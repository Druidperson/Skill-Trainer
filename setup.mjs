// Skill Trainer: train a skill or make an item, with the queue planning and running the work
export function setup(ctx) {
(() => {
  "use strict";

  const VERSION = "1.0.0";
  const LOG = (...a) => console.log("[Skill Trainer]", ...a);
  const list = (r) => r?.allObjects ?? (r?.registeredObjects ? [...r.registeredObjects.values()] : []);
  const nm = (o) => String(o?.name ?? o?._name ?? o?._localID ?? o?.id ?? "?");
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  const icon = (o) => (typeof o?.media === "string" ? `<img class="skill-icon-xs mr-1" src="${esc(o.media)}">` : "");
  const have = (item) => {
    try { const q = game.bank.getQty(item); return Number.isFinite(q) ? q : null; } catch (e) { return null; }
  };
  // ---------- settings ----------
  // As a Melvor mod, the switch lives in the mod settings menu (ctx.settings). It is also on the queue panel,
  // and falls back to localStorage if the settings API isn't there (userscript use).
  const KEYS = { autoStart: ["mst-th-autostart", false], autoSell: ["mst-th-autosell", true], preferMastery: ["mst-th-mastery", false] };
  const Settings = {
    api: null,
    get(name) {
      try { if (this.api) { const v = this.api.get(name); if (v !== undefined && v !== null) return !!v; } } catch (e) { /* use fallback */ }
      try { const raw = localStorage.getItem(KEYS[name][0]); if (raw !== null) return raw === "1"; } catch (e) { /* ignore */ }
      return KEYS[name][1];
    },
    set(name, v) {
      try { if (this.api) this.api.set(name, !!v); } catch (e) { console.warn("[Skill Trainer] settings", e); }
      try { localStorage.setItem(KEYS[name][0], v ? "1" : "0"); } catch (e) { /* ignore */ }
    },
    autoStart() { return this.get("autoStart"); },
    setAutoStart(v) { this.set("autoStart", v); },
    autoSell() { return this.get("autoSell"); },
    preferMastery() { return this.get("preferMastery"); },
  };
  if (typeof ctx !== "undefined" && ctx?.settings) {
    try {
      const section = ctx.settings.section("General");
      section.add({
        type: "switch",
        name: "autoStart",
        label: "Automatically start the queue when adding a training goal",
        hint: "When on, adding a training goal to the queue starts the queue right away. When off, you press Start yourself.",
        default: false,
      });
      section.add({
        type: "switch",
        name: "preferMastery",
        label: "Prefer mastery XP when training a skill",
        hint: "When on, the planner counts the mastery XP a method gives next to the skill XP, and sticks with a method longer so its mastery keeps growing. When off, it only looks at skill XP per hour.",
        default: false,
      });
      section.add({
        type: "switch",
        name: "autoSell",
        label: "Automatically sell extras the queue makes",
        hint: "When a step makes more than the task needs (like arrowtips crafted in batches), the extra is sold. It never sells anything you already owned.",
        default: true,
      });
      Settings.api = section;
    } catch (e) { console.warn("[Skill Trainer] could not register settings", e); }
  }
  const itemById = (id) => { try { return game.items.getObjectByID(id); } catch (e) { return null; } };
  const skillById = (id) => list(game.skills).find((s) => s.id === id);
  const actionById = (skill, id) => list(skill?.actions).find((a) => a.id === id);

  // ---------- recipe index (built on first use) ----------
  // The skills the queue can run on its own. Anything else a recipe needs (herbs, feathers, monster drops)
  // becomes a step the player does themselves.
  const TRAINABLE = new Set([
    "melvorD:Woodcutting", "melvorD:Mining", "melvorD:Fishing", "melvorD:Cooking", "melvorD:Smithing",
    "melvorD:Fletching", "melvorD:Crafting", "melvorD:Runecrafting", "melvorD:Herblore",
  ]);
  const isTrainable = (s) => !!s && TRAINABLE.has(s.id);
  let idx = null;
  const buildIndex = () => {
    if (idx) return idx;
    idx = { crafters: new Map(), gatherers: new Map() };
    for (const skill of list(game.skills)) {
      if (!isTrainable(skill)) continue;
      for (const a of list(skill.actions)) {
        if (!a.product) continue;
        const isCraft = Array.isArray(a.itemCosts) && (a.itemCosts.length > 0 || (a.alternativeCosts?.length ?? 0) > 0);
        push(isCraft ? idx.crafters : idx.gatherers, a.product.id, { skill, a });
      }
    }
    return idx;
  };

  // Cooking burns some food: costs are used every attempt, but the product and the XP only come from the ones that work.
  // Returns the share of attempts that succeed (1 for every skill that never fails).
  const succ = (skill, a) => {
    try {
      if (skill?.id === "melvorD:Cooking" && typeof skill.getRecipeSuccessChance === "function") {
        const c = Number(skill.getRecipeSuccessChance(a));
        if (c > 0 && c < 100) return Math.max(0.05, c / 100);
      }
    } catch (e) { /* ignore */ }
    return 1;
  };
  const baseCosts = (a) => (Array.isArray(a.itemCosts) ? a.itemCosts : []);
  const options = (a) =>
    a.alternativeCosts?.length
      ? a.alternativeCosts.map((o) => ({ costs: o.itemCosts ?? [], mult: o.quantityMultiplier ?? 1 }))
      : [{ costs: [], mult: 1 }];

  const explode = (item, qty, depth, path, nodes) => {
    const n = nodes.get(item.id) ?? { item, qty: 0, depth: 0 };
    n.qty += qty;
    n.depth = Math.max(n.depth, depth);
    nodes.set(item.id, n);
    const c = idx.crafters.get(item.id)?.[0];
    if (!c || path.has(item.id) || depth > 12) return;
    const opt = options(c.a)[0];
    const per = Math.max(1, (c.a.baseQuantity ?? 1) * opt.mult) * succ(c.skill, c.a);
    const crafts = Math.ceil(qty / per);
    n.recipe = { c, opt, crafts };
    path.add(item.id);
    for (const cost of [...baseCosts(c.a), ...opt.costs]) {
      if (cost?.item) explode(cost.item, cost.quantity * crafts, depth + 1, path, nodes);
    }
    path.delete(item.id);
  };

  const num = (n) => Number(n).toLocaleString();
  const chip = (html, cls = "", title = "") => `<span class="mst-chip ${cls}"${title ? ` title="${esc(title)}"` : ""}><span>${html}</span></span>`;
  const where = (x) => `${esc(nm(x.skill))}: ${esc(nm(x.a))} (Lv ${x.a.level ?? 1})`;
  // anything outside the skills in TRAINABLE (monster drops, the shop, Farming and so on) is a step the player does
  const MANUAL_NOTE = "Skill Trainer can't get this on its own, so it's a step you do yourself";

  // ---------- breakdown rows -> popup html / queue entries ----------
  const lvlChip = (skill, a) =>
    skill && (a.level ?? 1) > skill.level
      ? chip(`<i class="fa fa-exclamation-triangle"></i>&nbsp;Needs ${esc(nm(skill))} level ${a.level} (you have ${skill.level})`, "warn")
      : "";
  // the easiest way to gather an item that the player can't gather yet (null if they can, or if no skill gathers it)
  const gatherBlock = (id) => {
    const opts = idx.gatherers.get(id) ?? [];
    if (!opts.length || opts.some((x) => (x.a.level ?? 1) <= x.skill.level)) return null;
    return opts.reduce((m, x) => ((x.a.level ?? 1) - x.skill.level < (m.a.level ?? 1) - m.skill.level ? x : m));
  };
  const itemMissing = (item, qty, fresh = false) => {
    const out = [];
    for (const n of buildRows(item, qty, fresh)) {
      const x = n.recipe ? n.recipe.c : gatherBlock(n.item.id);
      if (x && (x.a.level ?? 1) > x.skill.level) out.push({ text: `${x.a.level} ${nm(x.skill)}`, forName: nm(n.item) });
    }
    const seen = new Set();
    return out.filter((x) => { const k = x.text + "|" + x.forName; if (seen.has(k)) return false; seen.add(k); return true; });
  };
  const missingHtml = (miss) =>
    `<div class="mst-step">` +
    miss.map((x) => `<div class="mst-chips">${chip(`<i class="fa fa-exclamation-triangle"></i>&nbsp;Warning: ${esc(x.text)} required for ${esc(x.forName)}`, "warn")}</div>`).join("") +
    `<div class="mst-note">You can't queue this until you meet the requirements.</div></div>`;

  const buildRows = (item, qty, fresh = false) => {
    buildIndex();
    const nodes = new Map();
    explode(item, qty, 0, new Set(), nodes);
    // second pass, parents before children: what the bank already holds is used first, and only the rest is made
    const demand = new Map([[item.id, qty]]);
    const rows = [];
    for (const n of [...nodes.values()].sort((a, b) => a.depth - b.depth)) {
      const need = demand.get(n.item.id) ?? 0;
      if (need <= 0) continue;
      const isRoot = fresh && n.item.id === item.id;
      const owned = isRoot ? 0 : have(n.item) ?? 0;
      const make = Math.max(0, need - owned);
      n.need = need;
      n.fresh = isRoot;
      n.qty = make;
      if (n.recipe) {
        const { c, opt } = n.recipe;
        const per = Math.max(1, (c.a.baseQuantity ?? 1) * opt.mult) * succ(c.skill, c.a);
        const crafts = Math.ceil(make / per);
        n.recipe = { c, opt, crafts };
        if (make > 0) {
          for (const cost of [...baseCosts(c.a), ...opt.costs]) {
            if (cost?.item) demand.set(cost.item.id, (demand.get(cost.item.id) ?? 0) + cost.quantity * crafts);
          }
        }
      }
      if (make > 0) rows.push(n);
    }
    return rows.sort((a, b) => b.depth - a.depth || nm(a.item).localeCompare(nm(b.item)));
  };

  const itemSection = (item, qty, fresh = false) => {
    const rows = buildRows(item, qty, fresh);
    if (!rows.length) return `<div class="mst-step"><div class="mst-chips">${chip(`<i class="fa fa-check"></i> You already have enough in your bank`, "ok")}</div></div>`;
    return rows.map((n, i) => {
      const owned = have(n.item);
      const haveChip = owned === null || n.fresh ? "" : chip(`You have ${num(owned)}${n.need !== undefined ? ` of ${num(n.need)} needed` : ""}`);
      let title, chips;
      if (n.recipe) {
        const { c, opt, crafts } = n.recipe;
        const uses = [...baseCosts(c.a), ...opt.costs].filter((x) => x?.item).map((x) => chip(`${icon(x.item)}${num(x.quantity * crafts)} ${esc(nm(x.item))}`));
        const alts = (idx.crafters.get(n.item.id)?.length ?? 1) - 1 + options(c.a).length - 1;
        title = `${icon(c.skill)}<b>${esc(nm(c.skill))}</b>: make ${icon(n.item)}<b>${esc(nm(n.item))}</b> &times;${num(n.qty)}`;
        chips =
          `<div class="mst-chips">${chip(`Level ${c.a.level ?? 1}`)}${chip(`${num(crafts)} craft${crafts === 1 ? "" : "s"}`)}${haveChip}${alts > 0 ? chip(`${alts} other option${alts === 1 ? "" : "s"}`) : ""}</div>` +
          (uses.length ? `<div class="mst-chips">${chip("<b>Uses</b>", "lbl")}${uses.join("")}</div>` : "") +
          (lvlChip(c.skill, c.a) ? `<div class="mst-chips">${lvlChip(c.skill, c.a)}</div>` : "");
      } else {
        title = `${icon(n.item)}<b>${esc(nm(n.item))}</b> &times;${num(n.qty)}`;
        const g = idx.gatherers.get(n.item.id), lb = gatherBlock(n.item.id);
        chips = `<div class="mst-chips">${haveChip}</div>` +
          (g ? `<div class="mst-chips">${chip(`<i class="fa fa-hand-paper"></i> <b>Gather</b>`, "lbl")}${g.slice(0, 3).map((x) => chip(where(x))).join("")}</div>` +
              (lb ? `<div class="mst-chips">${lvlChip(lb.skill, lb.a)}</div>` : "")
            : `<div class="mst-chips">${chip(MANUAL_NOTE, "warn")}</div>`);
      }
      return `<div class="mst-step"><div class="mst-stepno">Step ${i + 1}</div><div class="mst-title">${title}</div>${chips}</div>`;
    }).join("");
  };

  // Queue entries: "kind" is what the runner does; qty is how many MORE of the item to end up with
  // (for "manual" entries it is how many you should own).
  const toEntries = (rows) =>
    rows.map((n) => {
      const base = { itemId: n.item.id, qty: n.qty };
      if (n.recipe) {
        const { c } = n.recipe;
        return { ...base, kind: "craft", skillId: c.skill.id, actionId: c.a.id, altIndex: 0, label: `${nm(c.skill)}: make ${nm(n.item)}` };
      }
      const g = idx.gatherers.get(n.item.id)?.[0];
      if (g) return { ...base, kind: "gather", skillId: g.skill.id, actionId: g.a.id, label: `${nm(g.skill)}: gather ${nm(n.item)}` };
      return { ...base, qty: n.need ?? n.qty, kind: "manual", label: `Get ${nm(n.item)}`, note: MANUAL_NOTE };
    });

  // onQueue(top) is called with top=true for "Add to top", false for "Add to queue"
  const fire = (title, body, onQueue, hooks) => {
    const bodyFn = typeof body === "function" ? body : () => body;
    const res = SwalLocale.fire({
      title,
      html: `<div class="text-center font-size-sm mst-th-pop">${bodyFn()}</div>`,
      confirmButtonText: "Close",
      showDenyButton: !!onQueue,
      denyButtonText: '<i class="fa fa-play mr-1"></i>Add to queue',
      showCancelButton: !!onQueue,
      cancelButtonText: '<i class="fa fa-arrow-up mr-1"></i>Add to top',
      // same shape and size as the Close button (btn btn-primary m-1), different colours
      customClass: { confirmButton: "btn btn-primary m-1", denyButton: "btn btn-success m-1", cancelButton: "btn btn-warning m-1" },
      didOpen: (popup) => {
        try { hooks?.didOpen?.(popup); } catch (e) { console.warn("[Skill Trainer]", e); }
        const acts = popup?.querySelector?.(".swal2-actions");
        if (acts) Object.assign(acts.style, { display: "flex", justifyContent: "center", alignItems: "center", gap: "5px", flexWrap: "nowrap", margin: "1em auto 0" });
        // order: Add to queue, Add to top, Close
        const ord = { ".swal2-deny": "1", ".swal2-cancel": "2", ".swal2-confirm": "3" };
        const sz = { height: "36px", padding: "0 16px", "font-size": "14px", "line-height": "1", "box-sizing": "border-box", display: "inline-flex", "align-items": "center", "justify-content": "center", "box-shadow": "none", outline: "none", margin: "0" };
        for (const [sel, o] of Object.entries(ord)) {
          const el = popup?.querySelector?.(sel);
          if (!el || (!onQueue && sel !== ".swal2-confirm")) continue;
          el.style.order = o;
          for (const [k, v] of Object.entries(sz)) el.style.setProperty(k, v, "important");
          if (sel === ".swal2-confirm") el.style.setProperty("min-width", "84px", "important");
        }
      },
      width: 620,
    });
    if (onQueue && res?.then) {
      res.then((r) => {
        try {
          if (r?.isDenied) onQueue(false);
          else if (r?.dismiss === "cancel") onQueue(true);
        } catch (e) { console.warn("[Skill Trainer]", e); }
      });
    }
  };

  // ---------- queue (saved locally, one list per character name) ----------
  // gather and craft run a game action, manual waits for the player, train plans the next batch of steps
  const KINDS = new Set(["gather", "craft", "manual", "train"]);
  const Queue = {
    items: [],
    key() { return `mst-th-queue:${game.characterName ?? "default"}`; },
    load() {
      try { const raw = localStorage.getItem(this.key()); this.items = raw ? JSON.parse(raw) : []; } catch (e) { this.items = []; }
      this.items = this.items.filter((e) => KINDS.has(e.kind));
      // the runner never survives a reload, so nothing is "in progress" any more (progress counts are kept)
      for (const e of this.items) {
        if (e.status === "active" || e.status === "waiting" || e.status === "blocked") e.status = "pending";
        delete e.reason; delete e.ack; delete e.t0; delete e.g0;
      }
      updateBadge();
    },
    save() {
      try { localStorage.setItem(this.key(), JSON.stringify(this.items)); } catch (e) { console.warn("[Skill Trainer] could not save queue", e); }
      updateBadge();
      Panel.render();
    },
    add(entries, top = false) {
      const fresh = entries.map((e) => ({ ...e, id: uid(), status: "pending" }));
      this.items = top ? [...fresh, ...this.items] : [...this.items, ...fresh];
      this.save();
    },
    insertBefore(id, entries) {
      const fresh = entries.map((e) => ({ ...e, id: uid(), status: "pending" }));
      const i = this.items.findIndex((e) => e.id === id);
      if (i < 0) this.items.push(...fresh); else this.items.splice(i, 0, ...fresh);
      this.save();
    },
    remove(id) { this.items = this.items.filter((e) => e.id !== id); this.save(); },
    move(id, dir) {
      const i = this.items.findIndex((e) => e.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= this.items.length) return;
      [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
      this.save();
    },
    toTop(id) {
      const i = this.items.findIndex((e) => e.id === id);
      if (i <= 0) return;
      const [e] = this.items.splice(i, 1);
      this.items.unshift(e);
      this.save();
    },
    clearDone() { this.items = this.items.filter((e) => e.status !== "done"); this.save(); },
    clear() { Runner.stop(); this.items = []; this.save(); },
  };

  const updateBadge = () => {
    const b = document.querySelector("#mst-queue-btn .mst-count");
    if (!b) return;
    const n = Queue.items.filter((e) => e.status !== "done").length;
    b.textContent = n ? String(n) : "";
    b.style.display = n ? "block" : "none";
  };

  // ---------- starting actions in the game ----------
  // Uses the game's own click handlers, in the same order its buttons use them.
  const startAction = (e) => {
    const skill = skillById(e.skillId);
    const a = skill && actionById(skill, e.actionId);
    if (!skill || !a) return { ok: false, reason: "this action wasn't found in your game version" };
    if (a.level > skill.level) return { ok: false, reason: `needs ${nm(skill)} level ${a.level}` };
    try {
      if (game.activeAction && game.activeAction !== skill) game.stopActiveAction();
      if (skill.isActive && skill.stop() === false) return { ok: false, reason: "couldn't stop the current activity" };
      switch (skill.id) {
        case "melvorD:Woodcutting":
          skill.activeTrees.clear();
          skill.selectTree(a);
          break;
        case "melvorD:Mining":
          if (a.isRespawning) return { ok: false, transient: true, reason: "waiting for the rock to respawn" };
          if (!skill.canMineOre(a)) return { ok: false, reason: "can't mine this yet (level, mastery or shop unlock)" };
          skill.selectedRock = undefined;
          skill.onRockClick(a);
          break;
        case "melvorD:Fishing": {
          const area = list(skill.areas).find((ar) => (ar.fish ?? []).includes(a));
          if (!area) return { ok: false, reason: "no fishing area found for this fish" };
          skill.onAreaFishSelection(area, a);
          skill.onAreaStartButtonClick(area);
          break;
        }
        case "melvorD:Cooking":
          skill.onRecipeSelectionClick(a);
          skill.onActiveCookButtonClick(a.category);
          break;
        default:
          if (typeof skill.selectRecipeOnClick === "function" && typeof skill.createButtonOnClick === "function") {
            skill.selectRecipeOnClick(a);
            if (a.alternativeCosts?.length && typeof skill.selectAltRecipeOnClick === "function") skill.selectAltRecipeOnClick(e.altIndex ?? 0);
            if (!skill.isActive) skill.createButtonOnClick();
          } else {
            return { ok: false, reason: `automating ${nm(skill)} isn't supported yet` };
          }
      }
    } catch (err) {
      return { ok: false, reason: "error: " + err.message };
    }
    if (skill.isActive) return { ok: true };
    return { ok: false, noMaterials: e.kind === "craft" && (a.level ?? 1) <= skill.level, reason: e.kind === "craft" ? "not enough materials (or level too low)" : "the game wouldn't start it" };
  };

  // ---------- XP per hour at base speed ----------
  const MELVOR_REALM = "melvorD:Melvor";
  const xpRate = (skill, a) => {
    const ms = a.baseInterval ?? (a.baseMinInterval !== undefined && a.baseMaxInterval !== undefined ? (a.baseMinInterval + a.baseMaxInterval) / 2 : skill.baseInterval) ?? 3000;
    return ms > 0 ? (((a.baseExperience ?? 0) * succ(skill, a)) / ms) * 3600000 : 0;
  };
  // ---------- time estimates (base speeds; the active entry switches to its measured speed after a few seconds) ----------
  const intervalMs = (skill, a) =>
    a.baseInterval ?? (a.baseMinInterval !== undefined && a.baseMaxInterval !== undefined ? (a.baseMinInterval + a.baseMaxInterval) / 2 : skill.baseInterval) ?? 3000;
  const msPerUnit = (e) => {
    const skill = skillById(e.skillId);
    if (!skill) return null;
    const a = actionById(skill, e.actionId);
    if (!a) return null;
    const ms = intervalMs(skill, a);
    if (e.kind === "gather") return ms / Math.max(1, a.baseQuantity ?? 1);
    const opt = options(a)[e.altIndex ?? 0];
    return ms / (Math.max(1, (a.baseQuantity ?? 1) * (opt?.mult ?? 1)) * succ(skill, a));
  };
  const remainingUnits = (e) => Math.max(0, e.qty - Runner.gained(e));
  const estimateMs = (e) => {
    if (e.kind === "manual" || e.status === "done") return 0;
    if (e.kind === "train") return trainEstimate(e);
    const units = remainingUnits(e);
    if (units <= 0) return 0;
    let per = msPerUnit(e);
    if (Runner.state === "running" && Runner.activeId === e.id && e.t0 !== undefined) {
      const dt = Date.now() - e.t0, dg = Runner.gained(e) - e.g0;
      if (dt > 10000 && dg > 0) per = dt / dg;
    }
    return per === null ? null : units * per;
  };
  const fmtDur = (ms) => {
    const m = Math.round(ms / 60000);
    if (m < 1) return "under 1 min";
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  const fmtClock = (ms) => {
    const d = new Date(Date.now() + ms);
    const t = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
  };

  // ---------- runner: takes entries from the top of the list, one at a time ----------
  const Runner = {
    state: "idle", // idle | running | paused
    message: "",
    activeId: null,
    activeSkillId: null,
    setState(s, msg = "") { this.state = s; this.message = msg; Panel.render(); },
    elapsed: 0, // running time since the queue was started (for the progress bar)
    lastTick: null,
    eta() {
      let ms = 0, unknown = 0, manual = 0;
      for (const e of Queue.items) {
        if (e.status === "done") continue;
        if (e.kind === "manual") { manual++; continue; }
        const t = estimateMs(e);
        if (t === null) unknown++; else ms += t;
      }
      return { ms, unknown, manual };
    },
    focusId: null, // "Do this first": run this entry now without moving it in the list
    current() {
      const f = this.focusId && Queue.items.find((e) => e.id === this.focusId && e.status !== "done");
      if (!f) this.focusId = null;
      return f || Queue.items.find((e) => e.status !== "done");
    },
    doFirst(id) {
      const e = Queue.items.find((x) => x.id === id);
      if (!e || e.status === "done") return;
      this.focusId = id;
      if (e.status === "blocked" || e.status === "waiting") e.status = "pending";
      if (this.state === "running") { this.step(); Panel.render(); } else this.start();
    },
    gained(e) {
      if (e.kind === "train") return Math.floor(skillById(e.skillId)?.xp ?? 0);
      if (e.startQty === undefined) return 0;
      return Math.max(0, (have(itemById(e.itemId)) ?? 0) - e.startQty);
    },
    haltAction() {
      const s = this.activeSkillId ? skillById(this.activeSkillId) : null;
      try { if (s && game.activeAction === s) game.stopActiveAction(); } catch (e) { console.warn("[Skill Trainer]", e); }
    },
    leave() {
      if (this.activeId === null) return;
      const prev = Queue.items.find((e) => e.id === this.activeId);
      if (prev && prev.status === "active") prev.status = "pending";
      this.haltAction();
      this.activeId = null;
      this.activeSkillId = null;
    },
    start() {
      const cur = this.current();
      if (!cur) { this.setState("idle", "Nothing to run: the queue is empty or finished."); return; }
      if (cur.kind === "manual" && cur.status === "waiting") cur.ack = true;
      if (this.state === "idle") this.elapsed = 0;
      this.state = "running";
      this.message = "";
      this.step();
      Panel.render();
    },
    pause(msg = "Paused") {
      if (this.state !== "running") return;
      this.haltAction();
      this.setState("paused", msg);
    },
    stop() {
      this.haltAction();
      const cur = Queue.items.find((e) => e.id === this.activeId);
      if (cur && cur.status !== "done") { cur.status = "pending"; delete cur.startQty; delete cur.reason; }
      // a manual step that was waiting for you goes back to pending, so pressing Start later doesn't count it as done
      for (const e of Queue.items) if (e.status === "waiting") e.status = "pending";
      this.activeId = null;
      this.activeSkillId = null;
      this.focusId = null;
      this.elapsed = 0;
      this.state = "idle";
      this.message = "Stopped";
      Queue.save();
    },
    block(entry, reason) {
      entry.status = "blocked";
      entry.reason = reason;
      this.haltAction();
      this.activeId = null;
      this.activeSkillId = null;
      Queue.save();
      this.setState("paused", `Stopped at "${entry.label}": ${reason}. Fix it, then press Start.`);
    },
    sellExtra(entry) {
      try {
        if ((!Settings.autoSell() && !entry.sellAll) || (entry.kind !== "craft" && entry.kind !== "gather") || entry.startQty === undefined) return;
        const item = itemById(entry.itemId);
        if (!item || !(item.sellsFor?.quantity > 0)) return;
        const bi = game.bank.items.get(item);
        if (!bi || bi.locked) return;
        const extra = Math.min(bi.quantity, bi.quantity - entry.startQty - (entry.sellAll ? 0 : entry.qty));
        if (!(extra >= 1)) return;
        const price = game.bank.getItemSalePrice(item, extra);
        game.bank.processItemSale(item, extra);
        entry.sold = `Sold ${extra.toLocaleString()}${entry.sellAll ? "" : " extra"} for ${price.toLocaleString()} ${nm(item.sellsFor.currency)}`;
      } catch (e) { console.warn("[Skill Trainer] auto-sell", e); }
    },
    finish(entry) {
      this.sellExtra(entry);
      entry.status = "done";
      delete entry.reason;
      const s = skillById(entry.skillId);
      try { if (s && game.activeAction === s) game.stopActiveAction(); } catch (e) { console.warn("[Skill Trainer]", e); }
      this.activeId = null;
      this.activeSkillId = null;
      Queue.save();
    },
    step() {
      if (this.state !== "running") { this.lastTick = null; return; }
      const nowT = Date.now();
      if (this.lastTick) this.elapsed += Math.min(nowT - this.lastTick, 5000);
      this.lastTick = nowT;
      for (let guard = 0; guard < 100; guard++) {
        const cur = this.current();
        if (!cur) { this.leave(); this.setState("idle", "Queue finished"); return; }

        // a "train to level" entry never runs itself: it works out the next batch of steps, puts them above itself, and comes back
        if (cur.kind === "train") {
          const sk = skillById(cur.skillId);
          if (!sk || sk.level >= cur.targetLevel) { this.finish(cur); continue; }
          const xpNow = Math.floor(sk.xp ?? 0);
          if (cur.lastXp !== undefined && xpNow <= cur.lastXp) cur.stall = (cur.stall ?? 0) + 1; else cur.stall = 0;
          cur.lastXp = xpNow;
          if (cur.stall >= 2) { this.block(cur, "training isn't giving any XP, so the plan stopped. Check the steps above it"); return; }
          const nb = nextBatch(cur);
          if (!nb.ok) { this.block(cur, nb.reason); return; }
          cur.now = nb.note;
          if (nb.to !== undefined) cur.afterLevel = nb.to;
          Queue.insertBefore(cur.id, nb.entries);
          continue;
        }

        // a different entry is now on top (we just started, or something was added above): switch to it
        if (this.activeId !== cur.id) {
          this.leave();
          this.activeId = cur.id;
          this.activeSkillId = cur.skillId ?? null;
          cur.status = "active";
          delete cur.reason;
          if (cur.kind !== "manual" && cur.startQty === undefined) cur.startQty = have(itemById(cur.itemId)) ?? 0;
          Queue.save();
          if (cur.kind !== "manual") {
            const r = startAction(cur);
            if (!r.ok && !(cur.kind === "craft" && r.noMaterials)) { // a craft with no materials is handled just below: it adds the steps to get them
              if (r.transient) { this.message = r.reason; Panel.render(); return; }
              this.block(cur, r.reason);
              return;
            }
          }
          cur.t0 = Date.now();
          cur.g0 = this.gained(cur);
        }

        const owned = have(itemById(cur.itemId)) ?? 0;
        if (cur.kind === "manual") {
          if (owned >= cur.qty || cur.ack) { this.finish(cur); continue; }
          cur.status = "waiting";
          this.activeId = null;
          this.activeSkillId = null;
          Queue.save();
          this.setState("paused", `Your turn: ${cur.label} x${Number(cur.qty).toLocaleString()} (you have ${owned.toLocaleString()}). Do it, then press Start.`);
          return;
        }

        if (cur.untilLevel) {
          const us = skillById(cur.untilSkill ?? cur.skillId);
          if (us && (us.level >= cur.untilLevel || (cur.untilXp && (us.xp ?? 0) >= cur.untilXp))) { this.finish(cur); continue; }
        }
        if (owned - (cur.startQty ?? 0) >= cur.qty) { this.finish(cur); continue; }

        const skill = skillById(cur.skillId);
        if (skill && skill.isActive && game.activeAction === skill) { Panel.render(); return; }
        if (game.activeAction && game.activeAction !== skill) { this.pause("Paused: something else started running."); return; }

        // nothing is running and the target isn't reached: the game stopped it (materials, etc.) so try again once
        const r = startAction(cur);
        if (r.ok) { Panel.render(); return; }
        if (r.transient) { this.message = r.reason; Panel.render(); return; }
        if (r.noMaterials && cur.kind === "craft") {
          const made = this.gained(cur);
          if (cur.restockMade !== undefined && made <= cur.restockMade) cur.restockStall = (cur.restockStall ?? 0) + 1; else cur.restockStall = 0;
          cur.restockMade = made;
          const rs = restockCraft(cur);
          if (rs.ok && cur.restockStall < 2) {
            cur.restocks = (cur.restocks ?? 0) + 1;
            Queue.insertBefore(cur.id, rs.entries);
            this.message = `Short of materials for ${nm(itemById(cur.itemId))}: getting ${rs.remaining.toLocaleString()} more worth`;
            continue;
          }
          this.block(cur, `${rs.ok ? "it keeps running out of materials without making more" : rs.reason} (${made.toLocaleString()} of ${Number(cur.qty).toLocaleString()} done)`);
          return;
        }
        this.block(cur, `${r.reason} (${this.gained(cur).toLocaleString()} of ${Number(cur.qty).toLocaleString()} done)`);
        return;
      }
    },
  };

  // A craft step ran out of ingredients before it made enough (Cooking burns food, Smithing and others can come up short):
  // work out what is still missing and the steps that get it
  const restockCraft = (e) => {
    const skill = skillById(e.skillId), a = actionById(skill, e.actionId), item = itemById(e.itemId);
    if (!skill || !a || !item) return { ok: false, reason: "this action wasn't found in your game version" };
    const opt = options(a)[e.altIndex ?? 0] ?? { costs: [], mult: 1 };
    const per = Math.max(1, (a.baseQuantity ?? 1) * opt.mult) * succ(skill, a);
    const remaining = e.qty - Math.max(0, (have(item) ?? 0) - (e.startQty ?? 0));
    const crafts = Math.max(1, Math.ceil(remaining / per));
    const entries = [];
    for (const k of [...baseCosts(a), ...opt.costs]) {
      if (!k?.item) continue;
      const need = k.quantity * crafts - (have(k.item) ?? 0);
      if (need > 0) entries.push(...toEntries(buildRows(k.item, need, true)));
    }
    if (!entries.length) return { ok: false, reason: "not enough materials (or level too low)" };
    if (entries.some((x) => x.kind === "manual")) return { ok: false, reason: `${nm(item)} needs something the queue can't get on its own` };
    for (const x of entries) x.parent = e.parent ?? e.id;
    return { ok: true, entries, remaining };
  };
  // ---------- train a skill ----------
  // Two goals: make an amount of an item, or train to a level. A level goal never farms blindly: every method is ranked
  // by XP per hour of ALL the work it takes (gathering its materials included), and the plan only switches method when a
  // clearly better one opens up. The queue plans one batch at a time, so it always uses your real level and bank.
  const levelIn = (skill, lv) => (lv && lv.has(skill.id) ? lv.get(skill.id) : skill.level);
  const xpAt = (l) => { try { return exp.level_to_xp(l); } catch (e) { return 0; } };
  const levelCapFor = (s) => (s.level >= 99 ? 120 : 99);
  const SWITCH_GAIN_MASTERY = 1.25; // with "prefer mastery XP" on, stay on a method longer so its mastery keeps growing
  const SWITCH_GAIN = 1.1; // keep the current method unless another is at least 10% faster, so plans don't split into tiny batches

  // time (ms) to get n of an item from scratch with things the queue can do itself; Infinity if it can't
  // also returns the XP those steps give in `skillId` (smelting bars trains Smithing too)
  const acquire = (item, n, lv, skillId, seen = new Set(), depth = 0) => {
    if (!(n > 0)) return { ms: 0, xp: 0 };
    buildIndex();
    const NO = { ms: Infinity, xp: 0 };
    if (depth > 10 || seen.has(item.id)) return NO;
    const c = idx.crafters.get(item.id)?.[0];
    if (c) {
      if (!isTrainable(c.skill) || (c.a.level ?? 1) > levelIn(c.skill, lv)) return NO;
      const opt = options(c.a)[0];
      const sr = succ(c.skill, c.a);
      const per = Math.max(1, (c.a.baseQuantity ?? 1) * opt.mult) * sr;
      const crafts = n / per; // attempts, not rounded up: this ranks methods by their steady rate
      let ms = crafts * intervalMs(c.skill, c.a), xp = c.skill.id === skillId ? crafts * sr * (c.a.baseExperience ?? 0) : 0;
      seen.add(item.id);
      for (const k of [...baseCosts(c.a), ...opt.costs]) {
        if (!k?.item) continue;
        const r = acquire(k.item, k.quantity * crafts, lv, skillId, seen, depth + 1);
        ms += r.ms; xp += r.xp;
      }
      seen.delete(item.id);
      return { ms, xp };
    }
    const g = idx.gatherers.get(item.id)?.[0];
    if (!g || !isTrainable(g.skill) || (g.a.level ?? 1) > levelIn(g.skill, lv)) return NO;
    const acts = n / Math.max(1, g.a.baseQuantity ?? 1);
    return { ms: acts * intervalMs(g.skill, g.a), xp: g.skill.id === skillId ? acts * (g.a.baseExperience ?? 0) : 0 };
  };
  // the same step the queue would really run for this product (first crafter / first gatherer)
  const stepFor = (a) => {
    buildIndex();
    const c = a.product && idx.crafters.get(a.product.id)?.[0];
    const g = a.product && idx.gatherers.get(a.product.id)?.[0];
    return c ? (c.a === a ? { craft: true } : null) : g && g.a === a ? { craft: false } : null;
  };
  // training methods open at this level, best first by XP per hour of everything they need
  const trainCands = (skill, lv) => {
    const out = [];
    const L = levelIn(skill, lv);
    for (const a of list(skill.actions)) {
      if (a.realm && a.realm.id !== MELVOR_REALM) continue;
      if ((a.level ?? 1) > L || !(a.baseExperience > 0) || !a.product) continue;
      const st = stepFor(a);
      if (!st) continue;
      const opt = st.craft ? options(a)[0] : { costs: [], mult: 1 };
      const sr = succ(skill, a);
      const per = Math.max(1, (a.baseQuantity ?? 1) * opt.mult) * sr; // products per attempt
      let ms = intervalMs(skill, a), xpPer = a.baseExperience * sr;
      if (st.craft) for (const k of [...baseCosts(a), ...opt.costs]) if (k?.item) { const r = acquire(k.item, k.quantity, lv, skill.id); ms += r.ms; xpPer += r.xp; }
      if (!isFinite(ms) || ms <= 0) continue;
      let mast = 0;
      if (Settings.preferMastery() && a.hasMastery !== false) {
        try { if (skill.getMasteryLevel(a) < 99) mast = Number(skill.getMasteryXPToAddForAction(a, intervalMs(skill, a))) || 0; } catch (e) { /* ignore */ }
      }
      const rate = (xpPer / ms) * 3600000;
      out.push({ a, per, ms, xpPer, mast, rate, score: ((xpPer + mast) / ms) * 3600000 });
    }
    return out.sort((x, y) => y.score - x.score);
  };
  const trainPlan = (skill, target, forcedId, fromLevel = skill.level, fromXp = skill.xp ?? 0, seed = null) => {
    const sim = new Map(seed ?? []);
    const batches = [];
    let L = fromLevel, cur = null, blocked = null;
    for (let guard = 0; L < target && guard < 140; guard++) {
      sim.set(skill.id, L);
      let cands = trainCands(skill, sim);
      if (forcedId) cands = cands.filter((c) => c.a.id === forcedId);
      if (!cands.length) { blocked = L; break; }
      let pick = cands[0];
      if (cur) { const same = cands.find((c) => c.a === cur.c.a); if (same && pick.score < same.score * (Settings.preferMastery() ? SWITCH_GAIN_MASTERY : SWITCH_GAIN)) pick = same; }
      if (!cur || cur.c.a !== pick.a) { cur = { c: pick, from: L, to: L }; batches.push(cur); }
      L++;
      cur.to = L;
    }
    let total = 0, xpPrev = fromXp;
    for (const b of batches) {
      const startXp = Math.max(xpPrev, xpAt(b.from));
      b.xpGain = Math.max(0, xpAt(b.to) - startXp);
      b.actions = Math.max(1, Math.ceil(b.xpGain / b.c.xpPer));
      b.ms = b.actions * b.c.ms;
      total += b.ms;
      xpPrev = xpAt(b.to);
    }
    return { batches, totalMs: total, blocked };
  };
  // Another skill can hold a better method back (steel needs coal, which needs Mining 30). Work out whether training that skill first
  // gets you to the target sooner, counting the time it takes. Returns { skill, level, saveMs } or null.
  const detourMemo = new Map();
  const GATHER_SKILLS = ["melvorD:Mining", "melvorD:Woodcutting", "melvorD:Fishing"];
  const bestDetour = (skill, target, fromLevel = skill.level, fromXp = skill.xp ?? 0) => {
    if (!isTrainable(skill) || target - fromLevel < 3) return null;
    const lvKey = GATHER_SKILLS.map((id) => skillById(id)?.level ?? 0).join(",");
    const key = `${skill.id}|${fromLevel}|${target}|${lvKey}|${Settings.preferMastery()}`;
    if (detourMemo.has(key)) return detourMemo.get(key);
    if (detourMemo.size > 100) detourMemo.clear();
    let best = null;
    try {
      const base = trainPlan(skill, target, "", fromLevel, fromXp);
      const T0 = base.blocked != null ? Infinity : base.totalMs;
      const bestRate = (lv, L) => trainCands(skill, lv.set(skill.id, L))[0]?.score ?? 0;
      for (const sid of GATHER_SKILLS) {
        const S = skillById(sid);
        if (!S || sid === skill.id || !isTrainable(S)) continue;
        const levels = [...new Set(list(S.actions).filter((a) => (!a.realm || a.realm.id === MELVOR_REALM) && (a.level ?? 1) > S.level && (a.level ?? 1) <= S.level + 30).map((a) => a.level ?? 1))].sort((x, y) => x - y);
        for (const R of levels) {
          // quick filter: does opening this level make any method better, now or near the end of the run?
          const early = bestRate(new Map(), fromLevel), earlyR = bestRate(new Map([[S.id, R]]), fromLevel);
          const late = bestRate(new Map(), target - 1), lateR = bestRate(new Map([[S.id, R]]), target - 1);
          if (!(earlyR > early * 1.1 || lateR > late * 1.1 || (early === 0 && earlyR > 0) || (late === 0 && lateR > 0))) continue;
          const det = trainPlan(S, R, "", S.level, S.xp ?? 0);
          if (det.blocked != null || !det.batches.length) continue;
          const after = trainPlan(skill, target, "", fromLevel, fromXp, new Map([[S.id, R]]));
          if (after.blocked != null) continue;
          const T1 = det.totalMs + after.totalMs;
          if (T1 < T0 * 0.9 && (T0 === Infinity || T0 - T1 > 120000) && (!best || T1 < best.T1)) best = { skill: S, level: R, T0, T1, saveMs: T0 - T1, detourMs: det.totalMs };
        }
      }
    } catch (e) { console.warn("[Skill Trainer] detour check failed", e); }
    detourMemo.set(key, best);
    return best;
  };
  // the next batch of real queue steps for a "train" entry, planned from the player's level and bank right now
  const nextBatch = (e) => {
    const skill = skillById(e.skillId);
    if (!skill) return { ok: false, reason: "this skill wasn't found in your game version" };
    if (!e.forced && !e.noDetour) {
      const dt = bestDetour(skill, e.targetLevel);
      if (dt && (skillById(dt.skill.id)?.level ?? 0) < dt.level) {
        return {
          ok: true, detour: true, to: undefined,
          entries: [{ kind: "train", skillId: dt.skill.id, targetLevel: dt.level, targetXp: xpAt(dt.level), qty: xpAt(dt.level), noDetour: true, parent: e.id, label: `${nm(dt.skill)}: reach level ${dt.level} (opens better ${nm(skill)} methods)` }],
          note: `${nm(dt.skill)} to level ${dt.level} first, saves about ${fmtDur(dt.saveMs)} on ${nm(skill)}`,
        };
      }
    }
    const plan = trainPlan(skill, e.targetLevel, e.forced);
    if (!plan.batches.length) {
      const fa = e.forced && actionById(skill, e.forced);
      return { ok: false, reason: fa ? `${nm(fa)} can't be trained by the queue at level ${skill.level}` : `nothing at ${nm(skill)} level ${skill.level} can be trained by the queue on its own (it may need shop items or monster drops)` };
    }
    const b = plan.batches[0];
    const goalXp = Math.min(xpAt(b.to), e.targetXp ?? Infinity);
    const actions = Math.max(1, Math.ceil((goalXp - (skill.xp ?? 0)) / b.c.xpPer));
    const item = b.c.a.product;
    const rows = buildRows(item, Math.ceil(actions * b.c.per), true);
    const entries = toEntries(rows);
    const last = entries[entries.length - 1];
    if (!last || last.itemId !== item.id) return { ok: false, reason: "couldn't work out the steps" };
    if (entries.some((x) => x.kind === "manual")) return { ok: false, reason: `${nm(item)} needs something the queue can't get on its own` };
    Object.assign(last, { untilLevel: b.to, untilSkill: skill.id, sellAll: !!e.sellMade });
    if (e.targetXp !== undefined && e.targetXp <= xpAt(b.to)) last.untilXp = e.targetXp;
    for (const x of entries) x.parent = e.id;
    return { ok: true, entries, to: b.to, note: `${nm(b.c.a)} until level ${b.to} (about ${Math.round(b.c.rate).toLocaleString()} XP/h)` };
  };
  const estMemo = new Map();
  const trainEstimate = (e) => {
    const sk = skillById(e.skillId);
    if (!sk) return null;
    const fromL = e.afterLevel && e.afterLevel > sk.level ? e.afterLevel : sk.level;
    const key = `${e.id}|${fromL}|${e.targetLevel}|${Settings.preferMastery()}`;
    if (estMemo.has(key)) return estMemo.get(key);
    if (estMemo.size > 200) estMemo.clear();
    const fromXp = fromL === sk.level ? (sk.xp ?? 0) : xpAt(fromL);
    const plan = trainPlan(sk, e.targetLevel, e.forced, fromL, fromXp);
    const dt = !e.forced && !e.noDetour ? bestDetour(sk, e.targetLevel, fromL, fromXp) : null;
    const ms = dt ? dt.T1 : plan.blocked != null ? null : plan.totalMs;
    estMemo.set(key, ms);
    return ms;
  };
  const rowsMs = (rows) => rows.reduce((s, n) => {
    if (n.recipe) return s + n.recipe.crafts * intervalMs(n.recipe.c.skill, n.recipe.c.a);
    const g = idx.gatherers.get(n.item.id)?.[0];
    return s + (g ? (n.qty * intervalMs(g.skill, g.a)) / Math.max(1, g.a.baseQuantity ?? 1) : 0);
  }, 0);

  // ----- the popup -----
  const TS = { skillId: null, goal: "level", make: null, qty: 100, level: null, forced: "", sell: false };
  const trainSkills = () => list(game.skills).filter(isTrainable);
  const currentTrainSkill = () => { const s = skillById(game.openPage?.id); return isTrainable(s) ? s : trainSkills()[0]; };
  const makeables = (skill) => { buildIndex(); return list(skill.actions).filter((a) => (!a.realm || a.realm.id === MELVOR_REALM) && a.product && stepFor(a)).sort((x, y) => (x.level ?? 1) - (y.level ?? 1)); };
  const fixTrain = () => {
    let sk = skillById(TS.skillId);
    if (!isTrainable(sk)) { sk = currentTrainSkill(); TS.skillId = sk?.id ?? null; }
    if (!sk) return;
    const ms = makeables(sk);
    if (!ms.some((a) => a.id === TS.make)) { const ok = ms.filter((a) => (a.level ?? 1) <= sk.level); TS.make = (ok.length ? ok[ok.length - 1] : ms[0])?.id ?? null; }
    const cap = levelCapFor(sk);
    if (!(TS.level > sk.level) || TS.level > cap) TS.level = Math.min(cap, Math.max(sk.level + 1, Math.ceil((sk.level + 1) / 10) * 10));
    if (TS.forced && !trainCands(sk).some((c) => c.a.id === TS.forced)) TS.forced = "";
  };
  const opt = (v, l, sel) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(l)}</option>`;
  const trainForm = () => {
    const sk = skillById(TS.skillId);
    const sel = (id, body) => `<select id="${id}" class="custom-select custom-select-sm">${body}</select>`;
    let h = `<div class="mst-form"><label>Skill</label>${sel("mst-tr-skill", trainSkills().map((s) => opt(s.id, `${nm(s)} (level ${s.level})`, s.id === TS.skillId)).join(""))}` +
      `<label>Goal</label>${sel("mst-tr-goal", opt("level", "Train to a level", TS.goal === "level") + opt("make", "Make an amount of an item", TS.goal === "make"))}`;
    if (TS.goal === "make") {
      h += `<label>Item</label>${sel("mst-tr-item", makeables(sk).map((a) => opt(a.id, `${nm(a.product)} (level ${a.level ?? 1}${(a.level ?? 1) > sk.level ? ", locked" : ""})`, a.id === TS.make)).join(""))}` +
        `<label>Amount</label><input id="mst-tr-qty" type="number" min="1" step="1" value="${TS.qty}" class="form-control form-control-sm">`;
    } else {
      h += `<label>Target level</label><input id="mst-tr-level" type="number" min="${sk.level + 1}" max="${levelCapFor(sk)}" step="1" value="${TS.level}" class="form-control form-control-sm">` +
        `<label>Method</label>${sel("mst-tr-method", opt("", "Best available (recommended)", !TS.forced) + trainCands(sk).map((c) => opt(c.a.id, `${nm(c.a)} (about ${num(Math.round(c.rate))} XP/h)`, c.a.id === TS.forced)).join(""))}` +
        `<label>Selling</label><label style="opacity:1"><input id="mst-tr-sell" type="checkbox"${TS.sell ? " checked" : ""}> Sell the items it makes</label>` +
        `<label>Mastery</label><label style="opacity:1"><input id="mst-tr-mastery" type="checkbox"${Settings.preferMastery() ? " checked" : ""}> Prefer mastery XP</label>`;
    }
    return h + `</div>`;
  };
  const trainBuild = () => {
    const sk = skillById(TS.skillId);
    if (!sk) return { html: `<div class="mst-note">No trainable skill found.</div>`, entries: [], problem: "No trainable skill found." };
    if (TS.goal === "make") {
      const act = actionById(sk, TS.make);
      const qty = Math.max(1, Math.floor(TS.qty || 0));
      if (!act?.product) return { html: "", entries: [], problem: "Pick an item first." };
      const item = act.product;
      const miss = itemMissing(item, qty, true);
      if (miss.length) return { html: missingHtml(miss), entries: [], problem: "You don't meet the requirements for that yet." };
      const rows = buildRows(item, qty, true);
      const entries = toEntries(rows);
      const per = Math.max(1, (act.baseQuantity ?? 1) * (stepFor(act)?.craft ? options(act)[0].mult : 1));
      const xp = Math.ceil(qty / per) * (act.baseExperience ?? 0);
      const head = `<div class="mst-step"><div class="mst-title">${icon(item)}<b>Make ${num(qty)} ${esc(nm(item))}</b></div><div class="mst-chips">` +
        chip(`About ${fmtDur(rowsMs(rows))}`, "ok", "Base speed, counting what your bank already holds") + chip(`${num(xp)} ${esc(nm(sk))} XP`, "", "Base XP, before bonuses") + `</div></div>`;
      return { html: dupHtml(entries) + head + itemSection(item, qty, true), entries };
    }
    const cap = levelCapFor(sk);
    const L = Math.floor(TS.level || 0);
    if (!(L > sk.level) || L > cap) {
      const msg = sk.level >= cap ? `${nm(sk)} is already at its highest level.` : `Pick a target level between ${sk.level + 1} and ${cap}.`;
      return { html: `<div class="mst-note">${esc(msg)}</div>`, entries: [], problem: msg };
    }
    const plan = trainPlan(sk, L, TS.forced || null);
    if (!plan.batches.length) {
      const msg = "Nothing here can be trained by the queue on its own at your level (it may need shop items or monster drops).";
      return { html: `<div class="mst-step"><div class="mst-chips">${chip(`<i class="fa fa-exclamation-triangle"></i>&nbsp;${esc(msg)}`, "warn")}</div></div>`, entries: [], problem: msg };
    }
    const entries = [{ kind: "train", skillId: sk.id, targetLevel: L, targetXp: xpAt(L), qty: xpAt(L), forced: TS.forced || undefined, sellMade: TS.sell, label: `${nm(sk)}: reach level ${L}` }];
    const dt = TS.forced ? null : bestDetour(sk, L);
    let html = dupHtml(entries) + `<div class="mst-step"><div class="mst-title">${icon(sk)}<b>${esc(nm(sk))}: level ${sk.level} to ${L}</b></div><div class="mst-chips">` +
      chip(`${num(Math.max(0, Math.ceil(xpAt(L) - (sk.xp ?? 0))))} XP to go`) +
      (dt ? chip(`About ${fmtDur(dt.T1)}`, "ok", `Includes training ${esc(nm(dt.skill))} first`) : plan.blocked == null ? chip(`About ${fmtDur(plan.totalMs)}`, "ok", "Base speeds, gathering the materials included") : chip(`Plan covers up to level ${plan.blocked}`, "warn")) + `</div></div>` +
      (dt ? `<div class="mst-step"><div class="mst-stepno">First</div><div class="mst-title">${icon(dt.skill)}<b>${esc(nm(dt.skill))} to level ${dt.level}</b></div><div class="mst-chips">${chip(`About ${fmtDur(dt.detourMs)}`)}${chip(`Saves about ${fmtDur(dt.saveMs)}`, "ok", "Compared with staying on the methods you can use now")}</div><div class="mst-note">Better ${esc(nm(sk))} methods need materials from ${esc(nm(dt.skill))} level ${dt.level}, so the queue trains it first.</div></div>` : "");
    html += plan.batches.map((b, i) => {
      const a = b.c.a;
      const st = stepFor(a);
      const uses = st?.craft ? [...baseCosts(a), ...options(a)[0].costs].filter((k) => k?.item).map((k) => chip(`${icon(k.item)}${num(k.quantity)} ${esc(nm(k.item))}`)).join("") : "";
      return `<div class="mst-step"><div class="mst-stepno">${i === 0 ? "Starting at" : "Then at"} level ${b.from}${b.to > b.from ? ` (to ${b.to})` : ""}</div>` +
        `<div class="mst-title">${icon(a.product)}<b>${esc(nm(a))}</b></div><div class="mst-chips">${chip(`${num(Math.round(b.c.rate))} XP/hour`, "", "Counting the time to gather or make what it needs")}${chip(`About ${fmtDur(b.ms)}`)}</div>` +
        (uses ? `<div class="mst-chips">${chip("<b>Each uses</b>", "lbl")}${uses}</div>` : "") + `</div>`;
    }).join("");
    let skipped = false;
    if (!TS.forced) {
      const okIds = new Set(trainCands(sk).map((c) => c.a.id));
      skipped = list(sk.actions).some((a) => (a.level ?? 1) <= sk.level && a.baseExperience > 0 && a.product && !okIds.has(a.id) && xpRate(sk, a) > plan.batches[0].c.rate);
    }
    html += `<div class="mst-note">Methods are ranked by XP per hour including the time to gather what they need, so it won't farm a mountain of materials for little XP. The queue re-checks your level and bank after every batch.` +
      (skipped ? ` Some faster methods are left out because their materials need higher levels in other skills, or come from the shop or monsters.` : "") + `</div>`;
    return { html, entries };
  };
  const trainBody = () => `<div id="mst-tr-form">${trainForm()}</div><div id="mst-tr-prev">${trainBuild().html}</div>`;
  const trainQueue = (top) => {
    const b = trainBuild();
    if (!b.entries.length) { tellPlayer(b.problem || "Nothing to add."); return; }
    const added = addUnique(b.entries, top);
    Panel.open();
    if (added && Settings.autoStart() && Runner.state !== "running") Runner.start();
  };
  const onTrainEvent = (popup, ev) => {
    const el = ev.target, id = el?.id ?? "";
    if (!id.startsWith("mst-tr-")) return;
    if (ev.type === "input" && (el.tagName === "SELECT" || el.type === "checkbox")) return;
    if (id === "mst-tr-skill") { TS.skillId = el.value; TS.make = null; TS.level = null; TS.forced = ""; fixTrain(); popup.querySelector("#mst-tr-form").innerHTML = trainForm(); }
    else if (id === "mst-tr-goal") { TS.goal = el.value; fixTrain(); popup.querySelector("#mst-tr-form").innerHTML = trainForm(); }
    else if (id === "mst-tr-item") TS.make = el.value;
    else if (id === "mst-tr-qty") TS.qty = Math.max(1, Math.floor(Number(el.value) || 1));
    else if (id === "mst-tr-level") TS.level = Math.floor(Number(el.value) || 0);
    else if (id === "mst-tr-method") TS.forced = el.value;
    else if (id === "mst-tr-sell") TS.sell = el.checked;
    else if (id === "mst-tr-mastery") Settings.set("preferMastery", el.checked);
    const prev = popup.querySelector("#mst-tr-prev");
    if (prev) prev.innerHTML = trainBuild().html;
  };
  const openTrain = () => {
    const cur = currentTrainSkill();
    if (!cur) return;
    TS.skillId = cur.id; TS.make = null; TS.level = null; TS.forced = "";
    fixTrain();
    fire("Train a skill", trainBody, trainQueue, {
      didOpen: (popup) => { for (const t of ["input", "change"]) popup.addEventListener(t, (ev) => onTrainEvent(popup, ev)); },
    });
  };

  // ---------- floating panel ----------
  const levelIssue = (e) => {
    if (e.kind !== "craft" && e.kind !== "gather") return null;
    const sk = skillById(e.skillId), a = sk && actionById(sk, e.actionId);
    return a && (a.level ?? 1) > sk.level ? `Needs ${nm(sk)} level ${a.level} (you have ${sk.level})` : null;
  };
  const POS_KEY = "mst-th-panel-pos";
  const Panel = {
    el: null,
    last: "",
    place(x, y) {
      const el = this.el;
      const w = el.offsetWidth || 350;
      x = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - w));
      y = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 48));
      Object.assign(el.style, { left: x + "px", top: y + "px", right: "auto", bottom: "auto", maxHeight: `min(70vh, ${Math.max(160, window.innerHeight - y - 8)}px)` });
      return { x, y };
    },
    restorePos() {
      try {
        const p = JSON.parse(localStorage.getItem(POS_KEY) ?? "null");
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) this.place(p.x, p.y);
      } catch (e) { /* default position */ }
    },
    ensure() {
      if (this.el) return this.el;
      document.getElementById("mst-queue-panel")?.remove();
      const el = document.createElement("div");
      el.id = "mst-queue-panel";
      el.style.cssText =
        "position:fixed;right:68px;bottom:16px;width:350px;max-height:70vh;display:none;flex-direction:column;z-index:1050;" +
        "background:rgba(28,32,41,.98);color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:10px;" +
        "box-shadow:0 6px 24px rgba(0,0,0,.5);font-size:13px";
      let drag = null;
      el.addEventListener("pointerdown", (ev) => {
        if (!ev.target.closest("[data-drag]") || ev.target.closest("[data-act]")) return;
        const r = el.getBoundingClientRect();
        drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top };
        try { el.setPointerCapture(ev.pointerId); } catch (e) { /* ignore */ }
        ev.preventDefault();
      });
      el.addEventListener("pointermove", (ev) => { if (drag) this.place(ev.clientX - drag.dx, ev.clientY - drag.dy); });
      const endDrag = () => {
        if (!drag) return;
        drag = null;
        const r = el.getBoundingClientRect();
        try { localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); } catch (e) { /* ignore */ }
      };
      el.addEventListener("pointerup", endDrag);
      el.addEventListener("pointercancel", endDrag);
      el.addEventListener("click", (ev) => {
        const a = ev.target.closest("[data-act]");
        if (!a || a.disabled) return;
        ev.preventDefault();
        const act = a.dataset.act, id = a.dataset.id;
        if (act === "close") this.close();
        else if (act === "up") Queue.move(id, -1);
        else if (act === "down") Queue.move(id, 1);
        else if (act === "top") Queue.toTop(id);
        else if (act === "remove") Queue.remove(id);
        else if (act === "clear") Queue.clear();
        else if (act === "cleardone") Queue.clearDone();
        else if (act === "start") Runner.start();
        else if (act === "pause") Runner.pause("Paused");
        else if (act === "stop") Runner.stop();
        else if (act === "first") Runner.doFirst(id);
        else if (act === "autostart") { Settings.setAutoStart(!Settings.autoStart()); this.last = ""; this.render(); }
        else if (act === "autosell") { Settings.set("autoSell", !Settings.autoSell()); this.last = ""; this.render(); }
      });
      window.addEventListener("resize", () => {
        if (this.el && this.el.style.left) { const r = this.el.getBoundingClientRect(); this.place(r.left, r.top); }
      });
      document.body.appendChild(el);
      this.el = el;
      this.restorePos();
      return el;
    },
    row(e) {
      const isTrain = e.kind === "train";
      const item = isTrain ? skillById(e.skillId) : itemById(e.itemId);
      const manual = e.kind === "manual";
      const done = e.status === "done";
      const issue = !done && !manual ? levelIssue(e) : null;
      const warn = e.status === "blocked" || e.status === "waiting" || !!issue;
      const lead = done ? '<i class="fa fa-check text-success mr-2"></i>'
        : e.status === "active" ? '<i class="fa fa-play text-success mr-2"></i>'
        : warn ? '<i class="fa fa-exclamation-triangle text-warning mr-2"></i>'
        : '<i class="fa fa-circle mr-2" style="opacity:.25;font-size:8px;vertical-align:middle"></i>';
      const showProgress = !manual && !done && (isTrain || (e.startQty !== undefined && (e.status === "active" || e.status === "blocked" || Runner.gained(e) > 0)));
      const amount = isTrain ? `<b>Level ${(skillById(e.skillId)?.level ?? 0)} / ${e.targetLevel}</b>` : showProgress ? `<b>${Runner.gained(e).toLocaleString()} / ${Number(e.qty).toLocaleString()}</b>` : `<b>x${Number(e.qty).toLocaleString()}</b>`;
      const btn = (act, ic, title) =>
        `<a data-act="${act}" data-id="${esc(e.id)}" class="pointer-enabled text-white-50 ml-2" title="${title}"><i class="fa ${ic}"></i></a>`;
      const sub = done && e.sold ? `<br><small class="text-muted">${esc(e.sold)}</small>`
        : e.reason ? `<br><small class="text-warning">${esc(e.reason)}</small>`
        : issue ? `<br><small class="text-warning"><i class="fa fa-exclamation-triangle"></i> ${esc(issue)}</small>`
        : isTrain && e.now && !done ? `<br><small class="text-muted">now: ${esc(e.now)}</small>`
        : manual && !done ? `<br><small class="text-muted">do this yourself${e.status === "waiting" ? " (waiting for you)" : ""}</small>` : "";
      return (
        `<div style="display:flex;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.07);${done ? "opacity:.5" : ""}" ${manual ? `title="${esc(e.note ?? "")}"` : ""}>` +
        `<div style="flex:1;min-width:0">${lead}${icon(item)}<span class="${manual ? "text-muted font-italic" : ""}" style="${done ? "text-decoration:line-through" : ""}">${esc(e.label)}</span> ${amount}${Runner.focusId === e.id ? ' <span class="badge badge-success">first</span>' : ""}${sub}</div>` +
        (done ? btn("remove", "fa-times", "Remove") :
          `<a data-act="first" data-id="${esc(e.id)}" class="pointer-enabled text-success ml-2" title="Do this first (keeps its place in the list)"><i class="fa fa-play-circle"></i></a>` +
          btn("top", "fa-angle-double-up", "Move to top") + btn("up", "fa-arrow-up", "Move up") + btn("down", "fa-arrow-down", "Move down") + btn("remove", "fa-times", "Remove")) +
        `</div>`
      );
    },
    render() {
      if (!this.el) return;
      const q = Queue.items;
      const pending = q.filter((e) => e.status !== "done").length;
      const running = Runner.state === "running";
      const eta = Runner.eta();
      const total = Runner.elapsed + eta.ms;
      const pct = pending === 0 ? (q.length ? 100 : 0) : total > 0 ? Math.min(99, Math.round((Runner.elapsed / total) * 100)) : 0;
      const cur = Runner.current();
      const statusText = running ? `Running: ${cur ? cur.label : ""}` : Runner.state === "paused" ? (Runner.message || "Paused") : (Runner.message || (pending ? "Ready" : "Idle"));
      const statusCls = Runner.state === "paused" ? "text-warning" : running ? "text-success" : "text-muted";
      const etaText = pending === 0 ? (q.length ? "All done" : "Queue is empty")
        : `${fmtDur(eta.ms)} left &middot; done around ${fmtClock(eta.ms)}` +
          (eta.manual ? ` <span class="text-muted">(+ ${eta.manual} manual step${eta.manual === 1 ? "" : "s"})</span>` : "") +
          (eta.unknown ? ` <span class="text-muted">(some steps can't be estimated)</span>` : "");
      const b = (act, label, ic, cls, disabled) =>
        `<button class="btn btn-sm ${cls}" data-act="${act}" ${disabled ? "disabled" : ""} style="padding:2px 10px"><i class="fa ${ic} mr-1"></i>${label}</button>`;
      const asOn = Settings.autoStart(), slOn = Settings.autoSell();
      const toggles =
        `<a data-act="autostart" class="pointer-enabled mr-2" title="Auto-start: ${asOn ? "On" : "Off"}" style="font-size:19px;line-height:1;${asOn ? "color:#30c78d" : "opacity:.45"}"><i class="fa ${asOn ? "fa-toggle-on" : "fa-toggle-off"}"></i></a>` +
        `<a data-act="autosell" class="pointer-enabled mr-2" title="Auto-sell extras: ${slOn ? "On" : "Off"}" style="font-size:15px;line-height:1;${slOn ? "color:#e5ae67" : "opacity:.45"}"><i class="fa fa-dollar-sign"></i></a>`;
      const html =
        `<div data-drag style="display:flex;align-items:center;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.12);cursor:move;user-select:none;touch-action:none" title="Drag to move">` +
        `<i class="fa fa-grip-vertical mr-2" style="opacity:.4"></i>${toggles}<b style="flex:1">Action Queue</b><span class="text-muted mr-2">${pending} action${pending === 1 ? "" : "s"} left</span>` +
        `<a data-act="close" class="pointer-enabled text-white" title="Close"><i class="fa fa-times"></i></a></div>` +
        `<div data-list style="overflow:auto;padding:4px 10px;flex:1">` +
        (q.length ? q.map((e) => this.row(e)).join("") : `<div class="text-muted py-3 text-center">Nothing queued yet.<br>Press the chart button in the bottom-right menu to train a skill.</div>`) +
        `</div>` +
        `<div style="padding:10px;border-top:1px solid rgba(255,255,255,.12);text-align:center">` +
        `<div style="position:relative;height:16px;border-radius:8px;background:rgba(255,255,255,.12);overflow:hidden">` +
        `<div style="height:100%;width:${pct}%;background:#30c78d;transition:width .8s"></div>` +
        `<span style="position:absolute;left:0;right:0;top:0;line-height:16px;font-size:11px;font-weight:600;text-shadow:0 0 3px rgba(0,0,0,.7)">${pct}%</span></div>` +
        `<div style="margin-top:6px"><small class="${statusCls}">${esc(statusText)}</small></div>` +
        `<div style="margin-bottom:8px"><small>${etaText}</small></div>` +
        `<div style="display:flex;justify-content:center;gap:6px">` +
        b("start", Runner.state === "paused" ? "Resume" : "Start", "fa-play", "btn-success", running || pending === 0) +
        b("pause", "Pause", "fa-pause", "btn-warning", !running) +
        b("stop", "Stop", "fa-stop", "btn-danger", Runner.state === "idle") +
        `</div>` +
        `<div style="display:flex;justify-content:center;gap:6px;margin-top:6px">` +
        b("cleardone", "Clear Queue", "fa-check", "btn-secondary", !q.some((e) => e.status === "done")) +
        b("clear", "Clear All", "fa-trash", "btn-outline-danger", q.length === 0) +
        `</div></div>`;
      if (html === this.last) return;
      const prev = this.el.querySelector("[data-list]");
      const top = prev ? prev.scrollTop : 0;
      this.el.innerHTML = html;
      this.last = html;
      const next = this.el.querySelector("[data-list]");
      if (next) next.scrollTop = top;
    },
    open() { this.ensure().style.display = "flex"; this.last = ""; this.render(); },
    close() { if (this.el) this.el.style.display = "none"; },
    toggle() { this.ensure(); this.el.style.display === "flex" ? this.close() : this.open(); },
  };

  // ---------- minibar button (bottom-right menu), sized like its neighbours ----------
  const mountButton = () => {
    const bar = document.getElementById("skill-footer-minibar");
    if (!bar) return;
    let b = document.getElementById("mst-queue-btn");
    if (!b) {
      b = document.createElement("button");
      b.className = "btn btn-sm btn-light";
      b.id = "mst-queue-btn";
      b.title = "Action Queue";
      b.style.position = "relative";
      b.innerHTML =
        '<i class="fa fa-list-ol text-dark" style="display:inline-block;width:24px;height:24px;line-height:24px;font-size:17px;text-align:center;vertical-align:middle"></i>' +
        '<span class="mst-count" style="display:none;position:absolute;top:-6px;right:-6px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:#17a2b8;color:#fff;font-size:10px;font-weight:600;line-height:17px;text-align:center"></span>';
      b.addEventListener("click", () => { Panel.toggle(); b.blur(); });
      bar.appendChild(b);
      updateBadge();
    }
    let tb = document.getElementById("mst-train-btn");
    if (!tb) {
      tb = document.createElement("button");
      tb.className = "btn btn-sm btn-light";
      tb.id = "mst-train-btn";
      tb.title = "Train a skill: queue an item or a level goal";
      tb.innerHTML = '<i class="fa fa-chart-line text-dark" style="display:inline-block;width:24px;height:24px;line-height:24px;font-size:16px;text-align:center;vertical-align:middle"></i>';
      tb.addEventListener("click", () => { try { openTrain(); } catch (e) { console.warn("[Skill Trainer]", e); } tb.blur(); });
      bar.insertBefore(tb, b);
    }
    const ref = [...bar.children].find((c) => c !== b && c !== tb && c.offsetWidth > 0);
    if (ref) for (const x of [b, tb]) { x.style.width = ref.offsetWidth + "px"; x.style.height = ref.offsetHeight + "px"; }
  };

  // ---------- goal -> popup ----------
  // ---------- duplicates ----------
  const entryKey = (e) => `${e.kind}|${e.itemId ?? e.skillId ?? ""}|${e.actionId ?? e.forced ?? ""}|${e.targetXp ?? ""}`;
  const queuedKeys = () => new Set(Queue.items.filter((x) => x.status !== "done").map(entryKey));
  const dupHtml = (entries) => {
    if (!entries?.length) return "";
    const keys = queuedKeys();
    const dups = entries.filter((e) => keys.has(entryKey(e)));
    if (!dups.length) return "";
    const all = dups.length === entries.length;
    return `<div class="mst-step"><div class="mst-chips">${chip(`<i class="fa fa-exclamation-triangle"></i>&nbsp;${all ? "This task is already in your queue" : `${dups.length} of ${entries.length} steps are already in your queue`}`, "warn")}</div>` +
      `<div class="mst-chips">${dups.map((e) => chip(esc(e.label))).join("")}</div>` +
      `<div class="mst-note">${all ? "Adding it again does nothing." : "Those steps will be skipped, the rest are added."}</div></div>`;
  };
  const tellPlayer = (msg) => {
    // shown with the icon of the skill picked in the Train window, or the one the queue is on
    const e = Queue.items.find((x) => x.status !== "done" && x.skillId);
    const sk = skillById(TS.skillId) ?? (e && skillById(e.skillId)) ?? list(game.skills)[0];
    try { notifyPlayer(sk, msg, "info"); } catch (err) { console.log("[Skill Trainer]", msg); }
  };
  const addUnique = (entries, top) => {
    const seen = queuedKeys();
    const fresh = [], skipped = [];
    for (const e of entries) {
      const k = entryKey(e);
      if (seen.has(k)) skipped.push(e.label); else { seen.add(k); fresh.push(e); }
    }
    if (fresh.length) Queue.add(fresh, top);
    if (skipped.length) tellPlayer(fresh.length ? `${skipped.length} step${skipped.length === 1 ? " was" : "s were"} already in the queue and skipped: ${skipped.join(", ")}` : "That task is already in your queue.");
    return fresh.length;
  };

  // ---------- install ----------
  const injectStyle = () => {
    document.getElementById("mst-th-style")?.remove();
    const st = document.createElement("style");
    st.id = "mst-th-style";
    st.textContent = `
      .mst-th-pop{text-align:center}
      .mst-step{background:rgba(127,127,127,.12);border:1px solid rgba(127,127,127,.3);border-radius:8px;padding:8px 10px;margin:0 0 8px}
      .mst-stepno{font-size:12px;font-weight:600;opacity:.7;margin-bottom:2px}
      .mst-title{font-size:15px;margin:2px 0 6px}
      .mst-chips{display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:5px;margin-top:4px}
      .mst-chip{display:inline-flex;align-items:center;gap:3px;padding:1px 9px;border-radius:11px;background:rgba(127,127,127,.22);font-size:12px;line-height:20px}
      .mst-chip img,.mst-title img.skill-icon-xs{width:18px;height:18px;margin:0 3px 0 0;vertical-align:middle}
      .mst-chip.ok{background:rgba(48,199,141,.25);color:#2fb67a}
      .mst-chip.warn{background:rgba(229,174,103,.25);color:#c98a2b}
      .mst-chip.lbl{background:transparent;padding-left:0;opacity:.85}
      .mst-chip>span{display:inline;line-height:20px}
      .mst-chip small{opacity:.8;font-size:.8em}
      .mst-note{margin-top:8px;font-size:12px;opacity:.7}
      .mst-form{display:grid;grid-template-columns:120px 1fr;gap:6px 10px;align-items:center;text-align:left;margin:0 0 10px}
      .mst-form label{margin:0;font-size:13px;opacity:.85}
      .mst-form select,.mst-form input[type=number]{width:100%}
    `;
    document.head.appendChild(st);
  };

  const install = () => {
    injectStyle();
    Queue.load();
    mountButton();
    clearInterval(window.__mstTimer);
    window.__mstTimer = setInterval(mountButton, 2000); // the game can rebuild the menu; put our button back if it vanishes
    clearInterval(window.__mstRunTimer);
    window.__mstRunTimer = setInterval(() => { try { Runner.step(); } catch (e) { console.warn("[Skill Trainer] runner", e); } }, 1000);
    window.skillTrainer = {
      version: VERSION,
      queue: Queue,
      panel: Panel,
      runner: Runner,
      settings: Settings,
    };
    LOG("installed", VERSION);
  };

  const ready = () =>
    typeof game !== "undefined" &&
    list(game?.skills).length > 0 &&
    typeof SwalLocale !== "undefined" &&
    document.getElementById("skill-footer-minibar");

  if (ready()) install();
  else {
    const timer = setInterval(() => { if (ready()) { clearInterval(timer); install(); } }, 500);
  }
})();
}
