# Door and mirror knock rig, body lamps

Scenes from the owner's sketch (`docs/door-mirror-sketch.png`), seen from above with the car's
front at the top:

- **A**: the door is shut. A ram runs rear→front along the side with a small gap to the body. It
  catches only the mirror and knocks it off; the car takes no other damage.
- **B**: the door is open. The ram runs rear→front into it and drives it past its stop. Below the
  hinge limit the door is pushed to the stop and stays there; above it the door leaves with its
  mirror. The car takes no other damage.
- **C**: the door is open. The ram runs front→rear and swings it shut. A light push re-closes it and
  latches it; a hard push slams it off.
- **D** (key 6): a quarter panel stands out (hinge 0.45, 0.18 m off the body). The ram runs
  rear→front and pushes it back: a light push leaves it dented but on, a hard one tears it off.
- **E** (key 7): the same panel; the ram runs front→rear into its free end and pulls it out: a
  light pull opens it, a hard one tears it off. The panel is the door's mirror image (hinged at its
  tail), so the directions swap. Open doors also swing with the car's own acceleration; see
  `docs/PANEL_FLAP.md`.

Code: `car.ts` (hinge state and rules), `door-rig.ts` (`DoorRig`, DOM-free),
`engine-doors.ts` (ram visuals), the `doors` scene in `engine.ts`, and `DoorPanel` in
`hud-panels.tsx`. Tests: `door-rig.test.ts`, with the headless `fireRam` in `door-rig.test-util.ts`.

## Hinge model (`car.ts`)

Each door has a `DoorHinge`: open angle θ, rate ω, `latched`, the energy `load` its hinges have
taken at the stop, and its mirror's fold. The door is a thin slab about its front edge:
I = m·L²/3, with m = 25 kg and L = 0.57 m (the model's hinge-to-trailing-edge length), so
I = 2.71 kg·m².

`swingDoors(dt)` runs the free swing:

- Hinge friction: ω decays at 0.8 /s.
- **Check-strap stop** at θ = 68°. The door's swing energy ½Iω² at the stop goes into `load`. The
  strap's detent then holds it (ω = 0). Once `load` reaches `HINGE_TEAR_J` the door tears off
  with its trailing edge's velocity.
- **Latch** at θ = 0: a closing door latches (θ = 0, ω = 0). If one slam carries ½Iω² ≥
  `SLAM_TEAR_J`, the door is wrenched off instead and leaves outward and rearward.

The ram calls `loadDoorStop` when it pushes a door that already sits on its stop. The car is rigid
there, so the strap takes the ram's closing energy ½·m_ram·v².

### Crash-driven doors and mirrors (C1/C3) are unchanged

The crash rules from `docs/RIG_ANALYSIS.md` §6.1 still run in `syncAttachedParts` and
`evaluateBreakage`:

- **C1**: a door is loaded only by a hit on its own side. End-on crush jams it at most
  `DOOR_AJAR` open. A side hit tears it off only at EBS ≥ 12.5 m/s.
- **C3**: a mirror folds with the door skin under it.

The pose is shared (`posePart`). A door shows `max(hingeT·1.45, θ)`, so the crash value jams the
door open on top of the free swing. A mirror adds its fold on top of the crash fold. A wall crash
never touches the hinge state. The test `door-rig.test.ts` "given a car driven at 64 km/h head-on into a wall, when the crash settles, then both doors stay on and both hinges are shut, latched and unloaded" checks this, and the existing `crash-parts` door tests are unchanged and pass.

### Mirror

The mirror folds about its base. In lane A the ram face pins the trailing face of the mirror cap,
so the fold follows the ram (`mirrorSweep`). At the fold stop (75°) the cap still sits in the
lane, so the stop must take the ram:

- If ½·m_ram·v² < `MIRROR_BREAK_J`, the ram stops and the mirror stays on, folded.
- Otherwise the mirror snaps off with the ram's speed, and the ram goes on minus that energy.

So a light push folds the mirror and a real hit breaks it off.

### Thresholds

| constant | value | source |
|---|---|---|
| hinge strength | 11 kN longitudinal, 8.9 kN transverse | **sourced**: FMVSS 206 (`.extraResearch/perplexity/12-detach-part-thresholds.md` §3) |
| `DOOR_MASS` | 25 kg | guessed (front doors are 20–30 kg) |
| `DOOR_OPEN_MAX` | 68° | guessed (check straps stop at 65–70°) |
| `HINGE_TEAR_J` | 220 J | 11 kN at the pins is ~1.8 kN at the door through a ~6:1 strap lever, over ~0.12 m of plastic travel. The load is sourced; the lever and travel are **guessed** |
| `SLAM_TEAR_J` | 360 J | 8.9 kN transverse over ~4 cm of striker and hinge crush. The load is sourced; the travel is **guessed**. A hard hand slam is ~17 J |
| `MIRROR_FOLD_MAX` | 75° | guessed |
| `MIRROR_BREAK_J` | 30 J | **guessed**: the research file has no mirror source (§2). ECE R46 is the place to check |
| hinge friction | 0.8 /s | guessed |

## Rig (`door-rig.ts`)

The car is parked at the origin facing +Z. The ram is a box: a face width × height × 0.5 m. It is
kinematic except for the momentum it trades with the door and the mirror. It is a striker box in
the shared contact (`external-contact.ts`, docs/CONTACT_PARITY.md): the door and mirror colliders
below are `partContact`, the same code a car running down the side meets, and `bodyContact` dents
the skin if a lane reaches it (the stock lanes stay clear of it, so body Δ stays 0 mm). Contact
runs in 0.5 ms substeps.

The door is a slab in top view from its hinge to its trailing edge. A free door takes one
restitution impulse (e = 0.2) through its effective mass I/k², where k = r·sin θ is its lever
across the travel. Then the slab is pushed out of the face.

| lane | travel | inner edge \|x\| | width | height (m) | door at start |
|---|---|---|---|---|---|
| A `mirror` | rear→front | 0.95 (4 cm off the shut skin, 3 cm off the mirror base) | 0.4 | 0.50–1.10 | shut, latched |
| B `overOpen` | rear→front | 0.95 | 0.6 | 0.30–0.75 (below the mirror) | 55° |
| C `shut` | front→rear | 1.10 (outside the open door's mirror) | 0.6 | 0.30–0.75 | 55° |

`fireRam(car, scenario, { kph, kg, side })` runs one shot at 60 Hz the way the engine does
(`integrate`, `step`, `stepBreakage`, `updateSkin`). It returns:

- what is off the car (a mirror riding its torn door counts),
- the door angle, latch state and hinge load,
- whether the ram was stopped,
- the largest control-particle and skinned-vertex move since the shot began. The door and mirror
  are separate meshes, so neither is in these numbers.

### Measured (right side; the left side is the same, see the tests)

| scene | ram | off | door | other | body particles / vertices |
|---|---|---|---|---|---|
| A | 4 km/h, 38.9 kg (0.8× break energy) | — | 0°, latched | mirror folded 75°, ram stopped | 0 / 0 mm |
| A | 4 km/h, 60.8 kg (1.25×) | mirror | 0°, latched | | 0 / 0 mm |
| A | 50 km/h, 1500 kg | mirror | 0°, latched | | 0 / 0 mm |
| B | 5 km/h, 120 kg | — | 68° on the stop | hinge load 104 J, ram stopped | 0 / 0 mm |
| B | 15 km/h, 300 kg | door, mirror | — | hinge load 2.5 kJ | 0 / 0 mm |
| C | 4 km/h, 300 kg | — | 0°, latched | | 0 / 0 mm |
| C | 40 km/h, 300 kg | door, mirror | — | slammed off | 0 / 0 mm |

Thresholds from a 1 km/h sweep:

- B tears the door off from 5 km/h with 300 kg and from 8 km/h with 120 kg.
- C slams it off from 15 km/h with 300 kg and from 24 km/h with 50 kg. Only the door's speed
  counts, so the ram's mass hardly matters.
- A snaps a mirror from 6 km/h with 30 kg.

## Scene

To open the scene, pick **Doors** in the scene picker or press **N**. The panel has:

- **A** / **B** / **C** / **D** / **E** buttons (keys 1–3, 6, 7). Firing sets the door shut or open for that scene
  (D and E: the door shut, the panel at hinge 0.45) and re-parks the car if that side already lost the part it needs.
- **Left/Right door** (key 5) and **Door open/shut** (key 4).
- Speed and mass sliders.
- The last shot's outcome, including the body Δ.

The ram (head, post and floor rail) is one instanced draw.

## Lamps on the body, each a light (`lamp-lights.ts`)

Each lamp unit (housing and lens, one draw) is seated on the body skin, never on the bumper; the
grille and number plate stay on the bumper. At build time a lamp is anchored to the nearest skin
facet: 3 vertex indices, barycentric weights, an offset along the normal and its rotation in the
facet frame. It is re-posed only when the skin is written, including the deferred LoD flush. So a
detached bumper leaves the lamps behind and a crushed corner carries its lamp. Each lamp breaks
only from its own corner's sensors (heads [1,4] / [2,5], tails [16,10] / [17,11]); see
`lamps.test.ts`.

Each body sets its own seats (`BodyStyle.lamps`, car-variants.ts): the head lamps on the nose between
the grille and the header panel (the shared front clip, so the same on every body), the tail lamps on
the tail panel, standing upright in its corners beside a tailgate (hatchback, wagon, pickup: the
tailgate stops `TAILGATE_INSET` inside the corners). Every housing sits whole on its body's skin,
not on a bumper, grille or boot. The pool's light and glow come from the seat's world matrix, so a
class lift (truck +8 cm, monster +48 cm) raises them with the drawn lamp.

Real lights come from a fixed pool created once in the `CrashEngine` constructor:
`SPOT_POOL` = 4 white SpotLights for headlamps and `POINT_POOL` = 4 short red PointLights for tail
lamps, with no shadows. Lights are never added, removed or visibility-toggled at runtime. Doing that
changes three's lights hash and recompiles every lit material (see 32c53c1). Off, broken and
unassigned lights sit at intensity 0, like `impactLight` and `winnerLight`.

Each frame, after the visible skins flush and before render, `LampLights.update` ranks the intact
lamps:

1. the followed car first,
2. then the nearest on-screen lamps,
3. off-screen lamps only fill spare slots.

The top `SPOT_POOL` heads and `POINT_POOL` tails get lights. Every intact lamp also gets an
additive glow sprite in a single `THREE.Points` draw, and the lens emissive tracks its on/broken
state, so cars without a pool light still read as lit.

Render ms (Edge D3D11, RTX 4080 Laptop, 5 s per cell after 3 s warm-up, before → after):

| cars | fleet | derby |
|---|---|---|
| 10 | 2.14 → 1.68 | 2.78 → 2.85 |
| 24 | 5.70 → 5.71 | 6.91 → 6.86 |
| 32 | 7.86 → 8.32 | 8.56 → 8.85 |

With the 8 pool lights removed in-page, the lights alone cost −0.17 to +0.41 ms of render. That is
within run-to-run noise: two "before" runs differ by up to 0.94 ms at derby 24. Draw calls are
unchanged apart from the one glow draw. If the cost ever grows, shrink the pool constants first.
