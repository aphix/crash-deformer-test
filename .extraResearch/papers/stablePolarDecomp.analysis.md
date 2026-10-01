# Müller, Bender, Chentanez, Macklin 2016 — "A Robust Method to Extract the Rotational Part of Deformations" → crash-deformer-test

Paper rewrite: [`stablePolarDecomp.md`](./stablePolarDecomp.md). Every code claim below was checked against the working tree. Numbers marked *measured* come from throwaway node probes (in `/tmp`, since deleted) that imported the real `src/game/shape-match-core.js` / `streamed-deform.ts` / `car-mesh.ts`. One probe also ran a patched **scratch copy** of `src/game` (the repo was never edited). `[INFERENCE]` marks claims that were not measured.

## Summary

- **Problem.** Find the proper rotation $\mathbf{R}$ ($\det = +1$) closest to an arbitrary $3\times3$ matrix $\mathbf{A}$ in the Frobenius norm. In shape matching, $\mathbf{A} = \mathbf{A}_{pq}\mathbf{A}_{qq}^{-1}$ is exactly what `matchCluster` builds.
- **Update rule.** Never solve from scratch. Rotate the previous estimate: $\mathbf{R} \leftarrow \exp(\boldsymbol{\omega})\mathbf{R}$, with
  $\boldsymbol{\omega} = \dfrac{\sum_i \mathbf{r}_i\times\mathbf{a}_i}{|\sum_i \mathbf{r}_i\cdot\mathbf{a}_i| + 10^{-9}}$ (Eq. 7; columns $\mathbf{r}_i$, $\mathbf{a}_i$).
- **Physical reading.** $\mathbf{A}$'s columns are a fixed object. $\mathbf{R}$'s columns are a rigid body pulled toward them by springs $\mathbf{f}_i = \mathbf{a}_i - \mathbf{r}_i$. The step follows the net torque $\boldsymbol{\tau} = \sum_i \mathbf{r}_i\times\mathbf{a}_i$, scaled so a single axis pair gets $\tan\phi \approx \phi$. Both the Frobenius optimum and the polar-decomposition rotation have $\boldsymbol{\tau} = 0$ (Appendices A, B).
- **Robust by construction.** The output is always a rotation; there is no matrix inverse, no SVD and no branch except an early-out. If $\det(\mathbf{A}) < 0$, $\mathbf{R}$ stays proper and goes to the optimal proper rotation (it agrees with Irving et al. 2004 once converged). If $\mathbf{A}$ is singular (rank 2/1/0), the missing directions keep the previous $\mathbf{R}$; with $\mathbf{A} = 0$, $\mathbf{R}$ does not change.
- **Warm start is the algorithm.** $\mathbf{R}$ is stored as a quaternion $\mathbf{q}$ that persists across frames. The paper uses 3 iterations per solve; with warm starts that reaches $F < 10^{-3}$ "almost always". Cold start when no previous value exists: $\mathbf{q} = \mathrm{Quat}(\mathbf{A})/|\mathrm{Quat}(\mathbf{A})|$.
- **Failure mode.** Energy *maxima* (relative rotations of $\pi$) also have zero torque and are fixed points. They form a measure-zero set; the authors never met one, and a tiny perturbation escapes.
- **Cost claim.** 60–80 % faster than Irving's SVD at 3 iterations, "up to 2×" in the slides.
- **Printed code bug.** The Appendix D listing computes `1/|dot| + 1e-9`, not `1/(|dot| + 1e-9)` as Eq. 7 says. Implement Eq. 7.

## Useful content

### The iteration in this repo's conventions (runnable JS)

Conventions match `shape-match-core.js`. An `m3` is a row-major `Float64Array(9)` with `index = row*3 + col`, and it acts on column vectors (`m3MulVecInto`: `out.x = m[0]*x + m[1]*y + m[2]*z`, `shape-match-core.js:42-46`). So column `i` of a matrix `M` is `(M[i], M[3+i], M[6+i])`. Quaternions are `Float64Array(4)` laid out `[x, y, z, w]` (three.js order) and use the Hamilton product. `p ⊗ q` applies `q` first, so left-multiplying by the increment implements $\mathbf{R} \leftarrow \exp(\boldsymbol{\omega})\mathbf{R}$.

This exact code ran in the probes. All numbers in the next subsection come from it.

```js
// R(q): unit quaternion -> row-major rotation (column-vector convention).
function quatToM3(q, R) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  R[0] = 1 - (yy + zz); R[1] = xy - wz;       R[2] = xz + wy;
  R[3] = xy + wz;       R[4] = 1 - (xx + zz); R[5] = yz - wx;
  R[6] = xz - wy;       R[7] = yz + wx;       R[8] = 1 - (xx + yy);
  return R;
}

// Müller et al. 2016, Eq. 7. q is the persistent warm-start state (in/out). R is scratch.
// Caller guarantees A is finite (a NaN in A would otherwise poison q permanently).
function extractRotation(A, q, maxIter, R) {
  for (let it = 0; it < maxIter; it++) {
    quatToM3(q, R);
    let ox = 0, oy = 0, oz = 0, den = 0;
    for (let i = 0; i < 3; i++) {                 // r_i = column i of R, a_i = column i of A
      const rx = R[i], ry = R[3 + i], rz = R[6 + i];
      const ax = A[i], ay = A[3 + i], az = A[6 + i];
      ox += ry * az - rz * ay;                    // sum r_i x a_i  (= axial(A R^T - R A^T))
      oy += rz * ax - rx * az;
      oz += rx * ay - ry * ax;
      den += rx * ax + ry * ay + rz * az;         // sum r_i . a_i  (= trace(R^T A))
    }
    const inv = 1 / (Math.abs(den) + 1e-9);       // Eq. 7 form, NOT the listing's 1/|den| + 1e-9
    ox *= inv; oy *= inv; oz *= inv;
    const w = Math.sqrt(ox * ox + oy * oy + oz * oz);
    if (!(w >= 1e-9)) break;                      // also stops on NaN
    const h = 0.5 * w, s = Math.sin(h) / w, pw = Math.cos(h);
    const px = ox * s, py = oy * s, pz = oz * s;  // p = exp(omega) as a quaternion
    const qx = q[0], qy = q[1], qz = q[2], qw = q[3];
    const nx = pw * qx + px * qw + py * qz - pz * qy;   // q <- p ⊗ q
    const ny = pw * qy - px * qz + py * qw + pz * qx;
    const nz = pw * qz + px * qy - py * qx + pz * qw;
    const nw = pw * qw - px * qx - py * qy - pz * qz;
    const n = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
    q[0] = nx * n; q[1] = ny * n; q[2] = nz * n; q[3] = nw * n;
  }
}

// Policy clamp on the OUTPUT only (q keeps tracking the true rotation). Axis-exact, no
// Gram-Schmidt, and well-defined at angle = pi (unlike the matrix-lerp in m3ClampRotation).
const _qc = new Float64Array(4);
function quatClampedToM3(q, maxRad, R) {
  let x = q[0], y = q[1], z = q[2], w = q[3];
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }        // shortest arc
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s > 1e-12 && 2 * Math.atan2(s, w) > maxRad) {
    const k = Math.sin(0.5 * maxRad) / s;
    x *= k; y *= k; z *= k; w = Math.cos(0.5 * maxRad);
  }
  _qc[0] = x; _qc[1] = y; _qc[2] = z; _qc[3] = w;
  return quatToM3(_qc, R);
}
```

The paper's cold start, $\mathrm{Quat}(\mathbf{A})/|\cdot|$, is Shepperd's matrix→quaternion conversion applied to the non-orthogonal $\mathbf{A}$, followed by normalization. This repo does **not** need it in the sim. Clusters are born and `resetCluster`-ed at rest, so $\mathbf{q} = (0,0,0,1)$ already *is* the warm start.

### Convergence rate (derived here, verified numerically)

Linearize at the optimum $\mathbf{R}^*$. Write $\mathbf{S} = \mathbf{R}^{*T}\mathbf{A}$ with principal values $s_1, s_2, s_3$ (one may be negative if $\mathbf{A}$ is inverted). An error rotation of angle $\theta$ about principal axis $k$ produces torque $\approx\theta(s_i + s_j)$, but Eq. 7 divides by $s_1 + s_2 + s_3$. Each iteration therefore shrinks that error component by

$$\rho_k = \frac{s_k}{s_1 + s_2 + s_3}.$$

So convergence is **linear, not quadratic**. Verified against the probe's measured iteration counts to $|\boldsymbol{\omega}| < 10^{-9}$:

| $\mathbf{A}$ | predicted $\rho$ for the error axis (y) | measured |
|---|---|---|
| pure rotation $\mathrm{rotY}(0.3)$ | $1/3$ | per-iteration errors 9.69e-2 → 3.22e-2 → 1.07e-2 → 3.58e-3 (×1/3) |
| $\mathrm{rotY}(0.3)\,\mathrm{diag}(-0.5, 1, 1)$ (inverted) | $1/1.5 = 0.67$ | 46 iterations ($0.3\cdot0.67^{46}\approx3\text{e-}9$) |
| $\mathrm{rotY}(0.3)\,\mathrm{diag}(1, 1, -0.3)$ (inverted) | $1/1.7 = 0.59$ | 36 iterations |
| $\mathrm{rotY}(0.3)\,\mathrm{diag}(1, 1, 0)$ (rank 2) | $1/2$ | 28 iterations |
| $\mathrm{rotY}(0.3)\,\mathrm{diag}(1, 0, 1)$ (rank 2, null axis = rotation axis) | $0$ | 3 iterations |

Consequences for a car body:

- Convergence slows ($\rho_k \to 1$) for rotation about the most-stretched axis when the others are crushed, and near an inversion where $s_2 \approx |s_3|$. That is the same spot where the paper's Fig. 4 shows the largest gap to Irving's method.
- With per-frame warm starts, the steady tracking lag is roughly $\delta\,\rho^n/(1-\rho^n)$ for per-frame rotation $\delta$ and $n$ iterations. *Measured* worst lag for $\mathbf{A} = \mathbf{R}(t)\,\mathrm{diag}(0.6..0.8, 1, 1.3)$:

| per-frame $\delta$ | n=1 | n=2 | n=3 | n=5 |
|---|---|---|---|---|
| 0.010 rad | 5.8e-3 | 1.6e-3 | 5.5e-4 | 8.2e-5 |
| 0.030 rad | 1.7e-2 | 4.8e-3 | 1.7e-3 | 2.5e-4 |
| 0.040 rad | 2.3e-2 | 6.4e-3 | 2.2e-3 | 3.3e-4 |
| 0.120 rad | 6.8e-2 | 1.9e-2 | 6.6e-3 | 9.9e-4 |

`stepShapeMatch` calls `matchCluster` 2–5 times per step (`streamed-deform.ts:2008-2018`). So 1–2 iterations per call already gives 2–10 warm iterations per step.

### Paper's Figure 2, reproduced (*measured*, 200 k trials each, $\mathbf{A} = \mathbf{I}$, stop at $\|\mathbf{A}-\mathbf{R}\|_F^2 < 10^{-3}$)

- Cold start (uniform random $\mathbf{R}$): 1 it 1.3 %, 2 it 4.0 %, 3 it 17.7 %, **4 it 33.2 %**, 5 it 20.2 %, 6 it 10.9 %, 7 it 5.8 %, ≥ 8 it ≈ 7 %, max 23.
- Warm start (Euler angles in $[-\pi/3, \pi/3]$): 1 it 2.0 %, 2 it 5.4 %, **3 it 88.2 %**, 4 it 4.0 %, ≥ 5 it 0.4 %. This matches the paper's "almost always 3".

### Degenerate and inverted inputs (*measured*, warm start from identity, optimum by 400 random-start runs)

| $\mathbf{A}$ | current `m3Polar` distance to optimum | Eq. 7 converged | Eq. 7, 3 iterations |
|---|---|---|---|
| $\mathrm{rotY}(0.7)$ | 0 | 0 | 0.021 rad |
| $\mathrm{rotY}(0.4)\,\mathrm{diag}(0.5, 1, 1.4)$ | 0 | 0 | 0.016 |
| $\mathrm{diag}(-0.5, 1, 1)$ | 0 (coincidence, see below) | 0 | 0 |
| $\mathrm{rotY}(0.3)\,\mathrm{diag}(-0.5, 1, 1)$ | **0.510 rad** ($F$ 2.377 vs 2.250) | 0 | 0.089 |
| $\mathrm{rot}_{(1,1,0)}(0.5)\,\mathrm{diag}(1, -0.2, 1)$ | **0.653 rad** ($F$ 1.840 vs 1.440) | 0 | 0.058 |
| $\mathrm{rotY}(0.3)\,\mathrm{diag}(1, 1, -0.3)$ | 0 | 0 | 0.061 |
| $\mathrm{rotY}(0.3)\,\mathrm{diag}(1, 1, 0)$ (rank 2) | **0.300 rad** (snaps to $\mathbf{I}$) | 0 | 0.037 |
| $\mathrm{rotY}(0.3)\,\mathrm{diag}(1, 1, 10^{-7})$ | **0.300 rad** (snaps to $\mathbf{I}$) | 0 | 0.037 |
| $\mathbf{A} = 0$, start $\mathrm{rotY}(0.5)$ | snaps to $\mathbf{I}$ | keeps 0.5000 | keeps 0.5000 |
| rank 1 ($\mathbf{a}_1$ only), start $\mathrm{rotX}(0.2)$ | snaps to $\mathbf{I}$ | $\mathbf{r}_1 = \mathbf{a}_1$ exactly; the x-rotation is kept (`R[4]` = cos 0.2 = 0.9801) | — |
| $\mathrm{rotY}(2.0)$ | clamped to 0.77 rad (policy) | 2.0 (then clamp policy applies) | 1.8 |

Why `m3Polar` gets inversions wrong: it runs Higham's iteration, which converges to a **reflection** when $\det(\mathbf{A}) < 0$. It then repairs the determinant by negating **column 2** regardless of which axis inverted (`shape-match-core.js:131-136`). Irving et al. flip the smallest-singular-value axis instead. Whenever the inverted axis is not z, the result is a spurious rotation of up to π about some axis. The 0.85 rad clamp (`:137`) then turns that into a twist of up to 0.85 rad. For $\mathrm{diag}(-0.5, 1, 1)$ the flip gives a π rotation about y with zero off-diagonals, and the matrix-lerp clamp happens to collapse that to $\mathbf{I}$, which is why that row looks correct.

### Other details worth knowing

- **Eq. 8 maximum** (*measured*): with $\mathbf{A} = \mathbf{I}$ and $\mathbf{R}$ = 180° about $(1,1,0)/\sqrt2$, the iteration takes 0 steps and stays at π. A 1e-3 quaternion nudge reaches $\mathbf{I}$ in 25 iterations. In this repo such a case is benign: it keeps the previous orientation, it does not flip.
- **Listing precedence** (*measured*): with $\mathbf{A} = 0$ the literal Appendix D expression gives `q = NaN,NaN,NaN,NaN`; Eq. 7 leaves `q = 0,0,0,1`.
- **Scale invariance.** $\boldsymbol{\omega}$ is homogeneous of degree 0 in $\mathbf{A}$, so huge but finite $\mathbf{A}$ needs no magnitude guard for $\mathbf{R}$. Only $\mathbf{S} = \mathrm{sym}(\mathbf{R}^T\mathbf{A})$ needs bounding, and the existing `FrobeniusI(S) > 1.8` guard already does that.
- **Polar factor.** Once $\mathbf{R}$ is known, $\mathbf{S} = \mathrm{sym}(\mathbf{R}^T\mathbf{A})$ (`shape-match-core.js:139-143`) is still correct. At convergence $\mathbf{R}^T\mathbf{A}$ is already symmetric (Appendix B), so symmetrization only absorbs residual lag and clamp error.
- **Gram–Schmidt critique.** The paper notes that order-dependent frames (Gram–Schmidt) bias orientation and create ghost forces. `m3Orthonormalize` (`:146-173`) is exactly that, column 0 first. It is applied every call after Higham and inside `stabilizeMat`, so it biases toward column 0 (the x axis) whenever the input is far from orthonormal. With Eq. 7 the quaternion is already orthonormal and it is no longer needed.

### Measured on the real car rig

- `new StreamedDeformation(makeChassisGeometry())` builds 22 clusters (`streamed-deform.ts:532-563`). **10 of them have $|\det\mathbf{A}| \approx 10^{-14}$ at every pose**: all nine 3-particle clusters plus the coplanar `[bumperFL bumperFR engineL engineR]`. The test rig `BoxGeometry(1.7, 1.3, 4.3, 3, 2, 6)` gives the same 10. `m3Invert` rejects $|\det| < 10^{-12}$ (`shape-match-core.js:76`), so `m3Polar` takes the `R = S = I` exit at `:110-114` on its first Higham step, every call. Rotating all particles of the box rig rigidly by 0.3 rad: those 10 clusters report angle 0.000 and the other 12 report 0.300 (*measured*; Eq. 7 gives 0.300 for all 22). Peer lane PaperRajala2008 measured the same independently.
- Two triangles are each triplicated: `[engineL railL wingFL]` ×3 and `[engineR railR wingFR]` ×3 (6 of the 10 singular clusters). Goal averaging uses `cw = 1` (`streamed-deform.ts:2019`), so these identity-locked clusters get 3× weight on those particles.
- In the frontal-pulse scenario of `shape-match.test.ts:310-339` (24 frames, 16 m/s), the repo ends with 10 `skinR` at angle 0.00 and 3 at ≥ 0.83 rad. So the 0.85 rad clamp is already active in ordinary crashes.

## Code anchors

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| Rotation extraction (Eq. 7) | `src/game/shape-match-core.js:102-145` `m3Polar` | variant → contradicts on degenerate/inverted input | Higham iteration $\tfrac12(\mathbf{R}+\mathbf{R}^{-T})$, ≤ 12 steps (`:108-124`). The paper's related work names it as the method that yields $\det = -1$ for inverted $\mathbf{A}$ and fails for singular $\mathbf{A}$. Both happen here. |
| "Undefined for singular $\mathbf{A}$" | `shape-match-core.js:74-88` `m3Invert` (threshold `:76`); fallback `:110-114` | contradicts (paper: inherit from previous $\mathbf{R}$) | Singular $\mathbf{A}$ makes $\mathbf{R}$ snap to $\mathbf{I}$, permanently for the 10 planar clusters. |
| Inversion handling (Irving: flip smallest-σ axis) | `shape-match-core.js:131-136` (det < 0 → negate column 2) | contradicts | Flips z regardless of the inverted axis. Measured 0.51 and 0.65 rad wrong (table above). |
| Proper rotation by construction | `shape-match-core.js:146-173` `m3Orthonormalize` (Gram–Schmidt, column 0 first) | variant (paper's §2 critique) | Called at `:130,:135,:138,:191,:211,:216`. Order bias toward the x axis. Unneeded once $\mathbf{R}$ comes from a unit quaternion. |
| Warm start / temporal coherence | `shape-match-core.js:193-219` `stabilizeMat`, `:220-222` `stabilizeR`; state `Rprev` `:266`, `skinRprev` `:268` | variant | Coherence by blending toward the previous matrix (`t = 0.55`, `:209-210`) and re-orthonormalizing, not by iterating from it. The `dot < 0` negation (`:205-208`, gives det −1) and the `t = 0.08` branch are unreachable: *measured* min Frobenius dot between two clamped `m3Polar` outputs over 200 k random pairs is 0.457. |
| Exponential-map update $\exp(\boldsymbol{\omega})\mathbf{R}$ / quaternion state | — | missing | Would live in `shape-match-core.js` next to `m3Polar` (`quatToM3`, `extractRotation`), with `q`/`skinQ` replacing `Rprev`/`skinRprev` in `makeCluster` (`:242-299`). |
| (not in paper) rotation clamp | `shape-match-core.js:178-192` `m3ClampRotation(R, 0.85)` called at `:137`; `:174-177` `m3RotationAngle` | missing in paper (repo policy) | Matrix lerp toward $\mathbf{I}$ + Gram–Schmidt: not axis-exact, and collapses an exact π rotation to $\mathbf{I}$. Keep the policy, reimplement on the quaternion. |
| Polar factor $\mathbf{S}$ | `shape-match-core.js:139-144` (`S = sym(RᵀA)`, guard `FrobeniusI(S) > 1.8`) | same | Still valid after the swap (Appendix B). |
| Shape-matching $\mathbf{A} = \mathbf{A}_{pq}\mathbf{A}_{qq}^{-1}$ (slides 3) | `shape-match-core.js:311-344` `matchCluster` (`:333` A, `:334` guard, `:335-336` polar + stabilize); `:300-310` `rebuildAqqWeighted` (1e-3 ridge `:306-308`) | same | The ridge regularizes $\mathbf{A}_{qq}$, but $\mathbf{A}_{pq}$ of a planar cluster stays rank 2, so $\mathbf{A}$ stays singular. |
| Same, skin path | `shape-match-core.js:449-501` `matchSkinLocal` (`:492` A, `:493` guard, `:494-495` polar + `stabilizeMat`) | same | Called once per crushing frame from `streamed-deform.ts:2284-2288` `bakeLocalSkin` (`:1360`). Feeds `transformSkinPointInto` in `skin` (`:2469`) and `solveCagesFromShape` (`:2307`). |
| Symptom the paper fixes ("temporal incoherence" of fallbacks, slides 7) | `streamed-deform.ts:1363-1368` comment ("jittering polar … flicker", "polar snap-back flicker") | same problem, worked around | The repo gates re-skinning to hide polar snaps. Eq. 7 removes the identity snaps at the source. |
| Iterations per solve (paper: 3) | `streamed-deform.ts:2008-2018` `stepShapeMatch` (2–5 `matchCluster` calls per step) | variant | Per-call iterations should be lower than 3, because the calls themselves are warm iterations. |
| Rotation feeds plasticity | `shape-match-core.js:370-383` `applyPlasticity` (rest offsets rotated by `c.R` when contacting) | same (consumer) | After the swap the 10 planar clusters also feed rotation into `q0`. That is a behaviour change. |
| Reset of rotation state | `shape-match-core.js:392-426` `resetCluster` (`:400` `Rprev`, `:402` `skinRprev`) | same | Reset `q`/`skinQ` to identity instead. |
| Rigid-body orientation from particles | `streamed-deform.ts:1123-1186` `followGroup` (yaw from engine midpoint − `axleR` `:1128-1132`, pitch/roll from heights `:1133-1134`, `prevYaw` fallback `:1132`) | variant (ad-hoc, few-point frame) | The `prevYaw` fallback is a one-axis warm start. A whole-body $\mathbf{A}_{pq}$ + Eq. 7 would use all masses (candidate 5). |
| Public types / re-exports | `shape-match-core.d.ts:35-37` (`Rprev`, `skinR`, `skinRprev`), `:67-71` (`m3Polar`, `m3Orthonormalize`, `m3RotationAngle`, `m3ClampRotation`, `stabilizeR`); `shape-match.ts:41-43`, `:68-72` | — | Must change with the kernel. |
| Tests pinning the current polar | `shape-match.test.ts:44-102` (polar block), `:105-135` (single-call rigid match), `:274-301` (skin must not touch `R`/`Rprev`) | — | See candidate 3 for the re-target. |
| Microbench | `scripts/bench-physics.mjs:31-33` (static A), `:39` `m3Polar` row, `:40` `matchCluster` row | — | A static A would hit the warm-start early-out after the first call, so it cannot measure Eq. 7. See candidate 1. |
| Debug snapshot | `streamed-deform.ts:1795-1800` `snapshot().clusters` (`n`, `names`, `cm`, `plastic`) | missing (no rotation field) | Candidate 2. |

## Candidates to implement

Ordered by value/cost. Items 1–2 are cheap prerequisites for judging item 3. Item 3 is the main change and must ship together with the decision in item 4.

1. **Make `bench-physics.mjs` able to measure a warm-started rotation solver.** *Area:* tooling. *Change:* in `scripts/bench-physics.mjs` add a 1024-entry animated sequence $\mathbf{A}_k = \mathrm{rot}_{(0.3,1,0.2)}(0.6\sin 0.05k)\,\mathrm{diag}(0.6+0.2\sin 0.07k,\ 1,\ 1.3)$ and these rows:
   - `m3Polar (animated A)`;
   - `matchCluster 6-particle animated` (particles written as $\mathbf{A}_k\,\mathbf{x}_{rest}$ before each call);
   - `matchCluster 3-particle planar animated`;
   - `matchSkinLocal 6-particle animated` and `matchSkinLocal 3-particle planar animated` (`matchSkinLocal` is not benched today).

   Keep the static rows (`:39-40`) but label them "converged / early-out". *Expected effect:* before/after numbers that reflect sim use. Today's `:39` row reuses one static `A`, so a warm-started solver would bench its `|ω| < 1e-9` early-out. *Cost:* S. *Risk:* none (bench only). *Verify:* `npm run bench` before and after item 3. *Measured* with this exact harness (node 24, this WSL box, ns/op):

   | row | current kernel | Eq. 7 kernel (scratch) |
   |---|---|---|
   | `m3Polar` animated A | 273 (+ `stabilizeR` = 348) | warm ×1: 86 · ×2: 131 · ×3: 178 |
   | `matchCluster` 6-particle | 495 | 262 (×2) |
   | `matchSkinLocal` 6-particle | 537 | 331 (×3) |
   | `matchCluster` 3-particle planar | 230 (cheap only because it bails out to $\mathbf{I}$) | 241 |
   | `matchSkinLocal` 3-particle planar | 183 | 273 |

   For reference, the current `npm run bench` prints `m3Polar` 307 ns and `matchCluster` 523 ns. Fleet estimate `[INFERENCE]`: 12 volumetric clusters save ≈ 0.23 µs × 2–5 calls per step and the planar ones cost about the same, so ≈ 6–14 µs per car per `stepShapeMatch`. That is ≈ 0.15–0.35 ms per step for 24 cars, plus ≈ 0.04 ms in `bakeLocalSkin`. This is ~1–3 % of the measured 10 ms sim / 15 ms deform. **The case for item 3 is robustness, not speed.**

2. **Expose cluster rotation in `snapshot()`.** *Area:* tooling. *Change:* in `streamed-deform.ts:1795-1800` add `rot: round4(m3RotationAngle(c.R))`, `skinRot: round4(m3RotationAngle(c.skinR))` and (after item 3) `planar: c.planar`. Import `m3RotationAngle` from `./shape-match.ts`, which already re-exports it (`shape-match.ts:70`). *Expected effect:* scenario tests and the browser can see identity-snapped clusters (angle exactly 0 while neighbours rotate) and clamp saturation (≈ 0.85). Both are invisible today. *Cost:* S. *Risk:* none. *Verify:* in the `shape-match.test.ts:310` frontal-pulse scenario, assert no `skinRot` exceeds 0.85 + 1e-6. That holds after item 3, where the quaternion clamp is exact. Today the scenario *measures* 0.86: the matrix-lerp clamp plus Gram–Schmidt and blending is not angle-exact (cause `[INFERENCE]`).

3. **Replace `m3Polar` + `stabilizeMat` with the warm-started Eq. 7 iteration.** *Area:* correctness, stability (performance as a side effect).

   *Change (exact):*
   - `shape-match-core.js`: add `quatToM3`, `extractRotation`, `quatClampedToM3` (code in "Useful content").
   - Rewrite `m3Polar` (`:102-145`) as
     ```js
     function m3Polar(A, q, iters, R, S, planar = false) {
       const ok = m3Finite(A);
       if (ok) extractRotation(A, q, iters, R);   // q persists: warm start
       quatClampedToM3(q, 0.85, R);               // policy clamp on output only
       if (!ok || planar) { m3Id(S); return; }    // planar: see item 4
       m3Transpose(R, _polarRt);
       m3Mul(_polarRt, A, S);
       S[1] = S[3] = 0.5 * (S[1] + S[3]);
       S[2] = S[6] = 0.5 * (S[2] + S[6]);
       S[5] = S[7] = 0.5 * (S[5] + S[7]);
       if (!m3Finite(S) || m3FrobeniusI(S) > 1.8) m3Id(S);
     }
     ```
   - `makeCluster` (`:266`, `:268`): replace `Rprev`/`skinRprev` with `q: new Float64Array([0, 0, 0, 1])` and `skinQ: new Float64Array([0, 0, 0, 1])`, and add `planar: false`.
   - `rebuildAqqWeighted` (`:300-310`): before the 1e-3 ridge, set `const tr = _Aqq[0] + _Aqq[4] + _Aqq[8]; c.planar = m3Det(_Aqq) <= 1e-6 * (tr / 3) ** 3;`.
   - `matchCluster` (`:334-336`): replace the guard and the polar/stabilize pair with `m3Polar(c.A, c.q, 2, c.R, c.S, c.planar)`.
   - `matchSkinLocal` (`:493-495`): replace them with `m3Polar(c.A, c.skinQ, 3, c.skinR, c.S, c.planar)`.
   - `resetCluster` (`:400`, `:402`): reset `q`/`skinQ` to `(0, 0, 0, 1)`.
   - Delete `stabilizeMat`, `stabilizeR`, `m3ClampRotation`, `m3Orthonormalize` and `_polarInv`; with this change they have no remaining callers (verified by grep: only `shape-match.ts` re-exports and the kernel use them). Update `shape-match-core.d.ts:35-37, :67-71` and `shape-match.ts:41-43, :68-72` to match. Export `extractRotation`/`quatToM3` only if a test imports them.

   *Guards — what stays, what goes:*

   | Current guard | After | Reason |
   |---|---|---|
   | `:103` `!m3Finite(A)` → $\mathbf{R} = \mathbf{S} = \mathbf{I}$ | **keep the check, change the effect**: skip the update, so $\mathbf{R}$ = previous clamped rotation and $\mathbf{S} = \mathbf{I}$ | NaN must never reach the persistent `q`; holding $\mathbf{R}$ removes a snap |
   | `:103` `maxAbs(A) > 12 \|\| FrobeniusI(A) > 8` → $\mathbf{I}$ | remove | Eq. 7 is scale-invariant; the `S` guard bounds the stretch |
   | `:110-114` invert failure → $\mathbf{I}$; `:123` Higham stop | remove | no inverse; `w < 1e-9` break replaces it |
   | `:125-129` R finite / `maxAbs(R) > 4` | remove | a unit quaternion always gives an orthonormal R |
   | `:130/:135/:138` `m3Orthonormalize` | remove | as above; also removes the column-0 bias |
   | `:131-136` det < 0 → negate column 2 | remove (it is wrong, see table) | det = +1 by construction |
   | `:137` `m3ClampRotation(R, 0.85)` | **keep the policy**, implemented as `quatClampedToM3`; never write the clamped value back into `q` | gameplay limit; quaternion clamp is axis-exact and defined at π |
   | `:139-144` `S = sym(RᵀA)` + `FrobeniusI(S) > 1.8` | keep | still the right $\mathbf{S}$; still needed for huge or near-inverted $\mathbf{A}$ |
   | `:193-219` `stabilizeMat` | remove | coherence comes from the warm start; per-call lag is set by the iteration count (ρ ≈ 1/3 per iteration vs the old fixed 0.45 blend) |
   | `:334`, `:493` `!finite \|\| maxAbs(A) > 12` → `A = I` | remove (the finite check moves into `m3Polar`) | forcing $\mathbf{A} = \mathbf{I}$ would now drag $\mathbf{R}$ back to $\mathbf{I}$ over a few frames |
   | `:339`, `:341`, `:498` M/skinM `maxAbs` guards; `:342`, `:499` skinM inverse fallback | keep | downstream of $\mathbf{S}$, β, Sp; unchanged |

   *Expected effect:*
   - No more identity snaps: singular, zero, NaN or huge $\mathbf{A}$ holds the previous rotation.
   - Inverted clusters get the optimal proper rotation instead of a spurious twist of up to 0.85 rad.
   - The 10 planar clusters start tracking rotation.
   - `matchCluster` on volumetric clusters runs ≈ 1.9× faster (item 1 table).

   *Cost:* M. *Risk:* **medium–high, because this is a behaviour change, not a refactor.** I ran the full `src/game/*.test.ts` suite on a patched scratch copy (the repo was not touched). The unpatched copy passes 329/330; its one failure, `rest-mesh.test.ts` "writes a side silhouette for visual check", also fails before patching.

   | match / skin iterations | result (vs unpatched) |
   |---|---|
   | **2 / 3 (recommended)** | 1 new failure: the cold single-call unit test `shape-match.test.ts:105` (rigid error 0.154 > 0.05 after one call from $\mathbf{q} = \mathbf{I}$). All scenario tests pass. Frontal-pulse mesh–particle nose gap 0.434 (repo 0.376, limit 0.55). |
   | 3 / 3 | + `shape-match.test.ts:310` nose gap 0.576 > 0.55; + `zip.test.ts` "offset 16 vs 20 m/s must not reverse-slide" |
   | 4 / 4 | + nose gap failure |
   | 5 / 5 | all pass (nose gap 0.514) |
   | 1 / 1 | + nose gap failure, + zip reverse-slide failure, rigid error 0.465 |

   The non-monotonic pattern means these scenario tests sit near their thresholds, so expect retuning. The nose gap is driven by the planar clusters rotating; item 4 has the evidence. Also: with Eq. 7, 7–11 of 22 skin clusters saturate the 0.85 clamp in the frontal pulse, versus 3 today.

   *Tests:*
   - Re-target the polar block `shape-match.test.ts:44-102` to `m3Polar(A, q, 30, R, S)` with a fresh `q`. All five pass in the scratch run, including the NaN case: a fresh `q` stays identity, so `R[0] === 1` and `S[0] === 1`.
   - Make `:105-135` call `matchCluster` 4× (what one `stepShapeMatch` does) instead of once.
   - In `:274-301`, assert `c.q` is unchanged instead of `c.Rprev`.
   - Add regression tests that fail on the current kernel and pass after the change:
     - (a) `A = rotY(0.3)·diag(-0.5, 1, 1)` → angle to `rotY(0.3)` < 1e-3 (current: 0.51 rad);
     - (b) a 3-particle cluster rotated 0.3 rad → `c.R` angle within 1e-3 of 0.3 after 5 calls (current: 0);
     - (c) warm `q` at `rotY(0.5)`, then `A = 0` or NaN → angle stays 0.5 (current: snaps to 0).

   *Verify:*
   - `npm run test:game`;
   - `npm run bench` with item 1's rows;
   - `node scripts/bench-browser.mjs --cars 16,24 --modes fleet,derby` (`deformMs`, `physicsMs`);
   - a visual pass with the debug rig (`createHelper`/`updateHelper`) during a frontal and a side hit.

4. **Decide what planar (rank-2) clusters mean, explicitly.** *Area:* correctness/realism. Today the 10 planar clusters are translation-only (R = S = I) because `m3Invert` rejects them, not by design. Item 3 forces a choice. Scratch-copy results for each option:
   - (a) **Rotate with Eq. 7, keep `S = I`.** The `planar` branch above. All scenario tests pass at 2/3 iterations. Nose gap 0.434.
   - (b) **Rotate and fill the null direction of $\mathbf{S}$** ($\mathbf{S} \mathrel{+}= \mathbf{n}\mathbf{n}^T$, with $\mathbf{n}$ the right null vector of $\mathbf{A}$ = the largest cross product of two rows). Gives in-plane stretch to planar clusters. **Fails** the nose test at every iteration count tried: gap 0.619–0.638. Reject for now.
   - (c) **Lock explicitly** (`if (c.planar) { m3Id(R); m3Id(S); }` before the solve). Nose gap 0.33–0.40, but **fails** `crash-parts.test.ts:182` "right door never hinged" (hingeT 0.056–0.083 < 0.15) when combined with Eq. 7 on the other clusters.

   Recommend (a) and record the choice in a comment at `rebuildAqqWeighted`. Separately, dedupe the triplicated triangles: skip an `idx` set already in `this.clusters` inside the constructor loop at `streamed-deform.ts:533-551`. They triple the weight of whatever those clusters say. *Cost:* S (beyond item 3). *Risk:* medium; it moves the same scenario tests. *Verify:* `crash-parts.test.ts` door/bumper tests, `shape-match.test.ts:310`, and the existing test `shape-match.test.ts:347` "every mass belongs to at least one overlapping cluster" after the dedupe.

5. **Whole-body orientation in `followGroup` via shape matching + Eq. 7.** *Area:* realism. *Change:* in `streamed-deform.ts:1123-1186`, replace the yaw/pitch/roll derivation (`:1128-1134`, which uses `engineL`, `engineR`, `axleR`) as follows:
   - build $\mathbf{A}_{pq} = \sum m(\mathbf{x}^{world} - \mathbf{c})(\mathbf{x}^{rest} - \mathbf{c}_0)^T$ over the non-hub masses, times the precomputed $\mathbf{A}_{qq}^{-1}$;
   - run `extractRotation` warm-started from a persistent body quaternion;
   - convert to YXZ Euler and keep the existing pitch/roll clamps and `plant` branch.

   *Expected effect `[INFERENCE]`:* a crushed nose (engines pushed back or sideways) no longer drags the body yaw. The paper's argument against few-point, order-dependent frames applies. *Cost:* M. *Risk:* medium–high; it changes the car pose under every crush, which `zip.test.ts` and `crash-parts.test.ts:75` "a left hit must not invert the banana" exercise. *Verify:* `npm run test:game` plus the browser bench in derby mode. Do this only after item 3 has settled.

6. **Fallback if item 3 is rejected: strip the dead and wrong parts of the current path.** *Area:* correctness.
   - Remove the unreachable `dot < 0` negation (`shape-match-core.js:205-208`) and the `t = 0.08` branch (`:209`) in `stabilizeMat` (min dot measured 0.457).
   - Replace the column-2 flip (`:131-136`) with a flip of the column of $\mathbf{R}$ that best matches the smallest-norm column of $\mathbf{R}^T\mathbf{A}$ [INFERENCE: an approximation of Irving's smallest-σ axis without an SVD].

   *Cost:* S. *Risk:* low. *Verify:* `shape-match.test.ts:68` plus new test (a) from item 3. This does **not** fix the planar snap. Prefer item 3.

## Not applicable / caveats

- **GPU / branch-free motivation does not transfer.** The kernel is scalar JS on the CPU. What carries over is robustness (no inverse, no reflection, no identity fallback) and built-in temporal coherence. The speed win is real per call (≈ 1.9× for `matchCluster`) but small per frame (item 1 estimate).
- **The paper's speedup baseline is Irving's SVD, not this repo's Higham iteration.** The 60–80 % figure is not a prediction for us; use the item 1 numbers.
- **"3 iterations" assumes one solve per step.** Here `matchCluster` runs 2–5 times per `stepShapeMatch`, each call already a warm iteration, so 2 per call (skin: 3 per frame) is the starting point. The scratch suite showed the scenario tests react non-monotonically to this count, so treat it as a tuning constant, not a convergence setting.
- **Linear convergence.** The rate is $\rho_k = s_k/(s_1+s_2+s_3)$ (derived and verified above), so heavily crushed or nearly inverted clusters converge slowly ($\rho \to 1$ as $s_2 \to |s_3|$). With warm starts that shows up as a few frames of lag in exactly the frames where a cluster inverts. This is acceptable for visuals `[INFERENCE]`, but the paper does not prevent it.
- **Energy-maximum safeguards (random perturbation) are not wanted.** A relative π rotation is a fixed point, and here it simply holds the previous orientation. That is benign, and it is what keeps `shape-match.test.ts:77` (180° yaw must not be applied) passing with Eq. 7. Adding randomness would break deterministic tests.
- **The `Quat(A)` cold start is not needed.** Clusters are created and `resetCluster`-ed at rest, so identity is the warm start. It would only matter for a stateless API.
- **The 0.85 rad clamp, plasticity and β blending are outside the paper.** With the clamp active (common in crashes, see "Measured on the real car rig"), $\mathbf{S} = \mathrm{sym}(\mathbf{R}_{clamped}^T\mathbf{A})$ still absorbs rotation beyond 0.85 rad as fake strain. That strain drives `applyPlasticity`'s yield test (`shape-match-core.js:348`). The swap does not change this; it only removes the wrong-axis twist on inverted clusters.
- **Co-rotational FEM (tetrahedra), the other application in the paper, does not exist here.**
- **Appendix D listing.** Do not port it literally. Its `1/|dot| + 1e-9` precedence turns $\mathbf{A} = 0$ into NaN (*measured*).
