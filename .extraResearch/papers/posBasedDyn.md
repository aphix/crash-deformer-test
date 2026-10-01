# Position Based Dynamics

**Authors:** Matthias Müller, Bruno Heidelberger, Marcus Hennix, John Ratcliff (AGEIA)
**Venue:** 3rd Workshop in Virtual Reality Interactions and Physical Simulation "VRIPHYS" (2006), C. Mendoza, I. Navazo (Editors). © The Eurographics Association 2006.
**ACM CCS:** I.3.5 [Computer Graphics]: Computational Geometry and Object Modeling — Physically Based Modeling; I.3.7 [Computer Graphics]: Three-Dimensional Graphics and Realism — Animation and Virtual Reality.

> Rewrite note: prose below is paraphrased and condensed section by section; equations, pseudocode, parameter values and captions are preserved in meaning. Equations damaged by PDF extraction were rebuilt from context; uncertain ones are tagged `[reconstructed]`.

## Abstract

Most graphics simulators are force based: internal and external forces are summed, Newton's second law turns them into accelerations, and a time integrator updates velocities and then positions. Some (notably most rigid-body engines) are impulse based and modify velocities directly. This paper skips the velocity layer as well and acts **directly on positions**. The main benefit is controllability: the overshoot problems of explicit force-based integration disappear, and collision constraints are easy because penetrations can be fully removed by projecting points to valid locations. The authors built a real-time cloth simulator (part of a commercial physics library) on this approach to show its strengths.

## 1. Introduction

Graphics simulation values stability, robustness and speed over accuracy; results only need to look plausible. Methods from computational science therefore do not transfer one-to-one, which justifies graphics-specific techniques such as this one.

The classic pipeline accumulates internal forces (e.g. elastic forces in deformables, viscosity/pressure in fluids) and external forces (gravity, collisions) per time step, converts them to accelerations using lumped vertex masses, and integrates velocities then positions. Impulse methods skip one integration level by changing velocities directly.

Games in particular want **direct control over positions** — e.g. pin a vertex to a kinematic object, or guarantee a vertex stays outside a collider. Working on positions makes that trivial and also lets the integration itself be controlled, avoiding the overshoot / energy gain that plagues explicit integration. The claimed advantages:

- Position based simulation gives control over explicit integration and removes the usual instability problems.
- Vertex positions and object parts can be manipulated directly during simulation.
- The formulation handles general constraints in a position based setting.
- The explicit position solver is easy to understand and implement.

> Figure 1: A well-known deformation benchmark (a character squeezed through rotating gears) applied to a cloth character under pressure.

## 2. Related Work

- The Nealen et al. state-of-the-art report [NMK*05] surveys graphics deformables (mass-springs, FEM, finite differences); apart from [MHTG05] it does not discuss position based dynamics, although pieces of it have appeared in many papers without a named, complete framework.
- **Jakobsen [Jak01]** (Fysix engine) used Verlet integration and moved positions directly, so velocities are updated implicitly through the stored previous position. He focused on distance constraints and only hinted at general constraints. This paper gives a fully general treatment, addresses **conservation of linear and angular momentum** under projection, and keeps **explicit velocities** (instead of previous positions), which makes damping and friction much simpler.
- **Desbrun et al. [DSB99]** and **Provot [Pro95]** project constraints in mass-spring systems only to stop over-stretched springs — projection as a "polishing" pass, not as the core simulation method.
- **Bridson et al. [BFA02]** simulate cloth with forces but add a geometric collision step based on positions to keep impulses bounded; the kinematic collision correction of **Volino et al. [VCMT95]** is similar.
- **Clavet et al. [CBP05]** simulate viscoelastic fluids with a partly position based scheme, but the time step appears inside their projections, so it is only conditionally stable like plain explicit integration.
- **Müller et al. [MHTG05]** (meshless shape matching) move points toward goal positions found by matching the rest shape to the current shape. Their integrator is the closest relative of this one, but it handles a single specialised global constraint and needs no general position solver.
- **Fedor [Fed05]** applies Jakobsen's approach to game characters, keeping several skeletal representations in sync via projections.
- **Faure [Fau98]** uses Verlet and modifies positions, but linearises the constraints; this paper works with the non-linear constraint functions directly.
- Constraints are defined through a constraint function as in [BW98] and [THMG04], but rather than deriving forces from an energy gradient the method solves for the equilibrium configuration and projects positions. A cloth bending term similar to [GHDS03] and [BMF03] is derived for the point based setting.
- Section 4 applies the method to cloth; for the wider cloth literature the reader is referred to [NMK*05].

## 3. Position Based Simulation

This section formulates the general approach; cloth (Sections 4 and 5) is a concrete application. The world is assumed 3D, but everything works equally in 2D.

### 3.1. Algorithm Overview

A dynamic object is a set of $N$ vertices and $M$ constraints. Vertex $i \in [1,\dots,N]$ has mass $m_i$, position $\mathbf{x}_i$ and velocity $\mathbf{v}_i$.

Constraint $j \in [1,\dots,M]$ consists of:

- a cardinality $n_j$,
- a function $C_j : \mathbb{R}^{3n_j} \to \mathbb{R}$,
- a set of indices $\{i_1, \dots, i_{n_j}\}$, $i_k \in [1,\dots,N]$,
- a stiffness parameter $k_j \in [0 \dots 1]$, and
- a type: *equality* or *inequality*.

An equality constraint is satisfied when $C_j(\mathbf{x}_{i_1}, \dots, \mathbf{x}_{i_{n_j}}) = 0$; an inequality constraint when $C_j(\mathbf{x}_{i_1}, \dots, \mathbf{x}_{i_{n_j}}) \ge 0$. The stiffness $k_j$ sets constraint strength on a scale from zero to one.

Given this data and a time step $\Delta t$, the simulation runs:

```text
(1)  forall vertices i
(2)      initialize x_i = x_i^0,  v_i = v_i^0,  w_i = 1/m_i
(3)  endfor
(4)  loop
(5)      forall vertices i do  v_i <- v_i + Δt * w_i * f_ext(x_i)
(6)      dampVelocities(v_1, ..., v_N)
(7)      forall vertices i do  p_i <- x_i + Δt * v_i
(8)      forall vertices i do  generateCollisionConstraints(x_i -> p_i)
(9)      loop solverIterations times
(10)         projectConstraints(C_1, ..., C_{M+M_coll}, p_1, ..., p_N)
(11)     endloop
(12)     forall vertices i
(13)         v_i <- (p_i - x_i) / Δt
(14)         x_i <- p_i
(15)     endfor
(16)     velocityUpdate(v_1, ..., v_N)
(17) endloop
```

Lines (1)–(3) initialise state. The core is lines (7), (9)–(11) and (13)–(14):

- Line (7) predicts new positions $\mathbf{p}_i$ with an explicit Euler step.
- Lines (9)–(11) iteratively modify the predictions so they satisfy the constraints, projecting each constraint in turn in a Gauss–Seidel fashion (Section 3.2).
- Lines (13)–(14) move vertices to the corrected predictions and set velocities accordingly. This matches a Verlet step plus a position modification [Jak01] exactly, since Verlet stores velocity implicitly as current-minus-previous position; explicit velocities are simply more intuitive to manipulate.

Velocities are also touched in lines (5), (6) and (16):

- Line (5) adds external forces that cannot be expressed as positional constraints; with gravity only it reads $\mathbf{v}_i \leftarrow \mathbf{v}_i + \Delta t\,\mathbf{g}$.
- Line (6) optionally damps velocities; Section 3.5 gives a global damping that leaves rigid-body modes untouched.
- Line (16) applies friction and restitution to colliding vertices.

The constraints $C_1,\dots,C_M$ are fixed for the whole run. Line (8) additionally creates $M_{coll}$ collision constraints that change every step. Line (10) projects both kinds.

**Stability.** The scheme is unconditionally stable: lines (13)–(14) do not extrapolate blindly into the future as explicit integrators do; they move vertices to a physically valid configuration $\mathbf{p}_i$ computed by the solver. The only possible source of instability is the solver itself, which uses Newton–Raphson to find valid positions (Section 3.3), and its behaviour depends on the shape of the constraint functions, not on $\Delta t$.

The integrator is neither clearly implicit nor explicit. With a single solver iteration it behaves like an explicit scheme; with more iterations a constrained system can be made arbitrarily stiff and it behaves more like an implicit scheme. Raising the iteration count moves the bottleneck from collision detection to the solver.

### 3.2. The Solver

The solver receives the $M + M_{coll}$ constraints and the predicted positions $\mathbf{p}_1,\dots,\mathbf{p}_N$ and tries to move the predictions so that every constraint holds. The resulting system is non-linear — even a distance constraint $C(\mathbf{p}_1,\mathbf{p}_2) = |\mathbf{p}_1 - \mathbf{p}_2| - d$ is non-linear — and inequality constraints add inequalities. Classic Gauss–Seidel only handles linear systems; what is borrowed from it is the idea of **solving one constraint at a time**. Unlike GS, each solve is itself a non-linear operation. The solver sweeps repeatedly over all constraints and projects the involved particles to positions valid for that constraint alone. In contrast to a Jacobi iteration, each correction is visible immediately to the following projections, which speeds up convergence considerably because "pressure waves" can cross the material within one solver step — an effect that depends on constraint ordering. In over-constrained situations, an order that is not kept constant can cause oscillation.

> Figure 2: Projection of the constraint $C(\mathbf{p}_1,\mathbf{p}_2) = |\mathbf{p}_1 - \mathbf{p}_2| - d$. The corrections $\Delta\mathbf{p}_i$ are weighted by the inverse masses $w_i = 1/m_i$.

Collision constraint generation (line (8)) happens once per time step, which makes it look like an explicit step.

### 3.3. Constraint Projection

Projecting points onto a constraint means moving them so the constraint is satisfied. The central concern when moving points directly inside a simulation loop is **conservation of linear and angular momentum**. Let $\Delta\mathbf{p}_i$ be the displacement of vertex $i$ by the projection. Linear momentum is conserved if

$$\sum_i m_i \Delta\mathbf{p}_i = \mathbf{0}, \tag{1}$$

i.e. the centre of mass does not move. Angular momentum is conserved if

$$\sum_i \mathbf{r}_i \times m_i \Delta\mathbf{p}_i = \mathbf{0}, \tag{2}$$

where $\mathbf{r}_i$ is the distance of $\mathbf{p}_i$ to an arbitrary common rotation centre. A projection that violates either introduces **ghost forces** that behave like external forces, dragging and rotating the object. Only *internal* constraints must conserve momentum; collision and attachment constraints may legitimately have global effects.

The proposed projection conserves both for internal constraints. Again the point based approach is more direct: the constraint function is used as-is, whereas force-based methods derive forces from an energy term [BW98, THMG04].

Take a constraint of cardinality $n$ on $\mathbf{p}_1,\dots,\mathbf{p}_n$ with function $C$ and stiffness $k$, and let $\mathbf{p} = [\mathbf{p}_1^T,\dots,\mathbf{p}_n^T]^T$. For an internal constraint $C$ is invariant to rigid-body modes (translation, rotation), so $\nabla_{\mathbf{p}} C$ — the direction of maximal change — is perpendicular to those modes. Choosing $\Delta\mathbf{p}$ along $\nabla_{\mathbf{p}} C$ therefore conserves both momenta automatically when all masses are equal (unequal masses handled below). We want $\Delta\mathbf{p}$ with $C(\mathbf{p} + \Delta\mathbf{p}) = 0$, linearised as

$$C(\mathbf{p} + \Delta\mathbf{p}) \approx C(\mathbf{p}) + \nabla_{\mathbf{p}} C(\mathbf{p}) \cdot \Delta\mathbf{p} = 0. \tag{3}$$

Restricting $\Delta\mathbf{p}$ to the gradient direction means choosing a scalar $\lambda$ with

$$\Delta\mathbf{p} = \lambda \nabla_{\mathbf{p}} C(\mathbf{p}). \tag{4}$$

Substituting (4) into (3), solving for $\lambda$ and substituting back gives

$$\Delta\mathbf{p} = -\frac{C(\mathbf{p})}{|\nabla_{\mathbf{p}} C(\mathbf{p})|^2} \nabla_{\mathbf{p}} C(\mathbf{p}), \tag{5}$$

a regular Newton–Raphson step for the non-linear equation of a single constraint. Per point:

$$\Delta\mathbf{p}_i = -s\, \nabla_{\mathbf{p}_i} C(\mathbf{p}_1,\dots,\mathbf{p}_n), \tag{6}$$

with the scaling factor, identical for all points,

$$s = \frac{C(\mathbf{p}_1,\dots,\mathbf{p}_n)}{\sum_j |\nabla_{\mathbf{p}_j} C(\mathbf{p}_1,\dots,\mathbf{p}_n)|^2}. \tag{7}$$

With individual masses, corrections are weighted by inverse mass $w_i = 1/m_i$, so a point of infinite mass ($w_i = 0$) stays put, as expected. Eq. (4) becomes $\Delta\mathbf{p}_i = \lambda w_i \nabla_{\mathbf{p}_i} C(\mathbf{p})$, giving

$$s = \frac{C(\mathbf{p}_1,\dots,\mathbf{p}_n)}{\sum_j w_j |\nabla_{\mathbf{p}_j} C(\mathbf{p}_1,\dots,\mathbf{p}_n)|^2} \tag{8}$$

and the final correction

$$\Delta\mathbf{p}_i = -s\, w_i \nabla_{\mathbf{p}_i} C(\mathbf{p}_1,\dots,\mathbf{p}_n). \tag{9}$$

**Example — distance constraint.** For $C(\mathbf{p}_1,\mathbf{p}_2) = |\mathbf{p}_1 - \mathbf{p}_2| - d$ the gradients are $\nabla_{\mathbf{p}_1} C = \mathbf{n}$ and $\nabla_{\mathbf{p}_2} C = -\mathbf{n}$ with $\mathbf{n} = \frac{\mathbf{p}_1 - \mathbf{p}_2}{|\mathbf{p}_1 - \mathbf{p}_2|}$. Hence $s = \frac{|\mathbf{p}_1 - \mathbf{p}_2| - d}{w_1 + w_2}$ and

$$\Delta\mathbf{p}_1 = -\frac{w_1}{w_1 + w_2}\left(|\mathbf{p}_1 - \mathbf{p}_2| - d\right)\frac{\mathbf{p}_1 - \mathbf{p}_2}{|\mathbf{p}_1 - \mathbf{p}_2|} \tag{10}$$

$$\Delta\mathbf{p}_2 = +\frac{w_2}{w_1 + w_2}\left(|\mathbf{p}_1 - \mathbf{p}_2| - d\right)\frac{\mathbf{p}_1 - \mathbf{p}_2}{|\mathbf{p}_1 - \mathbf{p}_2|} \tag{11}$$

These are Jakobsen's distance projection formulas [Jak01] (Figure 2), recovered as a special case of the general method.

**Type and stiffness.** Equality constraints are always projected; inequality constraints only when $C(\mathbf{p}_1,\dots,\mathbf{p}_n) < 0$. The simplest way to apply stiffness is to scale the corrections by $k \in [0 \dots 1]$, but over several solver iterations the effect of $k$ is non-linear: for a single distance constraint the residual after $n_s$ iterations is $\Delta\mathbf{p}(1-k)^{n_s}$. To get a linear relationship, scale corrections by

$$k' = 1 - (1-k)^{1/n_s},$$

so that the residual becomes $\Delta\mathbf{p}(1-k')^{n_s} = \Delta\mathbf{p}(1-k)$ — linear in $k$ and independent of $n_s$. The resulting material stiffness still depends on the time step; real-time applications usually use a fixed step, so this is not an issue there.

### 3.4. Collision Detection and Response

Collision response is simple in this framework. Line (8) generates the $M_{coll}$ collision constraints from scratch each step (the first $M$ are fixed); their number varies with the number of colliding vertices. Both continuous and static collisions are supported.

- **Continuous:** for each vertex $i$ test the ray $\mathbf{x}_i \to \mathbf{p}_i$. If it enters an object, compute the entry point $\mathbf{q}_c$ and surface normal $\mathbf{n}_c$ there and add an *inequality* constraint $C(\mathbf{p}) = (\mathbf{p} - \mathbf{q}_c) \cdot \mathbf{n}_c$ with stiffness $k = 1$.
- **Static fallback:** if the whole ray lies inside an object, continuous detection failed at some earlier point. Then compute the closest surface point $\mathbf{q}_s$ to $\mathbf{p}_i$ with normal $\mathbf{n}_s$ and add the inequality constraint $C(\mathbf{p}) = (\mathbf{p} - \mathbf{q}_s) \cdot \mathbf{n}_s$ with $k = 1$.

Generating collision constraints outside the solver loop is much faster. With a fixed collision constraint set some collisions can be missed during solving, but in the authors' experience the artifacts are negligible.

**Friction and restitution** are applied to velocities in step (16): each vertex that received a collision constraint has its velocity damped perpendicular to the collision normal and reflected along it.

The above is only correct against static objects, since no impulse reaches the collision partner. Correct two-way response between dynamic objects is obtained by simulating both with this solver — the $N$ vertices and $M$ constraints then simply describe two or more independent objects. If a point $\mathbf{q}$ of one object moves through a triangle $\mathbf{p}_1,\mathbf{p}_2,\mathbf{p}_3$ of another, an *inequality* constraint

$$C(\mathbf{q},\mathbf{p}_1,\mathbf{p}_2,\mathbf{p}_3) = \pm(\mathbf{q} - \mathbf{p}_1)\cdot[(\mathbf{p}_2 - \mathbf{p}_1)\times(\mathbf{p}_3 - \mathbf{p}_1)]$$

keeps $\mathbf{q}$ on the correct side. Being invariant to rigid-body modes, it conserves linear and angular momentum. Detection is harder because all four vertices move along rays $\mathbf{x}_i \to \mathbf{p}_i$, so moving point vs. moving triangle must be tested (see cloth self collision).

### 3.5. Damping

Line (6) damps velocities before they are used for prediction. Any damping scheme works [NMK*05]; the paper proposes one with useful properties:

```text
(1) x_cm = (Σ_i x_i m_i) / (Σ_i m_i)
(2) v_cm = (Σ_i v_i m_i) / (Σ_i m_i)
(3) L = Σ_i r_i × (m_i v_i)
(4) I = Σ_i r̃_i r̃_i^T m_i
(5) ω = I^{-1} L
(6) forall vertices i
(7)     Δv_i = v_cm + ω × r_i − v_i
(8)     v_i <- v_i + k_damping Δv_i
(9) endfor
```

Here $\mathbf{r}_i = \mathbf{x}_i - \mathbf{x}_{cm}$, $\tilde{\mathbf{r}}_i$ is the $3\times3$ cross-product matrix with $\tilde{\mathbf{r}}_i \mathbf{v} = \mathbf{r}_i \times \mathbf{v}$, and $k_{damping} \in [0 \dots 1]$ is the damping coefficient. Lines (1)–(5) compute the global linear velocity $\mathbf{v}_{cm}$ and angular velocity $\boldsymbol{\omega}$; lines (6)–(9) damp only each vertex's deviation $\Delta\mathbf{v}_i$ from the global motion $\mathbf{v}_{cm} + \boldsymbol{\omega}\times\mathbf{r}_i$. With $k_{damping} = 1$ only the global motion survives and the vertex set moves like a rigid body; for other values velocities are damped globally **without affecting the global motion**.

(Note: as printed, line (4) reads $\mathbf{I} = \sum_i \tilde{\mathbf{r}}_i \tilde{\mathbf{r}}_i^T m_i$; since $\tilde{\mathbf{r}}^T = -\tilde{\mathbf{r}}$ this equals the usual inertia tensor $\sum_i m_i(|\mathbf{r}_i|^2\mathbf{I}_3 - \mathbf{r}_i\mathbf{r}_i^T)$.)

### 3.6. Attachments

Attaching vertices to static or kinematic objects is trivial with positions: the vertex position is set to the static target, or updated every step to coincide with the kinematic object. To keep other constraints from moving it, its inverse mass $w_i$ is set to zero.

> Figure 4: Bending resistance uses $C(\mathbf{p}_1,\mathbf{p}_2,\mathbf{p}_3,\mathbf{p}_4) = \arccos(\mathbf{n}_1\cdot\mathbf{n}_2) - \varphi_0$. The actual dihedral angle $\varphi$ is the angle between the normals $\mathbf{n}_1,\mathbf{n}_2$ of the two triangles sharing edge $\mathbf{p}_1\mathbf{p}_2$.

> Figure 5: Constraint $C(\mathbf{q},\mathbf{p}_1,\mathbf{p}_2,\mathbf{p}_3) = (\mathbf{q} - \mathbf{p}_1)\cdot\mathbf{n} - h$ keeps $\mathbf{q}$ above triangle $\mathbf{p}_1\mathbf{p}_2\mathbf{p}_3$ by the cloth thickness $h$.

## 4. Cloth Simulation

The framework was used to build a real-time cloth simulator for games; this section gives cloth-specific, concrete instances of the general concepts.

### 4.1. Representation of Cloth

Input is any manifold triangle mesh (each edge shared by at most two triangles); every mesh node becomes a simulated vertex. The user gives a density $\rho$ in mass per area [kg/m²]; a vertex's mass is the sum of one third of the mass of each adjacent triangle.

For every edge a **stretching** constraint is created:

$$C_{stretch}(\mathbf{p}_1,\mathbf{p}_2) = |\mathbf{p}_1 - \mathbf{p}_2| - l_0,$$

stiffness $k_{stretch}$, type *equality*; $l_0$ is the initial edge length and $k_{stretch}$ a global user parameter for stretch stiffness.

For every pair of adjacent triangles $(\mathbf{p}_1,\mathbf{p}_3,\mathbf{p}_2)$ and $(\mathbf{p}_1,\mathbf{p}_2,\mathbf{p}_4)$ a **bending** constraint is created:

$$C_{bend}(\mathbf{p}_1,\mathbf{p}_2,\mathbf{p}_3,\mathbf{p}_4) = \arccos\left(\frac{(\mathbf{p}_2 - \mathbf{p}_1)\times(\mathbf{p}_3 - \mathbf{p}_1)}{|(\mathbf{p}_2 - \mathbf{p}_1)\times(\mathbf{p}_3 - \mathbf{p}_1)|}\cdot\frac{(\mathbf{p}_2 - \mathbf{p}_1)\times(\mathbf{p}_4 - \mathbf{p}_1)}{|(\mathbf{p}_2 - \mathbf{p}_1)\times(\mathbf{p}_4 - \mathbf{p}_1)|}\right) - \varphi_0,$$

stiffness $k_{bend}$, type *equality*; $\varphi_0$ is the initial dihedral angle and $k_{bend}$ a global bending stiffness (Figure 4). Compared with a distance constraint between $\mathbf{p}_3$ and $\mathbf{p}_4$, or the [GHDS03] bending term, this one is **independent of stretching** because it does not depend on edge lengths — e.g. low stretch stiffness with high bending resistance is possible (Figure 3).

Eqs. (10)–(11) project stretching; Appendix A derives the bending projection.

### 4.2. Collision with Rigid Bodies

Handled as in Section 3.4. For two-way coupling, whenever vertex $i$ is projected because of a collision with a rigid body, the impulse $m_i\Delta\mathbf{p}_i/\Delta t$ is applied to that body at the contact point. Testing only cloth vertices is insufficient — small rigid bodies can slip through large cloth triangles — so the convex corners of rigid bodies are also tested against cloth triangles.

### 4.3. Self Collision

Assuming roughly uniform triangle size, spatial hashing [THM*03] finds vertex–triangle collisions. If vertex $\mathbf{q}$ moves through triangle $\mathbf{p}_1,\mathbf{p}_2,\mathbf{p}_3$, use

$$C(\mathbf{q},\mathbf{p}_1,\mathbf{p}_2,\mathbf{p}_3) = (\mathbf{q} - \mathbf{p}_1)\cdot\frac{(\mathbf{p}_2 - \mathbf{p}_1)\times(\mathbf{p}_3 - \mathbf{p}_1)}{|(\mathbf{p}_2 - \mathbf{p}_1)\times(\mathbf{p}_3 - \mathbf{p}_1)|} - h, \tag{12}$$

where $h$ is the cloth thickness (Figure 5). If the vertex comes from below relative to the triangle normal, use instead

$$C(\mathbf{q},\mathbf{p}_1,\mathbf{p}_2,\mathbf{p}_3) = (\mathbf{q} - \mathbf{p}_1)\cdot\frac{(\mathbf{p}_3 - \mathbf{p}_1)\times(\mathbf{p}_2 - \mathbf{p}_1)}{|(\mathbf{p}_3 - \mathbf{p}_1)\times(\mathbf{p}_2 - \mathbf{p}_1)|} - h \tag{13}$$

so it stays on its original side. These projections conserve linear and angular momentum, which matters for self collision because it is an internal process. Figure 6 shows a self-colliding cloth at rest. Continuous tests are not enough once cloth is tangled; untangling methods such as [BWK03] are then required.

### 4.4. Cloth Balloons

For closed meshes, overpressure is easy to model (Figure 7) with one *equality* constraint over all $N$ vertices:

$$C(\mathbf{p}_1,\dots,\mathbf{p}_N) = \left(\sum_{i=1}^{n_{triangles}} \left(\mathbf{p}_{t_1^i}\times\mathbf{p}_{t_2^i}\right)\cdot\mathbf{p}_{t_3^i}\right) - k_{pressure}V_0 \tag{14}$$

with stiffness $k = 1$, where $t_1^i, t_2^i, t_3^i$ are the vertex indices of triangle $i$. The sum is (proportional to) the current enclosed volume, compared against the original volume $V_0$ times the overpressure factor $k_{pressure}$. Its gradients are

$$\nabla_{\mathbf{p}_i} C = \sum_{j:\,t_1^j = i}\left(\mathbf{p}_{t_2^j}\times\mathbf{p}_{t_3^j}\right) + \sum_{j:\,t_2^j = i}\left(\mathbf{p}_{t_3^j}\times\mathbf{p}_{t_1^j}\right) + \sum_{j:\,t_3^j = i}\left(\mathbf{p}_{t_1^j}\times\mathbf{p}_{t_2^j}\right), \tag{15}$$

which are scaled by Eq. (7) and mass-weighted per Eq. (9) to obtain $\Delta\mathbf{p}_i$.

> Figure 3: With the proposed bending term, bending and stretching are independent. Top row: $(k_{stretch}, k_{bend}) = (1,1), (\tfrac12,1), (\tfrac1{100},1)$. Bottom row: $(1,0), (\tfrac12,0), (\tfrac1{100},0)$.

> Figure 6: A folded configuration showing stable self collision and response.

> Figure 7: Overpressure inside a character mesh.

## 5. Results

The method was integrated into *Rocket* [Rat04], a game-like physics test environment. All scenes ran on a 3 GHz Pentium 4.

**Independent bending and stretching.** Because bending depends only on the dihedral angle, the two resistances can be set independently. Figure 3 shows a cloth bag at several stretch stiffnesses, with and without bending; bending does not change stretch resistance.

**Attachments with two-way interaction.** Both one-way and two-way attachment constraints are supported. In Figure 8 cloth stripes hang from static rigid bodies via one-way constraints and are coupled two-way to rigid bodies at the bottom, producing believable swing and twist. The scene (6 rigid bodies, 3 cloth pieces) simulates and renders at over 380 fps.

> Figure 8: Cloth stripes attached one-way to static rigid bodies at the top and two-way to rigid bodies at the bottom.

**Real-time self collision.** The cloth of Figure 6 has 1364 vertices and 2562 triangles and runs at 30 fps on average including self-collision detection, collision handling and rendering. Figure 9 shows friction: the same cloth tumbling inside a rotating barrel.

**Tearing and stability.** Figure 10: a cloth of 4264 vertices and 8262 triangles is torn by an attached cube and finally ripped by a thrown ball, at 47 fps on average. Tearing rule: when an edge's stretch exceeds a threshold, pick one of its vertices, put a split plane through it perpendicular to the edge, and split the vertex — triangles above the plane keep the original vertex, those below get the duplicate. The method stays stable in extreme cases such as Figure 1 (inspired by [ITF04]): an inflated character squeezed through rotating gears, with many constraints, collisions and self collisions acting on single vertices.

**Complex scenes.** The method suits complex environments (Figure 12): even with heavy interaction with animated characters and complex levels, several cloth pieces simulate and render interactively.

> Figure 9: Under collision, self collision and friction, a cloth tumbles in a rotating barrel.

> Figure 10: A cloth torn open by an attached cube and ripped apart by a thrown ball.

> Figure 11: Three inflated characters undergoing multiple collisions and self collisions.

> Figure 12: Heavy interaction between cloth and an animated game character (left), a geometrically complex game level (middle), and hundreds of simulated plant leaves (right).

## 6. Conclusions

A position based dynamics framework handling general constraints expressed as constraint functions was presented. Acting on positions lets objects be manipulated directly during simulation, greatly simplifying collisions, attachment constraints and explicit integration, and giving direct, immediate control over the animated scene. A robust cloth simulator built on it supports two-way cloth/rigid interaction, cloth self collision and response, and attaching cloth to dynamic rigid bodies.

## 7. Future Work

Rigid-body simulation was not covered but should extend easily: instead of computing linear and angular impulses at contacts as usual rigid solvers do, translations and rotations would be applied to the bodies at the contact points, and their linear and angular velocities adjusted accordingly once the solver has finished.

## Appendix A

### Gradient of the Normalized Cross Product

Constraint functions often contain normalised cross products, so the gradient of $\mathbf{n} = \frac{\mathbf{p}_1\times\mathbf{p}_2}{|\mathbf{p}_1\times\mathbf{p}_2|}$ with respect to both arguments is useful. With respect to the first vector:

$$\frac{\partial\mathbf{n}}{\partial\mathbf{p}_1} = \begin{pmatrix} \frac{\partial n_x}{\partial p_{1x}} & \frac{\partial n_x}{\partial p_{1y}} & \frac{\partial n_x}{\partial p_{1z}} \\ \frac{\partial n_y}{\partial p_{1x}} & \frac{\partial n_y}{\partial p_{1y}} & \frac{\partial n_y}{\partial p_{1z}} \\ \frac{\partial n_z}{\partial p_{1x}} & \frac{\partial n_z}{\partial p_{1y}} & \frac{\partial n_z}{\partial p_{1z}} \end{pmatrix} \tag{16}$$

$$= \frac{1}{|\mathbf{p}_1\times\mathbf{p}_2|}\left(\begin{pmatrix} 0 & p_{2z} & -p_{2y} \\ -p_{2z} & 0 & p_{2x} \\ p_{2y} & -p_{2x} & 0 \end{pmatrix} + \mathbf{n}(\mathbf{n}\times\mathbf{p}_2)^T\right) \tag{17}$$

More compactly, for both arguments:

$$\frac{\partial\mathbf{n}}{\partial\mathbf{p}_1} = \frac{1}{|\mathbf{p}_1\times\mathbf{p}_2|}\left(-\tilde{\mathbf{p}}_2 + \mathbf{n}(\mathbf{n}\times\mathbf{p}_2)^T\right) \tag{18}$$

$$\frac{\partial\mathbf{n}}{\partial\mathbf{p}_2} = -\frac{1}{|\mathbf{p}_1\times\mathbf{p}_2|}\left(-\tilde{\mathbf{p}}_1 + \mathbf{n}(\mathbf{n}\times\mathbf{p}_1)^T\right) \tag{19}$$

where $\tilde{\mathbf{p}}$ is the matrix with

$$\tilde{\mathbf{p}}\,\mathbf{x} = \mathbf{p}\times\mathbf{x}. \tag{20}$$

### Bending Constraint Projection

The bending constraint is $C = \arccos(d) - \varphi_0$ with $d = \mathbf{n}_1\cdot\mathbf{n}_2 = \mathbf{n}_1^T\mathbf{n}_2$. Without loss of generality set $\mathbf{p}_1 = \mathbf{0}$, so the normals are $\mathbf{n}_1 = \frac{\mathbf{p}_2\times\mathbf{p}_3}{|\mathbf{p}_2\times\mathbf{p}_3|}$ and $\mathbf{n}_2 = \frac{\mathbf{p}_2\times\mathbf{p}_4}{|\mathbf{p}_2\times\mathbf{p}_4|}$. Using $\frac{d}{dx}\arccos(x) = -\frac{1}{\sqrt{1-x^2}}$, the gradients are `[reconstructed]` (extraction garbled; standard published form):

$$\nabla_{\mathbf{p}_3} C = -\frac{1}{\sqrt{1-d^2}}\left(\left(\frac{\partial\mathbf{n}_1}{\partial\mathbf{p}_3}\right)^T\mathbf{n}_2\right) \tag{21}$$

$$\nabla_{\mathbf{p}_4} C = -\frac{1}{\sqrt{1-d^2}}\left(\left(\frac{\partial\mathbf{n}_2}{\partial\mathbf{p}_4}\right)^T\mathbf{n}_1\right) \tag{22}$$

$$\nabla_{\mathbf{p}_2} C = -\frac{1}{\sqrt{1-d^2}}\left(\left(\frac{\partial\mathbf{n}_1}{\partial\mathbf{p}_2}\right)^T\mathbf{n}_2 + \left(\frac{\partial\mathbf{n}_2}{\partial\mathbf{p}_2}\right)^T\mathbf{n}_1\right) \tag{23}$$

$$\nabla_{\mathbf{p}_1} C = -\nabla_{\mathbf{p}_2} C - \nabla_{\mathbf{p}_3} C - \nabla_{\mathbf{p}_4} C \tag{24}$$

With the normalised-cross-product gradients, first compute

$$\mathbf{q}_3 = \frac{\mathbf{p}_2\times\mathbf{n}_2 + (\mathbf{n}_1\times\mathbf{p}_2)\,d}{|\mathbf{p}_2\times\mathbf{p}_3|} \tag{25}$$

$$\mathbf{q}_4 = \frac{\mathbf{p}_2\times\mathbf{n}_1 + (\mathbf{n}_2\times\mathbf{p}_2)\,d}{|\mathbf{p}_2\times\mathbf{p}_4|} \tag{26}$$

$$\mathbf{q}_2 = -\frac{\mathbf{p}_3\times\mathbf{n}_2 + (\mathbf{n}_1\times\mathbf{p}_3)\,d}{|\mathbf{p}_2\times\mathbf{p}_3|} - \frac{\mathbf{p}_4\times\mathbf{n}_1 + (\mathbf{n}_2\times\mathbf{p}_4)\,d}{|\mathbf{p}_2\times\mathbf{p}_4|} \tag{27}$$

$$\mathbf{q}_1 = -\mathbf{q}_2 - \mathbf{q}_3 - \mathbf{q}_4 \tag{28}$$

and the final correction is

$$\Delta\mathbf{p}_i = -\frac{w_i\sqrt{1-d^2}\,\left(\arccos(d) - \varphi_0\right)}{\sum_j w_j|\mathbf{q}_j|^2}\,\mathbf{q}_i. \tag{29}$$

## References

Reference list body omitted. Works cited here that matter for this repo:

- [Jak01] T. Jakobsen, *Advanced Character Physics* (Fysix engine), Gamasutra 2001 — Verlet + distance-constraint projection; Eqs. (10)–(11).
- [MHTG05] M. Müller, B. Heidelberger, M. Teschner, M. Gross, *Meshless Deformations Based on Shape Matching*, SIGGRAPH 2005 — the shape-matching kernel this repo uses.
- [Pro95] X. Provot, *Deformation constraints in a mass-spring model to describe rigid cloth behavior*, Graphics Interface 1995 — projection as a post-pass on over-stretched springs.
- [DSB99] M. Desbrun, P. Schröder, A. Barr, *Interactive animation of structured deformable objects*, GI 1999.
- [BW98] D. Baraff, A. Witkin, *Large steps in cloth simulation*, SIGGRAPH 1998 — constraint-function formulation.
- [THMG04] M. Teschner, B. Heidelberger, M. Müller, M. Gross, *A versatile and robust model for geometrically complex deformable solids*, CGI 2004.
- [THM*03] M. Teschner et al., *Optimized spatial hashing for collision detection of deformable objects*, VMV 2003.
- [NMK*05] A. Nealen, M. Müller, R. Keiser, E. Boxerman, M. Carlson, *Physically based deformable models in computer graphics*, Eurographics STAR 2005.

## Slides

The talk slides (same authors) mostly restate the paper; additions beyond it:

**Motivation (games: *Cell Factor*, *Bet on Soldier*).** For explicit Euler $\mathbf{v}^{t+1} = \mathbf{v}^t + \mathbf{f}/m\,\Delta t$, $\mathbf{x}^{t+1} = \mathbf{x}^t + \mathbf{v}^{t+1}\Delta t$: accuracy is "no issue in a game", stability is "a big issue in a game".

**Overshooting.** Explicit $\mathbf{x}(t+\Delta t) = \mathbf{x}(t) + \mathbf{v}(t)\Delta t$ versus the true $\mathbf{x}(t) + \int_t^{t+\Delta t}\mathbf{v}(t)\,dt$: errors show up as *outward spin* (orbits spiral out) and *amplitude build-up* (oscillators gain energy).

**Three update styles compared.**

| Style | Pipeline | Pros | Cons |
|---|---|---|---|
| Force based | penetration → forces → change velocities → change positions | — | needs overlap; reaction lag; strong force → stiff system, overshooting; weak force → squishy system |
| Velocity (impulse) based | penetration detection only → change velocities so objects separate → positions | controlled velocity change; only as much as needed → no overshooting | drift: consistent velocities do not guarantee consistent positions |
| Position based | penetration detection only → move objects so they do not penetrate → update velocities | controlled position change; only as much as needed → no overshooting; no drift | a velocity update is needed to keep a 2nd-order system |

**Verlet derivation.** Taylor expansions

$$\mathbf{x}(t+\Delta t) = \mathbf{x}(t) + \dot{\mathbf{x}}(t)\Delta t + \tfrac12\ddot{\mathbf{x}}(t)\Delta t^2 + \tfrac16\dddot{\mathbf{x}}(t)\Delta t^3 + O(\Delta t^4)$$
$$\mathbf{x}(t-\Delta t) = \mathbf{x}(t) - \dot{\mathbf{x}}(t)\Delta t + \tfrac12\ddot{\mathbf{x}}(t)\Delta t^2 - \tfrac16\dddot{\mathbf{x}}(t)\Delta t^3 + O(\Delta t^4)$$

sum to $\mathbf{x}(t+\Delta t) = 2\mathbf{x}(t) - \mathbf{x}(t-\Delta t) + \mathbf{a}(t)\Delta t^2 + O(\Delta t^4) = \mathbf{x}(t) + [\mathbf{x}(t) - \mathbf{x}(t-\Delta t)] + \mathbf{a}(t)\Delta t^2 + O(\Delta t^4)$; the bracket is the velocity stored implicitly in the previous position.

**Position based integration as "Verlet plus corrections"** (slide pseudocode, reconstructed from a garbled table `[reconstructed]`):

```text
Init:  x(0), v(0)
Loop:
    p        = x(t) + Δt·v(t)                // prediction
    modify p                                  // position correction (constraints, collisions)
    v(t+Δt)  = (p − x(t)) / Δt                // velocity update
    x(t+Δt)  = p
    modify v(t+Δt)                            // velocity correction
End loop
```

The slide stresses that **corrections change the dynamic state** — position corrections feed back into velocity through the update line.

**Position correction** examples: move vertices out of other objects; move vertices so constraints hold (illustrated with a particle constrained to a circle: prediction → projection → new velocity).

**Velocity correction** covers: external forces $\mathbf{v}(t+\Delta t) = \mathbf{v}^p(t+\Delta t) + \Delta t\,\mathbf{f}(t)/m$; internal damping; friction; restitution (illustrated: collision correction, then friction/restitution correction of the old velocity into the new one).

**General internal constraints** (same derivation as Sec. 3.3, summarised): $C(\mathbf{p}) = 0$ is the scalar constraint; find $\Delta\mathbf{p}$ with $C(\mathbf{p}+\Delta\mathbf{p}) = 0$, linearise $C(\mathbf{p}+\Delta\mathbf{p}) \approx C(\mathbf{p}) + \nabla_{\mathbf{p}}C(\mathbf{p})\cdot\Delta\mathbf{p} = 0$; rigid-body modes do not change $C$, so search perpendicular to them, $\Delta\mathbf{p} = \lambda\nabla_{\mathbf{p}}C(\mathbf{p})$, giving $\Delta\mathbf{p} = -\frac{C(\mathbf{p})}{|\nabla_{\mathbf{p}}C(\mathbf{p})|^2}\nabla_{\mathbf{p}}C(\mathbf{p})$ — this does not influence rigid-body modes (no ghost forces). With masses: $\Delta\mathbf{p}_i = -s\,n\,w_i\nabla_{\mathbf{p}_i}C$ with $s = \frac{C}{\sum_j w_j|\nabla_{\mathbf{p}_j}C|^2}$ `[reconstructed: the slide shows an extra factor n·w_i; with the paper's normalised weights this is Eq. (9)]`.

**Constraint examples on the slides:** stretch $C(\mathbf{p}_1,\mathbf{p}_2) = |\mathbf{p}_1-\mathbf{p}_2| - d$ (→ Jakobsen); bending (dihedral arccos form as in Sec. 4.1); and a **tetrahedral volume** constraint not spelled out in the paper:

$$C_{volume}(\mathbf{p}_1,\mathbf{p}_2,\mathbf{p}_3,\mathbf{p}_4) = [(\mathbf{p}_2-\mathbf{p}_1)\times(\mathbf{p}_3-\mathbf{p}_1)]\cdot(\mathbf{p}_4-\mathbf{p}_1) - v_0.$$

**Position solver remarks:** non-linear Gauss–Seidel; iterate over all constraints, projecting points per constraint. Caveats listed explicitly: Gauss–Seidel is **order dependent**; the **last constraints are strongest**; projection is a non-linear step; it **takes time for pressure waves to propagate** through objects.

Remaining slides (Results, Conclusions / Future Work) are image-only and add nothing textual beyond the paper.
