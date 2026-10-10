# Load crush: a face yields under the load on it

A body's faces crush under a **load**, not only under an impact: a car dropped on its roof flattens it, and a stack of
cars crushes the bottom roof by the weight above it. `vehicle/stack-crush.test.ts` pins the numbers below (headless,
sedan, flat pad).

## Mechanism

Impact crush comes from impact impulse (`applyImpact`, `feedOverlap`: the SAT pair, the barrier, the press and pistons).
Load crush is how `stepAir`, the rigid flight step, meets a body's five faces (roof, nose, tail, left, right:
`deform/load-crush.ts`): through a **strength law**, the force a face carries at a crush depth `d`, in car weights
`W = m·g`: `W·(y0 + k·d + q·d²)`.

- A contact on a face (the ground, or another car's top: `vehicle/car-surfaces.ts`, a `Ground` that adds every other
  car's top to the world's) may pass at most `strength(face, d) · g · dt` of impulse per slice, shared by every contact
  on that face (the way `SUPPORT` is shared by the four tyres). A contact past it **yields**.
- A yielding face's deepest penetration becomes crush depth `d` (permanent, `crush[face]`); the body points move in by
  `d`, and the masses that follow the face (`faceFollow`: the roof mass for the roof, the bumpers and engine for the
  nose) are baked in by `bakeLoadCrush`, which re-skins the car once (`update`: `loadDirty`). The skin's 0.1 m roof clamp
  lifts when the roof mass is sunk past 7.5 cm, as a squeeze's does.
- A face that has reached its packed depth (`faceMax`) is rigid and lifts the body; a contact the face can carry never
  yields (at rest under 0.5 W a roof does not move).
- A car resting on another car's top presses it back (`CarSurfaces.press`): the lower car takes the upper's reaction as a
  velocity change, so the bottom roof carries every car above it, and a car's yield is judged against **its own** weight
  in the lower car's roof (`mOwner / mSelf`). A car carried this way stays in `stepAir`; the plan SAT leaves it alone because the
  two cages' heights do not overlap at the contact.
- A step runs at 480 Hz (`stepWorld`: up to 8 slices, `CONTACT_HZ`) only while a body in flight touched something last
  slice (`contactHz`); free flight, a body frozen at rest, and every car with no flight cost what they cost otherwise. No
  allocation in `stepAir`, `CarSurfaces` or `bakeLoadCrush`.

One rule for every face; stacks are not special-cased (a stack is `restsOn` plus the roof's law).

### Strength laws, numbers and sources

| face | `y0` (W) | `k` (W/m) | `q` (W/m²) | packed (m) | source |
|---|---|---|---|---|---|
| roof | 0.5 | 15 | 45 | 0.45 | FMVSS 216 (roof strength): 3 W within 127 mm of platen crush. 0.5 + 15·0.127 + 45·0.127² = **3.13 W**. One car's weight settles at **31 mm**, two at 81 mm, three at 122 mm, four at 158 mm (static). 0.45 m: the cabin's height under the roof cage. |
| nose | 15 | 97 | 0 | 0.55 | `CRUSH_CALIBRATION.md`: 56 km/h into a wall, 0.37 m stroke, 104 kJ at 860 kg: mean 33 W over the stroke; 15 + 97·0.185 = 33 W. Packed at the rig's front `maxCrush`. |
| tail | 15 | 150 | 0 | 0.38 | same yield; the rig's shorter, stiffer rear stroke (`maxCrush` 0.38 m). |
| flank | 8 | 160 | 0 | 0.30 | the door band, 0.12-0.28 m at 50 km/h (`docs/CRUSH_CALIBRATION.md`). |

FMVSS 216 is a quasi-static *minimum* (a car need only carry 3 W), so one car's weight (1 W) gives modest crush (31 mm)
and the same law under impact gives the numbers below: the work a drop does is `W·(h + d) = ∫F dd`.

## Bars

Stack, aligned, each car dropped 2 cm onto the roof below (bottom car first), settled 8 s, then 5 s more:

| cars | bottom | 2nd | 3rd | top | drift in 5 s more |
|---|---|---|---|---|---|
| 2 | 38 mm | 0 | | | 0 |
| 3 | 119 mm | 76 mm | 0 | | 0 |
| 4 | **189 mm** | 145 mm | 96 mm | **0 mm** | 0 (position and roof) |

Strictly increasing from the top; the bottom roof under three cars lands in the **0.12-0.26 m** band (FMVSS 216's static
122 mm for 3 W, plus the overshoot of the cars' 2 cm fall). The same 4-stack at 60 / 144 / 240 Hz reads within 2 mm.

A car dropped on a face, 60 Hz, crush after settling (mm):

| drop | 0.5 m | 1 m | 2 m |
|---|---|---|---|
| upside-down, roof | 244 | 318 | 412 (packed at 450) |
| nose first (stands on its nose, then falls over onto its roof) | nose 28 | 59 | 98 |
| tail first | tail 27 | 57 | 90 |
| left / right flank | 74 | 94 | 149 |
| corner (nose + left, pitch 60°, roll 45°) | nose 29 | 46 | 96 |

Opposite faces stay at 0 (nose drop: tail 0; left: right 0).

**Columns** (`scenes/stack-column.test.ts`): 11 sedans, or the fleet's bodies without its monster truck, dropped 0.15 m a
second stay on the axis (< 5 cm, < 3° lean, no car 10 cm off at any time) with the roof sink growing toward the bottom.
What holds a column up, in the shared car-on-car rule:

- **The cages' heights** (`contact/cage-outline.ts` `bandsMeet`, `contact/sat.ts` `satCars`): a car whose body spans heights that overlap
  the car under it by no more than `VERTICAL_CLEAR` is on it, not beside it: the cage's top in the store carries it and the plan SAT does not push it.
- **`restsOn`** is set by touching a top, pressed or not (`CarSurfaces.touch`).
- **One-sided ground**: a car's ground is a car below it (origin height), never one above.
- **Lifted bodies**: others stand on the drawn roof (the class lift is on the top surface).
- **Tyres** on another car's top grip both ways.

## Limits

- Load crush rides replays and netplay: `crush[]` and `crushBaked` are in `simState`, and a car whose face yielded is
  `crashed`, so it rides the wreck section. `stack-crush.test.ts` restores a 4-stack from a keyframe: the same roofs, the
  same 3 s later.
- A wreck (`massActive`) keeps its lattice: it takes no load crush, and a car that load-crushed and is then hit re-fits its
  shape-match rests to the undamaged shape (the roof's vertical cap keeps its sag: `maxLift`).
- Forces between stacked cars are vertical only: a tilted pair does not pass friction to the car below, and there is no
  rigid-body torque on the carrier. The monster truck carrying four cars or more rolls and the column above it falls (an
  open `todo` in `stack-column.test.ts`).

## The Stack scene

The **Stack** scene (`/`, `scenes/stack-rig.ts`) drops cars one at a time onto a base car: the first after 1 s, then one
every **gap** seconds (sim time), each from **drop** m over the roof of the stack below it (the roof of the car's own body
style, 0.13 m belly room). After the last car's gap it restarts through the shared clear path (with Loop on). The three
sliders (cars 2–20, drop 0.02–2 m, gap 1–20 s) default to 4 / 0.02 m / 8 s, live in the share URL (`scars` / `sdrop` /
`sgap`) and restart the stack when changed. The panel lists, per car, the load (kN: the mass of the cars standing in the
column above it, each upright, within 0.6 m of the car under it and one car's height over it; a car off the column reads
"—") and its roof's sink (mm, `ROOF_REST_Y` minus the roof mass's height), both read off the sim's cars. Every car is the
car type picked in the settings (Driving, Car), not the fleet's mix; changing the pick, or entering or leaving the scene,
rebuilds the cars (`followSceneTypes`). Tall stacks of tall bodies (truck, monster) topple; the scene shows what the
physics does.
