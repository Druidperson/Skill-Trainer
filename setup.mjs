// Skill Trainer is part of Action Queue now (2.0.0 and later). This last version does nothing except say so, so it can't clash with it.
export function setup(ctx) {
  const VERSION = "1.3.0", NAME = "Skill Trainer";
  const ready = () => typeof game !== "undefined" && typeof SwalLocale !== "undefined" && document.getElementById("skill-footer-minibar");
  const tell = () => {
    let aq = null;
    try { aq = (typeof mod !== "undefined" && mod?.api?.actionQueue) || window.actionQueue; } catch (e) { /* not there */ }
    const major = Number(String(aq?.version ?? "0").split(".")[0]);
    const msg = major >= 2
      ? `${NAME} is part of Action Queue now, so this mod doesn't do anything anymore. Uninstall it from the Mod Manager.`
      : `${NAME} is part of Action Queue now. Update Action Queue to 2.0.0 or later and uninstall this mod from the Mod Manager.`;
    console.warn(`[${NAME}]`, VERSION, msg);
    try { SwalLocale.fire({ title: NAME, html: msg, icon: "info" }); } catch (e) { /* the console has it */ }
  };
  // wait until the game is fully loaded and give Action Queue a moment, so the popup never gets in the way of loading
  const timer = setInterval(() => { if (ready()) { clearInterval(timer); setTimeout(tell, 8000); } }, 1000);
}
