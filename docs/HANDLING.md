# Handling

How cars drive, what each class is like, the arcade ↔ realistic slider, and how damage changes driving.
Code: `src/game/vehicle-classes.ts` (data, slider, damage grading), `src/game/car-drive.ts` (`applyDrive`, `DriverSeat`),
`src/game/drive-input.ts` (keyboard / pad feel). Tests: `vehicle-classes.test.ts`, `drive-input.test.ts`, `gamepad.test.ts`.

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

| Class | Body | Mass | Top (m/s) | Accel (m/s²) | Torque | Turn (rad/s) | Grip (m/s²) | Drift | Durability | Lap |
|---|---|---|---|---|---|---|---|---|---|---|
| Sedan | sedan, hatchback, wagon | 1400 kg | 18.0 | 16.0 | 0.3 | 1.55 | 30 | 0.35 | 1.0 | 18.51 s |
| Muscle | coupe (steel) | 1650 kg | 19.0 | 18.0 | 0.6 | 1.36 | 27 | 0.85 | 1.15 | 18.22 s |
| Truck | pickup | 2100 kg | 17.8 | 15.5 | 0.5 | 1.50 | 28 | 0.25 | 1.25 | 18.85 s |
| Monster | pickup on 1.7× wheels, body +0.48 m | 2900 kg | 18.6 | 15.5 | 0.7 | 1.30 | 25 | 0.20 | 1.7 | 18.84 s |

- **Torque** shifts pull toward the launch: a torquey class jumps off the line and runs out of pull near top speed.
- **Drift** is how readily boost at full lock kicks the tail out and how long the slide runs before the assist catches it.
- **Mass** sets the launch and brake feel through `accel` / `brake`; collision masses stay the shared rig's, so a truck does not yet shove harder in a hit.
- **Monster truck**: the body and wheels ride a visual lift; masses, hulls and contacts stay at stock height (a deliberate visual cheat).
- **No tank.** The deformation rig, hulls and part list are one car platform; a tank needs tracks, a turret and skid-steer contact that the rig cannot express, so a tank would be a sedan that pivots in place.

Fleets cycle slots sedan, hatchback, wagon, coupe (muscle), pickup (truck), monster; slot 0 is the player's pick (HUD → Driving → Car).
Race AI plans with `classStats(id)` and `cornerSpeed(stats, radius, grip)`.

## Arcade handling

- **Instant response**: pedals and wheel ramp in well under 0.3 s; the yaw rate follows the wheel each slice.
- **Speed-sensitive steering**: lock fades with speed (never under 40 %), and grows from zero through a crawl, so the car never pivots on the spot.
- **Slides**: Space at speed with lock kicks the tail out; boost at full lock does it on tail-happy classes. Keep the gas on with lock either way (a counter-steer short of full opposite lock included) and the drift assist holds the body angle while the car carries its speed round; release the wheel or lift off and it catches itself. Full opposite lock catches it twice as fast.
- **Boost** raises top speed ×1.42–1.45 and acceleration ×1.55–1.6.
- **Recovery**: a driven car stuck on its roof or side rights itself after 1.2 s at the arcade end (3 s at mid slider); past 0.6 only R rights it.
- **Surface grip** comes from the active `Ground` (`frictionAt`) under each axle: low front grip loses steering, low rear grip loses traction and launches with wheelspin.
- Tyre FX read `car.drive.spin` (launch wheelspin), `lock` (brake lock-up) and `slide` (sideways slip), each 0–1.

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
A derby car's kill travel is `DERBY_KILL_SCALE` (0.5) of that (`killTravel(cls, realism, "derby")`, armed by `dressCar` and the Realism slider while derby mode is on); race and fleet keep the values above. Ten-car derby, 5 seeds at the realistic defaults (lane crash-realism-6): ×1 ends 0/5 matches by elimination, ×0.67 2/5 (first death 7.9 s), ×0.5 4/5 (first death 15 s).

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
