# Squash / buckle calibration

The crash knobs, what each one sets, the real-car bars they are held to, and how to re-check them. Every number below
comes from `npm run sweep` (`scripts/crush-sweep.mjs`, shape mode) or from `barrier.test.ts`.

## 0. Knobs and defaults

| knob | HUD | default | range | sets |
|---|---|---|---|---|
| squash | "Stroke", shown as the crush stroke at 56 km/h | **0.32** (0.52 m) | 0.109–0.729 (0.40–0.75 m) | crush stroke, plasticity and shape-match stiffness (below) |
| buckle | "Wrinkle" | **0.45** | 0–1 | skin fold size only; no physics target |
| realism | Handling's "Arcade ↔ Real" | **0.25** | 0–1 | when a car dies (`killTravel`), owned by `docs/HANDLING.md` |
| rig | `rig-spec.ts` `CAGES` | `chassisRear.maxCrush` **0.38** | - | rear stroke = 0.69 × the front's 0.55 |

- Defaults live in `hud-store.ts` `INITIAL_HUD`; ranges in `KNOB_RANGES` / `STROKE_RANGE_M`. The engine setters
  (`setSquash`, `setBuckle`) clamp to the same bounds. `knob-defaults.test.ts` checks that each default sits inside its
  range and that the default stroke sits in the real 0.35–0.55 m dynamic-crush band.
- **Defaults** (HUD button) copies `INITIAL_HUD` back, including realism and the player's car class.

What one squash value moves at once:

1. **The crush stroke** (`physics-core.js` `crushStroke`: `(0.035·ebs + 0.02)·(0.6 + s)`), the per-hit stroke cap
   (`deform-contact.ts` `hitStroke`, a side hit capped at the door band, a rear hit × `chassisRear / chassisFront`) and the
   per-node crush cap. This is the knob's real job.
2. **Contact stiffness** rises with squash (shape-match pull and cluster β in contact), while the stroke lets the same nodes
   crush deeper.
3. **Plasticity** (`shape-match-core.js` yield, creep and max strain) takes squash at about twice buckle's weight.

Buckle only reaches the skin: the wrinkle amplitude and the accordion folds within 0.82 m of the hit.

## 1. Bars

### Sedan into a rigid wall (`vehicle/barrier.test.ts`)

NCAP / IIHS full-frontal targets, run at both crumple settings (0.4 and the calibrated 0.32) where the test says so:

| hit | bar |
|---|---|
| 56 km/h square | both front corners 0.25–0.50 m permanent crush; no crush-model point > 5 cm past the wall face; 0.35–0.60 m travel after contact; pulse 60–150 ms; corners within 25 % of each other |
| 35 / 56 / 80 km/h | travel after contact grows with speed |
| 20–43 km/h | the engine block stays on its mounts while the nose has not packed |
| repeated 35 km/h | the block moves back every hit; the third kills the engine |
| one hit of 2× / 3× the 35 km/h energy (49.5 / 60.6 km/h) | the first leaves the engine running, the second kills it |
| reverse 50 km/h | tail ≥ 0.15 m, nose ≤ 3 cm; tail 0.6–1.0 × the 50 km/h nose; cabin in < 6 cm |
| reverse 40 km/h | block survives, car stays driveable (the rear kill is about 80 km/h, the front about 50) |
| side 50 km/h | door 0.12–0.28 m; nose and tail each < 10 cm; cabin shift < 12 cm |

The jersey slab is the reference every fixed solid is held to (`world/solid-parity.test.ts`): at 8 m/s a sedan, truck or
monster dents and keeps its engine and driver; at 55 m/s the block packs past the kill and the driver is thrown.

### Sweep scenarios (`scripts/crush-sweep.mjs`)

Weight in brackets. Bands at other speeds scale linearly with v from the 56 km/h band.

| scenario | targets |
|---|---|
| wall35 front | nose permanent 0.15–0.31 m (2), pulse 60–150 ms (1), avg 11–16 g (1), cabin ≤ 0.06 m (2), drivetrain alive (1) |
| wall56 front | nose permanent 0.25–0.50 m (2), COM travel 0.35–0.60 m (1), pulse 60–150 ms (1), avg 18–25 g (1), cabin ≤ 0.06 m (2), centre past face ≤ 0.05 m (1) |
| wall64 front | nose permanent 0.29–0.57 m (2), pulse 60–150 ms (1), avg 20.5–28.5 g (1), cabin ≤ 0.08 m (1), drivetrain dead (1) |
| offset64 (40 %) | struck-side nose 0.30–0.60 m (2), cabin ≤ 0.15 m (1), centre past face ≤ 0.05 m (1) |
| wall50 front | nose 0.22–0.45 m (1): feeds the rear ratio |
| rear50 | tail permanent 0.15–0.40 m (2), tail ÷ wall50 nose 0.6–1.0 (2), nose ≤ 0.03 m (1), cabin ≤ 0.06 m (1) |
| side50 slide | door 0.12–0.28 m (2), ends ≤ 0.10 m (1), cell shift ≤ 0.12 m (1) |
| head-on 2×28 | mean nose 0.12–0.26 m (≈ 28 km/h wall) (2), cabin ≤ 0.06 m (1), no hub popped (1), both drivetrains alive (1) |
| head-on 2×56 | mean nose 0.25–0.50 m (≈ 56 km/h wall) (2), pulse 60–150 ms (1), cabin ≤ 0.08 m (1) |
| T-bone 50 | struck door 0.12–0.28 m (2), bullet nose 0.08–0.30 m (1, an estimate) |

Real-world anchors: 56 km/h full-frontal crush 0.35–0.55 m dynamic, 0.25–0.45 m permanent, pulse 90–140 ms at 18–25 g
average; footwell / A-pillar intrusion under 5 cm is IIHS Good; IIHS side (1500 kg barrier at 50 km/h) allows about
0.15–0.25 m of B-pillar intrusion; the rear stroke is shorter and softer than the front; roofs carry ≥ 3× the car's weight
(FMVSS 216a). Crush scales with speed (linear spring).

### Ejection and kill speeds

`vehicle/ejection-matrix.test.ts` pins every striker × struck class pair (sedan, truck, monster) of the head-on, T-bone and
rear-end at a survivable speed (12 m/s each head-on, a 20 m/s striker otherwise: nobody thrown, engines near whole) and a
lethal one (2×40 m/s head-on throws both drivers; a 55 m/s striker kills and throws its own driver and spares the struck
car's). `deform/crash-parts.test.ts` holds the head-on nose ladder: from 100 to 200 km/h a faster pair never crushes more
than 5 % less.

## 2. Instrument

```
npm run sweep -- [--grid 0,0.2,0.4,0.6,0.8,1] [--cells s:b,...] [--slomo] [--scenarios a,b] [--after 1.5] [--root <tree>] [--out <dir>]
```

- The script imports `src/game/contact/crash-scenarios.test-util.ts` (the engine's own `stepWorld` and phase clock at
  `tickInner`'s slices) and the default pair from `hud-store.ts` `INITIAL_HUD`, which it always runs.
- Output: `<out>/sweep.json` (every `CrashResult` per cell) and `<out>/sweep.md`; default `.bench/crush-sweep/` (gitignored).
- `--slomo` runs every scenario through the engine's impact slow motion (sub-frame resolution for pulse lengths).
- **Score:** Σ w·min(2, miss) / Σ w; a miss is the distance outside the band in band widths (one-sided bands use ÷ limit,
  booleans score 0 or 1). **Centre:** the weighted mean distance from the middle of each two-sided band in half-widths
  (0 = mid-band, 1 = on the edge), the tie-break inside the region where the score is 0.

Squash 0.30–0.35 is the best-centred region; 0.32 is the point inside it where both the full-speed and slow-motion runs and
the piston-corner tests (`docs/PISTON_RIG.md`) pass.

## 3. Open gaps

The piston-rig `TODO` map (`scenes/piston-rig.test.ts`) and the contact-parity `PENDING` case
(`scenes/contact-parity.test.ts`) hold the documented targets the rig does not meet yet, with the measured value in each
reason. Derby lethality is set by Handling's kill travel on the arcade ↔ real axis, not by these knobs.

## 4. Reproduce

```
npm run sweep                                                    # grid + default, .bench/crush-sweep/
npm run sweep -- --cells 0.3:0.45,0.32:0.45,0.35:0.45 --slomo
npm run sweep -- --cells 0.32:0.45,1:1 --after 6                 # long settle
```
