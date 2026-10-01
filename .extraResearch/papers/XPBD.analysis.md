# XPBD (Macklin, Müller, Chentanez, MIG 2016) — analysis for crash-deformer-test

## Summary

- **Compliance instead of stiffness.** Each constraint $C_j$ gets compliance $\alpha_j = 1/k_j$ (SI units: m/N for a distance constraint). The solver uses the time-scaled $\tilde\alpha_j = \alpha_j/\Delta t^2$, so $\Delta t$ appears in the right place and stiffness stops depending on step size.
- **Total Lagrange multiplier per constraint.** $\lambda_j$ starts at 0 each step and accumulates over iterations. The update is $\Delta\lambda_j = (-C_j - \tilde\alpha_j\lambda_j)/(\nabla C_j M^{-1}\nabla C_j^T + \tilde\alpha_j)$, then $\Delta x = M^{-1}\nabla C_j^T\Delta\lambda_j$ (Eq. 17–18). The $-\tilde\alpha\lambda$ term in the numerator is the reason extra iterations converge to one compliant solution (implicit Euler) instead of making the constraint stiffer.
- **PBD is the limit $\alpha=0$.** In that case Eq. 18 becomes PBD's $s_j$. PBD's $k\in[0,1]$ multiplier (and the "exponential $k$" fix from Müller 2007) is a heuristic with no well-defined solution once constraints interact.
- **Force readout for free.** $f_j \approx \lambda_j \nabla C_j^T/\Delta t^2$ is the constraint force. Within 6/2/0.5 % of a Newton reference at 50/100/1000 iterations (chain test). The paper suggests using it for force-dependent effects such as breakable joints.
- **Constraint damping.** With Rayleigh damping $\beta$ (and $\tilde\beta=\Delta t^2\beta$, $\gamma=\tilde\alpha\tilde\beta/\Delta t = \alpha\beta/\Delta t$), the update becomes Eq. 26: numerator gains $-\gamma\nabla C(x_i-x^n)$, denominator gets the factor $(1+\gamma)$.
- **The algorithm is PBD plus three lines.** Predict $\tilde x = x^n + \Delta t v^n + \Delta t^2 M^{-1}f_{ext}$, zero $\lambda$, iterate, then set **$v = (x^{n+1}-x^n)/\Delta t$**. The velocity update is part of the method: time-step independence depends on it.
- **Overhead.** About 2 % (Table 1: 0.97 vs 0.95 ms at 20 iterations). One extra float per constraint.
- **Limitations.** XPBD does not converge faster than PBD. Stopping early still causes "artificial compliance". Stiff ($\alpha\to0$) constraints still need iterations or substeps. Suggested future work: warm-start $\lambda$ from the previous frame.

## Useful content

**Core update (diagonal compliance, Gauss–Seidel), per constraint $j$, per iteration:**

$$\Delta\lambda_j=\frac{-C_j(x_i)-\tilde\alpha_j\lambda_{j}-\gamma_j\nabla C_j(x_i-x^n)}{(1+\gamma_j)\,\nabla C_j M^{-1}\nabla C_j^T+\tilde\alpha_j},\quad \lambda_j{+}{=}\Delta\lambda_j,\quad x{+}{=}M^{-1}\nabla C_j^T\Delta\lambda_j$$

**Specialisations that matter here** (derived, not in the paper):

1. **Particle-to-goal constraint** (shape-matching goal $g_i$, treated as fixed during the projection, as Müller 2005 does). Take $C = |x_i-g_i|$ with $\nabla C = \hat n$, or equivalently the per-axis vector form $C = x_i - g_i$ with $\nabla C = I$. Then $w_i = 1/m_i$ and
   $\Delta\lambda = \dfrac{-(x_i-g_i)-\tilde\alpha\lambda}{w_i+\tilde\alpha}$ and $\Delta x_i = w_i\Delta\lambda$.
   With the goal held fixed, this converges to $x_i = \dfrac{\tilde\alpha\,\tilde x_i + w_i g_i}{\tilde\alpha+w_i}$. So the fraction of the goal error closed per step is $\dfrac{w_i}{w_i+\tilde\alpha} = \dfrac{(\omega\Delta t)^2}{1+(\omega\Delta t)^2}$, with $\omega^2 = k/m_i$. That fraction is independent of the iteration count, and its $\Delta t$ dependence is the physically correct one, **provided** velocity is updated from position.
   Authoring tip: set per-cage $\omega$ (rad/s) and use $\alpha_i = 1/(m_i\omega^2)$. Then $\tilde\alpha/w_i = 1/(\omega\Delta t)^2$ is mass-free.
2. **Distance (beam) constraint:** $C = |x_b-x_a| - L_{plastic}$, $\nabla C = \pm\hat n$, denominator $w_a+w_b+\tilde\alpha$. Use $\alpha = 1/k$ with $k$ in N/m. The existing `kTen`/`yieldK` values are already in N/m and convert directly.
3. **Force estimate:** $F_j = \lambda_j/\Delta t^2$ (N). Use it for force-based plastic yield (a return mapping: if $|F|>F_y$, move $L_{plastic}$ so that $|F| = F_y$) and for breakage thresholds.
4. **First-order (no-velocity) equivalent.** If shape matching stays a pure positional filter (as it is today), XPBD's exact time-step independence does not carry over, because there is no inertia term. The dt- and iteration-exact analogue for $\dot x = (g-x)/\tau$ is $x \mathrel{+}= (1-e^{-\Delta t/\tau})(g-x)$, applied once. Spread over $n$ iterations, use $1-e^{-\Delta t/(n\tau)}$ per iteration. This is Müller-2007-style exponential scaling and inherits that approach's convergence caveat for interacting constraints. It is still the right minimal fix here, because each overlapping-cluster goal is averaged Jacobi-style per particle.

**Measured slice dependence in this repo** (throwaway probes under `/tmp/xpbdprobe`, nothing in the repo was modified).

*How many times the structure step runs per sim second.* `stepShapeMatch` and `applyPlasticity` run once per `stepMassSlice`. The probe replays `physicsSlice` (sat.ts:23) together with the slicing in `stepStructure` (streamed-deform.ts:1117):

| refresh | timeScale | calls / sim-second | slice length |
|---|---|---|---|
| 60 Hz | 1 | 240 | 4.17 ms |
| 144 Hz | 1 | 288 | 3.47 ms |
| 165 Hz (vmax 8) | 1 | 165 | 6.06 ms |
| 60 Hz | 0.032 (`IMPACT_SCALE`) | 1875 | 0.53 ms |
| 144 Hz | 0.032 | 4500 | 0.22 ms |

Per-call `alpha` and the plastic-creep floor are not scaled by dt. As a result, shape stiffness and plastic flow per sim second vary up to about **19×** between real time and the auto-slow-mo used at impact.

*Same contact feed, only the structure slicing changed.* The probe feeds contact (`feedOverlap`) once per 1/240 s and runs 1, 4 or 8 `stepStructure(h/sub)` calls after each feed, for 0.2 s at 14 m/s:

| mode | sub-slices | railL travel | bumperFL | cell |
|---|---|---|---|---|
| shape | 1 | 0.745 | 1.056 | 0.060 |
| shape | 4 | 0.195 | 1.059 | 0.075 |
| shape | 8 | 0.136 | 0.740 | 0.021 |
| shape, contacting flag forced on every slice | 4 / 8 | 0.402 / 0.133 | 1.057 / 1.062 | 0.062 / 0.000 |
| lattice | 1 / 4 / 8 | 0.308 / 0.312 / 0.313 | 1.057 / 1.057 / 1.058 | 0.076 / 0.062 / 0.051 |

- Shape mode: rail crush changes 5.5× with the slice count.
- Lattice mode: rail crush stays within 2 %, because its explicit springs are force-based. Cell travel still drifts about 33 %, which matches the per-call floor on beam shrink.

*Lattice beams are not at a stability limit.* The probe computes $\omega=\sqrt{k_{yield}(w_a+w_b)}$ for all 46 beams; the largest are railL–railR (61 rad/s), doorL–doorR (60 rad/s) and cell–roof (59 rad/s). That gives $\omega h \le 0.26$ at 1/240 s, far below the symplectic-Euler limit of 2. At 1/240 s, $\tilde\alpha = 0.6$–$41$ while $w = 0.015$–$0.22$, so the beams sit in XPBD's soft regime where implicit and explicit behave almost the same. Moving beams to XPBD therefore buys **force readout, force-based yield and the option of near-rigid cabin members**, not stability at the current tuning.

*Current shape tuning expressed as XPBD stiffness.* Contacting: $\alpha=0.32+0.38\cdot0.4=0.472$ with 2 iterations, which closes $F=0.72$ of the goal error per 1/240 s call, i.e. $\tau\approx3.3$ ms, or $\omega\approx384$ rad/s in second-order form. Not contacting: `goalAlpha(0.4)` = 0.592 with `stiffnessIters(0.4)` = 4, giving $F=0.97$ ($\tau\approx1.2$ ms, $\omega\approx1400$ rad/s). The shape constraint is therefore roughly 6–20× stiffer than the stiffest beam: close to rigid within each cluster, with plasticity carrying the actual deformation.

## Code anchors

All anchors were checked against the files today. Line numbers drift as the code changes.

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| PBD stiffness multiplier $k$ applied per call | `src/game/streamed-deform.ts:2003-2008` `stepShapeMatch` (`alpha`, `iters`) | contradicts | `alpha` is a dimensionless fraction per call and per iteration, with no $\Delta t$. Effective stiffness therefore scales with calls per second and with `iters`, which is exactly the PBD flaw XPBD fixes. |
| PBD $k$ authored as a function of material | `src/game/shape-match-core.js:505` `goalAlpha`, `:502` `stiffnessIters` | contradicts | Raising `stiffnessIters` stiffens the cluster non-linearly. XPBD wants a compliance per cluster plus an iteration count that only buys convergence. |
| Correction step $\Delta x = k\,s\,M^{-1}\nabla C^T$ | `streamed-deform.ts:2053-2063` (`ax0 = alpha*(gx-p.x)`, 0.14 m cap `kStep`) | variant | Particle-to-goal projection without mass weighting and without $\lambda$. The 0.14 m cap is per call, so the implied speed limit is 34 m/s at 1/240 s but 263 m/s at a 0.53 ms slow-mo slice. |
| Velocity update $v=(x^{n+1}-x^n)/\Delta t$ | `streamed-deform.ts:705` `syncShapeFromMasses`, `:718-725` `writeShapeToMasses` | missing | The shape-match position change never reaches `vel`: `p.vx` is written back unchanged. Shape matching is a first-order positional filter, not XPBD dynamics. |
| Jacobi averaging of several constraints on a particle | `streamed-deform.ts:2016-2039` (`goalX/goalW` accumulation) | variant | Goals from overlapping clusters are averaged before the step. This is a Jacobi solve with relaxation $1/n_i$. A per-particle $\lambda$ on the averaged goal is the natural XPBD slot. |
| Shape-matching constraint itself (Müller 2005) | `shape-match-core.js:311` `matchCluster` | same | Computes the goal $g = M q + c_m$. XPBD treats the goal as a constraint target; the polar decomposition and $\beta$ blend stay unchanged. |
| Per-constraint storage for $\lambda$ | `shape-match-core.js:242` `makeCluster` (no λ field) | missing | Would hold `lam: Float64Array(3*n)`, zeroed at the start of each `stepShapeMatch` call (or warm-started). |
| Per-constraint compliance $\alpha_j$ | `streamed-deform.ts:1976-1982` `clusterBeta`, `:84-101` `CAGES[].absorption` | missing / contradicts | `absorption` is the only per-cage material knob and is only used to shape $\beta$. Separately, `clusterBeta` indexes `this.cages[ci]` by **cluster** index. The constructor (`:532-563`) splits `bonnet` and `chassisFront` into two clusters each and skips `boot`/`roof`/`chassisRear`/`glassRear` (fewer than 3 members), so the indices no longer line up. The probe confirms 18 cages vs 22 clusters: for example, cluster 4 (doorL/railL/cell/roof) gets roof's 0.52, and front crumple clusters 16/17 get the glass values 0.48/0.50 instead of the extra-cluster default 0.1. A per-cage compliance must not reuse this mapping. |
| Distance constraint, compliance $1/k$ | `streamed-deform.ts:1923` `stepBeams`, `:1956` / `:1958` (`f = kTen*ext + damp*relV`, `yieldK`) | variant | Explicit force springs (symplectic Euler, `:1971-1972`). Already dt-consistent in SI units and stable ($\omega h\le0.26$). XPBD form: $\alpha = 1/k$. |
| Damping $\beta$, $\gamma = \alpha\beta/\Delta t$ | `streamed-deform.ts:477` `damp: Math.sqrt(yieldK * 8)` | variant | Explicit dashpot with damping ratio ζ ≈ 0.17–0.67 (probe). Maps directly to XPBD $\beta$ = `damp`. |
| Constraint force from $\lambda/\Delta t^2$ (breakable joints) | `streamed-deform.ts:1931` (`len > rest*2.2` kills the beam); `src/game/car.ts:890` `evaluateBreakage` (`:898`, `:906-907` glass, `:924-929` part `hingeT`) | missing | Breakage is decided from geometry plus a scalar `impulse > 40`. No force estimate exists. |
| Plastic flow driven by force | `shape-match-core.js:345-350` `applyPlasticity` (`creep = … * Math.max(dt, 1/120) * 10`); `streamed-deform.ts:1965` beam `shrink` (`Math.max(dt*k, 0.03+squash*0.06)`) | contradicts | Both have per-call floors, `max(dt, 1/120)` and `0.03+…`. The floor dominates at 1/240 s and below, so plastic flow per sim second scales with call count. |
| Fixed $\Delta t$ / substeps | `src/game/sat.ts:23` `physicsSlice`; `src/game/engine.ts:1014-1018` (accumulator loop), `:1302` `stepStructure(h)`; `streamed-deform.ts:1114-1119` `stepStructure` (`slices = round(dt*240)`) | variant | $h$ ranges from the leftover remainder (≥ 1e-5 s) up to 8.75 ms, then gets re-sliced. Slow-mo `IMPACT_SCALE = 0.032` (`engine.ts:36`) multiplies calls per sim second. |
| Contact enters as zero-compliance constraint | `streamed-deform.ts:1293` `feedOverlap` (`:1302` `step = clamp(dt/(1/60), 0.35, 2.8)`) | variant | Contact is a positional nibble plus a velocity kill. The 0.35 floor is another per-call term. |
| "Contacting" state per step | `streamed-deform.ts:1987-1988` (`contacting = this.overlapFrame…; this.overlapFrame = false`) | contradicts (slice-dependent) | The first slice of a multi-slice `stepStructure` consumes the flag. The remaining slices run the non-contact branch (`goalAlpha`, up to 5 iterations, COM restore, no plasticity). |
| Already time-correct damping | `streamed-deform.ts:2157` `m.vel.multiplyScalar(Math.pow(rate, dt))` | same (spirit) | Example of the exponential form that is exact in dt. |
| Iteration-count independence test | `src/game/shape-match.test.ts:153-157` (monotonic `goalAlpha`/`stiffnessIters`) ; `src/game/crash-physics.test.ts:843` "slomo dt must not raise closing speed" | partial | No test asserts that crush travel is invariant to slice size or iteration count. |

## Candidates to implement

Ordered by value/cost. Candidates 1–4 are self-contained. Candidate 5 replaces 2 if adopted. Candidates 6 and 7 build on 5.

1. **Slice-invariance regression test** — area: tooling.
   - Change: add a `forModes` case in `src/game/crash-physics.test.ts`, next to the slomo test at `:843`. Spawn the 14 m/s frontal twice. Feed `feedOverlap(…, H=1/240)` identically in both runs, then call `stepStructure(H)` once in run A and `stepStructure(H/4)` four times in run B, for 48 feeds. Assert `travel(d,"railL")` and `travel(d,"cell")` agree within 15 %.
   - Effect: measures the defect. It fails today in shape mode (railL 0.745 vs 0.195) and should pass for lattice railL.
   - Cost: S. Risk: none (test only). Mark it `todo` until candidate 2 or 5 lands.
   - Verify: `npm run test:game`.

2. **Make shape-goal relaxation exact in dt and iterations (first-order form)** — area: correctness.
   - Change, in `streamed-deform.ts` `stepShapeMatch`:
     - Replace the per-call `alpha` with a time constant: `tau = contacting ? tauContact(squash) : tauFree(squash)`.
     - Per iteration, use `a = 1 - Math.exp(-dt / (tau * iters))`. Keep `iters` as convergence of the cluster averaging only.
     - Replace `goalAlpha` (`shape-match-core.js:505`) with `goalTau(squash)`, mapping today's tuning at the 1/240 s reference: `tau = -(1/240) / (iters_ref * Math.log(1 - goalAlpha_old))`. Contacting: ≈ 3.3 ms; free at squash 0.4: ≈ 1.2 ms.
     - Scale the 0.14 m `kStep` cap by `dt * 240`, i.e. a 33.6 m/s speed cap.
     - Update `shape-match.test.ts:155` to assert the monotonic `goalTau` instead.
   - Effect: crush outcome becomes independent of refresh rate (165–330 calls/s), slow-mo (240 → 4500 calls/s) and `stiffnessIters`. Deformation in slow-mo stops being up to ~8–19× stiffer per sim second.
   - Cost: S. Risk: medium. Slow-mo impacts become noticeably softer than today because today's look was tuned under 0.032× slow-mo; expect to retune the two τ curves.
   - Verify: candidate 1's test; existing `crash-physics.test.ts` rebound (`:865`) and slomo (`:843`) tests; `npm run test:game`; browser bench `scripts/bench-browser.mjs` to confirm no per-frame cost change.

3. **Remove per-call floors from plastic flow** — area: correctness.
   - Change:
     - `shape-match-core.js:350` `applyPlasticity`: `creep = 1 - Math.exp(-(0.35 + squash*1.25 + buckle*0.55) * 20 * dt)`. Use 20 rather than 10 because today's `max(dt, 1/120)` makes every 1/240 s call creep as if it lasted 1/120 s, and this keeps the 240 Hz look. Drop the `max(dt, 1/120)`; the 0.85 clamp becomes unnecessary. Use the same exponential for the `creep * 0.45` rotation term at `:375`.
     - `streamed-deform.ts:1965` `stepBeams`: `const rate = Math.max(this.deepCrush ? 14 : 8.5, (0.03 + this.squash * 0.06) * 240); const shrink = -ext * (1 - Math.exp(-rate * dt));`. This turns the old per-call floor into the equivalent rate at 1/240 s (≈ 13 /s at squash 0.4).
   - Effect: plastic flow per sim second becomes independent of slice count. This should also remove most of the lattice cell-travel drift seen in the probe (0.076 → 0.051) [INFERENCE: drift not yet attributed by a probe].
   - Cost: S. Risk: low–medium. Behaviour changes only off the 240 Hz reference: slow-mo plastic flow drops by up to 19× toward the real-time rate, so slow-mo dents get shallower.
   - Verify: candidate 1's test (lattice cell); `npm run bench` (`applyPlasticity` timing; `exp` is one call per cluster); `npm run test:game`.

4. **Hold "contacting" for the whole `stepStructure` call** — area: correctness.
   - Change: in `streamed-deform.ts:1114` `stepStructure`, read `const contacting = this.overlapFrame || this.bidirectional` once, clear `overlapFrame` after the slice loop, and pass `contacting` into `stepMassSlice` → `stepShapeMatch(dt, contacting)`. Delete `:1987-1988`.
   - Effect: 1/60 s calls (4 slices) no longer run 3 of their 4 slices on the free-body branch (higher α, COM restore, no plasticity) mid-impact.
   - Cost: S. Risk: low.
   - Verify: candidate 1 with `stepStructure(1/60)` vs four `stepStructure(1/240)` calls; `crash-parts.test.ts` and `barrier.test.ts` via `npm run test:game`.

5. **True XPBD goal constraints with λ and velocity coupling** — area: realism / correctness.
   - Change:
     - In `shape-match-core.js` add `xpbdGoalStep(p, gx, gy, gz, lam, k, alphaTilde)`, applying Eq. 18 per axis: `dl = (-(x-g) - alphaTilde*lam)/(1/m + alphaTilde)`, `lam += dl`, `x += dl/m`.
     - In `streamed-deform.ts` `stepShapeMatch`: keep a per-particle `lamX/Y/Z: Float64Array(masses.length)` zeroed at entry. Take `alphaTilde = alpha_i/dt²` with `alpha_i = 1/(m_i*omega_c²)`, where `omega_c` is set per cage via a new `CAGES[].omega` field (rad/s; start near today's ≈ 380 rad/s contact equivalent, lower for crumple zones, higher for `chassisCell`). Replace the `alpha*(g-x)` step at `:2053-2063` with `xpbdGoalStep`.
     - After the iterations, add `(x_after - x_before)/dt` to `p.vx/vy/vz` (Algorithm 1, line 16), restricted to the shape-match displacement so `feedOverlap`'s velocity kill is preserved.
     - Fix the `clusterBeta` cluster→cage mapping (store `cageIndex` per cluster in the constructor at `:546-549`; extras get −1) before using per-cage ω.
   - Effect: shape stiffness gets physical meaning (Hz per cage) and is independent of dt and iteration count, including slow-mo. Overlapping clusters converge to a defined compromise. Exposes $\lambda$ for candidates 6 and 7.
   - Cost: M. Risk: high. Shape matching starts storing kinetic energy, so rebound and ringing become possible. Mitigate with XPBD damping: Eq. 26 with $\gamma = \alpha\beta/\Delta t$ per goal, and plasticity bleeding energy as today.
   - Verify: `crash-physics.test.ts:865` rebound and `:843` slomo tests, candidate 1, `npm run bench` (adds about 3 mul-adds per particle per iteration), browser bench for frame-time parity.

6. **XPBD beams with force-based yield** — area: realism / stability.
   - Change: rewrite `streamed-deform.ts:1923` `stepBeams` as an XPBD distance-constraint solve on positions:
     - `C = len - beam.plastic`, `alpha = 1/(ext>0 ? kTen : yieldK*pass)`, `gamma = alpha*damp/dt`, Eq. 26.
     - Store `beam.lam`; report force `F = beam.lam/dt²`.
     - Plasticity as a return mapping: if `-F > beam.yieldF` (new `BEAM_SPECS` column, ≈ `yieldK * rest * 0.02`), set `plastic = max(minLen, len + yieldF*alpha)`. This replaces the rate-based `shrink` at `:1965`.
     - Break when `F > breakF` instead of `len > rest*2.2` (`:1931`).
     - Requires reordering `stepMassSlice` (`:2135`): predict `world += vel*dt` → beams → `vel = (world - prev)/dt` → ground clamp/friction.
   - Effect: dt- and iteration-independent crush that yields at a defined force (crumple-zone "crush force plateau", Bugbear-like). Lets `cell–roof` and `engineL–engineR` become near-rigid ($\alpha\to0$) without substeps.
   - Cost: M–L. Risk: medium–high, because the integrator order changes for hubs and suspension (`stepSuspension` `:2222`).
   - Verify: `crash-parts.test.ts:137` beam snapshot strain, `crash-physics.test.ts:442/453` restoring-spring tests (rewrite them as position-change assertions), candidate 1 (lattice), `npm run test:game`.

7. **Force-driven breakage from λ** — area: realism.
   - Change: add `partForce(part: BodyPartName): number` on `StreamedDeformation`, summing $|\lambda|/\Delta t^2$ of beams/goals whose masses lie in that cage. Use it in `car.ts:890` `evaluateBreakage` in place of the `impulse > 40` term (`:907`) and alongside the `hingeT` thresholds (`:924-929`).
   - Effect: mirrors, bumpers and glass break on load path, not on a global closing-speed scalar. Breakage becomes consistent across slow-mo.
   - Cost: S (after 5 or 6). Risk: low.
   - Verify: `crash-parts.test.ts` detachment cases; browser visual check of a 14 m/s frontal.

8. **Warm-start λ across slices** — area: performance.
   - Change: in candidate 5/6, don't zero `lam` per slice; scale it by 0.8 instead (paper §7 future work). Then lower contacting `iters` to 1.
   - Effect: same converged stiffness with fewer `matchCluster` calls. `matchCluster` dominates the kernel (see `npm run bench`).
   - Cost: S. Risk: medium (stale λ after contact ends gives a spurious push; clear on `quietTime() > 0`).
   - Verify: `npm run bench`, candidate 1.

## Not applicable / caveats

- **XPBD's dt-independence assumes positions drive velocities.** Here, shape matching deliberately does not touch `vel`, and contact (`feedOverlap`) kills inbound velocity positionally. A literal port (candidate 5) changes the energy model; candidate 2 is the faithful minimal fix for the current first-order design.
- **Gauss–Seidel ordering vs. the current Jacobi averaging.** The cluster goals are averaged (`goalW`), not projected sequentially. XPBD's convergence claims are for GS; with Jacobi, mass-split denominators ($n_i w_i + \tilde\alpha$) or averaging are needed to avoid overshoot.
- **The goal is not a fixed function of x.** $g$ depends on all cluster members through $c_m$ and $R$. Treating it as fixed (dropping those gradient terms) is the usual shape-matching approximation and adds error XPBD's derivation doesn't cover; the paper's $K\approx M$ argument does not bound it.
- **FEM/Voigt strain constraints and the volume balloon** (§6.3, §6.5) do not fit a 20-particle control rig. There are too few DOFs for per-element strain; the cage/cluster structure already encodes regional stiffness.
- **Stiffness is not the expensive part.** Measured cost is dominated by render submit and skinning/normals; XPBD adds ≈2 % to solver time and does nothing for the deform/skin budget.
- **Zero-compliance contacts still need iterations.** The paper treats contact as plain PBD. Rigid contacts and near-rigid cabin members ($\alpha\to0$) remain iteration-limited, so `physicsSlice` tunnelling limits stay.
- **Accuracy figures** (6 %/2 %/0.5 % force error) are for a 20-particle chain at 50–1000 iterations. This repo runs 2–5 iterations, so treat λ-forces as approximate (fine for breakage thresholds, not for validation against crash data).
