# Handling

How cars drive, what each class is like, the arcade ↔ realistic slider, and how damage changes driving.
Code: `src/game/vehicle/vehicle-classes.ts` (data, slider, damage grading), `src/game/vehicle/car-drive.ts` (`applyDrive`, `DriverSeat`),
`src/game/vehicle/drive-input.ts` (keyboard / pad feel). Tests: `vehicle-classes.test.ts`, `drive-input.test.ts`, `gamepad.test.ts`.

## Controls

| Action | Keyboard | Pad |
|---|---|---|
| Gas / brake-then-reverse | W / S (↑ / ↓) | RT / LT |
| Steer (A = nose left on screen, in every class and view) | A / D (← / →) | left stick |
| Handbrake (slide) | Space | A / Cross |
| Boost | Shift | X / Square |
| Right the car | R | D-pad down |

Reverse steers like a real car: holding A while backing swings the tail left.

## Classes

Every class runs the same stat budget: whatever it gains on the straights it pays back in the corners.
The planner lap on the 313 m mixed loop in `vehicle-classes.test.ts` (two 8 m hairpins, two 24 m sweepers):

| Class | Body | Mass | Top | 0–100 km/h | Gears | Turn (rad/s) | Grip (m/s²) | Drift | Durability | Lap |
|---|---|---|---|---|---|---|---|---|---|---|
| Sedan | sedan, hatchback, wagon | 1400 kg | 200 km/h | 2.45 s | 5 | 1.55 | 39 | 0.35 | 1.0 | 13.17 s |
| Muscle | coupe (steel) | 1650 kg | 210 km/h | 1.95 s | 5 | 1.36 | 35.5 | 0.85 | 1.15 | 13.72 s |
| Truck | pickup | 2100 kg | 195 km/h | 2.5 s | 4 | 1.50 | 38.5 | 0.25 | 1.25 | 13.54 s |
| Monster | pickup on 1.7× wheels, body +0.48 m | 2900 kg | 190 km/h | 2.0 s | 4 | 1.30 | 37 | 0.20 | 1.7 | 14.12 s |

- **Torque** sets how much the rear spins up on a launch (tyre FX); the pull itself is the gear buckets below.
- **Drift** is how readily boost at full lock kicks the tail out and how long the slide runs before the assist catches it.
- **Mass** sets the launch and brake feel through `gears` / `brake`; collision masses stay the shared rig's, so a truck does not yet shove harder in a hit.
- **Monster truck**: the body and wheels ride a visual lift; masses, hulls and contacts stay at stock height (a deliberate visual cheat).
- **No tank.** The deformation rig, hulls and part list are one car platform; a tank needs tracks, a turret and skid-steer contact that the rig cannot express, so a tank would be a sedan that pivots in place.

Fleets cycle slots sedan, hatchback, wagon, coupe (muscle), pickup (truck), monster; slot 0 is the player's pick (HUD → Driving → Car).
Race AI plans with `classStats(id)` and `cornerSpeed(stats, radius, grip)`.

## Acceleration

Each class has 4 or 5 gear buckets (`ClassStats.gears`): a gear's top end as a share of the class top speed, and a fixed
thrust (m/s²) that falls with each shift. No clutch or revs; the pull steps down at every shift. Boost multiplies the
thrust ×1.55–1.6 and lifts the top ×1.2–1.22, pulling on in top gear past the class top: 252 km/h on the muscle car,
the fastest a driven car goes (`barrier.test.ts` crashes every hit up to it).

| Class | Gear top ends (× top) | Thrust per gear (m/s²) | 0–100 km/h | Time to top |
|---|---|---|---|---|
| Sedan | 0.24 / 0.42 / 0.6 / 0.8 / 1 | 17.2 / 10.7 / 6.1 / 3.5 / 2.0 | 2.45 s | 12 s |
| Muscle | 0.24 / 0.42 / 0.6 / 0.8 / 1 | 20.4 / 12.7 / 7.7 / 4.7 / 2.8 | 1.95 s | 9.5 s |
| Truck | 0.3 / 0.53 / 0.76 / 1 | 16.3 / 7.8 / 4.3 / 1.8 | 2.5 s | 12.7 s |
| Monster | 0.3 / 0.53 / 0.76 / 1 | 17.1 / 11.5 / 5.0 / 1.8 | 2.0 s | 11.5 s |

The figures come from real vehicles, scaled to arcade pace: 0–100 km/h about × 0.4, time to top about × 0.5, first gear
as punchy as the old single-curve launch (derby hits keep their pace), the real order kept (muscle and monster quickest,
truck slowest off the line), then nudged so every class laps alike. Real figures (0–100 km/h is the published 0–60 mph):

| Class | Real vehicle | Gears | 0–60 mph | Longer run | Top speed | Source |
|---|---|---|---|---|---|---|
| Sedan | 2018 Honda Accord Sport 2.0T manual | 6 | 6.1 s | 0–100 mph 15.3 s, 0–120 mph 21.8 s | 201 km/h (governed) | [Car and Driver](https://www.caranddriver.com/reviews/a15078684/2018-honda-accord-sport-20t-manual-test-review/) |
| Muscle | 2018 Ford Mustang GT manual | 6 | 4.3 s | 0–100 mph 9.7 s, 0–130 mph 16.4 s | 249 km/h (governed) | [Car and Driver](https://www.caranddriver.com/reviews/a14500071/2018-ford-mustang-gt-manual-test-review/) |
| Truck | 2026 Toyota Tacoma TRD Off-Road manual | 6 | 7.9 s | 0–100 mph 21.6 s | 174 km/h (governed) | [Car and Driver](https://www.caranddriver.com/reviews/a70173539/2026-toyota-tacoma-trd-off-road-manual-test/) |
| Monster | Monster Jam truck, ~1500 hp, 12,000 lb | 2 | under 4 s (quoted, not measured) | 80 mph in 500 ft | 113 km/h | [Monster Jam](https://www.monsterjam.com/en-us/education/fun-facts/), [MotorTrend](https://www.motortrend.com/features/what-is-monster-jam-all-about-monster-truck-racing), [Car and Driver](https://www.caranddriver.com/features/a23807573/monster-trucks-monster-jam-university/) |

Solo laps at these numbers (race AI on main's `race-ai.ts`, seed 1, best of 3; "seat" is the scripted full-gas line
driver through the player's seat), s and % off the four-class mean:

| Course | Driver | Sedan | Muscle | Truck | Monster |
|---|---|---|---|---|---|
| Oval | AI | 16.21 (−2.6) | 16.60 (−0.3) | 16.67 (+0.2) | 17.10 (+2.7) |
| Oval | seat | 18.64 (−5.4) | 20.14 (+2.2) | 19.34 (−1.9) | 20.71 (+5.1) |
| Rally | AI | 25.79 (−2.1) | 26.33 (0.0) | 26.41 (+0.3) | 26.82 (+1.8) |
| Rally | seat | 34.21 (+0.2) | 33.01 (−3.3) | 35.03 (+2.6) | 34.28 (+0.4) |
| City | AI | 29.92 (+6.9) | 27.26 (−2.6) | 27.34 (−2.3) | 27.42 (−2.0) |
| City | seat | 27.62 (−2.6) | 28.88 (+1.8) | 28.91 (+1.9) | 28.04 (−1.1) |
| Stunt | AI | 27.26 (−1.6) | 27.29 (−1.5) | 27.69 (−0.1) | 28.63 (+3.3) |
| Stunt | seat | 25.55 (−5.7) | 27.09 (0.0) | 26.57 (−1.9) | 29.16 (+7.6) |

City has traffic: across seeds 1–4 its AI sedan stays 7–10 % slow (an AI line issue: its seat laps are not), the rest move a few percent.

## Arcade handling

- **Instant response**: pedals and wheel ramp in well under 0.3 s; the yaw rate follows the wheel each slice.
- **Speed-sensitive steering**: lock fades with speed (never under 40 %), and grows from zero through a crawl, so the car never pivots on the spot.
- **Slides**: Space at speed with lock kicks the tail out; boost at full lock does it on tail-happy classes. Keep the gas on with lock either way (a counter-steer short of full opposite lock included) and the drift assist holds the body angle while the car carries its speed round; release the wheel or lift off and it catches itself. Full opposite lock catches it twice as fast.
- **Boost** multiplies the gear thrust ×1.55–1.6 and the top speed ×1.2–1.22 (see Acceleration).
- **Recovery**: a driven car stuck on its roof or side rights itself after 1.2 s at the arcade end (3 s at mid slider); past 0.6 only R rights it.
- **Surface grip** comes from the active `Ground` (`frictionAt`) under each axle: low front grip loses steering, low rear grip loses traction and launches with wheelspin.
- Tyre FX read `car.drive.spin` (launch wheelspin), `lock` (brake lock-up) and `slide` (sideways slip), each 0–1.
- **Speed readouts** (sandbox HUD, race HUD, piston and door rig sliders) read mph when the browser's locale region is the US, km/h everywhere else (`speed-units.ts`, `useSpeedUnit`); physics stays in m/s.

## The arcade ↔ realistic slider

`HANDLING.realism`, HUD → Driving → Realism (default 0.25).

| | Arcade (0) | Realistic (1) |
|---|---|---|
| Lateral grip | class grip | × 0.62 (understeers at the limit) |
| Drift assist | holds the body to ≤ 0.62 rad, catches at 4.5/s | off: the slide is yours to hold, catches at 1.1/s |
| Speed through a slide | 80 % of the scrubbed sideways speed returns to the nose | all scrubbed |
| ABS | hides most lock-up | full lock-up |
| Self-righting | after 1.2 s | R only |
| Damage losses | × 0.55 | × 1 |
| Engine-kill travel (sedan) | 0.55 m | 0.15 m (sourced, `ENGINE_KILL_TRAVEL`) |

Kill travel per class is `0.15 m × durability` at the realistic end and `0.55 m × (1 + (durability − 1) / 2)` at the arcade end, capped at 0.63 m: the engine block reaches about 0.64 m by accumulated wrecking, so even a monster truck can still be killed.
Measured with the barrier re-arm (lane/crash-realism-5), a sedan's block travel after repeated 50 km/h wall hits is 0.14, 0.40, 0.48, 0.64 m: the arcade end survives three, the realistic end dies on the first hit over ~50 km/h (35 km/h drives on, 64 km/h kills).
A derby car's kill limits (`armKill(deform, cls, realism, "derby")`, armed by `dressCar` and the Realism slider while derby mode is on) are `DERBY_KILL_SCALE` (0.7935) of that travel plus a wear limit, `DERBY_WRECK_ENERGY` (400 m²/s²: every hit's EBS² capped at 36, summed over all ends); the travel share and the wear share add (`vehicle-classes.ts`). Race and fleet keep the travel above and no wear limit. Ten-car derby, seeds 1–5 at the realistic defaults (lane crash-realism-10): ×0.79 / 400 wrecks 5/5 with first deaths 14.1–36.9 s; travel alone at ×0.46 wrecked 3/5.

## Damage → drivability

From `deform.drivetrainHealth` (1 − block travel / kill travel), `deform.wheelsOn` and whether the car has crashed:

| Stage | When | Effect (realistic end; arcade × 0.55) |
|---|---|---|
| Healthy | never hit | none |
| Dented | crashed, health > 0.6, all wheels | cosmetic only |
| Damaged | health 0.25–0.6, or one wheel off | up to −12 % top speed, power −16 %, pulls ≤ 0.1 rad/s toward the struck side |
| Limping | health < 0.25, or two wheels off | up to −26 % top speed (−12 % more per lost wheel), stronger pull, smoke |
| Dead | block travel past the kill travel, all four wheels off, or derby elimination | no drive |

A car short of dead never drops below 60 % of its class top speed (`LIMP_FLOOR`).
A dented car under power drives on its tyres: the sliding-wreck ground drag (`groundMasses`, `bleedAfterSlide`) only
slows a coasting or dead wreck. With it on a driven car, a dented sedan after a 20 km/h wall hit topped out at 14 km/h.
