# Rapier evaluation

Should the game use Rapier (`@dimforge/rapier3d-compat`, the wasm core under react-three-rapier) for world physics, collision triggering, events, instancing or wheel contact?
Owner constraint: the mesh-deformation code (cages, shape matching, streamed deform) stays ours.
Owner directive (2026-10-02): Rapier comes in anyway with the Ragdoll lane's cosmetic driver ejection, so use it anywhere a minimal change on our side saves or improves performance, even a little.
**Owner decision (after these measurements): the module is `@dimforge/rapier3d-compat@0.19.3`.** Only the ragdoll adopts Rapier, so 0.19.3's flat per-step allocation, half-size download and faster start-up win, and nothing uses snapshots (the one thing 0.21.0 does better).
The candidates below were measured on 0.21.0, the base module at the time; none of them wins on 0.19.3 either.
The [adoption candidates](#adoption-candidates-ranked) table ranks every proposal from the lanes.
Code was measured at main 38fe41c; file names below are basenames, now in W11's context folders (for example `engine/world-step.ts`, `contact/sat.ts`, `world/track.ts`).

Everything below was measured in a throwaway prototype that is **not in this repo**: a scratch npm project `rapier-proto/` next to the worktrees, which imports the game's own TypeScript (main 38fe41c) by path.
Paths in the tables are relative to that directory; each result file is kept beside its script.

Machine: WSL2 on an i9-13900HX (14 vCPU), Node 24.15, headless Chromium 1228.
Other lanes were running at the same time (load average 22–27), so timings are medians over repeated runs and only differences of 1.5× or more are read as real.
Rapier builds: 0.21.0 compat (the base module), 0.21.0 `rapier3d-deterministic-compat`, and 0.19.3 compat (the Ragdoll lane's first pick) for comparison.

## Verdicts

| Area | Verdict | Numbers (measured) | Integration cost | Risk |
|---|---|---|---|---|
| 1. Wheel contact (ramp, banks) | **Reject.** Keep our car. WheelGround's fix (roll sign) passes the ramp and the bank 21/21 with no creep. | Main fails the owner's ramp on the side headings: roll error 2θ (20/40/60°), gaps −27/+23, −55/+40, −80/+48 cm. On the stunt bank it fails 9/9 (roll error 32–36°, gaps −50/+37 cm). WheelGround's fix: 21/21, gaps ≤ 1.1 cm, error 0.00°, slide 0. Rapier's raycast vehicle passes 12/12 + 9/9 (worst pitch/roll error 0.83° at 30°), but creeps: 2.4–13 cm in 3 s and 6–30 cm in 10 s, still moving at 0.04–0.06 m/s. The r3f demo's joint car fails (0.51–0.66 m slide at 20°, tumbles at 30° up). | Replace `car.ts` `integrate` (driven branch) and `car-drive.ts` `applyDrive` velocity writes with a Rapier body, then rebuild the arcade layer on top (top speed, drift assist, speed-sensitive lock, ABS, self-righting, per-axle grip), plus the hand-off to the deform code on a crash. | High: handling feel (no held drift: peak slip 13–14° against our 53°), slope creep, netplay state now partly inside wasm. |
| 2. Collision triggering, events | **Reject.** Our pair culls are cheaper than any Rapier route that misses no hit, at every car count the game allows. | Ours (pre-pass + SAT pair loops, per frame): oval 0.025 / 0.243 ms at 10 / 32 cars; derby 0.597 / 2.80 ms, of which 1.89 ms is hit resolution that stays either way. The most detection could save: oval 0.026 / 0.198, derby 0.124 / 0.811 ms. The cheapest zero-miss Rapier route costs oval 0.174 / 0.724, derby 0.451 / 2.354 ms. Without a margin Rapier misses 49–1250 real hit pairs per 30 s run. Updating the deforming hulls alone costs 0.12–1.29 ms per frame. | `world-step.ts` `stepWorld` pair-loop headers (lines 82–90, 121–124) and the `satCars` cull (`sat.ts` 211–215): 18 lines out, about 70 in, plus car lifecycle (spawn, respawn, dispose). | Missed hits (correctness, not only cost); a margin tuned per scene; 150–515 KB of JS garbage per frame. |
| 3. World physics (props, debris, barrier, balls, poles, track) | **Reject**, item by item. Rapier would only detect; every response stays ours. | Per frame at 10 / 32 cars, ours vs Rapier: race walls + props 0.059 / 0.286 vs 0.519 / 1.505 ms; ground queries 0.060 / 0.201 vs 0.926 / 6.328; loose parts + debris 0.037 / 0.393 vs 0.842 / 4.89; ramp balls 0.447 / 1.163 vs 1.848 / 3.267; lamp poles 0.467 / 0.873 vs 0.464 / 1.545; jersey slab detection 0.642 / 1.215 vs 0.863 / 1.55; derby bowl 0.038 / 0.089 vs 0.539 / 1.587. 0.21.0 allocates 0.31 KB of JS heap per collider per step. | Detection lines only: about 60 of `RaceField.wall`/`props`, 77 of `TrackGround`'s queries (with about 58 builder lines added), 30 of `stepLoose`/`stepLooseParts`, about 20 of `DebrisSystem.update`, and 10–62 per prop. | A course-sized 0.21.0 world collects garbage every few frames; heightfield rays miss on exact grid vertices; a heightfield cannot hold a bridge deck. |
| 4. Costs | **0.19.3** (owner decision). Against 0.21.0 it is half the bytes, a third of the start-up, 1.5–2× faster per step, with flat per-step garbage; its snapshots do not round-trip, and nothing uses them. | Lazy chunk 2183 KB raw / 810 KB gzip / 600 KB brotli (0.21.0: 4232 / 1605 / 1167). The VPS serves JS **uncompressed** today (current initial JS 1.19 MB). Cold start in Chromium 59 ms desktop, 183 ms at 4× CPU throttle (0.21.0: 212 / 580 ms). Garbage per step: a flat 0.56 KB (0.21.0: 0.31 KB per collider). Run-to-run digests bit-identical in every build; the snapshot round-trip diverges in 0.19.3 and matches in 0.21.0. | Ragdoll's loader. | Download size and start-up on mobile: start the import at scene load. |
| 5. Instancing | **Not a physics feature.** | Rapier has none; react-three-rapier's `InstancedRigidBodies` copies body poses into a three `InstancedMesh`. The game already instances wheels, props, fx, pistons and arena walls. | — | — |
| 6. Shared world with Ragdoll | **Keep the ragdoll world separate** and cosmetic. | Ragdolls touching 60 gameplay props change the props' digest, even with the ragdolls in a lower dominance group; ragdolls out of contact leave it bit-identical. | — | A shared world would make netplay/replay digests depend on local cosmetic bodies. |

## Adoption candidates (ranked)

Every proposal from the lanes and the coordinator's own list, measured A/B on 0.21.0: our code in place against the Rapier replacement, per 60 Hz frame (all slices) at 10 and 32 cars.
"Ours" is only the part Rapier would replace; the response code stays ours in every row.
Ranked by how close Rapier comes to winning at 32 cars.

| # | Candidate (proposed by) | Verdict | Ours 10 / 32 cars | Rapier 10 / 32 cars | Rapier JS garbage | Lines ours deleted | Feeds the sim? Determinism | Owning lane, functions |
|---|---|---|---|---|---|---|---|---|
| 0 | Ragdoll driver ejection (owner) | **Adopt**: the owner's decision; cosmetic | — (new feature) | 11 dynamic + 32 kinematic bodies: 40–68 µs per 1/60 s step on 0.19.3 (81–106 on 0.21.0) | 0.19.3: a flat 0.56 KB per step | 0 | No: a separate, local world | Ragdoll: `rapier.ts` `loadRapier`, `engine-ragdoll.ts` |
| 1 | Lamp poles (coordinator) | Skip | 0.467 / 0.873 ms | 0.464 / 1.545 ms | about 213–603 KB per frame for the balls, poles and slab world | about 10 of `resolveLampPoles` | Yes; Rapier hashes identical run to run | unowned: `engine-props.ts` `resolveLampPoles` |
| 2 | Jersey slab detection (coordinator) | Skip | 0.642 / 1.215 ms | 0.863 / 1.55 ms | (same world as row 1) | at most 62 (`satCarBarrier`) | Yes; identical | unowned: `sat.ts` `satCarBarrier` |
| 3 | Ramp balls (coordinator) | Skip | 0.447 / 1.163 ms | 1.848 / 3.267 ms | (same world as row 1) | about 15 of `resolveRampBalls` | Yes; identical | unowned: `engine-props.ts` `resolveRampBalls` |
| 4 | Car-car broad phase + collision events as `resolveCarPair` candidates (coordinator, PerfAudit) | Skip | at most 0.026 / 0.198 ms saved (oval); 0.124 / 0.811 (derby) | 0.174 / 0.724 ms (oval); 0.451 / 2.354 (derby) | 150–515 KB per frame | 18 | Yes; candidate sets identical in 3 runs and across processes; misses 49–1250 hits per run unless padded 0.25–0.5 m | unowned: `world-step.ts` `stepWorld`, `sat.ts` `satCars` |
| 5 | Track projection, `projectPath` (PerfAudit) | Skip | 382–626 ns per hinted query (0.05–0.08 ms for 128 queries) | 1252–1940 ns (0.16–0.25 ms) | 257–563 B per query | 0 | Yes; Rapier's global nearest point differs at 51–583 of 50 000 points (the hint keeps a car on its own stretch where roads pass close) | RaceDev: `world/track.ts` `projectPath` |
| 6 | Race walls and props (RaceDev) | Skip | 0.059 / 0.286 ms | 0.519 / 1.505 ms | 321 / 542 KB per frame | about 60 of 114 | Yes; identical | WheelGround (track collision surfaces): `engine-race-field.ts` `RaceField.wall`, `RaceField.props` |
| 7 | Derby bowl (coordinator) | Skip | 0.038 / 0.089 ms | 0.539 / 1.587 ms | — | 35 | Yes; identical | unowned: `derby-arena.ts` `clipToDerbyBowl`, `clipDerbyCar` |
| 8 | Wheel and ground sampling by ray (coordinator, WheelGround) | Skip | in place 0.060 / 0.201 ms (56–80 ns per `heightAt`); 4 wheels × 4 slices with normals: 0.047–0.055 / 0.151–0.175 ms | 0.926 / 6.328 ms in place; 0.255–0.324 / 0.815–1.038 ms for the 4-wheel pattern | 357–1011 B per ray | up to 77, with about 58 builder lines added | Yes; ray results reproducible; heights differ from ours by up to 0.24 m on non-planar cells (triangles against our bilinear) | WheelGround: `world/track.ts` `TrackGround.heightAt`/`normalAt` |
| 9 | Loose parts, popped wheels, debris (Ragdoll, CarAssets) | Skip | 0.032 + 0.005 / 0.241 + 0.152 ms | 0.842 / 4.89 ms (one world for both) | 283 / 505 KB per frame | 30 + about 20 | No (cosmetic, one-way) | CarAssets: `car-parts.ts` `stepLoose`, `stepLooseParts`; unowned: `engine-fx.ts` `DebrisSystem.update` |
| 10 | Swept `tyreStop` as `Shape.castShape` (PerfAudit) | Skip | 0.034 / 0.116 ms (0.73–1.33 µs per call, derby) | 1.81 / 5.78 ms (38–66 µs per call); disagrees on 0.2 % of calls | not measured | 59 | Yes | unowned: `pair-contact.ts` `tyreStop` |
| 11 | Pre-pass cylinder sensors for `collideWith`/`partContactPair` (coordinator) | Skip | cull only 0.002 / 0.012 ms (oval) | 0.107 / 0.155–0.261 ms | (as row 4) | 9 | Yes; exact, no misses | unowned: `world-step.ts` `stepWorld` |
| 12 | Anti-tunnelling sweep (CCD) at 200 km/h (coordinator, DriveSpeed) | Skip | — (no sweep today) | 0.21–0.24 / 0.49–0.53 ms | 3.3–10.2 KB per slice | 0 | — | Not a Rapier problem: the T-bone at 250 km/h goes through (this run), and DriveSpeed traced it to `resolveCarPair`'s per-slice impulse cap, not to a skipped contact |
| 13 | Traffic and police proximity scans (RaceDev) | Skip | 0.3 / 2.2 µs per think round | 28 / 70 µs per round | — | 0 | — | RaceDev: `traffic.ts` `think`, `engine-race-field.ts` `bubble`, police `nearest`/`spot` |
| 14 | Rapier raycast vehicle for wheel contact (owner) | Skip | (our pose is part of `integrate`) | adds 0.5–1 ms per frame for 32 cars | — | about 20 of `integrate` | Yes; the arcade layer would have to be rebuilt | WheelGround / DriveSpeed: `car.ts` `integrate`, `car-drive.ts` `applyDrive` |
| 15 | Shared ragdoll + gameplay world (Main) | Skip: keep separate | — | — | — | 0 | Contact with gameplay bodies changes their digest | Ragdoll |
| — | Camera clearance rays (coordinator) | Not applicable | `engine-camera.ts` makes no ground or wall query | — | — | — | — | — |
| — | Police line of sight (RaceDev) | Skip, not run | — | would need the walls world of row 6 | — | — | — | RaceDev |

Rows 1–3 and 9 come from a sandbox harness that turns on the balls, poles, slab and bowl together (the game never does), so treat their absolute numbers as per-item costs, not a game mode.
Rows 1–3 and 6–9 ran Rapier shadow worlds beside the real sim and left our race and derby digests unchanged; row 4 replayed recorded traces.
Every Rapier side hashed identically in 2–3 worlds per process and across 3 processes.
No candidate wins on 0.19.3 either: the 0.19.3 side runs (walls and props, debris, ground rays) were still 4.5–15× ours.

### Integration sketch: the one adoption (row 0)
The Ragdoll lane owns it; this is the shape the measurements support.
- One loader: `kernel/rapier.ts` `loadRapier()`, a single lazy import of `@dimforge/rapier3d@0.19.3` (the non-compat build, pinned; Ragdoll's choice). It downloads the wasm as its own file (1533 KB raw / 573 KB gzip / 419 KB brotli in this evaluation's size run) instead of the compat build's base64 inside the JS, needs no `init()`, and Vite 8 imports the `.wasm` natively. It loads in the background after `CrashEngine.ready`, so the start-up cost never lands on the ejection frame (this evaluation measured the compat build's cold start, 59–183 ms; the non-compat start-up was not measured here).
- One small, separate, local world: the dummies plus the cars as kinematic proxies (2 cuboids each), synced only while a dummy is out.
  0.19.3's per-step garbage is flat (0.56 KB), so the proxies cost no collections; on 0.21.0 they would cost 0.31 KB per collider per step.
- Nothing in the world feeds the sim: no contact with any gameplay body (section 6), so replays and netplay digests are untouched.
- Nothing of ours is deleted; nothing else moves into the world until a row above measures as a win.

## 1. Wheel contact

### The premise, corrected
The react-three-rapier "car" demo (`demo/src/examples/car/CarExample.tsx`) is **not** `DynamicRayCastVehicleController`.
It is a dynamic box plus four dynamic wheel bodies (`colliders="hull"` over a 32-segment cylinder) on revolute joints with velocity motors (`configureMotorVelocity(20, 10)`): no suspension, no steering, no brakes.
Both were tested, at our sedan's size: 1400 kg, wheels at `WHEEL_POS` (±0.74, 0.32, ±1.34), tyre radius 0.32 m.
- **raycast**: `DynamicRayCastVehicleController`, rest length 0.3 m, stiffness 22 (about 1.5 Hz ride), damping 2.4/2.8, friction slip 10.5 (Rapier's default) and 1.0.
- **joint**: the demo's construction. At 20 kg wheels (66:1 to the body) it shakes itself over on flat ground with Rapier's default 4 solver iterations; at 80 kg wheels it sits still, so 80 kg is used.

### The owner's ramp test
WheelGround's `ramp.test.ts` is the spec: a wedge rising along +X over x ∈ (−10, 10) at 10/20/30°, the car dropped 0.5 m above mid-face, facing up, down, left (−Z) and right (+Z), brake and handbrake held for 3 s.
It passes when all four wheels are within 2 cm of the face (perpendicular), pitch and roll are within 1.5° of the face along the car's heading, and the car slides ≤ 0.5 m at 10° and 20°.
The banked-turn section is the stunt course's bowl, built from `world/tracks/stunt.json` through our own `TrackGround` (1 m heightfield): nodes 5, 6 and 7 (bank 16°, 18°, 16°), at lateral −4, 0 and +4 m, facing the driving direction.
Rapier gets the same ground as a heightfield sampled from `heightAt` (0.25 m cells on the wedge, the `TrackGround` grid itself on the bank); a ray probe found its heights within 1e-5 m of ours.

| Model | Wedge 10° | Wedge 20° | Wedge 30° | Stunt bank | Slide after 3 s / 10 s |
|---|---|---|---|---|---|
| Ours, main | 2/4 pass. Left/right: roll error ±20°, gaps −27.2/+23.4 cm | 2/4. ±40°, −55.1/+40.1 cm | 2/4. ±60°, −80.1/+48.1 cm | 0/9. Roll error 31.9–36.0°, gaps −50/+37 cm | 0 m (no downhill force) |
| Ours, WheelGround's fix (`lane/wheel-ground` 1adbf03, the same tree as df610f0 apart from a comment) | 4/4. Gaps 0.0 cm, error 0.00° | 4/4 | 4/4 | 9/9. Gaps ≤ 1.1 cm, error 0.00° | 0 m |
| Rapier raycast, μ-slip 10.5 | 4/4. Error ≤ 0.28° | 4/4. ≤ 0.56° | 4/4. ≤ 0.83° | 9/9. ≤ 0.15° | 2.5–3.2 / 5.6 cm at 10°; 6.5–7.8 / 8.7–9.0 cm at 20°; 5.4–10.4 / 10.1–28.0 cm at 30°; bank 4.8–5.4 / 6.2–10.1 cm |
| Rapier raycast, μ-slip 1.0 | 4/4. ≤ 0.28° | 4/4. ≤ 0.56° | 4/4. ≤ 0.83° | 9/9. ≤ 0.15° | Within 3 cm of the row above |
| r3f joint car (80 kg wheels) | 4/4, but slides 0.20–0.35 m | 0/4: slides 0.51–0.66 m | 3/4: facing up it tumbles (roll error 67°, a wheel 1.7 m off) and slides 9.5 m | 0/9: slides 0.72–1.23 m | — |

- On main the up- and down-slope headings already pass and the side headings lean the wrong way: the roll error is exactly twice the slope.
  This is the sign error in `car.ts` `alignToGround` that WheelGround is fixing; the bank fails the same way.
  This run reproduces WheelGround's own RED numbers to the millimetre, which also checks this prototype's metric code against theirs.
- The raycast vehicle's gaps are zero by construction: each wheel is drawn where its ray hits.
  What it adds is a body pose from four springs (pitch/roll within 0.83° even at 30°; the residual is weight transfer onto the downhill springs).
- It never comes to rest on a slope: after 10 s it is still moving at 0.04–0.06 m/s.
  The friction model is Bullet's impulse model with no static anchor, so a parked car creeps (28 cm in 10 s at 30°).
- WheelGround's fix (roll sign, and keeping the tilt in `applyDrive`) passes all 21 placements in this harness with zero slide, so our model now beats the raycast vehicle on this test: no creep.

### Handling: can it feel like ours?
The same inputs through both models, flat ground (`vehicle/handling.mjs`).
Rapier's inputs are mapped the plain way: throttle → rear engine force (1400 kg × 16 m/s², × 1.6 boost: the sedan's accel and `BOOST`), steer → front wheel angle × 0.5 rad, handbrake → rear brakes.

| Manoeuvre | Ours (arcade, default realism) | Rapier raycast, as built | Rapier, COM at ground | Rapier, COM at ground + friction slip 3 |
|---|---|---|---|---|
| 0→17 m/s, no boost / boost | 1.08 s / 0.70 s; top speed 18.0 / 25.6 m/s | 1.07 s / 0.67 s; no top speed (64 m/s after 4 s) | same | 1.07 / 0.72 s |
| Full lock at 18 m/s, gas on (at 2 s) | 1.55 rad/s, 27.9 m/s², slip 0° | 1.19 rad/s, 38.6 m/s², slip 2.2°, speed climbing to 32 m/s | 3.99 rad/s, 93 m/s² | 1.30 rad/s, 27.4 m/s² |
| Handbrake flick, then gas + lock | peak slip 52.9°, held at 49° after 2 s | peak slip 14.1°, 3.6° after 2 s | peak 13.6° | peak 10.0° |

- Launch and boost map one-to-one: they are just forces.
- Lateral grip is tunable to ours (friction slip 3 with the centre of mass at ground level gives 27.4 against our 27.9 m/s²).
- No tune slid: with the rear side friction cut to 0.35 under the handbrake, the peak slip was still 13.3°.
  A held drift needs our drift assist re-implemented as forces on the body.
  So do the top speed, speed-sensitive lock, ABS, self-righting, per-axle surface grip and the arcade ↔ realistic slider (`car-drive.ts`, `vehicle-classes.ts`).
  Rapier would replace the suspension and ground contact, about 20 lines of `integrate`, and none of the feel.
- Per-step cost: 32 raycast cars on the stunt heightfield take 75–131 µs of `updateVehicle` plus 187–351 µs of `world.step` per 1/120 s step (2, 10, 32 cars: `vehicle/vehicle-cost.mjs`), on top of everything we keep.

### Verdict
Reject Rapier for wheel contact.
The defect is one wrong sign plus sampling the ground only at the car's origin, both local to `alignToGround`.
The one idea worth taking is the raycast vehicle's: read the ground at each wheel's contact point, not at the origin.
In our code that is four `ground.heightAt` calls and a plane fit, which WheelGround's handoff already lists as the follow-up.

## 2. Collision triggering and events
Question: would a Rapier broad phase with contact or intersection events, feeding our unchanged `resolveCarPair` / `collideWith` / `partContactPair`, cut cost or code?

Method (`collide/`): a Node resolve hook swaps `world-step.ts` for a verbatim copy of `stepWorld` with timers and counters around each section.
The copy is faithful: the race and derby state digests are equal plain, hooked and tracing in every scene (oval 2/10/32 cars, stunt 10/32, derby 10/24/32).
A negative control (SAT passes capped at 2) changes the digest, so the check can fail.
A trace of every slice (poses, the 5 cabin and 5 crush hulls per car, which pairs hit) is then replayed in Rapier: one kinematic body per car, one cuboid per hull, re-sized every slice as the hulls deform.

| Per 60 Hz frame, median | Oval 10 cars | Oval 32 | Stunt 32 (200 props) | Derby 10 | Derby 32 |
|---|---|---|---|---|---|
| Ours: pre-pass pair loop | 0.004 ms | 0.026 | 0.034 | 0.046 | 0.193 |
| Ours: SAT pair loops (`resolveCarPair` calls) | 0.021 | 0.217 | 0.415 | 0.551 | 2.607 |
| … of which hit resolution (stays) | ~0 | 0.034 | 0.123 | 0.440 | 1.889 |
| Most a perfect candidate source could save | 0.026 | 0.198 | — | 0.124 | 0.811 |
| Rapier, crush hulls only, half-height 1.25 m, 0.25 m margin, events (cheapest route with no miss) | 0.174 | 0.724 | — | 0.451 | 2.354 |
| Rapier, all 10 hulls, same settings | 0.613 | 1.577 | 2.168 | 2.561 | 4.11–4.81 |
| Ours: whole `stepWorld` | 0.308 | 1.17 | 2.09 | — | — |

- Pairs: at 32 cars on the oval, `resolveCarPair` runs 3595 times per frame, 76 pairs are near and 6.4 hit; Rapier would cut the calls from 4.47 M to 13 924 per 30 s, but each call that it skips costs only nanoseconds.
- Misses: without a margin Rapier's candidate set lacks 49–1250 of our hit pairs per 30 s run, almost all of them `tyreStop`'s swept tyre stops.
  A 0.25 m margin fixes it everywhere except derby-24, which needs 0.5 m; a 0.7 m half-height also drops 34 crush-hull hits on the stunt ramps, where the height gap reaches 1.4–2.5 m.
- Deforming hulls: after a crash almost every hull changes every slice (up to 272 of 320 colliders), so the shape updates alone cost 0.12–0.39 ms per frame on the oval and 0.63–1.29 ms in the 32-car derby.
- Garbage: Rapier's JS glue allocates about 150–515 KB per frame (wasm-bindgen call/drop wrappers, `FinalizationRegistry`, `mapNewSoftBodies` inside every `World.step`).
- A query-only route (no `world.step`) does not work: the broad-phase BVH only refits inside a step, so a moved body is invisible to queries until then (0.21.0 and 0.19.3).
  `setNextKinematicTranslation` also reports a new contact one step late.
- The deterministic build gives the same candidate digest at 1.45–1.63 ms per frame (oval 32, all hulls).
- Break-even, extrapolated from linear against quadratic growth and not measured: about 93–117 cars, against `MAX_CARS` = 32.

Verdict: reject.
Detection is not where the time goes; hit resolution is, and that stays ours.

## 3. World physics
What could move to Rapier, what it would cost, and what we would delete (`world/`, stunt course, the same car trajectories replayed into shadow Rapier worlds beside the real sim).
Rapier would only detect contacts.
Every response stays ours: `wallBounce`, `applyImpact`, `kickNearestHub`, `StrongestContact`, the pole fold, the slab's hold, brake and indent, and per-surface grip.

| Item | Ours: lines | Ours per frame, 10 / 32 cars | Rapier per frame, 10 / 32 | Would delete | Must keep |
|---|---|---|---|---|---|
| Race walls (`RaceField.wall` + `wallBounce`) | 41 + 19 | 0.010 / 0.048 ms | shared world with the props, next row | about 25 lines of probing | `wallBounce`, the hit feed, wall layering by path height |
| Race props (`RaceField.props`) | 73 | 0.049 / 0.236 ms (walls + props: 0.059 / 0.286) | walls trimesh + 200 props + car proxies: 0.519 / 1.505 ms | about 35 lines of probes | the knock response, the solid push, the hit feed |
| Ground (`TrackGround` queries) | 77 of 205 | 0.060 / 0.201 ms (742 / 3591 `heightAt` calls per frame) | heightfield + deck trimesh rays: 0.926 / 6.328 ms | up to 77, but about 58 builder lines added | surface ids (grip), the `STEP_UP` layer pick, `NO_FLOOR`, the bake |
| Bridge decks | inside `heightAt` | — | a heightfield holds one height per (x, z): the deck needs its own trimesh, rays cast from y + `STEP_UP` | 0 net | deck grip |
| Loose parts and wheels (`stepLoose`, `stepLooseParts`) | 30 | 0.032 / 0.241 ms | one world with the debris: 0.842 / 4.89 ms | 30 | glass dots and sparks, the fleet disc's fall-off, the netplay pose readout |
| Debris (`DebrisSystem.update`) | 33 | 0.005 / 0.152 ms | (with the loose parts) | about 20 | instancing, lifetime |
| Ramp balls (`resolveRampBalls`) | 75 | 0.447 / 1.163 ms | 1.848 / 3.267 ms | about 15 | the push, `armMasses`, `kickNearestHub`, the hit feed |
| Lamp poles (`resolveLampPoles`) | 41 | 0.467 / 0.873 ms | 0.464 / 1.545 ms | about 10 | the impulse, the fold animation |
| Jersey slab (`satCarBarrier` detection) | 62 of 365 | 0.642 / 1.215 ms | 0.863 / 1.55 ms | at most 62 | the multi-pass resolve, per-mass clipping, hold, brake, indent |
| Derby bowl (`clipToDerbyBowl`, `clipDerbyCar`) | 35 | 0.038 / 0.089 ms | 0.539 / 1.587 ms | 35 | the translation on the wall hit |
| `StrongestContact`, compactor and piston rigs | — | — | not replaceable / deformation strikers (owner rule) | 0 | all |

- Loads: the static world (ground heightfield, deck, walls, props, 32 proxies) builds in 76–161 ms with 2.9–6.4 MB of wasm memory.
  A trimesh ground instead costs 207 ms and 48 MB of wasm; our own bake is 197 ms and 1.04 MB.
- Garbage: 0.21.0's `World.step` allocates about 0.31 KB of JS heap per collider per step, even for idle fixed colliders (2000 fixed cuboids: 616 KB per step, 94 collections per 5000 steps); 0.19.3 allocates a flat 0.56 KB.
  The course's 2163 wall segments as cuboids would cost about 730 KB per step; as one trimesh, 128 KB.
- Accuracy: rays aimed exactly at heightfield grid vertices miss (5931 of 19 735 in 0.21.0), and 8 of 227 rays exactly on deck-mesh edges fall through to the road; tiny debris boxes with CCD fall through or off the ground (2–4 of 200).
- Determinism: our race digest stayed identical in every process with the shadow worlds running, and every Rapier contact and pose hash matched across 2–3 worlds per process and across 3 processes.
- Found on the way: `Track.wallClip` (26 lines) had no caller outside `track.test.ts` (ast_grep over `src`); since removed.

Verdict: reject, item by item.
The closest are the lamp poles (even at 10 cars) and the slab (1.3× ours); neither deletes more than 62 lines, and both get worse with more cars.

## 4. Costs

### Download
The game would load Rapier as a lazy chunk (the `-compat` build inlines the wasm as base64, so Vite needs no plugin or config).

| Build | Vite 8 lazy chunk, raw | gzip -9 | brotli 11 |
|---|---|---|---|
| 0.19.3 compat | 2183 KB | 810 KB | 600 KB |
| 0.21.0 compat | 4232 KB | 1605 KB | 1167 KB |
| 0.21.0 deterministic-compat (`.mjs`) | 4270 KB | 1612 KB | 1174 KB |
| 0.21.0 non-compat: `.wasm` + JS glue | 3010 + 330 KB | 1148 + 33 KB | 832 + 26 KB |

- 0.21.0's wasm is twice 0.19.3's (3010 against 1533 KB).
- The VPS sends `/crush/assets/*.js` with no `Content-Encoding` even when the request offers gzip or brotli; today's initial JS is 1.19 MB (index 405 KB, routes 189 KB, three 596 KB).
  As deployed, the 0.21.0 chunk adds 4.23 MB over the wire, 3.6× the whole initial JS.
  Enabling gzip or brotli on the server shrinks it to 1605 or 1167 KB (Main has taken this finding).

### Cold start
Fresh process or fresh browser context, so no code cache; the module bytes come from memory, so network time is excluded.

| | Import (parse) | `init()` | First world + step | Total |
|---|---|---|---|---|
| Node, 0.19.3 (median of 10) | 19 ms | 71 ms | 23 ms | 113 ms |
| Node, 0.21.0 | 35 ms | 117 ms | 118 ms | 270 ms |
| Node, 0.21.0 deterministic | 21 ms | 44 ms | 48 ms | 113 ms |
| Chromium, 0.19.3 (median of 7) | 31 ms | 20 ms | 8 ms | 59 ms |
| Chromium ×4 CPU throttle, 0.19.3 | 59 ms | 85 ms | 39 ms | 183 ms |
| Chromium ×6, 0.19.3 | 73 ms | 130 ms | 63 ms | 266 ms |
| Chromium, 0.21.0 | 98 ms | 35 ms | 79 ms | 212 ms |
| Chromium ×4, 0.21.0 | 130 ms | 123 ms | 328 ms | 580 ms |
| Chromium ×6, 0.21.0 | 96 ms | 146 ms | 489 ms | 731 ms |

All of this is main-thread work, so it must not land on a gameplay frame: start the import at scene load, not at first use.
0.19.3's `init()` prints a deprecation warning ("using deprecated parameters for the initialization function; pass a single object instead"); 0.21.0 does not.

### Memory
Node RSS after init plus a 20-body world: +38 MB with 0.19.3, +125 MB with 0.21.0 (median of 10); `arrayBuffers` +1.6 / +3.1 MB.

### Per-step cost
Small, ragdoll-sized worlds, 1/60 s steps, kinematic car boxes moved every step (`costs/step-small.mjs`, three interleaved A/B runs):

| World | 0.19.3 median | 0.21.0 median |
|---|---|---|
| 32 kinematic boxes only | 19–21 µs | 33–59 µs |
| 11 dynamic capsules (one jointed chain) + 32 kinematic | 40–68 µs | 81–106 µs |
| 44 dynamic + 32 kinematic | 101–114 µs | 155–236 µs |
| 110 dynamic + 32 kinematic | 230–397 µs | 368–634 µs |

0.21.0 is 1.5–2× slower than 0.19.3 here, and its `World.step` allocates about 0.31 KB of JS heap per collider per step (section 3).
Its worst step per run was 3.8–12.5 ms in all 6 runs; 0.19.3's stayed under 0.73 ms in 5 of its 6 runs (the sixth, under the same load, reached 4.5 ms).
A busier world (180 bodies: heightfield, 120 boxes, 32 kinematic boxes, 3 chains, 4 raycast vehicles at 1/120 s) steps in a 0.84–1.34 ms median in every build.

### Determinism
Replays and netplay need same-machine, bit-identical digests.
`costs/determinism.mjs` runs that 180-body world 900 steps and hashes every body's pose bits every step.

| Build | Run A = run B, in one process | 3 processes agree | Snapshot at step 450, restore, re-run 451–900 |
|---|---|---|---|
| 0.19.3 | yes (`5659294100a7ee2f`) | yes | **differs** (`902a8932…` against `c33dc0b6…` straight through) |
| 0.21.0 | yes (`9beab3a5899dd696`) | yes | matches (`8a3022fe…`) |
| 0.21.0 deterministic | yes, the same digest as 0.21.0 | yes | matches |

- On one x64 machine the regular and the enhanced-determinism builds give the same digests.
  The enhanced build is for cross-platform agreement (desktop x64 against a phone's ARM).
  That was not measured here: one machine only.
- 0.21.0's snapshots round-trip bit-identically; 0.19.3's diverged in this test.
- Vehicle controllers live outside the snapshot.

## 5. Instancing
Rapier has no instancing.
react-three-rapier's `<InstancedRigidBodies>` is a React helper that writes each body's pose into a three `InstancedMesh`'s `instanceMatrix`; vanilla three already has that (`InstancedMesh`, `BatchedMesh`).
The game instances wheels (`car-mesh.ts`), props per prefab part (`present/track-art.ts`), fx (`engine-fx.ts`), pistons, arena walls and the door ram already.
The note sent to the perf lane: `BatchedMesh` (one draw for several geometries sharing a material) is the one vanilla lever not used anywhere in `src/game`; for example, folding a prefab's shared-material parts into one draw. Not measured.

## 6. A shared Rapier world (Ragdoll lane)
The Ragdoll lane steps a separate, cosmetic Rapier world with the cars as kinematic colliders.
`costs/shared-world.mjs` steps 60 dynamic props shoved by 8 kinematic cars and hashes the props over 900 steps, then repeats with 3 ragdoll chains (8 capsules each) dropped at step 200:

| Ragdolls | Props digest, 0.19.3 | Same as without? | 0.21.0 | Same? |
|---|---|---|---|---|
| none | `7b734af650cda035` | — | `b5816f157d46502e` | — |
| touching the props, lower dominance group | `b0855e0663468a4f` | no | `3680486014a1e6a1` | no |
| touching, equal dominance | `00376c7f8d4e52a2` | no | `547940d7a9fcfaf8` | no |
| 40 m away, no contact | `7b734af650cda035` | yes | `b5816f157d46502e` | yes |

Ragdolls are local and cosmetic: two peers or a replay will not spawn them identically.
In a shared world any contact with gameplay bodies changes the gameplay state, and dominance groups do not prevent it.
Keep the ragdoll world separate.
A shared world makes sense only once gameplay bodies live in Rapier (section 3), and then only with collision groups that keep ragdolls off every gameplay dynamic body.
That last part is an inference from the no-contact row; collision groups were not run.

## Reproducing
Scratch project: `npm init -y && npm install @dimforge/rapier3d-compat @dimforge/rapier3d @dimforge/rapier3d-deterministic-compat` (0.21.0), plus 0.19.3's `rapier.mjs` copied from main's `node_modules` into `vendor0193/`.
Every run was `flock <lane lock> capped <command>` (a memory-capped scope); the browser run also took the shared heavy lock.
Game modules are imported from a tree given by `ROOT` (default: this lane's worktree at 38fe41c).

| Result | Script | Command |
|---|---|---|
| Heightfield layout, ray-height check | `vehicle/hf-probe.mjs` | `node vehicle/hf-probe.mjs` |
| Ramp + bank, Rapier | `vehicle/ramp-rapier.mjs` | `node --experimental-strip-types vehicle/ramp-rapier.mjs`; `SECS=10 …` |
| Ramp + bank, ours | `vehicle/ramp-ours.mts` | `ROOT=<tree> node --experimental-strip-types vehicle/ramp-ours.mts` |
| WheelGround's harness on main | their `src/game/ramp.test.ts` in a 38fe41c `git archive` copy | `node --experimental-strip-types --test src/game/ramp.test.ts` |
| Joint car stability | `vehicle/joint-trace.mjs`, `vehicle/joint-debug.mjs` | `node vehicle/joint-debug.mjs` |
| Handling | `vehicle/handling-rapier.mjs`, `vehicle/handling-ours.mts` | `node vehicle/handling-rapier.mjs`; `node --experimental-strip-types vehicle/handling-ours.mts` |
| Vehicle step cost | `vehicle/vehicle-cost.mjs` | `node --experimental-strip-types vehicle/vehicle-cost.mjs` (×3) |
| Sizes | `costs/sizes.mjs`, `costs/bundle/` | `node costs/sizes.mjs`; `OUT=<dir> vite build -c costs/bundle/vite.config.mjs` |
| Init, Node | `costs/init.mjs`, `costs/init-run.sh` | `./costs/init-run.sh` |
| Init, Chromium | `costs/init-browser.mjs` | `node costs/init-browser.mjs` |
| Small-world steps | `costs/step-small.mjs` | `node costs/step-small.mjs <rapier.mjs>` (A/B, ×3) |
| Determinism | `costs/determinism.mjs` | `node costs/determinism.mjs <rapier.mjs>` (×3 per build) |
| Shared world | `costs/shared-world.mjs` | `node costs/shared-world.mjs <rapier.mjs>` |
| VPS encoding | — | `curl -sD- -o/dev/null -H 'Accept-Encoding: gzip, br' https://baconwhiskey.org/crush/assets/<file>.js` |
| Car-car detection, ours in place | `collide/race.mts`, `collide/hook.mjs` (resolve hook), `collide/step-instr.mts` (timed `stepWorld` copy) | `COURSE=oval AI=31 SECS=30 node --import ./collide/hook.mjs --experimental-strip-types collide/race.mts`; derby: `SCENE=derby N=32 …`; all scenes: `sh collide/matrix.sh "oval 9" "oval 31" …` |
| Digest negative control | same | `PERTURB=1 COURSE=oval AI=31 SECS=30 node --import ./collide/hook.mjs --experimental-strip-types collide/race.mts` |
| Car-car detection, Rapier replay | `collide/replay.mts` (traces from `race.mts` with `TRACE=`) | `TRACE=collide/traces/oval-31 V=events HH=1.25 MARGIN=0.25 HULLS=crush REPS=3 node --experimental-strip-types collide/replay.mts`; `V=cyl`, `V=sensor`, `V=query`; `ALLOC=1`; `RAPIER_MJS=@dimforge/rapier3d-deterministic-compat` |
| Query-only route, event timing | `collide/probe.mts` | `node --experimental-strip-types collide/probe.mts` |
| `tyreStop` against `castShape` | `collide/race.mts` | `SCENE=derby N=32 SECS=30 TYRE=1 node --import ./collide/hook.mjs --experimental-strip-types collide/race.mts` |
| World physics, line counts | `world/count.mjs` | `node world/count.mjs` |
| Walls, props, ground, loose parts, debris in place | `world/insitu.ts`, `world/rapier-world.ts` | `CARS=32 SECS=30 SHADOW=collide node --experimental-strip-types world/insitu.ts`; `SHADOW=pieces`; `ALLOC=1` |
| Balls, poles, slab, bowl | `world/sandbox.ts` | `CARS=32 SECS=3 node --experimental-strip-types world/sandbox.ts` |
| Step, build and query costs | `world/bench.ts` | `MODE=step CARS=32 N=200 STEPS=1200 node --experimental-strip-types world/bench.ts`; `MODE=build GROUND=hf`; `MODE=query GROUND=tm` |
| 0.21.0 garbage per collider | `world/alloc-check.ts` | `node --experimental-strip-types world/alloc-check.ts`; `RAPIER=…/vendor0193/rapier.mjs …` |
| Ground rays (4-wheel pattern) | `candidates/ground-query.mjs` | `node --expose-gc --max-semi-space-size=128 --experimental-strip-types candidates/ground-query.mjs` (×3) |
| Track projection | `candidates/project-path.mjs` | `node --expose-gc --max-semi-space-size=128 --experimental-strip-types candidates/project-path.mjs` (×2) |
| Tunnelling at speed | `candidates/tunnel.mts` | `node --experimental-strip-types candidates/tunnel.mts` |
| Sweep (CCD) cost | `candidates/sweep-cost.mjs` | `node --expose-gc --max-semi-space-size=128 candidates/sweep-cost.mjs` (×3) |
| Proximity scans | `candidates/proximity.mjs` | `node --expose-gc --max-semi-space-size=128 candidates/proximity.mjs` (×3) |
