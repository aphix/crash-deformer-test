# Meshless Deformations Based on Shape Matching

**Authors:** Matthias Müller (NovodeX/AGEIA & ETH Zürich), Bruno Heidelberger (ETH Zürich), Matthias Teschner (University of Freiburg), Markus Gross (ETH Zürich)
**Venue:** ACM SIGGRAPH 2005 (ACM Transactions on Graphics 24(3))

> Rewrite note: section order, headings, equations, parameters and figure captions follow the paper; prose is paraphrased and condensed. Equation numbers match the paper. Where PDF extraction mangled an equation, the LaTeX was rebuilt from the surrounding derivation and checked algebraically; such spots are marked `[reconstructed]`.

> Figure 1: Teaser — many deformable objects piled up; the method stays stable in all situations and runs hundreds of deformable objects in real time.

## Abstract

The paper introduces a geometrically motivated way to simulate deformable objects. It works on point sets, needs no connectivity, no pre-processing, is cheap to evaluate and is unconditionally stable.

The central move is to drop elastic energies and forces in favour of geometric constraints: each point is pulled toward a *goal position*, and the pull is proportional to the distance between the current and the goal position. Goal positions come from a generalized shape matching between the undeformed rest configuration and the current deformed point cloud. Because every point is attracted to a well-defined target, the overshoot that destabilizes explicit integrators cannot occur. The authors argue that the flexibility in object representation, the low memory/compute cost and the unconditional stability make the method a good fit for games.

**CR Categories:** I.3.5 [Computer Graphics]: Computational Geometry and Object Modeling — Physically Based Modeling; I.3.7 [Computer Graphics]: Three-Dimensional Graphics and Realism — Animation and Virtual Reality.

**Keywords:** deformable modeling, geometric deformation, shape matching, real-time simulation.

## 1 Introduction

Deformable modelling in graphics goes back to Terzopoulos et al. [1987]. The many models proposed since then mostly target accurate material behaviour, numerical stability, and support for advanced effects such as plasticity or fracture. Even so, games rarely use them: apart from some cloth with simple geometry, game physics is dominated by rigid bodies, and jointed rigid bodies are the usual substitute. No practical, stable and efficient solution existed for elastically deformable 3D solids. The authors name three obstacles:

**Efficiency.** Physically accurate material laws combined with implicit (stable) integration are expensive and do not allow interactive rates at reasonable geometric complexity. They may also require special object representations and are hard to implement and debug. A game can only spend a small slice of its frame on deformation, and volumetric representations are often unavailable because game assets are surface meshes.

**Stability.** An interactive simulation must never blow up. Besides integrator stability, there are other error sources — degenerate geometry, physically inconsistent states, large interpenetrations — that most methods ignore. Irving et al. [2004] handled large deformation and element inversion robustly in FEM, but not at interactive cost.

**Controllability.** In games, the developer must be able to control the size and shape of a deformation; some loss of realism is acceptable as long as the result looks plausible (cf. Barzel et al. [1996], Barzel [1997] on plausible vs. accurate simulation).

Contributions claimed by the paper:

- Elasticity is obtained by pulling the deformed geometry toward a well-defined goal configuration produced by an extended shape-matching step.
- The richness of representable deformation is tunable via linear and quadratic deformation modes; splitting an object into clusters adds further degrees of freedom.
- Many kinds of objects work, because only points are processed — no connectivity or special representation is required.
- No pre-processing and no large auxiliary data structures; parameters are few and intuitive ("plug and simulate").
- The dynamics are stable for every configuration; ill-shaped or inverted elements are not an issue, and even non-manifold meshes with arbitrary triangles can be simulated.
- Everything is simple to implement and cheap in memory and time.

Related to this work, Metaxas and Terzopoulos [1992] derived dynamic models from global deformations of solid primitives (spheres, cylinders, cones, superquadrics). The deformation modes used here are also related to modal analysis [Pentland and Williams 1989; Hauser et al. 2003; James and Pai 2004], but they are *not* derived from elasto-mechanical properties (which typically needs auxiliary tetrahedral meshes [James and Pai 2002]). They are purely geometric, which removes the pre-processing stage. The model is not physically derived, yet the authors show its deformation capability is comparable to modal models, without modal decompositions or stored mode vectors.

The method builds on shape matching [Shoemake and Duff 1992; Alexa et al. 2000; Kent et al. 1992]. Classic shape matching mostly deals with finding correspondences between two shapes [Faugeras and Hebert 1983; Horn 1987; Besl and McKay 1992; Kazhdan et al. 2004]; here correspondences are known a priori, so what remains is the least-squares optimal rigid transform between two corresponded point clouds [Kanatani 1994; Umeyama 1991; Lorusso et al. 1995]. The paper extends this from optimal rigid to optimal *linear* and *quadratic* transforms.

## 2 Related Work

Deformable objects have been simulated with finite differences [Terzopoulos et al. 1987], mass-spring systems [Baraff and Witkin 1998; Desbrun et al. 1999], the Boundary Element Method [James and Pai 1999], the Finite Element Method [Debunne et al. 2001; Müller et al. 2002; Müller and Gross 2004], the Finite Volume Method [Teran et al. 2003], implicit surfaces [Desbrun and Cani 1995] and mesh-free particle systems [Desbrun and Cani 1996; Tonnesen 1998; Müller et al. 2004].

Beyond accuracy-focused work there are acceleration strategies: robust large-step integration [Baraff and Witkin 1998], multi-resolution models [Debunne et al. 2001; Capell et al. 2002; Grinspun et al. 2002], modal analysis that trades accuracy for speed [Pentland and Williams 1989; Shen et al. 2002; James and Pai 2002], and data-driven methods with precomputed state-space dynamics and impulse responses [James and Pai 1999].

## 3 Meshless Animation

Rigid bodies, deformables and fluids are all usually built on Newton's second law: departures from equilibrium create forces, the forces accelerate material back toward equilibrium, and accelerations and velocities are integrated numerically to get positions.

Implicit integrators are stable for any time step but need a linear (or nonlinear) system solve each step, which is costly for interactive use. Explicit integrators are cheap but only conditionally stable; explicit Euler, for example, is unconditionally *unstable* on an undamped linear mass-spring system [Eberly 2003].

This section first shows where explicit schemes lose stability, then derives a purely geometric scheme that is both cheap and unconditionally stable. All explicit schemes share the same failure mode, so a modified (symplectic) Euler method is used as the running example and as the basis of the new scheme.

### 3.1 Explicit Numerical Integration

Consider an undamped linear spring with rest length $l_0$ and stiffness $k$ (Fig. 2). One end is fixed at the origin; the other end is a point of mass $m$ at position $x(t)$, pulled toward equilibrium $x = l_0$ by $f = -k\,(x(t) - l_0)$. With the modified Euler scheme

$$
v(t+h) = v(t) + h\,\frac{-k\,(x(t) - l_0)}{m}, \qquad
x(t+h) = x(t) + h\,v(t+h), \tag{1}
$$

velocity is advanced with an explicit Euler step and position with an implicit Euler step that uses the freshly predicted velocity. For the state $[v\;x]^T$ this gives the system matrix

$$
\mathbf{A} = \begin{bmatrix} 1 & -\dfrac{hk}{m} \\[4pt] h & 1 - \dfrac{h^2 k}{m} \end{bmatrix} \tag{2}
$$

with eigenvalues

$$
e_0 = 1 - \frac{1}{2m}\left(h^2 k - \sqrt{-4mh^2k + h^4k^2}\right), \tag{3}
$$

$$
e_1 = 1 - \frac{1}{2m}\left(h^2 k + \sqrt{-4mh^2k + h^4k^2}\right). \tag{4}
$$

For a discrete linear system to be stable the spectral radius (largest $|e_i|$) must not exceed one. $|e_0|$ stays below one and tends to 1 as $h^2 k \to \infty$, but $|e_1| \le 1$ only holds while $h < 2\sqrt{m/k}$. Larger steps make the system blow up, so the scheme is only conditionally stable. *(Note: $\det\mathbf{A} = 1$, so for $h < 2\sqrt{m/k}$ the eigenvalues are a complex pair of modulus exactly 1.)*

A single step from rest ($v(t) = 0$) makes the problem concrete: the point moves by $\Delta x = -\frac{h^2 k}{m}\,(x(t) - l_0)$. If $h$ or $k$ is too large, or $m$ too small, the point jumps past $l_0$ to a spot where the spring is stretched *more* than before (Fig. 2, bottom). Since the step started with zero kinetic energy, total energy has wrongly increased, and the next step is worse because the restoring force is now even larger.

In general terms: elastic forces are negative energy gradients and point toward equilibrium, but an explicit scheme scales them blindly into displacements, which can overshoot equilibrium and raise the energy instead of conserving or lowering it. One remedy would be to clamp displacements so points never pass their equilibrium (goal) positions. In the 1D spring the goal is trivially $x = l_0$; for general geometry — solid FE meshes, complex meshes — per-point goals are not obvious. The proposed method supplies exactly such goals.

> Figure 2: A linear spring (fixed end at 0, free mass $m$ at $x(t)$, rest length $l_0$) integrated with Eq. (1). With a too-large step the internal force pushes the point from $x(t)$ to $x(t+h)$ beyond $l_0$, increasing the system's energy.

### 3.2 The Algorithm

The geometric algorithm needs only a set of particles with masses $m_i$ and initial (rest) positions $\mathbf{x}_i^0$ — no mesh or connectivity. Particles are integrated as an ordinary particle system with no particle–particle forces, but with collision response against the environment and external forces such as gravity. After every step each particle is pulled toward its goal $\mathbf{g}_i$. The goals come from matching the rest shape $\{\mathbf{x}_i^0\}$ to the current shape $\{\mathbf{x}_i\}$ (Fig. 3). The next two subsections cover the matching and the pull.

> Figure 3: First the rest shape $\mathbf{x}_i^0$ is optimally matched (rotated $\mathbf{R}$ and translated) onto the deformed points $\mathbf{x}_i$, yielding goals $\mathbf{g}_i$; then each deformed point is pulled toward its goal.

### 3.3 Shape Matching

With known correspondences, the problem reads: given point sets $\mathbf{x}_i^0$ and $\mathbf{x}_i$, find the rotation $\mathbf{R}$ and translations $\mathbf{t}$, $\mathbf{t}_0$ minimizing

$$
\sum_i w_i \left(\mathbf{R}(\mathbf{x}_i^0 - \mathbf{t}_0) + \mathbf{t} - \mathbf{x}_i\right)^2, \tag{5}
$$

with per-point weights $w_i$; the natural choice is $w_i = m_i$. The optimal translations are the centres of mass of the rest and current shapes:

$$
\mathbf{t}_0 = \mathbf{x}^0_{cm} = \frac{\sum_i m_i \mathbf{x}_i^0}{\sum_i m_i}, \qquad
\mathbf{t} = \mathbf{x}_{cm} = \frac{\sum_i m_i \mathbf{x}_i}{\sum_i m_i}, \tag{6}
$$

which is physically reasonable. For the rotation, define centred coordinates $\mathbf{q}_i = \mathbf{x}_i^0 - \mathbf{x}^0_{cm}$ and $\mathbf{p}_i = \mathbf{x}_i - \mathbf{x}_{cm}$, and first relax the problem to finding the best *linear* map $\mathbf{A}$, i.e. minimize $\sum_i m_i (\mathbf{A}\mathbf{q}_i - \mathbf{p}_i)^2$. Setting all partial derivatives with respect to the entries of $\mathbf{A}$ to zero gives

$$
\mathbf{A} = \Big(\sum_i m_i \mathbf{p}_i \mathbf{q}_i^T\Big)\Big(\sum_i m_i \mathbf{q}_i \mathbf{q}_i^T\Big)^{-1} = \mathbf{A}_{pq}\,\mathbf{A}_{qq}. \tag{7}
$$

(Here $\mathbf{A}_{qq}$ denotes the *inverse* of the rest-shape moment matrix.) $\mathbf{A}_{qq}$ is symmetric and so carries only scaling, no rotation; the paper therefore takes the optimal rotation $\mathbf{R}$ to be the rotational factor of $\mathbf{A}_{pq}$, obtained by polar decomposition $\mathbf{A}_{pq} = \mathbf{R}\mathbf{S}$ with symmetric part $\mathbf{S} = \sqrt{\mathbf{A}_{pq}^T\mathbf{A}_{pq}}$ and rotation $\mathbf{R} = \mathbf{A}_{pq}\mathbf{S}^{-1}$. The goal positions are then

$$
\mathbf{g}_i = \mathbf{R}\,(\mathbf{x}_i^0 - \mathbf{x}^0_{cm}) + \mathbf{x}_{cm}. \tag{8}
$$

### 3.4 Integration

With the goals known, an integration scheme that cannot overshoot is

$$
\mathbf{v}_i(t+h) = \mathbf{v}_i(t) + \alpha\,\frac{\mathbf{g}_i(t) - \mathbf{x}_i(t)}{h} + h\,\frac{\mathbf{f}_{ext}(t)}{m_i}, \tag{9}
$$

$$
\mathbf{x}_i(t+h) = \mathbf{x}_i(t) + h\,\mathbf{v}_i(t+h), \tag{10}
$$

where $\alpha \in [0, 1]$ plays the role of stiffness. The only change versus Eq. (1) is how the elastic term enters. With $\alpha = 1$ the velocity gains $(\mathbf{g}_i - \mathbf{x}_i)/h$, so the position update lands the point exactly on its goal; with $\alpha < 1$ it moves part of the way.

For the 1D spring of Fig. 2 the scheme becomes

$$
\begin{bmatrix} v(t+h) \\ x(t+h) \end{bmatrix} =
\begin{bmatrix} 1 & -\alpha/h \\ h & 1-\alpha \end{bmatrix}
\begin{bmatrix} v(t) \\ x(t) \end{bmatrix} +
\begin{bmatrix} \alpha l_0/h \\ \alpha l_0 \end{bmatrix}. \tag{11}
$$

The eigenvalues of the system matrix are $\left(1 - \frac{\alpha}{2}\right) \pm \frac{i}{2}\sqrt{4\alpha - \alpha^2}$, whose modulus is exactly 1 for every $\alpha \in [0,1]$ and every $h$. The scheme is therefore unconditionally stable and adds no numerical damping. The authors state the same holds in 3D without external forces, and stays true as long as external forces do not depend on positions (e.g. gravity) or act only instantaneously (e.g. collision impulses), because then the system matrix is unchanged.

### 3.5 Discussion

Implementation is cheap. $\mathbf{x}^0_{cm}$ and all $\mathbf{q}_i$ can be precomputed. Per step one assembles the $3\times3$ matrix $\mathbf{A}_{pq} = \sum_i m_i \mathbf{p}_i \mathbf{q}_i^T$; to get $\sqrt{\mathbf{A}_{pq}^T\mathbf{A}_{pq}}$ the symmetric matrix $\mathbf{A}_{pq}^T\mathbf{A}_{pq}$ is diagonalized with 5–10 Jacobi rotations — constant cost, independent of point count. In this basic form the method suits stiff or nearly rigid objects; Sections 4.2 and 4.3 lift that restriction for large deformations.

Matching about the centres of mass makes the impulses added in Eq. (9) sum to zero, so linear momentum is conserved. Using $m_i$ as weights in the matching and in $\mathbf{A}_{pq}$ also enforces conservation of angular momentum.

One flaw of Eq. (9) is time-step dependence: the velocity change per step is the same regardless of $h$. The fix is $\alpha = h/\tau$ with a time constant $\tau$. *(The extracted text reads "$\tau \le h$"; for $\alpha \le 1$ this must be $\tau \ge h$ — `[reconstructed]`.)*

## 4 Extensions

### 4.1 Rigid Body Dynamics

Setting $\alpha = 1$ turns the method into a rigid-body imitation: every step the points snap exactly to their goals, which are a rotated and translated copy of the rest shape. For an arbitrary surface mesh only a small subset of vertices needs to be simulated as particles; all other vertices are carried along with the per-step $\mathbf{R}$ and $\mathbf{t}$. The same "simulate few, skin many" idea applies to all following extensions.

> Figure 4: Three cubes. Plain (rotation-only) shape matching handles nearly rigid objects well (third cube); the linear and quadratic extensions (middle and first cube) permit large departures from the rest shape.

### 4.2 Linear Deformations

Rotation-only goals permit only small deviations from the rigid shape. To widen the range, the best-fit linear map $\mathbf{A}$ of Eq. (7) is reused: instead of $\mathbf{R}$ in Eq. (8), the goals are computed with

$$
\beta\,\mathbf{A} + (1 - \beta)\,\mathbf{R},
$$

where $\beta$ is a second control parameter. The goal shape can now undergo a linear transformation, while the $\mathbf{R}$ term keeps a pull toward the undeformed shape. To conserve volume, $\mathbf{A}$ is divided by $\sqrt[3]{\det(\mathbf{A})}$ so that $\det(\mathbf{A}) = 1$. Unlike the rigid case, which needs only $\mathbf{A}_{pq}$, this variant also needs $\mathbf{A}_{qq} = \left(\sum_i m_i \mathbf{q}_i \mathbf{q}_i^T\right)^{-1}$; being a constant symmetric $3\times3$ matrix it is precomputed.

### 4.3 Quadratic Deformations

Linear maps express only shear and stretch. To add bending and twisting the paper moves to quadratic maps (Fig. 4):

$$
\mathbf{g}_i = [\mathbf{A}\;\mathbf{Q}\;\mathbf{M}]\;\tilde{\mathbf{q}}_i, \tag{12}
$$

with $\mathbf{g}_i \in \mathbb{R}^3$ and the extended rest coordinate

$$
\tilde{\mathbf{q}} = [q_x,\, q_y,\, q_z,\, q_x^2,\, q_y^2,\, q_z^2,\, q_x q_y,\, q_y q_z,\, q_z q_x]^T \in \mathbb{R}^9 .
$$

$\mathbf{A} \in \mathbb{R}^{3\times3}$ holds the linear coefficients, $\mathbf{Q} \in \mathbb{R}^{3\times3}$ the pure quadratic ones and $\mathbf{M} \in \mathbb{R}^{3\times3}$ the mixed ones. With $\tilde{\mathbf{A}} = [\mathbf{A}\;\mathbf{Q}\;\mathbf{M}] \in \mathbb{R}^{3\times9}$ the objective becomes $\sum_i m_i(\tilde{\mathbf{A}}\tilde{\mathbf{q}}_i - \mathbf{p}_i)^2$, minimized by

$$
\tilde{\mathbf{A}} = \Big(\sum_i m_i \mathbf{p}_i \tilde{\mathbf{q}}_i^T\Big)\Big(\sum_i m_i \tilde{\mathbf{q}}_i \tilde{\mathbf{q}}_i^T\Big)^{-1} = \tilde{\mathbf{A}}_{pq}\,\tilde{\mathbf{A}}_{qq}. \tag{13}
$$

The symmetric $\tilde{\mathbf{A}}_{qq} \in \mathbb{R}^{9\times9}$ and all $\tilde{\mathbf{q}}_i$ are precomputed. As in the linear case the goals use

$$
\beta\,\tilde{\mathbf{A}} + (1-\beta)\,\tilde{\mathbf{R}}, \qquad \tilde{\mathbf{R}} = [\mathbf{R}\;\mathbf{0}\;\mathbf{0}] \in \mathbb{R}^{3\times9}.
$$

The authors describe this as a cheap imitation of modal-analysis methods; the linear (shear/stretch) modes and the extra bend/twist modes are visualized in Fig. 5.

> Figure 5: All $3\times9$ deformation modes, one per coefficient of $\tilde{\mathbf{A}} = [\mathbf{A}\;\mathbf{Q}\;\mathbf{M}]$ from Eq. (12), shown as deformed cubes.

### 4.4 Cluster Based Deformation

For even more freedom the particle set is split into *overlapping* clusters. One option would be a volumetric mesh where the vertices are particles and the vertices of each element (e.g. tetrahedron) form a cluster. The paper instead divides the space around a surface mesh into a regular grid of overlapping cubical regions and makes one cluster from the vertices inside each region.

Each integration step, every cluster's rest shape is matched to its current shape, and every cluster then contributes to each of its particles

$$
\Delta\mathbf{v}_i = \alpha\,\frac{\mathbf{g}_i^c(t) - \mathbf{x}_i(t)}{h}, \tag{14}
$$

where $\mathbf{g}_i^c(t)$ is particle $i$'s goal with respect to cluster $c$. (The contributions are added; the paper does not normalize by the number of clusters a particle belongs to.)

> Figure 6: A cube built from 8 clusters after plastic deformation — two different deformed rest states.

### 4.5 Plasticity

The linear model extends naturally to plasticity. Polar decomposition gives $\mathbf{A} = \mathbf{R}\mathbf{S}$ with $\mathbf{S} = \mathbf{R}^T\mathbf{A}$ the pure deformation. Since $\mathbf{S}$ sits to the right of $\mathbf{R}$, it is expressed in the initial, unrotated reference frame. Every cluster keeps a plastic state matrix $\mathbf{S}_p$, initialized to $\mathbf{I}$. Each step, if the current deformation $\|\mathbf{S} - \mathbf{I}\|_2$ exceeds a yield threshold $c_{yield}$, the state is updated by

$$
\mathbf{S}_p \leftarrow \left[\mathbf{I} + h\,c_{creep}\,(\mathbf{S} - \mathbf{I})\right]\mathbf{S}_p, \tag{15}
$$

with $h$ the time step and $c_{yield}$, $c_{creep}$ the plasticity controls, following O'Brien et al. [2002]. Total plastic strain is bounded: if $\|\mathbf{S}_p - \mathbf{I}\|_2 > c_{max}$, set

$$
\mathbf{S}_p \leftarrow \mathbf{I} + c_{max}\,\frac{\mathbf{S}_p - \mathbf{I}}{\|\mathbf{S}_p - \mathbf{I}\|_2}.
$$

To keep plasticity volume-neutral, $\mathbf{S}_p$ is divided by $\sqrt[3]{\det(\mathbf{S}_p)}$ after each update. Finally the plastic state deforms the rest shape by redefining the centred rest coordinates of Eq. (7) as

$$
\mathbf{q}_i = \mathbf{S}_p\,(\mathbf{x}_i^0 - \mathbf{x}^0_{cm}). \tag{16}
$$

Whenever $\mathbf{S}_p$ changes, $\mathbf{A}_{qq}$ (or $\tilde{\mathbf{A}}_{qq}$) must be recomputed. Fig. 6 shows two rest states reached through plastic flow; the cube is split into 8 clusters for more detail.

*(Rewrite note: this section speaks of polar-decomposing $\mathbf{A}$, while Section 3.3 takes $\mathbf{R}$ from $\mathbf{A}_{pq}$. The two rotations coincide only when $\mathbf{A}_{qq}$ is isotropic; the paper does not comment on the difference.)*

**Per-step algorithm (summary of Sections 3–4, linear + clusters + plasticity):**

```text
precompute per cluster c: x0_cm, q_i = x0_i - x0_cm, Aqq = (Σ m_i q_i q_iᵀ)⁻¹, Sp = I
each step h:
  for each particle i:  v_i += h * f_ext_i / m_i                       # external forces
  for each cluster c:
    x_cm  = Σ m_i x_i / Σ m_i
    p_i   = x_i - x_cm
    Apq   = Σ m_i p_i q_iᵀ
    R     = rotational part of Apq   (S = sqrt(Apqᵀ Apq) via Jacobi, R = Apq S⁻¹)
    A     = Apq Aqq ;  A /= cbrt(det A)                                 # linear mode, volume kept
    T     = β A + (1-β) R
    g_i   = T q_i + x_cm
    v_i  += α (g_i - x_i) / h                                           # Eq. (9) / (14), summed over clusters
    # plasticity (optional)
    S = Rᵀ A
    if ||S - I|| > c_yield:  Sp = [I + h c_creep (S - I)] Sp
    if ||Sp - I|| > c_max:   Sp = I + c_max (Sp - I)/||Sp - I||
    Sp /= cbrt(det Sp);  q_i = Sp (x0_i - x0_cm);  recompute Aqq
  for each particle i:  x_i += h * v_i                                 # Eq. (10), then collisions
```

## 5 Results

The method was integrated into a game-like environment for deformable objects, and experiments measured behaviour and cost. All timings are on a Pentium 4 at 3.2 GHz. A direct cost comparison with FEM or mass-spring models is hard, because the cost here depends on the chosen deformation modes and cluster count, which have no FEM/mass-spring equivalent (Fig. 8).

**Complex simulation scenarios.** Fig. 9 has 384 objects with 2,448 clusters and 55,200 points; quadratic shape matching costs between 0.008 and 0.096 ms per object per frame, depending on object complexity. The teaser (Fig. 1) animates 145 objects, 1,728 clusters and 24,618 points; quadratic shape matching costs 0.12 ms per object per frame.

**Interactivity.** Fig. 10 shows objects of typical game complexity: a head of 8 clusters and 66 points, and spheres of 1 cluster and 13 points. For visual quality they are skinned with surface meshes of 6,460 and 2,000 faces. The scene runs interactively including dragger interaction, collision handling and rendering.

**Cluster based deformation.** Fig. 7 shows three quadratically deforming sticks of 60 points each, split into one, two and five clusters. The same spring force is applied at the same surface point from the same location in each case. More clusters give more detailed deformation and better physical plausibility. Cluster count is user-chosen: one cluster may do for simple, sphere-like shapes, while complex shapes may need subdivision.

**Stability.** Fig. 11 shows that degenerate geometry is handled. Together with the unconditionally stable integrator this gives animations that stay stable whatever the user does.

**Performance.** Cost depends on the number of points in the matching and the number of clusters. In the scaling experiment, points get random positions and random goal positions (a random initial displacement), and timings are taken for different point and cluster counts with the linear and quadratic models. (The rigid case costs the same as the linear one.) Fig. 8 shows cost grows linearly with point count; more clusters mean more polar decompositions and thus lower performance; the quadratic model costs more than the linear one. Even so, 100 objects of 100 points each, split into 8 clusters, run with the quadratic model at 50 frames per second.

> Figure 7: Object flexibility depends on cluster count — the same stick with one, two and five clusters (left to right).

> Figure 8: Cost in milliseconds per frame (0–5 ms) versus number of simulated points (0–10,000), for linear and quadratic models with 1, 8 and 64 clusters (curves `linear_1`, `linear_8`, `linear_64`, `quadratic_1`, `quadratic_8`, `quadratic_64`); all curves are linear in the point count.

> Figure 9: A large scene of 384 objects: the deformation dynamics run in real time, but collision detection and response do not.

> Figure 10: A head model with 8 clusters responding to user interaction and to collisions with other deformable objects.

> Figure 11: A duck model being squeezed: the method stays stable and recovers from heavily deformed or inverted configurations.

## 6 Conclusions and Future Work

The paper presents a geometric approach to deformation. It is related to modal analysis but differs in several ways: no pre-processing or auxiliary structures, cheap evaluation, and unconditional stability. Unlike modal analysis it is not physically derived. Modal methods can be made more accurate simply by adding modes; here, adding higher-order modes complicates the method and does not necessarily improve accuracy, because the modes are not tied to physical vibration modes.

A reasonable number of deformable objects can be simulated in real time, but good collision handling is required. The demos used an existing penalty-based method [Teschner et al. 2003; Heidelberger et al. 2004], which turned out to be the bottleneck; the Bounded Deformation Tree [James and Pai 2004] is a possible alternative. The authors conclude that deformable collision handling needs more research to keep pace with deformable modelling [Teschner et al. 2005].

The "plug and simulate" handling, efficiency and unconditional stability make the approach attractive for games. Plasticity was investigated as a first extension; ongoing work targets fracture, which is attractive here because changing connectivity only requires small data-structure updates.

## 7 Acknowledgements

Marco Heidelberger is thanked for the duck model. The work was funded by the Swiss Commission for Technology and Innovation (CTI), project 6310.1 KTS-ET.

## References

Reference list body omitted. Works cited by the paper that matter for this repository:

- O'Brien, Bargteil, Hodgins 2002 — *Graphical modeling and animation of ductile fracture* (SIGGRAPH 2002): source of the yield/creep plasticity model used in Section 4.5.
- Irving, Teran, Fedkiw 2004 — *Invertible finite elements for robust simulation of large deformation* (SCA 2004): robust handling of inverted elements.
- Umeyama 1991; Kanatani 1994; Horn 1987 — closed-form least-squares rigid alignment with known correspondences (the basis of Eq. 5–8).
- Shoemake and Duff 1992 — *Matrix animation and polar decomposition*: polar decomposition used to split $\mathbf{A}_{pq}$ into $\mathbf{R}\mathbf{S}$.
- Teschner et al. 2003 — optimized spatial hashing for deformable collision detection; Heidelberger et al. 2004 — consistent penetration depth estimation (the collision handling used in the demos).
- James and Pai 2004 — *BD-Tree: output-sensitive collision detection for reduced deformable models*.
- Eberly 2003 — *Game Physics*: instability of explicit Euler on undamped springs.
