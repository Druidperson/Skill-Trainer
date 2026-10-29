// Skill Trainer: train a skill or make an item, with the queue planning and running the work
export function setup(ctx) {
  const VERSION = "1.0.0", TAG = "[Skill Trainer]";

  // ---------- small helpers ----------
  const list = (r) => r?.allObjects ?? (r?.registeredObjects ? [...r.registeredObjects.values()] : []);
  const nm = (o) => String(o?.name ?? o?._name ?? o?._localID ?? o?.id ?? "?");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => Number(n).toLocaleString();
  const plural = (n, w, ws = w + "s") => `${num(n)} ${n === 1 ? w : ws}`;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
  const chip = (html, cls = "", title = "") => `<span class="mst-chip ${cls}"${title ? ` title="${esc(title)}"` : ""}><span>${html}</span></span>`;
  const chips = (...c) => `<div class="mst-chips">${c.join("")}</div>`;
  const step = (body) => `<div class="mst-step">${body}</div>`;
  const note = (t) => `<div class="mst-note">${t}</div>`;

  // ---------- settings ----------
  // The switches live in the mod settings menu (ctx.settings), with localStorage as the fallback (userscript use).
  const SETTINGS = {
    autoStart: ["mst-th-autostart", false, "Automatically start the queue when adding a training goal",
      "When on, adding a training goal to the queue starts the queue right away. When off, you press Start yourself."],
    preferMastery: ["mst-th-mastery", false, "Prefer mastery XP when training a skill",
      "When on, the planner counts the mastery XP a method gives next to the skill XP, and sticks with a method longer so its mastery keeps growing. When off, it only looks at skill XP per hour."],
    autoSell: ["mst-th-autosell", true, "Automatically sell extras the queue makes",
      "When a step makes more than the task needs (like arrowtips crafted in batches), the extra is sold. It never sells anything you already owned."],
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
  const MANUAL_NOTE = "Skill Trainer can't get this on its own, so it's a step you do yourself";
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
      if (t !== -3 && t !== -4) return [];
      return bars.map((r) => method(skill, sp, {
        ...base, id: `${sp.id}|${r.id}`, name: `${nm(sp)} (${nm(r.product)})`, media: r.product.media, product: r.product, own: true, start: cast(sp, r),
        need: (lv) => (levelIn(game.smithing, lv) >= lvl(r) ? null : `needs Smithing level ${lvl(r)}`),
        get options() { return [{ costs: [...r.itemCosts.filter((k) => t === -3 || k.item.id !== "melvorD:Coal_Ore").map((k) => ({ item: k.item, quantity: k.quantity * (sp.specialCost.quantity ?? 1) })), ...runes(sp), ...fixed], mult: 1 }]; },
      }));
    });
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
  // without compost a crop only grows about half the time, and a dead crop gives nothing
  const cropChance = (f, r) => { try { return Math.min(1, Math.max(0.05, f.getPlotGrowthChance({ compostLevel: 0, plantedRecipe: r }) / 100)); } catch (e) { return 1; } };
  const farmTick = (f, r, e) => {
    const plots = openPlots(f, r), mine = (p) => p.plantedRecipe === r, m = methodById(f, r.id);
    if (!plots.length) return { block: `you haven't unlocked any ${nm(r.category)} plots yet` };
    for (const p of plots) if (mine(p) && p.state === PLOT.dead) f.clearDeadPlot(p);
    for (const p of plots) if (mine(p) && p.state === PLOT.grown) f.harvestPlot(p);
    const left = e.qty - Runner.gained(e), growing = plots.filter((p) => mine(p) && p.state === PLOT.growing).length;
    if (left <= 0) return {};
    const want = Math.ceil(left / Math.max(1e-9, e.kind === "skill" ? m.xp * m.succ : Math.max(1, m.qty) * m.succ)) - growing;
    if (want > 0) {
      const empty = plots.filter((p) => p.state === PLOT.empty), cost = seedCost(f, r), seeds = owned(r.seedCost.item);
      const n = Math.min(want, empty.length, Math.floor(seeds / cost)), timers = new Map();
      // the game starts one growth timer per planting time, the same way its own Plant All button does
      for (const p of empty.slice(0, n)) { const t = f.plantPlot(p, r); if (t > 0 && p.state === PLOT.growing) timers.set(t, [...(timers.get(t) ?? []), p]); }
      timers.forEach((ps, t) => f.createGrowthTimer(ps, t));
      if (n === 0 && !growing) return { block: empty.length ? `needs ${cost} ${nm(r.seedCost.item)} to plant ${nm(r)} and you have ${seeds}` : `all your ${nm(r.category)} plots are busy with other crops. Harvest or clear them` };
    }
    const now = plots.filter((p) => mine(p) && p.state === PLOT.growing);
    if (!now.length) return {};
    const ms = Math.max(...now.map((p) => { try { return f.getPlotGrowthTime(p); } catch (err) { return 0; } }));
    return { note: `Waiting for ${nm(r)} to grow: ${plural(now.length, "plot")} planted, ready in ${fmtDur(ms)}` };
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
  // Archaeology digs at sites that have a map with charges and tools picked. Maps come from Cartography and aren't made here.
  SKILLS["melvorAoD:Archaeology"] = (s, site) => method(s, site, {
    product: null, options: NO_COSTS, get xp() { return s.getBaseSkillXPForDigSite?.(site) ?? 0; }, get ms() { return s.getDigSiteInterval?.(site) ?? intervalMs(s, site); },
    need: () => (s.canExcavate?.(site) ? null : `needs a map for ${nm(site)} with charges, and your tools picked (maps come from Cartography)`),
    check: () => (site.selectedMap?.charges > 0 ? null : { why: `the ${nm(site)} map is out of charges` }), start: () => s.startDigging(site),
  });
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
  const buildCosts = (o) => { const c = game.agility.getObstacleBuildCosts(o); return { c, items: c.getItemQuantityArray(), cur: c.getCurrencyQuantityArray() }; };
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
  const costText = (x) => [...x.cur.map((k) => `${num(k.quantity)} ${nm(k.currency)}`), ...x.items.map((k) => `${num(k.quantity)} ${nm(k.item)}`)].join(" + ") || "free";
  // the queue steps for a set of picks: gather the items, then a build step each
  const buildSteps = (picks, parent) => picks.flatMap((x) => [...(materialSteps(x.items, 1, parent) ?? []),
    { kind: "build", skillId: AGILITY, actionId: x.o.id, slot: x.slot, qty: 1, parent, label: `Agility: build ${nm(x.o)}` }]);
  // the confirm window; the answer is kept on the step and the queue carries on
  const askBuild = (e, o) => {
    const x = { o, ...buildCosts(o) }, slot = game.agility.activeCourse.obstacleSlots[o.category];
    const mods = (o.modifiers ?? []).map((v) => { try { return v.getDescription().description; } catch (err) { return ""; } }).filter(Boolean);
    SwalLocale.fire({
      title: "Build an Agility obstacle?", width: 560, showCancelButton: true, confirmButtonText: "Build", cancelButtonText: "Skip",
      html: `<div class="text-center font-size-sm mst-th-pop">` + step(`<div class="mst-title">${icon(o)}<b>${esc(nm(o))}</b></div>` +
        chips(chip(`Slot ${o.category + 1} (Agility level ${slot?.level ?? 1})`), chip(`${num(o.baseExperience ?? 0)} XP per lap`), chip(`${num((o.baseInterval ?? 0) / 1000)} s`)) +
        chips(chip("<b>Costs</b>", "lbl"), chip(esc(costText(x)))) + (mods.length ? chips(chip("<b>Bonuses</b>", "lbl"), ...mods.map((d) => chip(esc(d), "ok"))) : "")) +
        note("Building can't be undone. Skip leaves this slot empty for this goal.") + `</div>`,
    })?.then?.((r) => { e.answer = r?.isConfirmed ? "build" : r?.dismiss === "cancel" ? "skip" : undefined; e.asking = false; Queue.save(); if (e.answer) Runner.start(); });
  };

  // Cartography trains here by making paper from logs. Surveying the map stays with you.
  const cartographyMethods = (s) => list(s.paperRecipes).filter(realmOk).map((r) => method(s, r, {
    get options() { return [{ costs: (r.costs?.items ?? []).filter((k) => k?.item), mult: 1 }]; },
    get ms() { return s.getPaperMakingInterval?.(r) ?? s.BASE_PAPER_MAKING_INTERVAL ?? 5000; },
    start: () => { s.selectPaperRecipeOnClick(r); if (!s.isActive) s.makePaperOnClick(); },
  }));
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
    if (skill.id === PRAYER && !(pl.prayerPoints > 0)) return "needs prayer points (bury some bones first)";
    return null;
  };
  // checked every second while a fight runs: runes, ammo and prayer points can run out
  const fightCheck = (skill) => {
    const pl = player(), sp = pl.spellSelection.attack;
    if (skill.id === PRAYER && !(pl.prayerPoints > 0)) return { why: "out of prayer points (bury some bones for more)" };
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
  const fighting = (m) => game.activeAction === game.combat && game.combat.selectedMonster === m;
  const startFight = (skill, m, area) => {
    const pl = player(), style = styleFor(skill), pr = skill.id === PRAYER && bestPrayer();
    if (game.activeAction && !fighting(m)) game.stopActiveAction();
    savedCombat ??= { type: pl.attackType, style: pl.attackStyles[pl.attackType], prayers: [...pl.activePrayers] };
    if (style && pl.attackStyles[pl.attackType] !== style) pl.setAttackStyle(pl.attackType, style);
    if (pr && !pl.activePrayers.has(pr)) pl.togglePrayer(pr);
    if (!fighting(m)) game.combat.selectMonster(m, area);
  };
  // the numbers behind each fight are worked out once a second, since the planner asks for them many times
  const fightMemo = { t: 0, m: new Map() };
  const fightEval = (key, fn) => {
    const t = Math.floor(Date.now() / 1000);
    if (t !== fightMemo.t) Object.assign(fightMemo, { t, m: new Map() });
    if (!fightMemo.m.has(key)) fightMemo.m.set(key, fn());
    return fightMemo.m.get(key);
  };
  const fightMethods = (skill) => [...list(game.combatAreas), ...list(game.slayerAreas)].filter(realmOk).flatMap((area) => (area.monsters ?? []).filter((m) => realmOk(m) && m.levels).map((m) => {
    const ev = () => fightEval(`${skill.id}|${area.id}|${m.id}`, () => ({ ...killStats(m), xp: xpPerKill(skill, m, area), hit: maxTaken(m) }));
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
          : chips(chip(MANUAL_NOTE, "warn")));
      }
      return step(`<div class="mst-stepno">Step ${i + 1}</div><div class="mst-title">${title}</div>${body}`);
    }).join("");
  };
  // Queue entries: "kind" is what the runner does; qty is how many MORE of the item to end up with
  // (for "manual" entries it is how many you should own).
  const toEntries = (rows) => rows.map((n) => {
    const base = { itemId: n.item.id, qty: n.qty }, c = n.recipe?.c, g = !c && gatherer(n.item.id);
    if (c) return { ...base, kind: "craft", skillId: c.skill.id, actionId: c.a.id, altIndex: 0, label: `${nm(c.skill)}: make ${nm(n.item)}` };
    if (g) return { ...base, kind: "gather", skillId: g.skill.id, actionId: g.a.id, label: `${nm(g.skill)}: gather ${nm(n.item)}` };
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

  // ---------- queue (saved locally, one list per character name) ----------
  // gather and craft run a game action until you have more of an item, skill runs one until it has given enough XP,
  // manual waits for the player, train plans the next batch of steps
  const KINDS = new Set(["gather", "craft", "skill", "manual", "train", "build"]);
  const Queue = {
    items: [],
    key: () => `mst-th-queue:${game.characterName ?? "default"}`,
    load() {
      try { this.items = JSON.parse(stored(this.key()) ?? "[]").filter((e) => KINDS.has(e.kind)); } catch (e) { this.items = []; }
      // the runner never survives a reload, so nothing is "in progress" any more (progress counts are kept)
      for (const e of this.items) { if (["active", "waiting", "blocked"].includes(e.status)) e.status = "pending"; for (const k of ["reason", "ack", "t0", "g0", "asking"]) delete e[k]; }
      updateBadge();
    },
    save() { if (!store(this.key(), JSON.stringify(this.items))) console.warn(TAG, "could not save queue"); updateBadge(); Panel.render(); },
    pos: (id) => Queue.items.findIndex((e) => e.id === id),
    fresh: (entries) => entries.map((e) => ({ ...e, id: uid(), status: "pending" })),
    add(entries, top = false) { this.items = top ? [...this.fresh(entries), ...this.items] : [...this.items, ...this.fresh(entries)]; this.save(); },
    insertBefore(id, entries) { const i = this.pos(id); this.items.splice(i < 0 ? this.items.length : i, 0, ...this.fresh(entries)); this.save(); },
    remove(id) { this.items = this.items.filter((e) => e.id !== id); this.save(); },
    move(id, dir) { const i = this.pos(id), j = i + dir; if (i >= 0 && j >= 0 && j < this.items.length) { [this.items[i], this.items[j]] = [this.items[j], this.items[i]]; this.save(); } },
    toTop(id) { const i = this.pos(id); if (i > 0) { this.items.unshift(...this.items.splice(i, 1)); this.save(); } },
    clearDone() { this.items = this.items.filter((e) => e.status !== "done"); this.save(); },
    clear() { Runner.stop(); this.items = []; this.save(); },
  };
  const updateBadge = () => {
    const b = document.querySelector("#mst-queue-btn .mst-count"), n = Queue.items.filter((e) => e.status !== "done").length;
    if (b) { b.textContent = n ? String(n) : ""; b.style.display = n ? "block" : "none"; }
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
    if (!m) return fail("this action wasn't found in your game version");
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

  // ---------- time estimates (base speeds; the active entry switches to its measured speed after a few seconds) ----------
  const estimateMs = (e) => {
    if (e.kind === "manual" || e.kind === "build" || e.status === "done") return 0;
    if (e.kind === "train") return trainEstimate(e);
    const units = Math.max(0, e.qty - Runner.gained(e));
    if (units <= 0) return 0;
    const m = methodById(skillById(e.skillId), e.actionId);
    if (!m) return null;
    // ms per unit: per item for gather and craft, per XP for a skill step
    let per = e.kind === "skill" ? m.ms / Math.max(1e-9, m.xp * m.succ) : e.kind === "gather" ? m.ms / Math.max(1, m.qty) : m.ms / perAttempt(m, { mult: m.options[e.altIndex ?? 0]?.mult ?? 1 });
    if (Runner.state === "running" && Runner.activeId === e.id && e.t0 !== undefined) {
      const dt = Date.now() - e.t0, dg = Runner.gained(e) - e.g0;
      if (dt > 10000 && dg > 0) per = dt / dg;
    }
    return units * per;
  };
  const fmtDur = (ms) => { if (!isFinite(ms)) return "an unknown time"; const m = Math.round(ms / 60000); return m < 1 ? "under 1 min" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const fmtClock = (ms) => {
    const d = new Date(Date.now() + ms), t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
  };

  // ---------- runner: takes entries from the top of the list, one at a time ----------
  const Runner = {
    state: "idle", // idle | running | paused
    message: "", activeId: null, activeActor: null,
    focusId: null, // "Do this first": run this entry now without moving it in the list
    elapsed: 0, lastTick: null, // running time since the queue was started (for the progress bar)
    setState(s, msg = "") { this.state = s; this.message = msg; Panel.render(); },
    eta() {
      const r = { ms: 0, unknown: 0, manual: 0 };
      for (const e of Queue.items.filter((x) => x.status !== "done")) {
        const t = e.kind === "manual" ? null : estimateMs(e);
        if (e.kind === "manual") r.manual++; else if (t === null) r.unknown++; else r.ms += t;
      }
      return r;
    },
    current() { const f = this.focusId && Queue.items.find((e) => e.id === this.focusId && e.status !== "done"); if (!f) this.focusId = null; return f || Queue.items.find((e) => e.status !== "done"); },
    doFirst(id) {
      const e = Queue.items.find((x) => x.id === id);
      if (!e || e.status === "done") return;
      this.focusId = id;
      if (e.status === "blocked" || e.status === "waiting") e.status = "pending";
      if (this.state === "running") { this.step(); Panel.render(); } else this.start();
    },
    // what a step counts: XP for skill steps, otherwise how many of its item you own
    value: (e) => (e.kind === "skill" ? Math.floor(skillById(e.skillId)?.xp ?? 0) : owned(itemById(e.itemId))),
    gained(e) { return e.kind === "train" ? Math.floor(skillById(e.skillId)?.xp ?? 0) : e.startQty === undefined ? 0 : Math.max(0, this.value(e) - e.startQty); },
    // what runs a step in the game: the skill, or combat for a fight
    actorOf: (e) => methodById(skillById(e.skillId), e.actionId)?.actor ?? skillById(e.skillId) ?? null,
    halt(actor = this.activeActor) { try { if (actor && game.activeAction === actor) game.stopActiveAction(); } catch (e) { console.warn(TAG, e); } restoreCombat(); },
    release() { this.activeId = null; this.activeActor = null; },
    leave() {
      if (this.activeId === null) return;
      const prev = Queue.items.find((e) => e.id === this.activeId);
      if (prev?.status === "active") prev.status = "pending";
      this.halt(); this.release();
    },
    start() {
      const cur = this.current();
      if (!cur) return this.setState("idle", "Nothing to run: the queue is empty or finished.");
      if (cur.kind === "manual" && cur.status === "waiting") cur.ack = true;
      if (cur.kind === "build") cur.asking = false;
      if (this.state === "idle") this.elapsed = 0;
      Object.assign(this, { state: "running", message: "" }).step();
      Panel.render();
    },
    // keep = you started something yourself: leave it running, just put your combat settings back
    pause(msg = "Paused", keep = false) { if (this.state === "running") { if (keep) restoreCombat(); else this.halt(); this.setState("paused", msg); } },
    stop() {
      this.halt();
      const cur = Queue.items.find((e) => e.id === this.activeId);
      if (cur && cur.status !== "done") { cur.status = "pending"; delete cur.startQty; delete cur.reason; }
      // a manual step that was waiting for you goes back to pending, so pressing Start later doesn't count it as done
      for (const e of Queue.items) if (e.status === "waiting") e.status = "pending";
      this.release();
      Object.assign(this, { focusId: null, elapsed: 0, state: "idle", message: "Stopped" });
      Queue.save();
    },
    block(entry, reason) {
      Object.assign(entry, { status: "blocked", reason });
      this.halt(); this.release(); Queue.save();
      this.setState("paused", `Stopped at "${entry.label}": ${reason}. Fix it, then press Start.`);
    },
    sellExtra(entry) {
      try {
        if ((!Settings.get("autoSell") && !entry.sellAll) || (entry.kind !== "craft" && entry.kind !== "gather") || entry.startQty === undefined) return;
        const item = itemById(entry.itemId), bi = item?.sellsFor?.quantity > 0 && game.bank.items.get(item);
        if (!bi || bi.locked) return;
        const extra = Math.min(bi.quantity, bi.quantity - entry.startQty - (entry.sellAll ? 0 : entry.qty));
        if (!(extra >= 1)) return;
        const price = game.bank.getItemSalePrice(item, extra);
        game.bank.processItemSale(item, extra);
        entry.sold = `Sold ${num(extra)}${entry.sellAll ? "" : " extra"} for ${num(price)} ${nm(item.sellsFor.currency)}`;
      } catch (e) { console.warn(TAG, "auto-sell", e); }
    },
    finish(entry) { this.sellExtra(entry); entry.status = "done"; delete entry.reason; this.halt(this.actorOf(entry)); this.release(); Queue.save(); },
    wait(msg) { this.message = msg; Panel.render(); },
    step() {
      if (this.state !== "running") { this.lastTick = null; return; }
      const nowT = Date.now();
      if (this.lastTick) this.elapsed += Math.min(nowT - this.lastTick, 5000);
      this.lastTick = nowT;
      for (let guard = 0; guard < 100; guard++) {
        const cur = this.current();
        if (!cur) { this.leave(); return this.setState("idle", "Queue finished"); }

        // a "train to level" entry never runs itself: it works out the next batch of steps, puts them above itself, and comes back
        if (cur.kind === "train") {
          const sk = skillById(cur.skillId);
          if (!sk || sk.level >= cur.targetLevel) { this.finish(cur); continue; }
          const xpNow = Math.floor(sk.xp ?? 0);
          cur.stall = cur.lastXp !== undefined && xpNow <= cur.lastXp ? (cur.stall ?? 0) + 1 : 0;
          cur.lastXp = xpNow;
          if (cur.stall >= 2) return this.block(cur, "training isn't giving any XP, so the plan stopped. Check the steps above it");
          const nb = nextBatch(cur);
          if (!nb.ok) return this.block(cur, nb.reason);
          cur.now = nb.note; if (nb.to !== undefined) cur.afterLevel = nb.to;
          Queue.insertBefore(cur.id, nb.entries);
          continue;
        }

        // a build step asks you, then builds or skips
        if (cur.kind === "build") {
          const ag = game.agility, o = list(ag?.actions).find((x) => x.id === cur.actionId), parent = Queue.items.find((x) => x.id === cur.parent);
          this.leave();
          if (!o) return this.block(cur, "this obstacle wasn't found in your game version");
          const there = o.course?.builtObstacles?.get(o.category) ?? ag.activeCourse.builtObstacles.get(o.category);
          if (there) { cur.sold = there === o ? "Already built" : `Slot already has ${nm(there)}`; this.finish(cur); continue; }
          if (cur.answer === "skip") { if (parent) parent.noBuild = [...(parent.noBuild ?? []), o.category]; cur.sold = "Skipped"; this.finish(cur); continue; }
          if (!ag.getObstacleBuildCosts(o).checkIfOwned()) return this.block(cur, `you can't pay for ${nm(o)} right now (${costText({ o, ...buildCosts(o) })})`);
          if (cur.answer === "build") { ag.buildObstacle(o); cur.sold = "Built"; this.finish(cur); continue; }
          if (!cur.asking) { cur.asking = true; askBuild(cur, o); }
          cur.status = "waiting";
          Queue.save();
          return this.setState("paused", `Your turn: confirm building ${nm(o)}, or skip it.`);
        }

        // a different entry is now on top (we just started, or something was added above): switch to it
        if (this.activeId !== cur.id) {
          this.leave();
          Object.assign(this, { activeId: cur.id, activeActor: this.actorOf(cur) });
          cur.status = "active"; delete cur.reason;
          if (cur.kind !== "manual" && cur.startQty === undefined) cur.startQty = this.value(cur);
          Queue.save();
          if (cur.kind !== "manual" && !methodById(skillById(cur.skillId), cur.actionId)?.tick) {
            const r = startAction(cur);
            // a step with no materials is handled below: it adds the steps to get them
            if (!r.ok && !r.noMaterials) return r.transient ? this.wait(r.reason) : this.block(cur, r.reason);
          }
          Object.assign(cur, { t0: Date.now(), g0: this.gained(cur) });
        }

        const got = this.value(cur);
        if (cur.kind === "manual") {
          if (got >= cur.qty || cur.ack) { this.finish(cur); continue; }
          cur.status = "waiting";
          this.release(); Queue.save();
          return this.setState("paused", `Your turn: ${cur.label} x${num(cur.qty)} (you have ${num(got)}). Do it, then press Start.`);
        }
        const us = cur.untilLevel && skillById(cur.untilSkill ?? cur.skillId);
        if (us && (us.level >= cur.untilLevel || (cur.untilXp && (us.xp ?? 0) >= cur.untilXp))) { this.finish(cur); continue; }
        if (got - (cur.startQty ?? 0) >= cur.qty) { this.finish(cur); continue; }

        const skill = skillById(cur.skillId), m = methodById(skill, cur.actionId), safety = m?.safe?.(), chk = m?.check?.(), actor = m?.actor ?? skill;
        // a Farming step has no action to run: it plants, waits and harvests
        if (m?.tick) { const t = m.tick(cur); if (t.block) return this.block(cur, t.block); return this.wait(t.note ?? ""); }
        // food, runes, ammo and prayer points can run out mid-step: stop before it isn't safe any more
        if (safety && !safety.ok) return this.block(cur, `not safe while you're away: ${safety.why}`);
        if (chk && !chk.noMaterials) return this.block(cur, chk.why);
        if (!chk && (m?.active ? m.active() : skill && skill.isActive && game.activeAction === skill)) return Panel.render();
        // something else started, or you picked another fight yourself
        if (game.activeAction && (game.activeAction !== actor || (m?.active && !m.active()))) return this.pause("Paused: something else started running.", true);

        // nothing is running and the target isn't reached: the game stopped it (materials, etc.) so try again once
        const r = chk ? fail(chk.why, { noMaterials: true }) : startAction(cur);
        if (r.ok) return Panel.render();
        if (r.transient) return this.wait(r.reason);
        const made = this.gained(cur), of = `(${num(made)} of ${num(cur.qty)} done)`;
        if (!r.noMaterials) return this.block(cur, `${r.reason} ${of}`);
        cur.restockStall = cur.restockMade !== undefined && made <= cur.restockMade ? (cur.restockStall ?? 0) + 1 : 0;
        cur.restockMade = made;
        const rs = restockCraft(cur);
        if (!rs.ok || cur.restockStall >= 2) return this.block(cur, `${rs.ok ? "it keeps running out of materials without making more" : rs.reason} ${of}`);
        cur.restocks = (cur.restocks ?? 0) + 1;
        Queue.insertBefore(cur.id, rs.entries);
        this.message = cur.kind === "skill" ? `Short of materials for ${rs.name}: getting enough for ${plural(rs.crafts, "more try", "more tries")}` : `Short of materials for ${nm(itemById(cur.itemId))}: getting ${num(rs.remaining)} more worth`;
      }
    },
  };
  // A craft step ran out of ingredients before it made enough (Cooking burns food, Smithing and others can come up short):
  // work out what is still missing and the steps that get it
  const restockCraft = (e) => {
    const m = methodById(skillById(e.skillId), e.actionId), item = itemById(e.itemId), name = e.kind === "skill" ? m?.name : nm(item);
    if (!m || (e.kind !== "skill" && !item)) return fail("this action wasn't found in your game version");
    const opt = m.options[e.altIndex ?? 0] ?? m.options[0], remaining = e.qty - Runner.gained(e);
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
  // how many attempts the bank allows for the costs the queue can't get itself
  const stockCap = (costs) => Math.min(Infinity, ...costs.filter((k) => !isFinite(makeTime(k.item, 1).ms)).map((k) => Math.floor(owned(k.item) / k.quantity)));
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
    for (const m of methodsOf(skill)) {
      if (m.level > skill.level) continue;
      const need = m.need?.();
      if (need) return need;
      const safe = m.xp > 0 && m.safe?.();
      if (safe && !safe.ok) return `it isn't safe while you're away (${safe.why})`;
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
    const dt = !e.forced && !e.noDetour && bestDetour(skill, e.targetLevel);
    if (dt && (skillById(dt.skill.id)?.level ?? 0) < dt.level) return {
      ok: true,
      entries: [{ kind: "train", skillId: dt.skill.id, targetLevel: dt.level, targetXp: xpAt(dt.level), qty: xpAt(dt.level), noDetour: true, parent: e.id, label: `${nm(dt.skill)}: reach level ${dt.level} (opens better ${nm(skill)} methods)` }],
      note: `${nm(dt.skill)} to level ${dt.level} first, saves about ${fmtDur(dt.saveMs)} on ${nm(skill)}`,
    };
    const b = trainPlan(skill, e.targetLevel, e.forced).batches[0];
    if (!b) {
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
    const item = m.product, entries = toEntries(buildRows(item, Math.ceil(actions * b.c.per), true)), last = entries[entries.length - 1];
    if (last?.itemId !== item.id) return fail("couldn't work out the steps");
    if (entries.some((x) => x.kind === "manual")) return fail(`${nm(item)} needs something the queue can't get on its own`);
    Object.assign(last, { untilLevel: b.to, untilSkill: skill.id, sellAll: !!e.sellMade });
    if (e.targetXp !== undefined && e.targetXp <= xpAt(b.to)) last.untilXp = e.targetXp;
    for (const x of entries) x.parent = e.id;
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

  // ----- the Train a skill window -----
  const TS = { skillId: null, goal: "level", make: null, qty: 100, level: null, forced: "", sell: false };
  // skills with something to do (Harvesting stays hidden until the Abyssal realm is unlocked)
  const trainSkills = () => list(game.skills).filter((s) => isTrainable(s) && methodsOf(s).length);
  // items a skill can be asked to make: its methods that are the usual way to make their product
  const makeables = (skill) => methodsOf(skill).filter((m) => m.product && stepFor(m) && !stepFor(m).own).sort((x, y) => x.level - y.level);
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
    return `<div class="mst-form">` +
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
    const head = step(`<div class="mst-title">${icon(item)}<b>Make ${num(qty)} ${esc(nm(item))}</b></div>` +
      chips(chip(`About ${fmtDur(rowsMs(rows))}`, "ok", "Base speed, counting what your bank already holds"), chip(`${num(xp)} ${esc(nm(sk))} XP`, "", "Base XP, before bonuses")));
    return { html: dupHtml(entries) + head + itemSection(rows), entries };
  };
  // Agility: the obstacles the builder would add, with a button that queues them
  const courseHtml = (picks) => !picks.length ? "" : step(`<div class="mst-stepno">Your course</div><div class="mst-title"><b>${plural(picks.length, "empty slot")} can be filled</b></div>` +
    picks.map((x) => chips(chip(`${icon(x.o)}Slot ${x.slot + 1}: ${esc(nm(x.o))}`), chip(`${num(Math.round(x.xpSec * 3600))} XP/hour`), chip(esc(costText(x))))).join("") +
    chips('<button type="button" class="btn btn-sm btn-success" data-mst-build><i class="fa fa-hammer mr-1"></i>Build my course</button>') +
    note("Each obstacle asks you to confirm before anything is spent. An Agility goal builds them first too."));
  const queueBuild = () => {
    const picks = agilityPicks();
    if (!picks.length) return tellPlayer("Your course has no empty slots the builder can fill right now.");
    if (addUnique(buildSteps(picks), false)) tellPlayer(`Added ${plural(picks.length, "obstacle")} to build. You'll confirm each one before anything is spent.`);
    Panel.open();
  };
  const trainLevel = (sk) => {
    const cap = levelCap(sk), L = Math.floor(TS.level || 0);
    if (!(L > sk.level) || L > cap) return nothing(sk.level >= cap ? `${nm(sk)} is already at its highest level.` : `Pick a target level between ${sk.level + 1} and ${cap}.`);
    const plan = trainPlan(sk, L, TS.forced || null), picks = sk.id === AGILITY && !TS.forced ? agilityPicks() : [];
    const goal = [{ kind: "train", skillId: sk.id, targetLevel: L, targetXp: xpAt(L), qty: xpAt(L), forced: TS.forced || undefined, sellMade: TS.sell, label: `${nm(sk)}: reach level ${L}` }];
    // an empty course can still take a goal: it builds first, then runs
    if (!plan.batches.length && picks.length) return { html: dupHtml(goal) + courseHtml(picks) + note("Your course is empty, so this goal builds it first and then runs it."), entries: goal };
    if (!plan.batches.length) {
      const why = blockedWhy(sk), msg = why ? `Nothing here can be trained right now: ${why}.` : "Nothing here can be trained by the queue on its own at your level (it may need shop items or monster drops).";
      return nothing(msg, step(chips(chip(`${warnIcon}${esc(msg)}`, "warn"))));
    }
    const entries = goal, dt = !TS.forced && bestDetour(sk, L);
    const time = dt ? chip(`About ${fmtDur(dt.T1)}`, "ok", `Includes training ${esc(nm(dt.skill))} first`)
      : plan.blocked == null ? chip(`About ${fmtDur(plan.totalMs)}`, "ok", "Base speeds, gathering the materials included") : chip(`Plan covers up to level ${plan.blocked}`, "warn");
    let html = dupHtml(entries) + step(`<div class="mst-title">${icon(sk)}<b>${esc(nm(sk))}: level ${sk.level} to ${L}</b></div>` + chips(chip(`${num(Math.max(0, Math.ceil(xpAt(L) - (sk.xp ?? 0))))} XP to go`), time));
    if (dt) html += step(`<div class="mst-stepno">First</div><div class="mst-title">${icon(dt.skill)}<b>${esc(nm(dt.skill))} to level ${dt.level}</b></div>` +
      chips(chip(`About ${fmtDur(dt.detourMs)}`), chip(`Saves about ${fmtDur(dt.saveMs)}`, "ok", "Compared with staying on the methods you can use now")) +
      note(`Better ${esc(nm(sk))} methods need materials from ${esc(nm(dt.skill))} level ${dt.level}, so the queue trains it first.`));
    html += plan.batches.map((b, i) => {
      const a = b.c.a, uses = b.c.st.craft ? b.c.opt.costs.map((k) => chip(`${icon(k.item)}${num(k.quantity)} ${esc(nm(k.item))}`)).join("") : "";
      return step(`<div class="mst-stepno">${i === 0 ? "Starting at" : "Then at"} level ${b.from}${b.to > b.from ? ` (to ${b.to})` : ""}</div><div class="mst-title">${icon(a)}<b>${esc(a.name)}</b></div>` +
        chips(chip(`${num(Math.round(b.c.rate))} XP/hour`, "", "Counting the time to gather or make what it needs"), chip(`About ${fmtDur(b.ms)}`)) + (uses ? chips(chip("<b>Each uses</b>", "lbl"), uses) : ""));
    }).join("");
    const okIds = !TS.forced && new Set(trainCands(sk).map((c) => c.a.id));
    const skipped = okIds && methodsOf(sk).some((m) => m.level <= sk.level && m.xp > 0 && m.safe?.().ok !== false && !okIds.has(m.id) && xpRate(m) > plan.batches[0].c.rate);
    html += courseHtml(picks);
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
    const added = addUnique(b.entries, top);
    Panel.open();
    if (added && Settings.get("autoStart") && Runner.state !== "running") Runner.start();
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
      html: `<div class="text-center font-size-sm mst-th-pop"><div id="mst-tr-form">${trainForm()}</div><div id="mst-tr-prev">${trainBuild().html}</div></div>`,
      confirmButtonText: "Close", showDenyButton: true, denyButtonText: '<i class="fa fa-play mr-1"></i>Add to queue',
      showCancelButton: true, cancelButtonText: '<i class="fa fa-arrow-up mr-1"></i>Add to top',
      customClass: { popup: "mst-swal", confirmButton: "btn btn-primary m-1", denyButton: "btn btn-success m-1", cancelButton: "btn btn-warning m-1" },
      didOpen: (popup) => {
        for (const t of ["input", "change"]) popup.addEventListener(t, (ev) => onTrainEvent(popup, ev));
        popup.addEventListener("click", (ev) => { if (ev.target.closest?.("[data-mst-build]")) { queueBuild(); const prev = popup.querySelector("#mst-tr-prev"); if (prev) prev.innerHTML = trainBuild().html; } });
      },
      width: 620,
    })?.then?.((r) => { try { if (r?.isDenied) trainQueue(false); else if (r?.dismiss === "cancel") trainQueue(true); } catch (e) { console.warn(TAG, e); } });
  };

  // ---------- duplicates and messages ----------
  const entryKey = (e) => `${e.kind}|${e.itemId ?? e.skillId ?? ""}|${e.actionId ?? e.forced ?? ""}|${e.targetXp ?? ""}`;
  const queuedKeys = () => new Set(Queue.items.filter((x) => x.status !== "done").map(entryKey));
  const dupHtml = (entries) => {
    const keys = queuedKeys(), dups = entries.filter((e) => keys.has(entryKey(e))), all = dups.length === entries.length;
    if (!dups.length) return "";
    return step(chips(chip(`${warnIcon}${all ? "This task is already in your queue" : `${dups.length} of ${entries.length} steps are already in your queue`}`, "warn")) +
      chips(...dups.map((e) => chip(esc(e.label)))) + note(all ? "Adding it again does nothing." : "Those steps will be skipped, the rest are added."));
  };
  // shown with the icon of the skill picked in the Train window, or the one the queue is on
  const tellPlayer = (msg) => {
    const e = Queue.items.find((x) => x.status !== "done" && x.skillId);
    try { notifyPlayer(skillById(TS.skillId) ?? (e && skillById(e.skillId)) ?? list(game.skills)[0], msg, "info"); } catch (err) { console.log(TAG, msg); }
  };
  const addUnique = (entries, top) => {
    const seen = queuedKeys(), fresh = [], skipped = [];
    for (const e of entries) { const k = entryKey(e); if (seen.has(k)) skipped.push(e.label); else { seen.add(k); fresh.push(e); } }
    if (fresh.length) Queue.add(fresh, top);
    if (skipped.length) tellPlayer(fresh.length ? `${skipped.length} step${skipped.length === 1 ? " was" : "s were"} already in the queue and skipped: ${skipped.join(", ")}` : "That task is already in your queue.");
    return fresh.length;
  };

  // ---------- floating panel ----------
  const POS_KEY = "mst-th-panel-pos";
  const levelIssue = (e) => {
    const sk = skillById(e.skillId), m = ["craft", "gather", "skill"].includes(e.kind) && methodById(sk, e.actionId);
    return m && m.level > sk.level ? `Needs ${nm(sk)} level ${m.level} (you have ${sk.level})` : null;
  };
  const toggleSetting = (name) => { Settings.set(name, !Settings.get(name)); Panel.last = ""; Panel.render(); };
  const ACTS = {
    close: () => Panel.close(), up: (id) => Queue.move(id, -1), down: (id) => Queue.move(id, 1), top: (id) => Queue.toTop(id), remove: (id) => Queue.remove(id),
    clear: () => Queue.clear(), cleardone: () => Queue.clearDone(), start: () => Runner.start(), pause: () => Runner.pause("Paused"), stop: () => Runner.stop(),
    first: (id) => Runner.doFirst(id), autostart: () => toggleSetting("autoStart"), autosell: () => toggleSetting("autoSell"),
  };
  const small = (cls, html) => `<br><small class="${cls}">${html}</small>`;
  const Panel = {
    el: null, last: "",
    place(x, y) {
      x = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - (this.el.offsetWidth || 350))); y = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 48));
      Object.assign(this.el.style, { left: x + "px", top: y + "px", right: "auto", bottom: "auto", maxHeight: `min(70vh, ${Math.max(160, window.innerHeight - y - 8)}px)` });
    },
    ensure() {
      if (this.el) return this.el;
      document.getElementById("mst-queue-panel")?.remove();
      const el = (this.el = document.createElement("div"));
      el.id = "mst-queue-panel";
      let drag = null;
      el.addEventListener("pointerdown", (ev) => {
        if (!ev.target.closest("[data-drag]") || ev.target.closest("[data-act]")) return;
        const r = el.getBoundingClientRect();
        drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* not supported */ } ev.preventDefault();
      });
      el.addEventListener("pointermove", (ev) => { if (drag) this.place(ev.clientX - drag.dx, ev.clientY - drag.dy); });
      const endDrag = () => { if (!drag) return; drag = null; const r = el.getBoundingClientRect(); store(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); };
      for (const t of ["pointerup", "pointercancel"]) el.addEventListener(t, endDrag);
      el.addEventListener("click", (ev) => { const a = ev.target.closest("[data-act]"); if (a && !a.disabled) { ev.preventDefault(); ACTS[a.dataset.act]?.(a.dataset.id); } });
      window.addEventListener("resize", () => { if (el.style.left) { const r = el.getBoundingClientRect(); this.place(r.left, r.top); } });
      document.body.appendChild(el);
      try { const p = JSON.parse(stored(POS_KEY) ?? "null"); if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) this.place(p.x, p.y); } catch (e) { /* default position */ }
      return el;
    },
    row(e) {
      const isTrain = e.kind === "train", manual = e.kind === "manual", done = e.status === "done";
      const issue = !done && !manual ? levelIssue(e) : null;
      const lead = done ? '<i class="fa fa-check text-success mr-2"></i>' : e.status === "active" ? '<i class="fa fa-play text-success mr-2"></i>'
        : e.status === "blocked" || e.status === "waiting" || issue ? '<i class="fa fa-exclamation-triangle text-warning mr-2"></i>'
        : '<i class="fa fa-circle mr-2" style="opacity:.25;font-size:8px;vertical-align:middle"></i>';
      const showProgress = !manual && !done && e.startQty !== undefined && (e.status === "active" || e.status === "blocked" || Runner.gained(e) > 0);
      const xpUnit = e.kind === "skill" ? " XP" : "";
      const amount = e.kind === "build" ? "" : isTrain ? `Level ${skillById(e.skillId)?.level ?? 0} / ${e.targetLevel}` : showProgress ? `${num(Runner.gained(e))} / ${num(e.qty)}${xpUnit}` : e.kind === "skill" ? `${num(e.qty)} XP` : `x${num(e.qty)}`;
      const btn = (act, ic, title, cls = "text-white-50") => `<a data-act="${act}" data-id="${esc(e.id)}" class="pointer-enabled ${cls} ml-2" title="${title}"><i class="fa ${ic}"></i></a>`;
      const sub = done && e.sold ? small("text-muted", esc(e.sold)) : e.reason ? small("text-warning", esc(e.reason))
        : issue ? small("text-warning", `<i class="fa fa-exclamation-triangle"></i> ${esc(issue)}`)
        : isTrain && e.now && !done ? small("text-muted", `now: ${esc(e.now)}`)
        : manual && !done ? small("text-muted", `do this yourself${e.status === "waiting" ? " (waiting for you)" : ""}`)
        : e.kind === "build" && !done ? small("text-muted", e.status === "waiting" ? "waiting for you to confirm" : "asks you before building") : "";
      return `<div style="display:flex;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.07);${done ? "opacity:.5" : ""}" ${manual ? `title="${esc(e.note ?? "")}"` : ""}>` +
        `<div style="flex:1;min-width:0">${lead}${icon(isTrain ? skillById(e.skillId) : e.kind === "build" ? list(game.agility?.actions).find((x) => x.id === e.actionId) : e.kind === "skill" ? methodById(skillById(e.skillId), e.actionId) ?? skillById(e.skillId) : itemById(e.itemId))}<span class="${manual ? "text-muted font-italic" : ""}" style="${done ? "text-decoration:line-through" : ""}">${esc(e.label)}</span> <b>${amount}</b>` +
        `${Runner.focusId === e.id ? ' <span class="badge badge-success">first</span>' : ""}${sub}</div>` +
        (done ? btn("remove", "fa-times", "Remove") : btn("first", "fa-play-circle", "Do this first (keeps its place in the list)", "text-success") +
          btn("top", "fa-angle-double-up", "Move to top") + btn("up", "fa-arrow-up", "Move up") + btn("down", "fa-arrow-down", "Move down") + btn("remove", "fa-times", "Remove")) + `</div>`;
    },
    render() {
      if (!this.el) return;
      const q = Queue.items, pending = q.filter((e) => e.status !== "done").length, running = Runner.state === "running", eta = Runner.eta(), total = Runner.elapsed + eta.ms;
      const pct = pending === 0 ? (q.length ? 100 : 0) : total > 0 ? Math.min(99, Math.round((Runner.elapsed / total) * 100)) : 0;
      const status = running ? `Running: ${Runner.current()?.label ?? ""}` : Runner.message || (Runner.state === "paused" ? "Paused" : pending ? "Ready" : "Idle");
      const etaText = pending === 0 ? (q.length ? "All done" : "Queue is empty") : `${fmtDur(eta.ms)} left &middot; done around ${fmtClock(eta.ms)}` +
        (eta.manual ? ` <span class="text-muted">(+ ${eta.manual} manual step${eta.manual === 1 ? "" : "s"})</span>` : "") + (eta.unknown ? ` <span class="text-muted">(some steps can't be estimated)</span>` : "");
      const b = (act, label, ic, cls, disabled) => `<button class="btn btn-sm ${cls}" data-act="${act}" ${disabled ? "disabled" : ""} style="padding:2px 10px"><i class="fa ${ic} mr-1"></i>${label}</button>`;
      const as = Settings.get("autoStart"), sl = Settings.get("autoSell");
      const html =
        `<div data-drag class="mst-ph" title="Drag to move"><i class="fa fa-grip-vertical mr-2" style="opacity:.4"></i>` +
        `<a data-act="autostart" class="pointer-enabled mr-2" title="Auto-start: ${as ? "On" : "Off"}" style="font-size:19px;line-height:1;${as ? "color:#30c78d" : "opacity:.45"}"><i class="fa ${as ? "fa-toggle-on" : "fa-toggle-off"}"></i></a>` +
        `<a data-act="autosell" class="pointer-enabled mr-2" title="Auto-sell extras: ${sl ? "On" : "Off"}" style="font-size:15px;line-height:1;${sl ? "color:#e5ae67" : "opacity:.45"}"><i class="fa fa-dollar-sign"></i></a>` +
        `<b style="flex:1">Action Queue</b><span class="text-muted mr-2">${plural(pending, "action")} left</span><a data-act="close" class="pointer-enabled text-white" title="Close"><i class="fa fa-times"></i></a></div>` +
        `<div data-list style="overflow:auto;padding:4px 10px;flex:1">` +
        (q.length ? q.map((e) => this.row(e)).join("") : `<div class="text-muted py-3 text-center">Nothing queued yet.<br>Press the chart button in the bottom-right menu to train a skill.</div>`) +
        `</div><div class="mst-pf"><div class="mst-bar"><div style="width:${pct}%"></div><span>${pct}%</span></div>` +
        `<div style="margin-top:6px"><small class="${Runner.state === "paused" ? "text-warning" : running ? "text-success" : "text-muted"}">${esc(status)}</small></div>` +
        `<div style="margin-bottom:8px"><small>${etaText}</small></div>` +
        `<div class="mst-btns">${b("start", Runner.state === "paused" ? "Resume" : "Start", "fa-play", "btn-success", running || pending === 0)}${b("pause", "Pause", "fa-pause", "btn-warning", !running)}${b("stop", "Stop", "fa-stop", "btn-danger", Runner.state === "idle")}</div>` +
        `<div class="mst-btns" style="margin-top:6px">${b("cleardone", "Clear Queue", "fa-check", "btn-secondary", !q.some((e) => e.status === "done"))}${b("clear", "Clear All", "fa-trash", "btn-outline-danger", q.length === 0)}</div></div>`;
      if (html === this.last) return;
      const top = this.el.querySelector("[data-list]")?.scrollTop ?? 0;
      this.el.innerHTML = this.last = html;
      const box = this.el.querySelector("[data-list]"); if (box) box.scrollTop = top;
    },
    open() { this.ensure().style.display = "flex"; this.last = ""; this.render(); },
    close() { if (this.el) this.el.style.display = "none"; },
    toggle() { this.ensure(); this.el.style.display === "flex" ? this.close() : this.open(); },
  };

  // ---------- minibar buttons (bottom-right menu), sized like their neighbours ----------
  const mountButton = () => {
    const bar = document.getElementById("skill-footer-minibar");
    if (!bar) return;
    const mk = (id, title, html, onClick, before) => {
      let b = document.getElementById(id);
      if (b) return b;
      bar.insertBefore((b = Object.assign(document.createElement("button"), { id, title, className: "btn btn-sm btn-light", innerHTML: html })), before ?? null);
      b.addEventListener("click", () => { try { onClick(); } catch (e) { console.warn(TAG, e); } b.blur(); });
      return b;
    };
    const iconHtml = (fa, size) => `<i class="fa ${fa} text-dark mst-ico" style="font-size:${size}px"></i>`;
    const q = mk("mst-queue-btn", "Action Queue", iconHtml("fa-list-ol", 17) + '<span class="mst-count"></span>', () => Panel.toggle());
    const t = mk("mst-train-btn", "Train a skill: queue an item or a level goal", iconHtml("fa-chart-line", 16), openTrain, q);
    updateBadge();
    const ref = [...bar.children].find((c) => c !== q && c !== t && c.offsetWidth > 0);
    if (ref) for (const x of [q, t]) Object.assign(x.style, { width: ref.offsetWidth + "px", height: ref.offsetHeight + "px" });
  };

  // ---------- install ----------
  const CSS = `
    .mst-th-pop{text-align:center} .mst-note{margin-top:8px;font-size:12px;opacity:.7}
    .mst-step{background:rgba(127,127,127,.12);border:1px solid rgba(127,127,127,.3);border-radius:8px;padding:8px 10px;margin:0 0 8px}
    .mst-stepno{font-size:12px;font-weight:600;opacity:.7;margin-bottom:2px} .mst-title{font-size:15px;margin:2px 0 6px}
    .mst-chips{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:5px;margin-top:4px}
    .mst-chip{display:inline-flex;align-items:center;gap:3px;padding:1px 9px;border-radius:11px;background:rgba(127,127,127,.22);font-size:12px;line-height:20px}
    .mst-chip img,.mst-title img.skill-icon-xs{width:18px;height:18px;margin:0 3px 0 0;vertical-align:middle}
    .mst-chip.ok{background:rgba(48,199,141,.25);color:#2fb67a} .mst-chip.warn{background:rgba(229,174,103,.25);color:#c98a2b}
    .mst-chip.lbl{background:transparent;padding-left:0;opacity:.85} .mst-chip>span{display:inline;line-height:20px} .mst-chip small{opacity:.8;font-size:.8em}
    .mst-form{display:grid;grid-template-columns:120px 1fr;gap:6px 10px;align-items:center;text-align:left;margin:0 0 10px}
    .mst-form label{margin:0;font-size:13px;opacity:.85} .mst-form select,.mst-form input[type=number]{width:100%}
    .mst-swal .swal2-actions{display:flex;justify-content:center;align-items:center;gap:5px;flex-wrap:nowrap;margin:1em auto 0}
    .mst-swal .swal2-actions :is(.swal2-deny,.swal2-cancel,.swal2-confirm){height:36px!important;padding:0 16px!important;font-size:14px!important;line-height:1!important;box-sizing:border-box!important;
      display:inline-flex!important;align-items:center!important;justify-content:center!important;box-shadow:none!important;outline:none!important;margin:0!important}
    .mst-swal .swal2-deny{order:1} .mst-swal .swal2-cancel{order:2} .mst-swal .swal2-confirm{order:3;min-width:84px!important}
    #mst-queue-panel{position:fixed;right:68px;bottom:16px;width:350px;max-height:70vh;display:none;flex-direction:column;z-index:1050;background:rgba(28,32,41,.98);color:#fff;
      border:1px solid rgba(255,255,255,.15);border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.5);font-size:13px}
    .mst-ph{display:flex;align-items:center;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.12);cursor:move;user-select:none;touch-action:none}
    .mst-pf{padding:10px;border-top:1px solid rgba(255,255,255,.12);text-align:center} .mst-btns{display:flex;justify-content:center;gap:6px}
    .mst-bar{position:relative;height:16px;border-radius:8px;background:rgba(255,255,255,.12);overflow:hidden} .mst-bar>div{height:100%;background:#30c78d;transition:width .8s}
    .mst-bar>span{position:absolute;left:0;right:0;top:0;line-height:16px;font-size:11px;font-weight:600;text-shadow:0 0 3px rgba(0,0,0,.7)}
    #mst-queue-btn{position:relative} .mst-ico{display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;vertical-align:middle}
    .mst-count{display:none;position:absolute;top:-6px;right:-6px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#17a2b8;color:#fff;font-size:10px;font-weight:600;line-height:17px;text-align:center}`;
  const install = () => {
    document.getElementById("mst-th-style")?.remove();
    document.head.appendChild(Object.assign(document.createElement("style"), { id: "mst-th-style", textContent: CSS }));
    Queue.load(); mountButton();
    clearInterval(window.__mstTimer);
    window.__mstTimer = setInterval(mountButton, 2000); // the game can rebuild the menu; put our buttons back if they vanish
    clearInterval(window.__mstRunTimer);
    window.__mstRunTimer = setInterval(() => { try { Runner.step(); } catch (e) { console.warn(TAG, "runner", e); } }, 1000);
    window.skillTrainer = { version: VERSION, queue: Queue, panel: Panel, runner: Runner, settings: Settings };
    console.log(TAG, "installed", VERSION);
  };
  const ready = () => typeof game !== "undefined" && list(game?.skills).length > 0 && typeof SwalLocale !== "undefined" && document.getElementById("skill-footer-minibar");
  if (ready()) install();
  else { const timer = setInterval(() => { if (ready()) { clearInterval(timer); install(); } }, 500); }
}
