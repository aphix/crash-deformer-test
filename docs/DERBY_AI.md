# Derby AI

How the demolition-derby drivers fight, what the aggression slider means for them, the count-out
rules, and how the field is validated. Code: `src/game/ai/derby-ai.ts` (`DerbyBrain`, `DERBY_RULES`),
`src/game/match/derby.ts` (`DerbyMatch`), `src/game/scenes/derby-arena.ts` (bowl, `derbyRadius`, `WinnerSpot`),
`src/game/ai/ai-aggression.ts` (shared with race mode). Tests: `derby-ai.test.ts`, `derby.test.ts`.

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

One point per hard hit (`SCORE_SPEED` 4 m/s into a live car), at most one per pair every `SCORE_GAP` 6 s,
plus `DISABLE_POINTS` 2 for the last hit before an engine dies. Softer aggressive hits (≥ 2 m/s) still reset
the hit clock but don't score; pushes and grinding do neither. Headless, 10 cars, seeds 1–3: tops 10–13 and
medians 4–6 at 2 min (the earlier 2 m/s / 2 s rule read 15–21). The score only matters when the time limit
decides the heat.

## Bowl size

`derbyRadius(n)`: 16.4 m up to 12 cars, then wide enough that tangent neighbours on the spawn ring keep
5.64 m (car + 1.2 m) — 32 cars ≈ 34 m. The engine scales the arena group, the AI and the wall clip to it.

## Validation (10 cars, default slider, real stack, headless)

`derby-ai.test.ts` runs the engine's derby step path (dressed as `dressCar` at the game defaults,
`INITIAL_HUD` and killTravel(class, `HANDLING.realism`, "derby")) to the end of the heat. CI runs seeds 1,2;
`DERBY_SEEDS=1,2,3,4,5` for the full set. Asserted per seed: a winner by the heat time limit; no
AI-made spin (> 5 rad/s for 0.2 s with no car contact in the 0.5 s before it was flagged) in the first
2 min; no zip (3·v·h + 5 cm); AI impacts (≥ 3 m/s closing) > 40 % rear-first and > 1.2× the nose-first.
Todo, owned by CrashRealism8: contact-induced spins (5–9 rad/s in pair contact, a physics artifact) and
≥ 4/5 heats won by wrecking within 300 s with no death before 8 s.

Main 3aa4301 (realistic defaults, `DERBY_KILL_SCALE` 0.5), 5 seeds, heat limit 300 s:

| Seed | Decided | Physics deaths (s) | Count-outs | Spins (contact / free) | Zips | Impacts F/R/S |
|---|---|---|---|---|---|---|
| 1 | wreck, c7 at 72.6 s | 5.9, 15.3, 20.9, 21.2, 25.9, 26.5, 52, 65, 72.6 | 0 | 3 / 0 | 0 | 36 / 46 / 14 |
| 2 | time, c2 at 300 s | 30.8, 48.8, 49, 53.5, 83.4, 204.3, 258.7 | 1 | 0 / 0 | 0 | 30 / 89 / 14 |
| 3 | time, c5 at 300 s | 27.7, 32, 39.2, 45.5, 204.4, 297.3 | 0 | 1 / 0 | 0 | 20 / 59 / 10 |
| 4 | count-out, c1 at 176.2 s | 16.4, 45.2, 52, 52.6, 62.5, 70, 100.4, 118.7 | 1 | 0 / 0 | 0 | 44 / 77 / 24 |
| 5 | wreck, c9 at 112.4 s | 9.2, 12.5, 16.4, 18.3, 41.9, 51.4, 77.1, 94.5, 112.4 | 0 | 5 / 0 | 0 | 14 / 54 / 15 |

Live (real app, 10 cars, main 1d3712f + this scoring): over 120 s of sim time, tracked on the derby clock
with a neighbour-speed allowance, 0 zips and 0 spins; the board at 120 s read 3–14 and at 24 cars
(25 s) 0–7, with no horizontal overflow and the clocks fitting. Winner spotlight cost (GPU timer queries,
RTX 4080 via ANGLE/D3D12, 1280×800, 144 frames per config interleaved, loaded box): spot + glow vs none
+0.02 ms at the 25th percentile, +0.17 ms median; the spread (IQR ~1 ms) is wider than the 0.2 ms budget,
so that is the resolution of this measurement.

Baseline (old brain, main 7be2ad2, 90 s): 5/5 stalemate, 0–3 deaths, 6–11 spins, rear-first 16–25 %.
