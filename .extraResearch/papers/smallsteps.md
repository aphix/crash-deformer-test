# Small Steps in Physics Simulation

**Authors:** Miles Macklin (NVIDIA, University of Copenhagen), Kier Storey, Michelle Lu, Pierre Terdiman, Nuttapong Chentanez, Stefan Jeschke, Matthias Müller (all NVIDIA)
**Venue:** SCA '19 — ACM SIGGRAPH / Eurographics Symposium on Computer Animation, July 26–28, 2019, Los Angeles. Article 39, 7 pages. DOI: [10.1145/3309486.3340247](https://doi.org/10.1145/3309486.3340247)
**CCS concepts:** Computing methodologies → Simulation by animation; Interactive simulation.
**Keywords:** physics-based animation, real-time simulation.

> *Rewrite note:* prose is paraphrased and condensed; equations, algorithm, parameter values, table and figure content are kept. Uncertain reconstructions are marked `[reconstructed]`.

> Figure 1: A high-resolution cloth (150k particles, 896k spring constraints) draped over the Stanford bunny. Left: 1 substep × 30 XPBD iterations — 12.4 ms/frame, visibly stretched. Right: 30 substeps × 1 XPBD iteration — 13.5 ms/frame, much less stretch and a stiffer-looking material. Collision detection runs once per frame in both.

## Abstract

The paper questions the common belief that implicit integrators taking large steps are the best stability/performance choice for stiff systems. Its central observation: a single large step solved with $n$ constraint-solver iterations is *less* effective than $n$ small steps of size $\Delta t/n$, each with *one* solver iteration. The method therefore splits each visual frame into $n$ substeps and runs one iteration of extended position-based dynamics (XPBD) per substep. Versus a classical large-step implicit integrator, constraint error and numerical damping drop considerably; versus explicit integration, the method is stable and robust over a wider range of stiffness. The advantage persists even against Krylov-type implicit solvers. The method is simple, insensitive to matrix conditioning, and copes with over-constrained problems.

## 1 Introduction

Interactive simulation must be faithful, robust and fast. Integrators fall into two families. **Explicit** schemes compute the next state directly from the current one but are only conditionally stable — they can blow up when step-size conditions are violated — so they are rarely used alone. **Implicit** schemes are preferred for stability but require solving a nonlinear system each step, usually by Newton's method: the system is linearized repeatedly and each linear system is solved globally (Conjugate Gradients or a direct solver). First-order implicit methods add numerical damping, cost more than explicit ones, and give no fixed time bound on convergence — awkward for interactive use.

Real-time applications therefore favour **local iterative relaxation** such as Position-Based Dynamics (PBD) [Müller et al. 2007], which uses nonlinear Projected Gauss–Seidel (PGS). Unlike a global linear solve, where the matrix (and all constraint gradients) is frozen for the solve and the answer can drift far from the constraint manifold, nonlinear PGS re-evaluates gradients at each projection, which limits overshoot. Relaxation also tolerates over-constrained systems that can defeat global linear solvers, and handling one equation at a time makes unilateral (inequality) constraints trivial: only currently violated constraints (the active set) are projected, and the set may change between projections, which avoids sticking. Coupling heterogeneous models (fluids, rigid bodies, …) amounts to concatenating or interleaving their constraint lists [Macklin et al. 2014; Stam 2009].

The downside of local methods is slow propagation of error corrections compared with a simultaneous solve, which hurts stiff problems, plus numerical dissipation similar to implicit integration. The authors set out to improve convergence and energy preservation of local solvers without losing their strengths.

Accuracy can be bought two ways: shrink the time step or add solver iterations. Both cost work, so at fixed budget one must trade them: more iterations (or a more complex solver) forces a larger step, and smaller steps leave fewer iterations per step. The question is whether it is better to (a) solve one hard problem accurately or (b) solve many easy problems approximately. Since Baraff and Witkin [1998] the field has favoured (a) — large implicit steps for stiff systems. The authors find (b) to be much better; for PGS the optimum is at the extreme of (b): as many small steps as the budget allows, with **one iteration per step**. Each frame step $\Delta t$ is split into $n$ substeps of $\Delta t/n$, each running a single XPBD iteration.

Replacing iterations by substeps is effective enough that one-iteration XPBD competes with global matrix solvers in convergence. One pass over the constraints looks too little to capture meaningful forces and torques, but it is enough: as Macklin et al. [2016] showed, the first XPBD iteration equals the first Newton step on the backward-Euler equations. So although each substep costs about as much as an explicit step, it inherits the stability of an implicit method. Prior work compared explicit-small-step with implicit-large-step integration, but not the middle ground of *approximate implicit integration with small steps*. Contributions: a new simulation approach and, more importantly, a study of shrinking the step size and of single-iteration implicit integration.

Table 1 summarises the trade-offs. Explicit methods are simple and can be efficient for moderately stiff problems. Classical implicit methods (backward Euler) are stable but conserve energy poorly and cost more. Iterative implicit methods such as XPBD are stable and efficient for moderate stiffness but struggle to reach high stiffness and are damped. The proposed method improves XPBD's convergence and energy behaviour with a small change to the algorithm.

**Table 1:** Relative strengths and weaknesses of each method (✓ = strength). `[reconstructed]` — check marks were garbled in extraction; pattern inferred from the text above.

| Method | Stability | Efficiency | Simplicity | Energy |
|---|---|---|---|---|
| Semi-Implicit Euler | | ✓ | ✓ | ✓ |
| Implicit Euler | ✓ | | | |
| XPBD | ✓ | ✓ | ✓ | |
| Small Steps | ✓ | ✓ | ✓ | ✓ |

## 2 Related Work

Implicit integration in graphics starts with Terzopoulos et al. [1987; 1988], who used the alternating-direction implicit (ADI) method [Peaceman and Rachford 1955] for part of the forces. Explicit integration then dominated until Baraff and Witkin [1998] made all cloth forces (including damping) implicit with backward Euler, which is stable for large steps. Desbrun et al. [1999] accelerated this with a predictor–corrector approximation to the implicit solution. All of these suffer artificial numerical damping. Choi and Ko [2002] reduced it with a second-order backward difference formula (BDF2). Bridson et al. [2003] combined explicit elastic and implicit damping forces (IMEX) — effectively a central Newmark scheme [Newmark 1959] — which with strain limiting is stable at moderate steps and barely damped. IMEX was also used for particle systems [Eberhardt et al. 2000]; Fierz et al. [2011] chose explicit or implicit per element. All rely on a global linear solve for the implicit part.

Variational integrators [Kane et al. 2000; Kharevych et al. 2006; Marsden and West 2001] give good energy behaviour and controlled damping; depending on the quadrature used to discretize the Lagrangian they can be explicit or implicit and of various orders. Energy stays bounded, yet animations may still oscillate with unnatural high-frequency vibration, and the explicit/implicit trade-off remains. Exponential integrators [Michels et al. 2014] solve the linear part analytically and the nonlinear part numerically, but stability is only guaranteed in the linear regime. Projective Dynamics [Bouaziz et al. 2014] alternates local and global solves with impressive real-time results; Dinev et al. [2018] added energy control by mixing implicit midpoint with forward or backward Euler. The PD global step needs a pre-factorized matrix, which hampers runtime topology changes. Asynchronous integrators [Lew et al. 2003; Thomaszewski et al. 2008] and asynchronous contact [Harmon et al. 2009; Zhao et al. 2016] vary the step over the domain, but their cost fluctuates over time — undesirable in real time. Gast et al. [2015] noted the value of a single Newton step over explicit integration but did not pursue it. Using the predicted next state to compute forces, akin to an implicit integrator, also appears in PD controllers [Tan et al. 2011] for stability.

## 3 Time Integration

Equations of motion are written with an implicit, position-level discretization:

$$\mathbf{M}\left(\mathbf{x}^{n+1}-\tilde{\mathbf{x}}\right)-\nabla\mathbf{C}\left(\mathbf{x}^{n+1}\right)^{T}\boldsymbol{\lambda}^{n+1}=\mathbf{0} \tag{1}$$

$$\mathbf{C}\left(\mathbf{x}^{n+1}\right)+\tilde{\boldsymbol{\alpha}}\,\boldsymbol{\lambda}^{n+1}=\mathbf{0} \tag{2}$$

$\mathbf{M}$ is the mass matrix, $\mathbf{x}^{n+1}$ the state at the end of step $n$, $\mathbf{C}$ the vector of constraint functions with gradient $\nabla\mathbf{C}$, and $\boldsymbol{\lambda}^{n+1}$ the Lagrange multipliers. Constraints are regularized by a compliance matrix $\tilde{\boldsymbol{\alpha}}$ obtained by factoring a quadratic energy potential [Macklin et al. 2016] (in XPBD, $\tilde{\alpha}=\alpha/\Delta t^2$). The predicted (inertial) position comes from explicitly integrating external forces:

$$\tilde{\mathbf{x}}=\mathbf{x}^{n}+\Delta t\,\mathbf{v}^{n}+\Delta t^{2}\,\mathbf{M}^{-1}\mathbf{f}_{ext}\left(\mathbf{x}^{n}\right) \tag{3}$$

Key observation from (3): the influence of external forces on positions scales with $\Delta t^2$, a consequence of discretizing a second-order ODE, and it largely determines the error made in one step. Halving the step quarters the positional error. This simple fact motivates the method and explains why small steps reduce positional error so effectively (Section 6).

**Algorithm 1: Substep XPBD simulation loop**

```text
1:  perform collision detection using x^n, v^n
2:  Δt_s ← Δt_f / n_steps
3:  while n < n_steps do
4:      predict position  x̃ ← x^n + Δt_s v^n + Δt_s² M⁻¹ f_ext(x^n)
5:      for all constraints do
6:          compute Δλ using Eq (7)
7:          compute Δx using Eq (4)
8:          update λ^{n+1} ← λ^n + Δλ        (optional)
9:          update x^{n+1} ← x + Δx           (x starts at x̃)
10:     end for
11:     update velocities  v^{n+1} ← (x^{n+1} − x^n) / Δt_s
12:     n ← n + 1
13: end while
```

## 4 Constraint Solve

Constraints are enforced with XPBD [Macklin et al. 2016], which projects positions per constraint $i$:

$$\Delta\mathbf{x}=\mathbf{M}^{-1}\nabla C_i(\mathbf{x})^{T}\,\Delta\lambda_i \tag{4}$$

with multiplier increment

$$\Delta\lambda_i=\frac{-C_i(\mathbf{x})-\tilde{\alpha}_i\lambda_i}{\nabla C_i\,\mathbf{M}^{-1}\nabla C_i^{T}+\tilde{\alpha}_i} \tag{5}$$

Plain PBD would loop this projection several times per constraint in Gauss–Seidel or Jacobi order. Instead, the whole frame step $\Delta t_f$ is divided into $n_{steps}$ substeps,

$$\Delta t_s=\frac{\Delta t_f}{n_{steps}} \tag{6}$$

and **one** constraint iteration is done per substep. This can be viewed as an inexact implicit solve per substep, while gaining from the $\Delta t^2$ dependence of position error. Because only one iteration is performed and the multiplier starts at zero each substep ($\lambda_i=0$), (5) simplifies to

$$\Delta\lambda_i=\frac{-C_i(\mathbf{x})}{\nabla C_i\,\mathbf{M}^{-1}\nabla C_i^{T}+\tilde{\alpha}_i} \tag{7}$$

> Figure 2: Position-based fluid with 936k particles. 10 iterations (1 step): noticeable compression and heavily damped motion. 10 substeps × 1 iteration: visibly stiffer fluid with livelier motion.

With one iteration per substep the multipliers need not be stored, but accumulating them is useful for reporting forces to the user; the results show these force estimates stay accurate even with one iteration per substep (Figure 4). Algorithm 1 summarises the loop.

### 4.1 Damping

Smaller steps also reduce the integrator's numerical dissipation, so physical damping must now be modelled explicitly in the constraints. Using the XPBD damping form:

$$\Delta\lambda_i=\frac{-C_i(\mathbf{x})-\gamma_i\,\nabla C_i\left(\mathbf{x}-\mathbf{x}^{n}\right)}{\left(1+\gamma_i\right)\nabla C_i\,\mathbf{M}^{-1}\nabla C_i^{T}+\tilde{\alpha}_i} \tag{8}$$

With a time-step-scaled damping parameter $\tilde{\beta}_i=\Delta t_s^{2}\,\beta_i$ for constraint $i$, define $\gamma_i=\dfrac{\tilde{\alpha}_i\tilde{\beta}_i}{\Delta t_s}$. Derivations: Macklin et al. [2016], Servin et al. [2006].

### 4.2 Collision Detection

Smaller steps generally make collision detection more accurate, but detecting collisions every substep is expensive. The key to making substepping affordable is to **detect once per frame and reuse the contact set across all substeps**. The system is first predicted forward over the whole frame step $\Delta t_f$ with current velocities, and potential collisions along that trajectory become contact constraints.

> Figure 3: Left: stretch of a 1D chain of particles linked by distance constraints hanging under gravity; substeps (red) cut stretch much more than the same number of iterations (blue). Curves: 10 iters, 100 iters, 10 substeps, 100 substeps over 1000 frames. Right: same test with a 10⁵ kg mass on the chain end — the gap widens.

> Figure 4: Left: residual error at frame 1000 for varying iteration vs substep counts (log scale) — about two orders of magnitude lower error for the same count of substeps. Right: force estimate (Lagrange multiplier) of the topmost chain constraint over time; true value 190 N. Even one iteration per substep gives an accurate force estimate.

Detecting only once per frame can miss collisions when trajectories change within the frame. Such misses would be handled on the next frame, but to limit them, contacts are generated for features within a user-defined margin distance. Updating the contact set in the style of constraint manifold refinement (CMR) [Otaduy et al. 2009] could improve this further.

### 4.3 Contact

Contacts are inelastic; interpenetration is prevented with inequality constraints

$$C_n(\mathbf{x})=\mathbf{n}^{T}\left[\mathbf{a}(\mathbf{x})-\mathbf{b}(\mathbf{x})\right]\ge 0 \tag{9}$$

where $\mathbf{a}$, $\mathbf{b}$ are points on a rigid or deformable body and $\mathbf{n}\in\mathbb{R}^3$ is the contact normal (fixed in world space or itself a function of the coordinates). A side effect of small steps: any penetration $d_0$ present at the start of a step is removed by the implicit solve within one substep, producing a separating velocity $v_{sep}=d_0/\Delta t_s$. Smaller substeps mean larger separating velocities and visible "popping". Macklin et al. [2014] proposed a pre-stabilization pass that projects out initial overlap kinematically; here a simpler contact-specific fix limits the maximum depenetration speed per substep:

$$C_n(\mathbf{x})=\mathbf{n}^{T}\left[\mathbf{a}(\mathbf{x})-\mathbf{b}(\mathbf{x})\right]+\max\left(d_0-v_{max}\Delta t_s,\;0\right)\ge 0 \tag{10}$$

$v_{max}$ is the largest separating speed allowed per substep: large values let bodies fly apart violently, small values separate them gently. This resembles the clamped normal impulses of Bridson et al. [2003]. With no initial penetration ($d_0=0$) it reduces to a hard inequality constraint.

### 4.4 Friction

Frictional attachment constraints:

$$\mathbf{C}_f(\mathbf{x})=\mathbf{D}^{T}\left[\mathbf{a}(\mathbf{x})-\mathbf{b}(\mathbf{x})\right]=\mathbf{0} \tag{11}$$

where $\mathbf{D}$ is a 1- or 2-dimensional friction basis. To obey Coulomb's law (friction bounded by normal force), the friction multiplier update is clamped:

$$\Delta\lambda_f\leftarrow\min\left(\mu\,\Delta\lambda_n,\;\Delta\lambda_f\right) \tag{12}$$

with $\lambda_n$, $\lambda_f$ the normal and friction multipliers and $\mu$ the friction coefficient (applied to the magnitude of $\Delta\lambda_f$ `[reconstructed]`). This projection implicitly captures stick/slip transitions and keeps the friction force bounded by the scaled normal force.

## 5 Comparison to Explicit Methods

Per substep the cost is close to that of an explicit integrator, but because the scheme comes from an implicit discretization it stays stable even for very large stiffness. This robustness matters for real-time/interactive use and makes asset authoring much easier. Even at infinite stiffness (zero compliance) the method is stable and behaves as stiffly as the total substep count allows.

## 6 Results

3D examples are implemented in CUDA on an NVIDIA RTX 2080 Ti using a parallel **Jacobi** iteration over constraints. A fixed iteration count is used for most examples, as is usual in interactive settings where the compute budget must not vary between frames.

### 6.1 Hanging Chain

A 1D chain of 20 particles, each of mass $m=1$ kg, joined by inextensible distance constraints of rest length $l=0.01$ m, hangs under gravity. The bottom particle's position measures error (Figure 3). In a variant, a heavy particle is attached at the bottom so that the total mass ratio is $1:100000$ — a stress test for most iterative methods. There the maximum error with 100 iterations is $e=322.1$ (unit printed as "m"; likely mm), versus $e=3.2$ with 100 substeps. This two-orders-of-magnitude reduction matches the predicted quadratic error reduction with step size.

### 6.2 Cloth

Hanging cloth is the classic case: iterative solvers struggle to keep it stiff and unstretched, and many fixes exist [Goldenthal et al. 2007; Kim et al. 2012; Müller 2008; Müller et al. 2012], often with non-physical side effects. Figure 5 compares substeps with iterations. At equal cost, substeps stretch much less and conserve energy better than more iterations (Figure 6). Compared with semi-implicit (symplectic) Euler using explicit spring forces, the approximate implicit scheme stays robust for large stiffness, even infinite stiffness (zero compliance), while semi-implicit Euler diverges quickly. Work per iteration is similar across approaches; the per-substep integration overhead is small relative to constraint solving. Per-frame times for the cloth: **1.8 ms** XPBD with 40 iterations, **2.4 ms** XPBD with 40 substeps, **2.5 ms** semi-implicit Euler.

> Figure 5: Simple hanging cloth sheets with stiffness $k=10^7$ N/m. Left: XPBD, 1 substep, 40 iterations. Middle: XPBD, 40 substeps, 1 iteration. Right: semi-implicit Euler, 40 substeps. Unlike the explicit method, the approach stays stable for high stiffness.

> Figure 6: System energy (gravitational + kinetic) over time (≈1500 frames) for the hanging cloth, comparing 10/4/40 iterations with 3/40 substeps `[reconstructed legend]`. Smaller steps markedly reduce the damping from implicit discretization, giving livelier motion.

### 6.3 FEM

A cantilever beam of 12800 tetrahedral FEM elements (linear constitutive model, Young's modulus $Y=10^7$ Pa, Poisson's ratio $\nu=0.45$, density $\rho=1000$ kg/m³) hangs under gravity. With large steps and many iterations the beam deforms strongly and collapses to the ground; with the same number of substeps it holds itself up. Compared with a linearly-implicit Newton method using a Krylov PCG solver (diagonal Jacobi preconditioner) applied directly to (1)–(2), substepping reaches similar stiffness with far less numerical damping. Frame times: **4 ms** (100 XPBD iterations), **6 ms** (100 XPBD substeps), **12 ms** (100 PCG iterations).

> Figure 7: Cantilever beam of 12800 tetrahedral FEM elements, $Y=10^7$ Pa, $\nu=0.45$. Left: XPBD 1 substep × 100 iterations. Middle: XPBD 100 substeps × 1 iteration. Right: backward Euler (PCG) 1 substep × 100 iterations. 4 ms, 6 ms and 12 ms per frame respectively. Substepping gives stiffness comparable to the more complex method, with less damping and lower cost.

### 6.4 Fluids

Position-Based Fluids [Macklin and Müller 2013]. The accompanying video shows a 2D scene that stresses any particle fluid: over a hundred particle layers of depth and fast incoming particles. For stability particles are limited to moving at most **0.3 × radius per time step** (a CFL condition). With substepping the steps are small enough that no visible damping is added, particles do not cross, and the fluid comes fully to rest. Large steps add heavy damping and instabilities; relaxing the CFL limit causes disturbing particle crossings. In Figure 2 a 3D fluid column (rest density $\rho=1000$ kg/m³, 936k particles) collapses under gravity in a container: 10 PBF iterations fail to enforce incompressibility (clear volume loss), whereas 10 substeps of one PBF iteration give a stiffer response and allow a larger CFL bound, with livelier motion.

### 6.5 Rigid Bodies

Figure 8 tests a heavy weight hung from jointed rigid bodies; the effect mirrors the cloth case — less stretch and more robust angular degrees of freedom. Figure 9 is a contact test: a large mass resting on a stack of rigid capsules, another stress case for iterative methods. With substeps the stack stays stiff and stable with little interpenetration; with one substep and many iterations it interpenetrates heavily and soon collapses.

> Figure 8: A chain of rigid bodies holding a suspended weight, mass ratio 1:1000. Left: 1 substep × 100 iterations, 4 ms/frame, visible joint separation. Middle: 1 substep × 500 iterations, 17 ms/frame, still visibly stretched. Right: 100 substeps × 1 iteration, 6 ms/frame, chain stiff and stable.

> Figure 9: A heavy box resting on a stack of capsules. 1 substep × 100 iterations: the stack collapses quickly (left). 100 substeps × 1 iteration: the stack stays stable (right). Collision detection runs once per frame in both.

## 7 Limitations and Future Work

Shrinking the step is effective for positional error, but not for velocity-dependent terms such as damping forces, because velocity error is only proportional to $\Delta t$ (not $\Delta t^2$). Velocity error is often acceptable; when it is not (e.g. highly viscous materials), an accurate implicit solve of the velocity terms after the positional constraints may be advisable. The method also works with Gauss–Seidel iteration, but as with most Gauss–Seidel methods the residual then depends somewhat on constraint ordering; this was not significant in practice, and symmetric successive over-relaxation (SSOR) could reduce it. Finally, because of the $\Delta t^2$ term, single-precision floating point limits can be hit after enough substeps: a tiny position delta added to a large coordinate may not change its float representation, depending on coordinate magnitude. All examples used 32-bit floats; very high substep counts may need double precision.

## 8 Conclusions

Many solver iterations on large time steps were found to be inferior to approximate implicit integration over small time steps. The approach adds little overhead but greatly raises achievable stiffness, a direct consequence of positional error from external forces scaling with $\Delta t^2$: shrinking the step reduces error quadratically at low complexity. This makes it an attractive alternative to traditional implicit integrators across multibody and deformable scenarios, and its simplicity should make it useful to practitioners.

## References (subset relevant to this repo)

- M. Müller, B. Heidelberger, M. Hennix, J. Ratcliff. *Position Based Dynamics.* J. Vis. Commun. Image Represent. 18(2), 2007.
- M. Macklin, M. Müller, N. Chentanez. *XPBD: Position-Based Simulation of Compliant Constrained Dynamics.* MIG 2016.
- M. Macklin, M. Müller, N. Chentanez, T.-Y. Kim. *Unified Particle Physics for Real-Time Applications.* ACM TOG 33(4), 2014 (pre-stabilization of contacts).
- D. Baraff, A. Witkin. *Large Steps in Cloth Simulation.* SIGGRAPH 1998.
- R. Bridson, S. Marino, R. Fedkiw. *Simulation of Clothing with Folds and Wrinkles.* SCA 2003 (clamped normal impulses).
- M. Servin, C. Lacoursière, N. Melin. *Interactive Simulation of Elastic Deformable Materials.* SIGRAD 2006 (constraint damping).
- M. A. Otaduy, R. Tamstorf, D. Steinemann, M. Gross. *Implicit Contact Handling for Deformable Objects.* CGF 28, 2009 (constraint manifold refinement).
- M. Macklin, M. Müller. *Position Based Fluids.* ACM TOG 32(4), 2013.

(The full reference list of the paper is omitted.)
