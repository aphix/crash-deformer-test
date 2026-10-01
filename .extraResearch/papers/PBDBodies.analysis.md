# PBDBodies (Müller et al., SCA 2020) — analysis against crash-deformer-test

Paper: *Detailed Rigid Body Simulation with Extended Position Based Dynamics* (rewrite: `PBDBodies.md`).
Focus of this analysis: rigid-body XPBD with substepping, hinge joints with limits (doors/hood/trunk), contact with static/dynamic friction and restitution (car pairs, debris, loose parts), vehicle modeling, breakable joints for detachable parts.

## Summary

- **Rigid bodies inside XPBD.** Each body carries $(\mathbf{x}, \mathbf{q}, \mathbf{v}, \boldsymbol{\omega})$ plus mass and a diagonal rest-frame inertia. Per substep: explicit prediction (including the gyroscopic term), one non-linear Gauss-Seidel sweep over constraints that updates bodies immediately, then velocities derived from the pose change — $\boldsymbol{\omega} = 2\,\mathrm{vec}(\mathbf{q}\mathbf{q}_{prev}^{-1})/h$ with a sign fix (Algorithm 2).
- **Only two projection operations are needed.** (a) A positional correction between two body points, using generalized inverse masses $w = m^{-1} + (\mathbf{r}\times\mathbf{n})^T\mathbf{I}^{-1}(\mathbf{r}\times\mathbf{n})$, which moves and rotates both bodies. (b) A rotational correction with $w = \mathbf{n}^T\mathbf{I}^{-1}\mathbf{n}$. Every joint and contact is built from these two.
- **XPBD compliance** $\alpha$ (m/N), with $\tilde\alpha=\alpha/h^2$ and an accumulated $\lambda$. Stiffness does not depend on step size or iteration count; $\alpha=0$ is infinitely stiff; forces and torques can be read back as $\lambda\mathbf{n}/h^2$ (Eqs. 10, 17). That readback is what makes force-based joint breaking possible.
- **Joints:** fixed (Eqs. 18–19), hinge alignment $\mathbf{a}_1\times\mathbf{a}_2$ (Eq. 20), target angle and motor (Eq. 21, $\alpha\leftarrow\alpha+hv$), a generic `LimitAngle` for hinge, swing and twist limits (Algorithm 3, Eqs. 22–24), a distance-limited attachment (Eq. 25) and per-axis prismatic limits applied in a single projection.
- **Contacts:** pairs are gathered once per frame with AABBs grown by $k\,\Delta t\,v$ ($k=2$). The normal and penetration are recomputed at every substep. Normal correction uses $\alpha=0$. Static friction is a positional correction that cancels tangential slip of the contact points over the substep (Eqs. 27–28), applied only while $\lambda_t<\mu_s\lambda_n$.
- **Velocity pass after the position solve.** Dynamic friction is applied explicitly and capped by $|\mathbf{v}_t|$, so it is unconditionally stable (Eq. 30). Joint damping uses $\min(\mu h,1)$ (Eqs. 31–32). Restitution is computed from the *pre-solve* normal velocity, with $e=0$ below $2|\mathbf{g}|h$ to kill jitter (Eq. 34). This also discards PBD's "penetration-depth velocity", so overlapping spawns are not launched.
- **Substeps beat iterations.** For a fixed budget, use the maximum number of substeps with 1 iteration each: better accuracy, better energy conservation, less tunneling. The demos use 20–40 substeps at 60 Hz.
- **Vehicle demo:** an RC car (20 substeps, 18 ms/frame) with the whole steering linkage simulated (1:760 mass ratio between servo arm and wheel). The tires are per-element shape matching on 1100 hex elements coupled to rigid rims, because tetrahedral FEM could not reach the needed stiffness within budget.
- **Limitations:** substepping removes numerical damping, so physical damping must be added back. Small steps need doubles. Recomputing directions on every projection can destabilize tall stacks.

## Useful content

**Substep loop (Algorithm 2), adapted for a car body / parts.**
```
h = Δt / n
predict:  x_prev=x; v += h g; x += h v; q_prev=q; ω += h I⁻¹(τ − ω×(Iω)); q += ½h[ω,0]q; normalize
solve:    one NPGS sweep over joints + contacts (immediate body updates)
derive:   v=(x−x_prev)/h; Δq=q q_prev⁻¹; ω=2Δq.xyz/h; if Δq.w<0: ω=−ω
velocity: dynamic friction (30), restitution (34), joint damping (31–32)
```
- The derive step's angular-velocity formula is what this repo lacks in `followGroup` (it emits pitch/roll *angles × 0.4* as "angular velocity").

**Generalized inverse mass (Eqs. 2–3, 42).** For a contact at offset $\mathbf{r}$, use $w = m^{-1} + (\mathbf{r}\times\mathbf{n})^T\mathbf{I}^{-1}(\mathbf{r}\times\mathbf{n})$; the impulse for a desired $\Delta v$ is $p=\Delta v/(w_1+w_2)$, and $\Delta\boldsymbol{\omega}=\mathbf{I}^{-1}(\mathbf{r}\times\mathbf{p})$. For a flat car (yaw only), $w = 1/m + (r_x n_z - r_z n_x)^2 / I_{yy}$ with $I_{yy}\approx m(L^2+W^2)/12$. For an 858 kg lumped car (sum of `MASS_SPECS`) about 4.4 × 1.8 m, $I_{yy}\approx 1.6\times10^3\ \mathrm{kg\,m^2}$.

**XPBD update and force readback (Eqs. 4–5, 10, 13–14, 17).**
$\Delta\lambda=(-C-\tilde\alpha\lambda)/(\sum w+\tilde\alpha)$, with $\lambda$ reset to 0 at the start of each substep. The constraint force is $f=\lambda/h^2$ and the torque is $\tau=\lambda/h^2$. With a kinematic parent (the car body), set $w_{parent}=0$; only the part's $w$ remains. This is the regime for door, hood and trunk hinges.

**Hinge with limits (Eq. 20 + Algorithm 3).**
- Alignment: $\Delta\mathbf{q}=\mathbf{a}_1\times\mathbf{a}_2$.
- Limit: $\phi=\arcsin((\mathbf{b}_1\times\mathbf{b}_2)\cdot\mathbf{a}_1)$, unwrap to $(-\pi,\pi]$. If $\phi\notin[\alpha,\beta]$, rotate $\mathbf{b}_1$ by $\mathrm{clamp}(\phi)$ about $\mathbf{a}_1$ and apply $\Delta\mathbf{q}=\mathbf{b}_1'\times\mathbf{b}_2$.
- Car mapping: door $[\theta_{min},\,1.45]$ rad (the code's max door angle), hood/trunk $[\theta_{min},\,0.5]$ rad. A *plastic* lower bound $\theta_{min}$ that ratchets with crush is exactly what `hingeT` already models.
- Limits can be soft ($\alpha>0$), which makes a door "bounce" off its stop instead of stopping dead.

**Attachment with slack (Eq. 25)** $\Delta\mathbf{x}=\frac{\Delta\mathbf{r}}{|\Delta\mathbf{r}|}(|\Delta\mathbf{r}|-d_{max})$ applied only when $|\Delta\mathbf{r}|>d_{max}$. This gives a loose, sagging hinge before tear-off, or a bumper hanging on one mount. Per-axis limits give a bumper that slides along its mount rail (prismatic joint).

**Contact (Eqs. 26–30, 34) for debris, loose panels and mass spheres.**
- Penetration $d=(\mathbf{p}_1-\mathbf{p}_2)\cdot\mathbf{n}$, positional fix $d\mathbf{n}$, accumulate $\lambda_n$.
- Static friction: $\Delta\mathbf{p}_t$ = tangential slip of the contact points since `prev`; cancel it if $\lambda_t<\mu_s\lambda_n$.
- Dynamic friction: $\Delta\mathbf{v}=-\hat{\mathbf{v}}_t\min(h\mu_d|f_n|,|\mathbf{v}_t|)$. Against static ground, $|f_n|\approx mg$, which is exactly `applyGroundFriction`.
- Restitution: $\Delta\mathbf{v}=\mathbf{n}(-v_n+\min(-e\bar v_n,0))$; set $e=0$ when $|v_n|\le2|g|h$.
- All terms are expressed per unit time ($h$ appears explicitly), so the result does not depend on how many slices or frames the engine runs. That is the property the current debris and loose-part code lacks.

**Joint/velocity damping (Eqs. 31–32)** $\Delta\mathbf{v}=(\mathbf{v}_2-\mathbf{v}_1)\min(\mu h,1)$. This is a rate-independent replacement for per-call factors such as `*= 0.96`, and it damps *relative* motion. Substepping removes numerical damping, so physical damping like this is required.

**Broadphase once per frame** with AABBs grown by $k\,\Delta t\,v$, $k=2$. A narrow test per substep is enough.

**Substeps vs iterations.** At a fixed budget, $n$ substeps × 1 iteration beats 1 × $n$ for constraint error (Fig. 11) and energy (Fig. 9). Mass ratios up to 1:760 stay stable at 20 substeps. This repo's worst ratio is bumperRL 8 kg vs cell 260 kg ≈ 1:33.

**Parameters worth reusing.**
- Restitution jitter threshold: $2|g|h$.
- Friction coefficients: average $\mu=(\mu_1+\mu_2)/2$ across materials.
- Broadphase margin: $k=2$.
- Hard joints: $\alpha=0$ attachments.
- Compliance from stiffness: $\alpha=1/k$, e.g. the suspension's $k=11000$ N/m gives $\alpha\approx9.1\times10^{-5}$ m/N.

## Code anchors

All touchpoints were read in the current tree; line numbers are as of this analysis.

| Paper concept | Code touchpoint (file:line symbol) | Relationship | Notes |
|---|---|---|---|
| Substep loop, $h=\Delta t/n$ (Alg. 2) | `src/game/engine.ts:1014-1016` `tickInner` while-loop calling `physicsSlice` + `fixedStep`; `src/game/sat.ts:23` `physicsSlice`; `engine.ts:1195-1196` `fixedStep` `slices`; `src/game/streamed-deform.ts:1117` `stepStructure` slices | variant | Slices are adaptive: they cap displacement at 0.07 m per slice (min 1/240 s), up to 8 per frame within an 8 ms budget, then 1–3 inner slices, then up to 4 structure slices. This is substepping driven by anti-tunneling, not by "max substeps, 1 iteration". |
| numPosIters = 1 (substeps beat iterations) | `engine.ts:1231` relaxation loop `k < (satBusy && !wrecked ? 3 : 1)`; `src/game/pair-contact.ts:188` `stepCarPair` `iters`; `streamed-deform.ts:2008` `stepShapeMatch` `iters = contacting ? 2 : stiffnessIters(...)` | contradicts | The budget goes into up to 3 SAT passes and 2+ shape-match iterations per slice. The paper's result says spend it on slices instead. |
| Recompute contact normal before each projection (NPGS) | `engine.ts:1232-1235` (`syncPose(0)`/`refreshBasis` each pass) → `engine.ts:1258` `resolveCarPair` → `pair-contact.ts:61-62` `satCars` (`sat.ts:157`) | same | Each relaxation pass recomputes SAT normal and depth from the updated pose, so no contact plane is frozen. |
| Body state $(\mathbf{x},\mathbf{q},\mathbf{v},\boldsymbol\omega,\mathbf{I})$ | `src/game/car.ts:93-94` `DeformableCar.velocity`/`angular`, pose in `group`; `car.ts:82-83` `DetachPart.velocity`/`angular` | variant / missing | No inertia tensor anywhere. Once crashed, the car's rotation comes from the 20-mass lattice; loose parts spin freely with no inertia. |
| $\boldsymbol\omega=2\,\mathrm{vec}(\mathbf{q}\mathbf{q}_{prev}^{-1})/h$, sign fix (Alg. 2) | `streamed-deform.ts:1219-1228` `followGroup` `angularOut.set(pitch*0.4, yawRate, roll*0.4)` | contradicts | Only yaw is a true rate. x and z are *angles* scaled by 0.4. Downstream `car.ts:992` `shatterGlass` uses `angular.x` as if it were a rate. |
| Quaternion integration $\mathbf{q}\mathrel{+}=\tfrac h2[\boldsymbol\omega,0]\mathbf{q}$ | `car.ts:1003-1007` `stepLooseParts` (`setFromAxisAngle` + `premultiply`) | variant | Exact exponential map in world space, which is fine. The gyroscopic term $\boldsymbol\omega\times\mathbf{I}\boldsymbol\omega$ is missing because there is no $\mathbf{I}$. |
| Gen. inverse mass $w=m^{-1}+(\mathbf{r}\times\mathbf{n})^T\mathbf{I}^{-1}(\mathbf{r}\times\mathbf{n})$ (Eqs. 2–3, 42) | `pair-contact.ts:136-140` `invA + invB` (linear only); `pair-contact.ts:152-155` `angular.y += (r×n)·j·0.00008` | contradicts | The angular term is a hand constant, not $I^{-1}$ ($I_{yy}^{-1}\approx6\times10^{-4}$). `[INFERENCE]` It is effectively inert: once mass-active, `followGroup` overwrites `angular` at the next `syncPose(h)` (`pair-contact.ts:200`, `engine.ts:1303`). |
| Particle positional correction split by $w_i=1/m_i$ (Eqs. 6–7 with $\mathbf{r}=0$) | `streamed-deform.ts:2737-2751` `sphereHit` | same | Mass-sphere overlap is projected in proportion to inverse mass. The normal is flattened (`_n.y *= 0.18`, l.2733) and the overlap is scaled by crumple transfer. |
| Restitution from pre-solve normal velocity + jitter threshold (Eq. 34) | `streamed-deform.ts:2752-2758` `sphereHit` (`e` = 0.18 / 0.08 / 0, `absorb`) | variant | Uses the current velocity. Has no $2\lVert g\rVert h$ threshold and no friction. |
| Static friction via contact-point slip (Eqs. 27–28) | `sphereHit` (`streamed-deform.ts:2728`); `pair-contact.ts:144-150` | missing / variant | Mass spheres have no tangential response at all. Car-pair friction is velocity-level with a single `mu = 0.45` (l.147), clamped to `±mu*j`, where $j$ itself is capped at `18 + pass*36` N·s (l.139). |
| Dynamic friction $\Delta v=-\hat v_t\min(h\mu_d\lvert f_n\rvert,\lVert v_t\rVert)$ (Eq. 30) | `src/game/physics-util.ts:56-68` `applyGroundFriction` (`drop = Math.min(s, mu * 9.81 * dt)`) | same | Exactly Eq. 30 with $f_n=mg$. Used for masses at `streamed-deform.ts:2175,2183,2185` but **not** for debris or loose parts. |
| Ground restitution/friction for small bodies | `engine.ts:1737-1743` `bounceGround` (`vel.y *= -0.28`, `vel.x/z *= 0.86` per call); `car.ts:1011-1016` `stepLooseParts` (`*-0.28`, `*0.96`, `angular *0.9` per call) | contradicts | Per-call factors. Loose parts are stepped once per physics slice (`engine.ts:1313` → `car.ts:638`) and FX once per frame (`engine.ts:1039-1042` → `engine-fx.ts:87,218,319`), so slide distance depends on slice count and frame rate. With no restitution threshold, resting parts micro-bounce. |
| Relative contact velocity $(\mathbf v_1+\boldsymbol\omega_1\times\mathbf r_1)-(\mathbf v_2+\boldsymbol\omega_2\times\mathbf r_2)$ (Eq. 29) | `engine.ts:1786-1829` `bounceAgainstCar` (`vn = vel·n`, reflect by `1.55`) | contradicts | Ignores the car's own point velocity. A debris piece at rest hit by a moving car has `vn = 0`, so it is only pushed positionally (dragged), never flung. There is no tangential friction and no reaction on the car. |
| Hinge axis alignment (Eq. 20) + positional attachment ($d=0$) | `car.ts:790-856` `syncAttachedParts` (door `rotation.y = -sign*t*1.45` l.849; cowl `rotation.x = -t*0.5` l.840; tail `t*0.5` l.845) | missing | Hinges are scripted poses driven by the crush ratchet `hingeT` (l.814). They have no inertia and no response to car rotation or deceleration. They update once per *frame* from `updateDeform` (`car.ts:727`), not per slice. |
| Joint frames $\bar{\mathbf r}$, $[\bar{\mathbf a},\bar{\mathbf b},\bar{\mathbf c}]$ in rest space | Door pivot at the A-pillar `car.ts:163-164` (`doorL/R.position (±0.86, 0.54, 0.55)`, mesh offset `z = -0.28` l.166); hood pivot `car.ts:154` (0, 0.7, 0.74); trunk `car.ts:158` (0, 0.74, -0.72) | same (data exists) | Pivots and axes (door: local Y; hood/trunk: local X) are already authored in parent rest space, so they can serve as joint frames directly. |
| Joint limits `LimitAngle` (Alg. 3) | `car.ts:814` `p.hingeT = Math.max(p.hingeT, …)` ratchet + fixed max angles 1.45 / 0.5 rad | variant | `hingeT` is effectively a *plastic lower limit* and the scripted angles are the upper limit. No dynamics happen between the two. |
| Target angle / motor (Eq. 21) | `car.ts:807-813` `target` from sensor/part compression | variant | The target sets the pose directly (infinitely stiff, rate-limited by `dt*3.2`), not through a compliant constraint. |
| Force readback $f=\lambda/h^2$ → breakable joints (Eqs. 10, 17) | `car.ts:913-932` `evaluateBreakage` (`hingeT > 0.5/0.58/0.7/0.78`) | missing | Breaking is purely geometric or crush-based. No load-based tear-off exists (e.g. a door ripped off by inertia in a spin). |
| Detach preserves momentum of the attached body | `car.ts:952-980` `detachPart` (`velocity = car.velocity + radial kick 2.2+min(5, 0.06·impulse)`, `+2.1 + 1.2·hingeT` up, random `angular` ±3, hinge-specific spin) | contradicts | Not $\mathbf v+\boldsymbol\omega\times\mathbf r$ at the attachment, and the angular velocity is random. A dynamic hinge would hand over its real state. |
| Contact at body points with torque (Eqs. 26, 33) | `car.ts:998-1019` `stepLooseParts` (center point clamped to `y >= 0.12`; `bounce?.(…, Math.min(0.22, p.radius*0.45))`) | missing | Panels are spheres at their pivot. They never tip over an edge, never rest at their real thickness, and get no contact torque. |
| Distance limit $d_{max}$ projection (Eq. 25), $\alpha=0$ | `streamed-deform.ts:1941-1950` `stepBeams` max-stretch clamp | same | PBD-style projection weighted by inverse mass. |
| Compliant spring ($\alpha=1/k$) | `streamed-deform.ts:1955-1972` `stepBeams` force springs; `streamed-deform.ts:2229-2239` `stepSuspension` (`k = 11000`, `c = 260`) | variant | Explicit symplectic-Euler springs. Current parameters are inside the explicit stability limit at ≤1/240 s (hub–mount reduced mass ≈20 kg → $\omega\approx23$ rad/s). |
| Breakable constraint | `streamed-deform.ts:1931-1933` beam `alive = false` when `len > rest*2.2` | variant | Breaks on strain; the paper's readback would let it break on force. |
| Physical damping instead of numerical (Conclusion; Eqs. 31–32) | `streamed-deform.ts:2157` `m.vel.multiplyScalar(Math.pow(rate, dt))`; `car.ts:1009` `Math.pow(0.72, dt)` | variant | Rate-independent, but damps absolute velocity rather than relative velocity across a joint. |
| Broadphase once per frame with $k\,\Delta t\,v$ margin | `pair-contact.ts:58-59` (`dist > 5.2`); `engine.ts:1218-1220` (`d² > 28`); `sat.ts:168` (`d² > 36`) | variant | Fixed radii, re-tested every slice. Cheap enough for 24 cars. |
| Velocity pass replaces PBD-derived velocity after position push (§3.6) | `pair-contact.ts:32-45` `pushCar` (moves pose, leaves velocity) + `pair-contact.ts:134-142` impulse from `cancelClosing` (`physics-core.js:83`); comment `pair-contact.ts:118-120` | same (philosophy) | Penetration pushes do not create separating velocity. The closing velocity is removed by a separate impulse with tiny restitution (`physics-core.js:88` clamps `e ≤ 0.08`). |
| Rigid bodies as shape-matched particles (Intro: slow impulse propagation) | `streamed-deform.ts:1985-2096` `stepShapeMatch`; `streamed-deform.ts:718-725` `writeShapeToMasses` copies `p.vx` unchanged | variant | Goal projections move positions but never update velocities (no $v=(x-x_{prev})/h$). Impulse propagation is hand-routed through `applyImpulse` (l.841) and `kickCore` (l.1260), as the paper predicts for particle rigid bodies. |
| Unconditional stability by compliance | `streamed-deform.ts:2057` `kStep` 0.14 m clamp; `physics-util.ts:47` `clampSpeed`; `physics-core.js:93` `satPushCap` | contradicts (mechanism) | Stability comes from clamps, not from implicit compliance. |
| Double precision for small steps | `shape-match-core.js:6` `Float64Array`; `streamed-deform.ts:382-385` `goalX..goalW` `Float64Array` | same | JS numbers and the sim arrays are already doubles. Only render buffers are `Float32Array`. |
| Vehicle: wheels, steering linkage, soft tires | `src/game/car-drive.ts:34` `applyDrive` (kinematic bicycle, sets `velocity`/`angular.y`); `car.ts:735` `nudgeWheels` (visual); hubs as masses `streamed-deform.ts:173-176` | missing | No wheel bodies, tire contact or steering joints. Popped hubs (`hubPopped`, l.923) keep the wheel visible at the hub mass. |
| Mass ratios | `streamed-deform.ts:156-176` `MASS_SPECS` (bumper 8–9 kg … cell 260 kg) | n/a | ≈1:33, well inside what the paper shows stable. |

## Candidates to implement

Ordered by value/cost. "Verify" names the concrete check. New tests follow the repo's `good:` / `bad:` / `close-but-wrong:` naming and run under `npm run test:game`.

1. **Fix the sign of the rotational point velocity $\boldsymbol\omega\times\mathbf r$ (Eqs. 29/37)**
   - **Area:** correctness.
   - **Problem:** `car.angular.y` is $d(\text{rotation.y})/dt$ (`car.ts:696` `this.yaw += this.angular.y * dt`, `car-drive.ts:70-75`, `followGroup` yawRate `streamed-deform.ts:1220-1226`). For that convention, $\boldsymbol\omega\times\mathbf r = (\omega_y r_z,\,0,\,-\omega_y r_x)$. Three sites use the opposite sign:
     - `streamed-deform.ts:741-742` `bindKinematic` (`m.vel.x += -worldOmega.y * rz; m.vel.z += worldOmega.y * rx`);
     - `car.ts:991,993` `shatterGlass`;
     - `pair-contact.ts:153,155` torque `(r.x*n.z - r.z*n.x)`. Correct is $(\mathbf r\times\mathbf n)_y = r_z n_x - r_x n_z$; note that the barrier path `engine.ts:1388` already has the right sign through its extra `-0.04`.
   - **Evidence:** a throwaway three.js finite-difference check gave a point velocity of $(+4,\,0)$ for $\omega_y=2$, $\mathbf r=(0,0,2)$, while the `bindKinematic` formula gives $(-4,\,0)$.
   - **Change:** flip the signs in `bindKinematic` and `shatterGlass`. In `resolveCarPair` either flip the sign and use $I_{yy}^{-1}$ ($I_{yy}=m\,((2\cdot\texttt{CAR\_HALF.z})^2+(2\cdot\texttt{CAR\_HALF.x})^2)/12$, `car-mesh.ts:30`) instead of `0.00008`, or delete lines 152-155. Per the anchor table they are overwritten by `followGroup` for mass-active cars.
   - **Expected effect:** a turning car that arms its masses (`beginCrush`/`armMasses`/`pushCar` → `bindKinematic`) currently gets bumper-mass velocities mirrored by up to $2\,\omega r\approx 6$–$11$ m/s (ω ≈ 1.5–2.8 rad/s from `DRIVE.turn`/`ebrakeTurn`, r ≈ 2 m). That injects a spurious counter-yaw and shear into the lattice at first contact. After the fix, derby hits during turns keep their spin direction and glass bursts leave with the right tangential velocity.
   - **Cost:** S. **Risk:** tuned constants may have compensated for the wrong sign. Watch the derby feel.
   - **Verify:** new test in `src/game/crash-parts.test.ts` group "CoG / followGroup": "good: arming masses on a car yawing at +2 rad/s keeps a positive yaw rate". Set `car.angular.set(0,2,0)`, call `car.deform.armMasses(...)`, `car.deform.stepStructure(DT)`, `car.syncPose(DT)`, then assert `car.angular.y > 1`. Run `npm run test:game` (derby/fleet/zip suites).

2. **Rate-independent ground friction/restitution for loose parts and FX (Eq. 30 + Eq. 34 threshold)**
   - **Area:** correctness.
   - **Change in `car.ts:1011-1016` `stepLooseParts`:**
     - replace `p.velocity.x/z *= 0.96` with `applyGroundFriction(p.velocity, dt, CRASH.muScuff, true)` (import from `physics-util.ts`);
     - replace `p.velocity.y *= -0.28` with `p.velocity.y = p.velocity.y < -2 * 9.6 * dt ? -0.28 * p.velocity.y : 0`;
     - replace `p.angular.multiplyScalar(0.9)` with the Eq. 32 form `multiplyScalar(Math.max(0, 1 - 6 * dt))` (≈0.9 at 60 Hz).
   - **Change for FX:** add `dt` to `WorldBounce` (`car.ts:37`) and thread it through `engine.ts:1737` `bounceGround` and `engine.ts:1746` `bounceWorld`. Callers already have `dt`: `engine-fx.ts:87,218,319` (`update(dt, …)`) and `stepLooseParts`. In `bounceGround` use `applyGroundFriction(vel, dt, μ, true)` instead of `vel.x/z *= 0.86`, together with the same restitution threshold.
   - **Expected effect:** panel and debris slide distance stops depending on `physicsSlice` count (which varies with fleet speed, `sat.ts:23`) and on display refresh rate. Resting parts stop micro-bouncing.
   - **Cost:** S. **Risk:** Coulomb sliding lasts longer than the current exponential bleed, so μ needs tuning (≈0.8 for FX chips, `CRASH.muScuff` 0.4 for panels).
   - **Verify:** new test in `crash-parts.test.ts`: "close-but-wrong: a detached hood slides the same distance at dt=1/60 and dt=1/240". Detach via the runtime-accessible private `detachPart` (strip-types does not enforce `private`), copy the state, step `car.integrate(dt)` for 2 s at each dt, and assert the XZ distance agrees within 5% (same style as `crash-physics.test.ts:667` "dt-scaled, not per-call"). Visually check debris in the browser at 60 vs 144 Hz.

3. **Bounce debris and loose parts off cars using the relative contact velocity (Eq. 29) + friction (Eq. 30) + jitter threshold (Eq. 34)**
   - **Area:** visual quality / correctness.
   - **Change in `engine.ts:1786-1829` `bounceAgainstCar`:** after the hull push-out, compute the car's point velocity at the contact. Use $\mathbf v_c = \texttt{car.velocity} + \omega_y\hat{\mathbf y}\times\mathbf r$ (with the sign fixed per #1, yaw only; x/z rates are not trustworthy until #5).
     - Normal: $v_n = (\mathbf v-\mathbf v_c)\cdot\mathbf n$. If $v_n<0$, apply $\mathbf v \mathrel{-}= (1+e)\,v_n\mathbf n$ with $e=0$ when $\lvert v_n\rvert\le 2gh$.
     - Tangential: reduce the relative tangential velocity by $\min(\mu(1+e)\lvert v_n\rvert, \lVert\mathbf v_t\rVert)$, which is the impulse form of Eq. 30.
     - Keep the car one-way ($w_{car}\approx0$; debris mass ≪ 858 kg).
     - Put the per-hull math in an exported pure function in `physics-util.ts` (e.g. `bounceOffMovingBox`) so it can be tested.
   - **Expected effect:** debris and panels struck by a moving car are flung at ≈$(1+e)\,v_{car}$ instead of being bulldozed (today `vn = vel·n = 0` for resting debris, so it is only dragged). Pieces lying on a sliding wreck ride along through friction.
   - **Cost:** S. **Risk:** more energetic debris. Cap $e$ at ~0.3 (today's 1.55 factor means $e=0.55$).
   - **Verify:** new test in `src/game/physics-util.test.ts`: "good: a resting sphere hit by a hull moving at 10 m/s leaves at ≈(1+e)·10 m/s along n"; also "bad: a sphere resting on a moving hull top is not reflected". Check the derby visually in the browser.

4. **Coulomb friction in mass-level car–car contact `sphereHit` (Eqs. 27–30, impulse/positional form)**
   - **Area:** realism.
   - **Change in `streamed-deform.ts:2728` `sphereHit`:**
     - Dynamic friction: after the normal impulse `j` (l.2756), compute the relative tangential velocity $\mathbf v_t = (\mathbf v_b-\mathbf v_a) - \text{rel}\,\mathbf n$ and $j_t=\min(\mu_d\,j,\ \lVert\mathbf v_t\rVert/\text{inv})$. Apply $\pm j_t\hat{\mathbf v}_t$ weighted by `ima`/`imb`, with $\mu_d$ = `CRASH.muScuff`.
     - Static friction, for sustained crush contact where `rel ≈ 0`: cancel the tangential slip over the slice $\Delta\mathbf p_t\approx\mathbf v_t h$ positionally, only while $\lVert\Delta\mathbf p_t\rVert<\mu_s\cdot\text{overlap}$. This is Eq. 28 with $\lambda_t<\mu_s\lambda_n$, since both λ's share $1/(w_a+w_b)$ for particles.
     - Pass `dt` into `sphereHit` from `collideWith` (`streamed-deform.ts:1085`).
   - **Expected effect:** side-swipes and T-bones transfer tangential momentum. The struck car is dragged and spun, and glancing hits stop ice-skating past each other (today the only tangential coupling is the SAT-level `mu = 0.45`, capped at `jMax = 18 + pass*36` N·s, `pair-contact.ts:139-148`).
   - **Cost:** S. **Risk:** interlocked crumple masses can "hook" and over-spin; `clampSpeed` bounds the worst case. Tune μ.
   - **Verify:** new test in `src/game/crash-physics.test.ts`: "good: a 30° side-swipe gives the struck car tangential velocity along the striker's travel", via `stepCarPair`, comparing μ=0 vs μ=0.4. Plus `fleet.test.ts`, `derby.test.ts` and `zip.test.ts` unchanged-green. Physics ms in `scripts/bench-browser.mjs` at 24 cars should not move (a few flops per touching pair).

5. **Derive car angular velocity from the pose quaternion (Algorithm 2, derive loop)**
   - **Area:** correctness.
   - **Change in `streamed-deform.ts:1219-1228` `followGroup`:**
     - keep a `prevQuat` field (initialize it where `prevYaw` is set: `beginCrush` l.769, `armMasses` l.795);
     - inside the existing `dt > 1e-5` guard compute $\Delta\mathbf q = \mathbf q\,\mathbf q_{prev}^{-1}$ and $\boldsymbol\omega = 2\,\Delta\mathbf q_{xyz}/dt$, negated if $\Delta q_w<0$;
     - clamp each component to ±6 rad/s (as yaw is today) and write it to `angularOut`, replacing `pitch*0.4`/`roll*0.4`.
   - **Readers to check:** `car.ts:992` `shatterGlass` (`Math.abs(angular.x)*2` becomes a real pitch rate) and `car.ts:697-698` (only on the `!massActive && crashed` path, which is practically unreachable because `applyImpact` → `beginCrush` sets `massActive`).
   - **Expected effect:** `car.angular` becomes a true 3D rate. Point velocities ($\mathbf v+\boldsymbol\omega\times\mathbf r$) used by glass bursts, #3, #7 and #8 become consistent with the rendered pose.
   - **Cost:** S. **Risk:** branch switches in `followGroup` (the `plant` snap to zero pitch/roll) produce one-slice rate spikes. The clamp bounds them.
   - **Verify:** new test in `crash-parts.test.ts` "CoG / followGroup": "close-but-wrong: angular is a rate — calling syncPose(DT) twice without stepping masses yields |angular| < 1e-6". The old code returns `0.4·pitch ≠ 0` after a nose-dive.

6. **`RigidPart`: a minimal XPBD rigid body for loose panels with corner contacts, friction and restitution (§3.2, §3.5, §3.6)**
   - **Area:** visual quality / realism.
   - **New module** `src/game/rigid-part.ts` exporting:
     - a `RigidPart` type: `x`, `q`, `v`, `ω`, `xPrev`, `qPrev`, `invMass`, `invInertia` (diagonal, rest frame), `halfExtents`, `comOffset`;
     - `integrateRigid(b, h, g)`: Algorithm 2 predict, including $\boldsymbol\omega\times\mathbf I\boldsymbol\omega$;
     - `deriveRigid(b, h)`;
     - `solveGroundCorners(b, h, μs)`: for each of the 8 box corners below $y=0$, positional $d\mathbf n$ correction with Eq. 2 $w$ (gives torque, so tipping) and static friction from corner slip versus `prev` (Eqs. 26–28);
     - `velocityPassGround(b, h, μd, e)`: Eqs. 29, 30, 34 with the $2gh$ threshold, applied through Eq. 33.
   - **Wiring:** in `car.ts:320` `registerParts`, compute each part's local box (`THREE.Box3` of the object's geometry in part space) and mass (door 22 kg as `MASS_SPECS` doorL; hood ≈16, trunk ≈14, bumper ≈9, mirror ≈1). Then `car.ts:998` `stepLooseParts` calls the four functions per slice instead of the center-point clamp at `y = 0.12`.
   - **Expected effect:** a hood lands, tips over an edge, slides with Coulomb friction and comes to rest flat at its real thickness. Doors fall over instead of hovering on a 0.12 m sphere.
   - **Cost:** M (≈200 lines). **Perf:** ≤8 parts × 8 corners per car per slice, negligible next to ≈10 ms sim. **Risk:** contact against car hulls is still the sphere path (`bounceAgainstCar`) unless extended per corner.
   - **Verify:** new tests in `crash-parts.test.ts`: "good: a dropped hood settles with its lowest corner in [0, 0.01] m and up-axis |dot| > 0.95 within 3 s", and "close-but-wrong: slide distance matches within 10% at dt 1/60 vs 1/240". Keep "bad: detached parts are in world space" (l.208) green.

7. **Dynamic hinges for doors, hood and trunk after the latch fails (Eqs. 2–9, 20/25, Algorithm 3), with crush as a plastic lower limit**
   - **Area:** realism.
   - **Change in `car.ts:790` `syncAttachedParts`:**
     - Keep the scripted pose while latched.
     - When `hingeT` exceeds a latch threshold (e.g. door 0.2, cowl/tail 0.25), flip the part to a `RigidPart` (from #6) initialized from its current world pose. Its velocity is the car's point velocity at the COM (needs #1 and #5).
     - Every physics slice, in a new `stepHinged(dt)` called from `afterContacts` (`car.ts:635`) and `integrate` (`car.ts:677`) next to `stepLooseParts`, solve against the *kinematic* car body ($w_{parent}=0$):
       - two $\alpha=0$ point attachments at the ends of the hinge line, which replaces Eq. 20 and stays exact for a kinematic parent. Pivots from `car.ts:154,158,163-164`: door axis = car-local Y through (±0.86, 0.54, 0.55), ±0.25 m; hood/trunk axis = car-local X through (0, 0.7, 0.74) / (0, 0.74, −0.72), ±0.6 m;
       - `LimitAngle` with $[\mathbf n,\mathbf n_1,\mathbf n_2]$ = [hinge axis, parent reference axis, part axis] and interval $[\texttt{hingeT}\cdot\theta_{max},\ \theta_{max}]$, with $\theta_{max}$ = 1.45 rad for doors and 0.5 rad for hood/trunk (the current scripted maxima).
     - Leave the `two-point` bumpers and mirrors as they are (bumpers follow masses; mirrors are door children).
   - **Expected effect:** doors fly open and slam in spins and side impacts on the opposite side (lateral acceleration acts on the COM 0.28 m behind the hinge), hoods bounce on their cowl hinge, and parts visibly hang before they tear off. The crush ratchet still forces them open as today.
   - **Cost:** M. **Risk:** keep the swinging part parented to `car.group` and write its local pose as $\texttt{group}^{-1}\cdot$ world pose each slice. Door glass and mirrors are door children (`followGlass` skips door panes, `car.ts:878-879`), so they follow automatically. `skinPanel` (`car.ts:716-720`) deforms hood/trunk geometry every frame independently of the object transform. The `_box` floor clamp for doors (`car.ts:852-853`) must move into the ground-contact step. Existing door tests assert `hingeT` values, which stay valid.
   - **Verify:** `crash-parts.test.ts` "doors hinge then detach" (l.161-206) stays green. New test: "good: an unlatched door stays within [θmin, 1.45] rad and its hinge points within 1 mm of the body while the car yaws at 4 rad/s". Inspect visually in the browser (debug rig `createHelper`).

8. **Load-based tear-off and momentum-consistent detach (Eqs. 10, 17)**
   - **Area:** realism / correctness.
   - **Change:** in #7's `stepHinged`, keep the per-slice multipliers. For sustained loads use force $\lvert\lambda\rvert/h^2$ (hinge points). For limit slams use impulse $\lvert\lambda\rvert/h$, which is step-size independent for impacts, whereas $\lambda/h^2$ scales with $1/h$. Detach when either exceeds a per-part threshold.
   - Keep the crush thresholds in `evaluateBreakage` (`car.ts:924-929`) as a second path.
   - In `car.ts:952-980` `detachPart`, hand over the `RigidPart` state (its own $\mathbf v,\boldsymbol\omega$) instead of `car.velocity` + radial kick + `Math.random()` spin, which would remain only for parts that were never dynamic.
   - **Expected effect:** doors are ripped off by inertia in rollovers and spins and hoods by a hard slam, and the tumble direction matches the visible motion just before release.
   - **Cost:** S (after #7). **Risk:** thresholds need tuning per part. Start from a door slam at ~3 rad/s into the stop as the "just breaks" case: $I\approx m L^2/3 = 22\cdot0.58^2/3\approx2.5\ \mathrm{kg\,m^2}$.
   - **Verify:** new tests in `crash-parts.test.ts`: "bad: a slow 1 rad/s swing into the stop does not detach" and "good: a 6 rad/s slam detaches and the part keeps ≥80% of its pre-release angular momentum about the hinge". Keep "front bumper folds then can detach" green.

9. **Spend the contact budget on slices, not SAT relaxation iterations (§1, Figs. 9/11)**
   - **Area:** stability / performance (experiment).
   - **Change in `engine.ts:1160` `fixedStep`:**
     - move the `satBusy`/`wrecked` scan (l.1225-1230) above the `slices` choice (l.1195);
     - when busy, triple `slices` and set the relaxation loop at l.1231 to a single pass;
     - mirror this in `pair-contact.ts:188` `stepCarPair`, the test harness.
   - Feed already happens on pass `k === 0`, so each slice feeds once, and `feedOverlap` is dt-scaled (`crash-physics.test.ts:667`).
   - **Expected effect (paper):** lower residual penetration and less "zip" at equal SAT passes, smoother contact and better impulse propagation. **Cost:** S to try, but `stepStructure` and `collideWith` then run up to 3× during contact.
   - **Risk:** M. Physics ms may grow (currently ≈10 ms at 24 cars), and many constants were tuned per slice.
   - **Verify:** `zip.test.ts`, `barrier.test.ts`, `fleet.test.ts` and `derby.test.ts` green. `node scripts/bench-browser.mjs` before/after: accept only if `phys` grows ≤2 ms/frame at 24 cars and max penetration drops.

## Not applicable / caveats

- **Do not turn the car body into one XPBD rigid body.** The crash deformation *is* the product here. The 20 control particles plus overlapping shape-match clusters already give distributed contact, and yaw emerges from asymmetric mass impulses, so the generalized inverse mass of Eqs. 2–3 is implicit in the particle system. The paper's rigid machinery fits the *discrete* parts (loose panels, hinged doors/hood/trunk, popped wheels), not the body shell.
- **The full vehicle model is out of scope.** The RC car (servo → steering linkage → rims, 1:760 mass ratio, tires as 1100 shape-matched hex elements, 18 ms/frame for *one* car at 20 substeps) costs more than this app's whole 24-car sim (≈10 ms). Driving is a kinematic bicycle (`car-drive.ts:34` `applyDrive`), and hubs are point masses with a vertical spring (`streamed-deform.ts:2222` `stepSuspension`). A popped wheel could become a `RigidPart` (candidate 6) that rolls via static friction; that is the only wheel-level idea that fits.
- **20–40 substeps × 1 iteration for the deform lattice is not affordable as-is.** `stepShapeMatch` runs a polar decomposition per cluster per iteration (`shape-match-core.js:311` `matchCluster` → `m3Polar`), and `stepStructure` already runs up to 4 slices of ≈1/240 s. Candidate 9 is the budget-neutral version; anything more needs `npm run bench` plus browser-bench evidence first.
- **No XPBD conversion is needed for the suspension or the lattice beams.** The explicit springs are far inside their stability limit. Hub (26 kg) to engine (88 kg) has reduced mass ≈20 kg, so $k=11000$ gives $\omega\approx23$ rad/s against $h_{crit}=2/\omega\approx0.085$ s; the stiffest beam (`yieldK` 4200 on 9/18 kg masses) gives $\omega\approx26$ rad/s. At $h\le1/240$ s explicit integration stays stable up to $k$ in the MN/m range. Compliance would only matter for much stiffer joints, which the game does not need.
- **Do not derive lattice velocities from positions ($\mathbf v=(\mathbf x-\mathbf x_{prev})/h$).** `stepShapeMatch` moves positions without touching velocities (`writeShapeToMasses` copies the unchanged `p.vx`, `streamed-deform.ts:718-725`). That conflicts with Algorithm 2, but it is consistent with the paper's own §3.6 argument that post-collision derived velocities only encode penetration depth. Deriving velocities from plastic/crush projections would turn crumple into kinetic energy and launch wrecks (cf. the comment at `pair-contact.ts:118-120`). Keep the separate velocity-level impulses (`cancelClosing`, `applyImpulse`, `kickCore`).
- **Energy conservation is not a goal.** The paper prizes substepping for preserving energy (Fig. 9). A crash sim wants controlled dissipation: crumple absorbs energy, restitution stays ≈0 (`physics-core.js:88` caps `e ≤ 0.08`), and post-impact damping ramps up (`streamed-deform.ts:2151-2157`). Use the paper for *rate independence and stability*, not for energy behavior.
- **Car–car contact is 2D.** SAT runs on XZ OBB hulls (`sat.ts:125` `satTwoHulls`), with `y` zeroed in `resolveCarPair` (`pair-contact.ts:66-71`). The paper's 3D contact geometry, rounded/curved colliders and pitch/roll contact torque do not map to it. Only the yaw component of Eq. 33 is meaningful at the pair level.
- **Broadphase.** An AABB tree with $k\,\Delta t\,v$ margins is unnecessary for ≤24 cars (276 pairs, already culled by distance at `engine.ts:1218-1220` and `pair-contact.ts:58-59`).
- **Joint types not needed:** ball-in-socket swing/twist limits (Eqs. 22–24), velocity motors, inverse kinematics and twisted ropes have no consumer here. A prismatic or per-axis-limited attachment (§3.4.2) could model a bumper sliding on one mount before tearing, but `two-point` bumpers follow lattice masses (`car.ts:821-828`), which already reads well.
- **The static-friction test as printed is ambiguous.** "$\lambda_t<\mu_s\lambda_n$" compares the accumulated multipliers. Common implementations compute the candidate $\Delta\lambda_t$ first and test $\lvert\lambda_t+\Delta\lambda_t\rvert<\mu_s\lambda_n$ `[INFERENCE]`. For particle contacts (candidate 4) this reduces to $\lVert\Delta\mathbf p_t\rVert<\mu_s d$.
- **Force vs impulse thresholds for breaking.** $\lambda/h^2$ is a force only for sustained loads. For impacts it scales with $1/h$, and this repo's slice size varies with speed (`sat.ts:23`). Break-on-impact criteria must use $\lambda/h$ (impulse), as noted in candidate 8.
- **Stacking instability from per-projection normals** (paper's stated limitation) is not a concern. Wrecks are not stacked, and loose parts get ground and car contacts only (no part–part contact is proposed).
- **Double precision** is already satisfied: JS numbers and the sim arrays are `Float64Array` (`shape-match-core.js:6`, `streamed-deform.ts:382-385`).
- **Gravity inconsistency.** Integration uses 9.6 m/s² (`car.ts:685,1001`, `streamed-deform.ts:2146`), while `applyGroundFriction` uses 9.81 for $f_n=mg$ (`physics-util.ts:64`). Eq. 30 wants the actual normal force, so when adopting it for parts (candidate 2) use the same constant as the integrator.
