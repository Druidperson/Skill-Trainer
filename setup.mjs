// Skill Trainer: pick a skill and a goal, and Action Queue plans and runs the work
export function setup(ctx) {
  const VERSION = "1.1.0", TAG = "[Skill Trainer]";
  // Everything that plans and runs steps lives in the Action Queue mod, which Skill Trainer needs.
  const aq = () => (typeof mod !== "undefined" && mod?.api?.actionQueue) || window.actionQueue;

  // ----- the Train a skill window -----
  const trainWindow = (A) => {
  const { nm, esc, num, plural, icon, chip, chips, step, note, warnIcon, fmtDur, costText } = A.ui;
  const { list: trainSkills, byId: skillById, isTrainable, methodsOf, methodById, makeables, stepFor, xpRate, levelCap, xpAt } = A.skills;
  const { buildRows, toEntries, itemMissing, missingHtml, itemSection, rowsMs, trainCands, trainPlan, bestDetour, blockedWhy, goalFirst, agilityPicks, buildSteps } = A.plan;
  const { settings: Settings, mastery, queue: { dupHtml } } = A;
  // messages show the icon of the skill picked in the window
  const tellPlayer = (m) => A.tell(m, skillById(TS.skillId));
  const AGILITY = "melvorD:Agility";
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
    if (added && Settings.get("autoStart") && A.runner.state !== "running") A.runner.start();
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
    return openTrain;
  };

  // ---------- install ----------
  let openTrain = null;
  const mount = () => { const A = aq(); if (A) { openTrain ??= trainWindow(A); A.addButton("mst-train-btn", "Train a skill: queue an item or a level goal", "fa-chart-line", 16, () => openTrain()); } };
  const install = () => {
    if (!aq()) {
      const msg = "Skill Trainer needs the Action Queue mod. Install Action Queue from the Mod Manager, then reload the game.";
      try { SwalLocale.fire({ title: "Skill Trainer", html: msg, icon: "warning" }); } catch (e) { console.warn(TAG, msg); }
      return;
    }
    mount();
    clearInterval(window.__mstTimer);
    window.__mstTimer = setInterval(mount, 2000); // the game can rebuild the menu; put the button back if it vanishes
    console.log(TAG, "installed", VERSION);
  };
  const ready = () => typeof game !== "undefined" && list0(game?.skills).length > 0 && typeof SwalLocale !== "undefined" && document.getElementById("skill-footer-minibar");
  const list0 = (r) => r?.allObjects ?? [];
  // wait a moment past the game loading so Action Queue (a dependency) is set up first
  const go = () => setTimeout(install, 1500);
  if (ready()) go();
  else { const timer = setInterval(() => { if (ready()) { clearInterval(timer); go(); } }, 500); }
}
