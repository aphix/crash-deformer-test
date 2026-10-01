# XPBD: Position-Based Simulation of Compliant Constrained Dynamics

**Authors:** Miles Macklin, Matthias Müller, Nuttapong Chentanez (NVIDIA)
**Venue:** MIG '16 (ACM SIGGRAPH Conference on Motion in Games), October 10–12, 2016, Burlingame, CA, USA. DOI: [10.1145/2994258.2994272](http://dx.doi.org/10.1145/2994258.2994272)

> This is a paraphrased, section-by-section rewrite. Equations, algorithm, parameters and table values are reproduced; prose is condensed in our own words. Equations marked `[reconstructed]` were rebuilt from context because PDF extraction mangled them; they match the standard published XPBD formulation.

> Figure 1: A deformable body whose volume-conservation stiffness is varied relative to its stretch/shear stiffness. Unlike plain PBD, XPBD lets the author set these stiffnesses independently of time step and iteration count, which makes assets much easier to author.

## Abstract

PBD has a long-standing flaw: how stiff a constraint behaves depends on the time step and on how many solver iterations are run. The authors add a small extension to PBD that lets it simulate arbitrary elastic and dissipative energy potentials implicitly and accurately. As a by-product the method yields estimates of constraint forces, which opens PBD to uses such as haptic feedback. Compared against costlier non-linear (Newton) solvers, it looks visually similar while keeping PBD's simplicity and robustness.

**Keywords:** physics simulation, constrained dynamics, position based dynamics
**CCS Concepts:** Computing methodologies → Real-time simulation; Interactive simulation

## 1 Introduction

Position-Based Dynamics [Müller et al. 2007] is widely used for real-time deformables in games and, increasingly, in film and medical simulation, because it is simple and robust.

Its best-known weakness is that behaviour depends on time step and iteration count [Bender et al. 2014b]: constraints get stiffer without bound as iterations increase or as the step shrinks. This is painful in scenes mixing materials (e.g. soft bodies touching nearly rigid ones): raising iterations to stiffen one object silently changes every other object, forcing global retuning and making reusable assets hard to build. Even within one asset — e.g. the stretch-vs-bend ratio in cloth — the problem appears, and because the iteration dependence is non-linear, stiffness cannot simply be rescaled as a function of iteration count.

VR raises the bar for physically representative real-time simulation, and haptic devices need accurate force estimates. PBD has no well-defined notion of constraint force, so it has mostly been used where accuracy matters less than speed.

The paper presents **XPBD** (extended PBD). A new constraint formulation corresponds to a well-defined elastic potential energy; it is derived from an implicit time discretisation that introduces a **total Lagrange multiplier** per constraint, which also gives constraint force estimates usable for force-dependent effects and devices.

Contributions:

- PBD constraints that correspond directly to well-defined elastic and dissipation potentials.
- A total Lagrange multiplier in PBD, so constraints are solved independently of time step and iteration count.
- Validation against a reference implicit integrator using a non-linear Newton solver.

## 2 Related Work

Constrained dynamics in graphics is a large field [Nealen et al. 2005]. XPBD builds on PBD [Müller et al. 2007], which projects constraints at the position level with Gauss–Seidel iteration; Stam [2009] proposed a comparable Gauss–Seidel solver at the velocity level. Both are local, efficient and easy to implement, but both have iteration-dependent stiffness.

PBD has been applied widely to deformables. Bender et al. [2014a] use strain energy directly as a constraint; Müller et al. [2014] constrain entries of the Green–St Venant strain tensor so strain can be controlled along directions independent of the discretisation. Shape matching [Müller et al. 2005] gives a geometric constraint suited to PBD. All of these share the strong iteration-count dependence. XPBD's compliant constraints instead map onto traditional constitutive models and converge to a well-defined solution.

Servin et al. [2006] formulated continuum models as compliant constraints with a semi-implicit, velocity-level integrator that handles a wide stiffness range independent of time step. XPBD transfers that compliant formulation to the position level, without extra stabilisation terms.

Global approaches: Goldenthal et al. [2007] enforce inextensibility by globally linearising and directly solving each iteration ("Fast Projection"); XPBD can be seen as a compliant version of it, solved with Gauss–Seidel. Tournier et al. [2015] add second-order derivative information to compliant constraints to avoid linearisation instabilities; XPBD uses only first derivatives and sidesteps global-linearisation instability by relinearising locally many times per step.

Liu et al. [2013] use a local/global split for mass-spring systems (local solve for directions, pre-factored global solve for stretch); stiffness is largely iteration independent and converges toward Newton. Projective Dynamics [Bouaziz et al. 2014] generalises this; Wang [2015] accelerates it with a Chebyshev scheme; Narain et al. [2016] use ADMM for implicit integration, supporting non-linear materials and hard constraints, and show Projective Dynamics is a special case of ADMM.

Those global methods usually depend on pre-factoring a global matrix, which must be refactored when topology changes (tearing, fracture) — expensive — and they are considerably more complex to implement than PBD.

## 3 Background

(See the survey by Bender et al. [2014b] for detail.) PBD is a semi-implicit Störmer–Verlet step followed by several constraint projections. Each projection linearises one constraint locally and applies a mass-weighted correction:

$$\Delta\mathbf{x} = k_j\, s_j\, \mathbf{M}^{-1}\nabla C_j(\mathbf{x}_i)^T \tag{1}$$

Subscript $i$ is the iteration index, $j$ the constraint index, and $k_j \in [0,1]$ a stiffness that simply scales each correction. The scale $s_j$ comes from one Newton step on the constraint function:

$$s_j = \frac{-C_j(\mathbf{x}_i)}{\nabla C_j\, \mathbf{M}^{-1}\nabla C_j^T} \tag{2}$$

Scaling the correction by $k$ makes the *effective* stiffness depend on both time step and number of projections. Müller et al. [2007] tried to compensate with an exponential rescaling of $k$, but that ignores the time step and has no well-defined converged solution when several constraints interact.

The following section builds regularised constraints tied to well-defined energy potentials and shows how to solve them independently of time step and iteration count.

### Algorithm 1 — XPBD simulation loop

```text
 1: predict position   x̃ ⇐ xⁿ + Δt vⁿ + Δt² M⁻¹ f_ext(xⁿ)
 2:
 3: initialize solve     x₀ ⇐ x̃
 4: initialize multipliers λ₀ ⇐ 0
 5: while i < solverIterations do
 6:   for all constraints do
 7:     compute Δλ using Eq (18)
 8:     compute Δx using Eq (17)
 9:     update λ_{i+1} ⇐ λ_i + Δλ
10:     update x_{i+1} ⇐ x_i + Δx
11:   end for
12:   i ⇐ i + 1
13: end while
14:
15: update positions  x^{n+1} ⇐ x_i
16: update velocities v^{n+1} ⇐ (1/Δt)(x^{n+1} − xⁿ)
```

Compared with PBD only lines 4, 7 and 9 are new.

## 4 Our Method

Start from Newton's equations of motion with forces from an energy potential $U(\mathbf{x})$:

$$\mathbf{M}\ddot{\mathbf{x}} = -\nabla U^T(\mathbf{x}) \tag{3}$$

$\mathbf{x} = [x_1, x_2, \dots, x_n]^T$ is the system state — usually particle positions in PBD, but it may be any generalised coordinates (e.g. rigid-body transforms). The gradient $\nabla$ is taken as a *row* vector of partial derivatives.

Discretise (3) implicitly at the position level ($n$ = time-step index):

$$\mathbf{M}\left(\frac{\mathbf{x}^{n+1} - 2\mathbf{x}^n + \mathbf{x}^{n-1}}{\Delta t^2}\right) = -\nabla U^T(\mathbf{x}^{n+1}) \tag{4}$$

Write the energy through a vector of constraint functions $\mathbf{C} = [C_1(\mathbf{x}), C_2(\mathbf{x}), \dots, C_m(\mathbf{x})]^T$:

$$U(\mathbf{x}) = \tfrac{1}{2}\,\mathbf{C}(\mathbf{x})^T \boldsymbol{\alpha}^{-1}\mathbf{C}(\mathbf{x}) \tag{5}$$

$\boldsymbol{\alpha}$ is a block-diagonal **compliance** (inverse stiffness) matrix. The elastic force is the negative gradient:

$$\mathbf{f}_{elastic} = -\nabla_{\mathbf{x}} U^T = -\nabla\mathbf{C}^T\boldsymbol{\alpha}^{-1}\mathbf{C} \tag{6}$$

Following Servin et al. [2006], split the force into a direction and a scalar part by introducing Lagrange multipliers:

$$\boldsymbol{\lambda}_{elastic} = -\tilde{\boldsymbol{\alpha}}^{-1}\mathbf{C}(\mathbf{x}) \tag{7}$$

where $\boldsymbol{\lambda}_{elastic} = [\lambda_1, \lambda_2, \dots, \lambda_m]^T$ (the subscript is dropped from here on). The $\Delta t^2$ from the left side of (4) is absorbed into the compliance:

$$\tilde{\boldsymbol{\alpha}} = \frac{\boldsymbol{\alpha}}{\Delta t^2}$$

Substituting gives the discrete constrained equations of motion:

$$\mathbf{M}(\mathbf{x}^{n+1} - \tilde{\mathbf{x}}) - \nabla\mathbf{C}(\mathbf{x}^{n+1})^T\boldsymbol{\lambda}^{n+1} = \mathbf{0} \tag{8}$$

$$\mathbf{C}(\mathbf{x}^{n+1}) + \tilde{\boldsymbol{\alpha}}\boldsymbol{\lambda}^{n+1} = \mathbf{0} \tag{9}$$

with the *predicted* (inertial) position $\tilde{\mathbf{x}} = 2\mathbf{x}^n - \mathbf{x}^{n-1} = \mathbf{x}^n + \Delta t\,\mathbf{v}^n$.

This non-linear system is solved by a Newton-style fixed-point iteration. Dropping the superscript $n+1$ and indexing iterations by $i$, call (8) $\mathbf{g}$ and (9) $\mathbf{h}$; we seek $\mathbf{x},\boldsymbol{\lambda}$ with

$$\mathbf{g}(\mathbf{x},\boldsymbol{\lambda}) = \mathbf{0} \tag{10}$$
$$\mathbf{h}(\mathbf{x},\boldsymbol{\lambda}) = \mathbf{0} \tag{11}$$

Linearising gives the Newton subproblem

$$\begin{bmatrix} \mathbf{K} & -\nabla\mathbf{C}^T(\mathbf{x}_i) \\ \nabla\mathbf{C}(\mathbf{x}_i) & \tilde{\boldsymbol{\alpha}} \end{bmatrix}\begin{bmatrix}\Delta\mathbf{x}\\ \Delta\boldsymbol{\lambda}\end{bmatrix} = -\begin{bmatrix}\mathbf{g}(\mathbf{x}_i,\boldsymbol{\lambda}_i)\\ \mathbf{h}(\mathbf{x}_i,\boldsymbol{\lambda}_i)\end{bmatrix} \tag{12}$$

with $\mathbf{K} = \partial\mathbf{g}/\partial\mathbf{x}$, and updates

$$\boldsymbol{\lambda}_{i+1} = \boldsymbol{\lambda}_i + \Delta\boldsymbol{\lambda} \tag{13}$$
$$\mathbf{x}_{i+1} = \mathbf{x}_i + \Delta\mathbf{x} \tag{14}$$

Any sequence with $|\mathbf{x}_{i+1}-\mathbf{x}_i| \to 0$ and $|\boldsymbol{\lambda}_{i+1}-\boldsymbol{\lambda}_i| \to 0$ satisfies (8, 9). This usually works but may need a line search to be robust, and assembling the system matrix is expensive — above all $\mathbf{K}$, which needs constraint Hessians.

Two approximations simplify things and reconnect to PBD:

1. **$\mathbf{K} \approx \mathbf{M}$.** Drops geometric-stiffness / constraint-Hessian terms, introducing a local error of order $O(\Delta t^2)$. It may alter the convergence rate but not the fixed point or the global error — effectively a quasi-Newton method.
2. **$\mathbf{g}(\mathbf{x}_i,\boldsymbol{\lambda}_i) = \mathbf{0}$.** Exactly true on the first iteration when starting from $\mathbf{x}_0 = \tilde{\mathbf{x}}$, $\boldsymbol{\lambda}_0 = \mathbf{0}$; stays small if constraint gradients change slowly and vanishes when they are constant. The modified system is also the optimality condition of a mass-weighted projection onto the constraint manifold from the current iterate (cf. Goldenthal et al. [2007]), so XPBD can be read as a compliant Fast Projection.

With both approximations the subproblem becomes

$$\begin{bmatrix} \mathbf{M} & -\nabla\mathbf{C}^T(\mathbf{x}_i) \\ \nabla\mathbf{C}(\mathbf{x}_i) & \tilde{\boldsymbol{\alpha}} \end{bmatrix}\begin{bmatrix}\Delta\mathbf{x}\\ \Delta\boldsymbol{\lambda}\end{bmatrix} = -\begin{bmatrix}\mathbf{0}\\ \mathbf{h}(\mathbf{x}_i,\boldsymbol{\lambda}_i)\end{bmatrix} \tag{15}$$

The Schur complement with respect to $\mathbf{M}$ gives a reduced system in $\Delta\boldsymbol{\lambda}$ alone:

$$\left[\nabla\mathbf{C}(\mathbf{x}_i)\,\mathbf{M}^{-1}\nabla\mathbf{C}(\mathbf{x}_i)^T + \tilde{\boldsymbol{\alpha}}\right]\Delta\boldsymbol{\lambda} = -\mathbf{C}(\mathbf{x}_i) - \tilde{\boldsymbol{\alpha}}\boldsymbol{\lambda}_i \tag{16}$$

and the position change is then evaluated directly:

$$\Delta\mathbf{x} = \mathbf{M}^{-1}\nabla\mathbf{C}(\mathbf{x}_i)^T\Delta\boldsymbol{\lambda} \tag{17}$$

Strictly the result no longer solves the implicit equations exactly, but the error is small in practice (quantified in Section 6).

### 4.1 A Gauss–Seidel Update

Solving (16) with Gauss–Seidel, one constraint $j$ at a time, gives the multiplier increment in closed form:

$$\Delta\lambda_j = \frac{-C_j(\mathbf{x}_i) - \tilde{\alpha}_j\lambda_{ij}}{\nabla C_j\,\mathbf{M}^{-1}\nabla C_j^T + \tilde{\alpha}_j} \tag{18}$$

This is the heart of the method: compute $\Delta\lambda_j$ for a constraint, then update positions and multipliers via (17), (13), (14). Algorithm 1 is PBD plus lines 4, 7 and 9.

With $\tilde{\alpha}_j = 0$, (18) reduces exactly to PBD's $s_j$ from (2) — so $s_j$ is really the multiplier increment of an infinitely stiff constraint. With compliance, an extra term shows up in numerator and denominator; it regularises the constraint so the force it can exert is bounded and consistent with the elastic potential (5).

The numerator uses $\lambda_{ij}$, the **total** multiplier of constraint $j$ at iteration $i$. One extra scalar per constraint must be stored and updated alongside positions. That modest overhead yields a total constraint force estimate, which can drive force-dependent effects (e.g. breakable joints) or haptic devices.

## 5 Damping

The implicit integrator already dissipates some energy, but explicit constraint damping is often wanted. Define a Rayleigh dissipation potential

$$D(\mathbf{x},\mathbf{v}) = \tfrac{1}{2}\,\dot{\mathbf{C}}(\mathbf{x})^T\boldsymbol{\beta}\,\dot{\mathbf{C}}(\mathbf{x}) \tag{19}$$
$$\phantom{D(\mathbf{x},\mathbf{v})} = \tfrac{1}{2}\,\mathbf{v}^T\nabla\mathbf{C}^T\boldsymbol{\beta}\,\nabla\mathbf{C}\,\mathbf{v} \tag{20}$$

$\boldsymbol{\beta}$ is block diagonal with the constraint damping coefficients. Unlike compliance it is *not* an inverse quantity: set it like a damping stiffness. In Lagrangian mechanics the dissipative force is the negative gradient of $D$ with respect to velocity:

$$\mathbf{f}_{damp} = -\nabla_{\mathbf{v}} D^T = -\nabla\mathbf{C}^T\boldsymbol{\beta}\,\nabla\mathbf{C}\,\mathbf{v} \tag{21}$$

As for elasticity, pull out the scalar multiplier and fold the time step in:

$$\boldsymbol{\lambda}_{damp} = -\tilde{\boldsymbol{\beta}}\,\nabla\mathbf{C}\,\mathbf{v}, \qquad \tilde{\boldsymbol{\beta}} = \Delta t^2\boldsymbol{\beta} \tag{22}$$

One could solve the damping multiplier separately, but normally only the total force matters, and damping acts along the elastic direction, so the two are merged:

$$\boldsymbol{\lambda} = \boldsymbol{\lambda}_{elastic} + \boldsymbol{\lambda}_{damp} = -\tilde{\boldsymbol{\alpha}}^{-1}\mathbf{C}(\mathbf{x}) - \tilde{\boldsymbol{\beta}}\,\nabla\mathbf{C}\,\mathbf{v} \tag{23}$$

Rearranged into constraint form:

$$\mathbf{h}(\mathbf{x},\boldsymbol{\lambda}) = \mathbf{C}(\mathbf{x}) + \tilde{\boldsymbol{\alpha}}\boldsymbol{\lambda} + \tilde{\boldsymbol{\alpha}}\tilde{\boldsymbol{\beta}}\,\nabla\mathbf{C}\,\mathbf{v} = \mathbf{0} \tag{24}$$

Substituting $\mathbf{v} = (\mathbf{x}^{n+1}-\mathbf{x}^n)/\Delta t$ and linearising in $\Delta\boldsymbol{\lambda}$ gives the updated Newton step:

$$\left[\left(\mathbf{I} + \frac{\tilde{\boldsymbol{\alpha}}\tilde{\boldsymbol{\beta}}}{\Delta t}\right)\nabla\mathbf{C}(\mathbf{x}_i)\,\mathbf{M}^{-1}\nabla\mathbf{C}(\mathbf{x}_i)^T + \tilde{\boldsymbol{\alpha}}\right]\Delta\boldsymbol{\lambda} = -\mathbf{h}(\mathbf{x}_i,\boldsymbol{\lambda}_i) \tag{25}$$

Per constraint, the Gauss–Seidel update becomes

$$\Delta\lambda_j = \frac{-C_j(\mathbf{x}_i) - \tilde{\alpha}_j\lambda_{ij} - \gamma_j\,\nabla C_j(\mathbf{x}_i - \mathbf{x}^n)}{(1+\gamma_j)\,\nabla C_j\,\mathbf{M}^{-1}\nabla C_j^T + \tilde{\alpha}_j} \tag{26}$$

In the common case where $\tilde{\boldsymbol{\alpha}}$ and $\tilde{\boldsymbol{\beta}}$ are plain diagonal (not block diagonal), $\gamma_j = \dfrac{\tilde{\alpha}_j\tilde{\beta}_j}{\Delta t}$ — the constraint's compliance times its damping, scaled by the time step. Every added term is cheap to evaluate.

## 6 Results

The method is tested on several deformable models and constraint types. 2D results use a CPU Gauss–Seidel implementation, validated against a conventional non-linear Newton solver applied directly to the discrete equations of motion (8, 9); the Newton solver uses Eigen's [Guennebaud et al. 2010] robust Cholesky decomposition as its linear solver. 3D results come from a GPU solver with Jacobi-style iteration on an NVIDIA GTX 1070. Collisions are treated exactly as in original PBD: contacts are given zero compliance, so no multiplier is stored for contact constraints.

### 6.1 Spring

A simple harmonic oscillator is modelled as a single distance constraint with rest position $x = 1$, initial position $x_0 = 1.5$, compliance $\alpha = 0.001$ and mass $m = 1$. PBD cannot reproduce the correct oscillation period; runs with 1, 5 and 10 iterations show period and damping both depending strongly on iteration count. In this simple case XPBD closely matches the analytic solution regardless of time step and iteration count. [reconstructed: the extracted text here is truncated; the remaining sentence notes the damping visible in the reference solution, which in an implicit-Euler reference is numerical damping.]

> Figure 2: Harmonic oscillator as a distance constraint with compliance $\alpha = 0.001$ (offset vs. frame, 0–100 frames). Curves: Exact, XPBD, PBD with 1/5/10 iterations. XPBD tracks the analytic solution closely; PBD's result depends heavily on the iteration count.

### 6.2 Chain

To measure how accurate the returned constraint forces are, a weakly extensible chain is simulated: 20 particles, each $m = 1.0$, connected by distance constraints with $\alpha = 10^{-8}$. Over 100 frames the constraint force magnitude at the fixed top particle is recorded and compared with the reference Newton solver. Maximum relative error of XPBD over the run is **6%, 2% and 0.5%** for **50, 100 and 1000** iterations respectively — acceptable for most graphics uses.

> Figure 3: (a) Constraint force magnitude (N) at the fixed support over frames for the chain example: Newton vs. XPBD with 50/100/1000 iterations. (b) Residual error vs. iteration for one frame of the beam example; Gauss–Seidel and Jacobi both converge linearly, as expected of an iterative method.
>
> Figure 4: Time-lapse of a hanging 20-particle chain falling under gravity. Left: reference Newton solver. Right: XPBD with 50 iterations.
>
> Figure 5: Cantilever beam of triangular FEM elements with a linear isotropic constitutive model, simulated for 50 frames. Left: reference Newton solver. Right: XPBD with 20 iterations — visually indistinguishable from the reference.
>
> Figure 6: Hanging cloth with 20, 40, 80 and 160 iterations (left to right). Top row: PBD, whose stiffness changes non-linearly with iteration count. Bottom row: XPBD, whose behaviour is qualitatively unchanged.

### 6.3 Cantilever Beam

Conventional FEM can be recast in the compliant-constraint framework [Servin et al. 2006]. For a linear isotropic material, the strain-tensor entries of each element form a vector of constraint functions; for a triangle in Voigt notation:

$$\mathbf{C}_{tri}(\mathbf{x}) = \boldsymbol{\epsilon}_{tri} = \begin{bmatrix}\epsilon_{xx}\\ \epsilon_{yy}\\ \epsilon_{xy}\end{bmatrix} \tag{27}$$

The compliance matrix is the inverse of the stiffness matrix, written with the Lamé parameters $\lambda, \mu$ as

$$\boldsymbol{\alpha}_{tri} = \mathbf{K}^{-1}, \qquad \mathbf{K} = \begin{bmatrix}\lambda + 2\mu & \lambda & 0\\ \lambda & \lambda + 2\mu & 0\\ 0 & 0 & 2\mu\end{bmatrix} \tag{28}$$

[reconstructed: matrix layout rebuilt from the garbled extraction; it is the standard plane linear-isotropic stiffness in Lamé form.]

Compared with Strain Based Dynamics [Müller et al. 2014], this formulation uses real material parameters and, as a side effect of the implicit discretisation, couples the individual strains correctly, reproducing the Poisson effect. XPBD can therefore simulate materials with parameters taken from measured data.

Accuracy is evaluated on a cantilever beam with a St Venant–Kirchhoff triangular FEM discretisation (Figure 5), linear isotropic material with Young's modulus $E = 10^5$, Poisson ratio $\nu = 0.3$ and $\Delta t = 0.008$, run for 50 frames. 20 XPBD iterations are enough to be visually indistinguishable from the Newton reference; the residual per iteration is plotted in Figure 3b.

### 6.4 Cloth

Iteration-count independence is tested on hanging cloth under gravity: a $64\times64$ particle grid linked by a graph of about 24k distance constraints. Constraint stiffness is held fixed while the iteration count varies (Figure 6). With PBD the cloth becomes steadily stiffer and more heavily damped as iterations increase; with XPBD the behaviour stays consistent. To make PBD's change obvious, an artificially low stiffness $k = 0.01$ is used. XPBD does **not** converge faster than PBD — it simply behaves the same at different iteration counts; at zero compliance it is identical to PBD with $k = 1$.

On this cloth example XPBD's extra per-iteration cost is typically under 2% of total simulation time (Table 1).

**Table 1:** Per-step simulation time (ms) for the hanging cloth at varying iteration counts.

| Iterations | 20 | 40 | 80 | 160 |
|---|---|---|---|---|
| PBD | 0.95 | 1.75 | 3.25 | 5.61 |
| XPBD | 0.97 | 1.78 | 3.34 | 5.65 |

### 6.5 Inflatable Balloon

An inflatable balloon models interior air pressure with one global volume constraint, and the surface as a cloth mesh with stretch, shear and bending constraints (Figure 1). The volume constraint needs only a single auxiliary multiplier, plus one per surface constraint. Relative stiffness is easy to tune — e.g. more iterations can be spent to enforce volume more strongly without changing surface stiffness.

## 7 Limitations and Future Work

At $\alpha = 0$ XPBD equals PBD with $k = 1$, so stiff results still need as many iterations as PBD. As in PBD, stopping before convergence (low iteration counts) introduces artificial compliance. Convergence could be sped up by swapping Gauss–Seidel/Jacobi for a stronger linear solver per iteration; accelerated iterative schemes such as Wang's [2015] Chebyshev method may apply.

Temporal coherence is a promising direction: since the total constraint force is now known, the solve could be **warm-started from the previous frame's Lagrange multipliers**.

Unlike Projective Dynamics [Bouaziz et al. 2014], XPBD only approximates an implicit Euler integrator. For real-time graphics the error is acceptable and often invisible, but traditional methods may suit applications needing stronger accuracy guarantees.

## 8 Conclusion

XPBD is a small extension of PBD that removes its best-known weakness, time-step- and iteration-dependent stiffness. It costs one extra stored scalar per constraint, yet lets PBD represent arbitrary elastic and dissipative potentials and return accurate constraint force estimates for force-driven effects. This brings PBD closer to applications that need accuracy and correspondence with traditional material models, and since it requires only trivial changes to an existing PBD solver it should be easy to adopt.

## References

Reference list omitted. Works cited that matter for this repo:

- Müller, Heidelberger, Teschner, Gross 2005 — *Meshless deformations based on shape matching* (SIGGRAPH). The shape-matching constraint used by `shape-match-core.js`.
- Müller, Heidelberger, Hennix, Ratcliff 2007 — *Position based dynamics* (JVCIR 18(2)). Original PBD; stiffness $k$ and exponential $k$ rescaling.
- Servin, Lacoursière, Melin 2006 — *Interactive simulation of elastic deformable materials* (SIGRAD). Compliant-constraint formulation XPBD adapts.
- Bender, Müller, Otaduy, Teschner, Macklin 2014b — *A survey on position-based simulation methods in computer graphics* (CGF 33).
- Müller, Chentanez, Kim, Macklin 2014 — *Strain based dynamics* (SCA).
- Goldenthal et al. 2007 — *Efficient simulation of inextensible cloth* (TOG 26). Fast Projection.
- Bouaziz et al. 2014 — *Projective dynamics* (TOG 33(4)); Wang 2015 — *A Chebyshev semi-iterative approach for accelerating projective and position-based dynamics* (TOG 34(6)).
