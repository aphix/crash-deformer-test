# Derby AI

How the demolition-derby drivers fight, what the aggression slider means for them, the count-out
rules, and how the field is validated. Code: `src/game/derby-ai.ts` (`DerbyBrain`, `DERBY_RULES`),
`src/game/derby.ts` (`DerbyMatch`), `src/game/derby-arena.ts` (bowl, `derbyRadius`, `WinnerSpot`),
`src/game/ai-aggression.ts` (shared with race mode). Tests: `derby-ai.test.ts`, `derby.test.ts`.

Sources: `.extraResearch/perplexity/40-derby-driver-techniques.md`, `41-derby-rules-door-timer.md`,
`50-derby-elimination-rules.md` (lane/calib-defaults).

## What real drivers do (and what the brain copies)

| Real technique | Brain |
|---|---|
| Hit with the rear "as much as possible": the engine and radiator live in the nose | The tail is the default bumper (`MODE_REV`); the nose only for a driver spoiling for it (mood > 0.35 + 0.4·`reverse`, nose < 30 % spent) or once the tail is the worse end |
| Aim at the front wheels, front corners and radiator | Reverse aim: its front wheel/radiator on our side, down a lane out from its nose so the run-in straightens square on (the block is pushed back only by along-car travel) |
| J-turn / handbrake to swing round and line up a rear hit | Nose toward a target > 6 m away while rolling > 5 m/s: handbrake + 0.85 lock (`jturn`, yaw stays under 5 rad/s) |
| Handbrake swing of the tail into a passing car's front | A nose level with our rear wheel, 0.9–3.2 m beside, pointing at us: handbrake, steer away, the tail whips in (`swing`, 0.45 s) |
| Sideswipes / glancing hits while passing to keep momentum | A car alongside (1.7–4.2 m), passing at > 2 m/s: steer into it at 0.8 throttle (`sideswipe`, 0.4 s) |
| No hits on the driver's door (disqualification in every rule book) | The driver's door is the steering-wheel side (local −x). Sideswipes skip a car whose door is the side we'd rub; reverse and nose aims go for the bumper corner on that side, clear of the door |
| Head-ons are banned | The nose never takes a head-on: in a car's front cone it swings out to the flank |
| Use the walls; don't get pinned | `boards`: bend onto the tangent before the wall, J-turn off it when nosed in; never back into the boards |
| Sandbag early, let others soften each other up — inside the hit clock | Mood ≤ 0 with three or more rivals left: lay back (keep rolling, away from anyone within ~10 m) until half the hit clock is gone (`0.5 − 0.3·a` of it) |
| Finish off smoking, weakened cars | Target cost subtracts 2·mood, which carries both cars' damage; a car past 75 % damage draws hunters at 0.3× the dogpile penalty |
| Final cars fight | With two or fewer rivals left nobody lays back; circling without closing in (> 1.2 s) takes the hit on whatever end is there |

E-brake turns *into opponent fronts* did not exist before this lane: the old brain used the handbrake
only to tighten a hunting turn (`ae > 1 && speed > 9`) and on the boards, and no test covered it.

## Aggression (shared with race mode)

`ai-aggression.ts` (RaceLead owns it): the slider is a maximum; each driver rolls
`fieldAggression(max, seed, id)` uniform in [0, max] per match. `mood(a, self, other)` > 0 means
"go for it": 0 never attacks, 0.5 attacks only a car more wrecked than itself, 1 attacks regardless.

Derby use: aggression 0 lays back for ever (and will be counted out); mood ≤ 0 lays back while three or
more rivals remain, until the hit clock is half gone; otherwise it attacks with the tactics above.
Low aggression also raises the dogpile penalty (`1.2 + 1.8·(1 − a)` per hunter). The derby default slider
is `DEFAULT_DERBY_AGGRESSION = 1` (the whole spread, sandbaggers to brawlers; race defaults to 0.35).
`DerbyMatch.begin(cars, { aggression, seed })` takes the slider; with no seed every match rolls anew.

## Rules (`DERBY_RULES`, one place to tune)

- Hit clock 60 s: an aggressive hit (≥ 2 m/s into a live car; pushing doesn't count) at least every
  60 s or the car is counted out (the common rule-book clock; some use 90 s or 2 min).
- Still clock 60 s: a car that hasn't got 2 m from where it stopped in 60 s is out.
- Heat time limit `heatLimit(n)` = max(90 s, 30 s a car) (10 cars: 5 min); then the top score among the
  running cars wins, shown as "Time! / Winner on points". Last car standing shows "Last engine still
  running" (wreck) or "the rest counted out" (count-out). The board shows each car's count-out clock.
- Counted-out cars take no input and read as dead to every driver.

## Scoring

One point per aggressive hit (the hit clock's definition: ≥ 2 m/s into a live car), at most one per pair
every 2 s, plus 3 for the last hit before an engine dies. Pushes and grinding don't score. A 10-car heat
reads single digits to low teens; the score only matters when the time limit decides the heat.

## Bowl size

`derbyRadius(n)`: 16.4 m up to 12 cars, then wide enough that tangent neighbours on the spawn ring keep
5.64 m (car + 1.2 m) — 32 cars ≈ 34 m. The engine scales the arena group, the AI and the wall clip to it.

## Validation (10 cars, default slider, real stack, headless)

`derby-ai.test.ts` runs the engine's derby step path (dressed as `dressCar` at the game defaults,
`INITIAL_HUD` and killTravel(class, `HANDLING.realism`)) to the end of the heat. CI runs seeds 1,2;
`DERBY_SEEDS=1,2,3,4,5` for the full set. Asserted per seed: a winner by the heat time limit; no
AI-made spin (> 5 rad/s for 0.2 s with no car contact in the 0.5 s before it was flagged) in the first
2 min; no zip (3·v·h + 5 cm); AI impacts (≥ 3 m/s closing) > 40 % rear-first and > 1.2× the nose-first.
Todo, owned by CrashRealism7: contact-induced spins (5–9 rad/s in pair contact, a physics artifact) and
≥ 4/5 heats won by wrecking (`DERBY_KILL_SCALE`, then this todo becomes the assertion).

Main 319fbf1 (realistic crush defaults), 5 seeds, heat limit 300 s:

| Seed | Decided | Physics deaths (s) | Count-outs | Spins (contact / free) | Zips | Impacts F/R/S (rear %) | Swings / J-turns / sideswipes |
|---|---|---|---|---|---|---|---|
| 1 | count-out, c7 at 283.6 s | 36.2, 41.5, 80.3, 80.6, 105.1, 169.8, 190.6, 190.6 | c9 | 11 / 0 | 0 | 58 / 166 / 50 (61) | 25 / 134 / 79 |
| 2 | time, c8 at 300 s | 32.2, 118.2 | 0 | 3 / 0 | 0 | 44 / 88 / 28 (55) | 5 / 88 / 31 |
| 3 | time, c7 at 300 s | 58.7, 59.6, 86.2 | 0 | 1 / 0 | 0 | 25 / 98 / 28 (65) | 4 / 104 / 10 |
| 4 | wreck, c6 at 284.7 s | 36.6, 40.2, 43.5, 76, 165.5, 216.5, 216.5, 262.9, 284.7 | 0 | 7 / 0 | 0 | 47 / 126 / 41 (59) | 20 / 262 / 76 |
| 5 | time, c4 at 300 s | 35.3, 48.4, 56.9, 82.2, 181, 245.1 | 0 | 5 / 0 | 0 | 53 / 104 / 31 (55) | 13 / 157 / 57 |

Baseline (old brain, main 7be2ad2, 90 s): 5/5 stalemate, 0–3 deaths, 6–11 spins, rear-first 16–25 %.
