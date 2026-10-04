# Survival (Driver 2 Havana): the map

Survival is a single-player mode on a Havana course: survive as long as possible while more and more cops try to wreck you.
This file is shared by the two lanes that build it. **The Map part** (this section) is the course; the Rules and Cops parts
(survival rules, the cop AI, the HUD, the scene wiring) are the Survival lane's and are added under their own headings.

## The Map

`world/tracks/havana.json` (id `havana`), exported as `HAVANA` from `world/tracks/havana.ts`. It is in `OFF_MENU`
(`world/tracks/index.ts`), not in `TRACKS`: the race menu, the campaign and the per-course test sweeps do not list it, and
`RaceField.load` resolves it by id. `new Track(HAVANA)` is the loader. Plan, left to right on screen, +z up
(`docs/shots/havana-top.webp`; the owner's reference is the Driver 2 Havana minimap):

- **The island.** A D: flat side north (z 52), round side south (r 55 about (0, -2)). The ring road round it is the Track's
  closed main loop: 12 m of asphalt, 3 m of concrete sidewalk each side, kerbs, 32 nodes, 4 checkpoints, node 0 (the start
  gantry) on the east leg, clear of the boulevard's mouth. The lawn inside it is `environment.paint` (grass over bare concrete
  terrain); the rest of the ground is concrete (sidewalks and blocks).
- **The grid.** Traffic routes with `count: 0` (they put roads in `Track.paths()` and nothing on them): `boulevard`, `north-st`
  (the ring's north leg run on east and west), `cross-130/220/310/400`, `avenue-east/west` (x ±110), `paseo` (south), `alley`.
  Pastel stucco blocks (`stucco`, the `building`'s shape and windows, seven tints) stand along them as `along` rows; palms
  (`palm`) along the boulevard, the paseo and the island's east and west edges.
- **The approach.** The boulevard: 20 m wide, 424 m long from (0, 476) to the ring, straight at the hill. Palms 3 m beyond each
  edge, blocks 11 m beyond that; the centre 20 m is clear. The monument is in view from the start (`havana-start.webp`).
  The start anchor is (0, 426), 390 m from the foot: from rest at full throttle the sedan is at 91 % of its top speed at the foot
  (muscle 96, monster 93, truck 90; measured, `havana-fit.test.ts`).
- **The foot road.** The ring's north leg, 12 m wide, across the boulevard's end.
- **The face.** The plateau's near side: 4 m up over a nominal 16 m (14°), 24 m wide, the whole width one plane; grass.
- **The plaza.** A raised platform, 24 × 36 m nominal, 4 m up, concrete on its flat (12 × 24 m), grass on its shoulders. The
  `monument` stands on it at (4.5, 0): a solid star-plan stone tower, 55 m, nine steps and a spire, collider a circle r 5.8
  m. 12 m of plaza is clear on its left (x -12 .. -1.3).
- **The crest.** The top meets the face in a parabola, 6 m either side of the nominal edge (the plateau's `round`); a
  car leaves the ground over it at about 25 m/s and up.
- **Beyond.** The far side falls 4 m over 18 m to the ring's south leg; past it the **landing area**: the paseo (24 m asphalt,
  the lower road) between two lawns, 150 m long, no solid prop within 60 m of the line (`havana.test.ts` checks it).
- **The escape alley.** A cobbled street 5.5 m wide at x -36.5 along the plaza's left side, from the foot road to the ring's
  south-west, a stucco `wall` (solid, 10 m panels, tinted per panel) along its west side, a stub wall across it at z -12
  and a `dumpster` (solid) in the corner behind the stub.
- **Light.** `environment.light`: a warm sun (#ffd49a, 2.9), a cool sky hemisphere and a warm fill; sky and fog #a8cfe3,
  fog 0.0012 (a 55 m tower reads at 430 m). `TrackArt` gives them to `WorldStage.look` while the art stands and takes them
  back at dispose.

### Anchors (the contract)

`Track.survival: SurvivalSpec | null` (`world/track-schema.ts`): `start {x, z, yaw}` and `formation`, 4-6 cop slots behind it. Havana:
start (0, 426) yaw π (forward = (sin yaw, cos yaw), so −z, at the hill); five slots at z 437-459, ±2.6 m, staggered 4-7 m, all yaw π.
They stand on asphalt clear of every prop (`havana.test.ts`).

### Terrain: the plateau and paint (`world/terrain.ts`)

Gaussian hills cannot make a crest, so the heightfield takes `environment.plateaus` after the roads are stamped (a plateau is
added on top, so the footprint plus `round` must be clear of every road: `checkPlateaus`, thrown at load): a flat top at `height`,
each side a plane to the ground over its `run` (-x, +x, -z, +z), each corner a cone, the crest and the foot rounded over `round` m
(a parabola). It is continuous with the ground (no step above a kerb: `terrain.test.ts` bounds the grade along lines through
every part). `environment.paint` lays a surface over bare terrain inside a polygon (a road keeps its own). Havana's plateau:
`halfX 12, halfZ 18, height 4, run [10, 10, 18, 16], round 6`.
Why `round`: a bare crest hangs two of a car's four tyres at once. The drop matrix at the crest failed with `round 0` and passes at 3
and up; the 30° diagonal landings roll less the softer the crest.

### Wheels on the grass and the crest: measured

`vehicle/havana-fit.test.ts` (judge shared with `ground-fit.test.ts` in `ground-judge.test-util.ts`; runs in `ground-run.test-util.ts`).

- **Drop matrix:** a car dropped 0.5 m, braked, at 8 headings, all 5 classes: approach (road, edge, kerb), foot road, foot lawn,
  face foot / low / mid / high, crest, plaza top, plaza edge, left slope, left foot, plaza corner, far crest / slope / foot, alley kerb,
  alley, alley south, landing lawn ×2, paseo kerb, ring south: **0 of 1080 cells fail**, no known list.
- **Drive matrix** (the throttle scaled by the surface as the race does; hull and tyre as the judge counts them, less a face's crush
  and a tilted tyre's shoulder): each class straight up the face at 10 / 20 / 30 m/s, from the start at full throttle, and 30°
  across the face (30 m/s, full throttle): the car takes off at z 15-21; 10 and 20 m/s stay on the ground; from 30 m/s 1.1-1.5
  s in the air, landing on the plaza top (z -16 to -19; across the face, on its left shoulder); from the start at full throttle
  2.4-2.9 s, 5.2-8.1 m up over the crest (apex 8.4-11.3 m over the ground), landing on the paseo at z -87 to -127; across the face at
  full throttle 1.7-2.0 s, on the left shoulder or the alley's cobble. Over all 30 runs: **hull in the ground 0.0-1.9 cm** (the muscle
  at 30 m/s is the 1.9; the rest 0.2 or less), **tyre in the grass 0.0-0.6 cm**, **0 drivers thrown out, 0 engine kills, 0 teleports**.
- **Set piece:** a police car at the player's foot speed (50.4 m/s): 2.5 s in the air, 8.8 m over the ground (5.9 m over the
  crest), lands at (0, -92) on the paseo at 43 m/s and keeps going to z -215 at 48 m/s.
- **Perf** (browser, heavy-slot, vsync'd Chromium, 6 cars, 3 interleaved runs): draw calls 59 (havana) against 134-136 (city), triangles
  135,658 against 178,086-190,660. Frame ms was not measured reliably (box contention: per-frame CPU 1.2-11.8 ms havana, 6.5-22 ms city
  across runs). The props are one `InstancedMesh` per prefab part, as on every course.

### For the Survival lane

- Prop contact is height-blind (`RaceField.props` ignores `y`): a car flying over a wall or a palm collides with it. The monument is
  55 m, so that is right for it; an airborne car over the alley wall (3.2 m) is stopped.
- The race's throttle cap on grass (`onSurface`, 60 % of top speed) slows a car on the face; the drive matrix applies it.
- A car that lands rolled can stay `airborne` while it slides on its side (`car.speed` is stale then; use the velocity).
- `Track.paths()` lists the grid; spawn points and respawns can use `routes` (count 0: no civilian traffic).

Shots (each looked at): `docs/shots/havana-start.webp`, `havana-face-side.webp`, `havana-top.webp`, `havana-mid-air.webp`, `havana-alley.webp`.
