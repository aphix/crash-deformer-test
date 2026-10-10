# Handling

How cars drive, what each class is like, the arcade ↔ realistic slider, and how damage changes driving.
Code: `src/game/vehicle/vehicle-classes.ts` (data, slider, damage grading), `src/game/vehicle/car-drive.ts` (`applyDrive`,
`DriverSeat`), `src/game/vehicle/drive-input.ts` (keyboard / pad feel). Tests: `vehicle-classes.test.ts`,
`drive-input.test.ts`, `gamepad.test.ts`. Every control: `docs/CONTROLS.md`.

Reverse steers like a real car: holding A while backing swings the tail left.

## Classes

Every class runs the same stat budget: whatever it gains on the straights it pays back in the corners
(`vehicle-classes.test.ts` laps each class on a 313 m mixed loop with two 8 m hairpins and two 24 m sweepers).

| Class | Body | Mass | Top | Gears | Turn (rad/s) | Grip (m/s²) | Drift | Durability |
|---|---|---|---|---|---|---|---|---|
| Sedan | sedan, hatchback, wagon | 1400 kg | 200 km/h | 5 | 1.55 | 39 | 0.35 | 1.0 |
| Muscle | coupe | 1650 kg | 210 km/h | 5 | 1.36 | 35.5 | 0.85 | 1.15 |
| Truck | pickup | 2100 kg | 195 km/h | 4 | 1.50 | 38.5 | 0.25 | 1.25 |
| Monster | pickup on big wheels, lifted body | 2900 kg | 190 km/h | 4 | 1.30 | 37 | 0.20 | 1.7 |
| Police | the sedan's drive on the police body | 1400 kg | 200 km/h | 5 | 1.55 | 39 | 0.35 | 1.3 (AI units only) |

- **Drift** is how readily boost at full lock kicks the tail out and how long the slide runs before the assist catches it.
- **Mass** sets the launch and brake feel through `gears` / `brake`; collision masses are the shared rig's.
- **Monster truck**: the body and wheels ride a visual lift; masses, hulls and contacts stay at stock height (a deliberate
  visual cheat).
- A police cruiser in the player's slot keeps the sedan's kill limits; only AI police units are tougher.

Fleets cycle slots sedan, hatchback, wagon, coupe (muscle), pickup (truck), monster; slot 0 is the player's pick
(HUD → Driving → Car). Race AI plans with `classStats(id)` and `cornerSpeed(stats, radius, grip)`.

## Acceleration

Each class has 4 or 5 gear buckets (`ClassStats.gears`): a gear's top end as a share of the class top speed, and a fixed
thrust (m/s²) that falls with each shift. No clutch or revs; the pull steps down at every shift. Each gear has an arcade
and a realistic thrust, lerped by `HANDLING.realism`. Boost multiplies the thrust ×1.55–1.6 and lifts the top ×1.2–1.22,
pulling on in top gear past the class top. In a race, drafting lifts the top a further ×1.02 while it lasts (`DRAFT.top`;
`docs/RACE_DESIGN.md` "Drafting"). The fastest a driven car goes is a boosted muscle car in a draft, and `barrier.test.ts`
crashes every hit up to it.

| Class | Gear top ends (× top) | Thrust per gear, arcade (m/s²) | Thrust per gear, realistic (m/s²) |
|---|---|---|---|
| Sedan | 0.24 / 0.42 / 0.6 / 0.8 / 1 | 17.2 / 10.7 / 6.1 / 3.5 / 2.0 | 6.9 / 4.3 / 2.44 / 1.93 / 1.1 |
| Muscle | 0.24 / 0.42 / 0.6 / 0.8 / 1 | 20.4 / 12.7 / 7.7 / 4.7 / 2.8 | 9.2 / 5.73 / 3.47 / 2.43 / 1.45 |
| Truck | 0.3 / 0.53 / 0.76 / 1 | 16.3 / 7.8 / 4.3 / 1.8 | 5 / 2.48 / 2.2 / 1.08 |
| Monster | 0.3 / 0.53 / 0.76 / 1 | 17.1 / 11.5 / 5.0 / 1.8 | 8.4 / 5.65 / 2.45 / 0.88 |

Launch targets (`vehicle-classes.test.ts` `LAUNCH`, full throttle at 1/120 s steps): 0–100 km/h and time to top at each
end of the slider. The realistic end is the sourced 0–60 mph read as 0–100 km/h, time to top about 2× the arcade end;
the arcade end is about × 0.4 and × 0.5 of those, the real order kept (muscle and monster quickest, truck slowest off the line).

| Class | 0–100 km/h, arcade / realistic | Time to top, arcade / realistic |
|---|---|---|
| Sedan | 2.45 / 6.1 s | 12 / 24 s |
| Muscle | 1.95 / 4.3 s | 9.5 / 19 s |
| Truck | 2.5 / 7.9 s | 12.7 / 25.7 s |
| Monster | 2 / 4 s | 11.5 / 23.1 s |

| Class | Real vehicle | 0–60 mph | Top speed | Source |
|---|---|---|---|---|
| Sedan | 2018 Honda Accord Sport 2.0T manual | 6.1 s | 201 km/h (governed) | [Car and Driver](https://www.caranddriver.com/reviews/a15078684/2018-honda-accord-sport-20t-manual-test-review/) |
| Muscle | 2018 Ford Mustang GT manual | 4.3 s | 249 km/h (governed) | [Car and Driver](https://www.caranddriver.com/reviews/a14500071/2018-ford-mustang-gt-manual-test-review/) |
| Truck | 2026 Toyota Tacoma TRD Off-Road manual | 7.9 s | 174 km/h (governed) | [Car and Driver](https://www.caranddriver.com/reviews/a70173539/2026-toyota-tacoma-trd-off-road-manual-test/) |
| Monster | Monster Jam truck, ~1500 hp, 12,000 lb | under 4 s (quoted) | 113 km/h | [Monster Jam](https://www.monsterjam.com/en-us/education/fun-facts/), [MotorTrend](https://www.motortrend.com/features/what-is-monster-jam-all-about-monster-truck-racing) |

## Arcade handling

- **Instant response**: pedals and wheel ramp in well under 0.3 s; the yaw rate follows the wheel each slice.
- **Speed-sensitive steering**: lock fades with speed (never under 40 %), and grows from zero through a crawl, so the car
  never pivots on the spot.
- **Slides**: Space at speed with lock kicks the tail out; boost at full lock does it on tail-happy classes. Keep the gas on
  with lock either way and the drift assist holds the body angle while the car carries its speed round; release the wheel or
  lift off and it catches itself. Full opposite lock catches it twice as fast.
- **Draft** (race mode only): in another racer's trail the top speed is ×1.02, the thrust unchanged.
- **Recovery**: a driven car stuck on its roof or side rights itself after 1.2 s at the arcade end, slower toward mid
  slider; past 0.6 only R rights it.
- **Surface grip** comes from the active `Ground` (`frictionAt`) under each axle: low front grip loses steering, low rear
  grip loses traction and launches with wheelspin. Tyre FX read `car.drive.spin`, `lock` and `slide`, each 0–1.
- **Speed readouts** read mph when the browser's locale region is the US, km/h everywhere else (`speed-units.ts`); physics
  stays in m/s.

## Air, slopes and springs

- **Slope gravity.** A grounded car feels gravity along the ground: none on the level, it slows a car uphill and speeds it
  downhill.
- **Ground support** (`DeformableCar.integrate`): the ground only pushes up, and at most `SUPPORT` (8 g, `car-air.ts`). The
  body stays on its support (the centre's ground, or the axle chord across a hollow) and climbs at the support's rate; past
  the cap (a ramp's foot at speed, a landing) it sinks into its springs and rises back out no faster than gravity stops it.
- **Takeoff.** Where the ground falls away faster than gravity can follow (v²κ > g), the car leaves it ballistically and is
  `airborne` once its middle is past its wheels' reach (`droop(class)`, half its spring travel). It carries the ground's last
  turn into the air.
- **Flight** (`car-air.ts` `stepAir`): a rigid box under gravity; hull and belly points meet the ground through impulses
  (restitution 0.25 on the body, none for tyres; tyres roll along their tread). No drive or grip in the air; a driven,
  uncrashed car's nose follows its flight path while under 30° off it.
- **Landing** hands the body back to the ground sim when two wheels are within reach and the body is within about 25° of the
  slope, with the touchdown frame already on the ground's pose (`car-support.ts` `landPose`).
- **Wrecks** ride on their masses (`deform-contact.ts` `followGroup`); once the contact window has closed and every hull
  point is clear, `stepAir` flies the wreck and gives it back to its masses on landing, dents kept.
- **Height-aware car contact.** Two cars touch only where their cages' heights overlap by more than `VERTICAL_CLEAR` at the contact
  (`contact/cage-outline.ts` `bandsMeet`, and per outline node in `satCars`).
- **Resting** (`car-support.ts`): a car under 3 m/s whose pose would put a tyre or its hull under the ground takes the rest
  plane instead, the lowest the middle can stand with every tyre, underside point and bumper corner above its own ground.
- **Ramps are ground and wall by one rule** (`FleetRamps.onFace`): a point stands on a wedge's face while the face is at most
  a tyre's mount height above it, else it is in the wall, which pushes the car out at most 5 cm a slice. An axle straddling
  a wall rides on its lower tyre (`axleGround`, `AXLE_STEP` 0.1 m).

**Drawn suspension** (`car-suspension.ts` `Suspension`): one spring and damper per wheel moves only the drawn body (heave,
pitch, roll) and seats each drawn wheel on the ground under its tread. Hulls, masses, contacts, wheels, grip, flight and
landings never read it, so the sim and its digests are the same with or without it. `car-load.ts` `LoadTransfer` adds the
squat, dive and roll of the ground pose's acceleration, capped per class.

| Class | Ride (Hz) | Damping ζ | Travel (m) |
|---|---|---|---|
| Sedan | 1.3 | 0.30 | 0.13 |
| Muscle | 1.6 | 0.30 | 0.11 |
| Police | 1.5 | 0.35 | 0.13 |
| Truck | 1.1 | 0.25 | 0.22 |
| Monster | 0.8 | 0.35 | 0.45 |

Drawn wheels turn with the signed ground speed over their own radius at their own contact point; a dead drivetrain
freewheels, the handbrake stops the rear pair, and in the air a wheel keeps its last rate under bearing drag
(`wheel-spin.test.ts`). A wreck missing wheels lies on its body corners (`wheel-rest.test.ts`).

## The arcade ↔ realistic slider

`HANDLING.realism`, HUD → Driving → Realism (default 0.25).

| | Arcade (0) | Realistic (1) |
|---|---|---|
| Lateral grip | class grip | × 0.62 (understeers at the limit) |
| Drift assist | holds the body to ≤ 0.62 rad, catches at 4.5/s | off: the slide is yours to hold, catches at 1.1/s |
| Speed through a slide | 80 % of the scrubbed sideways speed returns to the nose | all scrubbed |
| ABS | hides most lock-up | full lock-up |
| Self-righting | after 1.2 s | R only (from 0.6 up) |
| Damage losses | × 0.55 | × 1 |
| Engine-kill travel (sedan) | 0.55 m | 0.15 m (sourced) |

Kill travel per class (`killTravel`) is `0.15 m × durability` at the realistic end and `0.55 m × (1 + (durability − 1) / 2)`
at the arcade end, capped at 0.63 m (`KILL_CEILING`): the engine block reaches about 0.64 m by accumulated wrecking, so even
a monster truck can still be killed. At the realistic end a sedan dies on the first wall hit over about 50 km/h.

A derby car's kill limits (`armKill(deform, cls, realism, "derby")`) are `DERBY_KILL_SCALE` (0.7935) of that travel plus a
wear limit, `DERBY_WRECK_ENERGY` (250 m²/s²: every hit's EBS² capped at 36, summed over all ends); the travel share and the
wear share add. Race and fleet keep the travel alone and no wear limit.

## Damage → drivability

From `deform.drivetrainHealth` (1 − block travel / kill travel), `deform.wheelsOn` and whether the car has crashed:

| Stage | When | Effect (realistic end; arcade × 0.55) |
|---|---|---|
| Healthy | never hit | none |
| Dented | crashed, health > 0.6, all wheels | cosmetic only |
| Damaged | health 0.25–0.6, or one wheel off | up to −12 % top speed, power −16 %, pulls toward the struck side |
| Limping | health < 0.25, or two wheels off | up to −26 % top speed, stronger pull, smoke |
| Dead | block travel past the kill travel, all four wheels off, or derby elimination | no drive |

A car short of dead never drops below 60 % of its class top speed (`LIMP_FLOOR`).

**Wheels off** (`vehicle/wheel-loss.ts`, one rule for the player and every AI through `applyDrive`). Every class drives all
four wheels. Steering is the front wheels' share (both gone: none, one gone: half the lock), thrust is wheels on / 4 and top
speed its square root, brakes are the wheels on with the fronts taking 60 %, an axle with both wheels off keeps 35 % of its
sideways grip, every lost wheel scrapes the body for 0.5 m/s², and the handbrake needs a rear wheel to lock.

A dented car under power drives on its tyres: the sliding-wreck ground drag (`groundMasses`, `bleedAfterSlide`) only slows
a coasting or dead wreck.
