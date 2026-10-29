// Skill Trainer: train a skill or make an item, with the queue planning and running the work
export function setup(ctx) {
  const VERSION = "1.0.0", TAG = "[Skill Trainer]";

  // ---------- small helpers ----------
  const list = (r) => r?.allObjects ?? (r?.registeredObjects ? [...r.registeredObjects.values()] : []);
  const nm = (o) => String(o?.name ?? o?._name ?? o?._localID ?? o?.id ?? "?");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (n) => Number(n).toLocaleString();
  const plural = (n, w) => `${num(n)} ${w}${n === 1 ? "" : "s"}`;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const icon = (o) => (typeof o?.media === "string" ? `<img class="skill-icon-xs mr-1" src="${esc(o.media)}">` : "");
  const have = (item) => { try { const q = game.bank.getQty(item); return Number.isFinite(q) ? q : null; } catch (e) { return null; } };
  const owned = (item) => have(item) ?? 0;
  const store = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { return false; } return true; };
  const stored = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const itemById = (id) => { try { return game.items.getObjectByID(id); } catch (e) { return null; } };
  const skillById = (id) => list(game.skills).find((s) => s.id === id);
  const actionById = (skill, id) => list(skill?.actions).find((a) => a.id === id);
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

  // ---------- recipe index (built on first use) ----------
  // The skills the queue can run on its own. Anything else a recipe needs (herbs, feathers, monster drops)
  // becomes a step the player does themselves.
  const TRAINABLE = new Set(["Woodcutting", "Mining", "Fishing", "Cooking", "Smithing", "Fletching", "Crafting", "Runecrafting", "Herblore"].map((s) => "melvorD:" + s));
  const isTrainable = (s) => !!s && TRAINABLE.has(s.id);
  const inMelvor = (a) => !a.realm || a.realm.id === "melvorD:Melvor";
  const MANUAL_NOTE = "Skill Trainer can't get this on its own, so it's a step you do yourself";
  let idx = null;
  const index = () => {
    if (idx) return idx;
    idx = { crafters: new Map(), gatherers: new Map() };
    for (const skill of list(game.skills).filter(isTrainable)) for (const a of list(skill.actions)) {
      if (!a.product) continue;
      const m = Array.isArray(a.itemCosts) && (a.itemCosts.length || a.alternativeCosts?.length) ? idx.crafters : idx.gatherers;
      m.set(a.product.id, [...(m.get(a.product.id) ?? []), { skill, a }]);
    }
    return idx;
  };
  const crafter = (id) => index().crafters.get(id)?.[0];
  const gatherer = (id) => index().gatherers.get(id)?.[0];

  // Cooking burns some food: costs are used every attempt, but the product and the XP only come from the ones that work.
  const succ = (skill, a) => { try { const c = skill?.id === "melvorD:Cooking" ? Number(skill.getRecipeSuccessChance(a)) : 100; if (c > 0 && c < 100) return Math.max(0.05, c / 100); } catch (e) { /* never fails */ } return 1; };
  const options = (a) => (a.alternativeCosts?.length ? a.alternativeCosts.map((o) => ({ costs: o.itemCosts ?? [], mult: o.quantityMultiplier ?? 1 })) : [{ costs: [], mult: 1 }]);
  const costsOf = (a, opt = options(a)[0]) => [...(Array.isArray(a.itemCosts) ? a.itemCosts : []), ...opt.costs].filter((k) => k?.item);
  const perAttempt = (skill, a, opt = options(a)[0]) => Math.max(1, (a.baseQuantity ?? 1) * opt.mult) * succ(skill, a);
  const intervalMs = (skill, a) => a.baseInterval ?? (a.baseMinInterval !== undefined && a.baseMaxInterval !== undefined ? (a.baseMinInterval + a.baseMaxInterval) / 2 : skill.baseInterval) ?? 3000;
  const xpRate = (skill, a) => { const ms = intervalMs(skill, a); return ms > 0 ? (((a.baseExperience ?? 0) * succ(skill, a)) / ms) * 3600000 : 0; };

  // ---------- breaking an item down into steps ----------
  // Crafts break down into their materials. Parents come before children, so what the bank already holds is used first.
  const buildRows = (item, qty, fresh = false) => {
    const nodes = new Map();
    const explode = (it, depth, path) => {
      const n = nodes.get(it.id) ?? { item: it, depth }, c = crafter(it.id);
      nodes.set(it.id, Object.assign(n, { depth: Math.max(n.depth, depth) }));
      if (!c || path.has(it.id) || depth > 12) return;
      n.recipe = { c, opt: options(c.a)[0] };
      path.add(it.id); for (const k of costsOf(c.a, n.recipe.opt)) explode(k.item, depth + 1, path); path.delete(it.id);
    };
    explode(item, 0, new Set());
    const demand = new Map([[item.id, qty]]), rows = [];
    for (const n of [...nodes.values()].sort((a, b) => a.depth - b.depth)) {
      const need = demand.get(n.item.id) ?? 0;
      if (need <= 0) continue;
      n.fresh = fresh && n.item.id === item.id;
      Object.assign(n, { need, qty: Math.max(0, need - (n.fresh ? 0 : owned(n.item))) });
      if (n.recipe) {
        const { c, opt } = n.recipe;
        n.recipe.crafts = Math.ceil(n.qty / perAttempt(c.skill, c.a, opt));
        if (n.qty > 0) for (const k of costsOf(c.a, opt)) demand.set(k.item.id, (demand.get(k.item.id) ?? 0) + k.quantity * n.recipe.crafts);
      }
      if (n.qty > 0) rows.push(n);
    }
    return rows.sort((a, b) => b.depth - a.depth || nm(a.item).localeCompare(nm(b.item)));
  };
  const lvlChip = (skill, a) => (skill && lvl(a) > skill.level ? chip(`${warnIcon}Needs ${esc(nm(skill))} level ${a.level} (you have ${skill.level})`, "warn") : "");
  // the easiest way to gather an item the player can't gather yet (null if they can, or if no skill gathers it)
  const gatherBlock = (id) => {
    const opts = index().gatherers.get(id) ?? [];
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
        const alts = (index().crafters.get(n.item.id)?.length ?? 1) - 1 + options(c.a).length - 1;
        const uses = costsOf(c.a, opt).map((x) => chip(`${icon(x.item)}${num(x.quantity * crafts)} ${esc(nm(x.item))}`));
        title = `${icon(c.skill)}<b>${esc(nm(c.skill))}</b>: make ${icon(n.item)}<b>${esc(nm(n.item))}</b> &times;${num(n.qty)}`;
        body = chips(chip(`Level ${lvl(c.a)}`), chip(plural(crafts, "craft")), haveChip, alts > 0 ? chip(plural(alts, "other option")) : "") +
          (uses.length ? chips(chip("<b>Uses</b>", "lbl"), ...uses) : "") + (lvlChip(c.skill, c.a) ? chips(lvlChip(c.skill, c.a)) : "");
      } else {
        const g = index().gatherers.get(n.item.id), lb = gatherBlock(n.item.id);
        title = `${icon(n.item)}<b>${esc(nm(n.item))}</b> &times;${num(n.qty)}`;
        body = chips(haveChip) + (g
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
  // the steps that get the missing materials for `crafts` more crafts of a; null if the queue can't get one of them
  const materialSteps = (a, opt, crafts, parent) => {
    const entries = costsOf(a, opt).flatMap((k) => {
      const need = k.quantity * crafts - owned(k.item);
      return need > 0 ? toEntries(buildRows(k.item, need, true)) : [];
    });
    if (entries.some((x) => x.kind === "manual")) return null;
    for (const x of entries) x.parent = parent;
    return entries;
  };

  // ---------- queue (saved locally, one list per character name) ----------
  // gather and craft run a game action, manual waits for the player, train plans the next batch of steps
  const KINDS = new Set(["gather", "craft", "manual", "train"]);
  const Queue = {
    items: [],
    key: () => `mst-th-queue:${game.characterName ?? "default"}`,
    load() {
      try { this.items = JSON.parse(stored(this.key()) ?? "[]").filter((e) => KINDS.has(e.kind)); } catch (e) { this.items = []; }
      // the runner never survives a reload, so nothing is "in progress" any more (progress counts are kept)
      for (const e of this.items) { if (["active", "waiting", "blocked"].includes(e.status)) e.status = "pending"; for (const k of ["reason", "ack", "t0", "g0"]) delete e[k]; }
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
  };
  const startCraft = (s, a, e) => {
    if (typeof s.selectRecipeOnClick !== "function" || typeof s.createButtonOnClick !== "function") return fail(`automating ${nm(s)} isn't supported yet`);
    s.selectRecipeOnClick(a);
    if (a.alternativeCosts?.length && typeof s.selectAltRecipeOnClick === "function") s.selectAltRecipeOnClick(e.altIndex ?? 0);
    if (!s.isActive) s.createButtonOnClick();
  };
  const startAction = (e) => {
    const skill = skillById(e.skillId), a = actionById(skill, e.actionId);
    if (!a) return fail("this action wasn't found in your game version");
    if (a.level > skill.level) return fail(`needs ${nm(skill)} level ${a.level}`);
    try {
      if (game.activeAction && game.activeAction !== skill) game.stopActiveAction();
      if (skill.isActive && skill.stop() === false) return fail("couldn't stop the current activity");
      const r = (STARTERS[skill.id] ?? startCraft)(skill, a, e);
      if (r) return r;
    } catch (err) { return fail("error: " + err.message); }
    if (skill.isActive) return { ok: true };
    const craft = e.kind === "craft";
    return fail(craft ? "not enough materials (or level too low)" : "the game wouldn't start it", { noMaterials: craft && lvl(a) <= skill.level });
  };

  // ---------- time estimates (base speeds; the active entry switches to its measured speed after a few seconds) ----------
  const estimateMs = (e) => {
    if (e.kind === "manual" || e.status === "done") return 0;
    if (e.kind === "train") return trainEstimate(e);
    const units = Math.max(0, e.qty - Runner.gained(e));
    if (units <= 0) return 0;
    const skill = skillById(e.skillId), a = actionById(skill, e.actionId);
    if (!a) return null;
    let per = e.kind === "gather" ? intervalMs(skill, a) / Math.max(1, a.baseQuantity ?? 1) : intervalMs(skill, a) / perAttempt(skill, a, { mult: options(a)[e.altIndex ?? 0]?.mult ?? 1 });
    if (Runner.state === "running" && Runner.activeId === e.id && e.t0 !== undefined) {
      const dt = Date.now() - e.t0, dg = Runner.gained(e) - e.g0;
      if (dt > 10000 && dg > 0) per = dt / dg;
    }
    return units * per;
  };
  const fmtDur = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? "under 1 min" : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const fmtClock = (ms) => {
    const d = new Date(Date.now() + ms), t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
  };

  // ---------- runner: takes entries from the top of the list, one at a time ----------
  const Runner = {
    state: "idle", // idle | running | paused
    message: "", activeId: null, activeSkillId: null,
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
    gained: (e) => (e.kind === "train" ? Math.floor(skillById(e.skillId)?.xp ?? 0) : e.startQty === undefined ? 0 : Math.max(0, owned(itemById(e.itemId)) - e.startQty)),
    halt(skillId = this.activeSkillId) { const s = skillId && skillById(skillId); try { if (s && game.activeAction === s) game.stopActiveAction(); } catch (e) { console.warn(TAG, e); } },
    release() { this.activeId = null; this.activeSkillId = null; },
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
      if (this.state === "idle") this.elapsed = 0;
      Object.assign(this, { state: "running", message: "" }).step();
      Panel.render();
    },
    pause(msg = "Paused") { if (this.state === "running") { this.halt(); this.setState("paused", msg); } },
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
    finish(entry) { this.sellExtra(entry); entry.status = "done"; delete entry.reason; this.halt(entry.skillId); this.release(); Queue.save(); },
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

        // a different entry is now on top (we just started, or something was added above): switch to it
        if (this.activeId !== cur.id) {
          this.leave();
          Object.assign(this, { activeId: cur.id, activeSkillId: cur.skillId ?? null });
          cur.status = "active"; delete cur.reason;
          if (cur.kind !== "manual" && cur.startQty === undefined) cur.startQty = owned(itemById(cur.itemId));
          Queue.save();
          if (cur.kind !== "manual") {
            const r = startAction(cur);
            // a craft with no materials is handled below: it adds the steps to get them
            if (!r.ok && !(cur.kind === "craft" && r.noMaterials)) return r.transient ? this.wait(r.reason) : this.block(cur, r.reason);
          }
          Object.assign(cur, { t0: Date.now(), g0: this.gained(cur) });
        }

        const got = owned(itemById(cur.itemId));
        if (cur.kind === "manual") {
          if (got >= cur.qty || cur.ack) { this.finish(cur); continue; }
          cur.status = "waiting";
          this.release(); Queue.save();
          return this.setState("paused", `Your turn: ${cur.label} x${num(cur.qty)} (you have ${num(got)}). Do it, then press Start.`);
        }
        const us = cur.untilLevel && skillById(cur.untilSkill ?? cur.skillId);
        if (us && (us.level >= cur.untilLevel || (cur.untilXp && (us.xp ?? 0) >= cur.untilXp))) { this.finish(cur); continue; }
        if (got - (cur.startQty ?? 0) >= cur.qty) { this.finish(cur); continue; }

        const skill = skillById(cur.skillId);
        if (skill && skill.isActive && game.activeAction === skill) return Panel.render();
        if (game.activeAction && game.activeAction !== skill) return this.pause("Paused: something else started running.");

        // nothing is running and the target isn't reached: the game stopped it (materials, etc.) so try again once
        const r = startAction(cur);
        if (r.ok) return Panel.render();
        if (r.transient) return this.wait(r.reason);
        const made = this.gained(cur), of = `(${num(made)} of ${num(cur.qty)} done)`;
        if (!(r.noMaterials && cur.kind === "craft")) return this.block(cur, `${r.reason} ${of}`);
        cur.restockStall = cur.restockMade !== undefined && made <= cur.restockMade ? (cur.restockStall ?? 0) + 1 : 0;
        cur.restockMade = made;
        const rs = restockCraft(cur);
        if (!rs.ok || cur.restockStall >= 2) return this.block(cur, `${rs.ok ? "it keeps running out of materials without making more" : rs.reason} ${of}`);
        cur.restocks = (cur.restocks ?? 0) + 1;
        Queue.insertBefore(cur.id, rs.entries);
        this.message = `Short of materials for ${nm(itemById(cur.itemId))}: getting ${num(rs.remaining)} more worth`;
      }
    },
  };
  // A craft step ran out of ingredients before it made enough (Cooking burns food, Smithing and others can come up short):
  // work out what is still missing and the steps that get it
  const restockCraft = (e) => {
    const skill = skillById(e.skillId), a = actionById(skill, e.actionId), item = itemById(e.itemId);
    if (!a || !item) return fail("this action wasn't found in your game version");
    const opt = options(a)[e.altIndex ?? 0] ?? { costs: [], mult: 1 };
    const remaining = e.qty - Math.max(0, owned(item) - (e.startQty ?? 0));
    const entries = materialSteps(a, opt, Math.max(1, Math.ceil(remaining / perAttempt(skill, a, opt))), e.parent ?? e.id);
    if (!entries) return fail(`${nm(item)} needs something the queue can't get on its own`);
    return entries.length ? { ok: true, entries, remaining } : fail("not enough materials (or level too low)");
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
  const acquire = (item, n, lv, skillId, seen = new Set(), depth = 0) => {
    if (!(n > 0)) return { ms: 0, xp: 0 };
    const NO = { ms: Infinity, xp: 0 }, c = crafter(item.id), g = !c && gatherer(item.id), x = c || g;
    if (depth > 10 || seen.has(item.id) || !x || lvl(x.a) > levelIn(x.skill, lv)) return NO;
    if (g) { const acts = n / Math.max(1, g.a.baseQuantity ?? 1); return { ms: acts * intervalMs(g.skill, g.a), xp: g.skill.id === skillId ? acts * (g.a.baseExperience ?? 0) : 0 }; }
    const opt = options(c.a)[0], sr = succ(c.skill, c.a), crafts = n / perAttempt(c.skill, c.a, opt); // attempts, not rounded: ranks methods by their steady rate
    const r = { ms: crafts * intervalMs(c.skill, c.a), xp: c.skill.id === skillId ? crafts * sr * (c.a.baseExperience ?? 0) : 0 };
    seen.add(item.id);
    for (const k of costsOf(c.a, opt)) { const s = acquire(k.item, k.quantity * crafts, lv, skillId, seen, depth + 1); r.ms += s.ms; r.xp += s.xp; }
    seen.delete(item.id);
    return r;
  };
  // the same step the queue would really run for this product (first crafter, or first gatherer)
  const stepFor = (a) => {
    if (!a.product) return null;
    const c = crafter(a.product.id), g = gatherer(a.product.id);
    return c ? (c.a === a ? { craft: true } : null) : g?.a === a ? { craft: false } : null;
  };
  // training methods open at this level, best first by XP per hour of everything they need
  const trainCands = (skill, lv) => {
    const out = [], L = levelIn(skill, lv);
    for (const a of list(skill.actions)) {
      const st = inMelvor(a) && lvl(a) <= L && a.baseExperience > 0 && a.product && stepFor(a);
      if (!st) continue;
      const opt = st.craft ? options(a)[0] : { costs: [], mult: 1 }, sr = succ(skill, a);
      let ms = intervalMs(skill, a), xpPer = a.baseExperience * sr, mast = 0;
      if (st.craft) for (const k of costsOf(a, opt)) { const r = acquire(k.item, k.quantity, lv, skill.id); ms += r.ms; xpPer += r.xp; }
      if (!isFinite(ms) || ms <= 0) continue;
      if (mastery() && a.hasMastery !== false) {
        try { if (skill.getMasteryLevel(a) < 99) mast = Number(skill.getMasteryXPToAddForAction(a, intervalMs(skill, a))) || 0; } catch (e) { /* no mastery */ }
      }
      out.push({ a, per: perAttempt(skill, a, opt), ms, xpPer, mast, rate: (xpPer / ms) * 3600000, score: ((xpPer + mast) / ms) * 3600000 });
    }
    return out.sort((x, y) => y.score - x.score);
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
    if (!isTrainable(skill) || target - fromLevel < 3) return null;
    const key = `${skill.id}|${fromLevel}|${target}|${GATHER_SKILLS.map((id) => skillById(id)?.level ?? 0)}|${mastery()}`;
    return memo(detourMemo, key, 100, () => {
      let best = null;
      try {
        const base = trainPlan(skill, target, "", fromLevel, fromXp), T0 = base.blocked != null ? Infinity : base.totalMs;
        const bestRate = (lv, L) => trainCands(skill, lv.set(skill.id, L))[0]?.score ?? 0;
        for (const S of GATHER_SKILLS.map(skillById)) {
          if (!S || S === skill || !isTrainable(S)) continue;
          const levels = [...new Set(list(S.actions).filter((a) => inMelvor(a) && lvl(a) > S.level && lvl(a) <= S.level + 30).map(lvl))].sort((x, y) => x - y);
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
    const dt = !e.forced && !e.noDetour && bestDetour(skill, e.targetLevel);
    if (dt && (skillById(dt.skill.id)?.level ?? 0) < dt.level) return {
      ok: true,
      entries: [{ kind: "train", skillId: dt.skill.id, targetLevel: dt.level, targetXp: xpAt(dt.level), qty: xpAt(dt.level), noDetour: true, parent: e.id, label: `${nm(dt.skill)}: reach level ${dt.level} (opens better ${nm(skill)} methods)` }],
      note: `${nm(dt.skill)} to level ${dt.level} first, saves about ${fmtDur(dt.saveMs)} on ${nm(skill)}`,
    };
    const b = trainPlan(skill, e.targetLevel, e.forced).batches[0];
    if (!b) {
      const fa = e.forced && actionById(skill, e.forced);
      return fail(fa ? `${nm(fa)} can't be trained by the queue at level ${skill.level}` : `nothing at ${nm(skill)} level ${skill.level} can be trained by the queue on its own (it may need shop items or monster drops)`);
    }
    const actions = Math.max(1, Math.ceil((Math.min(xpAt(b.to), e.targetXp ?? Infinity) - (skill.xp ?? 0)) / b.c.xpPer));
    const item = b.c.a.product, entries = toEntries(buildRows(item, Math.ceil(actions * b.c.per), true)), last = entries[entries.length - 1];
    if (last?.itemId !== item.id) return fail("couldn't work out the steps");
    if (entries.some((x) => x.kind === "manual")) return fail(`${nm(item)} needs something the queue can't get on its own`);
    Object.assign(last, { untilLevel: b.to, untilSkill: skill.id, sellAll: !!e.sellMade });
    if (e.targetXp !== undefined && e.targetXp <= xpAt(b.to)) last.untilXp = e.targetXp;
    for (const x of entries) x.parent = e.id;
    return { ok: true, entries, to: b.to, note: `${nm(b.c.a)} until level ${b.to} (about ${num(Math.round(b.c.rate))} XP/h)` };
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
    if (n.recipe) return s + n.recipe.crafts * intervalMs(n.recipe.c.skill, n.recipe.c.a);
    const g = gatherer(n.item.id);
    return s + (g ? (n.qty * intervalMs(g.skill, g.a)) / Math.max(1, g.a.baseQuantity ?? 1) : 0);
  }, 0);

  // ----- the Train a skill window -----
  const TS = { skillId: null, goal: "level", make: null, qty: 100, level: null, forced: "", sell: false };
  const trainSkills = () => list(game.skills).filter(isTrainable);
  const makeables = (skill) => list(skill.actions).filter((a) => inMelvor(a) && stepFor(a)).sort((x, y) => lvl(x) - lvl(y));
  const fixTrain = () => {
    let sk = skillById(TS.skillId);
    if (!isTrainable(sk)) { const open = skillById(game.openPage?.id); sk = isTrainable(open) ? open : trainSkills()[0]; TS.skillId = sk?.id ?? null; }
    if (!sk) return;
    const ms = makeables(sk), ok = ms.filter((a) => lvl(a) <= sk.level), cap = levelCap(sk);
    if (!ms.some((a) => a.id === TS.make)) TS.make = (ok[ok.length - 1] ?? ms[0])?.id ?? null;
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
      field("Goal", select("mst-tr-goal", opt("level", "Train to a level", TS.goal === "level") + opt("make", "Make an amount of an item", TS.goal === "make"))) +
      (TS.goal === "make"
        ? field("Item", select("mst-tr-item", makeables(sk).map((a) => opt(a.id, `${nm(a.product)} (level ${lvl(a)}${lvl(a) > sk.level ? ", locked" : ""})`, a.id === TS.make)).join(""))) +
          field("Amount", numberInput("mst-tr-qty", TS.qty, 'min="1"'))
        : field("Target level", numberInput("mst-tr-level", TS.level, `min="${sk.level + 1}" max="${levelCap(sk)}"`)) +
          field("Method", select("mst-tr-method", opt("", "Best available (recommended)", !TS.forced) + trainCands(sk).map((c) => opt(c.a.id, `${nm(c.a)} (about ${num(Math.round(c.rate))} XP/h)`, c.a.id === TS.forced)).join(""))) +
          check("mst-tr-sell", TS.sell, "Sell the items it makes") + check("mst-tr-mastery", mastery(), "Prefer mastery XP")) +
      `</div>`;
  };
  const nothing = (problem, html = note(esc(problem))) => ({ html, entries: [], problem });
  const trainMake = (sk) => {
    const act = actionById(sk, TS.make), qty = Math.max(1, Math.floor(TS.qty || 0)), item = act?.product;
    if (!item) return nothing("Pick an item first.", "");
    const miss = itemMissing(item, qty, true);
    if (miss.length) return nothing("You don't meet the requirements for that yet.", missingHtml(miss));
    const rows = buildRows(item, qty, true), entries = toEntries(rows);
    const xp = Math.ceil(qty / Math.max(1, (act.baseQuantity ?? 1) * (stepFor(act)?.craft ? options(act)[0].mult : 1))) * (act.baseExperience ?? 0);
    const head = step(`<div class="mst-title">${icon(item)}<b>Make ${num(qty)} ${esc(nm(item))}</b></div>` +
      chips(chip(`About ${fmtDur(rowsMs(rows))}`, "ok", "Base speed, counting what your bank already holds"), chip(`${num(xp)} ${esc(nm(sk))} XP`, "", "Base XP, before bonuses")));
    return { html: dupHtml(entries) + head + itemSection(rows), entries };
  };
  const trainLevel = (sk) => {
    const cap = levelCap(sk), L = Math.floor(TS.level || 0);
    if (!(L > sk.level) || L > cap) return nothing(sk.level >= cap ? `${nm(sk)} is already at its highest level.` : `Pick a target level between ${sk.level + 1} and ${cap}.`);
    const plan = trainPlan(sk, L, TS.forced || null);
    if (!plan.batches.length) {
      const msg = "Nothing here can be trained by the queue on its own at your level (it may need shop items or monster drops).";
      return nothing(msg, step(chips(chip(`${warnIcon}${esc(msg)}`, "warn"))));
    }
    const entries = [{ kind: "train", skillId: sk.id, targetLevel: L, targetXp: xpAt(L), qty: xpAt(L), forced: TS.forced || undefined, sellMade: TS.sell, label: `${nm(sk)}: reach level ${L}` }];
    const dt = !TS.forced && bestDetour(sk, L);
    const time = dt ? chip(`About ${fmtDur(dt.T1)}`, "ok", `Includes training ${esc(nm(dt.skill))} first`)
      : plan.blocked == null ? chip(`About ${fmtDur(plan.totalMs)}`, "ok", "Base speeds, gathering the materials included") : chip(`Plan covers up to level ${plan.blocked}`, "warn");
    let html = dupHtml(entries) + step(`<div class="mst-title">${icon(sk)}<b>${esc(nm(sk))}: level ${sk.level} to ${L}</b></div>` + chips(chip(`${num(Math.max(0, Math.ceil(xpAt(L) - (sk.xp ?? 0))))} XP to go`), time));
    if (dt) html += step(`<div class="mst-stepno">First</div><div class="mst-title">${icon(dt.skill)}<b>${esc(nm(dt.skill))} to level ${dt.level}</b></div>` +
      chips(chip(`About ${fmtDur(dt.detourMs)}`), chip(`Saves about ${fmtDur(dt.saveMs)}`, "ok", "Compared with staying on the methods you can use now")) +
      note(`Better ${esc(nm(sk))} methods need materials from ${esc(nm(dt.skill))} level ${dt.level}, so the queue trains it first.`));
    html += plan.batches.map((b, i) => {
      const a = b.c.a, uses = stepFor(a)?.craft ? costsOf(a).map((k) => chip(`${icon(k.item)}${num(k.quantity)} ${esc(nm(k.item))}`)).join("") : "";
      return step(`<div class="mst-stepno">${i === 0 ? "Starting at" : "Then at"} level ${b.from}${b.to > b.from ? ` (to ${b.to})` : ""}</div><div class="mst-title">${icon(a.product)}<b>${esc(nm(a))}</b></div>` +
        chips(chip(`${num(Math.round(b.c.rate))} XP/hour`, "", "Counting the time to gather or make what it needs"), chip(`About ${fmtDur(b.ms)}`)) + (uses ? chips(chip("<b>Each uses</b>", "lbl"), uses) : ""));
    }).join("");
    const okIds = !TS.forced && new Set(trainCands(sk).map((c) => c.a.id));
    const skipped = okIds && list(sk.actions).some((a) => lvl(a) <= sk.level && a.baseExperience > 0 && a.product && !okIds.has(a.id) && xpRate(sk, a) > plan.batches[0].c.rate);
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
      didOpen: (popup) => { for (const t of ["input", "change"]) popup.addEventListener(t, (ev) => onTrainEvent(popup, ev)); },
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
    const sk = skillById(e.skillId), a = (e.kind === "craft" || e.kind === "gather") && actionById(sk, e.actionId);
    return a && lvl(a) > sk.level ? `Needs ${nm(sk)} level ${a.level} (you have ${sk.level})` : null;
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
      const amount = isTrain ? `Level ${skillById(e.skillId)?.level ?? 0} / ${e.targetLevel}` : showProgress ? `${num(Runner.gained(e))} / ${num(e.qty)}` : `x${num(e.qty)}`;
      const btn = (act, ic, title, cls = "text-white-50") => `<a data-act="${act}" data-id="${esc(e.id)}" class="pointer-enabled ${cls} ml-2" title="${title}"><i class="fa ${ic}"></i></a>`;
      const sub = done && e.sold ? small("text-muted", esc(e.sold)) : e.reason ? small("text-warning", esc(e.reason))
        : issue ? small("text-warning", `<i class="fa fa-exclamation-triangle"></i> ${esc(issue)}`)
        : isTrain && e.now && !done ? small("text-muted", `now: ${esc(e.now)}`)
        : manual && !done ? small("text-muted", `do this yourself${e.status === "waiting" ? " (waiting for you)" : ""}`) : "";
      return `<div style="display:flex;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.07);${done ? "opacity:.5" : ""}" ${manual ? `title="${esc(e.note ?? "")}"` : ""}>` +
        `<div style="flex:1;min-width:0">${lead}${icon(isTrain ? skillById(e.skillId) : itemById(e.itemId))}<span class="${manual ? "text-muted font-italic" : ""}" style="${done ? "text-decoration:line-through" : ""}">${esc(e.label)}</span> <b>${amount}</b>` +
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
