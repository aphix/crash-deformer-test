# Squash / buckle calibration

Status: phase 1 (measure and document). These numbers were measured on main `0e83d6f`, shape mode, full speed.
The only source change is the harness probe (`crash-scenarios.test-util.ts`): it adds knob overrides, `crushMax`,
`quietYawDrift` and `spinFrames`. Defaults are unchanged. Two solver lanes, crash contact/clamp and shape-match
rest/skin, will shift these numbers. Re-run `npm run sweep` after they land and before applying §6.

## 0. Summary

- **Recommended defaults: squash 0.25 (down from 0.4), buckle 0.45 (unchanged).**
  At 0.25, every crush, pulse, cabin and drivetrain target is in band. The rear/front stroke ratio becomes 0.66,
  which passes the `barrier.test.ts` "tail is softer with a shorter stroke" test that fails at 0.4 (0.49).
  Two misses remain, and neither is caused by the knobs: the offset64 mass centre past the slab face (a contact
  bug), and the 2×56 head-on pulse, which reads 50 ms against a 60 ms floor at the probe's 16.7 ms resolution.
- **Realistic squash band: 0.2–0.45.** Recommended slider span: 0.1–0.7. Better still, re-parameterise the slider
  as "crush stroke at 56 km/h", 0.39–0.73 m, with 0.48 m as the default (§6).
- **Buckle has no measurable physical effect.** Across 0–1 it moves no scored crash metric by more than 0.03 m,
  except the offset64 nose at squash ≥ 0.6. In practice it is a visual wrinkle knob. Relabel it "Panel wrinkle"
  and keep the full 0–1 range.
- **Owner's 1/1 setting:** score 0.545 with 18 of 37 targets missed. At 1/1, a 56 km/h wall leaves 0.82 m of
  permanent nose crush (target 0.25–0.50) at 11 g average (target 18–25). A 35 km/h wall kills the drivetrain.
  A 2×28 km/h head-on crushes each nose 0.46 m and kills both engines. The run is stable: its only spin-clamp
  frames come from the yaw ratchet, and the positive-control fix removes them (§5).

## 1. Knob audit

`s` = squash, `b` = buckle, both 0..1 (HUD `hud.tsx` sliders, `engine.ts:setSquash/setBuckle` clamp to [0,1]).
Values are at s = 0 / 0.4 / 1 unless noted (computed from the formulas; 56 km/h = 15.56 m/s).

| # | consumer (file:line) | formula | physical meaning | values | monotonic / issues |
|---|---|---|---|---|---|
| S1 | `physics-core.js:88 crushStroke` | `(0.035·ebs + 0.02)·(0.6 + s)` | dynamic crush stroke = crumple stiffness (k = m·v²/stroke²) | 56 km/h: 0.34 / 0.56 / 0.90 m | ↑ linear. **The knob's real job.** |
| S2 | `streamed-deform.ts:1172 hitStroke` | `min((0.5 + 1.15s)·1.1, crushStroke)`; side: `min(door band max, ·)`; rear: `× chassisRear/Front maxCrush` | per-hit stroke cap; also sets the barrier brake force `engine-props.ts:138` j = m·v²/(2·stroke) | cap 0.55 / 1.06 / 1.82 m | ↑. Cap never binds ≤ 80 km/h (crushStroke(80, 0) = 0.48 < 0.55): **dead term**. Side hits clamp to the door band (0.278 m) for every s: **side intrusion ignores squash** (§4.3) |
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

**Double counting and coupling**

1. **Squash is three knobs at once.** It is the crush stroke (S1–S3, S7, S8), the shape-match stiffness (S9–S11,
   with opposite signs in contact and in free flight) and two thirds of the plasticity (S12–S14). Buckle gets the
   remaining third of the plasticity plus the visuals.
2. **Contact stiffness rises with squash** (S10 contact α 0.33 → 0.70, S9 contact β 0.19 → 0.40), while the stroke
   lets the same nodes crush deeper. These act in opposite directions inside one slider.
3. **Buckle's plasticity channel is masked.** Permanent nose set is held by `clampLocal`'s `crushSet` (only the
   last 0.08 m springs back), and buckle does not enter that path. So S12–S14 change almost nothing measurable
   (§4.2).
4. **Steps at s < 0.03:** S8 overlap crush turns off, S9/S10 snap to 0.04/0.9, and S15 can disable plasticity.
   Measured outputs barely jump (wall56 nose 0.20 m at s = 0 and s = 0.02), so this is a code smell, not a visible
   cliff.

## 2. Instrument

`npm run sweep -- [--grid 0,0.2,0.4,0.6,0.8,1] [--cells s:b,…] [--scenarios a,b] [--after 1.5] [--root <tree>] [--out <dir>]`
(`scripts/crush-sweep.mjs`). It imports `src/game/crash-scenarios.test-util.ts`, so the frame and contact order are
the same as `CrashEngine.tickInner`. Grid mode always adds the default pair, 0.4/0.45. The script writes
`<out>/sweep.json` (every `CrashResult` per cell) and `<out>/sweep.md`. The default output directory is
`.bench/crush-sweep/`, which is gitignored. A full 6×6 grid plus the default pair is 37 cells × 10 scenarios.
`npm run sweep` alone takes 30.2 s wall time (29.6 s inside the loop), and 44.7 s with three other sweeps running.
Results are deterministic: a repeat run reproduced every cell's score exactly.

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

Targets come from `docs/RIG_ANALYSIS.md` §2/§3.3 and `barrier.test.ts`. Bands at other speeds scale linearly with
v from the cited 56 km/h band, following the linear-spring model in §3.3.

The **score** is Σ w·min(2, miss) / Σ w, where miss = distance outside the band ÷ band width (one-sided bands:
÷ limit; booleans: 0/1). 0 means every target is in band.

**Visual-only output:** `wrinkle` = wrinkle amplitude and skin fold at the hit, recomputed from the run's peak
`crushAmount` (B1/B2). No target constrains it.

**Resolution limits:** the probe samples once per rendered frame, so pulse lengths come in 16.7 ms steps
(50 / 67 / 83 / 100 ms) and avg g jumps with them (14.1 → 11.3 g on wall35 between s = 0.3 and 0.35). The run
ends 1.5 s of sim time after first contact (`--after`).

## 3. Sweep on main `0e83d6f`

### 3.1 Realism score (lower is better; **bold** = row of the default squash)

| squash \ buckle | 0 | 0.2 | 0.4 | 0.6 | 0.8 | 1 |
|---|---|---|---|---|---|---|
| 0 | 0.136 | 0.138 | 0.136 | 0.134 | 0.132 | 0.128 |
| 0.2 | 0.030 | 0.032 | 0.034 | 0.041 | 0.041 | 0.041 |
| **0.4** | 0.052 | 0.053 | 0.053 | 0.053 | 0.052 | 0.054 |
| 0.6 | 0.126 | 0.133 | 0.129 | 0.149 | 0.154 | 0.160 |
| 0.8 | 0.309 | 0.316 | 0.325 | 0.320 | 0.324 | 0.328 |
| 1 | 0.529 | 0.530 | 0.536 | 0.540 | 0.534 | 0.545 |

Default 0.4/0.45: score 0.053, 2 of 37 targets missed. Targets missed per row: s = 0: 14; 0.2: 2; 0.4: 2 (3 at b = 1);
0.6: 12; 0.8: 14; 1: 18. **The rows are flat across buckle.**

### 3.2 Fine squash sweep (buckle 0.45)

| squash | score / misses | wall56 nose / COM / pulse / g | wall35 nose | wall50 nose | rear50 tail | tail ÷ nose50 | head-on 28 / 56 | offset nose / past face | T-bone door | wall64 nose / g |
|---|---|---|---|---|---|---|---|---|---|---|
| 0.10 | 0.062 / 9 | 0.25 / 0.41 / 67 / 22.6 | 0.12 | 0.20 | 0.18 | 0.86 | 0.15 / 0.28 | 0.38 / 0.08 | 0.18 | 0.28 / 34.4 |
| 0.15 | 0.066 / 6 | 0.27 / 0.43 / 67 / 22.6 | 0.14 | 0.23 | 0.18 | 0.78 | 0.15 / 0.31 | 0.42 / 0.10 | 0.20 | 0.32 / 34.4 |
| 0.20 | 0.034 / 2 | 0.29 / 0.46 / 83 / 18.1 | 0.16 | 0.25 | 0.18 | 0.72 | 0.16 / 0.34 | 0.45 / 0.13 | 0.21 | 0.36 / 25.8 |
| **0.25** | 0.044 / 2 | 0.33 / 0.48 / 83 / 18.1 | 0.18 | 0.28 | 0.18 | **0.66** | 0.17 / 0.37 | 0.47 / 0.16 | 0.22 | 0.38 / 25.8 |
| 0.30 | 0.044 / 2 | 0.35 / 0.51 / 83 / 18.1 | 0.20 | 0.29 | 0.19 | 0.63 | 0.21 / 0.39 | 0.50 / 0.20 | 0.24 | 0.41 / 25.8 |
| 0.35 | 0.052 / 3 | 0.38 / 0.53 / 83 / 18.1 | 0.22 | 0.32 | 0.17 | 0.52 | 0.22 / 0.42 | 0.52 / 0.23 | 0.25 | 0.45 / 25.8 |
| 0.40 | 0.053 / 2 | 0.41 / 0.55 / 83 / 18.1 | 0.24 | 0.34 | 0.17 | 0.49 | 0.23 / 0.44 | 0.55 / 0.25 | 0.26 | 0.49 / 25.8 |
| 0.45 | 0.056 / 2 | 0.44 / 0.59 / 83 / 18.1 | 0.26 | 0.37 | 0.17 | 0.46 | 0.24 / 0.48 | 0.58 / 0.26 | 0.28 | 0.50 / 20.7 |
| 0.50 | 0.075 / 7 | 0.47 / 0.61 / 100 / 15.1 | 0.27 | 0.39 | 0.17 | 0.44 | 0.27 / 0.50 | 0.62 / 0.30 | 0.28 | 0.52 / 20.7 |

What drives the misses:

- **s ≤ 0.15:** the car is too stiff. At 64 km/h the pulse is 50 ms at 34 g and the drivetrain survives. Every
  nose is near or under the lower band edge.
- **0.20–0.45:** only two misses remain. The offset64 mass centre ends up past the slab face (0.13–0.26 m,
  growing with squash). This is the open clip-through for the crash-contact lane, not a knob target. The 2×56
  head-on pulse reads 50 ms, 1 frame short of 60 ms, up to s = 0.35. From s = 0.35 the tail ÷ nose50 ratio drops
  below 0.6.
- **s ≥ 0.5:** COM travel, the g levels and the head-on/offset noses leave their bands.

The 0.2 vs 0.25 score gap comes only from the size of the offset past-face miss (a contact bug).

### 3.3 Per-scenario squash response (buckle 0.4; s = 0 → 0.2 → 0.4 → 0.6 → 0.8 → 1)

| scenario | key metric (m) |
|---|---|
| wall35 nose | 0.09 → 0.16 → 0.24 → 0.31 → 0.39 → 0.48 |
| wall56 nose | 0.20 → 0.29 → 0.41 → 0.52 → 0.63 → 0.82 |
| wall64 nose | 0.23 → 0.36 → 0.49 → 0.58 → 0.69 → 0.90 |
| wall50 nose | 0.15 → 0.25 → 0.34 → 0.45 → 0.57 → 0.72 |
| offset64 struck nose | 0.25 → 0.45 → 0.54 → 0.67 → 0.91 → 0.88 |
| **rear50 tail** | **0.18 → 0.18 → 0.17 → 0.16 → 0.16 → 0.14** |
| **side50 door** | **0.27 → 0.28 → 0.28 → 0.28 → 0.28 → 0.28** |
| head-on 2×28 nose | 0.08 → 0.16 → 0.23 → 0.30 → 0.38 → 0.45 |
| head-on 2×56 nose | 0.22 → 0.34 → 0.44 → 0.57 → 0.72 → 0.89 |
| T-bone struck door | 0.15 → 0.21 → 0.26 → 0.28 → 0.28 → 0.28 |
| wall56 pulse ms / avg g | 67/23 → 83/18 → 83/18 → 100/15 → 117/13 → 133/11 |
| wall56 cabin | 0.010 → 0.013 → 0.037 → 0.044 → 0.053 → 0.062 |

Frontal crush is monotonic and roughly linear in squash (wall56 ×4 across the range). Two scenarios do not
follow it:

- **The rear tail does not follow the slider.** It stays at 0.14–0.18 m for every squash, so the rear/front ratio
  falls from 1.18 to 0.20 as squash rises. The tail is held by the `chassisRear` cage, band and beam limits, not
  by the stroke. This is why the `barrier.test.ts` ratio test fails at 0.4 and passes at s ≤ 0.3.
- **Side intrusion is pinned to the door band max (0.278 m).** That holds for side50 at every squash and for the
  T-bone at s ≥ 0.6, through the S2 `min(door band max, stroke)` clamp. The door depth is a cap, not a response.

### 3.4 Buckle effect

Buckle spread is the largest change in each scenario's key metric across buckle 0–1, taking the worst squash row:

| scenario | spread |
|---|---|
| wall35 | 0.014 m |
| wall56 | 0.030 m |
| wall64 | 0.055 m |
| offset64 | 0.221 m (s = 0.6: 0.67 → 0.84) |
| wall50 | 0.012 m |
| rear50 | 0.005 m |
| side50 | 0.009 m |
| head-on 28 | 0.017 m |
| head-on 56 | 0.043 m |
| T-bone | 0.003 m |

At the recommended s = 0.25, buckle 0 → 0.7 leaves every key metric within ±0.01 m and the score is 0.044 for
every buckle.

**Visual only** (wall56, s = 0.25, peak `crushAmount` 0.46 m):

| buckle | wrinkle amp | skin fold at the hit |
|---|---|---|
| 0 | 0.092 | 0.005 m |
| 0.25 | 0.149 | 0.013 m |
| 0.45 | 0.195 | 0.021 m |
| 0.7 | 0.252 | 0.034 m |
| 1 (owner, squash 1, crush 0.87 m) | 0.609 | 0.101 m |

## 4. Yaw-ratchet confound (positive control)

On main, `followGroup` reads yaw from the world engine-mid→axleR vector. That assumes the vector is +z in local
space, but after asymmetric crush `clampLocal`'s permanent set tilts it. The positive-control hunk measures yaw
relative to the same vector taken from the masses' `local` positions. It is copied from `crash-wt/bisect`:
`yaw = atan2(fx, fz) − atan2(lfx, lfz)`. The hunk was applied in a scratch copy under
`.bench/crush-calibration/fixed/` and is not committed. The whole sweep ran on both trees with `--root`.

Max quiet-phase yaw drift per cell, main / fixed (rad). This is Σ|Δ group yaw| per frame once contact has been
quiet for 0.1 s, taking the worst scenario. Spin-clamp frames (|ω_y| ≥ 5.9) are shown in brackets:

| squash \ buckle | 0 | 0.2 | 0.4 | 0.6 | 0.8 | 1 |
|---|---|---|---|---|---|---|
| 0 | 0.08/0.08 | 0.06/0.06 | 0.06/0.06 | 0.05/0.05 | 0.04/0.04 | 0.04/0.04 |
| 0.2 | 0.14/0.02 | 0.11/0.02 | 0.08/0.03 | 0.03/0.05 | 0.02/0.05 | 0.02/0.04 |
| 0.4 | 0.04/0.02 | 0.02/0.01 | 0.03/0.02 | 0.04/0.04 | 0.07/0.07 | 0.18/0.18 |
| 0.6 | 0.21/0.20 | 0.21/0.21 | 0.21/0.21 | 0.20/0.20 | 0.21/0.21 | 0.13/0.13 |
| 0.8 | 0.16/0.10 | 0.13/0.10 | 0.10/0.10 | 0.04/0.05 | 0.00/0.00 | 0.00/0.00 (6 → 1) |
| 1 | 0.05/0.02 | 0.03/0.02 | 0.02/0.01 | 0.02/0.02 | 0.02/0.02 | 0.03/0.03 (4 → 0) |

**Cells that changed once the ratchet was removed (1.5 s runs):**

| cell | change |
|---|---|
| 0.8/1 | 6 spin-clamp frames → 1 (T-bone bullet) |
| 1/1 | 4 spin-clamp frames → 0 (T-bone bullet) |
| 0.8/0 | score 0.309 → 0.308 |
| 1/0.6 | score 0.540 → 0.538 |
| 1/1 | score 0.545 → 0.543 |
| fine 0.35/0 | score 0.051 → 0.048 |
| fine 0.35/0.45 | score 0.052 → 0.050 |
| 0.2/0–0.2 | quiet drift 0.14 → 0.02 rad |

No key metric moved more than 0.02 m. No cell crosses the 0.5 rad drift flag in either tree. With the probe's
1.5 s window, the harness does not reproduce a sustained ±6 rad/s spin at any setting.

**Long settle (`--after 6`; cells 0/0, 0.2/0, 0.4/0.45, 0.6/0.6, 0.8/0.8, 0.8/1, 1/0, 1/1).** The ratchet does
show here:

| cell | metric | main | fixed |
|---|---|---|---|
| 0.4/0.45 | T-bone struck door keeps growing after contact | 0.26 → 0.34 m | 0.29 m |
| 0.4/0.45 | side50 cell shift | 0.08 m | 0.00 m |
| 1/1 | T-bone struck door | 0.38 m | 0.36 m |
| 0.4/0.45 | score | 0.070 | 0.056 |
| 1/1 | score | 0.566 | 0.559 |

Max drift is ≤ 0.66 rad over 6 s in both trees. Independent of the ratchet, and present in both trees, the T-bone
**bullet's nose relaxes from 0.18 to 0.06 m** between 1.5 s and 6 s (default cell). The pair-hit permanent set
is not permanent. That belongs to the shape-match rest/skin lane, not to these knobs.

**Conclusion:** the recommendations below rest on fixed-tree numbers, which match main to ±0.003 in score on
every grid and fine cell. The 1/1 extreme is stable once the ratchet is fixed. None of the range advice below
comes from spin or instability.

## 5. Owner's 1/1 setting vs default vs recommended

| scenario | metric | target | 0.4/0.45 (default) | 0.25/0.45 (recommended) | 1/1 (owner) |
|---|---|---|---|---|---|
| wall35 | nose permanent m | 0.15–0.31 | 0.24 | 0.18 | 0.47 ✗ |
| wall35 | pulse ms / avg g | 60–150 / 11–16 | 83 / 11 | 67 / 14 | 117 / 8 ✗ |
| wall35 | drivetrain | alive | alive | alive | dead ✗ |
| wall56 | nose permanent m | 0.25–0.50 | 0.41 | 0.33 | 0.82 ✗ |
| wall56 | COM travel m | 0.35–0.60 | 0.55 | 0.48 | 0.91 ✗ |
| wall56 | pulse ms / avg g | 60–150 / 18–25 | 83 / 18 | 83 / 18 | 133 / 11 ✗ |
| wall56 | cabin m | ≤ 0.06 | 0.04 | 0.02 | 0.06 ✗ |
| wall64 | nose m / avg g | 0.29–0.57 / 20.5–28.5 | 0.49 / 26 | 0.38 / 26 | 0.87 ✗ / 15 ✗ |
| offset64 | struck nose m | 0.30–0.60 | 0.55 | 0.47 | 0.97 ✗ |
| offset64 | centre past face m | ≤ 0.05 | 0.25 ✗ | 0.16 ✗ | 0.23 ✗ |
| wall50 | nose m | 0.22–0.45 | 0.34 | 0.28 | 0.71 ✗ |
| rear50 | tail m | 0.15–0.40 | 0.17 | 0.18 | 0.14 ✗ |
| rear50 | tail ÷ wall50 nose | 0.6–1.0 | 0.49 ✗ | 0.66 | 0.20 ✗ |
| side50 | door m | 0.12–0.28 | 0.28 | 0.28 | 0.28 |
| head-on 2×28 | nose m / drivetrains | 0.12–0.26 / alive | 0.23 / alive | 0.17 / alive | 0.46 ✗ / dead ✗ |
| head-on 2×56 | nose m / pulse ms | 0.25–0.50 / 60–150 | 0.44 / 67 | 0.37 / 50 ✗ | 0.90 ✗ / 83 |
| T-bone 50 | struck door / bullet nose m | 0.12–0.28 / 0.08–0.30 | 0.26 / 0.18 | 0.22 / 0.14 | 0.28 / 0.37 ✗ |
| all | score / misses (of 37) | 0 / 0 | 0.053 / 2 | 0.044 / 2 | 0.545 / 18 |

Every 1/1 miss comes from squash, which roughly doubles crush and halves deceleration. Buckle 1 vs 0 changes the
1/1 score by 0.016. At 1/1 the 56 km/h nose crush (0.82 m) exceeds the 0.65 m crumple length (`CRASH.crushMeters`).
Skin wrinkle folds reach 0.10 m.

## 6. Recommendations (apply in phase 2 after re-running the sweep)

**Defaults:** squash **0.25**, buckle **0.45**. Change them in `hud-store.ts:INITIAL_HUD`, `engine.ts`
`squash`/`buckle`, the `StreamedDeformation` fields, and the test helpers that pin 0.4/0.45.

What 0.25 gives over 0.4:

- 56 km/h permanent nose crush 0.33 m, centred in 0.25–0.50.
- COM travel 0.48 m, centred in 0.35–0.60.
- Rear/front ratio 0.66 instead of 0.49. This is the currently red `barrier.test.ts` case.
- Offset past-face clip of 0.16 m instead of 0.25 m.
- 64 km/h nose 0.38 m.

**Squash range:**

| span | squash | what it gives |
|---|---|---|
| realistic band | 0.20–0.45 | every crush, pulse, cabin and drivetrain target in band |
| below the band | ≤ 0.15 | stiffer than a real car: 50 ms / 34 g at 64 km/h, drivetrain survives 64 km/h |
| above the band | ≥ 0.5 | COM travel, g levels and noses leave their bands |
| drivetrain limit | ≥ 0.8 | the drivetrain dies at 35 km/h; at 1.0 it also dies in a 2×28 head-on |
| physical crumple limit | > 0.8 | the 56 km/h nose crushes past the 0.65 m crumple length |

Recommended slider span: **0.1–0.7**. This keeps a visible stiff/soft margin around the realistic band. Values
above 0.7 are stable but not car-like, so label them "arcade" or leave them out. This is a realism call; the
ratchet does not force it (§4).

**Re-parameterisation (preferred):** squash already is a stroke multiplier, k = 0.6 + s (S1). At 56 km/h the
dynamic stroke is 0.564·k m, and it matches the measured COM travel (0.48 m at s = 0.25). Name the slider
**"Crush stroke @ 56 km/h"** in metres:

| span | stroke | squash |
|---|---|---|
| slider span | 0.39–0.73 m | 0.1–0.7 |
| default | 0.48 m | 0.25 |
| realistic band | 0.45–0.59 m | 0.2–0.45 |

**Buckle:** keep 0–1 and the 0.45 default. Relabel it **"Panel wrinkle"**: its measurable output is the skin fold
size, 0.5–3.4 cm at the hit at 56 km/h for buckle 0–0.7. The plastic-flow share it carries (S12–S14) is masked by
the `clampLocal` crush set.

**Code-level follow-ups:** these change behaviour, so each needs its own sweep.

- (a) Take squash out of contact stiffness (S9/S10 contact branches) so the slider means only stroke.
- (b) Remove the s < 0.03 switches (S8, S9, S10, S15).
- (c) Make the rear stroke and the side door cap respond to the stroke (S2 rear ratio, door band clamp). Today
  only the front responds.
- (d) Delete the dead `hitStroke` cap term (S2) and the S7 seed floor, or give them a range where they act.

## 7. Reproduce

```
npm run sweep                                    # grid + default, writes .bench/crush-sweep/
npm run sweep -- --cells 0.1:0.45,0.15:0.45,0.2:0.45,0.25:0.45,0.3:0.45,0.35:0.45,0.4:0.45,0.45:0.45,0.5:0.45
npm run sweep -- --root <scratch tree with the followGroup hunk> --out .bench/fixed
npm run sweep -- --cells 0.4:0.45,1:1 --after 6  # long settle
```
