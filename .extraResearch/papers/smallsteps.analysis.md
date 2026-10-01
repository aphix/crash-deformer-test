# Small Steps in Physics Simulation (Macklin et al., SCA 2019) — analysis for crash-deformer-test

## Summary

- **Core claim:** at a fixed budget, $n$ substeps of $\Delta t_f/n$ with **one** constraint iteration each beat one step of $\Delta t_f$ with $n$ iterations. Positional error from external forces scales with $\Delta t^2$ (Eq. 3), so halving the step quarters the error. Iterations only reduce the residual of a fixed step.
- **Per-substep solve is XPBD with $\lambda$ reset to 0:** $\Delta\lambda_i=-C_i/(\nabla C_i M^{-1}\nabla C_i^T+\tilde\alpha_i)$ with $\tilde\alpha=\alpha/\Delta t_s^2$ (Eq. 7). The compliance term makes stiffness a material property rather than a by-product of iteration or substep count. Infinite stiffness ($\alpha=0$) stays stable.
- **Loop order (Alg. 1):** predict $\tilde x = x + h v + h^2 M^{-1} f_{ext}$ → project constraints → $v=(x^{n+1}-x^n)/h$. The velocity comes *from* the projection, so constraint corrections carry momentum.
- **Less numerical damping:** with small steps the implicit integrator stops damping motion, so physical damping has to be added explicitly in constraint space (Eq. 8, $\gamma=\tilde\alpha\tilde\beta/h$, $\tilde\beta=h^2\beta$). Velocity error is only $O(\Delta t)$, so damping terms do not gain from substeps.
- **Collision detection once per frame** over the predicted full-frame trajectory, with a margin. The contact set is reused across all substeps, which is what makes substepping affordable.
- **Contact popping fix (Eq. 10):** clamp depenetration per substep to $v_{max}\Delta t_s$ with $C_n + \max(d_0 - v_{max}\Delta t_s, 0)\ge 0$. Without it, separation speed $d_0/\Delta t_s$ grows as substeps shrink.
- **Friction (Eq. 11–12):** position-level attachment constraints; the friction multiplier is clamped by $\mu\Delta\lambda_n$.
- **Numbers:** cloth 1.8 ms (40 iters) vs 2.4 ms (40 substeps); FEM beam 4 / 6 / 12 ms (100 iters / 100 substeps / 100 PCG). Substeps cost about 1.3–1.5× iterations because of per-substep integration overhead, but they reach far higher stiffness. A 1:10⁵ mass-ratio chain shows about 100× lower error. Jacobi on GPU, float32. Precision becomes the limit at very high substep counts.

## Useful content

Equations and tricks that matter for a real-time car body:

1. **Stiffness independent of step count.** For a goal-position constraint $C=x-g$ on a particle of mass $m$, Eq. 7 gives a closed-form per-substep blend:
   $$x \leftarrow x + \alpha_s (g-x),\qquad \alpha_s=\frac{1}{1+m\,\alpha/\Delta t_s^{2}}$$
   This is a drop-in replacement for a hand-tuned per-iteration relaxation factor. As $\Delta t_s\to0$ it approaches 1 (rigid). For a fixed physical compliance $\alpha$ the stiffness converges instead of drifting with the number of iterations or substeps. Cheaper equivalent if only step-count invariance is wanted, not physical units: $\alpha_s = 1-(1-\alpha_{ref})^{\Delta t_s/h_{ref}}$.
2. **Predict → project → derive velocity** (Alg. 1 lines 4, 9, 11). This is what makes the per-substep solve implicit. If positions are corrected without deriving velocity, constraint work never enters momentum: there is no elastic rebound, but also no "implicit" stability benefit for momentum.
3. **Constraint-space damping (Eq. 8)** damps only the deformation velocity along $\nabla C$, not rigid motion. A crash body needs this if it moves to velocity-from-projection, because small steps remove numerical damping and the body would ring and rebound (see the probe below).
4. **Once-per-frame contact set plus margin (Sec. 4.2):** predict each body over the whole frame and collect candidate pairs and features within a margin. Substeps only re-evaluate $C_n$ on that fixed set.
5. **Depenetration speed clamp (Eq. 10):** every per-step positional push must scale as $v_{max}\cdot\Delta t_s$, with no constant floor. Otherwise the correction speed grows with substep count.
6. **CFL bound (Sec. 6.4):** particles move at most $0.3\,r$ per step. The repo's equivalent is `physicsSlice`'s 0.07 m per slice. With mass radii of 0.26–0.5 m (`MASS_SPECS`), 0.07 m is about 0.14–0.27 r, which is in the paper's range.
7. **Limitation:** substeps do not fix velocity-level error such as damping or viscosity. Float precision is a non-issue here because the JS kernel and `Float64Array` goal buffers are float64.

### Measured in this repo (throwaway probe, not committed)

A throwaway Node script (since deleted) drove the `stepCarPair` harness (same order as `CrashEngine.fixedStep`, `pair-contact.ts:174`): two cars head-on in shape mode for 2 s, set up as in `derby.test.ts:205-228`, with call counts taken by wrapping prototype methods. Per car: `crumple` = `crumpleTravel()`, `eng` = engine-mass travel, `rebound` = max separating velocity, `gap` = final z-distance between the cars (negative means the cars passed through each other).

| outer h | v (m/s) | crumple A/B | eng travel | rebound | gap | stepStructure / mass slices / shape calls |
|---|---|---|---|---|---|---|
| 1/60 | 7 | 1.842/1.798 | 0.270 | 0 | 3.56 | 142 / 568 / 480 |
| 1/120 | 7 | 2.069/1.735 | 0.046 | 0 | 2.89 | 282 / 564 / 448 |
| 1/240 | 7 | 1.823/1.781 | 0.084 | 0 | 3.08 | 564 / 564 / 470 |
| 1/480 | 7 | 1.792/1.798 | 0.208 | 0 | 4.19 | 1128 / 1128 / 932 |
| 1/960 | 7 | 1.665/1.707 | 0.223 | 0 | 2.78 | 2254 / 2254 / 1914 |
| 1/60 | 14 | 2.398/2.026 | 0.566 | 0 | 3.00 | 192 / 768 / 368 |
| 1/120 | 14 | 1.798/1.737 | 0.422 | 0 | −3.70 | 382 / 764 / 428 |
| 1/240 | 14 | 1.795/1.746 | 0.504 | 0 | −6.09 | 762 / 762 / 502 |
| 1/960 | 14 | 1.678/1.733 | 0.752 | 0 | −13.06 | 3048 / 3048 / 1440 |

Findings:
- The inner mass-step rate is pinned at 240 Hz for any outer $h\ge 1/240$: the mass-slice count stays about 565 (7 m/s) or 765 (14 m/s) regardless of outer h. Outcomes still vary by up to 6× in engine travel, so the variation comes from per-call state (contact latch, contact pushes), not from the integrator rate.
- No row converges as $h\to0$. At 14 m/s the cars end interpenetrated (negative gap) for every outer $h\le 1/120$ in this harness.
- Internal rebound is exactly 0 in every baseline row, because shape matching is position-only.
- Patching in a naive Alg.-1 velocity update ($v \mathrel{+}= \Delta x_{shape}/h$, env `VUPD=1`) with the current `goalAlpha` gave separating velocities of 4–27 m/s, rising with substep count and up to about 2× the 14 m/s impact speed. That is energy injection. It shows that velocity-from-projection needs compliance-scaled $\alpha_s$ and Eq. 8 damping, not the current per-iteration α.
- Kernel microbench (`npm run bench`, Node): `matchCluster` 2.37 µs, `m3Polar` 1.29 µs, `applyPlasticity` 0.93 µs per call. Each car has **22 clusters** (counted at runtime) over 20 masses.

## Code anchors

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| Substep split $\Delta t_s=\Delta t_f/n$ (Eq. 6, Alg. 1 l.2) | `src/game/streamed-deform.ts:1114-1121` `stepStructure` | variant | `slices = clamp(round(dt*240),1,4)`, so mass integration runs at about 240 Hz. Each slice still runs several shape iterations. |
| Iterations per step (what the paper replaces) | `src/game/streamed-deform.ts:2008` (`iters = contacting ? 2 : stiffnessIters(squash)`), `src/game/shape-match-core.js:502-504` `stiffnessIters` (2..5) | contradicts | The repo buys stiffness with iterations per slice, which is exactly the trade the paper shows is inferior. |
| Outer CFL-style step | `src/game/sat.ts:23-27` `physicsSlice` (0.07 m per slice, floor 1/240) | variant | Same idea as the paper's 0.3 r CFL bound (Sec. 6.4). It bounds anti-tunnelling, not stiffness. |
| Frame loop / accumulator | `src/game/engine.ts:1008-1025` `tickInner` (acc cap 0.05 s, ≤8 steps, 8 ms budget) | variant | `vmax` at 1009 reads `car.speed`, which is only written at spawn (`car.ts:481,498`), by `applyDrive` (`car-drive.ts:74,82`) and at `engine.ts:745`. For mass-active, non-driven crash cars it is stale. |
| Second slicing level | `src/game/engine.ts:1195-1196` `fixedStep` (`slices` 1–3) | variant | A third nesting level. Contacts and SAT run per slice here; `stepStructure` sub-slices again inside. |
| Collision once per frame + reuse (Sec. 4.2) | `src/game/engine.ts:1213-1223` (`collideWith` O(n²) per slice), `1231-1299` (up to 3 SAT passes, O(n²) `resolveCarPair`) | variant | Contact is detected per outer slice and reused across `stepStructure`'s inner slices, which matches the paper. There is no per-frame candidate list; broadphase is an all-pairs distance test (`dx²+dz²>28` at 1220; `dist > 5.2` at `pair-contact.ts:59`). |
| Contact state reused across substeps | `src/game/streamed-deform.ts:1295` (`feedOverlap` sets `overlapFrame`), `1987-1988` (`stepShapeMatch` reads then clears it) | contradicts | The flag is consumed by the **first** inner slice only. Slices 2–4 of the same `stepStructure` call run the non-contact branch: `stiffnessIters`, `goalAlpha`, COM restore, no plasticity. Contact behaviour therefore changes with outer h. |
| XPBD compliance $\tilde\alpha=\alpha/h^2$ (Eq. 5/7) | `src/game/streamed-deform.ts:2003-2007` `alpha`, `src/game/shape-match-core.js:505-507` `goalAlpha` | variant | A fixed per-iteration relaxation factor (0.22..0.84), not h-scaled. Effective stiffness ≈ $1-(1-\alpha)^{iters\cdot slices}$ grows with step count. |
| Jacobi constraint averaging (Sec. 6) | `src/game/streamed-deform.ts:2012-2064` (goal accumulation over overlapping clusters, `goalW` average) | same | Same parallel-Jacobi flavour the paper uses on the GPU. |
| Predict $\tilde x$ (Eq. 3) | `src/game/streamed-deform.ts:2143-2160` `stepMassSlice` (gravity on hubs only at 2146, `world += vel*dt` at 2160) | variant | Order is project-then-integrate (shape at 2138, integrate after), not predict-then-project. |
| Velocity update $v=(x^{n+1}-x^n)/h$ (Alg. 1 l.11) | `src/game/streamed-deform.ts:705-716` `syncShapeFromMasses`, `718-729` `writeShapeToMasses` (`m.vel.set(p.vx…)` with `p.vx` never modified by `stepShapeMatch`) | missing | Shape projection moves positions only, so internal elastic work never becomes momentum. The probe confirms 0 rebound in every baseline run. |
| Constraint-space damping (Eq. 8) | `src/game/streamed-deform.ts:2151-2157` (global `vel *= rate^dt`), `2147` (`vel.y *= 0.12^dt`); lattice `damp` at `477` / `1956-1958` | variant | Ether-style drag on absolute velocity. It is dt-consistent but damps rigid motion too. Lattice beams are explicit spring-dampers. |
| Depenetration speed clamp (Eq. 10) | `src/game/physics-core.js:93-95` `satPushCap` (`0.01 + 0.08*clamp(dt*60,0.04,1.2)`), used at `pair-contact.ts:104,127` and `engine.ts:1377`; per-iteration goal-step cap `streamed-deform.ts:2056-2057` (0.14 m) | variant | Both caps are per step, not $v_{max}\Delta t_s$. The 0.01 m floor gives 0.6 m/s at 60 Hz, 2.4 m/s at 240 Hz and 9.6 m/s at 960 Hz per pass, so correction speed rises with step count — the paper's popping mechanism. The 0.14 m cap is not h-scaled either. |
| Speed limit | `src/game/physics-core.js:20` `CRASH.maxMassMps = 55`, `src/game/physics-util.ts:47` `clampSpeed` | variant | A hard velocity clamp instead of a principled depenetration bound. |
| Friction (Eq. 11–12) | `src/game/physics-util.ts:56` `applyGroundFriction` (used at `streamed-deform.ts:2175,2183,2185`) | variant | Velocity-level Coulomb drag on ground. No position-level static friction. |
| Force estimate from $\lambda$ (Fig. 4) | `src/game/engine.ts:1258-1271` (`pair.impulse` drives cinematics/derby scoring) | variant | Impulse from SAT, not an accumulated multiplier. No λ exists in the shape solver. |
| Plastic flow per unit time | `src/game/shape-match-core.js:350` `applyPlasticity` creep `* Math.max(dt, 1/120) * 10` | contradicts | `stepStructure` slices are 1/240, so every slice is billed 1/120 and creep per second is doubled. Creep rate also scales with slice count above 120 Hz. |
| Rotation temporal smoothing | `src/game/shape-match-core.js:193-219` `stabilizeMat` (blend t = 0.08/0.22/0.55), called per `matchCluster` at `336` | variant | Applied once per iteration per slice with a fixed t, so rotation lag depends on iterations × slices, not time. |
| Explicit springs that limit h | `src/game/streamed-deform.ts:2222-2240` `stepSuspension` (k=11000, c=260, hub 26 kg at 173) | same (explicit) | $\omega=\sqrt{k/\mu}\approx23$ rad/s, so it is stable for $h<0.08$ s. It is no constraint on substep choice. |
| Float precision limit (Sec. 7) | `src/game/streamed-deform.ts:529-531` `Float64Array` goal buffers; JS numbers are float64 | n/a | The float32 issue does not apply. |
| dt-invariance guards | `src/game/crash-physics.test.ts:843-863` ("slomo dt must not raise closing speed"); `src/game/physics-util.test.ts:289-290` (`satPushCap(1/240) < 0.35·satPushCap(1/60)`) | same (intent) | These guard impulse and push scaling only. No test checks that the shape/crumple outcome is invariant to step size. |

## Candidates to implement

Ordered by value/cost. The first four are dt-consistency fixes the paper's analysis exposes, and they are prerequisites for any substep retune.

1. **Latch contact state per `stepStructure` call, not per slice.**
   - Area: correctness.
   - Change: in `src/game/streamed-deform.ts` `stepStructure` (1114), compute `const contacting = this.overlapFrame || this.bidirectional; this.overlapFrame = false;` once, pass it into `stepMassSlice(h, contacting)` → `stepShapeMatch(dt, contacting)`, and delete the read/clear at 1987-1988.
   - Effect: all inner slices of a contact frame use the contact branch (contact α, 2 iters, plasticity, no COM restore). Today only slice 1 of 4 does at 60 Hz outer, but every slice does at 240 Hz outer — a direct cause of the outer-h-dependent crumple in the probe table.
   - Cost: S.
   - Risk: contact frames become more plastic at 60 Hz (plasticity now runs 4× per frame instead of 1×), so tests tuned to today's travel may shift. Pair this with #2.
   - Verify: `npm run test:game` (`crash-physics.test.ts`, `crash-parts.test.ts`, `barrier.test.ts`); re-run a dt sweep (see #9) and expect lower spread in `crumpleTravel()` across 1/60…1/240.

2. **Make plastic creep rate time-consistent.**
   - Area: correctness / realism.
   - Change: `src/game/shape-match-core.js:350` `applyPlasticity`: replace `Math.max(dt, 1/120) * 10` with `dt * 20`. That keeps today's per-slice amount at 1/240 slices (1/120·10 = 1/240·20) and removes the floor, so creep per second no longer scales with slice count. Better: the exact form `creep = 1 - Math.pow(1 - c, dt / (1/240))`, where `c` is the current per-slice value at 1/240.
   - Effect: dent depth independent of slice count and slomo.
   - Cost: S.
   - Risk: low at the current 240 Hz (numerically identical there). It only changes behaviour when slices are below 1/240 (outer h < 1/240 via `physicsSlice` floor ties).
   - Verify: `shape-match.test.ts` plasticity cases, `npm run bench` (`applyPlasticity` ns/op unchanged), dt sweep (#9).

3. **Use real velocities for the `physicsSlice` vmax.**
   - Area: correctness / performance.
   - Change: `src/game/engine.ts:1009` in `tickInner`: replace `car.speed` with `car.velocity.length()`, maxed with the deform masses' fastest `vel` when `car.deform.massActive` (bumpers can outrun the body after a hit).
   - Effect: after a crash, stale spawn speeds (e.g. 20 m/s → h ≈ 1/240 → 4 `fixedStep`s per frame, each with O(n²) pair loops) stop forcing fine steps when cars have stopped. A parked car (`speed = 0`, `engine.ts:745`) launched at 15 m/s gets correct anti-tunnelling slicing.
   - Cost: S.
   - Risk: cars that really are fast get fewer steps than before only if their spawn speed overstated them; tunnelling guard stays exact.
   - Verify: `barrier.test.ts`, `zip.test.ts`, `derby.test.ts`; `scripts/bench-browser.mjs` `physics` ms in the 24-car fleet scene (expect a drop in the aftermath phase).

4. **Scale per-step position caps by dt (Eq. 10).**
   - Area: stability.
   - Change: `src/game/physics-core.js:93` `satPushCap(dt)`: drop the constant `0.01` floor and use `vPush * dt` with `vPush ≈ 5.4` m/s (today's 1/60 value of 0.09 m/frame). In `src/game/streamed-deform.ts:2056-2057` replace the `0.14` per-iteration cap with `vGoalMax * dt` (`vGoalMax ≈ 33.6` m/s = 0.14 m × 240 Hz).
   - Effect: correction speed no longer grows with step rate (today ≈ 0.6 / 2.4 / 9.6 m/s of floor-only push per SAT pass at 60 / 240 / 960 Hz). This removes the paper's "popping" mechanism and probably part of the high-rate interpenetration seen in the probe [INFERENCE].
   - Cost: S.
   - Risk: at 60 Hz an unclamped deep overlap separates more slowly. Keep `CRASH.maxMassMps` as the backstop.
   - Verify: `physics-util.test.ts:289-290` (still holds), `barrier.test.ts`, `crash-physics.test.ts` restitution/bounce cases; the probe's `gap` column should stay positive at 1/120–1/960.

5. **Compliance-based goal blend instead of per-iteration α.**
   - Area: realism / correctness.
   - Change: in `src/game/shape-match-core.js` add `goalBlend(alphaRef, dt)` returning `1 - Math.pow(1 - alphaRef, dt * 240)` (step-count-invariant, calibrated so 240 Hz equals today). Use it in `src/game/streamed-deform.ts:2003-2007` in place of the raw `alpha`. Optional physical form per particle: `1 / (1 + p.mass * compliance / (dt*dt))` with a per-cage compliance taken from `CAGES[].absorption` (cabin ≈ 0, crumple zones high).
   - Effect: stiffness becomes a material property; changing substeps/iterations changes accuracy, not material.
   - Cost: M.
   - Risk: medium — every tuned `goalAlpha`/`squash` interaction is calibrated at 240 Hz × iters. Keep the calibration point exact.
   - Verify: `shape-match.test.ts` (`goalAlpha` ordering test at 155 stays true), crash suites, dt sweep (#9).

6. **One iteration, many substeps in `stepStructure`.**
   - Area: realism / performance.
   - Prerequisites: #1, #2, #5.
   - Change: `src/game/streamed-deform.ts:1117` set `slices = clamp(round(dt * 240 * K), 1, 4*K)` with `K = 4` for free cars and `K = 2` for contacting cars, and set `iters = 1` at 2008. Retire `stiffnessIters` (`shape-match-core.js:502`, its export at 541, `shape-match.ts:83`, the import at `streamed-deform.ts:14`, and its assertion at `shape-match.test.ts:156`). Move `applyPlasticity` to run every K-th substep so its cost stays at 240 Hz.
   - Effect: same `matchCluster` count as today (free: 4 slices × 4 iters = 16; contact: 4 × 2 = 8 per 1/60) but each projection sees a fresh $\Delta t^2$-small prediction. The paper predicts a stiffer cabin and less spurious cluster stretch at equal cost; the probe shows today's iterations do not converge.
   - Per-substep overhead: one sync/write pass and the 20-mass integration loop, about 2–4 Math.pow per mass [INFERENCE ≈ 1–3 µs vs 52 µs per 22-cluster sweep].
   - Cost: M.
   - Risk: medium. `stabilizeMat` blending is per call (see #8), so rotation lag is unchanged only at equal call counts.
   - Verify: `npm run bench` (unchanged per-op), `npm run test:game`, browser bench `physics` ms at 24 cars within ±10 %.

7. **Velocity-from-projection with constraint-space damping (full Alg. 1).**
   - Area: realism.
   - Prerequisites: #5 and #6.
   - Change: in `src/game/streamed-deform.ts` `stepMassSlice` (2135), reorder to predict (`world += vel*dt`, gravity) → `stepShapeMatch` → `vel = (world - prev)/dt`. Add Eq. 8 damping on the goal correction (`Δx = α_s (g - x) - γ·α_s·((x - x_prev)·n̂)`, applied per cluster goal). Remove or lower the global `rate` drag at 2151-2157.
   - Effect: impulses propagate through the body inside one frame (stiff cabin pushes engine/rails rather than just being repositioned). Rigid motion is no longer damped by ether drag.
   - Cost: L.
   - Risk: **high.** The probe's naive version (`VUPD=1`) produced 4–27 m/s rebounds, up to about 2× the impact speed. Metal crashes need e ≈ 0.1, so damping β must be tuned per cage and plasticity must eat the stored elastic energy. Gate behind `mode` until the restitution tests pass.
   - Verify: `crash-physics.test.ts:865-873` (rebound < impact speed), the restitution test near 688, a dt sweep checking that rebound stays below 0.2 × closing speed.

8. **Time-scale `stabilizeMat` blending.**
   - Area: stability / correctness.
   - Change: `src/game/shape-match-core.js:193` `stabilizeMat(R, Rprev, k = 1)`: use `t' = 1 - Math.pow(1 - t, k)` with `k = dt*240/iters`, passed from `matchCluster` (311) and `matchSkinLocal` (449, `k = 1`, per render frame).
   - Effect: rotation lag set in seconds rather than calls, needed once #6 changes call counts.
   - Cost: S.
   - Risk: low.
   - Verify: `shape-match.test.ts` polar/stabilize cases, `npm run bench`.

9. **dt-sweep regression test (tooling).**
   - Area: tooling.
   - Change: add to `src/game/crash-physics.test.ts` a case modelled on the probe: two shape-mode cars head-on via `stepCarPair` (`pair-contact.ts:174`) at outer h ∈ {1/60, 1/120, 1/240}, at 7 m/s and 14 m/s. Assert that the engine-mass travel (`engineL/R` `local` vs `rest`, as in `derby.test.ts:229-233`) differs by < 0.1 m across h, and that the final z-gap stays > 0 (no pass-through).
   - Effect: pins the step-size invariance the paper argues for. It fails today: engine travel spans 0.046–0.270 m at 7 m/s and 0.422–0.566 m at 14 m/s, and at 14 m/s the gap is −3.7 m at h = 1/120 and −6.1 m at 1/240. Note that `crumpleTravel()` alone is too blunt: it varies only ≈13 % at 7 m/s.
   - Cost: S.
   - Risk: none to runtime. It may need #1/#2/#4 to pass.
   - Verify: it is the verification.

10. **Per-frame contact candidate list (Sec. 4.2).**
   - Area: performance.
   - Change: in `src/game/engine.ts` `tickInner` before the `while` at 1014, build `this.pairCandidates` from all pairs whose centres are within `5.2 + 2·vmax·acc` (the `resolveCarPair` radius `pair-contact.ts:59` plus a swept margin). Iterate only that list in `fixedStep` at 1213-1223 and 1255-1274.
   - Effect: for 30 cars, 435 pairs × up to 4 `fixedStep`s × (1 + 3 SAT passes) ≈ 7000 distance tests per frame drop to O(contacts).
   - Cost: M.
   - Risk: low if the margin covers the frame; a missed pair is caught next frame, as in the paper.
   - Verify: `fleet.test.ts`, `derby.test.ts`; browser bench `physics` ms at 24 cars.

### Perf / quality estimate for 10–30 cars

Per car per 60 Hz frame, from the Node microbench (`matchCluster` 2.37 µs incl. polar, 22 clusters, `applyPlasticity` 0.93 µs). Browser V8 JIT should be similar in order [INFERENCE].

| Configuration | matchCluster calls / car / frame | ms / live car | 10 cars | 20 cars | 30 cars |
|---|---|---|---|---|---|
| Today, contact frame at outer 1/60 (slice 1 contact = 2 iters, slices 2–4 free = 4 iters) | 308 | 0.75 | 7.5 | 15 | 22 |
| Today after #1 (all 4 slices contact, 2 iters) + plasticity ×4 | 176 | 0.50 | 5.0 | 10 | 15 |
| Free-but-live (quiet < 0.35 s), 4 slices × 4 iters | 352 | 0.83 | 8.3 | 17 | 25 |
| #6 small steps at equal cost (8 contact / 16 free substeps × 1 iter) | 176 / 352 | 0.50 / 0.85 | same | same | same |
| #5+#6 with compliance, 4 substeps × 1 iter (stiffness kept by α_s) | 88 | 0.23 | 2.3 | 4.6 | 7 |

Columns assume every car is live at once, which is the worst case. `stepMassSlice` skips shape matching when `quietTime() ≥ 0.35` (2136-2138), so typical fleet cost is a fraction of this; this is consistent with the measured ≈10 ms sim at 24 cars.

The paper's lever for this repo is not "more substeps". Once stiffness is compliance-based (#5), substep count becomes a pure accuracy knob that can be set per car: about 8 substeps for cars in contact this frame, 2–4 for cars live but not in contact. That bounds 30-car worst-case shape cost at about 7–10 ms instead of about 22–25 ms, while the cabin stiffness stays fixed by material parameters.

## Not applicable / caveats

- **Energy preservation is not a goal here.** The paper's selling point — less numerical damping, livelier motion, rebound (Fig. 6) — is the opposite of what a crumpling car wants. Today's position-only shape matching is maximally dissipative (0 rebound measured) and that is partly why crashes look "dead" rather than springy. Adopt the stiffness/convergence half (#5, #6) before the momentum half (#7), and only add #7 together with explicit Eq. 8 damping and plasticity.
- **The real stiffness bottleneck may be cluster topology, not convergence.** Only 20 particles in 22 overlapping clusters; the paper's gains are on high-resolution systems (896k constraints, 12800 tets, 1:10⁵ mass ratios). Our mass ratios are about 1:29 (`bumperFL` 9 kg vs `cell` 260 kg), so the error gap between iterations and substeps will be smaller than the paper's 100× [INFERENCE].
- **Contacts are not constraints here.** Car–car contact is SAT impulses plus position pushes (`resolveCarPair`, `pushCar`) and `feedOverlap` energy-based crush. It does not use Eq. 9 inequality constraints re-evaluated per substep, so Eq. 9–12 cannot be adopted literally. Only the dt-scaling discipline of Eq. 10 transfers (#4).
- **Friction is velocity-level on ground only.** Eq. 11–12 attachment friction would only matter for car–car scraping, which the 2D hull SAT handles at velocity level.
- **GPU Jacobi, float32 precision** (Sec. 6, 7): irrelevant. This is a single-threaded JS kernel in float64.
- **λ force estimates (Fig. 4):** nice for crash-pulse telemetry or HUD g-force, but there are no multipliers in Müller shape matching. You would need the XPBD reformulation from #5 with λ accumulation, which costs one extra float per particle per cluster.
- **The 3-level nested slicing (tickInner → fixedStep → stepStructure) is legitimate:** the outer levels exist for anti-tunnelling of 2D hulls (CFL), not stiffness. The paper's "one loop" applies only to the innermost `stepStructure` level.
- **Probe caveat:** numbers come from `stepCarPair` in Node without the engine's barrier/derby clipping, `afterContacts` world bounces or render. The negative gaps at 14 m/s are harness observations and were not reproduced in the browser.
