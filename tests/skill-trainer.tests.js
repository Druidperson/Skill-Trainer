/*
 * Skill Trainer test suite. Runs inside Melvor Idle with the mod installed.
 *
 *   1. Open the game, load a character, open the browser console.
 *   2. Paste this file, then run:   await STTests.run()
 *
 * Options: STTests.run({ live: false })            skip tests that start real game actions
 *          STTests.run({ group: "Queue" })         one group only
 *          STTests.run({ only: /duplicate/i })     tests whose name matches
 * The queue, settings and bank lookups are backed up and restored around every test.
 * Keep the game tab in front while it runs: hidden tabs pause the game and the live tests will skip.
 */
(() => {
  "use strict";
  const TESTS = [];
  const test = (group, name, fn, opts = {}) => TESTS.push({ group, name, fn, ...opts });
  class Skip extends Error {}
  const skip = (why) => { throw new Skip(why); };
  class Warn extends Error {}
  const fail = (m) => { throw new Error(m); };
  const ok = (c, m = "expected a truthy value") => { if (!c) fail(m); };
  const eq = (a, b, m = "") => { if (a !== b) fail(`${m} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`.trim()); };
  const has = (s, sub, m = "") => { if (!String(s).includes(sub)) fail(`${m} expected text to contain ${JSON.stringify(sub)}, got ${JSON.stringify(String(s).replace(/\s+/g, " ").slice(0, 160))}`.trim()); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond, ms = 15000, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await cond()) return true; await sleep(step); } return false; };
  const TH = () => window.skillTrainer;
  const D = () => TH()._dev;
  const list = (r) => r?.allObjects ?? (r?.registeredObjects ? [...r.registeredObjects.values()] : []);
  const item = (id) => game.items.getObjectByID(id);
  const skill = (n) => game.skills.getObjectByID("melvorD:" + n);
  const html = (s) => { const d = document.createElement("div"); d.innerHTML = s; return d; };
  const text = (s) => html(s).textContent;
  const TRAINABLE = ["Woodcutting", "Mining", "Fishing", "Cooking", "Smithing", "Fletching", "Runecrafting"];

  // ---- sandbox: everything a test changes is put back afterwards ----
  let stubs = [];
  const stub = (obj, key, val) => {
    const d = Object.getOwnPropertyDescriptor(obj, key);
    if (d && d.configurable === false) { // global function declarations: assign over them
      const old = obj[key];
      stubs.push(() => { obj[key] = old; });
      obj[key] = val;
      return;
    }
    stubs.push(() => (d ? Object.defineProperty(obj, key, d) : delete obj[key]));
    Object.defineProperty(obj, key, { value: val, configurable: true, writable: true, enumerable: true });
  };
  const bankStub = (fn) => stub(game.bank, "getQty", (it) => fn(it?.id));
  const notes = [];
  const captureNotices = () => stub(window, "notifyPlayer", (_, msg) => { notes.push(String(msg)); });
  // closing animates, and a half-closed popup would answer the next test's lookups
  const closePopups = async () => {
    try { Swal.close(); } catch (e) { /* none open */ }
    await waitFor(() => !document.querySelector(".swal2-container"), 800, 25);
    document.querySelectorAll(".swal2-container").forEach((x) => x.remove());
  };
  const sandbox = async (fn) => {
    const th = TH();
    th.runner.stop();
    await closePopups();
    const saved = JSON.stringify(th.queue.items);
    const sAuto = th.settings.autoStart(), sSell = th.settings.autoSell(), sMast = th.settings.preferMastery();
    th.settings.setAutoStart(false);
    th.settings.set("autoSell", true);
    th.settings.set("preferMastery", false);
    th.queue.items = [];
    notes.length = 0;
    stubs = [];
    try { return await fn(); }
    finally {
      th.runner.stop();
      try { if (game.activeAction) game.stopActiveAction(); } catch (e) { /* ignore */ }
      await closePopups();
      while (stubs.length) stubs.pop()();
      th.queue.items = JSON.parse(saved);
      th.queue.save();
      th.settings.setAutoStart(sAuto);
      th.settings.set("autoSell", sSell);
      th.settings.set("preferMastery", sMast);
      th.panel.close();
    }
  };
  // SweetAlert shows the popup first; the mod's own setup (button styling and click handlers) runs in didOpen right after.
  // Its last visible trace is the Close button's min-width.
  const popupReady = () => waitFor(() => document.querySelector(".swal2-confirm")?.style.minWidth === "84px", 3000, 25);
  const liveOk = () => { if (document.hidden) skip("the game tab is hidden, so the game is paused"); };

  // =====================================================================================
  // Game contract: the game things the mod relies on. A failure here after a game update tells you what moved.
  // =====================================================================================

  // =====================================================================================
  // Game contract: the game things the mod relies on. A failure here after a game update tells you what moved.
  // =====================================================================================
  const aMonster = () => list(game.monsters).find((m) => D().areaFor(m));
  const G = "Game contract";
  test(G, "XP table matches the known values", () => { eq(exp.level_to_xp(99), 13034431, "level 99"); ok(exp.level_to_xp(50) > 100000 && exp.level_to_xp(50) < 102000, "level 50"); });
  test(G, "skill methods used to start actions exist", () => {
    const need = {
      Woodcutting: ["selectTree", "stop"], Mining: ["onRockClick", "canMineOre", "stop"], Fishing: ["onAreaFishSelection", "onAreaStartButtonClick", "stop"],
      Firemaking: ["selectLog", "burnLog"], Cooking: ["onRecipeSelectionClick", "onActiveCookButtonClick"],
      Smithing: ["selectRecipeOnClick", "createButtonOnClick"], Fletching: ["selectRecipeOnClick", "createButtonOnClick"],
      Crafting: ["selectRecipeOnClick", "createButtonOnClick"], Runecrafting: ["selectRecipeOnClick", "createButtonOnClick"], Herblore: ["selectRecipeOnClick", "createButtonOnClick"],
    };
    const bad = [];
    for (const [s, ms] of Object.entries(need)) for (const m of ms) if (typeof skill(s)?.[m] !== "function") bad.push(`${s}.${m}`);
    ok(!bad.length, "missing: " + bad.join(", "));
    ok(skill("Woodcutting").activeTrees && typeof skill("Woodcutting").activeTrees.clear === "function", "Woodcutting.activeTrees");
    ok(list(skill("Fishing").areas).length > 0, "Fishing.areas");
  });
  test(G, "combat, bank, shop and stats methods exist", () => {
    for (const [o, ms] of [[game, ["stopActiveAction", "checkRequirement", "checkRequirements"]], [game.combat, ["selectMonster"]],
      [game.bank, ["getQty", "processItemSale", "getItemSalePrice"]], [game.shop, ["buyItemOnClick", "capPurchaseQuantity"]], [game.stats, ["monsterKillCount"]]]) {
      for (const m of ms) eq(typeof o[m], "function", m);
    }
    ok(game.bank.items instanceof Map || typeof game.bank.items?.get === "function", "bank.items.get");
    ok("buyQuantity" in game.shop, "shop.buyQuantity");
    ok(list(game.combatAreas).length > 0 && list(game.slayerAreas).length >= 0, "combat areas");
  });
  test(G, "recipe data has the fields the planner reads", () => {
    for (const s of TRAINABLE) {
      const acts = list(skill(s).actions);
      ok(acts.length > 0, `${s} has no actions`);
      ok(acts.some((a) => a.baseExperience > 0 && a.level >= 1 && a.product), `${s}: no action with baseExperience, level and product`);
    }
    const bar = list(skill("Smithing").actions).find((a) => a.product?.id === "melvorD:Bronze_Bar");
    ok(bar && bar.itemCosts.length === 2, "Bronze Bar recipe changed");
    ok(item("melvorD:Feathers") && item("melvorD:Copper_Ore"), "base items");
  });

  // =====================================================================================
  const I = "Install";
  test(I, "minibar has the queue and train buttons", () => {
    ok(document.getElementById("mst-queue-btn"), "queue button");
    ok(document.getElementById("mst-train-btn"), "train button");
  });
  test(I, "panel opens and closes", () => {
    TH().panel.open();
    eq(document.getElementById("mst-queue-panel").style.display, "flex");
    TH().panel.close();
    eq(document.getElementById("mst-queue-panel").style.display, "none");
  });

  // =====================================================================================
  const Q = "Queue";
  const logsAction = () => list(skill("Woodcutting").actions).find((a) => a.product?.id === "melvorD:Normal_Logs");
  const E = (o = {}) => ({ kind: "gather", skillId: "melvorD:Woodcutting", actionId: logsAction()?.id, itemId: "melvorD:Normal_Logs", qty: 1, label: "Test step", ...o });
  test(Q, "add, remove, move and move to top", () => sandbox(() => {
    const q = TH().queue;
    q.add([E({ label: "A" }), E({ label: "B" }), E({ label: "C" })]);
    eq(q.items.map((e) => e.label).join(""), "ABC");
    q.add([E({ label: "T" })], true);
    eq(q.items[0].label, "T");
    q.move(q.items[1].id, 1); eq(q.items.map((e) => e.label).join(""), "TBAC");
    q.toTop(q.items[3].id); eq(q.items[0].label, "C");
    q.remove(q.items[0].id); eq(q.items.length, 3);
    ok(q.items.every((e) => e.id && e.status === "pending"));
  }));
  test(Q, "insertBefore puts steps above a given entry", () => sandbox(() => {
    const q = TH().queue;
    q.add([E({ label: "A" }), E({ label: "B" })]);
    q.insertBefore(q.items[1].id, [E({ label: "X" }), E({ label: "Y" })]);
    eq(q.items.map((e) => e.label).join(""), "AXYB");
  }));
  test(Q, "clear done removes only finished steps", () => sandbox(() => {
    const q = TH().queue;
    q.add([E({ label: "A" }), E({ label: "B" })]);
    q.items[0].status = "done";
    q.clearDone();
    eq(q.items.map((e) => e.label).join(""), "B");
  }));
  test(Q, "the queue is saved per character and statuses reset on load", () => sandbox(() => {
    const q = TH().queue;
    ok(q.key().includes(game.characterName ?? "default"), "key " + q.key());
    q.add([E({ label: "A" }), E({ label: "B" }), E({ label: "C" })]);
    q.items[0].status = "active"; q.items[1].status = "blocked"; q.items[1].reason = "r"; q.items[2].status = "done";
    q.save();
    q.items = []; q.load();
    eq(q.items.map((e) => e.status).join(), "pending,pending,done");
    ok(!q.items[1].reason, "reason cleared");
  }));
  test(Q, "the badge shows how many steps are left", () => sandbox(() => {
    TH().queue.add([E(), E(), E()]);
    eq(document.querySelector("#mst-queue-btn .mst-count").textContent, "3");
    TH().queue.clear();
    eq(document.querySelector("#mst-queue-btn .mst-count").style.display, "none");
  }));

  const S = "Auto-sell";
  const sellSetup = (qty, locked = false, sellsFor = true) => {
    const sold = [];
    const it = item("melvorD:Copper_Ore");
    stub(game.bank.items, "get", () => ({ quantity: qty, locked }));
    stub(game.bank, "getItemSalePrice", () => 7);
    stub(game.bank, "processItemSale", (i, n) => sold.push([i.id, n]));
    if (!sellsFor) stub(it, "sellsFor", { quantity: 0 });
    return sold;
  };
  const sellEntry = (o = {}) => ({ kind: "gather", itemId: "melvorD:Copper_Ore", qty: 10, startQty: 5, label: "x", ...o });
  test(S, "sells only what's above the target", () => sandbox(() => {
    const sold = sellSetup(20);
    TH().runner.sellExtra(sellEntry());
    eq(JSON.stringify(sold), JSON.stringify([["melvorD:Copper_Ore", 5]]));
  }));
  test(S, "sells nothing when exactly on target", () => sandbox(() => {
    const sold = sellSetup(15);
    TH().runner.sellExtra(sellEntry());
    eq(sold.length, 0);
  }));
  test(S, "never sells locked items, or when auto-sell is off", () => sandbox(() => {
    let sold = sellSetup(20, true);
    TH().runner.sellExtra(sellEntry());
    eq(sold.length, 0, "locked");
    while (stubs.length) stubs.pop()();
    sold = sellSetup(20);
    TH().settings.set("autoSell", false);
    TH().runner.sellExtra(sellEntry());
    eq(sold.length, 0, "setting off");
  }));
  test(S, "'sell what I make' sells everything gained, even with auto-sell off", () => sandbox(() => {
    const sold = sellSetup(20);
    TH().settings.set("autoSell", false);
    const e = sellEntry({ sellAll: true });
    TH().runner.sellExtra(e);
    eq(JSON.stringify(sold), JSON.stringify([["melvorD:Copper_Ore", 15]]));
    has(e.sold, "Sold 15");
  }));

  const ST = "Settings";
  test(ST, "auto-start and auto-sell can be toggled and are remembered", () => sandbox(() => {
    const s = TH().settings;
    s.setAutoStart(true); eq(s.autoStart(), true);
    s.setAutoStart(false); eq(s.autoStart(), false);
    s.set("autoSell", false); eq(s.autoSell(), false);
    s.set("autoSell", true); eq(s.autoSell(), true);
  }));
  test(ST, "panel toggles flip the settings", () => sandbox(() => {
    TH().panel.open();
    const before = TH().settings.autoStart();
    TH().panel.el.querySelector('[data-act="autostart"]').click();
    eq(TH().settings.autoStart(), !before);
    const sBefore = TH().settings.autoSell();
    TH().panel.el.querySelector('[data-act="autosell"]').click();
    eq(TH().settings.autoSell(), !sBefore);
  }));

  // =====================================================================================
  const P = "Panel";
  test(P, "every kind of step renders a row", () => sandbox(() => {
    const sk = skill("Woodcutting");
    TH().queue.add([
      E({ label: "Gather row" }), E({ kind: "craft", skillId: "melvorD:Smithing", itemId: "melvorD:Bronze_Bar", actionId: "melvorD:Bronze_Bar", label: "Craft row" }),
      { kind: "manual", itemId: "melvorD:Feathers", qty: 5, label: "Manual row", note: "n" },
      { kind: "xp", skillId: sk.id, targetXp: sk.xp + 100, qty: 1, label: "XP row" },
      { kind: "combat", monsterId: aMonster().id, targetKills: 2, rel: true, qty: 2, label: "Combat row" },
      { kind: "train", skillId: sk.id, targetLevel: sk.level + 2, targetXp: exp.level_to_xp(sk.level + 2), qty: 1, label: "Train row" },
    ]);
    TH().panel.open();
    const t = TH().panel.el.innerText;
    for (const l of ["Gather row", "Craft row", "Manual row", "XP row", "Combat row", "Train row"]) has(t, l);
    has(t, `Level ${sk.level} / ${sk.level + 2}`, "train progress");
    has(t, "6 actions left");
  }));
  test(P, "an empty queue says so and disables Start", () => sandbox(() => {
    TH().panel.open();
    has(TH().panel.el.innerText, "Nothing queued yet");
    ok(TH().panel.el.querySelector('[data-act="start"]').disabled, "Start enabled");
  }));
  test(P, "time estimates are numbers for gather steps", () => sandbox(() => {
    TH().queue.add([E({ qty: 100 })]);
    const ms = D().estimateMs(TH().queue.items[0]);
    ok(ms > 0 && Number.isFinite(ms), "estimate " + ms);
    ok(TH().runner.eta().ms >= ms - 1, "eta");
    ok(/min|h/.test(D().fmtDur(ms)), "format");
  }));

  // =====================================================================================
  const R = "Runner";
  test(R, "starting an empty queue stays idle", () => sandbox(() => {
    TH().runner.start();
    eq(TH().runner.state, "idle");
    ok(TH().runner.message.length > 0, "message");
  }));
  test(R, "a manual step waits for you, then continues when you press Start", () => sandbox(() => {
    TH().queue.add([{ kind: "manual", itemId: "melvorD:Feathers", qty: 999999999, label: "Do it", note: "n" }]);
    TH().runner.start();
    eq(TH().runner.state, "paused");
    eq(TH().queue.items[0].status, "waiting");
    has(TH().runner.message, "Your turn");
    TH().runner.start();
    eq(TH().queue.items[0].status, "done");
  }));
  test(R, "a step you can't do stops the queue with a reason", () => sandbox(() => {
    const sm = skill("Smithing");
    const hard = list(sm.actions).filter((a) => a.product && a.level > sm.level)[0];
    if (!hard) skip("no recipe above your Smithing level");
    TH().queue.add([{ kind: "craft", skillId: sm.id, actionId: hard.id, itemId: hard.product.id, qty: 1, label: "Too hard" }]);
    TH().runner.start();
    eq(TH().runner.state, "paused");
    eq(TH().queue.items[0].status, "blocked");
    has(TH().queue.items[0].reason, "level");
    ok(!game.activeAction || game.activeAction === null, "something is still running");
  }));
  test(R, "stop puts the current step back to pending, so Start doesn't skip a manual step", () => sandbox(() => {
    TH().queue.add([{ kind: "manual", itemId: "melvorD:Feathers", qty: 999999999, label: "m", note: "" }]);
    TH().runner.start();
    eq(TH().queue.items[0].status, "waiting");
    TH().runner.stop();
    eq(TH().runner.state, "idle");
    eq(TH().queue.items[0].status, "pending");
  }));
  test(R, "monsters outside normal areas are blocked, not crashed", () => sandbox(() => {
    const m = list(game.monsters).find((x) => !D().areaFor(x));
    if (!m) skip("every monster has an area");
    TH().queue.add([{ kind: "combat", monsterId: m.id, targetKills: 1, rel: true, qty: 1, label: "Special" }]);
    TH().runner.start();
    eq(TH().queue.items[0].status, "blocked");
    has(TH().queue.items[0].reason, "dungeon");
  }));

  const L = "Live actions";
  const live = { live: true };
  test(L, "gathering: chops logs, finishes, and stops the action", () => sandbox(async () => {
    liveOk();
    const logs = item("melvorD:Normal_Logs");
    const before = game.bank.getQty(logs);
    TH().queue.add([E({ qty: 2 })]);
    TH().runner.start();
    ok(await waitFor(() => game.activeAction === skill("Woodcutting"), 4000), "Woodcutting never started");
    ok(await waitFor(() => TH().queue.items[0].status === "done", 30000), "never finished: " + TH().queue.items[0].status);
    ok(game.bank.getQty(logs) - before >= 2, "no logs gained");
    ok(await waitFor(() => !game.activeAction, 3000), "action still running after the queue finished");
  }), live);
  test(L, "XP goal: trains until the XP is reached", () => sandbox(async () => {
    liveOk();
    const sk = skill("Woodcutting");
    TH().queue.add([{ kind: "xp", skillId: sk.id, targetXp: Math.floor(sk.xp) + 15, qty: 1, label: "xp" }]);
    TH().runner.start();
    ok(await waitFor(() => TH().queue.items[0].status === "done", 40000), "never finished: " + TH().queue.items[0].status);
    ok(sk.xp >= Math.floor(sk.xp) , "xp");
  }), live);
  test(L, "pause stops the action and Resume continues", () => sandbox(async () => {
    liveOk();
    TH().queue.add([E({ qty: 50 })]);
    TH().runner.start();
    ok(await waitFor(() => game.activeAction === skill("Woodcutting"), 4000), "start");
    TH().runner.pause();
    ok(!game.activeAction, "still running after pause");
    eq(TH().runner.state, "paused");
    TH().runner.start();
    ok(await waitFor(() => game.activeAction === skill("Woodcutting"), 4000), "resume");
  }), live);
  test(L, "'do this first' runs that step now", () => sandbox(async () => {
    liveOk();
    TH().queue.add([{ kind: "manual", itemId: "melvorD:Feathers", qty: 999999999, label: "m", note: "" }, E({ qty: 50, label: "Chop" })]);
    TH().runner.doFirst(TH().queue.items[1].id);
    ok(await waitFor(() => game.activeAction === skill("Woodcutting"), 4000), "didn't start the chosen step");
    eq(TH().queue.items[0].status, "pending", "the manual step should keep its place");
  }), live);
  test(L, "combat steps start the fight", () => sandbox(async () => {
    liveOk();
    const m = aMonster();
    TH().queue.add([{ kind: "combat", monsterId: m.id, targetKills: 1, rel: true, qty: 1, label: "Fight" }]);
    TH().runner.start();
    const started = await waitFor(() => game.activeAction === game.combat && game.combat.selectedMonster === m, 5000);
    TH().runner.stop();
    ok(started, "combat didn't start: " + (TH().queue.items[0].reason ?? TH().runner.message));
  }), live);
  test(L, "auto-start begins the queue when something is added", () => sandbox(async () => {
    liveOk();
    TH().settings.setAutoStart(true);
    D().TS.skillId = "melvorD:Woodcutting";
    D().openTrain();
    document.querySelector(".swal2-deny").click();
    ok(await waitFor(() => TH().runner.state === "running", 4000), "didn't start: " + TH().runner.state);
  }), live);

  // =====================================================================================
  const X = "XP planner";
  test(X, "XP methods are best first and open at your level", () => {
    for (const s of list(game.skills)) {
      const c = D().xpCandidates(s);
      for (let i = 0; i < c.length; i++) {
        ok((c[i].a.level ?? 1) <= s.level, `${s.id}: ${c[i].a.id} is above your level`);
        if (i) ok(c[i - 1].rate >= c[i].rate, `${s.id}: not sorted`);
      }
      ok(D().xpCandidates(s, true).length >= c.length, `${s.id}: ignoring materials can't give fewer`);
    }
  });
  test(X, "XP task popup names the fastest method", () => {
    const sk = skill("Woodcutting");
    const h = D().xpSection(sk, sk.xp + 5000);
    has(h, "Fastest method");
    has(h, "XP/hour");
  });

  // =====================================================================================
  const T = "Train a skill";
  const plans = () => TRAINABLE.map((n) => [skill(n)]).filter(([s]) => s);
  test(T, "every supported skill has something to train", () => {
    for (const [s] of plans()) ok(D().trainCands(s).length > 0, `${s.id} has no automatic methods at level ${s.level}`);
  });
  test(T, "plans are contiguous, reach the target and take finite time", () => {
    for (const [s] of plans()) for (const add of [3, 15]) {
      const target = Math.min(99, s.level + add);
      if (target <= s.level) continue;
      const p = D().trainPlan(s, target, null);
      ok(p.batches.length > 0, `${s.id} +${add}: empty plan`);
      eq(p.batches[0].from, s.level, `${s.id} start`);
      for (let i = 1; i < p.batches.length; i++) eq(p.batches[i].from, p.batches[i - 1].to, `${s.id} gap`);
      if (p.blocked == null) { eq(p.batches[p.batches.length - 1].to, target, `${s.id} end`); ok(Number.isFinite(p.totalMs) && p.totalMs > 0, `${s.id} time`); }
      for (const b of p.batches) ok(b.c.rate > 0 && b.actions >= 1 && b.xpGain >= 0, `${s.id} batch`);
    }
  });
  test(T, "never picks a method much slower than the best one open at that level", () => {
    // the guard against farming a lot of material for little XP: at every level the chosen method is within 10% of the best
    for (const [s] of plans()) {
      const target = Math.min(99, s.level + 12);
      if (target <= s.level) continue;
      const p = D().trainPlan(s, target, null);
      for (const b of p.batches) {
        for (let l = b.from; l < b.to; l++) {
          const sim = new Map([[s.id, l]]);
          const best = D().trainCands(s, sim)[0];
          ok(best.rate <= b.c.rate * 1.1001, `${s.id} level ${l}: chose ${b.c.a.id} (${Math.round(b.c.rate)}/h) but ${best.a.id} gives ${Math.round(best.rate)}/h`);
        }
      }
    }
  });
  test(T, "a chosen method is honoured", () => {
    const s = skill("Woodcutting");
    const c = D().trainCands(s);
    const pick = c[c.length - 1];
    const p = D().trainPlan(s, Math.min(99, s.level + 3), pick.a.id);
    ok(p.batches.length === 1 && p.batches[0].c.a === pick.a, "forced method not used");
  });
  test(T, "the first batch becomes real queue steps that stop at the level", () => sandbox(() => {
    for (const [s] of plans()) {
      const target = Math.min(99, s.level + 3);
      if (target <= s.level) continue;
      const r = D().nextBatch({ id: "t", skillId: s.id, targetLevel: target, sellMade: true });
      ok(r.ok, `${s.id}: ${r.reason}`);
      const last = r.entries[r.entries.length - 1];
      eq(last.untilLevel, r.to, `${s.id} untilLevel`);
      eq(last.sellAll, true, `${s.id} sellAll on the product step`);
      ok(r.entries.slice(0, -1).every((e) => !e.untilLevel && !e.sellAll), `${s.id}: only the product step stops at the level`);
      ok(r.entries.every((e) => e.kind !== "manual" && e.parent === "t"), `${s.id}: manual step or no parent`);
      ok(r.entries.every((e) => Number.isFinite(e.qty) && e.qty >= 1), `${s.id}: bad quantity`);
    }
  }));
  test(T, "batches use the bank first", () => sandbox(() => {
    const s = skill("Smithing");
    bankStub((id) => (/_Ore$|_Bar$/.test(id ?? "") ? 9999 : 0)); // every ore and bar, so it works at any Smithing level
    const r = D().nextBatch({ id: "t", skillId: s.id, targetLevel: Math.min(99, s.level + 2) });
    ok(r.ok, r.reason);
    ok(r.entries.every((e) => e.kind !== "gather"), "still gathering ore it already has");
  }));
  test(T, "time estimate for a level goal is finite and shrinks as levels pass", () => sandbox(() => {
    const s = skill("Woodcutting");
    const e = { id: "z", kind: "train", skillId: s.id, targetLevel: Math.min(99, s.level + 10) };
    const full = D().trainEstimate(e);
    ok(full > 0 && Number.isFinite(full), "estimate " + full);
    const later = D().trainEstimate({ ...e, afterLevel: Math.min(e.targetLevel, s.level + 5) });
    ok(later < full, "later estimate should be smaller");
  }));

  const U = "Train popup";
  const setv = (id, v, type = "change") => { const e = document.getElementById(id); if (e.type === "checkbox") e.checked = v; else e.value = v; e.dispatchEvent(new Event(type, { bubbles: true })); };
  // opens the popup the way a player does (it starts on the skill page you're on), then picks the skill and goal
  const open = async (skillName, goal = "level") => {
    D().TS.goal = "level";
    D().openTrain();
    ok(await popupReady(), "popup never finished opening");
    if (document.getElementById("mst-tr-skill").value !== "melvorD:" + skillName) setv("mst-tr-skill", "melvorD:" + skillName);
    if (goal !== "level") setv("mst-tr-goal", goal);
  };
  test(U, "opens from the minibar button with a skill list and a live preview", () => sandbox(async () => {
    D().TS.goal = "level"; // the popup remembers the last goal you used
    document.getElementById("mst-train-btn").click();
    ok(await popupReady(), "popup never finished opening");
    const sel = document.getElementById("mst-tr-skill");
    ok(sel, "popup");
    ok(sel.options.length >= TRAINABLE.length, "skills listed");
    if (sel.value !== "melvorD:Woodcutting") setv("mst-tr-skill", "melvorD:Woodcutting"); // the popup starts on the skill page you are on
    has(document.getElementById("mst-tr-prev").textContent, "XP/hour");
  }));
  test(U, "level goal queues one train step", () => sandbox(async () => {
    await open("Woodcutting");
    const sk = skill("Woodcutting");
    setv("mst-tr-level", String(sk.level + 2), "input");
    document.querySelector(".swal2-deny").click();
    await sleep(100);
    eq(TH().queue.items.length, 1);
    const e = TH().queue.items[0];
    eq(e.kind, "train"); eq(e.targetLevel, sk.level + 2); eq(e.targetXp, exp.level_to_xp(sk.level + 2));
  }));
  test(U, "'sell the items it makes' is saved on the step", () => sandbox(async () => {
    await open("Woodcutting");
    setv("mst-tr-sell", true);
    document.querySelector(".swal2-deny").click();
    await sleep(100);
    eq(TH().queue.items[0].sellMade, true);
  }));
  test(U, "a level at or below yours adds nothing and says why", () => sandbox(async () => {
    captureNotices();
    await open("Woodcutting");
    setv("mst-tr-level", String(skill("Woodcutting").level), "input");
    document.querySelector(".swal2-deny").click();
    await sleep(100);
    eq(TH().queue.items.length, 0);
    ok(notes.length > 0, "no notice");
  }));
  test(U, "make mode queues the full chain and the amount, even if some is in the bank", () => sandbox(async () => {
    bankStub((id) => (id === "melvorD:Bronze_Bar" ? 100 : 0));
    await open("Smithing", "make");
    setv("mst-tr-item", "melvorD:Bronze_Bar");
    setv("mst-tr-qty", "20", "input");
    has(document.getElementById("mst-tr-prev").textContent, "Make 20 Bronze Bar");
    document.querySelector(".swal2-deny").click();
    await sleep(100);
    const bar = TH().queue.items.find((e) => e.kind === "craft");
    ok(bar, "no craft step");
    eq(bar.qty, 20, "bars to make");
  }));
  test(U, "make mode refuses recipes above your level", () => sandbox(async () => {
    const sm = skill("Smithing");
    const hard = list(sm.actions).filter((a) => a.product && a.level > sm.level)[0];
    if (!hard) skip("no locked Smithing recipe");
    captureNotices();
    await open("Smithing", "make");
    setv("mst-tr-item", hard.id);
    has(document.getElementById("mst-tr-prev").textContent, "Warning");
    document.querySelector(".swal2-deny").click();
    await sleep(100);
    eq(TH().queue.items.length, 0);
  }));
  test(U, "changing the skill rebuilds the form", () => sandbox(async () => {
    await open("Woodcutting");
    setv("mst-tr-skill", "melvorD:Mining");
    await sleep(50);
    eq(D().TS.skillId, "melvorD:Mining");
    has(document.getElementById("mst-tr-method").textContent, "Best available");
  }));
  test(U, "queued level goals expand into steps when run", () => sandbox(async () => {
    liveOk();
    const sk = skill("Woodcutting");
    TH().queue.add([{ kind: "train", skillId: sk.id, targetLevel: sk.level + 1, targetXp: exp.level_to_xp(sk.level + 1), qty: 1, label: "Train" }]);
    TH().runner.start();
    await sleep(500);
    const items = TH().queue.items;
    eq(items[items.length - 1].kind, "train", "the train step stays last");
    ok(items.length >= 2, "no steps were put above it");
    eq(items[0].untilLevel, sk.level + 1, "first step stops at the level");
  }), live);

  const XG = "XP goals";
  const xpE = (name, extra) => { const sk = skill(name); return { id: "t", kind: "xp", skillId: sk.id, targetXp: Math.floor(sk.xp ?? 0) + 3000, ...extra }; };
  test(XG, "an XP goal with no materials plans the gathering for a skill that needs logs", () => sandbox(async () => {
    const sk = skill("Firemaking");
    bankStub(() => 0);
    eq(D().xpCandidates(sk).length, 0, "bank is empty, nothing should be ready");
    const r = D().xpMaterialBatch(xpE("Firemaking"));
    ok(r.ok, r.reason);
    ok(r.entries.length > 0 && r.entries.every((x) => x.kind !== "manual"), "steps should be things the queue can do");
    ok(r.entries.some((x) => x.skillId === "melvorD:Woodcutting"), "should chop logs");
  }));
  test(XG, "a crafting skill plans the whole chain and stops at the exact XP", () => sandbox(async () => {
    const sk = skill("Smithing");
    bankStub(() => 0);
    const target = Math.floor(sk.xp ?? 0) + 5;
    const r = D().xpMaterialBatch(xpE("Smithing", { targetXp: target }));
    ok(r.ok, r.reason);
    const last = r.entries[r.entries.length - 1];
    eq(last.untilXp, target);
    ok(r.entries.some((x) => x.kind === "gather"), "should gather ore first");
  }));
  test(XG, "the popup says what it will gather first", () => sandbox(async () => {
    bankStub(() => 0);
    const sk = skill("Firemaking");
    has(D().xpSection(sk, Math.floor(sk.xp ?? 0) + 3000).replace(/<[^>]+>/g, " "), "get the materials");
  }));
  test(XG, "the runner adds the gathering above the XP step instead of stopping", () => sandbox(async () => {
    liveOk();
    const sk = skill("Firemaking");
    bankStub(() => 0);
    TH().queue.add([xpE("Firemaking", { qty: 1, label: "Firemaking XP" })]);
    TH().runner.start();
    const items = TH().queue.items;
    ok(items.length > 1, "no steps were added");
    eq(items[items.length - 1].kind, "xp");
    ok(items[0].parent, "added steps should point at the XP step");
    ok(items.every((x) => x.status !== "blocked"), "nothing should be blocked");
    TH().runner.stop();
  }), { live: true });

  const RS = "Restocking";
  const cookShrimp = () => { const sk = skill("Cooking"); const a = list(sk.actions).find((x) => x.product?.id === "melvorD:Shrimp"); return { sk, a }; };
  const shrimpEntry = (extra) => { const { sk, a } = cookShrimp(); return { id: "c1", kind: "craft", skillId: sk.id, actionId: a.id, altIndex: 0, itemId: "melvorD:Shrimp", qty: 10, startQty: 0, label: "Cooking: make Shrimp", ...extra }; };
  test(RS, "a craft that came up short asks for just the missing ingredients", () => sandbox(async () => {
    const { a } = cookShrimp();
    if (!a) skip("no Shrimp recipe");
    bankStub((id) => (id === "melvorD:Shrimp" ? 3 : 0)); // 3 cooked, the rest burned, no raw left
    stub(skill("Cooking"), "getRecipeSuccessChance", () => 100); // the burn rate has its own tests
    const r = D().restockCraft(shrimpEntry());
    ok(r.ok, r.reason);
    eq(r.remaining, 7);
    const raw = r.entries.find((x) => x.kind === "gather");
    ok(raw, "should gather the raw fish again");
    eq(raw.qty, 7);
    ok(r.entries.every((x) => x.parent === "c1"), "steps should point at the craft step");
  }));
  test(RS, "the runner adds the gathering above a craft that ran out, instead of stopping", () => sandbox(async () => {
    const { a } = cookShrimp();
    if (!a) skip("no Shrimp recipe");
    if ((game.bank.getQty(game.items.getObjectByID("melvorD:Raw_Shrimp")) ?? 0) >= 5) skip("the bank holds raw shrimp, so the craft would start");
    bankStub(() => 0); // nothing cooked yet, nothing raw to cook
    TH().queue.add([shrimpEntry({ id: undefined })]);
    TH().runner.start();
    const items = TH().queue.items;
    ok(items.length > 1, "no steps were added");
    eq(items[items.length - 1].kind, "craft");
    ok(items.every((x) => x.status !== "blocked"), "nothing should be blocked: " + items.map((x) => x.status + ":" + (x.reason ?? "")).join(" | "));
    TH().runner.stop();
  }));

  const BR = "Burn rate";
  const burnAt = (pct) => stub(skill("Cooking"), "getRecipeSuccessChance", () => pct);
  const rawShrimpIn = (rows) => rows.find((r) => r.item.id === "melvorD:Raw_Shrimp")?.qty;
  test(BR, "the burn rate is read from the game and never goes below 5%", () => sandbox(async () => {
    const { a } = cookShrimp();
    if (!a) skip("no Shrimp recipe");
    burnAt(50); eq(D().succ(skill("Cooking"), a), 0.5);
    burnAt(100); eq(D().succ(skill("Cooking"), a), 1);
    burnAt(0.1); eq(D().succ(skill("Cooking"), a), 0.05);
    eq(D().succ(skill("Woodcutting"), list(skill("Woodcutting").actions)[0]), 1, "skills that never fail");
  }));
  test(BR, "a task breakdown asks for extra raw food to cover the burnt ones", () => sandbox(async () => {
    const { a } = cookShrimp();
    if (!a) skip("no Shrimp recipe");
    const shrimp = game.items.getObjectByID("melvorD:Shrimp");
    bankStub(() => 0);
    burnAt(100);
    const none = rawShrimpIn(D().buildRows(shrimp, 10, true));
    burnAt(50);
    const half = rawShrimpIn(D().buildRows(shrimp, 10, true));
    eq(none, 10); eq(half, 20);
  }));
  test(BR, "a restock after burning counts the burn rate too", () => sandbox(async () => {
    const { a } = cookShrimp();
    if (!a) skip("no Shrimp recipe");
    bankStub((id) => (id === "melvorD:Shrimp" ? 3 : 0));
    burnAt(50);
    const r = D().restockCraft(shrimpEntry());
    eq(r.remaining, 7);
    eq(r.entries.find((x) => x.kind === "gather").qty, 14);
  }));
  test(BR, "cooking is ranked and timed by what survives the pan", () => sandbox(async () => {
    const { sk, a } = cookShrimp();
    if (!a) skip("no Shrimp recipe");
    burnAt(100);
    const full = D().xpCandidates(sk, true).find((c) => c.a === a)?.rate;
    burnAt(50);
    const half = D().xpCandidates(sk, true).find((c) => c.a === a)?.rate;
    ok(full > 0 && Math.abs(half - full / 2) < 1, `expected half the XP/hour, got ${half} vs ${full}`);
    bankStub(() => 0);
    const e = { kind: "craft", skillId: sk.id, actionId: a.id, itemId: "melvorD:Shrimp", qty: 10, startQty: 0, altIndex: 0 };
    const slow = D().estimateMs(e);
    burnAt(100);
    ok(slow > D().estimateMs(e) * 1.9, "burning half should roughly double the time");
  }));

  const LA = "Lookahead and mastery";
  test(LA, "when a better method is held back by another skill's level, it trains that skill first", () => sandbox(async () => {
    const sm = skill("Smithing"), mi = skill("Mining");
    if (sm.level < 10) skip("Smithing is below 10, so iron isn't open");
    stub(mi, "level", 1); // only copper and tin can be mined, iron needs more
    const to = Math.min(99, sm.level + 15);
    const dt = D().bestDetour(sm, to);
    ok(dt, "no detour found with Mining at 1");
    eq(dt.skill.id, mi.id);
    ok(dt.level > 1 && dt.saveMs > 0, "the detour should save time");
    ok(dt.T1 < dt.T0, "total with the detour should be shorter");
  }));
  test(LA, "the train step adds the other skill's training above itself", () => sandbox(async () => {
    const sm = skill("Smithing"), mi = skill("Mining");
    if (sm.level < 10) skip("Smithing is below 10, so iron isn't open");
    stub(mi, "level", 1);
    const to = Math.min(99, sm.level + 15);
    const nb = D().nextBatch({ id: "tt", skillId: sm.id, targetLevel: to, targetXp: exp.level_to_xp(to) });
    ok(nb.ok && nb.detour, "expected a detour batch");
    eq(nb.entries.length, 1);
    eq(nb.entries[0].kind, "train"); eq(nb.entries[0].skillId, mi.id); eq(nb.entries[0].noDetour, true); eq(nb.entries[0].parent, "tt");
  }));
  test(LA, "no detour is suggested when nothing is held back", () => sandbox(async () => {
    const wc = skill("Woodcutting");
    eq(D().bestDetour(wc, Math.min(99, wc.level + 20)), null);
  }));
  test(LA, "Prefer mastery XP adds mastery XP to the ranking and is off by default", () => sandbox(async () => {
    const sm = skill("Smithing");
    eq(TH().settings.preferMastery(), false);
    const off = D().trainCands(sm);
    ok(off.length > 0, "no methods");
    ok(off.every((c) => c.mast === 0 && c.score === c.rate), "off should rank by skill XP only");
    TH().settings.set("preferMastery", true);
    const on = D().trainCands(sm);
    ok(on.some((c) => c.mast > 0), "no method gave mastery XP");
    ok(on.every((c) => c.score >= c.rate), "mastery XP can only add to the score");
    ok(on.every((c, i) => i === 0 || on[i - 1].score >= c.score), "sorted by score");
  }));
  test(LA, "the train popup has the mastery switch and it changes the setting", () => sandbox(async () => {
    D().TS.goal = "level";
    D().openTrain();
    ok(await popupReady(), "popup never finished opening");
    if (document.getElementById("mst-tr-skill").value !== "melvorD:Woodcutting") setv("mst-tr-skill", "melvorD:Woodcutting");
    const cb = document.getElementById("mst-tr-mastery");
    ok(cb, "mastery switch missing");
    eq(cb.checked, false);
    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
    eq(TH().settings.preferMastery(), true);
  }));
  const run = async (opts = {}) => {
    const { live = true, group = null, only = null } = opts;
    const results = [];
    const t0 = Date.now();
    for (const t of TESTS) {
      if (group && t.group !== group) continue;
      if (only && !only.test(t.name)) continue;
      const r = { group: t.group, name: t.name, status: "pass", ms: 0, note: "" };
      const s = Date.now();
      if (t.live && !live) { r.status = "skip"; r.note = "live tests off"; }
      else {
        try { await t.fn(); }
        catch (e) { if (e instanceof Skip) { r.status = "skip"; r.note = e.message; } else { r.status = "FAIL"; r.note = e.message; console.error(`[ST test] ${t.group}: ${t.name}`, e); } }
      }
      r.ms = Date.now() - s;
      results.push(r);
    }
    const count = (s) => results.filter((r) => r.status === s).length;
    const summary = { version: TH()?.version, passed: count("pass"), failed: count("FAIL"), skipped: count("skip"), total: results.length, seconds: Math.round((Date.now() - t0) / 100) / 10 };
    const unknown = window.__tthUnknownGoals ?? [];
    console.table(results.filter((r) => r.status !== "pass").map((r) => ({ group: r.group, test: r.name, result: r.status, note: r.note })));
    console.log(`%cSkill Trainer ${summary.version}: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped (${summary.seconds}s)`, `font-weight:bold;color:${summary.failed ? "#e0505c" : "#30c78d"}`);
    if (unknown.length) console.log("Task goal types without a play button (check after game updates):", unknown.join(", "));
    return { summary, results, unsupportedGoalTypes: unknown };
  };
  window.STTests = { run, tests: TESTS.map((t) => `${t.group}: ${t.name}`) };
  console.log(`STTests loaded (${TESTS.length} tests). Run: await STTests.run()`);
})();
