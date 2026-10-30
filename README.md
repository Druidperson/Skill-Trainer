![Skill Trainer](assets/banner.png)

# Skill Trainer

Pick a skill, say how far you want to take it, and walk away. Skill Trainer works out the quickest way there, gathers the materials, crafts what it needs and keeps going until you hit your goal.

## You need Action Queue

Skill Trainer needs the [Action Queue](https://github.com/Druidperson/Action-Queue) mod to work. Skill Trainer plans the training and Action Queue holds the queue the steps run in. Install both from the Mod Manager. If Action Queue is missing, Skill Trainer tells you when the game loads and doesn't add its button.

## Getting started

Open the bottom-right menu and press the chart button. Choose a skill, then choose what you're after:

- A level, like Smithing 40
- An amount of an item, like 500 Bronze Bars

Add it to the queue and press Start. The queue itself is the Action Queue list button right next to it.

## Make an item

Name an item and an amount. Make 500 Bronze Bars and the queue mines the ore, smelts it and stops at 500. If you already have some of the ore in your bank, it uses that first.

Some recipes need things the queue can't gather or craft. Feathers, compost and shards come from the shop, and you're asked before every purchase unless you turn on auto-buy in Action Queue's settings. Herbs and monster drops show up as a step for you to do yourself. The queue waits there until you have them, then carries on.

## Skills it can train

Woodcutting, Mining, Fishing, Cooking, Smithing, Fletching, Crafting, Runecrafting, Herblore, Firemaking, Thieving, Summoning, Astrology, Magic, Agility, Farming, Cartography, Archaeology and Harvesting, plus the combat skills: Attack, Strength, Defence, Hitpoints, Ranged, Prayer and Slayer. Township isn't here, since it trains through Township itself.

- Firemaking, Thieving and Astrology don't make anything you'd ask for, so they only take level goals. Firemaking cuts the logs it needs first.
- Thieving can hurt you when a pickpocket fails, so the queue only thieves when it's safe while you're away. That means food equipped and auto eat set to start above the target's biggest hit. If your food runs out, the queue stops.
- Summoning shards come from the shop. The queue uses the ones in your bank first and asks before buying more.
- Magic trains with Alt Magic, using your runes. Superheat turns ores into bars, and Just Learning and Item Alchemy are cast on something the queue can gather or make, like arrowtips or bars. Alchemy goes for the item that makes the most GP. Your other bank items are never used.
- Harvesting shows up once the Abyssal realm is unlocked.
- Farming plants on the plots you've unlocked with seeds you own, waits for the crops and harvests them. Compost you own goes on the plots first, and a Farming goal offers to buy some so every crop grows. While crops grow, the queue works on other steps. Herbs for Herblore can come from Farming once you've unlocked Herb plots.
- Agility runs the course you've built, and can build it for you too. See below.
- Cartography trains by making paper from logs, or by surveying the map around where you stand.
- Archaeology digs at sites where you have a map with charges. With no map, the goal offers to make one first and picks your tools for you.

## Agility course builder

Pick Agility in the Train window and it shows which empty slots it can fill, with a Build my course button. An Agility goal fills them first too, before it runs the course.

- For each empty slot you've unlocked, it picks the obstacle with the most XP per second that you meet the requirements for and that has no negative bonus.
- Nothing gets built until you say so. When the queue reaches a build step, a window shows the obstacle, its cost and its bonuses, and the queue waits for you to press Build or Skip. A slot you skip stays empty for that goal.
- If an obstacle needs items, like logs, the queue gathers them first. GP has to be in your bank already.
- It never replaces an obstacle you've built.

## Combat

Combat skills train by fighting, with the gear you have on. The queue picks the fight with the best XP per hour that's safe while you're away. Safe means you have food equipped, auto eat starts above the monster's biggest hit (special attacks and the combat triangle included), and the monster can't take half your HP in one hit. If your food gets low, the queue stops before it runs out.

- It sets the attack style that trains your skill, like Slash for Strength, and puts your own style back when the step ends.
- Attack and Strength need a melee weapon, Ranged needs a bow and ammo, and Magic needs a magic weapon and a combat spell selected. If one of your other equipment sets has the right weapon, the queue switches to it and back when the goal is done. If not, it waits for you to equip one. Defence, Hitpoints, Prayer and Slayer work with whatever you have on.
- Prayer turns on your best prayer for the fight. When you run out of prayer points, it buries the cheapest bones in your bank.
- Slayer fights in Slayer areas you can enter, or on your Slayer task. With no task, it asks before rolling one and tells you how many of that tier's monsters are safe for you.
- If you start a fight yourself while the queue is running, it pauses and leaves your fight alone.

## Reach a level

Aim for a level and it works out the best method for each stretch of the climb. It counts everything a method takes, materials included, so you never end up farming ore for hours to earn a few points of XP. It only switches methods when a clearly better one opens up, so the plan doesn't turn into lots of tiny steps.

If a better method is held back by another skill, like iron bars needing Mining, it checks whether training that skill first gets you there sooner and does it when it does.

## Plans for burnt food

Cooking burns food, so the queue gathers extra raw food to cover it. If a craft runs short anyway, the queue goes back, gathers what's missing and carries on.

## Prefer mastery XP

Turn this on in the mod settings or in the Train window and the planner counts mastery XP next to skill XP. It also sticks with a method longer so its mastery keeps growing. It's off by default.

## Bugs and ideas

Found a bug or have an idea? Open an issue. For a bug, say which skill and goal you picked and what you expected to see.

## License

MIT, see [LICENSE](LICENSE).
