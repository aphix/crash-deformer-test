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
The planner lap on the 313 m mixed loop in `vehicle-classes.test.ts` (two 8 m hairpins, two 24 m sweepers), and 0–100 km/h, both at the default slider (0.25):

| Class | Body | Mass | Top | 0–100 km/h | Gears | Turn (rad/s) | Grip (m/s²) | Drift | Durability | Lap |
|---|---|---|---|---|---|---|---|---|---|---|
| Sedan | sedan, hatchback, wagon | 1400 kg | 200 km/h | 2.87 s | 5 | 1.55 | 39 | 0.35 | 1.0 | 13.37 s |
| Muscle | coupe (steel) | 1650 kg | 210 km/h | 2.24 s | 5 | 1.36 | 35.5 | 0.85 | 1.15 | 13.88 s |
| Truck | pickup | 2100 kg | 195 km/h | 2.99 s | 4 | 1.50 | 38.5 | 0.25 | 1.25 | 13.76 s |
| Monster | pickup on 1.7× wheels, body +0.48 m | 2900 kg | 190 km/h | 2.25 s | 4 | 1.30 | 37 | 0.20 | 1.7 | 14.29 s |

- **Torque** sets how much the rear spins up on a launch (tyre FX); the pull itself is the gear buckets below.
- **Drift** is how readily boost at full lock kicks the tail out and how long the slide runs before the assist catches it.
- **Mass** sets the launch and brake feel through `gears` / `brake`; collision masses stay the shared rig's, so a truck does not yet shove harder in a hit.
- **Monster truck**: the body and wheels ride a visual lift; masses, hulls and contacts stay at stock height (a deliberate visual cheat).
- **No tank.** The deformation rig, hulls and part list are one car platform; a tank needs tracks, a turret and skid-steer contact that the rig cannot express, so a tank would be a sedan that pivots in place.

Fleets cycle slots sedan, hatchback, wagon, coupe (muscle), pickup (truck), monster; slot 0 is the player's pick (HUD → Driving → Car).
Race AI plans with `classStats(id)` and `cornerSpeed(stats, radius, grip)`.

## Acceleration

Each class has 4 or 5 gear buckets (`ClassStats.gears`): a gear's top end as a share of the class top speed, and a fixed
thrust (m/s²) that falls with each shift. No clutch or revs; the pull steps down at every shift. Each gear has an arcade
and a realistic thrust, lerped by `HANDLING.realism` (no extra knob). Boost multiplies the thrust ×1.55–1.6 and lifts the
top ×1.2–1.22, pulling on in top gear past the class top. In a race, drafting another car lifts the top a further ×1.02
while it lasts (`DRAFT.top`, `applyDrive`'s `topScale`; see RACE_DESIGN.md "Drafting"): 257 km/h on a boosted muscle car
in a draft, the fastest a driven car goes (`barrier.test.ts` crashes every hit up to it).

| Class | Gear top ends (× top) | Thrust per gear, arcade (m/s²) | Thrust per gear, realistic (m/s²) |
|---|---|---|---|
| Sedan | 0.24 / 0.42 / 0.6 / 0.8 / 1 | 17.2 / 10.7 / 6.1 / 3.5 / 2.0 | 6.9 / 4.3 / 2.44 / 1.93 / 1.1 |
| Muscle | 0.24 / 0.42 / 0.6 / 0.8 / 1 | 20.4 / 12.7 / 7.7 / 4.7 / 2.8 | 9.2 / 5.73 / 3.47 / 2.43 / 1.45 |
| Truck | 0.3 / 0.53 / 0.76 / 1 | 16.3 / 7.8 / 4.3 / 1.8 | 5 / 2.48 / 2.2 / 1.08 |
| Monster | 0.3 / 0.53 / 0.76 / 1 | 17.1 / 11.5 / 5.0 / 1.8 | 8.4 / 5.65 / 2.45 / 0.88 |

Measured full-throttle runs (`vehicle-classes.test.ts` launch, 1/120 s steps), 0–100 km/h and time to top, at the arcade
end, the default slider (0.25) and the realistic end:

| Class | 0–100 km/h: 0 / 0.25 / 1 | Time to top: 0 / 0.25 / 1 |
|---|---|---|
| Sedan | 2.43 / 2.87 / 6.08 s | 11.9 / 13.6 / 24.0 s |
| Muscle | 1.93 / 2.24 / 4.30 s | 9.4 / 10.8 / 19.0 s |
| Truck | 2.48 / 2.99 / 7.89 s | 12.6 / 14.3 / 25.7 s |
| Monster | 1.97 / 2.25 / 4.00 s | 11.3 / 12.9 / 23.1 s |

The realistic end gives the sourced figures below: the published 0–60 mph as 0–100 km/h, time to top about 2× the arcade
end. The arcade end scales them about × 0.4 (0–100) and × 0.5 (time to top), first gear as punchy as the old single-curve
launch, the real order kept (muscle and monster quickest, truck slowest off the line), then nudged so every class laps alike:

| Class | Real vehicle | Gears | 0–60 mph | Longer run | Top speed | Source |
|---|---|---|---|---|---|---|
| Sedan | 2018 Honda Accord Sport 2.0T manual | 6 | 6.1 s | 0–100 mph 15.3 s, 0–120 mph 21.8 s | 201 km/h (governed) | [Car and Driver](https://www.caranddriver.com/reviews/a15078684/2018-honda-accord-sport-20t-manual-test-review/) |
| Muscle | 2018 Ford Mustang GT manual | 6 | 4.3 s | 0–100 mph 9.7 s, 0–130 mph 16.4 s | 249 km/h (governed) | [Car and Driver](https://www.caranddriver.com/reviews/a14500071/2018-ford-mustang-gt-manual-test-review/) |
| Truck | 2026 Toyota Tacoma TRD Off-Road manual | 6 | 7.9 s | 0–100 mph 21.6 s | 174 km/h (governed) | [Car and Driver](https://www.caranddriver.com/reviews/a70173539/2026-toyota-tacoma-trd-off-road-manual-test/) |
| Monster | Monster Jam truck, ~1500 hp, 12,000 lb | 2 | under 4 s (quoted, not measured) | 80 mph in 500 ft | 113 km/h | [Monster Jam](https://www.monsterjam.com/en-us/education/fun-facts/), [MotorTrend](https://www.motortrend.com/features/what-is-monster-jam-all-about-monster-truck-racing), [Car and Driver](https://www.caranddriver.com/features/a23807573/monster-trucks-monster-jam-university/) |

Solo laps at the default slider (race AI, seed 1, best of 3; "seat" is the scripted full-gas line driver through the
player's seat), s and % off the four-class mean:

| Course | Driver | Sedan | Muscle | Truck | Monster |
|---|---|---|---|---|---|
| Oval | AI | 17.00 (−1.7) | 17.17 (−0.8) | 17.27 (−0.2) | 17.76 (+2.7) |
| Oval | seat | 18.89 (−5.3) | 20.36 (+2.1) | 19.52 (−2.2) | 21.03 (+5.4) |
| Rally | AI | 26.53 (−1.0) | 26.56 (−0.9) | 26.95 (+0.6) | 27.14 (+1.3) |
| Rally | seat | did not finish | 33.59 (−5.2) | 36.14 (+2.0) | 36.56 (+3.2) |
| City | AI | 26.06 (−0.9) | 24.67 (−6.2) | 27.58 (+4.9) | 26.85 (+2.1) |
| City | seat | 30.21 (+2.8) | 27.99 (−4.8) | 30.47 (+3.6) | 28.93 (−1.6) |
| Stunt | AI | 29.93 (−0.5) | 29.69 (−1.3) | 30.27 (+0.6) | 30.44 (+1.2) |
| Stunt | seat | 25.80 (−5.7) | 27.23 (−0.4) | 26.80 (−2.0) | 29.55 (+8.1) |

City has traffic: the muscle and truck AI each died once there (best laps 24.67 and 27.58 s, their other laps 29.30/28.92 and 34.58/30.54 s). The scripted seat is a full-gas line, not a racer: at 200 km/h its sedan does not finish the rally, and its truck and monster finish 2 of 3 laps inside the run's time limit.

## Arcade handling

- **Instant response**: pedals and wheel ramp in well under 0.3 s; the yaw rate follows the wheel each slice.
- **Speed-sensitive steering**: lock fades with speed (never under 40 %), and grows from zero through a crawl, so the car never pivots on the spot.
- **Slides**: Space at speed with lock kicks the tail out; boost at full lock does it on tail-happy classes. Keep the gas on with lock either way (a counter-steer short of full opposite lock included) and the drift assist holds the body angle while the car carries its speed round; release the wheel or lift off and it catches itself. Full opposite lock catches it twice as fast.
- **Boost** multiplies the gear thrust ×1.55–1.6 and the top speed ×1.2–1.22 (see Acceleration).
- **Draft** (race mode only): in another racer's trail the top speed is ×1.02, the thrust unchanged, so a car already flat out creeps up on the one ahead.
- **Recovery**: a driven car stuck on its roof or side rights itself after 1.2 s at the arcade end (3 s at mid slider); past 0.6 only R rights it.
- **Surface grip** comes from the active `Ground` (`frictionAt`) under each axle: low front grip loses steering, low rear grip loses traction and launches with wheelspin.
- Tyre FX read `car.drive.spin` (launch wheelspin), `lock` (brake lock-up) and `slide` (sideways slip), each 0–1.
- **Speed readouts** (sandbox HUD, race HUD, piston and door rig sliders) read mph when the browser's locale region is the US, km/h everywhere else (`speed-units.ts`, `useSpeedUnit`); physics stays in m/s.

## Air, slopes and springs

On a course's ground (a race track, the fleet ramps, the corkscrew; not the flat pad or the fleet disc):

- **Slope gravity.** A grounded car feels gravity along the ground, `v.xz += g · n.y · n.xz · dt`: none on the level, it slows a car uphill and speeds it downhill.
- **Ground support** (`DeformableCar.integrate`): the ground only pushes up, and at most `SUPPORT` (8 g, `car-air.ts`). Where one slice's push does it, the body stays on its support (the centre's ground, or the axle chord across a hollow) and climbs at the support's own rate; across a step steeper than 45° (a kerb, a ramp's side) at the face's rate. Past the cap (a ramp's foot at speed, a dip's floor, a landing) the body sinks into its springs and rises back out no faster than gravity stops it at the surface (`climb + √(2 g · sunk)`, no hop). The springs' stop is their full travel below the support (2 × `droop`): there the body moves with its support and sinks no further, with no positional snap. Set onto its support in one slice instead, a ramp's foot or a landing kicked the body up at 20–36 g within one frame; capped, a ramp's foot at 32 m/s rises at ≤ 9 g (measured headless on the fleet ramps and a 1 m / 10 m crest). Landings that bottom the travel out (13 cm on a sedan) still peak at 16–26 g per frame: stopping 6.6 m/s over 13 cm needs 17 g.
- **Takeoff.** Above its support nothing holds the body: it falls under gravity, so over a crest it leaves the ground ballistically where the ground falls away faster than gravity can follow (v² κ > g: 2.3 m before a 1 m / 10 m crest's top at 20 m/s). It is flagged airborne (`DeformableCar.airborne`) once its middle is past its wheels' reach, `droop(class)` (half its spring travel: sedan 6.5 cm, monster 22.5 cm), above the ground under it. It carries the ground's last turn of its body into the air.
- **Flight** (`vehicle/car-air.ts` `stepAir`): a rigid box under gravity, turning freely about its centre of mass (0.55 m up). 16 hull points (the four tyres' lowest points, bumper, beltline and roof corners) meet the ground through impulses: restitution 0.25 for a body point closing faster than 1.5 m/s, none for tyres; friction 0.6 on the body, 0.9 across a tyre's tread (it rolls freely along it). A tyre within its springs' full travel of the ground sits in them: the four share one `SUPPORT` budget per slice and take no positional lift; past the travel, and for every body point, the contact is rigid and lifts the point out. No drive or grip in the air. A driven, uncrashed car's nose follows its flight path (arcade) while it is under 30° off it and faster than 6 m/s; the roll stays free.
- **Landing.** Back on the ground sim when two wheels are within 3 cm of the ground, the middle within `droop` of it and the body within ~25° of its slope (up · n > 0.9). Nothing snaps: the ground support takes the body where and as it is, and lays a driven body on its slope. On its roof or side it rests on the hull points until recovery rights it.
- **Wrecks.** A wreck rides on its masses (`deform-contact.ts` `followGroup`): on its ground its frame keeps the body's middle in a band over the ground under its anchor and the hubs' floor. Its middle leaving that band by `LIFT_OFF` (0.1 m) with a wheel off its ground makes it `aloft`: every mass falls under gravity with no ground rule (`deform-solve.ts`), so a wreck slides off a ramp's lip and flies. Its vertical speed is the frame's measured climb. Once the contact window has closed (`live()`) and every hull point is clear of the ground (`hullClear`), `stepAir` flies it, fitted to its masses' motion; it goes back to its masses on landing, dents kept. A hit in the air arms the masses where the body is (a driven car starts its crash there) and leaves it flying; masses armed after `stepAir` already moved the body that slice step back by it (`unstep`), so the slice moves it once. Before these rules a car struck mid-air dropped 1.85 m to the ground in one frame, a wreck never left a ramp's lip, and two wrecks touching in flight fell at twice their speed.
- **Height-aware car contact.** Two cars touch only where their body boxes (`CAR_HALF`, tilted) overlap in height (`contact/sat.ts` `shareHeight`): a car flying 2 m over another never hits it (before: 150 pair hits).
- **What a wreck reports, and who reads it.** A resting wreck reads vertical speed 0 (the hub average it replaced read up to 4 m/s at rest, and half the true climb up a ramp's face). Nothing in the sim reads it on the ground except the loose parts that inherit it; the derby tests did: their slice width came from `car.speed`, the length of the whole velocity, so a micro-difference in a wreck's vertical speed moved a slice in the sixth digit and a heat decohered (first divergence at 0.87 s of a 10-car heat; every later death time differed). Derby results are therefore chaotic in any such change, and a seed pick flips (six-car eliminations, 3 of 5 and 5 of 5 under two such changes): `derby.test.ts` measures the elimination rate over seeds 1–20 instead (main 14/20, this lane 13/20).
- **Corkscrew landing.** The touchdown roll is the lip's spin (189°/s, unchanged) times the air: at 27 m/s the lane flies 3.15 s against 3.05 s (the body leaves the lip 0.9 m sooner, on a 0.53 grade at 14.4 m/s up rather than 0.49 at 13.4). 26 / 26.5 / 27 / 27.5 / 28 m/s touch down at 508 / 572 / 596 / 619 / 645° (main 540 / 558 / 576 / 599 / 620°). The sink after takeoff is bounded by the springs' stop, `2 × droop` (13 cm for a sedan), which a hard landing reaches.
- **Ballistic continuity** (the 2 cm rule: each 1/60 s frame's rise must lie within `[min(vy₀, vy₁)·Δt − 2 cm, max(vy₀, vy₁)·Δt + 2 cm]` of the reported vertical speeds; main's 8 cm rule is the same with the mean). Flagged frames, main b89ebeb → this lane: fleet head-on 40/20 308 → 0, stunt race 5064 → 85, rally 9373 → 6, city 9070 → 0 (the two left are an in-place respawn, which the probe skips by hooking `spawnFacing`), oval 2747 → 0, derby heat 2951 → 0, corkscrew 27 m/s 69 → 0, fleet jumps 0. Every one left is one of four classes: *arming* (the frame a crash arms the masses, where the band lifts a body that sank into its springs up to the ground: ≤ 6.5 cm, once per car per crash), *impulse* (a hit or a landing changes the reported speed by more than g·Δt + 0.5 m/s inside the frame; the rule cannot bracket a velocity step), *ground contact in flight* (a hull point resolved against the ground: ≤ 0.6 cm) and *in-band jitter* (a wreck on its ground reports the climb of the last ≥ 4 ms of its frame, one sample of a path that moves smoothly over the frame: ≤ 4.3 cm headless, 5.6 cm in the browser's slow 42 ms frame). A report averaged over a whole frame removes that last class but reads stale vertical speed on a wreck at rest (the D2 rest test), so it was not taken.

**Drawn suspension: the body bounces visually; physics keeps no spring state.** `vehicle/car-suspension.ts` `Suspension` keeps one spring and damper per wheel and moves only the drawn body (the class lift group: heave, pitch, roll) over the physics frame. Hulls, masses, contacts, wheels, grip, flight and landings never read it, so the sim and its digests are the same with or without it; physics reads only the class's travel (`droop`) for the ground support's stop and the wheels' reach, and the springs show what the support's capped push leaves. A spring's input is the change in its wheel's vertical speed on the ground pose (a landing, a ramp's foot, a crest), clamped at half the travel each way; in free flight body and wheels fall together, and a crash puts the body back on its stock ride. Netplay clients run it themselves from the host's poses.

| Class | Ride (Hz) | Damping ζ | Travel (m) | 14 m/s ramp landing: peak bump | Under 1 cm after |
|---|---|---|---|---|---|
| Sedan | 1.3 | 0.30 | 0.13 | 6.5 cm (stop) | 1.02 s |
| Muscle | 1.6 | 0.30 | 0.11 | 4.1 cm | 0.87 s |
| Police | 1.5 | 0.35 | 0.13 | 6.5 cm (stop) | 0.65 s |
| Truck | 1.1 | 0.25 | 0.22 | 11.0 cm (stop) | 1.65 s |
| Monster | 0.8 | 0.35 | 0.45 | 22.5 cm (stop) | 1.87 s |

Measured by `scenes/fleet-ramps.test.ts` with the capped ground support (the sill stays ≥ 0.197 m off the ground in every class). Monster ζ 0.20 still swung 1 cm 2.4 s after that landing, 0.30 for 2.3 s.

**Drawn wheels sit on the ground.** The physics frame is one plane (the ground's normal under the car), so on a crest, a twist or across a banked road's edge some wheels would float or sink; `Suspension` also seats each drawn wheel on the ground under its tread (the crown's bottom arc ±29° and its shoulders, `TREAD`), up to the full travel below the body and `stop` above it, beyond which the wheel lifts that corner of the drawn body. In the air the wheels ease back onto their hubs (15/s). Drawn only: every crash, fleet, derby, oval and city digest is identical. `vehicle/bank-wheels.test.ts` drives a sedan and a monster through stunt's 18° bank on the low edge, centre and high edge: every tread within 2 cm of the ground (main b89ebeb: the low edge sank tyres 10.8 cm).

**Drawn load transfer: launches squat, brakes dive, corners roll.** `vehicle/car-load.ts` `LoadTransfer` reads the ground pose's horizontal acceleration off `group.matrixWorld` across slices (the way `Suspension` reads vertical speed: smoothed over 0.06 s, cut at 80 m/s², reset by a teleport faster than 100 m/s, zero in the air) and holds the four springs' resting offsets at the weight shift it implies: per wheel Δ = 2 a h / (L k) along the nose and 2 a h / (T k) across, with the class's CG height h, wheelbase L, track T and spring k, saturated (`tanh`) at the class's pitch and roll limit (sedan 1.5° / 3°, muscle 1.8° / 3°, police 1.5° / 3°, truck 2.2° / 3.4°, monster 3.5° / 4°) so a landing keeps room in the travel. The rear squats and the nose rises under throttle, the nose dives under braking, the body leans outward in a turn; a stopped or steady-straight car is level. Measured on flat ground at full throttle, full brake from 25 m/s and full lock at 20 m/s (the springs overshoot the limit by about a third): sedan 2.0° launch pitch, 2.1° brake dive, 4.0° roll (3.0° settled); muscle 2.2 / 2.4 / 3.8; truck 3.2 / 3.2 / 4.9; monster 4.6 / 4.6 / 5.2; police 1.8 / 2.0 / 3.9. Drawn only and a few adds per slice (0.3 µs per car-slice), so it needs no FX gate; the drive model, launch timing (0-50 km/h: sedan 0.97 s, muscle 0.78 s, truck 1.02 s, monster 0.92 s, police 0.97 s) and every digest are untouched.

**Camera ride.** `DriveCam` (the chase, far-chase and hood shots of `frameDrive`) rides a share of the followed car's drawn heave and pitch (`Suspension.heave`, `.pitch`): the eye drops and tips up under a squat or a landing, lifts and tips down under a dive; a chase eye behind the body's pivot sinks with nose-up, the hood cam ahead of it rises. Soft-bounded (`tanh`) under 4 cm and 0.6°, eased at 12/s, let go while the player holds a look offset. It costs 0.0004 ms a frame, so it is on at every FX tier but "off" (and off under reduced motion); the crash cam, reel, ragdoll ride-along, orbit and user-framed views never ride. `vehicle/car-load.test.ts` holds the launch/brake/turn/stopped signs and the camera bounds.

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
