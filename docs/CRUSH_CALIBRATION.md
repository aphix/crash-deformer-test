# Squash / buckle calibration

Status: phase 2, defaults applied on lane `calib-defaults`, rebased onto main `fe381c3` (CrashRealism6 merged). §3.0 is
the final sweep on that tree; §3.1–§3.4 are the phase-2 decision sweep on base main `b9c5647`. Phase 1, the knob audit
and the instrument, was measured on `0e83d6f` (§8). Every number below comes from `npm run sweep`
(`scripts/crush-sweep.mjs`), shape mode, unless a section says otherwise.

## 0. Summary

| knob | old default | new default | old range | new range | basis |
|---|---|---|---|---|---|
| squash (HUD "Stroke", shown as crush stroke @56 km/h) | 0.40 (0.56 m) | **0.32 (0.52 m)** | 0–1 (0.34–0.90 m) | **0.109–0.729 (0.40–0.75 m)** | realism: in band and best band-centring from 0.30 to 0.35, full speed and slomo (§3). 0.32 is the point in that region where the two noisy piston-corner tests pass (§5) |
| buckle (HUD "Wrinkle", "Panel wrinkle") | 0.45 | 0.45 | 0–1 | 0–1 | no physics target: ≤ 0.035 m crush spread across 0–1 for squash 0.2–0.6 except the offset nose (§3.4); visual fold size only |
| realism (Handling's "Arcade ↔ Real") | 0.25 | 0.25 | 0–1 | 0–1 (`KNOB_RANGES.realism`) | owned by Handling (when a car dies); this lane only adds it to the shared ranges and the Defaults reset |
| rig `CAGES.chassisRear.maxCrush` (data, `rig-spec.ts`) | 0.45 | **0.38** | — | — | rear stroke = 0.69 × front (was 0.82); tail ÷ 50 km/h nose 0.78–0.86 at every squash 0.2–0.45 on `fe381c3`, full speed and slomo (§4) |

- **Default car (0.32 / 0.45) on `fe381c3`, full speed:** score 0.028, centre 0.55. 56 km/h wall: nose 0.37 m, COM
  travel 0.52 m, 83 ms, 18.1 g, cabin 0.03 m. Two misses, neither from the knobs: the 2×56 head-on pulse (§5.4) and
  the T-bone struck door, which on `fe381c3` swings on its hinge instead of intruding (0.02 m at every squash; fixed
  by `crash-realism-7`: 0.242 m at 0.32, §5.6).
- **Slomo** (the engine's impact slow motion, `--slomo`): score 0.049, centre 0.50, same two misses.
- **Defaults button:** `engine.resetDefaults` copies `INITIAL_HUD`, including realism and the player's car class. The
  engine fields start from `INITIAL_HUD`. The `StreamedDeformation` field defaults equal it, and
  `knob-defaults.test.ts` checks that agreement and that each default sits inside its slider range.
- **Owner's 1/1 setting:** score 0.475 with 16 targets missed (§6). It is outside the slider range: the maximum
  stroke is 0.75 m, squash 0.729.

## 1. Knob audit

`s` = squash, `b` = buckle. `engine.ts:setSquash/setBuckle` clamp to `KNOB_RANGES` (`hud-store.ts`); the slider uses
the same bounds. Values are formula evaluations at s = 0 / 0.4 / 1 unless noted (56 km/h = 15.56 m/s). Line numbers
are from `0e83d6f`; the formulas are unchanged on `b9c5647`.

| # | consumer (file:line) | formula | physical meaning | values | monotonic / issues |
|---|---|---|---|---|---|
| S1 | `physics-core.js:88 crushStroke` | `(0.035·ebs + 0.02)·(0.6 + s)` | dynamic crush stroke = crumple stiffness (k = m·v²/stroke²) | 56 km/h: 0.34 / 0.56 / 0.90 m (default 0.32: 0.52 m) | ↑ linear. **The knob's real job.** |
| S2 | `streamed-deform.ts:1172 hitStroke` | `min((0.5 + 1.15s)·1.1, crushStroke)`; side: `min(door band max, ·)`; rear: `× chassisRear/Front maxCrush` (0.38/0.55 = 0.69 since phase 2) | per-hit stroke cap; also sets the barrier brake force `engine-props.ts:138` j = m·v²/(2·stroke) | cap 0.55 / 1.06 / 1.82 m | ↑. Cap never binds ≤ 80 km/h (crushStroke(80, 0) = 0.48 < 0.55): **dead term**. Side hits clamp to the door band (0.278 m) for every s: **side intrusion ignores squash** |
| S3 | `streamed-deform.ts:1785 clampLocal` | `maxCrush = 0.5 + 1.15s` per node × `(0.38 + 0.72·cornerWeight)` | per-node crush cap | 0.50 / 0.96 / 1.65 m | ↑ |
| S4 | `streamed-deform.ts:1784 clampLocal` | `maxAway = 0.025 + 0.04s` | outward (anti-crush) spring allowance | 0.025 / 0.041 / 0.065 m | ↑; tiny |
| S5 | `streamed-deform.ts:1910 stepBeams` | `maxStretch = 1.12 + 0.35s` | beam tension limit (stretch before pull-back) | 1.12 / 1.26 / 1.47 | ↑ (softer in tension) |
| S6 | `streamed-deform.ts:1934 stepBeams` | plastic shrink share `min(1, max(dt·8.5, 0.03 + 0.06s))` | beam plastic-set rate | 240 Hz: 0.035 / 0.054 / 0.090 | ↑; **dead zone s < 0.09** (dt term wins) |
| S7 | `streamed-deform.ts:983 impulseAt` | `seed = clamp(|closing|·0.0025·s, 0.01, 0.08)` | inward dent seed velocity | 56 km/h: 0.010 / 0.016 / 0.039 | ↑; **dead zone s < 0.26 at 56 km/h** (clamped to 0.01) |
| S8 | `streamed-deform.ts:1336-1342 feedOverlap` | `live = s < 0.03 ? 0 : 1`; `absorbFrac = leftover·(0.5 + 0.42s)·live`; `crush = min(overlap·(0.4 + 0.35s)·ke, 0.06 + 0.2ke)·live` | share of closing speed eaten by local crush | absorb 0 / 0.67 / 0.92 | ↑ but **step switch at s = 0.03** (crush off below) |
| S9 | `streamed-deform.ts:1947-1951 clusterBeta` | `s < 0.03 → 0.04`; contact: `lerp(0.18 + 0.22s, 0.03, absorb)`; free: `0.9s·(1 − absorb/2)` | Müller β, the share of linear (stretch) deformation; high = jelly | contact 0.04 / 0.27 / 0.40; free 0.04 / 0.36 / 0.90 | **non-monotonic**: free β 0.04 at s = 0.02 → 0.027 at s = 0.03; contact β jumps 0.04 → 0.19 |
| S10 | `streamed-deform.ts:1975-1979 stepShapeMatch` | contact: `s < 0.03 ? 0.9 : 0.32 + 0.38s`; free: `goalAlpha = 0.22 + 0.62(1 − s)` | shape-match pull per iteration = **stiffness** | contact 0.90 / 0.47 / 0.70; free 0.84 / 0.59 / 0.22 | **opposite signs**: in contact more squash = stiffer pull; free, more squash = softer. Step 0.90 → 0.33 at s = 0.03 |
| S11 | `shape-match-core.js:780 stiffnessIters` (free only; contact = 2) | `clamp(round(2 + 3(1.05 − s)), 2, 5)` | solver iterations = stiffness | 5 / 4 / 2 | ↓ staircase (5 for s ≤ 0.21, 4 ≤ 0.55, 3 ≤ 0.88, 2 above) |
| S12 | `shape-match-core.js:589 applyPlasticity` (contact only) | `yieldC = 0.035 + 0.08(1 − s) + 0.04(1 − b)` | plastic yield threshold on ‖S − I‖ | s,b = 0,0: 0.155; 0.4,0.45: 0.105; 1,1: 0.035 | ↓ in both knobs; **squash weight 2× buckle** |
| S13 | `shape-match-core.js:594` | `creepRef = min(0.85, (0.35 + 1.25s + 0.55b)/12)` per 1/240 s | plastic flow rate | per 83 ms pulse: 45 % / 85 % / 98 % (s,b as S12) | ↑; squash weight 2.3× buckle |
| S14 | `shape-match-core.js:609` | `maxE = 0.18 + 0.55s + 0.4b` | max plastic strain ‖Sp − I‖ | 0.18 / 0.58 / 1.13 | ↑ |
| S15 | `shape-match-core.js:588` | off if `s < 0.03 && b < 0.03` | plasticity kill switch | — | step |
| B1 | `streamed-deform.ts:1396 update` | `wrinkleAmp = clamp(crushAmount·(0.2 + 0.5b), 0, 0.18 + 0.5b)` | **visual only**: wrinkle envelope | cap 0.18 / 0.405 (b = .45) / 0.68 | ↑ |
| B2 | `streamed-deform.ts:2509-2515` skin pass | `amp = wrinkle·e^(−3.4d)·0.16·(0.35 + 0.65b)`, offset capped at `0.03 + 0.08b`; drawn only if wrinkle > 0.02 | **visual only**: accordion folds (12 cm wavelength) within 0.82 m of the hit | wall56 fold at the hit, s = 0.25: 0.005 / 0.021 / 0.034 m at b = 0 / 0.45 / 0.7 | ↑ and **b enters twice**, so amplitude ∝ ~b² |

**Double counting and coupling** (unchanged by phase 2; each item is a follow-up that needs its own sweep)

1. **Squash is three knobs at once.** It sets the crush stroke (S1–S3, S7, S8), the shape-match stiffness (S9–S11,
   with opposite signs in contact and in free flight) and two thirds of the plasticity (S12–S14). Buckle gets the
   remaining third of the plasticity plus the visuals.
2. **Contact stiffness rises with squash** (S10 contact α 0.33 → 0.70, S9 contact β 0.19 → 0.40), while the stroke
   lets the same nodes crush deeper.
3. **Buckle's plasticity channel is masked.** `clampLocal`'s `crushSet` holds the permanent set, and buckle does
   not enter that path.
4. **Steps at s < 0.03** (S8, S9, S10, S15). These lie below the new slider minimum (0.109).

## 2. Instrument

`npm run sweep -- [--grid 0,0.2,0.4,0.6,0.8,1] [--cells s:b,…] [--slomo] [--scenarios a,b] [--after 1.5] [--root <tree>] [--out <dir>]`

- **Imports and defaults:** the script imports `src/game/contact/crash-scenarios.test-util.ts`, which has the
  `CrashEngine.tickInner` frame and contact order. It reads the default pair from `hud-store.ts` `INITIAL_HUD` and
  always runs it.
- **Output:** `<out>/sweep.json` (every `CrashResult` per cell) and `<out>/sweep.md`. The default output directory
  is `.bench/crush-sweep/`, which is gitignored.
- **Size and time:** a 6×6 grid plus the default is 37 cells × 10 scenarios. On the loaded box (another project's
  build running) it took 49 s; phase 1 took 30 s on an idle box.
- **`--slomo`:** runs every scenario through the engine's impact slow motion. Slomo samples the velocity trace at
  sub-frame resolution, so slomo pulse lengths are not quantised to 16.7 ms.
- **Score:** Σ w·min(2, miss) / Σ w. miss = distance outside the band ÷ band width. One-sided bands use ÷ limit;
  booleans score 0 or 1.
- **Centre:** the weighted mean distance from the middle of each two-sided band, in half-widths (0 = mid-band,
  1 = on the edge). This is the tie-break inside the region where the score is 0.
- **Rear ratio:** tail ÷ the wall50 nose's worse corner, the same definition as `barrier.test.ts`.

| scenario | targets (weight) |
|---|---|
| wall35 front | nose permanent 0.15–0.31 m (∝ v from the 56 km/h band) (2), pulse 60–150 ms (1), avg 11–16 g (1), cabin ≤ 0.06 m (2), drivetrain alive (1) |
| wall56 front | nose permanent 0.25–0.50 m (2), COM travel 0.35–0.60 m (1), pulse 60–150 ms (1), avg 18–25 g (1), cabin ≤ 0.06 m (2), mass centre past face ≤ 0.05 m (1) |
| wall64 front | nose 0.29–0.57 m (2), pulse 60–150 ms (1), avg 20.5–28.5 g (1), cabin ≤ 0.08 m (1), drivetrain dead (1) |
| offset64 (40 %) | struck-side nose 0.30–0.60 m (2), cabin ≤ 0.15 m (1), centre past face ≤ 0.05 m (1) |
| wall50 front | nose 0.22–0.45 m (1); feeds the rear ratio |
| rear50 | tail permanent 0.15–0.40 m (2), tail ÷ wall50 nose 0.6–1.0 (2, `barrier.test.ts`), nose ≤ 0.03 m (1), cabin ≤ 0.06 m (1) |
| side50 slide | door 0.12–0.28 m (2), ends ≤ 0.10 m (1), cell shift ≤ 0.12 m (1) |
| head-on 2×28 | mean nose 0.12–0.26 m (≈ 28 km/h wall) (2), cabin ≤ 0.06 m (1), hubs popped 0 (1), both drivetrains alive (1) |
| head-on 2×56 | mean nose 0.25–0.50 m (≈ 56 km/h wall) (2), pulse 60–150 ms (1), cabin ≤ 0.08 m (1) |
| T-bone 50 | struck door 0.12–0.28 m (2), bullet nose 0.08–0.30 m (1; an estimate, no cited source) |

Targets come from `docs/RIG_ANALYSIS.md` §2/§3.3 and `barrier.test.ts`. Bands at other speeds scale linearly with v
from the cited 56 km/h band. The `wrinkle` output (wrinkle amplitude, skin fold at the hit) is visual only, and no
target constrains it.

## 3. Sweeps

### 3.0 Final sweep on `fe381c3` (lane rebased; CrashRealism5/6, ContactParity, Netplay, Cinematic merged)

Grid, full speed (score / centre; 37 cells × 10 scenarios in 76.5 s on a loaded box):

| squash \ buckle | 0 | 0.2 | 0.4 | 0.6 | 0.8 | 1 |
|---|---|---|---|---|---|---|
| 0 | 0.102 / 1.08 | 0.111 / 1.16 | 0.112 / 1.17 | 0.112 / 1.16 | 0.116 / 1.18 | 0.115 / 1.17 |
| 0.2 | 0.049 / 0.63 | 0.049 / 0.61 | 0.049 / 0.62 | 0.049 / 0.62 | 0.049 / 0.62 | 0.049 / 0.61 |
| 0.4 | 0.028 / 0.63 | 0.040 / 0.67 | 0.028 / 0.63 | 0.028 / 0.65 | 0.028 / 0.66 | 0.029 / 0.66 |
| 0.6 | 0.100 / 1.13 | 0.105 / 1.15 | 0.107 / 1.16 | 0.102 / 1.15 | 0.105 / 1.16 | 0.104 / 1.15 |
| 0.8 | 0.255 / 1.49 | 0.247 / 1.49 | 0.247 / 1.49 | 0.253 / 1.50 | 0.252 / 1.49 | 0.256 / 1.49 |
| 1 | 0.459 / 1.60 | 0.462 / 1.60 | 0.468 / 1.60 | 0.473 / 1.60 | 0.468 / 1.60 | 0.475 / 1.60 |

Every cell's score rose by about 0.023 against `b9c5647` because of one squash-independent miss, the T-bone struck
door (0.02 m, §5.6). Max quiet-phase yaw drift 0.27 rad, no spin-clamp frames.

Squash fine sweep, buckle 0.45:

| squash | stroke @56 | score / centre / misses | slomo score / centre / misses | wall56 nose / COM / pulse ms / g / cabin | wall35 nose | wall64 nose / g | offset64 nose | rear50 tail / ratio (full · slomo) | head-on 28 / 56 nose | head-on 56 pulse ms (full · slomo) | T-bone door / bullet nose |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.15 | 0.42 | 0.070 / 0.76 / 6 | 0.066 / 0.86 / 5 | 0.27 / 0.43 / 67 / 22.6 / 0.01 | 0.14 | 0.34 / 34.4 | 0.43 | 0.20 / 0.86 · 0.84 | 0.16 / 0.35 | 50 · 29 | 0.02 / 0.20 |
| 0.20 | 0.45 | 0.049 / 0.62 / 3 | 0.052 / 0.72 / 5 | 0.31 / 0.46 / 83 / 18.1 / 0.02 | 0.16 | 0.36 / 25.8 | 0.48 | 0.22 / 0.85 · 0.86 | 0.16 / 0.39 | 50 · 32 | 0.02 / 0.21 |
| 0.25 | 0.48 | 0.028 / 0.58 / 2 | 0.050 / 0.61 / 2 | 0.34 / 0.49 / 83 / 18.1 / 0.02 | 0.18 | 0.38 / 25.8 | 0.52 | 0.23 / 0.82 · 0.84 | 0.21 / 0.41 | 50 · 33 | 0.02 / 0.22 |
| 0.30 | 0.51 | 0.034 / 0.61 / 3 | 0.050 / 0.52 / 2 | 0.36 / 0.51 / 83 / 18.1 / 0.03 | 0.20 | 0.42 / 25.8 | 0.65 | 0.24 / 0.84 · 0.80 | 0.21 / 0.43 | 50 · 35 | 0.02 / 0.24 |
| **0.32** | **0.52** | **0.028 / 0.55 / 2** | **0.049 / 0.50 / 2** | 0.37 / 0.52 / 83 / 18.1 / 0.03 | 0.21 | 0.43 / 25.8 | 0.57 | 0.25 / 0.83 · 0.80 | 0.22 / 0.43 | 50 · 36 | 0.02 / 0.24 |
| 0.35 | 0.54 | 0.029 / 0.61 / 3 | 0.049 / 0.50 / 2 | 0.39 / 0.53 / 83 / 18.1 / 0.03 | 0.22 | 0.45 / 25.8 | 0.61 | 0.26 / 0.80 · 0.80 | 0.22 / 0.49 | 50 · 37 | 0.02 / 0.25 |
| 0.40 | 0.56 | 0.028 / 0.64 / 2 | 0.040 / 0.55 / 1 | 0.41 / 0.56 / 83 / 18.1 / 0.03 | 0.24 | 0.48 / 25.8 | 0.58 | 0.27 / 0.78 · 0.82 | 0.23 / 0.49 | 50 · 62 | 0.02 / 0.26 |
| 0.45 | 0.59 | 0.029 / 0.75 / 3 | 0.040 / 0.68 / 1 | 0.44 / 0.59 / 83 / 18.1 / 0.03 | 0.26 | 0.51 / 20.7 | 0.61 | 0.29 / 0.78 · 0.82 | 0.25 / 0.50 | 50 · 63 | 0.02 / 0.28 |
| 0.50 | 0.62 | 0.052 / 0.89 / 6 | 0.057 / 0.83 / 4 | 0.47 / 0.61 / 100 / 15.1 / 0.04 | 0.27 | 0.54 / 20.7 | 0.65 | 0.31 / 0.77 · 0.79 | 0.27 / 0.54 | 67 · 65 | 0.02 / 0.29 |

**0.32 still holds.** It has the best band centring at full speed (0.55) and ties best in slomo (0.50); its score
(0.028) ties 0.25 and 0.40. Two things moved since `b9c5647`:

- The slomo 2×56 head-on anomaly at 0.40+ is gone (62–65 ms now, in band), so 0.40 has one fewer slomo miss
  (score 0.040 vs 0.049). At 0.32 that pulse still reads 36 ms (§5.4).
- The offset64 nose is noisier: 0.65 at 0.30 and 0.61 at 0.35 leave the band, 0.57 at 0.32 does not.

Piston-corner margins at 0.32 grew (`.bench/crush-calibration/piston-probe.ts`): far door 0.049 m (limit 0.06,
was 0.055) and paint ÷ particle 0.815 (floor 0.75, was 0.761). At 0.30 the far door reads 0.063 and still fails.

### 3.1 Phase-2 decision grid on `b9c5647`, full speed (score / centre, lower is better)

| squash \ buckle | 0 | 0.2 | 0.4 | 0.6 | 0.8 | 1 |
|---|---|---|---|---|---|---|
| 0 | 0.111 / 1.16 | 0.116 / 1.19 | 0.115 / 1.19 | 0.118 / 1.20 | 0.119 / 1.20 | 0.117 / 1.19 |
| 0.2 | 0.002 / 0.55 | 0.002 / 0.54 | 0.002 / 0.54 | 0.002 / 0.53 | 0.002 / 0.52 | 0.023 / 0.50 |
| 0.4 | 0.002 / 0.51 | 0.002 / 0.50 | 0.006 / 0.54 | 0.006 / 0.55 | 0.006 / 0.56 | 0.006 / 0.56 |
| 0.6 | 0.069 / 1.03 | 0.081 / 1.07 | 0.081 / 1.07 | 0.086 / 1.08 | 0.075 / 1.05 | 0.079 / 1.07 |
| 0.8 | 0.249 / 1.41 | 0.255 / 1.41 | 0.253 / 1.41 | 0.249 / 1.42 | 0.242 / 1.40 | 0.237 / 1.39 |
| 1 | 0.462 / 1.52 | 0.465 / 1.52 | 0.469 / 1.52 | 0.473 / 1.52 | 0.470 / 1.52 | 0.473 / 1.52 |

The default cell, 0.32 / 0.45: score 0.002, centre 0.45, one miss (head-on 2×56 pulse). Max quiet-phase yaw drift
in the grid: 0.24 rad, with no spin-clamp frames.

### 3.2 Squash fine sweep, buckle 0.45 (full speed; slomo where marked)

| squash | stroke @56 | score / centre / misses | slomo score / centre / misses | wall56 nose / COM / pulse ms / g | wall35 nose | wall64 nose / g | offset64 nose | rear50 tail / ratio (full · slomo) | head-on 28 / 56 nose | head-on 56 pulse ms (full · slomo) | T-bone door |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.15 | 0.42 | 0.023 / 0.71 / 4 | 0.030 / 0.75 / 4 | 0.27 / 0.43 / 67 / 22.6 | 0.14 | 0.33 / 34.4 | 0.36 | 0.20 / 0.88 · 0.87 | 0.15 / 0.32 | 50 · 29 | 0.20 |
| 0.20 | 0.45 | 0.002 / 0.54 / 1 | 0.013 / 0.63 / 4 | 0.31 / 0.46 / 83 / 18.1 | 0.16 | 0.35 / 25.8 | 0.39 | 0.22 / 0.87 · 0.87 | 0.15 / 0.35 | 50 · 32 | 0.21 |
| 0.25 | 0.48 | 0.002 / 0.47 / 1 | 0.010 / 0.47 / 1 | 0.33 / 0.49 / 83 / 18.1 | 0.19 | 0.38 / 25.8 | 0.54 | 0.24 / 0.85 · 0.86 | 0.21 / 0.39 | 50 · 33 | 0.22 |
| 0.30 | 0.51 | 0.002 / 0.44 / 1 | 0.009 / 0.38 / 1 | 0.36 / 0.51 / 83 / 18.1 | 0.20 | 0.44 / 25.8 | 0.56 | 0.25 / 0.87 · 0.92 | 0.21 / 0.39 | 50 · 35 | 0.24 |
| **0.32** | **0.52** | **0.002 / 0.45 / 1** | **0.009 / 0.39 / 1** | 0.37 / 0.52 / 83 / 18.1 | 0.21 | 0.45 / 25.8 | 0.58 | 0.26 / 0.88 · 0.92 | 0.21 / 0.40 | 50 · 36 | 0.24 |
| 0.35 | 0.54 | 0.002 / 0.47 / 1 | 0.008 / 0.41 / 1 | 0.39 / 0.53 / 83 / 18.1 | 0.22 | 0.47 / 25.8 | 0.60 | 0.27 / 0.83 · 0.93 | 0.22 / 0.43 | 50 · 37 | 0.25 |
| 0.40 | 0.56 | 0.006 / 0.54 / 2 | 0.050 / 0.52 / 1 | 0.41 / 0.56 / 83 / 18.1 | 0.24 | 0.49 / 25.8 | 0.63 | 0.29 / 0.82 · 0.93 | 0.23 / 0.44 | 50 · **288** | 0.26 |
| 0.45 | 0.59 | 0.011 / 0.66 / 2 | 0.074 / 0.67 / 3 | 0.44 / 0.59 / 83 / 18.1 | 0.26 | 0.52 / 20.7 | 0.66 | 0.30 / 0.81 · 0.82 | 0.23 / 0.47 | 50 · **407** | 0.28 |
| 0.50 | 0.62 | 0.026 / 0.80 / 5 | 0.071 / 0.79 / 3 | 0.48 / 0.61 / 100 / 15.1 | 0.27 | 0.54 / 20.7 | 0.69 | 0.32 / 0.80 · 0.75 | 0.27 / 0.50 | 67 · 407 | 0.28 |

**Why 0.30–0.32:**

- **0.30 to 0.35 is the best region.** The score is flat at 0.002 from 0.2 to 0.35, so band centring picks the
  default. It is lowest from 0.30 to 0.35: 0.44–0.47 full speed, 0.38–0.41 slomo.
- **Below 0.2:** 0.15 is too stiff, with a 50 ms / 34 g pulse at 64 km/h and the drivetrain surviving 64 km/h.
  The slomo 56 km/h pulse also falls under 60 ms at 0.20 (59 ms).
- **From 0.4:** the offset64 nose leaves its band (0.63 m), and the slomo 2×56 head-on anomaly appears (95 % of Δv
  after 288 ms).
- **0.32 within that region:** it is where the piston-corner tests in §5 pass. Realism-wise, 0.30 and 0.32 are
  equal within the sweep's resolution.

### 3.3 Base vs. lane

On base `b9c5647` (rear 0.45, default 0.4), the phase-1 problems were already gone: offset past-face clipping and
the yaw ratchet are fixed. The rear tail tracked the front at **1.0–1.09×** for every squash, so the
`barrier.test.ts` 0.6–1.0 band passed only at 0.4 / 0.45 (0.999). Going from base to lane, only the rear numbers
change; no other key metric moves more than 0.03 m:

| squash 0.2 / 0.4 / 0.6 / 1 (buckle 0.4) | base | lane |
|---|---|---|
| rear50 tail permanent (m) | 0.27 / 0.35 / 0.42 / 0.58 | 0.22 / 0.29 / 0.35 / 0.48 |

### 3.4 Buckle effect and visuals

Largest change in each scenario's key metric across buckle 0–1, over the squash 0.2–0.6 rows:

| scenario | spread |
|---|---|
| wall35 | 0.006 m |
| wall56 | 0.025 m |
| wall64 | 0.029 m |
| offset64 | 0.119 m (at s = 0.2) |
| wall50 | 0.012 m |
| rear50 | 0.002 m |
| side50 | 0.000 m |
| head-on 28 | 0.018 m |
| head-on 56 | 0.035 m |
| T-bone | 0.001 m |

Buckle is a visual knob. The wall56 skin fold at the hit:

| setting | wrinkle amp | skin fold at the hit |
|---|---|---|
| default 0.32 / 0.45 | 0.211 | 0.023 m |
| 1 / 1 | 0.610 | 0.102 m |

## 4. Rear stroke data fix

`hitStroke` scales a rear hit's stroke by `chassisRear.maxCrush / chassisFront.maxCrush`. The scaling is data
(`rig-spec.ts` `CAGES`); the code is unchanged. I set chassisRear maxCrush to 0.38 (was 0.45), so the rear stroke
is 0.69× the front (was 0.82×). The same value also scales the rear cage's skin crush (`maxCrush · compression`)
and its cap.

Tail ÷ 50 km/h nose (worse corner), buckle 0 / 0.45 / 1:

| squash | rear 0.45, full | rear 0.38, full | rear 0.38, slomo |
|---|---|---|---|
| 0.20 | 1.09 / 1.07 / 1.05 | 0.88 / 0.87 / 0.86 | 0.88 / 0.87 / 0.86 |
| 0.25 | 1.05 / 1.04 / 1.03 | 0.86 / 0.85 / 0.84 | 0.86 / 0.86 / 0.84 |
| 0.30 | 1.08 / 1.07 / 1.06 | 0.89 / 0.87 / 0.87 | 0.92 / 0.92 / 0.91 |
| 0.35 | 1.02 / 1.02 / 1.05 | 0.84 / 0.83 / 0.87 | 0.93 / 0.93 / 0.92 |
| 0.40 | 1.03 / 1.00 / 1.03 | 0.84 / 0.82 / 0.85 | 0.94 / 0.93 / 0.92 |
| 0.45 | 1.01 / 0.98 / 1.02 | 0.83 / 0.81 / 0.84 | 0.84 / 0.82 / 0.81 |

With rear 0.38, the range is **0.806–0.939** for squash 0.2–0.45, every buckle, full speed and slomo. That is at
least 0.06 inside both edges of the sourced 0.6–1.0 band. Tail permanent stays at 0.20–0.32 m, inside 0.15–0.40,
and rear cabin intrusion is ≤ 0.03 m. A first try at 0.40 (factor 0.73) left slomo at 0.97–0.999 for squash
0.3–0.4, so I went to 0.38.

On `fe381c3` (CrashRealism6's crumple ordering merged) the same check reads **0.778–0.855** at buckle 0.45 for squash
0.2–0.45, full speed and slomo: still at least 0.14 inside both edges.

## 5. Known issues (not fixed here; numbers from the lane tree)

### 5.1 Piston-corner far-door intrusion: a noisy step function

Test: `piston-rig.test.ts` "when the frontLeft piston fires, then cabin intrusion stays under 0.06 m, except at the struck door" (and the same for frontRight). A
1500 kg, 40 km/h rigid piston at the front corner moves the **far** door:

| squash | 0.20 | 0.25 | 0.30 | 0.32 | 0.34 | 0.36 | 0.38 | 0.40 | 0.42 | 0.45 |
|---|---|---|---|---|---|---|---|---|---|---|
| far door (m) | 0.066 | 0.056 | 0.062 | **0.055** | 0.059 | 0.059 | 0.057 | 0.054 | 0.055 | 0.054 |

The behaviour is not monotonic: 0.32 passes with **0.005 m** margin, 0.30 fails by 0.002, and base 0.4 had 0.006
margin. Buckle 0.2–1 does not change it. Suspected cause: far-door shove inertia. The free car is shoved sideways
and the far door closes on the cell, the same mechanism as the existing `left:cabin` / `right:cabin` TODOs.

### 5.2 Corner paint under-reads the particle dent at low squash

Test: `skin.test.ts` "when the frontLeft piston shoots it, then the paint dent is at least 75% and at most 105% of the dent of the particles it struck" (and the same for frontRight)
(ratio ≥ 0.75):

| squash | 0.20 | 0.25 | 0.30 | 0.32 | 0.34 | 0.36 | 0.38 | 0.40 | 0.42 |
|---|---|---|---|---|---|---|---|---|---|
| paint ÷ particle | 0.63 | 0.72 | 0.705 | **0.761** | 0.760 | 0.751 | 0.769 | 0.804 | 0.793 |

0.32 passes with **0.011** margin. This is also a step function: the struck bumper particle jumps from 0.163 to
0.183 m between 0.30 and 0.32. Buckle 0.2 → 1 adds only 0.02 to the ratio. Suspected cause: corner skin anchoring
at low squash, where the corner cluster's fitted dent stays shallower than its particles.

### 5.3 Derby stalemate: the last two cars push without dying

**Status on `fe381c3`.** CrashRealism6 now runs the derby tests at explicit knobs (`derby.test.ts` `REALISTIC` =
squash 0.32, rear 0.38, each car's class `killTravel` at realism 0.25, i.e. this lane's defaults; `ARCADE` = main's old
0.4 / 0.45). The elimination target is an `it.todo`; the zip test passes at both knob sets. At `REALISTIC`, seeds
7 / 11 / 13 / 17 / 19 die at [33.4, 39.4, 59.9, 88.2] / [51.4, 72.6, 82.0] / [22.6, 71.4] /
[18.1, 23.6, 30.5, 37.7, 38.1] / [36.4, 36.7, 69.1, 78.9] s: 18 deaths, none before 18 s, 1 of 5 matches ends by
elimination. CrashRealism6 measured that a sedan's 0.45 m kill travel needs ≈ 20 nose rams at 40 km/h closing, and
that a 0.30 m kill travel (realism ≈ 0.62) ends 5/5; the remaining lever is Handling's kill travel or harder AI rams,
not crush. The history below is the measurement that led there.

On `107db69` the elimination test failed at the new defaults: seed 7 had one death (49.7 s) by 90 s. The owner's
9-car derby zip test also flagged one slice at squash 0.32 (o4 moved 0.12 m in 5.7 ms at 3.7 m/s, limit 0.113 m); at
0.4 it flagged none.

Six-car seed probe on `107db69` (seeds 7, 11, 23, 31, 42; "elim" = the match ends before 90 s), with squash and
the rear maxCrush varied separately:

| squash | rear maxCrush | eliminating seeds | earliest deaths | owner-derby zips |
|---|---|---|---|---|
| 0.40 | 0.45 (main) | 4/5 | 5.0 s and 8.0 s in every seed | 0 |
| 0.32 | 0.45 | 3/5 | 13.9–24.7 s | 1 |
| 0.40 | 0.38 | 1/5 | 9.3–40.4 s | 0 |
| 0.32 | 0.38 (lane) | 1/5 | 15.8–49.7 s | 1 |

Measured: the rear maxCrush is the larger lever on derby lethality (4/5 → 1/5 at squash 0.4; 3/5 → 1/5 at 0.32).
Inferred, not traced per death: the most common late contact is a nose into a rear (front→rear 125 of 370 hits
in seed 7), so a shorter rear stroke keeps more of those hits from pushing the block past the kill line. If so,
main's 4/5 relies on rear hits at derby speed (≈ 43 km/h) killing engines, against the `barrier.test.ts` rule
that backing into a wall well under 80 km/h leaves the block alive. When a car dies is the arcade ↔ real axis
(Handling's `killTravel`), not the crush calibration.

Decision: keep rear 0.38 and the sourced ratio margin. Derby pacing is restored through the graded death model
(CrashRealism5's `drivetrainHealth` plus Handling's kill point on the arcade ↔ real slider), not by lengthening the
rear stroke again. Main's 5–8 s deaths in every seed are also the "dies immediately" case the design pillars rule
out. This lane lands after CrashRealism5, and is re-checked after Handling's graded death if the derby test
still needs it.

**Wall re-hits (first suspect, not the derby cause).** One car's nose hit into the slab 20 times
(`.bench/crush-calibration/accum-probe.ts`) never died at 12 m/s: engine travel stayed at 0.140 m (squash 0.4) or
flipped 0.048 ↔ 0.105 m (0.32), under the 0.15 m kill. CrashRealism5 traced that to the barrier never re-arming a
wreck, plus the harness relaunching within the re-arm quiet time. It is fixed on its lane (`e83663e`): 12 m/s at
squash 0.4 now reads 0.075, 0.222 † on hit 2. Car-car contact already re-armed, so this was not the derby cause.

**Derby duel, measured** (seed 7, instrumented copy of `runDerby`, 90 s). fwd = max over engineL/R of
rest.z − local.z:

- **Live cars carry engine displacement past the kill line.** At squash 0.32, c3 is alive at t = 90 s with fwd
  0.258 m. At 0.4, c1 stays alive at 0.263–0.286 m from t = 50 s and c2 at 0.247 m from t = 10 s.
  `updateDrivetrain` measures travel only along the current hit's `impactInward` and returns early on side-classed
  hits, so the block can sit 0.25 m back on a live car.
- **The late duel is pushing, not ramming.** After 30 s at 0.32 there are 370 scored hits with closing speed
  p50 0.0 m/s and p90 8.2 m/s (nose-first: p50 0.0, p90 3.7). Faces: front→rear 125, side→front 87,
  rear→rear 67. At 0.4: p50 5.1, p90 10.9.

Routed to CrashRealism5, whose graded `engineTravel` / `drivetrainHealth` (`34a0b16`) is the place to measure
displacement independent of the hit direction. Re-run the 5-seed probe after it merges; the target is ≥ 4/5 seeds
ending by elimination within 90 s, with no death before about 8 s.

Real derby elimination rules (`.extraResearch/perplexity/50-derby-elimination-rules.md`):

- A mandatory aggressive hit every 60 s (some books use 90 s or 2 min).
- A car that does not move for 60 s is out.
- The last car to make a legal hit wins.

These are worth adding to `DerbyMatch` as their own feature. They would not end this duel, because both cars keep
scoring hits.

### 5.4 Head-on 2×56 pulse is too short

The full-speed probe reads 50 ms (1 frame under the 60 ms floor). Slomo measures 29–37 ms for squash 0.15–0.35,
about half the 60–150 ms band, at every realistic squash. This is a pair-contact stiffness issue, not a knob
issue.

### 5.5 Crumple absorb-then-transmit tests (CrashRealism5, `7be2ad2`) — fixed on `fe381c3`

**Status.** CrashRealism6 fixed all four (`ce8b656`, `8be85c4`): the block holds on its mounts until the nose packs,
a packed nose no longer crushes past its packed length, repeated hits build up to the same energy as one hit
(two 35s alive, three dead, at squash 0.32 and 0.4 alike), and the 40 km/h car/rig engine sag matches (43 / 43 mm).
Its `barrier.test.ts` now runs each crumple test at both 0.4 and 0.32 with the 52 km/h packing fixture, which
supersedes this lane's single-squash re-pin. Full suite on `fe381c3` + this lane: 666 tests, 614 pass, 0 fail.

What they measured on `7be2ad2`, when four tests written at 0.4 failed at 0.32 and passed with only the default
put back to 0.4 (`.bench/crush-calibration/absorb-probe.ts`, `kill-probe.ts`, `packed-probe.ts`):

| test | 0.30 | 0.32 | 0.35 | 0.40 | reading |
|---|---|---|---|---|---|
| barrier: block stays on its mounts until the nose packs (block ≤ 0.045 m while gap > 0.56) | 43 km/h: 0.046 @ gap 0.584 | 0.045 (fails, > 0.045) @ 0.576 | 0.044 @ 0.564 | 0.060 @ 0.540 (skipped: packed) | the block crept 0.036–0.046 m before packing at every squash; at 0.4 the 43 km/h check never ran |
| barrier: repeated 35 km/h hits kill within three | hit 4 | hit 4 | hit 3 | hit 2 | single-hit kill was 54 km/h (0.32, 0.35) or 52 km/h (0.4); three 35s carry 61 km/h of EBS² |
| contact-parity 40 km/h front, engine crush car / rig (≤ 10 mm or 15 %) | 73 / 54 | 72 / 61 | 66 / 66 | 66 / 64 | noisy; 0.32 missed by 0.2 mm |
| barrier: a packed nose takes nothing of the next 35 km/h hit | — | fixture | — | — | 50 km/h left the nose 18 mm long of packed at 0.32 |

After a packing first hit, the next 35 km/h hit crushed the nose **past** the packed length (gap before → after):

| first hit | squash 0.32 | squash 0.4 |
|---|---|---|
| 50 km/h | 0.558 → 0.540 | 0.540 → 0.540 |
| 52 km/h | 0.543 → 0.470 | 0.541 → 0.455 |
| 54 km/h | 0.543 → 0.455 | 0.542 → 0.531 |
| 56 km/h | 0.545 → 0.510 | 0.543 → 0.511 |

The old test had passed only because 50 km/h at 0.4 was the one safe fixture.

### 5.6 T-bone struck door swings instead of intruding (`fe381c3`, every squash) — fixed by `crash-realism-7`

The 50 km/h T-bone's struck door particle moves 0.02 m at every squash and buckle (target 0.12–0.28 m). The door
part ends with its hinge at 0.25 and the mirror torn off, and the bullet's nose still crushes 0.24 m.

**Correction:** the 0.21–0.28 m recorded on `b9c5647` was not a crush. A per-frame trace shows the door at ≤ 0.01 m
for 0.9 s there too; the bullet then drove through the struck car (cell 5 m past) and the door particle read
0.21–0.28 m as it passed. Nor did it come with `partContactPair`: car-car contact never gave the struck car momentum
(RIG_ANALYSIS §6.6). With the side-contact fix the door intrudes 0.242 / 0.263 m (squash 0.32 / 0.4) within 0.1 s
and the bullet stays 2.4 m clear of the struck cell.

### 5.7 A faster head-on crushed less (lane `car-crush`, main `73439a8`) — fixed

Owner (10-04): hard car-v-car hits no longer eject. Measured through the sandbox engine step (`tickWorld` + `EjectionWatch`,
class-dressed cars at the HUD defaults, `.bench/crush/table.ts`): a 2×30 m/s head-on killed both engines (block 0.52 m, 80 %
of the stroke used), 2×40 and 2×55 left both alive at health 0.21 / 0.17 with the block at 0.36–0.37 m. Every faster
head-on did less. T-bone and rear-end strikers grow monotonically and never moved (31 m/s is where a sedan striker's block
crosses the 0.15 m throw line; a struck door or tail spares its engine by design).

Mechanism (per-slice ledger, `.bench/crush/dbg.ts`): `tyreStop` (`pair-contact.ts`, b4b76d9) is the pair's final stop and
cancelled the whole closing at the first wheel-on-wheel touch. The wheels meet with the cars' centres 3.3 m apart; the
hub-pop rule (`HUB_OVERRUN`) takes a wheel once its corner is within 0.12 m of the hub, 0.60 m of crush (rig-spec: bumper
z 2.06, hub 1.34), and `tyreStop` skips popped hubs. At 30 m/s the corner has crushed 0.58 m as the tyres touch and pops
the hubs a slice later, so the noses crush on to their full stroke; at 55 m/s the corner has crushed only 0.44 m when the
tyres meet. The ledger: 58.3 ms closing 103 → 59 m/s (tyre sweep, `first` 0.58), 62.5 ms the remaining 59 m/s cancelled
at once with 0.45 of the stroke used; the block never reached the cabin. The crush feed, the SAT push, `brakeInbound`
and the re-arm were not at fault (`followGroup` writes no vertical speed in either head-on: max |v.y| 0.000).

Fix: end-on tyre contact (normal within 45° of both headings) whose hit stroke reaches both wheels (`hubReach`: the
stroke is at least the corner crush that overruns the hub, 0.60 m; the derby's 4–13 m/s hits never do, a first version
without this gate tore wheels off in the ten-car derby and zipped 5 of 8 seeds 5–28 cm) and has stroke left in either nose
(`strokeUsed` < 0.9, B1's gate) tears the touching wheels off their hubs instead of stopping the pair; the packed stop (B1)
and, with the stroke spent, the tyres still end it. Head-on, sedan / sedan (block m, health, thrown), before → after:

| 2× m/s | 20 | 25 | 30 | 40 | 55 |
| --- | --- | --- | --- | --- | --- |
| block (m) | 0.30 → 0.30 | 0.46 → 0.46 | 0.52 → 0.51 | 0.36 → 0.51 | 0.37 → 0.59 |
| health | 0.33 → 0.33 | 0 → 0 | 0 → 0 | 0.21 → 0 | 0.17 → 0 |
| alive | yes | no | no | yes → no | yes → no |
| both thrown | yes | yes | yes | yes | yes |

The block reads the frozen value at death above the kill (0.45 m sedan, 0.536 monster); the nose is the crush measure:
`runPair` 100 / 115 / 130 / 150 / 180 / 200 km/h mean nose 0.757 / 0.586 / 0.814 / 0.51 / 0.53 / 0.50 m → 0.794 / 0.815 /
0.878 / 0.864 / 0.838 / 0.835 m (the stroke cap). `vehicle/ejection-matrix.test.ts` pins every striker × struck class
pair (sedan, truck, monster) of the head-on, T-bone and rear-end at a survivable and a lethal speed and a speed ladder;
`crash-parts.test.ts` pins the nose ladder. REPLAY_VERSION 14.

## 6. Owner's 1/1 setting (lane tree, `fe381c3`)

Full speed: score 0.475, 16 targets missed. Slomo: score 0.504. Max quiet drift 0.27 rad, no spin-clamp frames.

| scenario | measurement | target |
|---|---|---|
| wall35 | drivetrain dead, avg g 8.1 | alive, 11–16 g |
| wall56 | nose 0.77 m | 0.25–0.50 m |
| wall56 | COM travel 0.91 m | 0.35–0.60 m |
| wall56 | avg g 11.3 | 18–25 g |
| wall56 | cabin 0.06 m | < 0.06 m |
| wall64 | nose 0.84 m | 0.29–0.57 m |
| offset64 | nose 0.95 m | 0.30–0.60 m |
| rear50 | tail 0.48 m | 0.15–0.40 m |
| head-on 2×28 | nose 0.45 m (drivetrains now survive) | 0.12–0.26 m, alive |
| head-on 2×56 | nose 0.92 m | 0.25–0.50 m |
| T-bone 50 | bullet nose 0.42 m | 0.08–0.30 m |

No spin-clamp frames: it is stable. The 56 km/h nose crush exceeds the 0.65 m crumple length, which is why the slider
tops out at a 0.75 m stroke (squash 0.729). Stability did not set that cap.

## 7. HUD

`hud-sections.tsx` TuningSection:

- **Stroke** (aria "Crush stroke @56 km/h (m)"): the slider and the number field show the dynamic crush stroke of a
  56 km/h full-width barrier hit in metres (`strokeAt56(squash)`, i.e. `crushStroke(15.56, squash)`). Range
  0.40–0.75 m (`STROKE_RANGE_M`), step 0.01 m. Moving it writes `squashForStroke(m)`.
- **Wrinkle** (aria "Panel wrinkle"): buckle, 0–1.
- **Tooltips:** both rows have one stating the meaning, the real band and, for Stroke, the default (from
  `INITIAL_HUD`).
- **Defaults** restores exactly `INITIAL_HUD`, including Handling's `realism` (arcade ↔ real, `KNOB_RANGES.realism`
  0–1) and the player's car class.

## 8. Phase 1 history (`0e83d6f`)

- **Squash 0.25 recommendation:** phase 1 recommended squash 0.25 because the rear tail then did not follow the
  slider (0.14–0.18 m for every squash), and the ratio test needed a softer front. Main has since changed the rear,
  so that reasoning no longer applies.
- **Yaw-ratchet positive control** (followGroup yaw measured on the local engine→axle vector): it changed no metric
  by more than 0.02 m within the 1.5 s window. It removed the T-bone spin-clamp frames at 0.8/1 (6 → 1) and 1/1
  (4 → 0). Main has since fixed it; the phase-2 grid shows no spin-clamp frames.
- **Offset64 clip-through:** the mass centre ended 0.12–0.26 m past the slab face. It is fixed on `b9c5647`
  (0.00 m in every cell).

## 9. Reproduce

```
npm run sweep                                             # grid + default, .bench/crush-sweep/
npm run sweep -- --cells 0.2:0.45,0.25:0.45,0.3:0.45,0.32:0.45,0.35:0.45,0.4:0.45,0.45:0.45
npm run sweep -- --slomo --cells 0.3:0.45,0.32:0.45,0.4:0.45 --scenarios wall56,offset64,wall50,rear50,headon28,headon56,tbone50
npm run sweep -- --cells 0.32:0.45,1:1 --after 6          # long settle
```
