# Changelog

## 1.3.0
- Skill Trainer is part of Action Queue now (2.0.0 and later). This version doesn't do anything except tell you to uninstall it, so it can't clash with the new Action Queue.

## 1.2.0
- Skill Trainer is now where everything about training lives: how to start each skill, what's safe, how to plan a goal, Farming, combat, Agility building, Slayer tasks and dig site maps. Action Queue only runs the queue, so it needs Skill Trainer to run training steps.
- The "Prefer mastery XP" setting moved here from Action Queue.
- Alt Magic can use Just Learning and Item Alchemy. They're cast on something the queue can gather or make, like arrowtips or bars, and Alchemy goes for the item that makes the most GP. Your other bank items are never used.
- When nothing can be trained, the message says which material is missing, like Nature Runes before you can craft them.
- Fixed: Alt Magic goals asked you to equip a magic weapon.
- Farming harvests a crop that's already grown before it offers compost.

## 1.1.0
- Skill Trainer now needs the Action Queue mod. The queue, its panel and settings moved there, so Skill Trainer and Township Task Helper share one queue instead of each having their own. Install both.
- Feathers, compost and Summoning shards can come from the shop. The queue asks you before every purchase.
- Slayer goals with no task ask before rolling one, and show how many of its monsters are safe for you.
- Archaeology goals with no map offer to make one and pick your tools.
- Attack, Strength, Ranged and Magic switch to an equipment set with the right weapon, and back when done. If you have none, the queue waits for you to equip one.
- Prayer buries your cheapest bones when you run out of points.
- Farming uses compost you own and offers to buy some, and the queue works on other steps while crops grow.
- Cartography can train by surveying the map around you.
- Fixed: a Farming goal could stop when your seeds only just covered the batch.
- Saved queues from 1.0.0 don't carry over.

## 1.0.0
- First release. Skill Trainer is the Train a skill window from Township Task Helper, now its own mod that works without Township tasks.
- Train to a level or make an amount of an item, for Woodcutting, Mining, Fishing, Cooking, Smithing, Fletching, Crafting, Runecrafting, Herblore, Firemaking, Thieving, Summoning, Astrology, Magic (Alt Magic) and Harvesting.
- Thieving only runs when it's safe while you're away, and stops if your food runs out.
- Combat skills: Attack, Strength, Defence, Hitpoints, Ranged, Magic, Prayer and Slayer. It only picks fights that are safe while you're away, sets the right attack style for each step and puts yours back after.
- Uses what's in your bank for things the queue can't get itself, like Summoning shards and feathers.
- Agility course builder: fills empty slots with the obstacle that gives the most XP, after you confirm each one. Agility goals build first, and the Train window has a Build my course button.
- Farming plants, waits and harvests with your own seeds and plots. Agility runs your course, Cartography makes paper and Archaeology digs where you have a map.
- Looks ahead across skills, counts burnt food, restocks when a craft runs short, and has a Prefer mastery XP setting.
- Has its own queue, panel and settings, so it runs next to Township Task Helper without sharing a queue.
