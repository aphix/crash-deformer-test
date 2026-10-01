# Detailed Rigid Body Simulation with Extended Position Based Dynamics

**Authors:** Matthias Müller¹, Miles Macklin¹˒², Nuttapong Chentanez¹, Stefan Jeschke¹, Tae-Yong Kim¹
¹NVIDIA, ²University of Copenhagen

**Venue:** ACM SIGGRAPH / Eurographics Symposium on Computer Animation (SCA) 2020, *Computer Graphics Forum* Vol. 39 (2020), No. 8. Guest editors: J. Bender and T. Popa.

> Figure 1: Two showcase scenes: a rolling-ball sculpture with fast marbles colliding against curved geometry, and a remote-controlled car with deformable tires driving over obstacles.

*Note on this rewrite:* prose is paraphrased and condensed section by section; equations, algorithms, parameter values, the table and figure captions are kept in full meaning. Reconstructions of extraction-damaged math are marked `[reconstructed]`.

## Abstract

The paper presents a rigid body simulator that resolves fine temporal and spatial detail using a *quasi-explicit* integration scheme that is nonetheless unconditionally stable. Conventional rigid body solvers linearize their constraints, either because they work at the velocity level or because they solve the equations of motion implicitly; in both cases the constraint directions are frozen across several iterations. The proposed method instead always uses the most recent constraint directions. This makes it possible to follow high-speed objects colliding with curved geometry, to need fewer constraints, to be more robust, and to keep the solver formulation simple. The paper gives every detail needed to build a complete rigid body engine with contacts, several joint types and coupling to soft bodies.

**CCS concepts:** Computing methodologies → Simulation by animation; Interactive simulation.
**Keywords:** rigid body simulation, soft body simulation, position based dynamics.

## 1. Introduction

Rigid body simulation is central to game engines and important for film effects. Its two core problems are contact handling and joint handling. For collisions there are two main families:

- **Penalty methods** separate bodies with forces derived from penetration. They need large forces and small steps to make bodies look rigid, so games and films rarely use them, although they have regained interest in differentiable simulation because their trajectories are smooth.
- **Impulse-based methods** are the dominant approach. Mirtich and Canny [MC95] founded impulse-based rigid body simulation in graphics and games in the mid-1990s; Hecker [Hec97] brought it to game developers and Baraff [Bar97] to the graphics community. Velocities are changed instantly at impacts by impulses, skipping the acceleration layer.

> Figure 2: Non-linear Gauss-Seidel. Points $\mathbf{p}_1$ and $\mathbf{p}_2$ are fixed to the ground; the top point $\mathbf{p}_3$ must stay at distance $l_1$ from $\mathbf{p}_1$ and $l_2$ from $\mathbf{p}_2$, which is a non-linear positional problem. Solving at the velocity level or with a global linear solve fixes the constraint gradients, so the solver converges to a wrong point (red, above the true solution) regardless of the iteration count; reaching the true solution would require repeated linear solves. Non-linear Gauss-Seidel updates the gradients after every single constraint projection and converges to the true solution without overshooting.

Moving bodies that both translate and rotate makes the problem non-linear. Freezing the spatial configuration and solving for velocities yields a linear system; with contacts (inequalities) this becomes a linear complementarity problem (LCP), which is still linear. Velocity space is the tangent space of the non-linear configuration space at the current state, which is why it is convenient — but a velocity solver cannot see positional error, so it drifts. Engines patch drift with extra forces or constraints.

**Position based dynamics** (PBD) [MHR06, Sta09] avoids drift by operating on positions directly and deriving velocities afterwards from the change in configuration over the step. PBD was long used mainly for constrained particle systems (cloth, soft bodies) until Macklin et al. [MM13] added fluids, leading to a unified particle solver [MMCK14]. That solver represented rigid bodies with shape matching [MHTG05] over rigidly connected particles, but cost grows with particle count, impulse propagation is slow and joints are awkward. It is more effective to extend PBD to true rigid bodies with rotational state, which Deul et al. [DCB14] formulated.

Both velocity-level solvers and global solvers that linearize the positional problem freeze constraint directions for the duration of the linear solve, i.e. across several iterations [MEM*19, ST96, KSJP08]. Contacts must then be treated as local planes and Coulomb cones approximated by polyhedra, and a 3D attachment becomes three scalar constraint rows. Local solvers such as Gauss-Seidel let the contact geometry change between iterations, which has been used for smooth isotropic friction [Erl17, DBDB11]; this paper additionally lets the *contact normal* change every iteration.

Original PBD solves the non-linear positional equations with **non-linear projected Gauss-Seidel (NPGS)**. This is fundamentally different from running ordinary or projected Gauss-Seidel (PGS) on linearized equations (Figure 2): after each individual constraint projection the positions are updated immediately, so PBD works on the non-linear problem itself, gaining robustness and accuracy. Round friction cones and collisions with curved objects become easy. Rather than storing a contact as an object pair plus a fixed normal (a contact plane), only the pair is stored and the normal is recomputed before each individual solve. A cheaper alternative is to store local contact geometry as usual but with a higher-order approximation.

The goal is a full rigid body engine in the PBD framework that stays simple, with algorithms described at a level that can be implemented directly. PBD has been criticized for: not using physical quantities and units; iteration- and step-dependent stiffness; inaccurate integration; dependence on constraint ordering; dependence on mesh tessellation; and slow convergence. All of these have since been addressed:

- The first three were solved by **Extended PBD (XPBD)** [MMC16]: a small extension that makes stiffness independent of iteration count and step size, uses physical units, and allows measuring forces and torques. XPBD closely approximates implicit Euler. It works with *compliance* (inverse stiffness), so infinitely stiff constraints are handled robustly by setting compliance to zero, where XPBD reduces to PBD.
- Gauss-Seidel order dependence can be useful (e.g. to steer error propagation) and can be removed with Jacobi or symmetric successive over-relaxation (SSOR) iterations.
- Tessellation dependence is removed by continuum-mechanics (FEM) constraints [MMC16].
- Slow convergence was addressed by [MSL*19]: replacing solver iterations with substeps makes Gauss-Seidel and Jacobi competitive with global solvers. Substepping with a single NPGS iteration per substep looks computationally almost like an explicit step but is unconditionally stable thanks to compliance — hence *quasi-explicit*.

The substepping result is counter-intuitive. It is not simply a smaller time step; what matters is the per-frame *simulation time budget*, i.e. substeps × iterations per substep, which is usually fixed in real-time applications. One extreme spends the budget on one substep solved very accurately; the other uses as many substeps as possible with one approximate iteration each. The best accuracy comes from the second extreme: maximum substeps, one iteration each. It also reveals high-frequency temporal detail lost with large steps, conserves energy much better, and lowers the chance of tunneling. Because one iteration is optimal, the substep count follows directly from the budget; because XPBD uses physical quantities, no parameters need tuning; and because XPBD is unconditionally stable, step sizes need not be tuned for stability either.

## 2. Related Work

For a broad overview the authors point to the survey by Bender et al. [BET14], which covers the field since Baraff's state-of-the-art report [Bar93]. Most specific related work is discussed in the introduction; additional approaches:

- **Varying contact normals / areas.** Xu et al. [XZB14] use semi-implicit integration with analytic contact gradients in a penalty formulation, with stability improved by symbolic Gaussian elimination. Wang et al. [WSPJ17] precompute spatially and directionally varying restitution coefficients by treating the body as a stiff deformable object and solving a proxy contact problem, which gives more realistic bouncing.
- **CAD / multibody dynamics.** Implicit position-based time discretizations appear in ADAMS and MBDyn [OCC77, Rya90, MMM14]. These typically use penalty contact needing carefully tuned parameters and cannot produce perfectly hard contact. Offline multibody codes may use higher-order integrators such as BDF2, which help free flight; but for non-smooth trajectories, typical of contact, the authors found higher-order integration can give spurious, unpredictable collision response. This motivates small time steps with complementarity-based contact.
- **Rigid–soft coupling.** Galvez et al. [GCC] link rigid and deformable bodies with kinematic joints and solve the non-smooth contact problem with a mixed augmented Lagrangian, integrating with a non-smooth generalized-$\alpha$ scheme. Coupling rigid and soft bodies is natural in the proposed method.
- **Oriented particles.** Augmenting particles with orientation was used by Müller et al. [MC11] to stabilize shape-matching soft bodies, and by Umetani et al. [USS15] for position-based elastic rods.
- **Closest work: Deul et al. [DCB14]**, who formulated rigid body dynamics within PBD. Their description is fairly vague, e.g. a short passage on joints covering one joint type and no joint limits, which are essential in rigid body engines. This paper provides hard and soft joint limits, collisions against rounded objects, and — the key difference — uses XPBD instead of PBD, giving physical parameters and the ability to read out forces and torques at joints and contacts.

## 3. Position Based Rigid Body Simulation

The section first recaps the original particle-based PBD loop, then extends it to rigid bodies.

> Figure 3: The two basic correction operations. Top: classical particle PBD — a positional correction $\Delta\mathbf{x}$ applied to two particles is split in proportion to their inverse masses so that linear and angular momentum are conserved. Middle: a positional correction applied at points $\mathbf{r}_1$, $\mathbf{r}_2$ on two rigid bodies produces translations $\Delta\mathbf{x}_1$, $\Delta\mathbf{x}_2$ of the centers of mass and rotations $\Delta\mathbf{q}_1$, $\Delta\mathbf{q}_2$, weighted by a combination of inverse masses and inverse inertia. Bottom: a pure rotational correction $\Delta\mathbf{q}$ (here aligning two orientations) is split between the bodies in proportion to their inverse moments of inertia; centers of mass do not move.

### 3.1. Particle Simulation Loop

```
Algorithm 1  Position Based Particle Simulation

while simulating do
    CollectCollisionPairs();
    h ← Δt / numSubsteps;
    for numSubsteps do
        for n particles do
            x_prev ← x;
            v ← v + h f_ext / m;
            x ← x + h v;
        end
        for numPosIters do
            SolvePositions(x_1, ..., x_n);
        end
        for n particles do
            v ← (x − x_prev) / h;
        end
    end
end
```

Substepping is already built in: $\Delta t$ is the frame time step and $h$ the substep size. Per substep, the first loop explicitly integrates positions $\mathbf{x}_i$ and velocities $\mathbf{v}_i$ using only external forces $\mathbf{f}_{ext}$ such as gravity. The second loop is the implicit core: `SolvePositions` sweeps all constraints (Gauss-Seidel or Jacobi style) and moves particles by constraint projection — this is the paper's main subject. The third loop derives new velocities from previous and current positions. Following [MSL*19], substeps are much more effective than iterations, so `numPosIters` is normally 1.

### 3.2. Rigid Body Simulation Loop

A particle is fully described by position $\mathbf{x}$, velocity $\mathbf{v}$ and mass $m$. A finite rigid body additionally carries angular quantities:

- its orientation, a unit quaternion $\mathbf{q} \in \mathbb{R}^4$, $|\mathbf{q}| = 1$;
- its angular velocity $\boldsymbol{\omega} \in \mathbb{R}^3$;
- its inertia tensor $\mathbf{I} \in \mathbb{R}^{3\times3}$.

The angular velocity splits into a unit rotation axis and a scalar rate:

$$\boldsymbol{\omega} = \omega \cdot \mathbf{n}_{rot} \tag{1}$$

The inertia tensor is the rotational analogue of mass. Simple shapes (boxes, spheres) have closed-form tensors; for a closed triangle mesh, Blow and Binstock [BB04] give a short algorithm computing the tensor and the center of mass together. Algorithm 2 extends Algorithm 1 with these quantities.

```
Algorithm 2  Position Based Rigid Body Simulation

while simulating do
    CollectCollisionPairs();
    h ← Δt / numSubsteps;
    for numSubsteps do
        for n bodies and particles do
            x_prev ← x;
            v ← v + h f_ext / m;
            x ← x + h v;
            q_prev ← q;
            ω ← ω + h I⁻¹ (τ_ext − (ω × (I ω)));
            q ← q + h ½ [ω_x, ω_y, ω_z, 0] q;
            q ← q / |q|;
        end
        for numPosIters do
            SolvePositions(x_1, ..., x_n, q_1, ..., q_n);
        end
        for n bodies and particles do
            v ← (x − x_prev) / h;
            Δq ← q q_prev⁻¹;
            ω ← 2 [Δq_x, Δq_y, Δq_z] / h;
            ω ← Δq_w ≥ 0 ? ω : −ω;
        end
        SolveVelocities(v_1, ..., v_n, ω_1, ..., ω_n);
    end
end
```

The extra lines for rotational integration and velocity derivation drop easily into an existing PBD code. The angular-velocity update, including external torques $\boldsymbol{\tau}_{ext}$ and the gyroscopic term, comes from the Newton–Euler equations (see Mirtich's thesis [Mir96]). Quaternion integration and the recovery of $\boldsymbol{\omega}$ from the quaternion change use linearized formulas, which are fast, robust and adequate at substep sizes. Unlike the particle case, the implicit solver now also changes orientations.

The same solver simulates rigid and deformable objects together and coupled: it loops over all bodies and all particles, skipping the rotational updates for particles.

### 3.3. Core Projection Operations

Changing the main loop is easy; the hard part is solving constraints between finite-sized bodies in a positional framework. Only two basic operations are required (Figure 3); every joint type, contact, and rigid–soft coupling is built on them.

- As a reference, the particle distance constraint (Figure 3, top) applies a correction $\Delta\mathbf{x}$ to restore the rest length, distributing it in proportion to inverse masses $w_i = m_i^{-1}$ to conserve linear and angular momentum.
- **Operation 1** (middle row): a positional correction $\Delta\mathbf{x}$ applied between points $\mathbf{r}_1$, $\mathbf{r}_2$ (relative to each body's center of mass) — a generalized distance constraint. To conserve momentum it moves *and* rotates both bodies according to their generalized inverse masses.
- **Operation 2** (bottom row): a rotational correction applied to two bodies, e.g. to align orientations, distributed by inverse moments of inertia.

The update formulas are derived from impulse-based dynamics in the Appendix; the final, implementable forms follow.

#### 3.3.1. Positional Constraints

To apply a positional correction $\Delta\mathbf{x}$ at $\mathbf{r}_1$ and $\mathbf{r}_2$, split it into direction $\mathbf{n}$ and magnitude $c$ (the latter is the constraint-function value in PBD terms). The two generalized inverse masses are

$$w_1 = \frac{1}{m_1} + (\mathbf{r}_1 \times \mathbf{n})^T\, \mathbf{I}_1^{-1}\, (\mathbf{r}_1 \times \mathbf{n}) \tag{2}$$

$$w_2 = \frac{1}{m_2} + (\mathbf{r}_2 \times \mathbf{n})^T\, \mathbf{I}_2^{-1}\, (\mathbf{r}_2 \times \mathbf{n}) \tag{3}$$

As in XPBD, the Lagrange multiplier update is

$$\Delta\lambda = \frac{-c - \tilde\alpha\,\lambda}{w_1 + w_2 + \tilde\alpha} \tag{4}$$

$$\lambda \leftarrow \lambda + \Delta\lambda \tag{5}$$

with $\tilde\alpha = \alpha / h^2$, where $\alpha$ is the constraint's compliance. Each compliant constraint stores one multiplier $\lambda$, reset to zero before the solver starts. Compliance is inverse stiffness with units of meters per Newton; $\alpha = 0$ gives an infinitely stiff constraint. With the positional impulse $\mathbf{p} = \Delta\lambda\,\mathbf{n}$, the bodies are updated immediately after each constraint solve:

$$\mathbf{x}_1 \leftarrow \mathbf{x}_1 + \mathbf{p}/m_1 \tag{6}$$

$$\mathbf{x}_2 \leftarrow \mathbf{x}_2 - \mathbf{p}/m_2 \tag{7}$$

$$\mathbf{q}_1 \leftarrow \mathbf{q}_1 + \tfrac{1}{2}\left[\mathbf{I}_1^{-1}(\mathbf{r}_1 \times \mathbf{p}),\, 0\right]\mathbf{q}_1 \tag{8}$$

$$\mathbf{q}_2 \leftarrow \mathbf{q}_2 - \tfrac{1}{2}\left[\mathbf{I}_2^{-1}(\mathbf{r}_2 \times \mathbf{p}),\, 0\right]\mathbf{q}_2 \tag{9}$$

The second body gets the opposite sign. Updating bodies immediately after each constraint prevents overshooting and is one source of PBD's robustness; the result is a non-linear projected Gauss-Seidel solve. A Jacobi variant (for parallel implementations, or to remove order dependence) converges more slowly: corrections are accumulated and applied after each full sweep over the constraints. After the solve, the force acting along the constraint is

$$\mathbf{f} = \lambda\,\mathbf{n} / h^2 \tag{10}$$

Coupling a rigid body to a soft body made of constrained particles is direct: a particle is treated as a body with $w = m^{-1}$ and no orientation update.

#### 3.3.2. Angular Constraints

Joints also need to constrain the relative orientation of two bodies. The correction is then a rotation vector $\Delta\mathbf{q} \in \mathbb{R}^3$, split into axis $\mathbf{n}$ and angle $\theta$. The generalized inverse masses become

$$w_1 = \mathbf{n}^T\, \mathbf{I}_1^{-1}\, \mathbf{n} \tag{11}$$

$$w_2 = \mathbf{n}^T\, \mathbf{I}_2^{-1}\, \mathbf{n} \tag{12}$$

The XPBD update is unchanged except that the angle replaces the distance:

$$\Delta\lambda = \frac{-\theta - \tilde\alpha\,\lambda}{w_1 + w_2 + \tilde\alpha} \tag{13}$$

$$\lambda \leftarrow \lambda + \Delta\lambda \tag{14}$$

Now only orientations change:

$$\mathbf{q}_1 \leftarrow \mathbf{q}_1 + \tfrac{1}{2}\left[\mathbf{I}_1^{-1}\mathbf{p},\, 0\right]\mathbf{q}_1 \tag{15}$$

$$\mathbf{q}_2 \leftarrow \mathbf{q}_2 - \tfrac{1}{2}\left[\mathbf{I}_2^{-1}\mathbf{p},\, 0\right]\mathbf{q}_2 \tag{16}$$

(with $\mathbf{p} = \Delta\lambda\,\mathbf{n}$ as before `[reconstructed]`).

The world-space inertia tensor depends on the current orientation and would need updating after every projection. Instead, $\mathbf{n}$, $\mathbf{r}$ and $\mathbf{p}$ are transformed into each body's rest frame before evaluating the formulas; joint attachment points $\mathbf{r}$ are usually defined in the rest frame anyway. Bodies are also rotated in their rest state so that the inertia tensor is diagonal, which simplifies the expressions and lets it be stored as a 3-vector. By analogy with Eq. (10), the exerted torque is

$$\boldsymbol{\tau} = \lambda\,\mathbf{n} / h^2 \tag{17}$$

### 3.4. Joints

Joints connect body pairs and restrict their relative translational and rotational degrees of freedom. All joint types below use only the two correction operations of Section 3.3.

#### 3.4.1. Rotational Degrees of Freedom

For a joint that fully aligns the relative orientation of two bodies, the angular correction is

$$\mathbf{q} = \mathbf{q}_1\,\mathbf{q}_2^{-1} \tag{18}$$

$$\Delta\mathbf{q}_{fixed} = 2\,(q_x, q_y, q_z) \tag{19}$$

More general joints define, on each body in its rest shape, an attachment point $\bar{\mathbf{r}}$ and a set of mutually perpendicular unit axes $[\bar{\mathbf{a}}, \bar{\mathbf{b}}, \bar{\mathbf{c}}]$. When handling the joint these are first transformed to world space as $\mathbf{r}$ and $[\mathbf{a}, \mathbf{b}, \mathbf{c}]$.

**Hinge.** The axes $\mathbf{a}_1$ and $\mathbf{a}_2$ must coincide, which is enforced with

$$\Delta\mathbf{q}_{hinge} = \mathbf{a}_1 \times \mathbf{a}_2 \tag{20}$$

**Target angle / motor.** To drive a hinge toward a target angle $\alpha$, rotate $\mathbf{b}_1$ about $\mathbf{a}_1$ by $\alpha$ to obtain $\mathbf{b}_{target}$ and apply

$$\Delta\mathbf{q}_{target} = \mathbf{b}_{target} \times \mathbf{b}_2 \tag{21}$$

The compliance of this constraint sets its stiffness. A velocity-driven motor follows by advancing the target angle every substep, $\alpha \leftarrow \alpha + h\,v$, where $v$ is the motor's target angular velocity and the compliance acts as its strength.

**Joint limits.** Limits are essential in a rigid body engine; for rotational DOFs they bound joint angles. Algorithm 3 is the generic procedure: it keeps the angle between axis $\mathbf{n}_1$ (body 1) and $\mathbf{n}_2$ (body 2), measured about a common rotation axis $\mathbf{n}$, inside $[\alpha, \beta]$.

```
Algorithm 3  Handling joint angle limits

LimitAngle(n, n1, n2, α, β):
    φ ← arcsin((n1 × n2) · n);
    if n1 · n2 < 0 then φ ← π − φ;
    if φ > π then φ ← φ − 2π;
    if φ < −π then φ ← φ + 2π;
    if φ < α or φ > β then
        φ ← clamp(φ, α, β);
        n1 ← rot(n, φ) n1;
        Apply(Δq_limit = n1 × n2);
    end
    return
```

Usage per joint type:

- **Hinge** with common axis $\mathbf{a}_1 = \mathbf{a}_2$: $[\mathbf{n}, \mathbf{n}_1, \mathbf{n}_2] = [\mathbf{a}_1, \mathbf{b}_1, \mathbf{b}_2]$.
- **Spherical (ball-in-socket)**: swing and twist of $\mathbf{a}_2$ relative to $\mathbf{a}_1$ are limited separately. Swing uses $[\mathbf{n}, \mathbf{n}_1, \mathbf{n}_2] = [\mathbf{a}_1 \times \mathbf{a}_2,\, \mathbf{a}_1,\, \mathbf{a}_2]$. Twist must be decoupled from swing, using the axes

$$\mathbf{n} \leftarrow (\mathbf{a}_1 + \mathbf{a}_2) / |\mathbf{a}_1 + \mathbf{a}_2| \tag{22}$$

$$\mathbf{n}_1 \leftarrow \mathbf{b}_1 - (\mathbf{n}\cdot\mathbf{b}_1)\,\mathbf{n};\quad \mathbf{n}_1 \leftarrow \mathbf{n}_1 / |\mathbf{n}_1| \tag{23}$$

$$\mathbf{n}_2 \leftarrow \mathbf{b}_2 - (\mathbf{n}\cdot\mathbf{b}_2)\,\mathbf{n};\quad \mathbf{n}_2 \leftarrow \mathbf{n}_2 / |\mathbf{n}_2| \tag{24}$$

Any limit becomes soft by giving it a compliance $\alpha > 0$.

#### 3.4.2. Positional Degrees of Freedom

Translational DOFs are simpler. Compute the offset between the world attachment points, $\Delta\mathbf{r} = \mathbf{r}_2 - \mathbf{r}_1$. Using $\Delta\mathbf{x} = \Delta\mathbf{r}$ attaches the bodies with zero separation, the usual joint case; with $\alpha > 0$ it becomes a zero-rest-length spring. For more flexibility, an upper separation limit $d_{max}$ can be given: a correction is applied only if $|\Delta\mathbf{r}| > d_{max}$, namely

$$\Delta\mathbf{x} = \frac{\Delta\mathbf{r}}{|\Delta\mathbf{r}|}\left(|\Delta\mathbf{r}| - d_{max}\right) \tag{25}$$

The attachment can also be relaxed so the bodies move within bounds along chosen axes. Start with $\Delta\mathbf{x} = \mathbf{0}$. For axis $\mathbf{a}_1$ compute the projected displacement $a = \Delta\mathbf{r}\cdot\mathbf{a}_1$; if $a < a_{min}$ add $\mathbf{a}_1 (a - a_{min})$ to the correction, and if $a > a_{max}$ add $\mathbf{a}_1 (a - a_{max})$. Repeat for every axis and limit, then apply the accumulated correction once, so all limits are handled by a single projection.

Setting every limit except those of the first axis to zero gives a **prismatic** joint. To drive a joint (e.g. a robot) to a given offset, replace $d_{max}$ by $d_{target}$ in Eq. (25) and apply the correction unconditionally; choosing the compliance $\alpha = \frac{1}{f}\left(|\Delta\mathbf{r}| - d_{target}\right)$ makes the joint apply a force $f$.

Joints show the benefit of the positional, non-linear Gauss-Seidel approach: unilateral constraints are handled by applying corrections only when their condition holds; corrections always follow the current offsets and errors; and an attachment is one constraint instead of the three rows a linearized solver needs.

### 3.5. Handling Contacts and Friction

To save cost, potential collision pairs are gathered once per *time step* (not per substep) with an AABB tree. Each box is enlarged by $k\,\Delta t\,v_{body}$, with a safety factor $k \ge 1$ covering accelerations during the step; the examples use $k = 2$. Every substep then tests the pairs for actual contact. On contact, the current contact normal and the local contact points $\mathbf{r}_1$, $\mathbf{r}_2$ on bodies 1 and 2 are computed, and two Lagrange multipliers for normal and tangential force, $\lambda_n$ and $\lambda_t$, are set to zero.

During the position solve, the contact points are evaluated on both bodies at the current state and at the state before the substep's integration:

$$\mathbf{p}_1 = \mathbf{x}_1 + \mathbf{q}_1\mathbf{r}_1,\quad \mathbf{p}_2 = \mathbf{x}_2 + \mathbf{q}_2\mathbf{r}_2,\quad \bar{\mathbf{p}}_1 = \mathbf{x}_{1,prev} + \mathbf{q}_{1,prev}\mathbf{r}_1,\quad \bar{\mathbf{p}}_2 = \mathbf{x}_{2,prev} + \mathbf{q}_{2,prev}\mathbf{r}_2 \tag{26}$$

where quaternion × vector means rotating the vector by the quaternion. The penetration is $d = (\mathbf{p}_1 - \mathbf{p}_2)\cdot\mathbf{n}$; the contact is skipped if $d \le 0$. The non-linear Gauss-Seidel solver handles the complementarity condition simply by checking it per constraint. When penetrating, apply $\Delta\mathbf{x} = d\,\mathbf{n}$ with $\alpha = 0$, accumulating into $\lambda_n$.

**Static friction.** Compute the relative motion of the contact points over the substep and its tangential part:

$$\Delta\mathbf{p} = (\mathbf{p}_1 - \bar{\mathbf{p}}_1) - (\mathbf{p}_2 - \bar{\mathbf{p}}_2) \tag{27}$$

$$\Delta\mathbf{p}_t = \Delta\mathbf{p} - (\Delta\mathbf{p}\cdot\mathbf{n})\,\mathbf{n} \tag{28}$$

Static friction means no tangential motion at the contact, $\Delta\mathbf{p}_t = 0$. It is enforced by applying $\Delta\mathbf{x} = \Delta\mathbf{p}_t$ at the contact points with $\alpha = 0$, but only if $\lambda_t < \mu_s\,\lambda_n$, where $\mu_s$ is the static friction coefficient. For bodies with different coefficients the paper uses $\mu = (\mu_1 + \mu_2)/2$; taking the maximum or minimum is an alternative.

### 3.6. Velocity Level

Plain PBD derives velocities after the position solve and moves on to the next substep. To handle dynamic friction and restitution, a velocity solve is appended (Algorithm 2), making one pass over all contacts and updating the new velocities.

For each contact pair, the relative normal and tangential velocities at the contact point are

$$\mathbf{v} \leftarrow (\mathbf{v}_1 + \boldsymbol{\omega}_1 \times \mathbf{r}_1) - (\mathbf{v}_2 + \boldsymbol{\omega}_2 \times \mathbf{r}_2),\qquad v_n \leftarrow \mathbf{n}\cdot\mathbf{v},\qquad \mathbf{v}_t \leftarrow \mathbf{v} - \mathbf{n}\,v_n \tag{29}$$

**Dynamic friction** is integrated explicitly via the velocity update

$$\Delta\mathbf{v} \leftarrow -\frac{\mathbf{v}_t}{|\mathbf{v}_t|}\,\min\!\left(h\,\mu_d\,|f_n|,\; |\mathbf{v}_t|\right) \tag{30}$$

where $\mu_d$ is the dynamic friction coefficient and $f_n = \lambda_n / h^2$ is the normal force. This is the explicit application of Coulomb dynamic friction; combined with the Gauss-Seidel update it is unconditionally stable, because the $\min$ guarantees that the correction never exceeds the current tangential speed.

**Joint damping** is applied in the same pass:

$$\Delta\mathbf{v} \leftarrow (\mathbf{v}_2 - \mathbf{v}_1)\,\min(\mu_{lin}\,h,\; 1) \tag{31}$$

$$\Delta\boldsymbol{\omega} \leftarrow (\boldsymbol{\omega}_2 - \boldsymbol{\omega}_1)\,\min(\mu_{ang}\,h,\; 1) \tag{32}$$

**Applying a velocity correction.** Following the Appendix, a velocity update $\Delta\mathbf{v}$ at $\mathbf{r}_1$, $\mathbf{r}_2$ is applied as (with $w_1$, $w_2$ from Eqs. (2)–(3) using $\mathbf{n} = \Delta\mathbf{v}/|\Delta\mathbf{v}|$ `[reconstructed]`):

$$\mathbf{p} = \frac{\Delta\mathbf{v}}{w_1 + w_2},\quad \mathbf{v}_1 \leftarrow \mathbf{v}_1 + \mathbf{p}/m_1,\quad \mathbf{v}_2 \leftarrow \mathbf{v}_2 - \mathbf{p}/m_2,\quad \boldsymbol{\omega}_1 \leftarrow \boldsymbol{\omega}_1 + \mathbf{I}_1^{-1}(\mathbf{r}_1 \times \mathbf{p}),\quad \boldsymbol{\omega}_2 \leftarrow \boldsymbol{\omega}_2 - \mathbf{I}_2^{-1}(\mathbf{r}_2 \times \mathbf{p}) \tag{33}$$

**Restitution** additionally needs $\bar v_n$, the normal velocity *before* the PBD velocity update, obtained by evaluating Eq. (29) with the pre-update velocities. With restitution coefficient $e$, the desired post-contact normal velocity is $-e\,\bar v_n$, achieved by

$$\Delta\mathbf{v} \leftarrow \mathbf{n}\left(-v_n + \min(-e\,\bar v_n,\; 0)\right) \tag{34}$$

i.e. the current normal velocity $v_n$ is removed and replaced by the reflected velocity $-e\,\bar v_n$, while ensuring the result points along the collision normal. To avoid jitter, $e$ is set to 0 when $|v_n|$ is small; the threshold is $|v_n| \le 2\,|\mathbf{g}|\,h$ with gravity $\mathbf{g}$, which is twice the velocity that the prediction step adds from gravity in one substep.

This step also fixes a known PBD weakness. Velocities derived by PBD's standard update are meaningful only if no collision happened during the step; otherwise they merely encode the penetration depth, which depends on how the trajectory was discretized in time. Objects spawned overlapping also receive large separating velocities in plain PBD. Eq. (34) discards the derived velocity at an impact and substitutes the previous step's velocity scaled by the restitution coefficient — which is zero for initially overlapping objects.

## 4. Results

All demos ran on a Core-i7 CPU at 3.6 GHz with 32 GB of RAM. Table 1 lists per-frame simulation cost; the accompanying video shows the behavior best.

| Example | substeps | iters/substep | time (ms/frame) |
|---|---|---|---|
| 3 Boxes | 20 | 1 | 0.34 |
| 7 Boxes | 20 | 1 | 0.44 |
| Pendula | 40 | 1 | 0.07, 0.09, 0.2 |
| Bunnies | 20 | 1 | 2.3 |
| Rolling balls | 10 | 1 | 15 |
| Coin | 20 | 1 | 0.3 |
| Car | 20 | 1 | 18 |
| Robot | 20 | 1 | 0.4 |
| Rope | 20 | 1 | 3.5 |

> Table 1: Computation times. All examples use a simulation time step of 1/60 s per frame.

**Basic technical scenes.** The test application visualizes forces, torques and elongations at joints.

> Figure 4: The test application displays forces, torques and elongations live. Compliance, force and elongation keep the correct relationship regardless of substep and iteration counts.

- Figure 4: boxes hang from a static ceiling on distance joints, all with compliance $0.01\,\mathrm{m/N}$; large and small boxes weigh 1 kg and 1/8 kg, gravity is $10\,\mathrm{m/s^2}$. Elongations and forces come out correct independent of iteration and substep counts.
- Figure 5: the same holds for torques. A bar on a hinge joint with target angle 0° and zero compliance exerts exactly the torque needed to resist a user force applied 20 cm from the pivot. XPBD makes an infinitely stiff joint trivial (zero compliance), unlike force- or impulse-based systems.
- Figure 6 (large mass ratios): a 1 g box hangs from the ceiling on a distance joint and holds a 1 kg box with a second joint, repeated with compliances 0.01, 0.001 and 0 m/N. The simulation is stable. With non-zero compliance, distances are proportional to forces; with zero compliance the distance stays zero whatever the force. At 20 substeps a small error remains at the top joint.
- Figure 7: prismatic, hinge and ball-in-socket joints with various limits, target angles and target offsets.
- Figure 8 (pendula): plain hinges reproduce double, triple and closed-loop pendula. Chaotic motion appears only with small time steps and little damping: with 40 substeps × 1 iteration the pendula keep swinging for a long time, whereas 1 substep × 100 iterations brings them to rest quickly. Figure 9 plots the triple pendulum's energy for several substep/iteration splits — replacing all iterations by substeps is best.
- Figures 10–11 (constraint error): a chain of 100 bunnies hanging from the ceiling, run with different substep × iteration combinations at a fixed budget. Again, substeps instead of iterations is by far the best; the video shows the difference vividly.

> Figure 5: A spring of fixed compliance (yellow) attached to the mouse pulls on a bar that is hinged on its left end with target angle zero and zero compliance; the joint produces the correct torque to keep the bar straight.

> Figure 6: Large mass ratios: a 1 g box hangs on a distance constraint from the ceiling and holds a 1 kg box via a second joint; joint compliances from left to right are 0.01, 0.001 and 0 m/N.

> Figure 7: Various joint types with target angles and with soft and hard joint limits.

> Figure 8: Substepping gives correct double- and triple-pendulum behavior; a closed-loop pendulum is also easy.

> Figure 9: Energy of the triple pendulum over 10 s for substeps × iterations = 20×1, 10×2, 5×4, 2×10 and 1×20.

> Figure 10: A chain of 100 bunnies hanging from the ceiling. Left: 1 substep, 20 iterations. Right: 20 substeps, 1 iteration.

> Figure 11: Chain elongation (0–30 %) for substeps × iterations = 20×1, 10×2, 5×4, 2×10 and 1×20.

**Velocity pass.** The Section 3.6 velocity pass propagates impulses correctly (Figure 12): a marble hitting a row of three from the right transfers its impulse to the rightmost marble, while PBD's plain velocity derivation does not. In Figure 13 marbles start out penetrating the wires; PBD's derived velocities make them jump off the track, whereas with the velocity pass they are pushed out gently and stay on it.

> Figure 12: Top to bottom: initial condition; state after the red marble's hit using the proposed velocity pass with restitution 1; state after the hit using plain PBD velocity derivation.

> Figure 13: Marbles created penetrating the wires. Top: plain PBD produces large velocities and the marbles jump off the track. Bottom: the marbles are pushed up gently and remain on the track.

**Large scenes.** Two scenes target the method's strengths (Figure 1):

- *Rolling-ball sculpture*, inspired by David Morell's sculptures [Mor] and their mechanisms. In some elements, e.g. the spring of Figure 14, a marble turns a quarter circle within one time step; such fast curved motion needs substepping and current constraint normals for each projection. Collision handling dominates the cost, especially finding the closest point on a Hermite spline segment. Substepping plus curved geometry also reproduces the high-frequency wobble of a coin just before it settles (Figure 15).
- *Remote-controlled car*: demonstrates coupling soft tires to rigid rims and handling large mass ratios. The whole steering train from servo to wheels is simulated (Figure 16); servo arm to wheel mass ratio is 1:760, the servo arm is 3 cm long and the wheels 15 cm in diameter, yet the servo turns the big wheels quickly against obstacles and terrain. Using actual constraint directions matters because an RC car sees far larger accelerations and direction changes than a real car. High-frequency spring vibration is resolved, conveying stiff springs. The wheels are the most expensive part: FEM on tetrahedra could not reach the required stiffness within the budget, so per-element shape matching [MHTG05] is used on the tires' 1100 hexahedral elements.

> Figure 14: Some sculpture elements make marbles turn sharply within a single time step, which requires current constraint directions for every projection.

> Figure 15: Curved-geometry handling plus substepping reproduces the high-frequency motion of a coin shortly before it comes to rest.

> Figure 16: The steering mechanism is simulated from the small servo arm to the big wheels, a mass ratio of 1:760.

**Joint limits.** Two scenes show why limit handling matters. In Figure 17 the method solves inverse kinematics so a robot gripper follows a gray box while all joint limits are respected; unreachable targets create over-constrained problems that are handled gracefully by bringing the gripper as close as possible to the target pose. Independent swing and twist limits with separate compliances let a chain of 100 capsules joined by spherical joints behave correctly as a twisted rope (Figure 18).

> Figure 17: Inverse kinematics for over-constrained systems with possibly redundant degrees of freedom, e.g. this robot arm.

> Figure 18: Separate swing and twist limits make a twisted rope possible.

## 5. Conclusion

The paper presents a rigid body method that resolves small temporal and spatial detail accurately. Being built on XPBD, it inherits XPBD's simplicity and its handling of infinitely stiff joints. Substepping improves accuracy and energy conservation and copes with large mass ratios and fast direction changes within a single time step. Two basic projection operations suffice for a complete rigid body engine. Source snippets are available on the authors' challenges page [Mue20].

Limitations:

- Substepping removes most numerical damping, so high-frequency vibration is not damped out and can look jittery; real physical damping can be added back easily.
- Small time steps require double precision. Doubles cost nothing extra on CPUs but still slow GPUs down.
- Updating constraint directions after every projection may destabilize tall stacks or piles; this is left for future work.

## Appendix A: Derivation of the Position Based Updates

In impulse-based solvers, impulses applied at contact points change velocities. Let $\mathbf{r}$ be the vector from the center of mass to the contact point. An impulse $\mathbf{p}$ at that point changes the center-of-mass velocity $\mathbf{v}_{cm}$ and the angular velocity $\boldsymbol{\omega}$:

$$\mathbf{p} = m\,\Delta\mathbf{v}_{cm} \tag{35}$$

$$\mathbf{r} \times \mathbf{p} = \mathbf{I}\,\Delta\boldsymbol{\omega} \tag{36}$$

with mass $m$ and inertia $\mathbf{I}$. The velocity of the contact point is

$$\mathbf{v} = \mathbf{v}_{cm} + \boldsymbol{\omega} \times \mathbf{r} \tag{37}$$

With contact normal $\mathbf{n}$, writing the impulse as $\mathbf{p} = p\,\mathbf{n}$ and the normal velocity change as the scalar $\Delta v$:

$$\Delta v = \left[\Delta\mathbf{v}_{cm} + \Delta\boldsymbol{\omega} \times \mathbf{r}\right]\cdot\mathbf{n} \tag{38}$$

$$= \left[\mathbf{p}\,m^{-1} + \left(\mathbf{I}^{-1}(\mathbf{r}\times\mathbf{p})\right)\times\mathbf{r}\right]\cdot\mathbf{n} \tag{39}$$

$$= p\left[\mathbf{n}\,m^{-1} + \left(\mathbf{I}^{-1}(\mathbf{r}\times\mathbf{n})\right)\times\mathbf{r}\right]\cdot\mathbf{n} \tag{40}$$

$$= p\left[\mathbf{n}\cdot\mathbf{n}\,m^{-1} + \left(\mathbf{I}^{-1}(\mathbf{r}\times\mathbf{n})\right)\times\mathbf{r}\cdot\mathbf{n}\right] \tag{41}$$

$$= p\left[m^{-1} + (\mathbf{r}\times\mathbf{n})^T\,\mathbf{I}^{-1}\,(\mathbf{r}\times\mathbf{n})\right] \tag{42}$$

$$= p\,w \tag{43}$$

where $w$ is a generalized inverse mass. An impulse $p$ at the contact between two bodies produces a total velocity change $\Delta v = \Delta v_1 + \Delta v_2 = p\,(w_1 + w_2)$; conversely, a desired velocity change is achieved by the impulse $p = \Delta v / (w_1 + w_2)$. Given the impulse, the body updates are

$$\Delta\mathbf{v}_{cm} = \mathbf{p}\,m^{-1} \tag{44}$$

$$\Delta\boldsymbol{\omega} = \mathbf{I}^{-1}(\mathbf{r}\times\mathbf{p}) \tag{45}$$

Moving from velocities to positions amounts to multiplying these relations by time: the velocity correction $\Delta\mathbf{v}$ becomes a positional correction $\Delta\mathbf{x}$, and the impulse becomes a quantity with units of mass × distance. The generalized inverse mass is unchanged. The center-of-mass velocity update turns into a position update, and the angular velocity update turns into a rotation, which is applied to the orientation with the linearized quaternion update of Algorithm 2.

## References (subset relevant to this repo)

The full reference list is omitted. Works cited by the paper that matter for this codebase:

- [MHTG05] Müller, Heidelberger, Teschner, Gross — *Meshless deformations based on shape matching*, ACM TOG 24(3), 2005. (Basis of `shape-match-core.js`; the paper also uses it for the RC car tires.)
- [MHR06] Müller, Heidelberger, Hennix, Ratcliff — *Position based dynamics*, VRIPHYS 2006.
- [MMC16] Macklin, Müller, Chentanez — *XPBD: position-based simulation of compliant constrained dynamics*, MIG 2016.
- [MSL*19] Macklin et al. — *Small steps in physics simulation*, SCA 2019 (substeps beat iterations).
- [MC11] Müller, Chentanez — *Solid simulation with oriented particles*, ACM TOG 30(4), 2011.
- [DCB14] Deul, Charrier, Bender — *Position-based rigid body dynamics*, Computer Animation and Virtual Worlds 27(2), 2014.
- [Mir96] Mirtich — *Impulse-based Dynamic Simulation of Rigid Body Systems*, PhD thesis, 1996.
- [BB04] Blow, Binstock — *How to find the inertia tensor (or other mass properties) of a 3D solid body represented by a triangle mesh*, 2004.
- [Mue20] Müller — the author's online "challenges" page with source-code snippets for this paper (URL in the original reference list).
