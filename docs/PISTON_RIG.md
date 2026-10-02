# Piston rig

Eight horizontal rams around one parked car (`I` in the app, or the
**Pistons** button). The model is `src/game/scenes/piston-rig.ts` (DOM-free; the
engine and the tests run the same `PistonRig.step`), the rams are drawn by
`src/game/present/engine-pistons.ts` (five instanced meshes), and
`src/game/scenes/piston-rig.test.ts` is the test table below. Sketch:
`docs/piston-rig-sketch.png`.

## The pistons

Car frame at rest: +Z forward, +X the car's right. Keys run clockwise from
the front-left corner, seen from above.

| key | id | aimed at | axis | expected damage | struck particles |
|---|---|---|---|---|---|
| 1 | `frontLeft` | front-left corner | 45°, between `bumperFL` and `wingFL` (0.33 m either side) | crushed corner | `bumperFL`, `wingFL` |
| 2 | `front` | middle of the nose | square, −Z | dent across the bumper, L/R even | `bumperFL`, `bumperFR` |
| 3 | `frontRight` | front-right corner | 45° | crushed corner | `bumperFR`, `wingFR` |
| 4 | `right` | middle of the right side | square, −X | door dent | `doorR` |
| 5 | `rearRight` | rear-right corner | 45° | crushed corner | `bumperRR` (no rear wing particle) |
| 6 | `rear` | middle of the tail | square, +Z | dent across the bumper | `bumperRL`, `bumperRR` |
| 7 | `rearLeft` | rear-left corner | 45° | crushed corner | `bumperRL` |
| 8 | `left` | middle of the left side | square, +X | door dent | `doorL` |

`0` fires all eight. Clicking a ram in the panel fires it.

## Model

- **Stroke.** Each ram rests 0.4 m off the paint, accelerates over that gap
  to the shot speed, then coasts as a free mass: contact is the only thing
  that slows it. It retracts (1.6 m/s) once the car stops it, the contact
  lets go for 50 ms, or the face reaches 0.9 m past the paint (end stop).
- **Contact** is the shared striker contact (`external-contact.ts`
  `bodyContact`, docs/CONTACT_PARITY.md), the same code as the press plates
  and the Doors ram, in the head's rest frame: every particle velocity is
  shifted by −(face speed), then `StreamedDeformation.projectOutOfBox` (the
  head is the box: depth 0.3 m along the axis, half the face width across)
  puts crossed particles back on the face, and while particles rest on it
  `brakeInbound` applies the stroke-sized crush force `m·EBS²/(2·hitStroke)`
  (the jersey barrier's `brake`). Velocities are shifted back; the momentum
  the car took comes off the ram (`u −= Δp / M`). The head also meets the
  door and mirror colliders (`partContact`), and a head on the nose or tail
  reports the struck end (`noteContactEnd`), so front and rear fired together
  squeeze the car like the press. The first touch calls
  `DeformableCar.applyImpact(point, inward, closing, EBS)` once per crash.
- **Energy.** The car takes `E = h · ½ μ v²`, μ the reduced mass
  `mM/(m+M)` (free car) or `M` (held car); `EBS = √(2E/m)`, m the rig mass
  (858 kg). Standard shot: 1500 kg at 40 km/h → 33.7 kJ, EBS 31.9 km/h.
- **Hardness** `h` (0.05–1) is the car's share of that energy. Below 1 the
  face carries an aluminium honeycomb block `0.4·(1−h)` m deep that gives
  way at `(1−h)` of the closing speed while it has depth left, so at equal
  force the stroke splits between block and car by the same share.
- **Hold car** removes the car's mean velocity each step (a seismic floor):
  no shove, dents kept, and the car takes the ram's whole `½Mv²`.
- **Contact pad.** The particles sit inboard of the paint (up to 0.09 m on
  the nose). At attach each face measures the first paint it meets
  (vertices within its width and height band) and the first particle
  sphere; the physics plane leads the visible face by the difference, so the
  head touches the paint, not the particle.
- **Face size.** `projectOutOfBox` is planar, so face height only picks the
  paint the face meets. A face narrower than 2·0.52 − 0.28 = 0.76 m slips
  between the two bumper particles on a mid shot (the rig has no particle at
  the bumper centre) — the default is 1.2 m.

## Config knobs

| knob | default | range | HUD |
|---|---|---|---|
| `speedKph` | 40 | 1–200 | Speed slider (5–120) |
| `massKg` | 1500 | 50–20000 | Mass slider (200–3000) |
| `hardness` | 1 (steel) | 0.05–1 | Face slider (0.2–1, "steel" / "% car") |
| `faceWidth` | 1.2 m | 0.2–2 | — |
| `faceHeight` | 0.5 m | 0.15–1.2 | — |
| `holdCar` | false | — | Hold car button |

The panel shows the shot's car energy and EBS. The scene uses the same
defaults as the tests: the car is free, so a shot shoves it out of the ring
(through the idle rams, which do not collide). Firing again parks a fresh
car; with **Hold car** on, shots add up on the same car. With Loop on the
scene fires the selected ram after 1.2 s and moves to the next ram on each
loop reset.

## API for other suites

```ts
import { firePiston, pistonLocality } from "./piston-rig.test-util.ts";
const shot = firePiston(makeCar("shape"), "front", { speedKph: 40, massKg: 1500, hardness: 1 });
const tap = firePiston(makeCar("shape"), "front", { speedKph: 3, massKg: 1500, hardness: 1 });
shot.struck;            // [{ name, inward }] — travel along the hit, rigid motion removed
shot.drivetrainAlive;
pistonLocality(shot, tap); // farParticle / farSkin / opposite… / dent, extra over the tap
```

`firePiston` parks the car at the origin, runs the engine's frame order
(two slices of a 1/60 s frame, `cutDrive`, one skin update per frame) until
1.5 s after contact, then fits out the rigid motion (plan-view rotation and
translation plus mean height) on the body particles more than 1.2 m from the
struck paint and reports everything in that frame. Locality is the extra
travel over a 3 km/h tap of the same ram (0.2 kJ), because arming the crash
already moves the skin (see the last section).

## Measured (main 0e83d6f, shape mode, free car, 1500 kg rigid)

Deepest struck particle travel along the hit (m); † drivetrain dead.

| piston | 20 km/h (EBS 16) | 30 (24) | 40 (32) | 50 (40) | 60 (48) | 70 (56) | 80 (64) |
|---|---|---|---|---|---|---|---|
| frontLeft | 0.09 | 0.16 | 0.24 | 0.30 | 0.37 † | 0.43 † | 0.46 † |
| front | 0.10 | 0.18 | 0.25 | 0.30 | 0.32 † | 0.39 † | 0.47 † |
| frontRight | 0.09 | 0.16 | 0.24 | 0.30 | 0.37 † | 0.43 † | 0.46 † |
| right | 0.11 | 0.19 | 0.22 | 0.22 | 0.23 | 0.23 | 0.24 |
| rearRight | 0.10 | 0.16 | 0.23 | 0.29 | 0.35 | 0.42 | 0.50 |
| rear | 0.09 | 0.15 | 0.22 | 0.29 | 0.36 | 0.42 | 0.49 |
| rearLeft | 0.10 | 0.16 | 0.23 | 0.29 | 0.35 | 0.42 | 0.50 |
| left | 0.11 | 0.19 | 0.22 | 0.22 | 0.23 | 0.23 | 0.24 |

Side shots flatten at the door band (`doorL/R` bands max 0.278 m).

Standard shot (40 km/h), Δ = extra over the 3 km/h tap:

| piston | struck (m) | paint dent Δ | far particle Δ | far skin Δ | opposite half Δ particle / skin | doors L / R, roof | shove |
|---|---|---|---|---|---|---|---|
| frontLeft | bumperFL 0.206, wingFL 0.037 | 0.046 | 0.077 (bumperFR) | 0.091 | 0.070 / 0.063 | 0.003 / 0.054, −0.001 | 6.18 |
| front | bumperFL 0.252, bumperFR 0.252 | 0.111 | 0.065 (axleR) | 0.086 | 0.065 / 0.080 | −0.001 / −0.001, −0.001 | 6.24 |
| frontRight | bumperFR 0.206, wingFR 0.037 | 0.046 | 0.077 (bumperFL) | 0.091 | 0.070 / 0.063 | 0.054 / 0.003, −0.001 | 6.18 |
| right | doorR 0.214 | 0.202 | 0.137 (bumperFR) | 0.119 | 0.058 / 0.119 | 0.079 / 0.158, −0.005 | 6.55 |
| rearRight | bumperRR 0.196 | 0.161 | 0.140 (bumperFL) | 0.228 | 0.140 / 0.102 | 0.054 / 0.024, 0.011 | 6.21 |
| rear | bumperRL 0.223, bumperRR 0.223 | 0.184 | 0.133 (tank) | 0.160 | 0.105 / 0.070 | 0.000 / 0.000, 0.007 | 6.34 |
| rearLeft | bumperRL 0.196 | 0.161 | 0.140 (bumperFR) | 0.228 | 0.140 / 0.102 | 0.024 / 0.054, 0.011 | 6.21 |
| left | doorL 0.214 | 0.202 | 0.137 (bumperFL) | 0.119 | 0.058 / 0.119 | 0.158 / 0.079, −0.005 | 6.55 |

Measured after the `crash-realism-2` yaw-frame fix (`followGroup` no longer turns the body by the crush
tilt). Corners lost a little dent (0.075 → 0.046) and gained 0.011 m of far-door travel. The corner
dent floor is now ≥ 0.04 m, and cabin intrusion uses the sourced < 0.06 m target (RIG_ANALYSIS §3.3).

Engine kill (lowest speed at 2 km/h steps, 1500 kg rigid, up to 150 km/h):
**front-middle 56 km/h (EBS 44.7 km/h)**; front corners 52 km/h (EBS 41.5);
rear, both sides and both rear corners never (side hits do not count in
`updateDrivetrain`; the tail never packs the block within 150 km/h).

Hardness at 40 km/h (crush m, honeycomb crushed m): front 0.252 / 0.215
(h 0.75, 0.10) / 0.166 (0.5, 0.20) / 0.101 (0.25, 0.30); left 0.215 /
0.173 / 0.174 / 0.107; frontLeft 0.237 / 0.198 / 0.149 / 0.093. Held car,
front: 92.6 kJ, EBS 52.9 km/h, crush 0.435 m, drivetrain dead, shove 0.27 m.

## Expectations and their anchors

Real-world anchors from `docs/RIG_ANALYSIS.md` §3.3 ([09], [10]): frontal
crush at 56 km/h is 350–550 mm dynamic / 250–450 mm static and scales with
speed, so at 32 km/h EBS 0.14–0.26 m static, ≤ 0.31 m dynamic; IIHS side
test (1500 kg MDB, 50 km/h) ≈ 0.15–0.25 m B-pillar intrusion; footwell /
A-pillar Good < 5 cm.

Passing (real assertions): front-middle bumpers 0.14–0.31 m and even L/R;
rear-middle ≥ 0.11 m (B4 rear/front stroke ratio); doors ≥ 0.12 m at
40 km/h and 0.15–0.25 m at 50 km/h; corner bumper ≥ 0.12 m with the wing in
but less than the bumper; paint dents ≥ 0.05 m at every ram (≥ 0.04 m at the corners); mirrored rams
mirror; crush never shrinks with energy (front, rear and corner rams every
10 km/h, 20–80 km/h; the side rams every 5 km/h, see below); a 0.5
honeycomb face crushes front, left and frontLeft at least 2 cm less than
steel; the front-middle kill shot leaves rear, sides and rear corners alive;
a 45° corner needs at least the front-middle's kill shot (only the block's
travel along the car toward the cabin counts, lane `crash-realism-5`).

**Side rams (re-expressed, lane `crash-realism-5`).** From 35 km/h the struck
door sits exactly on its crush cap (`bands.max`, 0.278 m) in the body frame.
The struck-particle row is a rigid fit over the far particles and wanders
±7 mm with the frame path while the door stays on its cap (main 2a53b04 read
0.223 → 0.216 m between 50 and 55 km/h). The test samples every 5 km/h and
asserts: the door's body-frame crush never decreases (exact, 1 µm), it equals
the cap at every speed from the first one that reaches it, the fit row is
monotonic (5 mm) up to that speed and ≥ 0.20 m (IIHS side intrusion) above it.
Cutting the door cap 3 % above 16 m/s fails it.

## Expected changes (the `todo` tests — hand-off to the crash-realism lane)

Each is a `todo` in `piston-rig.test.ts` keyed `piston:metric`; flip it to a
plain test when the rig meets it.

| key | measured | expected | why it misses |
|---|---|---|---|
| `*:far-particles` | 0.066 (front, corners) – 0.147 (sides) m | ≤ 0.03 m beyond 1.2 m | a door hit bends the same-side nose (0.147 m `bumperF*`); rear corners bend the far front corner (0.137 m); the 7 m/s shove leaves a set across the car |
| `*:far-skin` | 0.066 – 0.236 m | ≤ 0.03 m | follows the far particles |
| `*:opposite-half` | 0.062 – 0.137 m particle, 0.052 – 0.120 m skin | ≤ 0.03 m | same |
| `left:cabin`, `right:cabin` | far door 0.079 m | ≤ 0.06 m | the far door closes on the cell as the cabin is shoved sideways |
| `front:kill-ebs` | 56 km/h = EBS 44.7 km/h | EBS in (56, 64] km/h (wall56 alive, wall64 dead, RIG_ANALYSIS §6) | the piston path kills the block at a lower EBS than the barrier path; it also crushes more per EBS (0.25 m at 32 km/h vs the wall's 0.17 m at 35 km/h) |
| `left/right:tap-particles` | 0.034 m (far door) | ≤ 0.03 m | arming the masses sags them |
| `rearLeft/rearRight:tap-particles` | 0.089 m (other rear bumper) | ≤ 0.03 m | a 0.2 kJ rear-corner tap moves the other rear corner |
| `*:tap-skin` | 0.352 – 0.366 m (panels 0.064 – 0.150 m) | ≤ 0.03 m | see below |
| `*:lattice-tap-skin` | 1.641 – 1.654 m (rear 0.348 m) | ≤ 0.03 m | see below |

## Found on the way (not piston-specific)

- **Wheel-arch skin folds onto the hub on any crash.** Arm a parked car and
  call `applyImpact` with EBS 0.5 m/s and no contact at all: the particles
  move ≤ 0.05 m, but skin vertices around each wheel arch (e.g. rest
  (±0.62, 0.32, 1.72)) move 0.34 m toward the hub as soon as the crash skin
  runs. Present at 59ca5ba too. This is why locality is measured over a tap.
- **Lattice skin vertex jump.** Same probe in lattice mode: a rear vertex at
  rest (0.42, 0.67, −2.11) moves 1.64 m along Z. Present at 59ca5ba too.
