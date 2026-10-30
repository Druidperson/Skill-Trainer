// Skill Trainer: knows how to train every skill in Melvor Idle. Pick a skill and a goal in the Train window and it plans the
// work; the steps run in the Action Queue mod, which Skill Trainer needs. Township Task Helper plans with it too.
export function setup(ctx) {
  const VERSION = "1.2.0", TAG = "[Skill Trainer]";
  // Action Queue (a dependency) holds the queue, its panel and settings, and runs the steps through the trainer below
  let A = null;
  const aq = () => (typeof mod !== "undefined" && mod?.api?.actionQueue) || window.actionQueue;

  // ---------- small helpers ----------
  const list = (r) => r?.allObjects ?? (r?.registeredObjects ? [...r.registeredObjects.values()] : []);
  const nm = (o) => String(o?.name ?? o?._name ?? o?._localID ?? o?.id ?? "?");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => Number(n).toLocaleString();
  const plural = (n, w, ws = w + "s") => `${num(n)} ${n === 1 ? w : ws}`;
  const aOr = (w) => `${/^[aeiou]/i.test(w) ? "an" : "a"} ${w}`;
  const icon = (o) => (typeof o?.media === "string" ? `<img class="skill-icon-xs mr-1" src="${esc(o.media)}">` : "");
  const have = (item) => { try { const q = game.bank.getQty(item); return Number.isFinite(q) ? q : null; } catch (e) { return null; } };
  const owned = (item) => have(item) ?? 0;
  const store = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { return false; } return true; };
  const stored = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const itemById = (id) => { try { return game.items.getObjectByID(id); } catch (e) { return null; } };
  const skillById = (id) => list(game.skills).find((s) => s.id === id);
  const lvl = (a) => a.level ?? 1;
  const fail = (reason, extra) => ({ ok: false, reason, ...extra });
  const warnIcon = '<i class="fa fa-exclamation-triangle"></i>&nbsp;';
  const chip = (html, cls = "", title = "") => `<span class="aq-chip ${cls}"${title ? ` title="${esc(title)}"` : ""}><span>${html}</span></span>`;
  const chips = (...c) => `<div class="aq-chips">${c.join("")}</div>`;
  const step = (body) => `<div class="aq-step">${body}</div>`;
  const note = (t) => `<div class="aq-note">${t}</div>`;

  // ---------- settings ----------
  // Skill Trainer's own switch lives in the mod settings menu (ctx.settings), with localStorage as the fallback. The queue's
  // switches (auto-start, auto-sell, auto-buy, crops) live in Action Queue.
  const SETTINGS = {
    preferMastery: ["mst-mastery", false, "Prefer mastery XP when training a skill",
      "When on, the planner counts the mastery XP a method gives next to the skill XP, and sticks with a method longer so its mastery keeps growing. When off, it only looks at skill XP per hour."],
  };
  let section = null;
  try {
    if (ctx?.settings) {
      section = ctx.settings.section("General");
      for (const [name, [, def, label, hint]] of Object.entries(SETTINGS)) section.add({ type: "switch", name, label, hint, default: def });
    }
  } catch (e) { section = null; console.warn(TAG, "could not register settings", e); }
  const Settings = {
    get(name) { try { const v = section?.get(name); if (v !== undefined && v !== null) return !!v; } catch (e) { /* use the fallback */ } const raw = stored(SETTINGS[name][0]); return raw !== null ? raw === "1" : SETTINGS[name][1]; },
    set(name, v) { try { section?.set(name, !!v); } catch (e) { console.warn(TAG, "settings", e); } store(SETTINGS[name][0], v ? "1" : "0"); },
  };
  const mastery = () => Settings.get("preferMastery");

  // ---------- skills and their methods ----------
  // The skills the queue can run on its own. Anything else a recipe needs (herbs, feathers, monster drops) becomes a step the
  // player does themselves, unless the bank already holds enough of it.
  const COMBAT = new Set(["Attack", "Strength", "Defence", "Hitpoints", "Ranged", "Magic", "Prayer", "Slayer"].map((s) => "melvorD:" + s));
  const TRAINABLE = new Set(["Woodcutting", "Mining", "Fishing", "Cooking", "Smithing", "Fletching", "Crafting", "Runecrafting", "Herblore",
    "Firemaking", "Thieving", "Summoning", "Astrology", "Agility", "Farming"].map((s) => "melvorD:" + s).concat("melvorItA:Harvesting", "melvorAoD:Archaeology", "melvorAoD:Cartography", ...COMBAT));
  const isTrainable = (s) => !!s && TRAINABLE.has(s.id);
  const MAGIC = "melvorD:Magic", FARMING = "melvorD:Farming", MELVOR = "melvorD:Melvor";
  // skills that only count as a source for things no other skill makes (Bone Offering makes Bones, Farming grows trees)
  const EXTRA = new Set([MAGIC, FARMING]);
  // actions from another realm only count once that realm is unlocked and they give normal XP
  const realmOk = (a) => !a.realm || a.realm.id === MELVOR || (a.realm.isUnlocked === true && (a.baseExperience ?? 0) > 0);
  const MANUAL_NOTE = "The queue can't get this on its own, so it's a step you do yourself";
  const fmtDur = (ms) => { if (!isFinite(ms)) return "an unknown time"; const m = Math.round(ms / 60000); return m < 1 ? "under 1 min" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const intervalMs = (skill, a) => a.baseInterval ?? (a.baseMinInterval !== undefined && a.baseMaxInterval !== undefined ? (a.baseMinInterval + a.baseMaxInterval) / 2 : skill.baseInterval) ?? 3000;
  // Cooking burns some food: costs are used every attempt, but the product and the XP only come from the ones that work.
  const succ = (skill, a) => { try { const c = skill?.id === "melvorD:Cooking" ? Number(skill.getRecipeSuccessChance(a)) : 100; if (c > 0 && c < 100) return Math.max(0.05, c / 100); } catch (e) { /* never fails */ } return 1; };
  const baseCosts = (a) => (Array.isArray(a.itemCosts) ? a.itemCosts : []);
  const NO_COSTS = [{ costs: [], mult: 1 }];
  // a hit the player takes while away is safe when auto eat starts above the biggest hit and there is food to eat
  const NM = () => (typeof numberMultiplier === "number" ? numberMultiplier : 10);
  const player = () => game.combat?.player;
  const resistance = () => Number(player()?.stats.getResistance?.(game.normalDamage)) || 0;
  // a hit you take while away is safe when auto eat starts above the biggest hit and there is food to eat.
  // A few pieces of food stay in reserve, so the step stops before the last one is gone.
  const takeSafety = (max) => {
    try {
      const pl = player(), slot = pl.food.slots[pl.food.selectedSlot], hp = pl.stats.maxHitpoints, eat = Number(pl.autoEatThreshold) || 0;
      if (!(max > 0)) return { ok: true };
      if (max * 2 >= hp) return { ok: false, why: `it can hit for ${num(max)} against your ${num(hp)} HP` };
      if (!slot?.item || !(slot.quantity > 0) || slot.item.id === "melvorD:Empty_Food") return { ok: false, why: "you have no food equipped" };
      if (slot.quantity < 3) return { ok: false, why: "you're almost out of food" };
      if (eat <= 0) return { ok: false, why: "auto eat is off, so nothing eats your food while the queue runs" };
      if (eat < max) return { ok: false, why: `auto eat starts at ${num(Math.round(eat))} HP but it can hit for ${num(max)}` };
      return { ok: true };
    } catch (e) { return { ok: false, why: "your combat stats couldn't be read" }; }
  };
  // numbers the planner asks for many times (fights, the shop, your bones) are worked out once a second
  const secMemo = { t: 0, m: new Map() };
  const perSec = (key, fn) => {
    const t = Math.floor(Date.now() / 1000);
    if (t !== secMemo.t) Object.assign(secMemo, { t, m: new Map() });
    if (!secMemo.m.has(key)) secMemo.m.set(key, fn());
    return secMemo.m.get(key);
  };
  const costText = (x) => [...x.cur.map((k) => `${num(k.quantity)} ${nm(k.currency)}`), ...x.items.map((k) => `${num(k.quantity)} ${nm(k.item)}`)].join(" + ") || "free";
  const costsOf = (c) => ({ c, items: c.getItemQuantityArray(), cur: c.getCurrencyQuantityArray() });
  const hitSafety = (maxHit, realm) => takeSafety(Math.floor((Number(maxHit) || 0) * NM() * (1 - (!realm || realm.id === MELVOR ? resistance() : 0) / 100)));
  // A method is one way to train: what an attempt costs (options, the first is used), what it makes (product, qty), how long it
  // takes (ms), the XP it gives, the share of attempts that work (succ) and how to start it. Most come straight from an action.
  const method = (skill, a, over = {}) => Object.defineProperties({
    id: a.id, skill, a, name: nm(a), xp: a.baseExperience ?? 0,
    get level() { return lvl(a); }, get media() { return a.media ?? this.product?.media; }, get product() { return a.product ?? null; }, get qty() { return a.baseQuantity ?? 1; },
    get options() { return (a.alternativeCosts?.length ? a.alternativeCosts.map((o) => ({ costs: o.itemCosts ?? [], mult: o.quantityMultiplier ?? 1 })) : NO_COSTS).map((o) => ({ costs: [...baseCosts(a), ...o.costs].filter((k) => k?.item), mult: o.mult })); },
    get succ() { return succ(skill, a); }, get ms() { return intervalMs(skill, a); },
    start: (e) => (STARTERS[skill.id] ?? startCraft)(skill, a, e),
  }, Object.getOwnPropertyDescriptors(over));
  const nonShardQty = (skill, a, item) => {
    try { const cost = item.sellsFor?.currency?.id === "melvorItA:AbyssalPieces" ? Summoning.recipeAPCost : Summoning.recipeGPCost; return skill.modifyNonShardItemCost(item, cost / Math.max(20, item.sellsFor?.quantity ?? 0), a); } catch (e) { return 1; }
  };
  // spells that only take runes and set items, and Superheat (ores into a bar). Spells that destroy an item you pick are left out.
  const magicMethods = (skill) => {
    const runes = (sp) => { try { return game.combat.player.getRuneCosts(sp); } catch (e) { return sp.runesRequired ?? []; } };
    const cast = (sp, bar) => () => { skill.selectSpellOnClick(sp); if (bar) skill.selectBarOnClick(bar); if (!skill.isActive) skill.castButtonOnClick(); };
    const bars = list(game.smithing?.actions).filter((r) => r.category?.id === "melvorD:Bars" && realmOk(r) && r.product);
    return list(skill.actions).filter(realmOk).flatMap((sp) => {
      const t = sp.specialCost?.type, fixed = sp.fixedItemCosts ?? [], base = { qty: sp.productionRatio ?? 1, ms: skill.baseInterval ?? 2000, succ: 1 };
      if (t === -5 && sp.produces && typeof sp.produces === "object")
        return [method(skill, sp, { ...base, product: sp.produces, get options() { return [{ costs: [...runes(sp), ...fixed], mult: 1 }]; }, start: cast(sp) })];
      // spells that use up an item you pick (Just Learning, Item Alchemy): cast them on whatever the queue can get the
      // quickest, so the item counts as part of the work. Alchemy turns it into GP as well.
      if (t === -1) return [method(skill, sp, {
        ...base, own: true, product: typeof sp.produces === "object" ? sp.produces : null,
        get pick() { return perSec(`alt|${sp.id}`, () => altFeed(skill, sp)); },
        get name() { const p = this.pick; return p ? `${nm(sp)} (${nm(p.item)}${p.gp ? `, ${num(Math.round(p.gp))} GP each` : ""})` : nm(sp); },
        get media() { return this.pick?.item.media ?? sp.media; },
        get options() { const it = this.pick?.item; return [{ costs: [...(it ? [{ item: it, quantity: sp.specialCost.quantity ?? 1 }] : []), ...runes(sp), ...fixed], mult: 1 }]; },
        need: () => (perSec(`alt|${sp.id}`, () => altFeed(skill, sp)) ? null : "there's nothing the queue can get to cast it on"),
        start: () => { const it = altFeed(skill, sp)?.item; if (!it) return fail("there's nothing the queue can get to cast it on"); skill.selectSpellOnClick(sp); skill.selectItemOnClick(it); if (!skill.isActive) skill.castButtonOnClick(); },
      })];
      if (t !== -3 && t !== -4) return [];
      return bars.map((r) => method(skill, sp, {
        ...base, id: `${sp.id}|${r.id}`, name: `${nm(sp)} (${nm(r.product)})`, media: r.product.media, product: r.product, own: true, start: cast(sp, r),
        need: (lv) => (levelIn(game.smithing, lv) >= lvl(r) ? null : `needs Smithing level ${lvl(r)}`),
        get options() { return [{ costs: [...r.itemCosts.filter((k) => t === -3 || k.item.id !== "melvorD:Coal_Ore").map((k) => ({ item: k.item, quantity: k.quantity * (sp.specialCost.quantity ?? 1) })), ...runes(sp), ...fixed], mult: 1 }]; },
      }));
    });
  };
  // the item an "any item" spell is cast on: one the queue can gather or make, with the most XP per hour counting the time to
  // get it (for alchemy, the one that makes the most GP among the fastest). It never picks items only the shop, monsters or you can get.
  const altFeed = (skill, sp) => {
    const out = [], castMs = skill.baseInterval ?? 2000, q = sp.specialCost?.quantity ?? 1, prod = typeof sp.produces === "object" ? sp.produces : null;
    const alch = typeof sp.produces !== "object" && sp.produces === -1;
    for (const id of new Set([...index().gatherers.keys(), ...index().crafters.keys()])) {
      const item = itemById(id);
      if (!item || item === prod || !(item.sellsFor?.quantity > 0) || item.sellsFor.currency?.id !== "melvorD:GP") continue;
      const t = makeTime(item, q);
      if (!isFinite(t.ms)) continue;
      let gp = 0;
      if (alch) { try { gp = Number(skill.getAlchemyGP(item, sp.productionRatio ?? 0)) || 0; } catch (e) { gp = item.sellsFor.quantity * (sp.productionRatio ?? 0); } }
      out.push({ item, ms: castMs + t.ms, gp });
    }
    // anything within 10% of the fastest counts as just as good, and then the one that makes the most GP wins
    const fast = Math.min(...out.map((x) => x.ms));
    return out.filter((x) => x.ms <= fast * 1.1).sort((a, b) => b.gp - a.gp || a.ms - b.ms)[0] ?? null;
  };
  // what is special about each skill's actions; skills not listed use their actions as they are
  const SKILLS = {
    "melvorD:Herblore": (s, a) => method(s, a, { get product() { return a.product ?? a.potions?.[Math.min(a.potions.length - 1, Math.max(0, s.getPotionTier?.(a) ?? 0))] ?? null; }, get qty() { return a.product ? a.baseQuantity ?? 1 : 1; } }),
    "melvorD:Firemaking": (s, a) => method(s, a, { product: null, name: nm(a.log ?? a), media: a.log?.media, options: [{ costs: a.log ? [{ item: a.log, quantity: 1 }] : [], mult: 1 }] }),
    "melvorD:Thieving": (s, a) => method(s, a, {
      product: null, options: NO_COSTS, safe: () => hitSafety(a.maxHit, a.realm),
      get succ() { return Math.min(1, Math.max(0.01, (Number(s.getNPCSuccessRate?.(a)) || 100) / 100)); },
      // a failed attempt stuns you, unless you avoid the stun
      get ms() { return (s.baseInterval ?? 3000) + (1 - this.succ) * (1 - (Number(s.stunAvoidanceChance) || 0) / 100) * (s.baseStunInterval ?? 3000); },
      start: () => (a.area ? s.startThieving(a.area, a) : fail("no thieving area found for this target")),
    }),
    "melvorD:Astrology": (s, a) => method(s, a, { product: null, options: NO_COSTS, get ms() { return Number(s.getConstellationInterval?.(a)) || intervalMs(s, a); }, start: () => s.studyConstellationOnClick(a) }),
    "melvorItA:Harvesting": (s, a) => method(s, a, { product: null, options: NO_COSTS, start: () => s.onVeinClick(a) }),
    "melvorD:Summoning": (s, a) => method(s, a, {
      get options() { const shards = baseCosts(a).filter((k) => k?.item), alts = a.nonShardItemCosts ?? []; return alts.length ? alts.map((item) => ({ costs: [...shards, { item, quantity: nonShardQty(s, a, item) }], mult: 1 })) : [{ costs: shards, mult: 1 }]; },
      start: (e) => { s.selectRecipeOnClick(a); s.selectNonShardCostOnClick?.(e.altIndex ?? 0); if (!s.isActive) s.createButtonOnClick(); },
    }),
  };
  // ---------- Farming: plant, wait for the crop to grow, harvest ----------
  // Farming has no action to start. Crops grow on real-time timers, so a Farming step plants what it needs on the plots
  // you've unlocked, with seeds you own, waits, and harvests. One planting is one attempt; plots grow side by side.
  const PLOT = { empty: 1, growing: 2, grown: 3, dead: 4 };
  const openPlots = (f, r) => { let p = []; try { p = [...(f.getPlotsForCategory(r.category) ?? [])]; } catch (e) { /* use the list */ } return (p.length ? p : list(f.plots).filter((x) => x.category === r.category)).filter((x) => x.state !== 0); };
  const growMs = (f, r) => { try { return f.modifyInterval(r.baseInterval, r) || r.baseInterval; } catch (e) { return r.baseInterval; } };
  const seedCost = (f, r) => { try { return f.getRecipeSeedCost(r); } catch (e) { return r.seedCost?.quantity ?? 1; } };
  // without compost a crop only grows about half the time, and a dead crop gives nothing. Compost you own goes on a plot
  // before it's planted (Weird Gloop and other kinds are left for you to use).
  const COMPOST = "melvorD:Compost";
  const compostPer = () => { const c = itemById(COMPOST); return c?.compostValue > 0 ? Math.ceil(100 / c.compostValue) : Infinity; };
  const cropChance = (f, r, level = owned(itemById(COMPOST)) >= compostPer() ? 100 : 0) => { try { return Math.min(1, Math.max(0.05, f.getPlotGrowthChance({ compostLevel: level, plantedRecipe: r }) / 100)); } catch (e) { return 1; } };
  const compostPlot = (f, p) => {
    const c = itemById(COMPOST), n = c?.compostValue > 0 ? Math.ceil((100 - (p.compostLevel ?? 0)) / c.compostValue) : 0;
    if (n > 0 && owned(c) >= n) try { f.compostPlot(p, c, n); } catch (e) { console.warn(TAG, "compost", e); }
  };
  const farmTick = (f, r, e) => {
    const plots = openPlots(f, r), mine = (p) => p.plantedRecipe === r, m = methodById(f, r.id);
    if (!plots.length) return { block: `you haven't unlocked any ${nm(r.category)} plots yet` };
    for (const p of plots) if (mine(p) && p.state === PLOT.dead) f.clearDeadPlot(p);
    for (const p of plots) if (mine(p) && p.state === PLOT.grown) f.harvestPlot(p);
    const left = e.qty - A.runner.gained(e), growing = plots.filter((p) => mine(p) && p.state === PLOT.growing).length;
    if (left <= 0) return {};
    const want = Math.ceil(left / Math.max(1e-9, e.kind === "skill" ? m.xp * m.succ : Math.max(1, m.qty) * m.succ)) - growing;
    if (want > 0) {
      const empty = plots.filter((p) => p.state === PLOT.empty), cost = seedCost(f, r), seeds = owned(r.seedCost.item);
      const n = Math.min(want, empty.length, Math.floor(seeds / cost)), timers = new Map();
      // the game starts one growth timer per planting time, the same way its own Plant All button does
      for (const p of empty.slice(0, n)) { compostPlot(f, p); const t = f.plantPlot(p, r); if (t > 0 && p.state === PLOT.growing) timers.set(t, [...(timers.get(t) ?? []), p]); }
      timers.forEach((ps, t) => f.createGrowthTimer(ps, t));
      if (n === 0 && !growing) return { block: empty.length ? `needs ${cost} ${nm(r.seedCost.item)} to plant ${nm(r)} and you have ${seeds}` : `all your ${nm(r.category)} plots are busy with other crops. Harvest or clear them` };
    }
    const now = plots.filter((p) => mine(p) && p.state === PLOT.growing);
    if (!now.length) return {};
    const times = now.map((p) => { try { return f.getPlotGrowthTime(p); } catch (err) { return 0; } });
    return { note: `waiting for ${nm(r)} to grow: ${plural(now.length, "plot")} planted, ready in ${fmtDur(Math.max(...times))}`, readyIn: Math.min(...times) };
  };
  SKILLS[FARMING] = (s, r) => method(s, r, {
    get options() { return [{ costs: r.seedCost?.item ? [{ item: r.seedCost.item, quantity: seedCost(s, r) }] : [], mult: 1 }]; },
    get succ() { return cropChance(s, r); },
    // XP per planting: base XP when planted (for some kinds), then base XP per crop (or once) when a grown crop is harvested.
    // The planner counts xp x succ as the average, so the planting part is divided back out.
    get xp() { const b = r.baseExperience ?? 0; return (r.category?.giveXPOnPlant ? b / this.succ : 0) + b * (r.category?.scaleXPWithQuantity ? r.baseQuantity ?? 1 : 1); },
    get ms() { const n = openPlots(s, r).length; return n ? growMs(s, r) / n : Infinity; },
    need: () => (openPlots(s, r).length ? null : `needs an unlocked ${nm(r.category)} plot`),
    tick: (e) => farmTick(s, r, e), start: () => fail("Farming steps plant and harvest instead"),
  });
  // Archaeology digs at sites that have a map with charges and tools picked. An Archaeology goal with no map offers to make
  // one in Cartography (you confirm it), and picks the tools for you.
  const ARCH = "melvorAoD:Archaeology";
  SKILLS[ARCH] = (s, site) => method(s, site, {
    product: null, options: NO_COSTS, get xp() { return s.getBaseSkillXPForDigSite?.(site) ?? 0; }, get ms() { return s.getDigSiteInterval?.(site) ?? intervalMs(s, site); },
    need: () => (s.canExcavate?.(site) ? null : `needs a map for ${nm(site)} with charges, and your tools picked (maps come from Cartography)`),
    check: () => (site.selectedMap?.charges > 0 ? null : { why: `the ${nm(site)} map is out of charges` }), start: () => s.startDigging(site),
  });
  // every tool goes on a site that has a map but no tools picked yet
  const pickTools = (site) => { const ar = game.archaeology; if (site.selectedMap && !site.selectedTools?.length) for (const t of list(ar.tools)) try { ar.setToolAsActive(site, t); } catch (e) { /* tool not available */ } };
  // the dig site to make a map for: found on the map, open at your level, room for another map, best XP first
  const mapSite = () => {
    const ar = game.archaeology, sites = list(ar?.actions).filter((x) => realmOk(x) && lvl(x) <= ar.level && x.maps.length < (x.getMaxMaps?.() ?? 1));
    const found = sites.filter((x) => x.poi?.isDiscovered).sort((a, b) => xpRate(methodById(ar, b.id)) - xpRate(methodById(ar, a.id)));
    return { site: found[0] ?? null, hidden: sites.length > 0 && !found.length };
  };
  // Agility runs the course you've built; a lap gives the XP of every obstacle. The course builder below fills empty slots.
  const AGILITY = "melvorD:Agility";
  const agilityMethods = (s) => {
    const built = () => [...(s.activeCourse?.builtObstacles?.values?.() ?? [])];
    return [method(s, { id: "agility:course", name: "Run your course", media: s.media }, {
      product: null, options: NO_COSTS, level: 1, noMastery: true,
      get xp() { return built().reduce((t, o) => t + (o.baseExperience ?? 0), 0); },
      get ms() { const o = built(); return o.length ? o.reduce((t, x) => t + (s.getObstacleInterval?.(x) ?? x.baseInterval ?? 3000), 0) : Infinity; },
      need: () => (s.activeCourse?.builtObstacles?.has?.(0) ? null : "build at least the first obstacle of your Agility course"),
      start: () => s.startAgilityOnClick(),
    })];
  };
  // ---------- Agility course builder ----------
  // For each empty slot you've unlocked: the obstacle with the most XP per second of lap time that meets its requirements, has no
  // negative bonus, costs GP you have and items you own or the queue can gather. Nothing is built until you confirm it,
  // obstacles you built are never replaced, and a slot you skip stays empty for that goal.
  const buildCosts = (o) => costsOf(game.agility.getObstacleBuildCosts(o));
  const agilityPicks = (skip = []) => {
    const ag = game.agility, course = ag?.activeCourse, picks = [];
    (course?.obstacleSlots ?? []).forEach((slot, i) => {
      if (!ag.isSlotUnlocked(slot) || course.builtObstacles.has(i) || skip.includes(i)) return;
      const ok = list(ag.actions).filter((o) => o.category === i && (o.realm?.id ?? MELVOR) === (course.realm?.id ?? MELVOR) && game.checkRequirements(o.skillRequirements ?? []) && !(o.modifiers ?? []).some((v) => v.isNegative)).map((o) => ({ o, slot: i, ...buildCosts(o), xpSec: (o.baseExperience ?? 0) / ((ag.getObstacleInterval?.(o) ?? o.baseInterval) / 1000) }))
        .filter((x) => x.cur.every((k) => (k.currency.amount ?? 0) >= k.quantity) && x.items.every((k) => owned(k.item) >= k.quantity || isFinite(makeTime(k.item, k.quantity).ms)));
      const best = ok.sort((a, b) => b.xpSec - a.xpSec)[0];
      if (best) picks.push(best);
    });
    return picks;
  };
  // the queue steps for a set of picks: gather the items, then a build step each (it asks you first)
  const buildSteps = (picks, parent) => picks.flatMap((x) => [...(materialSteps(x.items, 1, parent) ?? []),
    { kind: "ask", what: "build", skillId: AGILITY, actionId: x.o.id, slot: x.slot, qty: 1, parent, label: `Agility: build ${nm(x.o)}` }]);

  // Cartography trains by making paper from logs, or by surveying the hexes in range of where you stand on the map
  const surveyHex = (s) => {
    try {
      const map = s.activeMap;
      return map.getHexesInRange(map.playerPosition, map.surveyRange).filter((h) => !h.isFullySurveyed && (h.cartographyLevel ?? 1) <= s.level && game.checkRequirements(h.requirements ?? []))
        .sort((a, b) => (b.cartographyLevel ?? 0) - (a.cartographyLevel ?? 0))[0] ?? null;
    } catch (e) { return null; }
  };
  const cartographyMethods = (s) => [...list(s.paperRecipes).filter(realmOk).map((r) => method(s, r, {
    get options() { return [{ costs: (r.costs?.items ?? []).filter((k) => k?.item), mult: 1 }]; },
    get ms() { return s.getPaperMakingInterval?.(r) ?? s.BASE_PAPER_MAKING_INTERVAL ?? 5000; },
    start: () => { s.selectPaperRecipeOnClick(r); if (!s.isActive) s.makePaperOnClick(); },
  })), method(s, { id: "cartography:survey", name: "Survey the map", media: s.media }, {
    product: null, options: NO_COSTS, level: 1, noMastery: true,
    get xp() { const h = surveyHex(s); return h ? Number(s.getSkillXPForHexSurveyAction?.(h)) || (h.cartographyLevel ?? 1) * 2.6 : 0; },
    get ms() { return s.surveyInterval ?? 5000; },
    need: () => (surveyHex(s) ? null : "there's nothing left to survey in range of where you are on the map. Move somewhere new first"),
    start: () => { const h = surveyHex(s); if (!h) return fail("nothing left to survey nearby"); s.autoSurveyOnClick(h); },
  })];
  const WHOLE = { [MAGIC]: (s) => magicMethods(s), "melvorD:Agility": agilityMethods, "melvorAoD:Cartography": cartographyMethods };

  // ---------- combat ----------
  // A fight trains the skill your attack style gives XP in: 4 XP per point of damage (split on Longrange and Defensive), and
  // 1.33 Hitpoints XP on top. Prayer XP comes from an active prayer, Slayer XP from Slayer areas (half the monster's HP) and
  // your Slayer task (its full HP). Only fights that are safe while you're away are used, with the gear you have on.
  const PRAYER = "melvorD:Prayer", SLAYER = "melvorD:Slayer", HITPOINTS = "melvorD:Hitpoints";
  const STYLES = { "melvorD:Attack": { melee: "Stab" }, "melvorD:Strength": { melee: "Slash" }, "melvorD:Defence": { melee: "Block", ranged: "Longrange", magic: "Defensive" },
    "melvorD:Ranged": { ranged: "Accurate" }, "melvorD:Magic": { magic: "Magic" } };
  const WEAPON = { "melvorD:Attack": "melee", "melvorD:Strength": "melee", "melvorD:Ranged": "ranged", "melvorD:Magic": "magic" };
  const RESPAWN_MS = 3000;
  const mstat = (m, key) => (m.equipmentStats ?? []).find((x) => x.key === key && (key !== "resistance" || !x.damageType || x.damageType === game.normalDamage))?.value ?? 0;
  // the style that trains this skill with the weapon you have on (null if that weapon can't); your own style for the rest.
  // A ranged or magic style that already gives full XP in the skill (Rapid, say) is kept.
  const styleFor = (skill) => {
    const pl = player(), type = pl.attackType, cur = pl.attackStyles[type], want = STYLES[skill.id];
    if (!want) return cur;
    if (!want[type]) return null;
    if (skill.id !== "melvorD:Defence" && cur?.experienceGain?.some((g) => g.skill === skill && g.ratio >= 4)) return cur;
    return game.attackStyles.getObjectByID("melvorD:" + want[type]) ?? null;
  };
  // the prayer that gives the most Prayer XP that you can use
  const bestPrayer = () => list(game.prayers).filter((p) => !p.isAbyssal && !p.isUnholy && p.pointsPerPlayer > 0 && lvl(p) <= (game.prayer?.level ?? 1))
    .sort((a, b) => b.pointsPerPlayer - a.pointsPerPlayer)[0] ?? null;
  const onTask = (m) => { const t = game.combat.slayerTask; return t?.monster === m && t.killsLeft > 0; };
  // Prayer points run out: the cheapest bones in your bank (by sale price per point) are buried for more
  const bones = () => perSec("bones", () => list(game.items).filter((it) => it.prayerPoints > 0 && owned(it) > 0 && !game.bank.items.get(it)?.locked)
    .sort((a, b) => (a.sellsFor?.quantity ?? 0) / a.prayerPoints - (b.sellsFor?.quantity ?? 0) / b.prayerPoints)[0] ?? null);
  const buryBones = () => {
    const b = bones();
    if (!b) return false;
    try { game.bank.buryItemOnClick(b, Math.max(1, Math.ceil(100 / (Number(game.bank.getPrayerPointsPerBone?.(b)) || b.prayerPoints)))); } catch (e) { console.warn(TAG, "burying bones", e); }
    secMemo.m.delete("bones");
    return player().prayerPoints > 0;
  };
  // the weapon type an equipment set fights with, and another set that fits a skill (-1 if none)
  const weaponOf = (set) => { const w = set?.equipment?.equippedItems?.["melvorD:Weapon"]?.item; return !w || w.id === "melvorD:Empty_Equipment" ? "melee" : w.attackType ?? "melee"; };
  const weaponGap = (skill) => !!WEAPON[skill.id] && player()?.attackType !== WEAPON[skill.id];
  const setFor = (skill) => { const pl = player(); return (pl.equipmentSets ?? []).findIndex((s, i) => i !== pl.selectedEquipmentSet && weaponOf(s) === WEAPON[skill.id]); };
  // a monster's biggest normal hit before the combat triangle and your damage reduction (null if it can't be worked out)
  const monsterHit = (m, type) => {
    const lv = m.levels ?? {}, sp = m.selectedSpell;
    if (type === "melee") return Character.calculateStandardMaxHit(lv.Strength ?? 1, mstat(m, "meleeStrengthBonus"));
    if (type === "ranged") return Character.calculateStandardMaxHit(lv.Ranged ?? 1, mstat(m, "rangedStrengthBonus"));
    if (!sp) return null;
    return sp.spellbook?.allowDamageModifiers === false ? Math.round(NM() * sp.maxHit) : Math.floor(NM() * sp.maxHit * (1 + mstat(m, "magicDamageBonus") / 100) * (1 + ((lv.Magic ?? 1) + 1) / 200));
  };
  // the hardest single hit you can take from a monster: special attacks included, and the combat triangle and your damage
  // reduction counted the way that is worst for you. Specials based on anything else can't be worked out, so they count as unsafe.
  const maxTaken = (m) => {
    const pt = player().attackType, tri = game.combat.combatTriangle, dm = tri?.damageModifier ?? {}, rm = tri?.reductionModifier ?? {};
    let worst = 0;
    for (const t of m.attackType === "random" ? ["melee", "ranged", "magic"] : [m.attackType]) {
      const base = monsterHit(m, t);
      if (base === null) return null;
      let hit = base;
      for (const sp of m.specialAttacks ?? []) for (const d of sp.attack?.damage ?? []) {
        if (d.maxRoll === "MaxHit" && (d.character ?? "Attacker") === "Attacker") hit = Math.max(hit, (base * (d.maxPercent ?? 100)) / 100);
        else if (d.maxRoll === "Fixed") hit = Math.max(hit, (d.maxPercent ?? 0) * NM());
        else return null;
      }
      const tf = Math.max(dm[t]?.[pt] ?? 1, dm[pt]?.[t] ?? 1), rf = Math.min(1, rm[pt]?.[t] ?? 1, rm[t]?.[pt] ?? 1);
      worst = Math.max(worst, hit * tf * (1 - (resistance() * rf) / 100));
    }
    return Math.ceil(worst);
  };
  // how many attacks a kill takes, and how long it takes with the time until the next monster appears
  const killStats = (m) => {
    const st = player().stats, pt = player().attackType, lv = m.levels ?? {}, tri = game.combat.combatTriangle?.damageModifier ?? {};
    const level = pt === "magic" ? Math.floor((lv.Defence ?? 1) * 0.3 + (lv.Magic ?? 1) * 0.7) : lv.Defence ?? 1;
    const ev = Character.calculateStandardStat({ effectiveLevel: level, bonus: mstat(m, `${pt}DefenceBonus`) }), acc = st.accuracy;
    const hit = !(acc > 0) ? 0 : acc < ev ? (0.5 * acc) / ev : 1 - (0.5 * ev) / acc;
    const dmg = hit * ((st.minHit + st.maxHit) / 2) * (tri[pt]?.[m.attackType] ?? 1) * (1 - mstat(m, "resistance") / 100);
    const attacks = dmg > 0 ? Math.ceil(((lv.Hitpoints ?? 1) * NM()) / dmg) : Infinity;
    return { attacks, ms: attacks * st.attackInterval + RESPAWN_MS };
  };
  const xpPerKill = (skill, m, area) => {
    const hp = m.levels?.Hitpoints ?? 1;
    if (skill.id === HITPOINTS) return hp * 1.33;
    if (skill.id === SLAYER) return (game.slayerAreas.allObjects.includes(area) ? hp / 2 : 0) + (onTask(m) ? hp : 0);
    if (skill.id === PRAYER) return (hp * (bestPrayer()?.pointsPerPlayer ?? 0)) / 3;
    return hp * (styleFor(skill)?.experienceGain?.find((g) => g.skill === skill)?.ratio ?? 0);
  };
  // why this fight can't be used right now (null when it can)
  const fightNeed = (skill, m, area) => {
    const pl = player(), type = pl.attackType;
    if (WEAPON[skill.id] && WEAPON[skill.id] !== type) return `needs a ${WEAPON[skill.id]} weapon equipped (yours fights with ${type})`;
    if (!game.checkRequirements(area.entryRequirements ?? [])) return `${nm(area)} has requirements you don't meet yet`;
    if (type === "magic" && !(pl.spellSelection.attack && pl.canUseCombatSpell(pl.spellSelection.attack))) return "needs a combat spell you can cast selected in Combat";
    if (type === "ranged" && !(pl.equipment.equippedItems["melvorD:Quiver"]?.quantity > 0)) return "needs ammo in your quiver";
    if (skill.id === PRAYER && !bestPrayer()) return "needs a prayer you can use";
    if (skill.id === PRAYER && !(pl.prayerPoints > 0) && !bones()) return "needs prayer points, or bones in your bank to bury";
    return null;
  };
  // checked every second while a fight runs: runes, ammo and prayer points can run out
  const fightCheck = (skill) => {
    const pl = player(), sp = pl.spellSelection.attack;
    if (skill.id === PRAYER && !(pl.prayerPoints > 0) && !buryBones()) return { why: "out of prayer points, with no bones left to bury" };
    if (pl.attackType === "ranged" && !(pl.equipment.equippedItems["melvorD:Quiver"]?.quantity > 0)) return { why: "out of ammo" };
    if (pl.attackType === "magic" && sp && !pl.getRuneCosts(sp).every((k) => owned(k.item) >= k.quantity)) return { why: "out of runes", noMaterials: true };
    return null;
  };
  // The queue sets the attack style (and the prayer, for Prayer) for a fight and puts yours back when the step ends.
  let savedCombat = null;
  const restoreCombat = () => {
    const s = savedCombat, pl = player();
    savedCombat = null;
    if (!s || !pl) return;
    try {
      if (pl.attackStyles[s.type] !== s.style) pl.setAttackStyle(s.type, s.style);
      for (const p of [...pl.activePrayers]) if (!s.prayers.includes(p)) pl.togglePrayer(p);
      for (const p of s.prayers) if (!pl.activePrayers.has(p)) pl.togglePrayer(p);
    } catch (e) { console.warn(TAG, "restoring combat settings", e); }
  };
  // an Attack, Strength, Ranged or Magic goal can switch to another equipment set; it switches back when the goal is done
  const restoreSet = (e) => {
    const pl = player();
    if (e.wasSet === undefined || !pl || pl.selectedEquipmentSet === e.wasSet || game.activeAction === game.combat) return;
    try { pl.changeEquipmentSet(e.wasSet); } catch (err) { console.warn(TAG, "switching your equipment set back", err); }
  };
  const kills = (id) => { try { return game.stats.monsterKillCount(game.monsters.getObjectByID(id)) ?? 0; } catch (e) { return 0; } };
  // the fight a kill or drop step uses: any combat area or Slayer area the monster is in (null for dungeons)
  const fightId = (m) => { const a = [...list(game.combatAreas), ...list(game.slayerAreas)].find((x) => (x.monsters ?? []).includes(m)); return a ? `fight:${a.id}:${m.id}` : null; };
  const fighting = (m) => game.activeAction === game.combat && game.combat.selectedMonster === m;
  const startFight = (skill, m, area) => {
    const pl = player(), style = styleFor(skill), pr = skill.id === PRAYER && bestPrayer();
    if (game.activeAction && !fighting(m)) game.stopActiveAction();
    savedCombat ??= { type: pl.attackType, style: pl.attackStyles[pl.attackType], prayers: [...pl.activePrayers] };
    if (style && pl.attackStyles[pl.attackType] !== style) pl.setAttackStyle(pl.attackType, style);
    if (pr && !(pl.prayerPoints > 0)) buryBones();
    if (pr && !pl.activePrayers.has(pr)) pl.togglePrayer(pr);
    if (!fighting(m)) game.combat.selectMonster(m, area);
  };
  const fightMethods = (skill) => [...list(game.combatAreas), ...list(game.slayerAreas)].filter(realmOk).flatMap((area) => (area.monsters ?? []).filter((m) => realmOk(m) && m.levels).map((m) => {
    const ev = () => perSec(`${skill.id}|${area.id}|${m.id}`, () => ({ ...killStats(m), xp: xpPerKill(skill, m, area), hit: maxTaken(m) }));
    return method(skill, m, {
      id: `fight:${area.id}:${m.id}`, name: `Fight ${nm(m)}${game.slayerAreas.allObjects.includes(area) ? ` (${nm(area)})` : ""}`, media: m.media, product: null, level: 1, succ: 1,
      actor: game.combat, noMastery: true, cap: () => (skill.id === SLAYER && !game.slayerAreas.allObjects.includes(area) ? game.combat.slayerTask.killsLeft : Infinity),
      get xp() { return ev().xp; }, get ms() { return ev().ms; },
      // a combat spell uses runes on every cast
      get options() { const pl = player(), sp = pl.spellSelection.attack; return pl.attackType === "magic" && sp ? [{ costs: pl.getRuneCosts(sp).map((k) => ({ item: k.item, quantity: k.quantity * ev().attacks })), mult: 1 }] : NO_COSTS; },
      need: () => fightNeed(skill, m, area), check: () => fightCheck(skill), active: () => fighting(m), start: () => startFight(skill, m, area),
      safe: () => (ev().hit === null ? { ok: false, why: `${nm(m)} has special attacks whose damage can't be worked out` } : takeSafety(ev().hit)),
    });
  }));
  const methodCache = new Map();
  const methodsOf = (skill) => {
    if (!skill) return [];
    if (!methodCache.has(skill.id)) {
      const own = WHOLE[skill.id] ? WHOLE[skill.id](skill) : list(skill.actions).filter(realmOk).map((a) => (SKILLS[skill.id] ?? method)(skill, a));
      methodCache.set(skill.id, COMBAT.has(skill.id) ? [...own, ...fightMethods(skill)] : own);
    }
    return methodCache.get(skill.id);
  };
  const methodById = (skill, id) => methodsOf(skill).find((m) => m.id === id);
  const perAttempt = (m, opt = m.options[0]) => Math.max(1, m.qty * opt.mult) * m.succ;
  const xpRate = (m) => (m.ms > 0 ? ((m.xp * m.succ) / m.ms) * 3600000 : 0);
  // where each item comes from. Magic only makes what no other skill makes, so bars still come from Smithing.
  let idx = null;
  const index = () => {
    if (idx) return idx;
    idx = { crafters: new Map(), gatherers: new Map() };
    const add = (m) => { const map = m.options[0].costs.length ? idx.crafters : idx.gatherers; map.set(m.product.id, [...(map.get(m.product.id) ?? []), { skill: m.skill, a: m }]); };
    const skills = list(game.skills).filter(isTrainable), known = (id) => idx.crafters.has(id) || idx.gatherers.has(id);
    for (const m of skills.filter((s) => !EXTRA.has(s.id)).flatMap(methodsOf)) if (m.product) add(m);
    for (const m of skills.filter((s) => EXTRA.has(s.id)).flatMap(methodsOf).filter((m) => m.product && !m.own && !known(m.product.id))) add(m);
    return idx;
  };
  // an extra source only counts once you can use it (the level, an unlocked plot); until then the item is a step you do yourself
  const usable = (x) => (x && EXTRA.has(x.skill.id) && (x.a.level > x.skill.level || x.a.need?.()) ? undefined : x);
  const crafter = (id) => usable(index().crafters.get(id)?.[0]);
  const gatherer = (id) => usable(index().gatherers.get(id)?.[0]);

  // ---------- breaking an item down into steps ----------
  // Crafts break down into their materials. Parents come before children, so what the bank already holds is used first.
  const buildRows = (item, qty, fresh = false) => rowsFor([[item, qty]], fresh);
  const rowsFor = (targets, fresh = false) => {
    const nodes = new Map(), roots = new Set(targets.map(([it]) => it.id));
    const explode = (it, depth, path) => {
      const n = nodes.get(it.id) ?? { item: it, depth }, c = crafter(it.id);
      nodes.set(it.id, Object.assign(n, { depth: Math.max(n.depth, depth) }));
      if (!c || path.has(it.id) || depth > 12) return;
      n.recipe = { c, opt: c.a.options[0] };
      path.add(it.id); for (const k of n.recipe.opt.costs) explode(k.item, depth + 1, path); path.delete(it.id);
    };
    for (const [it] of targets) explode(it, 0, new Set());
    const demand = new Map(targets.map(([it, q]) => [it.id, q])), rows = [];
    for (const n of [...nodes.values()].sort((a, b) => a.depth - b.depth)) {
      const need = demand.get(n.item.id) ?? 0;
      if (need <= 0) continue;
      n.fresh = fresh && roots.has(n.item.id);
      Object.assign(n, { need, qty: Math.max(0, need - (n.fresh ? 0 : owned(n.item))) });
      if (n.recipe) {
        const { c, opt } = n.recipe;
        n.recipe.crafts = Math.ceil(n.qty / perAttempt(c.a, opt));
        if (n.qty > 0) for (const k of opt.costs) demand.set(k.item.id, (demand.get(k.item.id) ?? 0) + k.quantity * n.recipe.crafts);
      }
      if (n.qty > 0) rows.push(n);
    }
    return rows.sort((a, b) => b.depth - a.depth || nm(a.item).localeCompare(nm(b.item)));
  };
  const lvlChip = (skill, a) => (skill && lvl(a) > skill.level ? chip(`${warnIcon}Needs ${esc(nm(skill))} level ${a.level} (you have ${skill.level})`, "warn") : "");
  // the easiest way to gather an item the player can't gather yet (null if they can, or if no skill gathers it)
  const gatherBlock = (id) => {
    const opts = (index().gatherers.get(id) ?? []).filter((x) => !EXTRA.has(x.skill.id));
    if (!opts.length || opts.some((x) => lvl(x.a) <= x.skill.level)) return null;
    return opts.reduce((m, x) => (lvl(x.a) - x.skill.level < lvl(m.a) - m.skill.level ? x : m));
  };
  const itemMissing = (item, qty, fresh) => {
    const out = new Map();
    for (const n of buildRows(item, qty, fresh)) {
      const x = n.recipe ? n.recipe.c : gatherBlock(n.item.id);
      if (x && lvl(x.a) > x.skill.level) out.set(`${x.a.level} ${nm(x.skill)}|${nm(n.item)}`, { text: `${x.a.level} ${nm(x.skill)}`, forName: nm(n.item) });
    }
    return [...out.values()];
  };
  const missingHtml = (miss) => step(miss.map((x) => chips(chip(`${warnIcon}Warning: ${esc(x.text)} required for ${esc(x.forName)}`, "warn"))).join("") + note("You can't queue this until you meet the requirements."));
  const itemSection = (rows) => {
    if (!rows.length) return step(chips(chip(`<i class="fa fa-check"></i> You already have enough in your bank`, "ok")));
    return rows.map((n, i) => {
      const o = have(n.item);
      const haveChip = o === null || n.fresh ? "" : chip(`You have ${num(o)} of ${num(n.need)} needed`);
      let title, body;
      if (n.recipe) {
        const { c, opt, crafts } = n.recipe;
        const alts = (index().crafters.get(n.item.id)?.length ?? 1) - 1 + c.a.options.length - 1;
        const uses = opt.costs.map((x) => chip(`${icon(x.item)}${num(x.quantity * crafts)} ${esc(nm(x.item))}`));
        title = `${icon(c.skill)}<b>${esc(nm(c.skill))}</b>: make ${icon(n.item)}<b>${esc(nm(n.item))}</b> &times;${num(n.qty)}`;
        body = chips(chip(`Level ${lvl(c.a)}`), chip(plural(crafts, "craft")), haveChip, alts > 0 ? chip(plural(alts, "other option")) : "") +
          (uses.length ? chips(chip("<b>Uses</b>", "lbl"), ...uses) : "") + (lvlChip(c.skill, c.a) ? chips(lvlChip(c.skill, c.a)) : "");
      } else {
        const g = (index().gatherers.get(n.item.id) ?? []).filter(usable), lb = gatherBlock(n.item.id);
        title = `${icon(n.item)}<b>${esc(nm(n.item))}</b> &times;${num(n.qty)}`;
        body = chips(haveChip) + (g.length
          ? chips(chip(`<i class="fa fa-hand-paper"></i> <b>Gather</b>`, "lbl"), ...g.slice(0, 3).map((x) => chip(`${esc(nm(x.skill))}: ${esc(nm(x.a))} (Lv ${lvl(x.a)})`))) + (lb ? chips(lvlChip(lb.skill, lb.a)) : "")
          : shopOnly(n.item) ? chips(chip(`<i class="fa fa-shopping-cart"></i> <b>Buy</b>`, "lbl"), chip(`From the shop for ${esc(costText(costsOf(game.shop.getPurchaseCosts(shopFor(n.item), Math.ceil(n.qty / perBuy(shopFor(n.item)))))))}`), chip(A.settings.get("autoBuy") ? "Bought without asking" : "Asks you first", "ok"))
          : chips(chip(MANUAL_NOTE, "warn")));
      }
      return step(`<div class="aq-stepno">Step ${i + 1}</div><div class="aq-title">${title}</div>${body}`);
    }).join("");
  };
  // ways to get an item that other mods know about: fn(item, qty) returns a step (or nothing)
  const SOURCES = [];
  // Queue entries: "kind" is what the runner does; qty is how many MORE of the item to end up with
  // (for "manual" entries it is how many you should own).
  const toEntries = (rows) => rows.map((n) => {
    const base = { itemId: n.item.id, qty: n.qty }, c = n.recipe?.c, g = !c && gatherer(n.item.id);
    if (c) return { ...base, kind: "craft", skillId: c.skill.id, actionId: c.a.id, altIndex: 0, label: `${nm(c.skill)}: make ${nm(n.item)}` };
    if (g) return { ...base, kind: "gather", skillId: g.skill.id, actionId: g.a.id, label: `${nm(g.skill)}: gather ${nm(n.item)}` };
    for (const fn of SOURCES) { const x = fn(n.item, n.qty); if (x) return { ...base, ...x }; }
    // qty for a buy step is how many you should own, like a manual step
    if (shopOnly(n.item)) return { ...base, qty: owned(n.item) + n.qty, kind: "ask", what: "buy", label: `Buy ${nm(n.item)}` };
    return { ...base, qty: n.need ?? n.qty, kind: "manual", label: `Get ${nm(n.item)}`, note: MANUAL_NOTE };
  });
  // the steps that get the missing materials for `crafts` more attempts; null if the queue can't get one of them
  const materialSteps = (costs, crafts, parent) => {
    const targets = costs.map((k) => [k.item, k.quantity * crafts - owned(k.item)]).filter(([, n]) => n > 0);
    const entries = targets.length ? toEntries(rowsFor(targets, true)) : [];
    if (entries.some((x) => x.kind === "manual")) return null;
    for (const x of entries) x.parent = parent;
    return entries;
  };

  // ---------- the shop (Action Queue buys; Skill Trainer plans with it) ----------
  const shopFor = (item) => A?.shop.for(item);
  const perBuy = (p) => A.shop.perBuy(p);
  // things only the shop sells (feathers, compost, Summoning shards): the plan buys them, and Action Queue asks you first
  // unless auto-buy is on
  const shopOnly = (item) => !!shopFor(item) && !crafter(item.id) && !gatherer(item.id);
  const buyLeft = (item) => (shopOnly(item) ? A.shop.canBuy(item) : 0);

  // ---------- Slayer tasks ----------
  // A Slayer goal with no task asks you about rolling one: the cheapest tier you have the Slayer level for and can pay for,
  // as long as some of its monsters are safe for you to fight while you're away
  const slayerTier = () => {
    const st = game.combat.slayerTask, sl = skillById(SLAYER)?.level ?? 1;
    for (const c of list(st?.categories)) {
      if ((c.realm?.id ?? MELVOR) !== MELVOR || (c.level ?? 1) > sl || !st.getRollCosts(c).checkIfOwned()) continue;
      const mons = st.getMonsterSelection(c), safe = mons.filter((m) => { const h = maxTaken(m); return h !== null && takeSafety(h).ok; });
      if (safe.length) return { c, mons, safe };
    }
    return null;
  };
  const hasTask = () => { const t = game.combat.slayerTask; return !!t?.monster && t.killsLeft > 0; };

  // ---------- steps that ask you first ----------
  // Action Queue runs "ask" steps; these are the kinds Skill Trainer adds (it registers them when it installs): building an
  // Agility obstacle, rolling a Slayer task, making a dig site map, and switching equipment sets (no question asked, or it
  // waits for you to equip the right weapon).
  const popHtml = (o, rows, foot) => step(`<div class="aq-title">${icon(o)}<b>${esc(nm(o))}</b></div>${rows}`) + note(foot);
  const ASKS = {
    build: {
      target: (e) => list(game.agility?.actions).find((x) => x.id === e.actionId),
      done: (e, o) => { const there = o.course?.builtObstacles?.get(o.category) ?? game.agility.activeCourse.builtObstacles.get(o.category); return there ? (there === o ? "Already built" : `Slot already has ${nm(there)}`) : null; },
      skip: (e, o, parent) => { if (parent) parent.noBuild = [...(parent.noBuild ?? []), o.category]; },
      cannot: (e, o) => (game.agility.getObstacleBuildCosts(o).checkIfOwned() ? null : `you can't pay for ${nm(o)} right now (${costText(buildCosts(o))})`),
      act: (e, o) => { game.agility.buildObstacle(o); return "Built"; },
      turn: (e, o) => `confirm building ${nm(o)}, or skip it.`,
      pop: (e, o) => {
        const slot = game.agility.activeCourse.obstacleSlots[o.category], mods = (o.modifiers ?? []).map((v) => { try { return v.getDescription().description; } catch (err) { return ""; } }).filter(Boolean);
        return { title: "Build an Agility obstacle?", yes: "Build", html: popHtml(o, chips(chip(`Slot ${o.category + 1} (Agility level ${slot?.level ?? 1})`), chip(`${num(o.baseExperience ?? 0)} XP per lap`), chip(`${num((o.baseInterval ?? 0) / 1000)} s`)) +
          chips(chip("<b>Costs</b>", "lbl"), chip(esc(costText(buildCosts(o))))) + (mods.length ? chips(chip("<b>Bonuses</b>", "lbl"), ...mods.map((d) => chip(esc(d), "ok"))) : ""),
          "Building can't be undone. Skip leaves this slot empty for this goal.") };
      },
    },
    slayer: {
      icon: () => skillById(SLAYER),
      target: (e) => list(game.combat.slayerTask?.categories).find((c) => c.id === e.actionId),
      done: () => (hasTask() ? `Task: ${nm(game.combat.slayerTask.monster)} x${num(game.combat.slayerTask.killsLeft)}` : null),
      skip: (e, c, parent) => { if (parent) parent.noTask = true; },
      cannot: (e, c) => { const k = game.combat.slayerTask.getRollCosts(c); return k.checkIfOwned() ? null : `you can't pay for ${aOr(nm(c))} task right now (${costText(costsOf(k))})`; },
      act: (e, c) => {
        const st = game.combat.slayerTask;
        st.selectTask(c, true, true, true);
        // the game starts the task a second later; start it now so the plan can count it
        if (st.monster && !(st.killsLeft > 0)) { st.taskTimer?.stop?.(); st.setTask(); }
        return hasTask() ? `Task: ${nm(st.monster)} x${num(st.killsLeft)}` : { block: `the game didn't give you ${aOr(nm(c))} task` };
      },
      turn: (e, c) => `confirm rolling ${aOr(nm(c))} Slayer task, or skip it.`,
      pop: (e, c) => {
        const t = slayerTier(), k = game.combat.slayerTask.getRollCosts(c), n = t?.c === c ? t : { mons: [], safe: [] };
        return { title: "Roll a Slayer task?", yes: "Roll", html: popHtml(c, chips(chip(`Costs ${esc(costText(costsOf(k)))}`), chip(`${n.safe.length} of ${n.mons.length} monsters are safe for you`, n.safe.length ? "ok" : "warn")),
          "The task is random. If you get a monster that isn't safe while you're away, the queue skips it and uses a safe Slayer area if there is one. Skip doesn't ask again for this goal.") };
      },
    },
    map: {
      target: (e) => list(game.archaeology?.actions).find((x) => x.id === e.actionId),
      done: (e, s) => { pickTools(s); return game.archaeology.canExcavate(s) ? "Map ready" : null; },
      skip: (e, s, parent) => { if (parent) parent.noMap = true; },
      cannot: (e, s) => { const k = game.cartography.getMapCreationCosts(s); return !s.poi?.isDiscovered ? `you haven't found ${nm(s)} on the map yet` : k.checkIfOwned() ? null : `you don't have what ${aOr(nm(s))} map takes (${costText(costsOf(k))})`; },
      act: (e, s) => {
        game.cartography.createNewMapForDigSite(s);
        if (!(s.selectedMap?.charges > 0) && s.maps.length) try { s.selectedMapIndex = s.maps.length - 1; } catch (err) { /* the game picks it */ }
        pickTools(s);
        return game.archaeology.canExcavate(s) ? "Map made" : { block: `the map for ${nm(s)} couldn't be made or picked. Pick it in Archaeology, then press Start` };
      },
      turn: (e, s) => `confirm making a map for ${nm(s)}, or skip it.`,
      pop: (e, s) => ({ title: "Make a dig site map?", yes: "Make map", html: popHtml(s, chips(chip(`Archaeology level ${lvl(s)}`), chip("<b>Costs</b>", "lbl"), chip(esc(costText(costsOf(game.cartography.getMapCreationCosts(s)))))),
        "Uses up the materials. The queue picks all your tools for the site too. Skip doesn't ask again for this goal.") }),
    },
    // set: another equipment set to switch to (no question asked), or -1 to wait for you
    equip: {
      target: (e) => skillById(e.skillId),
      done: (e, s) => (weaponGap(s) ? null : e.set >= 0 ? `Switched to equipment set ${e.set + 1}` : "Done"),
      auto: (e) => e.set >= 0,
      hint: (e) => (e.set >= 0 ? "switches your equipment set" : "waits for you to equip it"),
      act: (e, s, parent) => {
        const pl = player();
        if (game.activeAction === game.combat) game.stopActiveAction();
        if (parent && parent.wasSet === undefined) parent.wasSet = pl.selectedEquipmentSet;
        try { pl.changeEquipmentSet(e.set); } catch (err) { /* checked below */ }
        return weaponGap(s) ? { block: `equipment set ${e.set + 1} doesn't fight with a ${WEAPON[s.id]} weapon` } : `Switched to equipment set ${e.set + 1}`;
      },
      turn: (e, s) => `equip a ${WEAPON[s.id]} weapon${WEAPON[s.id] === "ranged" ? " and ammo" : ""}. The queue carries on once you do.`,
    },
  };

  // ---------- starting actions in the game ----------
  // Uses the game's own click handlers, in the same order its buttons use them. A starter returns a failure or nothing.
  const STARTERS = {
    "melvorD:Woodcutting": (s, a) => { s.activeTrees.clear(); s.selectTree(a); },
    "melvorD:Mining": (s, a) => {
      if (a.isRespawning) return fail("waiting for the rock to respawn", { transient: true });
      if (!s.canMineOre(a)) return fail("can't mine this yet (level, mastery or shop unlock)");
      s.selectedRock = undefined; s.onRockClick(a);
    },
    "melvorD:Fishing": (s, a) => {
      const area = list(s.areas).find((ar) => (ar.fish ?? []).includes(a));
      if (!area) return fail("no fishing area found for this fish");
      s.onAreaFishSelection(area, a); s.onAreaStartButtonClick(area);
    },
    "melvorD:Cooking": (s, a) => { s.onRecipeSelectionClick(a); s.onActiveCookButtonClick(a.category); },
    "melvorD:Firemaking": (s, a) => { s.selectLog(a); if (!s.isActive) s.burnLog(); },
  };
  const startCraft = (s, a, e) => {
    if (typeof s.selectRecipeOnClick !== "function" || typeof s.createButtonOnClick !== "function") return fail(`automating ${nm(s)} isn't supported yet`);
    s.selectRecipeOnClick(a);
    if (a.alternativeCosts?.length && typeof s.selectAltRecipeOnClick === "function") s.selectAltRecipeOnClick(e.altIndex ?? 0);
    if (!s.isActive) s.createButtonOnClick();
  };
  const startAction = (e) => {
    const skill = skillById(e.skillId), m = methodById(skill, e.actionId), safety = m?.safe?.();
    if (!m) return fail(e.kind === "kill" ? "this monster is in a dungeon or special area, so fight it yourself, then press Start" : "this action wasn't found in your game version");
    if (m.level > skill.level) return fail(`needs ${nm(skill)} level ${m.level}`);
    if (m.need?.()) return fail(m.need());
    if (safety && !safety.ok) return fail(`not safe while you're away: ${safety.why}`);
    const chk = m.check?.();
    if (chk) return fail(chk.why, { noMaterials: !!chk.noMaterials });
    try {
      if (game.activeAction && game.activeAction !== (m.actor ?? skill)) game.stopActiveAction();
      if (!m.actor && skill.isActive && skill.stop() === false) return fail("couldn't stop the current activity");
      const r = m.start(e);
      if (r) return r;
    } catch (err) { return fail("error: " + err.message); }
    if (m.active ? m.active() : skill.isActive) return { ok: true };
    const costly = (m.options[e.altIndex ?? 0] ?? m.options[0]).costs.length > 0 && e.kind !== "gather";
    return fail(costly ? "not enough materials (or level too low)" : "the game wouldn't start it", { noMaterials: costly && m.level <= skill.level });
  };

  // A craft step ran out of ingredients before it made enough (Cooking burns food, Smithing and others can come up short):
  // work out what is still missing and the steps that get it
  const restockCraft = (e) => {
    const m = methodById(skillById(e.skillId), e.actionId), item = itemById(e.itemId), name = e.kind === "skill" ? m?.name : nm(item);
    if (!m || (e.kind !== "skill" && !item)) return fail("this action wasn't found in your game version");
    const opt = m.options[e.altIndex ?? 0] ?? m.options[0], remaining = e.qty - A.runner.gained(e);
    const crafts = Math.max(1, Math.ceil(remaining / (e.kind === "skill" ? Math.max(1e-9, m.xp * m.succ) : perAttempt(m, opt))));
    const entries = materialSteps(opt.costs, crafts, e.parent ?? e.id);
    if (!entries) return fail(`${name} needs something the queue can't get on its own`);
    return entries.length ? { ok: true, entries, remaining, crafts, name } : fail("not enough materials (or level too low)");
  };

  // ---------- train a skill ----------
  // Two goals: make an amount of an item, or train to a level. A level goal never farms blindly: every method is ranked
  // by XP per hour of ALL the work it takes (gathering its materials included), and the plan only switches method when a
  // clearly better one opens up. The queue plans one batch at a time, so it always uses your real level and bank.
  const levelIn = (skill, lv) => (lv?.has(skill.id) ? lv.get(skill.id) : skill.level);
  const xpAt = (l) => { try { return exp.level_to_xp(l); } catch (e) { return 0; } };
  const levelCap = (s) => (s.level >= 99 ? 120 : 99);
  // keep the current method unless another is at least 10% faster (25% with "prefer mastery XP"), so plans don't split into tiny batches
  const switchGain = () => (mastery() ? 1.25 : 1.1);

  // time (ms) to get n of an item from scratch with things the queue can do itself; Infinity if it can't.
  // Also returns the XP those steps give in `skillId` (smelting bars trains Smithing too).
  const makeTime = (item, n, lv, skillId, seen = new Set(), depth = 0) => {
    if (!(n > 0)) return { ms: 0, xp: 0 };
    const NO = { ms: Infinity, xp: 0 }, c = crafter(item.id), g = !c && gatherer(item.id), x = c || g;
    // buying from the shop takes no time (you still confirm each purchase)
    if (!x) return buyLeft(item) >= n ? { ms: 0, xp: 0 } : NO;
    if (depth > 10 || seen.has(item.id) || !x || x.a.level > levelIn(x.skill, lv) || x.a.need?.(lv)) return NO;
    if (g) { const acts = n / Math.max(1, g.a.qty); return { ms: acts * g.a.ms, xp: g.skill.id === skillId ? acts * g.a.xp : 0 }; }
    const opt = c.a.options[0], crafts = n / perAttempt(c.a, opt); // attempts, not rounded: ranks methods by their steady rate
    const r = { ms: crafts * c.a.ms, xp: c.skill.id === skillId ? crafts * c.a.succ * c.a.xp : 0 };
    seen.add(item.id);
    for (const k of opt.costs) { const s = acquire(k.item, k.quantity * crafts, lv, skillId, seen, depth + 1); r.ms += s.ms; r.xp += s.xp; }
    seen.delete(item.id);
    return r;
  };
  // the same, but what the queue can't get itself is free while the bank holds enough of it (shards, feathers, bones)
  const acquire = (item, n, lv, skillId, seen, depth) => { const r = makeTime(item, n, lv, skillId, seen, depth); return isFinite(r.ms) || owned(item) < n ? r : { ms: 0, xp: 0 }; };
  // how many attempts the bank (and what you could buy) allows for the costs the queue can't gather or make
  const stockCap = (costs) => Math.min(Infinity, ...costs.filter((k) => shopOnly(k.item) || !isFinite(makeTime(k.item, 1).ms)).map((k) => Math.floor((owned(k.item) + buyLeft(k.item)) / k.quantity)));
  // the same step the queue would really run for this product (first crafter, or first gatherer). Methods that make nothing,
  // and extra ways to make something (Superheat), run as their own XP step.
  const stepFor = (m) => {
    if (!m.product) return { craft: m.options[0].costs.length > 0, own: true };
    const c = crafter(m.product.id), g = gatherer(m.product.id);
    return c ? (c.a === m ? { craft: true } : null) : g?.a === m ? { craft: false } : m.own ? { craft: true, own: true } : null;
  };
  // training methods open at this level, best first by XP per hour of everything they need
  const trainCands = (skill, lv) => {
    const out = [], L = levelIn(skill, lv);
    for (const m of methodsOf(skill)) {
      const st = m.level <= L && m.xp > 0 && !m.need?.(lv) && m.safe?.().ok !== false && stepFor(m);
      if (!st) continue;
      const opt = st.craft ? m.options[0] : NO_COSTS[0];
      let ms = m.ms, xpPer = m.xp * m.succ, mast = 0;
      if (st.craft) for (const k of opt.costs) { const r = acquire(k.item, k.quantity, lv, skill.id); ms += r.ms; xpPer += r.xp; }
      if (!isFinite(ms) || ms <= 0) continue;
      if (mastery() && !m.noMastery && m.a.hasMastery !== false) {
        try { if (skill.getMasteryLevel(m.a) < 99) mast = Number(skill.getMasteryXPToAddForAction(m.a, m.ms)) || 0; } catch (e) { /* no mastery */ }
      }
      out.push({ a: m, st, opt, per: perAttempt(m, opt), ms, xpPer, mast, rate: (xpPer / ms) * 3600000, score: ((xpPer + mast) / ms) * 3600000 });
    }
    return out.sort((x, y) => y.score - x.score);
  };
  // why nothing at this level can be trained, when it comes down to gear, requirements or safety (no food, say)
  const blockedWhy = (skill) => {
    // skill actions first, fights after: Alt Magic short on runes says so before Magic combat asks for a staff
    for (const m of [...methodsOf(skill)].sort((a, b) => !!a.actor - !!b.actor)) {
      if (m.level > skill.level) continue;
      const need = m.need?.();
      if (need) return need;
      const safe = m.xp > 0 && m.safe?.();
      if (safe && !safe.ok) return `it isn't safe while you're away (${safe.why})`;
      // something it needs that the queue can't get (Nature Runes before Runecrafting 44, say)
      const k = m.xp > 0 && !m.actor && (m.options[0]?.costs ?? []).find((c) => owned(c.item) < c.quantity && !isFinite(makeTime(c.item, c.quantity).ms));
      if (k) return `${m.name} needs ${nm(k.item)}, which you don't have and the queue can't get on its own yet`;
    }
    return null;
  };
  const trainPlan = (skill, target, forcedId, fromLevel = skill.level, fromXp = skill.xp ?? 0, seed = null) => {
    const sim = new Map(seed ?? []), batches = [];
    let L = fromLevel, cur = null, blocked = null;
    for (let guard = 0; L < target && guard < 140; guard++) {
      sim.set(skill.id, L);
      const cands = trainCands(skill, sim).filter((c) => !forcedId || c.a.id === forcedId);
      if (!cands.length) { blocked = L; break; }
      const same = cur && cands.find((c) => c.a === cur.c.a);
      const pick = same && cands[0].score < same.score * switchGain() ? same : cands[0];
      if (!cur || cur.c.a !== pick.a) batches.push((cur = { c: pick, from: L, to: L }));
      cur.to = ++L;
    }
    let totalMs = 0, xpPrev = fromXp;
    for (const b of batches) {
      b.xpGain = Math.max(0, xpAt(b.to) - Math.max(xpPrev, xpAt(b.from)));
      b.ms = Math.max(1, Math.ceil(b.xpGain / b.c.xpPer)) * b.c.ms;
      totalMs += b.ms;
      xpPrev = xpAt(b.to);
    }
    return { batches, totalMs, blocked };
  };
  // Another skill can hold a better method back (steel needs coal, which needs Mining 30). Work out whether training that skill first
  // gets you to the target sooner, counting the time it takes. Returns { skill, level, T1, saveMs, detourMs } or null.
  const memo = (m, key, max, fn) => { if (m.has(key)) return m.get(key); if (m.size > max) m.clear(); const v = fn(); m.set(key, v); return v; };
  const detourMemo = new Map(), estMemo = new Map();
  const GATHER_SKILLS = ["melvorD:Mining", "melvorD:Woodcutting", "melvorD:Fishing"];
  const bestDetour = (skill, target, fromLevel = skill.level, fromXp = skill.xp ?? 0) => {
    if (!isTrainable(skill) || (COMBAT.has(skill.id) && skill.id !== MAGIC) || target - fromLevel < 3) return null;
    const key = `${skill.id}|${fromLevel}|${target}|${GATHER_SKILLS.map((id) => skillById(id)?.level ?? 0)}|${mastery()}`;
    return memo(detourMemo, key, 100, () => {
      let best = null;
      try {
        const base = trainPlan(skill, target, "", fromLevel, fromXp), T0 = base.blocked != null ? Infinity : base.totalMs;
        const bestRate = (lv, L) => trainCands(skill, lv.set(skill.id, L))[0]?.score ?? 0;
        for (const S of GATHER_SKILLS.map(skillById)) {
          if (!S || S === skill || !isTrainable(S)) continue;
          const levels = [...new Set(list(S.actions).filter((a) => realmOk(a) && lvl(a) > S.level && lvl(a) <= S.level + 30).map(lvl))].sort((x, y) => x - y);
          for (const R of levels) {
            // quick filter: does opening this level make any method better, now or near the end of the run?
            const better = (L) => { const was = bestRate(new Map(), L), now = bestRate(new Map([[S.id, R]]), L); return now > was * 1.1 || (was === 0 && now > 0); };
            if (!better(fromLevel) && !better(target - 1)) continue;
            const det = trainPlan(S, R, "", S.level, S.xp ?? 0);
            const after = det.blocked == null && det.batches.length && trainPlan(skill, target, "", fromLevel, fromXp, new Map([[S.id, R]]));
            if (!after || after.blocked != null) continue;
            const T1 = det.totalMs + after.totalMs;
            if (T1 < T0 * 0.9 && (T0 === Infinity || T0 - T1 > 120000) && (!best || T1 < best.T1)) best = { skill: S, level: R, T1, saveMs: T0 - T1, detourMs: det.totalMs };
          }
        }
      } catch (e) { console.warn(TAG, "detour check failed", e); }
      return best;
    });
  };
  // the next batch of real queue steps for a "train" entry, planned from the player's level and bank right now
  const nextBatch = (e) => {
    const skill = skillById(e.skillId);
    if (!skill) return fail("this skill wasn't found in your game version");
    // an Agility goal fills the empty slots of your course first (you confirm each obstacle)
    const picks = skill.id === AGILITY && !e.forced ? agilityPicks(e.noBuild) : [];
    if (picks.length) return { ok: true, entries: buildSteps(picks, e.id), note: `building your course first (${plural(picks.length, "obstacle")})` };
    // a Slayer goal with no task asks about rolling one
    if (skill.id === SLAYER && !e.noTask && !hasTask()) {
      const t = slayerTier();
      if (t) return { ok: true, entries: [{ kind: "ask", what: "slayer", skillId: SLAYER, actionId: t.c.id, qty: 1, parent: e.id, label: `Slayer: roll ${aOr(nm(t.c))} task` }], note: "asking you about a Slayer task first" };
    }
    // an Archaeology goal with no map to dig with makes one first (you confirm it), and picks your tools
    if (skill.id === ARCH) {
      for (const s of list(skill.actions)) pickTools(s);
      if (!e.noMap && !list(skill.actions).some((s) => lvl(s) <= skill.level && skill.canExcavate?.(s))) {
        const { site, hidden } = mapSite();
        if (!site && hidden) return fail("you haven't found a dig site you can map yet. Survey the map in Cartography to find one");
        if (site) {
          const mats = materialSteps(costsOf(game.cartography.getMapCreationCosts(site)).items, 1, e.id);
          if (!mats) return fail(`a map for ${nm(site)} needs something the queue can't get on its own`);
          return { ok: true, entries: [...mats, { kind: "ask", what: "map", skillId: ARCH, actionId: site.id, qty: 1, parent: e.id, label: `Make a map for ${nm(site)}` }], note: `making a map for ${nm(site)} first` };
        }
      }
    }
    const dt = !e.forced && !e.noDetour && bestDetour(skill, e.targetLevel);
    if (dt && (skillById(dt.skill.id)?.level ?? 0) < dt.level) return {
      ok: true,
      entries: [{ kind: "train", skillId: dt.skill.id, targetLevel: dt.level, targetXp: xpAt(dt.level), qty: xpAt(dt.level), noDetour: true, parent: e.id, label: `${nm(dt.skill)}: reach level ${dt.level} (opens better ${nm(skill)} methods)` }],
      note: `${nm(dt.skill)} to level ${dt.level} first, saves about ${fmtDur(dt.saveMs)} on ${nm(skill)}`,
    };
    const b = trainPlan(skill, e.targetLevel, e.forced).batches[0];
    if (!b) {
      // Attack, Strength, Ranged and Magic need the right weapon: switch to a set that has one, or wait for you to equip it
      if (weaponGap(skill)) {
        const i = setFor(skill), w = WEAPON[skill.id];
        return { ok: true, entries: [{ kind: "ask", what: "equip", skillId: skill.id, actionId: w, set: i, qty: 1, parent: e.id, label: i >= 0 ? `Switch to equipment set ${i + 1} (${w})` : `Equip a ${w} weapon` }],
          note: i >= 0 ? `switching to equipment set ${i + 1} first` : `waiting for you to equip a ${w} weapon` };
      }
      const fm = e.forced && methodById(skill, e.forced), why = blockedWhy(skill);
      return fail(fm ? `${fm.name} can't be trained by the queue at level ${skill.level}` : why ? `nothing at ${nm(skill)} level ${skill.level} can be trained right now: ${why}`
        : `nothing at ${nm(skill)} level ${skill.level} can be trained by the queue on its own (it may need shop items or monster drops)`);
    }
    const m = b.c.a, goalXp = Math.min(xpAt(b.to), e.targetXp ?? Infinity), note = `${m.name} until level ${b.to} (about ${num(Math.round(b.c.rate))} XP/h)`;
    const actions = Math.max(1, Math.min(stockCap(b.c.opt.costs), m.cap?.() ?? Infinity, Math.ceil((goalXp - (skill.xp ?? 0)) / b.c.xpPer)));
    // a method that makes nothing (or isn't the usual way to make its product) runs as an XP step after its materials
    if (b.c.st.own) {
      const entries = materialSteps(b.c.opt.costs, actions, e.id), xpPer = m.xp * m.succ;
      if (!entries) return fail(`${m.name} needs something the queue can't get on its own`);
      const last = { kind: "skill", skillId: skill.id, actionId: m.id, qty: Math.ceil(actions * xpPer), untilLevel: b.to, untilSkill: skill.id, parent: e.id, label: `${nm(skill)}: ${m.name}` };
      if (e.targetXp !== undefined && e.targetXp <= xpAt(b.to)) last.untilXp = e.targetXp;
      return { ok: true, entries: [...entries, last], to: b.to, note };
    }
    const item = m.product, entries = toEntries(buildRows(item, Math.max(1, Math.floor(actions * b.c.per + 1e-9)), true)), last = entries[entries.length - 1];
    if (last?.itemId !== item.id) return fail("couldn't work out the steps");
    if (entries.some((x) => x.kind === "manual")) return fail(`${nm(item)} needs something the queue can't get on its own`);
    Object.assign(last, { untilLevel: b.to, untilSkill: skill.id, sellAll: !!e.sellMade });
    if (e.targetXp !== undefined && e.targetXp <= xpAt(b.to)) last.untilXp = e.targetXp;
    for (const x of entries) x.parent = e.id;
    // Farming: offer to buy compost so every crop grows (skip it once and this goal plants without)
    const comp = itemById(COMPOST);
    // (not while this crop is already growing or ready to pick: the harvest may be all the goal needs)
    const busy = skill.id === FARMING && openPlots(skill, m.a).some((p) => p.plantedRecipe === m.a && (p.state === PLOT.growing || p.state === PLOT.grown));
    if (skill.id === FARMING && !busy && !e.noCompost && shopFor(comp) && owned(comp) < compostPer())
      entries.unshift({ kind: "ask", what: "buy", optional: true, skipFlag: "noCompost", skipNote: "Compost makes every crop grow. Skip plants without it for the rest of this goal.", itemId: COMPOST, qty: Math.ceil(actions * m.succ) * compostPer(), parent: e.id, label: "Buy compost for your crops" });
    return { ok: true, entries, to: b.to, note };
  };
  const trainEstimate = (e) => {
    const sk = skillById(e.skillId);
    if (!sk) return null;
    const fromL = e.afterLevel > sk.level ? e.afterLevel : sk.level;
    return memo(estMemo, `${e.id}|${fromL}|${e.targetLevel}|${mastery()}`, 200, () => {
      const fromXp = fromL === sk.level ? (sk.xp ?? 0) : xpAt(fromL), plan = trainPlan(sk, e.targetLevel, e.forced, fromL, fromXp);
      const dt = !e.forced && !e.noDetour && bestDetour(sk, e.targetLevel, fromL, fromXp);
      return dt ? dt.T1 : plan.blocked != null ? null : plan.totalMs;
    });
  };
  const rowsMs = (rows) => rows.reduce((s, n) => {
    if (n.recipe) return s + n.recipe.crafts * n.recipe.c.a.ms;
    const g = gatherer(n.item.id);
    return s + (g ? (n.qty * g.a.ms) / Math.max(1, g.a.qty) : 0);
  }, 0);

  // skills with something to do (Harvesting stays hidden until the Abyssal realm is unlocked)
  const trainSkills = () => list(game.skills).filter((s) => isTrainable(s) && methodsOf(s).length);
  // items a skill can be asked to make: its methods that are the usual way to make their product
  const makeables = (skill) => methodsOf(skill).filter((m) => m.product && stepFor(m) && !stepFor(m).own).sort((x, y) => x.level - y.level);
  // what a goal does first that the plan below doesn't show (switch gear, roll a Slayer task, make a map)
  const goalFirst = (sk) => {
    if (weaponGap(sk)) {
      const i = setFor(sk), w = WEAPON[sk.id];
      return i >= 0 ? `Your equipment set ${i + 1} has a ${w} weapon. This goal switches to it first and back when it's done.` : `You don't have a ${w} weapon on. When this goal starts it waits for you to equip one.`;
    }
    if (sk.id === SLAYER && !hasTask()) { const t = slayerTier(); if (t) return `You have no Slayer task. This goal asks you before rolling ${aOr(nm(t.c))} task (${t.safe.length} of its ${t.mons.length} monsters are safe for you).`; }
    if (sk.id === ARCH && !list(sk.actions).some((s) => lvl(s) <= sk.level && sk.canExcavate?.(s))) { const { site } = mapSite(); if (site) return `You have no map to dig with. This goal makes a map for ${nm(site)} first, once you confirm it.`; }
    return null;
  };

  // ---------- running steps (Action Queue asks the trainer) ----------
  const methodOf = (e) => methodById(skillById(e.skillId), e.actionId);
  const levelIssue = (e) => {
    const sk = skillById(e.skillId), m = ["craft", "gather", "skill", "kill"].includes(e.kind) && methodById(sk, e.actionId);
    return m && m.level > sk.level ? `Needs ${nm(sk)} level ${m.level} (you have ${sk.level})` : null;
  };
  const Trainer = {
    // what a step counts: XP for skill steps, kills for kill steps (items are counted by Action Queue)
    value: (e) => (e.kind === "skill" ? Math.floor(skillById(e.skillId)?.xp ?? 0) : e.kind === "kill" ? kills(e.monsterId) : undefined),
    actor: (e) => methodOf(e)?.actor ?? skillById(e.skillId) ?? null,
    start: (e) => startAction(e),
    ticks: (e) => !!methodOf(e)?.tick,
    tick: (e) => { const m = methodOf(e); return m?.tick ? m.tick(e) : null; },
    check: (e) => {
      const m = methodOf(e), s = m?.safe?.();
      if (s && !s.ok) return { why: `not safe while you're away: ${s.why}` };
      return m?.check?.() ?? null;
    },
    running: (e) => { const sk = skillById(e.skillId), m = methodOf(e); return m?.active ? m.active() : !!sk && sk.isActive && game.activeAction === sk; },
    foreign: (e) => { const m = methodOf(e), actor = m?.actor ?? skillById(e.skillId); return !!game.activeAction && (game.activeAction !== actor || (!!m?.active && !m.active())); },
    restock: (e) => restockCraft(e),
    plan: (e) => nextBatch(e),
    trainFinished: (e) => restoreSet(e),
    halt: () => restoreCombat(),
    changed: () => secMemo.m.clear(),
    // ms per unit (item, XP or kill), or the whole time for a goal
    estimate: (e) => {
      if (e.kind === "train") { const t = trainEstimate(e); return t === null ? null : { total: t }; }
      const m = methodOf(e);
      if (!m) return null;
      return { per: e.kind === "skill" ? m.ms / Math.max(1e-9, m.xp * m.succ) : e.kind === "gather" ? m.ms / Math.max(1, m.qty) : m.ms / perAttempt(m, { mult: m.options[e.altIndex ?? 0]?.mult ?? 1 }) };
    },
    issue: levelIssue,
    icon: (e) => methodOf(e) ?? skillById(e.skillId),
    // while crops grow: gathering, kills, or a skill step that uses no materials
    sideJobOk: (e) => { const m = ["gather", "skill", "kill"].includes(e.kind) && methodOf(e); return !!m && !m.tick && (e.kind !== "skill" || !m.options[0].costs.length); },
  };

  // ----- the Train a skill window -----
  // ----- the Train a skill window -----
  // messages show the icon of the skill picked in the window
  const tellPlayer = (m) => A.tell(m, skillById(TS.skillId));
  const dupHtml = (entries) => A.queue.dupHtml(entries);
  const TS = { skillId: null, goal: "level", make: null, qty: 100, level: null, forced: "", sell: false };
  const fixTrain = () => {
    let sk = skillById(TS.skillId);
    if (!isTrainable(sk)) { const open = skillById(game.openPage?.id); sk = isTrainable(open) ? open : trainSkills()[0]; TS.skillId = sk?.id ?? null; }
    if (!sk) return;
    const ms = makeables(sk), ok = ms.filter((m) => m.level <= sk.level), cap = levelCap(sk);
    if (!ms.length) TS.goal = "level"; // Thieving, Firemaking and others make nothing to ask for
    if (!ms.some((m) => m.id === TS.make)) TS.make = (ok[ok.length - 1] ?? ms[0])?.id ?? null;
    if (!(TS.level > sk.level) || TS.level > cap) TS.level = Math.min(cap, Math.max(sk.level + 1, Math.ceil((sk.level + 1) / 10) * 10));
    if (TS.forced && !trainCands(sk).some((c) => c.a.id === TS.forced)) TS.forced = "";
  };
  const opt = (v, l, sel) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(l)}</option>`;
  const select = (id, body) => `<select id="${id}" class="custom-select custom-select-sm">${body}</select>`;
  const field = (label, html) => `<label>${label}</label>${html}`;
  const check = (id, on, text) => field(id === "mst-tr-sell" ? "Selling" : "Mastery", `<label style="opacity:1"><input id="${id}" type="checkbox"${on ? " checked" : ""}> ${text}</label>`);
  const numberInput = (id, value, attrs) => `<input id="${id}" type="number" ${attrs} step="1" value="${value}" class="form-control form-control-sm">`;
  const trainForm = () => {
    const sk = skillById(TS.skillId);
    return `<div class="aq-form">` +
      field("Skill", select("mst-tr-skill", trainSkills().map((s) => opt(s.id, `${nm(s)} (level ${s.level})`, s.id === TS.skillId)).join(""))) +
      field("Goal", select("mst-tr-goal", opt("level", "Train to a level", TS.goal === "level") + (makeables(sk).length ? opt("make", "Make an amount of an item", TS.goal === "make") : ""))) +
      (TS.goal === "make"
        ? field("Item", select("mst-tr-item", makeables(sk).map((m) => opt(m.id, `${nm(m.product)} (level ${m.level}${m.level > sk.level ? ", locked" : ""})`, m.id === TS.make)).join(""))) +
          field("Amount", numberInput("mst-tr-qty", TS.qty, 'min="1"'))
        : field("Target level", numberInput("mst-tr-level", TS.level, `min="${sk.level + 1}" max="${levelCap(sk)}"`)) +
          field("Method", select("mst-tr-method", opt("", "Best available (recommended)", !TS.forced) + trainCands(sk).map((c) => opt(c.a.id, `${nm(c.a)} (about ${num(Math.round(c.rate))} XP/h)`, c.a.id === TS.forced)).join(""))) +
          check("mst-tr-sell", TS.sell, "Sell the items it makes") + check("mst-tr-mastery", mastery(), "Prefer mastery XP")) +
      `</div>`;
  };
  const nothing = (problem, html = note(esc(problem))) => ({ html, entries: [], problem });
  const trainMake = (sk) => {
    const act = methodById(sk, TS.make), qty = Math.max(1, Math.floor(TS.qty || 0)), item = act?.product;
    if (!item) return nothing("Pick an item first.", "");
    const miss = itemMissing(item, qty, true);
    if (miss.length) return nothing("You don't meet the requirements for that yet.", missingHtml(miss));
    const rows = buildRows(item, qty, true), entries = toEntries(rows);
    const xp = Math.ceil(qty / Math.max(1, act.qty * (stepFor(act)?.craft ? act.options[0].mult : 1))) * act.xp;
    const head = step(`<div class="aq-title">${icon(item)}<b>Make ${num(qty)} ${esc(nm(item))}</b></div>` +
      chips(chip(`About ${fmtDur(rowsMs(rows))}`, "ok", "Base speed, counting what your bank already holds"), chip(`${num(xp)} ${esc(nm(sk))} XP`, "", "Base XP, before bonuses")));
    return { html: dupHtml(entries) + head + itemSection(rows), entries };
  };
  // Agility: the obstacles the builder would add, with a button that queues them
  const courseHtml = (picks) => !picks.length ? "" : step(`<div class="aq-stepno">Your course</div><div class="aq-title"><b>${plural(picks.length, "empty slot")} can be filled</b></div>` +
    picks.map((x) => chips(chip(`${icon(x.o)}Slot ${x.slot + 1}: ${esc(nm(x.o))}`), chip(`${num(Math.round(x.xpSec * 3600))} XP/hour`), chip(esc(costText(x))))).join("") +
    chips('<button type="button" class="btn btn-sm btn-success" data-mst-build><i class="fa fa-hammer mr-1"></i>Build my course</button>') +
    note("Each obstacle asks you to confirm before anything is spent. An Agility goal builds them first too."));
  const queueBuild = () => {
    const picks = agilityPicks();
    if (!picks.length) return tellPlayer("Your course has no empty slots the builder can fill right now.");
    if (A.queue.add(buildSteps(picks), false, skillById(AGILITY))) tellPlayer(`Added ${plural(picks.length, "obstacle")} to build. You'll confirm each one before anything is spent.`);
    A.panel.open();
  };
  const trainLevel = (sk) => {
    const cap = levelCap(sk), L = Math.floor(TS.level || 0);
    if (!(L > sk.level) || L > cap) return nothing(sk.level >= cap ? `${nm(sk)} is already at its highest level.` : `Pick a target level between ${sk.level + 1} and ${cap}.`);
    const plan = trainPlan(sk, L, TS.forced || null), picks = sk.id === AGILITY && !TS.forced ? agilityPicks() : [];
    const goal = [{ kind: "train", skillId: sk.id, targetLevel: L, targetXp: xpAt(L), qty: xpAt(L), forced: TS.forced || undefined, sellMade: TS.sell, label: `${nm(sk)}: reach level ${L}` }];
    // an empty course can still take a goal: it builds first, then runs
    if (!plan.batches.length && picks.length) return { html: dupHtml(goal) + courseHtml(picks) + note("Your course is empty, so this goal builds it first and then runs it."), entries: goal };
    const first = !TS.forced && goalFirst(sk);
    if (!plan.batches.length && first) return { html: dupHtml(goal) + step(chips(chip(esc(first), "ok"))) + note("The plan is worked out once that's done."), entries: goal };
    if (!plan.batches.length) {
      const why = blockedWhy(sk), msg = why ? `Nothing here can be trained right now: ${why}.` : "Nothing here can be trained by the queue on its own at your level (it may need shop items or monster drops).";
      return nothing(msg, step(chips(chip(`${warnIcon}${esc(msg)}`, "warn"))));
    }
    const entries = goal, dt = !TS.forced && bestDetour(sk, L);
    const time = dt ? chip(`About ${fmtDur(dt.T1)}`, "ok", `Includes training ${esc(nm(dt.skill))} first`)
      : plan.blocked == null ? chip(`About ${fmtDur(plan.totalMs)}`, "ok", "Base speeds, gathering the materials included") : chip(`Plan covers up to level ${plan.blocked}`, "warn");
    let html = dupHtml(entries) + step(`<div class="aq-title">${icon(sk)}<b>${esc(nm(sk))}: level ${sk.level} to ${L}</b></div>` + chips(chip(`${num(Math.max(0, Math.ceil(xpAt(L) - (sk.xp ?? 0))))} XP to go`), time));
    if (dt) html += step(`<div class="aq-stepno">First</div><div class="aq-title">${icon(dt.skill)}<b>${esc(nm(dt.skill))} to level ${dt.level}</b></div>` +
      chips(chip(`About ${fmtDur(dt.detourMs)}`), chip(`Saves about ${fmtDur(dt.saveMs)}`, "ok", "Compared with staying on the methods you can use now")) +
      note(`Better ${esc(nm(sk))} methods need materials from ${esc(nm(dt.skill))} level ${dt.level}, so the queue trains it first.`));
    html += plan.batches.map((b, i) => {
      const a = b.c.a, uses = b.c.st.craft ? b.c.opt.costs.map((k) => chip(`${icon(k.item)}${num(k.quantity)} ${esc(nm(k.item))}`)).join("") : "";
      return step(`<div class="aq-stepno">${i === 0 ? "Starting at" : "Then at"} level ${b.from}${b.to > b.from ? ` (to ${b.to})` : ""}</div><div class="aq-title">${icon(a)}<b>${esc(a.name)}</b></div>` +
        chips(chip(`${num(Math.round(b.c.rate))} XP/hour`, "", "Counting the time to gather or make what it needs"), chip(`About ${fmtDur(b.ms)}`)) + (uses ? chips(chip("<b>Each uses</b>", "lbl"), uses) : ""));
    }).join("");
    const okIds = !TS.forced && new Set(trainCands(sk).map((c) => c.a.id));
    const skipped = okIds && methodsOf(sk).some((m) => m.level <= sk.level && m.xp > 0 && m.safe?.().ok !== false && !okIds.has(m.id) && xpRate(m) > plan.batches[0].c.rate);
    html += courseHtml(picks) + (first ? step(chips(chip(esc(first), "ok"))) : "");
    html += note("Methods are ranked by XP per hour including the time to gather what they need, so it won't farm a mountain of materials for little XP. The queue re-checks your level and bank after every batch." +
      (skipped ? " Some faster methods are left out because their materials need higher levels in other skills, or come from the shop or monsters." : ""));
    return { html, entries };
  };
  const trainBuild = () => {
    const sk = skillById(TS.skillId);
    return !sk ? nothing("No trainable skill found.") : TS.goal === "make" ? trainMake(sk) : trainLevel(sk);
  };
  const trainQueue = (top) => {
    const b = trainBuild();
    if (!b.entries.length) return tellPlayer(b.problem || "Nothing to add.");
    const added = A.queue.add(b.entries, top, skillById(TS.skillId));
    A.panel.open();
    if (added && A.settings.get("autoStart") && A.runner.state !== "running") A.runner.start();
  };
  // what each form field changes; "redraw" means the form itself depends on it
  const FIELDS = {
    "mst-tr-skill": (el) => { Object.assign(TS, { skillId: el.value, make: null, level: null, forced: "" }); return true; },
    "mst-tr-goal": (el) => { TS.goal = el.value; return true; },
    "mst-tr-item": (el) => { TS.make = el.value; },
    "mst-tr-qty": (el) => { TS.qty = Math.max(1, Math.floor(Number(el.value) || 1)); },
    "mst-tr-level": (el) => { TS.level = Math.floor(Number(el.value) || 0); },
    "mst-tr-method": (el) => { TS.forced = el.value; },
    "mst-tr-sell": (el) => { TS.sell = el.checked; },
    "mst-tr-mastery": (el) => { Settings.set("preferMastery", el.checked); },
  };
  const onTrainEvent = (popup, ev) => {
    const el = ev.target, fn = FIELDS[el?.id];
    if (!fn || (ev.type === "input" && (el.tagName === "SELECT" || el.type === "checkbox"))) return;
    if (fn(el)) { fixTrain(); popup.querySelector("#mst-tr-form").innerHTML = trainForm(); }
    const prev = popup.querySelector("#mst-tr-prev");
    if (prev) prev.innerHTML = trainBuild().html;
  };
  const openTrain = () => {
    Object.assign(TS, { skillId: null, make: null, level: null, forced: "" });
    fixTrain();
    if (!TS.skillId) return;
    SwalLocale.fire({
      title: "Train a skill",
      html: `<div class="text-center font-size-sm aq-pop"><div id="mst-tr-form">${trainForm()}</div><div id="mst-tr-prev">${trainBuild().html}</div></div>`,
      confirmButtonText: "Close", showDenyButton: true, denyButtonText: '<i class="fa fa-play mr-1"></i>Add to queue',
      showCancelButton: true, cancelButtonText: '<i class="fa fa-arrow-up mr-1"></i>Add to top',
      customClass: { popup: "aq-swal", confirmButton: "btn btn-primary m-1", denyButton: "btn btn-success m-1", cancelButton: "btn btn-warning m-1" },
      didOpen: (popup) => {
        for (const t of ["input", "change"]) popup.addEventListener(t, (ev) => onTrainEvent(popup, ev));
        popup.addEventListener("click", (ev) => { if (ev.target.closest?.("[data-mst-build]")) { queueBuild(); const prev = popup.querySelector("#mst-tr-prev"); if (prev) prev.innerHTML = trainBuild().html; } });
      },
      width: 620,
    })?.then?.((r) => { try { if (r?.isDenied) trainQueue(false); else if (r?.dismiss === "cancel") trainQueue(true); } catch (e) { console.warn(TAG, e); } });
  };
  // ---------- install ----------
  const API = {
    version: VERSION, settings: Settings, mastery,
    skills: { list: trainSkills, byId: skillById, isTrainable, methodsOf, methodById, makeables, stepFor, xpRate, levelCap, xpAt, levelIn, COMBAT, WEAPON },
    items: { crafter, gatherer, shopOnly, buyLeft, index: () => index() },
    plan: { buildRows, rowsFor, toEntries, materialSteps, makeTime, acquire, itemMissing, missingHtml, itemSection, rowsMs, trainCands, trainPlan, bestDetour, blockedWhy, goalFirst, agilityPicks, buildSteps, nextBatch },
    fightId, HITPOINTS,
    // other mods can say where an item comes from (monster drops, gems): fn(item, qty) returns a step, or nothing
    addSource: (fn) => { if (typeof fn === "function") SOURCES.push(fn); },
    openTrain: () => openTrain(),
    _dev: { Trainer, secMemo, startAction, restockCraft },
  };
  try { ctx?.api?.(API); } catch (e) { console.warn(TAG, "could not register the mod API", e); }
  window.skillTrainer = API;
  const mount = () => { if (A) A.addButton("mst-train-btn", "Train a skill: queue an item or a level goal", "fa-chart-line", 16, () => openTrain()); };
  const install = () => {
    A = aq();
    if (!A) {
      const msg = "Skill Trainer needs the Action Queue mod. Install Action Queue from the Mod Manager, then reload the game.";
      try { SwalLocale.fire({ title: "Skill Trainer", html: msg, icon: "warning" }); } catch (e) { console.warn(TAG, msg); }
      return;
    }
    A.setTrainer(Trainer);
    for (const [what, def] of Object.entries(ASKS)) A.addAsk(what, def);
    mount();
    clearInterval(window.__mstTimer);
    window.__mstTimer = setInterval(mount, 2000); // the game can rebuild the menu; put the button back if it vanishes
    console.log(TAG, "installed", VERSION);
  };
  const ready = () => typeof game !== "undefined" && list(game?.skills).length > 0 && typeof SwalLocale !== "undefined" && document.getElementById("skill-footer-minibar");
  // wait a moment past the game loading so Action Queue (a dependency) is set up first
  const go = () => setTimeout(install, 1500);
  if (ready()) go();
  else { const timer = setInterval(() => { if (ready()) { clearInterval(timer); go(); } }, 500); }
}
