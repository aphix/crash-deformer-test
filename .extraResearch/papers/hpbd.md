# Hierarchical Position Based Dynamics

*Matthias Müller (NVIDIA). Workshop on Virtual Reality Interaction and Physical Simulation, VRIPHYS 2008 (eds. F. Faure, M. Teschner). © The Eurographics Association 2008.*

> Paraphrased, condensed rewrite. Section order, equations, algorithms, parameters and figure captions are preserved in meaning; prose is not the author's wording. Equations whose PDF text extraction was garbled and had to be rebuilt from context are marked **[reconstructed]**.

## Abstract

Position Based Dynamics (PBD) simulates dynamic objects robustly in real time. Its simplicity comes from processing constraints one at a time in a Gauss-Seidel fashion; unlike a global Newton-Raphson solver, this local solver handles non-linear and inequality constraints with ease. The price is slow convergence. The paper proposes a multigrid-style process that speeds up PBD convergence substantially while keeping its ability to handle general non-linear constraints. Examples show the new approach is much faster than plain PBD, enabling real-time simulation at higher detail in interactive applications such as games.

*ACM CCS: I.3.5 [Computer Graphics]: Computational Geometry and Object Modeling — Physically Based Modeling; I.3.7 [Computer Graphics]: Three-Dimensional Graphics and Realism — Animation and Virtual Reality.*

## 1. Introduction

To be usable in games a simulation method must satisfy four requirements: it must be **fast, stable, controllable and easy to code**. A gap persists between academic graphics research, which keeps growing more mathematically involved as it approaches computational-science methods (needed for film-quality effects), and game practice, where most physics is still rigid-body dynamics and water, cloth and soft bodies are mostly procedural because procedural methods are cheap and cannot go unstable.

PBD [MHR06] tries to bridge this gap. It generalises Jakobsen's approach [Jak01]: a Verlet-style integrator skips the force and velocity layers and edits particle/vertex positions directly, using a non-linear Gauss-Seidel solver. Its advantages are simplicity, unconditional stability, direct handling of non-linear unilateral (inequality) and bilateral (equality) constraints, and the ability to manipulate positions directly, which gives the user a lot of control.

The weakness of Gauss-Seidel solvers is that constraints are processed individually, so information propagates slowly through a mesh. Cloth and soft bodies therefore look stretchy, especially at high resolution. This is clearly wrong: real cloth is highly deformable because of low *bending* resistance, not low *stretching* stiffness.

Global solvers converge much faster. Newton-Raphson iteration is the standard choice for non-linear systems, but it is expensive and complex: the system is linearised and solved several times per step. It is impractical in real time but handles stiff equations well offline, as [GHF*07] demonstrates. Being global, each linear solve needs a global linear solver such as Preconditioned Conjugate Gradients (PCG). PCG cannot easily be extended to unilateral constraints because these turn the problem into a QP / LCP [Ebe04]. Multigrid methods are an important alternative to PCG, but they target linear systems and also cannot handle inequalities, since it is unclear how to carry them to coarser levels.

A useful property of multigrid is that each level is typically solved with a simple Jacobi or Gauss-Seidel iteration. The core idea here is to replace that linear Gauss-Seidel smoother with PBD's **non-linear** one, giving a non-linear multigrid solver. This raises questions the paper answers: how to restrict unilateral constraints to coarser meshes, how to translate non-linear constraint functions to coarser levels, and how to prolongate solutions back to finer levels. The main contribution is thus a way to turn PBD's non-linear Gauss-Seidel solver into a non-linear multigrid algorithm that converges much faster while keeping PBD's attractive properties.

## 2. Related Work

The paper targets deformable objects. Surveys [GM97] and [NMK*05] cover the field. Since the early work of [TPBF87] many deformable solid and cloth techniques have appeared; offline at first, now real-time. *ArtDefo* [JP99] was among the first interactive deformable systems. Reduced models [HSO03], [BJ07] are an efficient speed-up; [MG04] keeps all degrees of freedom but reduces the non-linear equations to a linear system while avoiding artifacts under large rotations. The present method also targets real time, though nothing prevents its use at high resolution offline.

As an extension of PBD [Jak01, MHR06], the method is based on **constraint projection**. Constraint projection has been used in cloth to resolve collisions geometrically [BFA02] and in kinematic collision correction [VCMT95]; Desbrun [DSB99], Provot [Pro95] and [GHF*07] used projection in mass-spring systems to prevent over-stretching; Faure [Fau98] represented objects by linearised displacement constraints; and for stable soft bodies [MHTG05] projected particles onto a configuration obtained by **shape matching** the rest to the current positions.

Multigrid has been used in computational science for decades ([McC87] is an introduction) and more recently in graphics, mostly with FEM [DDCB01, CGC*02, WT04, GW06]. [CFL*07] used algebraic multigrid for the Poisson equation of incompressible fluids, and [OGRG07] exploited the hierarchy to *adaptively* simulate deformations, refining locally where stresses are high. By contrast, the present method produces fine detail **everywhere** in the object: neither the refinement locations nor the number of levels change during simulation, which avoids the visual artifacts typical of adaptive schemes.

## 3. Position Based Simulation

Because the paper accelerates PBD and aims to be self-contained, it recaps PBD. An object is a set of $N$ particles and $M$ constraints. Particle $i$ has three attributes:

**Table 1: Attributes of a particle**

| Symbol | Meaning |
|---|---|
| $m_i$ | mass |
| $\mathbf{x}_i$ | position |
| $\mathbf{v}_i$ | velocity |

Constraint $j$ has five attributes:

**Table 2: Attributes of a constraint**

| Symbol | Meaning |
|---|---|
| $n_j$ | cardinality (number of particles it involves) |
| $C_j : \mathbb{R}^{3n_j} \to \mathbb{R}$ | scalar constraint function |
| $\{i_1, \dots, i_{n_j}\},\ i_k \in [1, \dots, N]$ | set of particle indices |
| $k_j \in [0 \dots 1]$ | stiffness parameter |
| unilateral or bilateral | type |

A bilateral constraint is satisfied when $C_j(\mathbf{x}_{i_1}, \dots, \mathbf{x}_{i_{n_j}}) = 0$; a unilateral one when $C_j(\mathbf{x}_{i_1}, \dots, \mathbf{x}_{i_{n_j}}) \ge 0$. The stiffness $k_j$ scales the constraint's strength between zero and one.

Given these data and a time step $\Delta t$, the simulation runs:

```text
(1)  for all particles i
(2)      initialize x_i = x_i^0,  v_i = v_i^0,  w_i = 1 / m_i
(3)  endfor
(4)  loop
(5)      for all particles i do  v_i <- v_i + Δt * w_i * f_ext(x_i)
(6)      for all particles i do  p_i <- x_i + Δt * v_i
(7)      for all particles i do  generateCollisionConstraints(x_i -> p_i)
(8)      loop solverIterations times
(9)          projectConstraints(C_1, ..., C_{M + M_coll}, p_1, ..., p_N)
(10)     endloop
(11)     for all particles i
(12)         v_i <- (p_i - x_i) / Δt
(13)         x_i <- p_i
(14)     endfor
(15) endloop
```

The algorithm is second-order in time, so positions and velocities are initialised in (1)–(3) before the loop. Lines (5)–(6) are an explicit forward Euler step on velocities and positions; the new locations $\mathbf{p}_i$ are only *predictions*, not yet committed. Non-permanent external constraints such as collisions are regenerated from scratch every step in line (7), using the original and predicted positions for continuous collision detection. The solver (8)–(10) iteratively corrects the predictions so they satisfy the $M_{coll}$ external and $M$ internal constraints. Finally the corrected $\mathbf{p}_i$ update both positions **and** velocities; updating velocities this way is essential for the method to behave as a second-order system.

## 4. The System to be Solved

The rest of the paper focuses on the solver (8)–(10), where almost all simulation time is spent. The original Gauss-Seidel solver [MHR06] is reviewed first.

The solver must correct the predicted positions $\mathbf{p}_i$ so that all constraints hold. This is a set of $M$ equations in $3N$ unknown position components ($M$ now counts all constraints). The system need not be symmetric: if $M > 3N$ it is over-determined, if $M < 3N$ under-determined. The equations are generally non-linear — even a simple distance constraint $C(\mathbf{p}_1, \mathbf{p}_2) = (\mathbf{p}_1 - \mathbf{p}_2)^2 - d^2$ is non-linear — and collisions add inequalities. Solving a non-symmetric, non-linear system with equalities and inequalities is hard.

Let $\mathbf{p} = [\mathbf{p}_1^T, \dots, \mathbf{p}_N^T]^T$ be the concatenated positions, and let every $C_j$ take $\mathbf{p}$ as input while only using the coordinates it is defined on. The system is

$$
\begin{aligned}
C_1(\mathbf{p}) &\succ 0 \\
&\ \,\vdots \\
C_M(\mathbf{p}) &\succ 0
\end{aligned}
$$

where $\succ$ stands for either $=$ or $\ge$.

Newton-Raphson iteration solves non-linear *symmetric* systems with *equalities only*. From an initial guess, each constraint is linearised around the current solution:

$$
C_j(\mathbf{p} + \Delta\mathbf{p}) = C_j(\mathbf{p}) + \nabla_{\mathbf{p}} C_j(\mathbf{p}) \cdot \Delta\mathbf{p} + O(|\Delta\mathbf{p}|^2) = 0, \qquad j = 1, \dots, M. \tag{1}
$$

This gives a *linear* system for the global correction $\Delta\mathbf{p}$:

$$
\begin{aligned}
\nabla_{\mathbf{p}} C_1(\mathbf{p}) \cdot \Delta\mathbf{p} &= -C_1(\mathbf{p}) \\
&\ \,\vdots \\
\nabla_{\mathbf{p}} C_M(\mathbf{p}) \cdot \Delta\mathbf{p} &= -C_M(\mathbf{p})
\end{aligned}
$$

where $\nabla_{\mathbf{p}} C_j(\mathbf{p})$ is the $1 \times N$ (per-coordinate) row vector of derivatives of $C_j$ with respect to all its parameters — the $j$-th row of the linear system. Rows and right-hand sides are constants, evaluated at $\mathbf{p}$ before solving. When $M = 3N$ and only equalities appear, any linear solver (e.g. PCG) applies. After solving, $\mathbf{p} \leftarrow \mathbf{p} + \Delta\mathbf{p}$, rows and right-hand sides are re-evaluated, and the process repeats.

If $M \ne 3N$ the matrix is non-square and not invertible; [GHF*07] use the pseudo-inverse, giving the least-squares solution. Inequalities still cannot be handled directly.

## 5. The Non-Linear Gauss-Seidel Solver

PBD's non-linear Gauss-Seidel solver handles each constraint equation on its own. Each constraint gives one scalar equation $C(\mathbf{p}) \succ 0$ in the positions of the particles it involves, so the sub-system is heavily under-determined. PBD resolves it as follows. Given $\mathbf{p}$, find a correction $\Delta\mathbf{p}$ with $C(\mathbf{p} + \Delta\mathbf{p}) = 0$. Note that PBD also linearises, but per constraint:

$$
C(\mathbf{p} + \Delta\mathbf{p}) \approx C(\mathbf{p}) + \nabla_{\mathbf{p}} C(\mathbf{p}) \cdot \Delta\mathbf{p} = 0. \tag{2}
$$

Under-determination is removed by restricting $\Delta\mathbf{p}$ to the direction of the constraint gradient, which conserves linear and angular momentum; then only one scalar — a Lagrange multiplier $\lambda$ — remains to be found:

$$
\Delta\mathbf{p} = \lambda\, \nabla_{\mathbf{p}} C(\mathbf{p}). \tag{3}
$$

*(Mass weighting enters per particle in Eq. 4; with the inverse mass matrix this reads $\Delta\mathbf{p} = \lambda\, \mathbf{M}^{-1} \nabla_{\mathbf{p}} C$.)* **[reconstructed]**

Substituting (3) into (2) and solving gives the correction for a single particle $i$:

$$
\Delta\mathbf{p}_i = -s\, w_i\, \nabla_{\mathbf{p}_i} C(\mathbf{p}), \tag{4}
$$

with

$$
s = \frac{C(\mathbf{p})}{\sum_j w_j \left| \nabla_{\mathbf{p}_j} C(\mathbf{p}) \right|^2} \tag{5}
$$

and $w_i = 1/m_i$.

So this solver also linearises the constraint functions — but, unlike Newton-Raphson, **individually per constraint**. For a single distance constraint the linearised solve already gives the exact answer in one step. Because positions are updated immediately after each constraint is processed, these updates change the linearisation of the next constraint (the linearisation depends on the current positions). Asymmetry is harmless since each constraint gives exactly one scalar equation for one unknown $\lambda$. Inequalities are trivial: first test whether $C(\mathbf{p}) \ge 0$; if so, skip the constraint.

## 6. The Multi-Grid Solver

This section presents the non-linear multigrid solver. The key part is building a data structure — a **hierarchy of constrained particle systems**. Once it exists, solving is straightforward.

### 6.1. Hierarchical Particle Systems

The original system of $N$ particles and $M$ constraints is the finest level, **level 0**. In particular settings it has a specific structure: a triangle mesh for cloth, typically a tetrahedral mesh for deformable solids.

A particle system at coarser level $l$ contains a **proper subset** of the particles at level $l-1$. Hence a particle present at level $l$ is present in all finer levels $l-1, \dots, 0$. The **level of a particle** is defined as the coarsest level that contains it (Fig. 5).

Two kinds of constraint are distinguished: **cardinality-1** constraints and **cardinality-$n$** constraints with $n > 1$. Each level has its own set of cardinality-$n$ constraints, whereas cardinality-1 constraints belong to their particle and are used on every level that contains that particle.

Two particles are **connected (neighbours) at level $l$** if they share at least one cardinality-$n$ constraint on that level. To propagate information between levels, every level-$l$ particle must be connected to at least one level-$(l+1)$ particle; this must hold on all levels except the coarsest. The level-$(l+1)$ particles connected to a level-$l$ particle are its **parents**. Thus all particles except those on the coarsest level have at least one parent (Fig. 1).

This definition solves a main problem raised in the introduction: restricting unilateral constraints to coarser levels. In the target scenarios the only unilateral constraints are collision constraints, which usually have cardinality 1. Since cardinality-1 constraints are tied to their particle, they are simply processed as in PBD on every level on which the particle exists. The same holds for other cardinality-1 constraints such as attachments.

> Figure 1: A fine level $l$ consists of all particles shown and the dashed constraints. The next coarser level $l+1$ contains the proper subset of black particles and the solid constraints. Each fine (white) particle must be connected to at least $k$ ($=2$) black particles — its parents, shown by arrows.

### 6.2. Particle Restriction

First, how the particle subsets per level are chosen. Given the particles and connectivity on a fine level $l$, one must pick a proper subset to be the particles of coarse level $l+1$. Many choices work as long as each fine particle is connected to at least one coarse particle on the fine level. As [CFL*07] note, this is the *vertex (node) cover problem* [Pap97], which is NP-complete. Fortunately an optimal solution is unnecessary; a good sub-optimal one is fine, although a better one makes the method faster.

[CFL*07] use a greedy heuristic: mark all particles fine, then traverse the mesh marking some coarse; for disconnected meshes the process must restart per component. The paper proposes a simpler algorithm that handles a disconnected mesh in one sweep. It also handles a **stricter** version of the requirement: every fine vertex must have at least $k$ parents. For $k > 1$ the particle count shrinks more slowly from fine to coarse levels, which yields smoother error propagation but more projection work on coarse levels. The examples use $k = 2$.

```text
mark all particles coarse
for each particle: coarseNeighbors <- total number of neighbours
for each particle p, in arbitrary order:
    if p.coarseNeighbors >= k
       and every FINE neighbour n of p has n.coarseNeighbors > k   // strictly more than k
        mark p fine
        for each neighbour n of p: n.coarseNeighbors -= 1
```

(A particle becomes fine only if it keeps at least $k$ coarse neighbours itself and no already-fine neighbour would drop below $k$ coarse neighbours — i.e. $k$ parents.)

Convergence improves if **attached** particles are kept on the coarse levels, but keeping all of them on every level makes coarse meshes needlessly dense. One fix is to mark attached coarse vertices as fine only with some probability; another is to process attached vertices last, since the chance of being marked fine decreases toward the end of the sweep.

For speed, each particle $\mathbf{p}_i$ stores pointers to its parents $\mathbf{p}_j$ on the next coarser level and corresponding weights $w_{ij}$:

$$
\tilde w_{ij} = \frac{1}{\dfrac{d_{ij}}{\max_j(d_{ij})} + \varepsilon} \tag{6}
$$

**[reconstructed]** — where $d_{ij}$ is the child–parent distance in the original (rest) mesh; the normalised weights $w_{ij} = \tilde w_{ij} / \sum_j \tilde w_{ij}$ are used. The key property: if the particle coincides with one of its parents, that parent gets weight 1 and all others get zero. With $\varepsilon = 0$ this holds exactly but the non-normalised weight becomes infinite; a small $\varepsilon$ in the denominator avoids that numerical problem.

### 6.3. Constraint Restriction

The remaining question is how to generate the cardinality-$n$ constraints on coarser levels. The paper treats cardinality-2 distance constraints here and discusses higher-order constraints afterwards. Generating level-$l$ constraints from level-$(l-1)$ constraints proceeds as follows.

First all level-$(l-1)$ constraints are copied to level $l$. Some of them reference fine particles absent from level $l$. This is fixed by processing the fine particles one by one: each fine particle $\mathbf{p}_i$ is **collapsed** into one of its coarse neighbours $\mathbf{p}_j$ (Fig. 2). The constraint joining $\mathbf{p}_i$ and $\mathbf{p}_j$ is removed. For every other neighbour $\mathbf{p}_k$ of $\mathbf{p}_i$: if $\mathbf{p}_k$ is already a neighbour of $\mathbf{p}_j$, the constraint $\mathbf{p}_k$–$\mathbf{p}_i$ is removed; otherwise it is replaced by a new constraint $\mathbf{p}_k$–$\mathbf{p}_j$.

```text
C_l <- copy(C_{l-1})
for each fine particle p_i (not present on level l):
    p_j <- coarse neighbour of p_i closest to the average ORIGINAL position
           of all coarse neighbours of p_i
    remove constraint (p_i, p_j)
    for each other neighbour p_k of p_i:
        if p_k is already a neighbour of p_j: remove (p_k, p_i)
        else: replace (p_k, p_i) by new (p_k, p_j) with rest length d_kj
```

Two questions remain: how to choose $\mathbf{p}_j$ among the coarse neighbours, and how to set the new constraint's rest distance. To choose $\mathbf{p}_j$, average the original positions of all coarse neighbours of $\mathbf{p}_i$ and take the neighbour closest to that average; this gives evenly distributed edge lengths.

For the rest distance $d_{kj}$ of the new constraint there are several options. One is the **sum of rest distances** of $\mathbf{p}_k$–$\mathbf{p}_i$ and $\mathbf{p}_i$–$\mathbf{p}_j$ (Fig. 2 (b)):

$$
d_{kj} = d_{ki} + d_{ij}
$$

This mimics geodesic distance within the mesh manifold. If a cut runs through the original mesh, such constraints do not bridge the gap and correctly measure distance around the cut. However, they may be too loose, because edge paths only approximate geodesics.

Another option is the distance between $\mathbf{p}_k$ and $\mathbf{p}_j$ in the **original pose**, $d_{kj} = |\mathbf{x}^0_k - \mathbf{x}^0_j|$. For initially flat cloth this is correct; for non-flat pieces it may be too tight, forcing the cloth back to its original curved state, and it bridges cuts, which is wrong. Each choice has cases it suits.

A useful property: if the finest-level distance constraints form a triangle mesh, all coarser levels are triangle meshes too, because edge collapses preserve that property. This is especially useful for **level-of-detail physics**: objects far from the camera can use only coarse meshes, for both simulation and visualisation.

> Figure 2: Fine particle $\mathbf{p}_i$ is collapsed into its coarse neighbour $\mathbf{p}_j$. The dashed edges in (a) are removed. Constraint $\mathbf{p}_k\mathbf{p}_i$ in (a) becomes the new constraint $\mathbf{p}_k\mathbf{p}_j$ in (b); its length is computed from constraints $\mathbf{p}_k\mathbf{p}_i$ and $\mathbf{p}_i\mathbf{p}_j$.

Higher-order constraints such as bending could be generalised in a similar way. But, as noted in the introduction, deformable objects usually have low bending resistance, so bending need not be represented on coarse levels. Bending is also a local phenomenon that shows up when the material is not stretched.

## 7. Hierarchical Solver

With the hierarchy in place the multigrid algorithm is fast and simple:

```text
1. l <- l_max                                   // start at the coarsest level
2. for every particle i present on level l:  q_i <- p_i      // save positions
3. run one (or more) PBD solver iterations on level l, i.e. project
     - all cardinality-1 constraints of all level-l particles, and
     - all cardinality-n constraints of level l
   with the non-linear Gauss-Seidel solver (Sec. 5)
4. if l == 0: stop
   else: l <- l - 1                              // next finer level
5. for every particle i on level l (those not on level l+1 — see note):
       p_i <- p_i + sum_{j in P(i)} w_ij (p_j - q_j)            (7)
6. goto 2
```

$$
\mathbf{p}_i \leftarrow \mathbf{p}_i + \sum_{j \in \mathcal{P}(i)} w_{ij}\, (\mathbf{p}_j - \mathbf{q}_j) \tag{7}
$$

where $\mathcal{P}(i)$ is the set of indices of the parents of particle $i$, and $\mathbf{q}_j$ the parent's position saved before the coarse solve, so $\mathbf{p}_j - \mathbf{q}_j$ is the parent's **correction** on its level. *Note:* the text says "each particle on level $l$"; particles that also live on level $l+1$ were already moved directly by the coarser solve, so the prolongation is meaningful for those whose particle-level is exactly $l$. **[interpretation]**

## 8. Discussion

More sophisticated schemes exist: typical multigrid solvers make several passes up and down the hierarchy (V/W-cycles). The author found this single coarse-to-fine sweep sufficient to obtain the desired stiffness.

Importantly, only the **corrections** computed on a level are propagated down the hierarchy, not the newly computed positions themselves. This preserves all the small detail in the high-resolution levels.

Coarse geodesic-based distance constraints should only take effect when all the material between the adjacent particles is fully stretched; otherwise they must not influence the simulation. To guarantee that, **all distance constraints on levels above 0 are unilateral upper-limit constraints**:

$$
C_{kj}(\mathbf{p}) = d_{kj} - |\mathbf{p}_k - \mathbf{p}_j| \ \ge\ 0 \qquad (l \ge 1) \quad \textbf{[reconstructed form]}
$$

**Tearing.** A main reason games use physics is destructible environments; destructible cloth is tearable cloth. On tearing, the hierarchy must be updated. The [MHR06] tearing algorithm splits particles: a particle is cloned several times and subsets of adjacent triangles are assigned to each clone. After a split, the parent links and the adjacent constraints in the hierarchy become invalid; if kept they could bridge the cut and create ghost influences across it. The paper takes a conservative approach: first all parent links and adjacent constraints of the split particle are removed; then the algorithm walks recursively up the hierarchy along the parent links, removing constraints and parent links of the parents on coarser levels as well (Fig. 8).

**Drawbacks.** With very low iteration counts, visual artifacts can appear if the hierarchical meshes are of poor quality; raising the iteration count of the subsequent (level-0) PBD step to three or four removes them. The hierarchical solver is not as easy to parallelise as PBD's Gauss-Seidel solver; currently it is run sequentially before starting the parallel PBD solver. Bending constraints are not considered on higher levels, a restriction of the current implementation. While higher stretching stiffness improves cloth quality, higher bending stiffness usually removes small detail and wrinkles — and that effect can be obtained simply by making the simulation mesh coarser.

## 9. Results

The method was integrated into a real-time physics engine. Results in the paper and video were recorded on an Intel Core2 at 2.66 GHz, 2 GB RAM, NVIDIA GeForce 8800 GTX.

PBD has become popular in game physics; it was recently used in the open-source engine *Bullet* for its new soft-body feature. The method targets developers already using PBD who want it substantially faster, so it is compared against original PBD rather than more complex solvers.

Fig. 3 plots the number of solver iterations needed to keep the stretch of a cloth piece (shown in Fig. 6) under gravity below a given value. The cloth has 126 rows of triangles, which makes propagation of pressure waves through it slow without the hierarchy. The curves clearly show the benefit of the hierarchical approach.

> Figure 3: Number of regular PBD iterations (y axis, 0–30) needed to limit the stretch of a cloth piece with 126 rows of triangles hanging under gravity to a given relative stretch (x axis, 25 % down to 5 %), with no hierarchy and with 3 and 5 hierarchy levels. (Curve values are not recoverable from the extracted text; qualitatively, iteration count rises steeply as the stretch target tightens without a hierarchy and stays far lower with 3 and especially 5 levels.)

Fig. 7 shows the effect of the multigrid solver and of iteration count. Each time step first runs the multigrid solver of Sec. 7. Then, because the multigrid pass does not touch the original level-0 constraints, the original Gauss-Seidel solver is run **twice**, the second iteration processing constraints in **reverse order**, which makes the process symmetric. The cloth has **11,500 triangles** and runs at **60 fps**. Switching the multigrid part off while keeping two iterations gives almost no speed-up, because the total number of constraints in the whole hierarchy is typically smaller than on level 0 — but with only two iterations the material becomes very stretchy. More iterations stiffen the cloth but slow the simulation; only at about **20 iterations** does stiffness match the multigrid result, and the frame rate then drops to about **12 fps**. This example uses a regular base mesh (Fig. 6), suitable for flags or canvases, where the hierarchy can be generated directly from coarser versions of the base structure.

To test irregular meshes, a woman in a long dress was simulated (Fig. 5); results are in Fig. 4. The whole simulation, including character animation and character–cloth interaction, runs at about **30 fps**. Without the multigrid solver, wind and floor friction stretch the dress significantly; as the second and fourth images show, the multigrid approach makes inextensible cloth possible at interactive rates.

> Figure 4: The multigrid solver makes real-time simulation of high-resolution cloth possible. In the first and third image, friction and wind make cloth simulated conventionally look stretchy; in the second and fourth, this artifact is gone with no noticeable performance drop.

> Figure 5: The particle system defined by the irregular cloth mesh is reduced step by step to build a hierarchy. A particle in a given level is also contained in all finer levels.

> Figure 6: Regular meshes can often be used, e.g. for flags or canvases; then the hierarchy can be built directly, without the general reduction algorithm.

> Figure 7: The cloth on the left uses the multigrid algorithm plus two regular iterations. The others are simulated conventionally with 2, 5, 10 and 20 iterations. The same stiffness is reached only with 20 iterations, at about one fifth of the frame rate.

> Figure 8: When the cloth is torn, the hierarchy must be updated on all levels.

## 10. Conclusions and Future Work

The paper presents a non-linear multigrid algorithm that speeds up PBD substantially. PBD's good properties — simplicity and stability — are kept while slow error propagation is removed.

Future work: improving tearing — the current procedure is conservative and usually removes more constraints than necessary, making the cloth weaker than it should be along the tear line; other methods for generating coarser meshes; and porting the method to the author's soft-body engine, expected to be straightforward because the method is not restricted to triangles.

## References

- [BFA02] Bridson, Fedkiw, Anderson: Robust treatment of collisions, contact and friction for cloth animation. SIGGRAPH 2002, 594–603.
- [BJ07] Barbič, James: Time-critical distributed contact for 6-DoF haptic rendering of adaptively sampled reduced deformable models. SCA 2007, 171–180.
- [CFL*07] Chentanez, Feldman, Labelle, O'Brien, Shewchuk: Liquid simulation on lattice-based tetrahedral meshes. SCA 2007, 219–228.
- [CGC*02] Capell, Green, Curless, Duchamp, Popović: A multiresolution framework for dynamic deformations. SCA 2002, 41–47.
- [DDCB01] Debunne, Desbrun, Cani, Barr: Dynamic real-time deformations using space and time adaptive sampling. SIGGRAPH 2001.
- [DSB99] Desbrun, Schröder, Barr: Interactive animation of structured deformable objects. Graphics Interface 1999, 1–8.
- [Ebe04] Eberly: Game Physics. Elsevier, 2004.
- [Fau98] Faure: Interactive solid animation using linearized displacement constraints. Eurographics Workshop on Computer Animation and Simulation 1998, 61–72.
- [GHF*07] Goldenthal, Harmon, Fattal, Bercovier, Grinspun: Efficient simulation of inextensible cloth. ACM TOG 26(3), 2007, 49.
- [GM97] Gibson, Mirtich: A survey of deformable models in computer graphics. MERL TR-97-19, 1997.
- [GW06] Georgii, Westermann: A multigrid framework for real-time simulation of deformable bodies. Computers & Graphics 30(3), 2006, 408–415.
- [HSO03] Hauser, Shen, O'Brien: Interactive deformation using modal analysis with constraints. Graphics Interface 2003.
- [Jak01] Jakobsen: Advanced character physics. Gamasutra 2001.
- [JP99] James, Pai: ArtDefo: accurate real time deformable objects. SIGGRAPH 1999, 65–72.
- [McC87] McCormick: Multigrid Methods. SIAM, 1987.
- [MG04] Müller, Gross: Interactive virtual materials. Graphics Interface 2004, 239–246.
- [MHR06] Müller, Heidelberger, Hennix, Ratcliff: Position based dynamics. VRIPHYS 2006, 71–80.
- [MHTG05] Müller, Heidelberger, Teschner, Gross: Meshless deformations based on shape matching. SIGGRAPH 2005, 471–478.
- [NMK*05] Nealen, Müller, Keiser, Boxerman, Carlson: Physically based deformable models in computer graphics. Eurographics STAR 2005.
- [OGRG07] Otaduy, Germann, Redon, Gross: Adaptive deformations with fast tight bounds. SCA 2007, 181–190.
- [Pap97] Papadimitriou: Computational Complexity. Addison-Wesley, 1997.
- [Pro95] Provot: Deformation constraints in a mass-spring model to describe rigid cloth behavior. Graphics Interface 1995, 147–154.
- [TPBF87] Terzopoulos, Platt, Barr, Fleischer: Elastically deformable models. SIGGRAPH 1987, 205–214.
- [VCMT95] Volino, Courchesne, Magnenat-Thalmann: Versatile and efficient techniques for simulating cloth and other deformable objects. SIGGRAPH 1995, 137–144.
- [WT04] Wu, Tendick: Multigrid integration for interactive deformable body simulation. ISMS 2004, 92–104.
