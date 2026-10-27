# Tests

The suite runs inside Melvor Idle, against the real game, so it catches both bugs in the mod and things a game update moved.

## Run it

1. Open the game, load a character (a test save is best), and keep the tab in front.
2. Open the browser console (F12) and load the tests straight from GitHub:

```js
(0,eval)(await fetch("https://raw.githubusercontent.com/Druidperson/Skill-Trainer/main/tests/skill-trainer.tests.js").then(r => r.text()));
await STTests.run();
```

| Option | What it does |
| --- | --- |
| `STTests.run({ live: false })` | Skips the tests that start real game actions. |
| `STTests.run({ group: "Queue" })` | One group only. |
| `STTests.run({ only: /mastery/i })` | Tests whose name matches. |

## What it covers

| Group | What is checked |
| --- | --- |
| Game contract | The game objects and methods the mod depends on, and the XP table. Start here after a game update. |
| Install | Version, minibar buttons, the panel opening and closing. |
| Queue | Add, remove, move, move to top, insert, clear, saving per character, the badge. |
| Auto-sell, Settings, Panel, Runner | Selling extras, the settings, step rows, blocked and manual steps. |
| Live actions | Gathering, XP goals, pause and resume. These start real actions for a few seconds. |
| Train a skill, Train popup | Plans reach the target, the chosen method is never much slower than the best, batches become real steps, the bank is used first, the popup. |
| XP goals, Restocking, Burn rate, Lookahead and mastery | Gathering ahead of an XP step, restocking a short craft, cooking burn rate, training another skill first, Prefer mastery XP. |

Hidden or background tabs pause the game, so the live tests skip when the tab isn't in front.
