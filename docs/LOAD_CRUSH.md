# Load crush: a face yields under the load on it

Status: new. Measured on main `533b388` plus this lane, headless, 60 Hz frames, sedan, flat pad (`.bench/stack-probe.ts`,
`.bench/drop-probe.ts`; the same numbers are pinned by `vehicle/stack-crush.test.ts`).

## Mechanism

Before, a car's body crushed only from **impact impulse** (`applyImpact`, `feedOverlap`: the SAT pair, the barrier, the
press and pistons). A body in rigid flight (`stepAir`) met the ground or another car rigidly: nothing deformed, a car
dropped on its roof from 2 m kept its roof, and a car over another car (plan SAT only) was shoved off it.

Now `stepAir` meets a body's five faces (roof, nose, tail, left, right: `deform/load-crush.ts`) through a **strength law**,
the force a face carries at a crush depth `d`, in car weights `W = m·g`: `W·(y0 + k·d + q·d²)`.

- A contact on a face (the ground, or another car's top: `vehicle/car-surfaces.ts`, a `Ground` that adds every other
  car's top to the world's) may pass at most `strength(face, d) · g · dt` of impulse per slice, shared by every contact
  on that face (the way `SUPPORT` is shared by the four tyres). A contact past it **yields**.
- A yielding face's deepest penetration becomes crush depth `d` (permanent, `crush[face]`); the body points move in by
  `d`, and the masses that follow the face (`faceFollow`: the roof mass for the roof, the bumpers and engine for the
  nose) are baked in by `bakeLoadCrush`, which re-skins the car once (`update`: `loadDirty`). The skin's 0.1 m roof clamp
  lifts when the roof mass is sunk past 7.5 cm, as a squeeze's does.
- A face that has reached its packed depth (`faceMax`) is rigid and lifts the body as before; a contact the face can
  carry never yields (at rest under 0.5 W a roof does not move).
- A car resting on another car's top presses it back (`CarSurfaces.press`): the lower car takes the upper's reaction as a
  velocity change, so the bottom roof carries every car above it, and a car's yield is judged against **its own** weight
  in the lower car's roof (`mOwner / mSelf`). A car carried this way stays in `stepAir` (`land` tests the world's ground
  only) and `restsOn` keeps the plan SAT from shoving it off its carrier (`shareHeight`).
- Sleeping stack: a body `stepAir` freezes at rest costs one slice per step like any resting wreck in flight.

One rule for every face; stacks are not special-cased (a stack is `restsOn` plus the roof's law). The ground, the press,
pistons, the barrier and the pair SAT are untouched.

### Strength laws, numbers and sources

| face | `y0` (W) | `k` (W/m) | `q` (W/m²) | packed (m) | source |
|---|---|---|---|---|---|
| roof | 0.5 | 15 | 45 | 0.45 | FMVSS 216 (roof strength): 3 W within 127 mm of platen crush. 0.5 + 15·0.127 + 45·0.127² = **3.13 W**. One car's weight settles at **31 mm**, two at 81 mm, three at 122 mm, four at 158 mm (static). 0.45 m: the cabin's height under the roof cage. |
| nose | 15 | 97 | 0 | 0.55 | `CRUSH_CALIBRATION.md`: 56 km/h into a wall, 0.37 m stroke, 104 kJ at 860 kg: mean 33 W over the stroke; 15 + 97·0.185 = 33 W. Packed at the rig's front `maxCrush`. |
| tail | 15 | 150 | 0 | 0.38 | same yield; the rig's shorter, stiffer rear stroke (`maxCrush` 0.38 m). |
| flank | 8 | 160 | 0 | 0.30 | `RIG_ANALYSIS.md`: the door band, 0.12-0.28 m at 50 km/h. |

FMVSS 216 is a quasi-static *minimum* (a car need only carry 3 W), so one car's weight (1 W) gives modest crush (31 mm)
and the same law under impact gives the numbers below: the work a drop does is `W·(h + d) = ∫F dd`.

## Before (main `533b388`): no load crush

| scenario | roof / face crush |
|---|---|
| car dropped on its roof from 0.5 / 1 / 2 m | **0 / 0 / 0 mm** (rigid contact; a roof under a car stays at rest) |
| nose / tail / side / corner drops from 0.5 / 1 / 2 m | **0 mm** on every face |
| 2 cars, the upper 2 cm over the lower | lower roof **0 mm**; the upper slides off, both end on the ground 1.7 m apart |
| 3 and 4 cars | roofs **0-70 mm**, every car on the ground; the SAT shoved them apart and crashed them (the 70 mm is the crash solver's own roof sag cap) |

## After

Stack, aligned, each car dropped 2 cm onto the roof below (bottom car first), settled 8 s, then 5 s more:

| cars | bottom | 2nd | 3rd | top | drift in 5 s more |
|---|---|---|---|---|---|
| 2 | 38 mm | 0 | | | 0.0000 m |
| 3 | 119 mm | 76 mm | 0 | | 0.0000 m |
| 4 | **189 mm** | 145 mm | 96 mm | **0 mm** | 0.0000 m (position and roof) |

Strictly increasing from the top; the bottom roof under three cars lands in the **0.12-0.26 m** band the test states
(FMVSS 216's static 122 mm for 3 W, plus the overshoot of the cars' 2 cm fall: dropping a load deforms more than setting
it down, `W·h` extra work). Frame rate: the same 4-stack at 60 / 144 / 240 Hz reads 189 / 189 / 188 mm (bottom),
145 / 145 / 147 (2nd), 96 / 95 / 95 (3rd), top 0 (the contact is solved at 480 Hz, `CONTACT_HZ`, whatever the frame rate).

A car dropped on a face, 60 Hz, crush after settling (mm):

| drop | 0.5 m | 1 m | 2 m |
|---|---|---|---|
| upside-down, roof | 244 | 318 | 412 (packed at 450) |
| nose first (stands on its nose, then falls over onto its roof: roof 358 mm) | nose 28 | 59 | 98 |
| tail first | tail 27 | 57 | 90 |
| left / right flank | 74 | 94 | 149 |
| corner (nose + left, pitch 60°, roll 45°) | nose 29 | 46 | 96 |

Opposite faces stay at 0 (nose drop: tail 0; left: right 0). Rates 60 / 144 / 240 Hz: roof at 0.5 m 244 / 244 / 243 mm;
the flanks vary 6 %.

## Cost

- A stack at rest: 0.07 ms per physics slice for four cars (three in flight), 0.29 ms per 60 Hz frame (4 slices) and 0.07
  ms at 240 Hz. `CarSurfaces.top` reads a 0.1 m height grid per body style (built once), not the loft.
- A step where a body in flight is near a contact runs at 480 Hz (`stepWorld`: up to 8 slices); resting bodies and cars
  with no flight cost what they cost before. No allocation in `stepAir`, `CarSurfaces` or `bakeLoadCrush`.
- The one-off re-skin after a face grows: `loadDirty`, one `bakeLocalSkin` + `solveCages` + `flushSkin`.

## Limits (not done)

- Load crush lives in `crush[]` and the baked masses, not in `simState` or the netplay wreck section: a netplay client
  and a highlight replay from a keyframe do not show it, and a replayed run re-derives it only from the recorded inputs.
- A wreck (`massActive`) keeps its lattice: it takes no load crush, and a car that load-crushed and is then hit re-fits its
  shape-match rests to the undamaged shape (the roof's vertical cap keeps its sag: `maxLift`).
- Forces between stacked cars are vertical only: a tilted pair does not pass friction to the car below, and there is no
  rigid-body torque on the carrier.

## Debug

`window.__crush.dropStack(n)` stands `n` cars (default 4) one over the other on the origin, each 2 cm over the roof below;
watch the roofs settle by the weight on them (sandbox scenes).
