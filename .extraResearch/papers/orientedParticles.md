# Solid Simulation with Oriented Particles

**Matthias Müller, Nuttapong Chentanez** — NVIDIA PhysX Research
**Venue:** SIGGRAPH 2011 (ACM Transactions on Graphics 30(4))

> Rewrite note: prose below is a condensed paraphrase, section by section, in the paper's order. Equations are transcribed in LaTeX and were checked against a rendering of the PDF pages (not only the text extraction). Notes in *[brackets]* are the rewriter's, not the authors'.

> Figure 1: A monster truck simulated with oriented particles — the body deforms plastically, the wheels spin freely on soft tires, and a high-resolution visual mesh is skinned in real time, all driven by a sparse physical model.

## Abstract

The paper presents a fast, robust way to simulate many kinds of solids — rigid, plastic and soft — and structures of any dimension (1D ropes, 2D cloth, 3D volumes). The core idea is to give each particle a **rotation and an angular velocity (spin)** in addition to position and velocity. This extra state pays off three ways:

1. particles can have anisotropic shapes (ellipsoids), which approximate surfaces better than spheres;
2. shape matching stays robust for sparse configurations — chains of particles, or even a single particle — because the degrees of freedom that positions alone cannot pin down are carried by the particles' rotational state;
3. the full per-particle rigid transform (translation + rotation) gives a robust way to skin a visual mesh and to map plastic deformation back into the rest state.

**CR Categories:** I.3.5 [Computer Graphics]: Computational Geometry and Object Modeling — Physically Based Modeling; I.3.7 [Computer Graphics]: Three-Dimensional Graphics and Realism — Animation and Virtual Reality.

**Keywords:** oriented particles, shape matching, position based dynamics.

## 1 Introduction

Graphics cares more about overall look-and-feel and artist control than about reproducing small-scale physical behaviour exactly. The recent trend has been toward more accurate (continuum-mechanics) models, which offer physical parameters such as Young's modulus and converge under refinement, but at the price of complexity.

Games, by contrast, value speed and robustness, so unconditionally stable geometric methods such as position based dynamics (PBD) [Müller et al. 2006] are often enough. The authors therefore aim for the simplest and fastest method that still gives the visual fidelity graphics needs, built by generalizing PBD and shape matching [Müller et al. 2005]. Combining **oriented particles with shape matching** lets complex dynamic objects be built from few simulation particles, so turning a visual mesh into a physical object takes minutes.

Contributions of the first part:

- an extension of PBD that handles particle orientation and angular velocity;
- a generalized shape-matching formulation that uses particle orientations and is stable for any number and arrangement of particles;
- use of the orientation to (1) approximate shapes with ellipsoids for more accurate collisions and (2) skin a visual mesh to the simulation nodes.

The second part describes the content-creation and simulation framework built on the method, and a set of demo scenes.

## 2 Related Work

*Unified solvers.* Stam [2009] models solids with simplices of different dimension. O'Brien et al. [1997], Jansson and Vergeest [2003] and Lenoir and Fonteneau [2004] couple deformable and rigid bodies; Sifakis et al. [2007] use soft/hard bindings between representations. Point-based continuum methods [Müller et al. 2004; Pauly et al. 2005; Gerszewski et al. 2009] derive a deformation field from particles with moving least squares (MLS), which is only stable for non-degenerate neighbourhoods. Martin et al. [2010] fixed this with **elastons**, which also store derivatives so that 0D–3D configurations work via generalized MLS (GMLS) — but not in real time.

The authors apply the same idea to geometric shape matching: plain shape matching also breaks for singular particle arrangements, and storing orientation on particles fixes it. Orientations can be seen as derivative information of a normalized deformation field, i.e. the simplest extra datum that removes the singularity, and much cheaper than elastons.

Becker et al. [2009] use SPH-style forces on particles and handle degenerate cases with a stabilized polar decomposition [Schmedding and Teschner 2008]. There the missing rotation is filled in **statically**, not simulated: for a single particle the stabilized decomposition always yields the identity, whereas here angular quantities evolve physically. A further problem arises when two eigenvalues of the moment matrix are zero — permanently the case for a stretched 1D structure. One missing eigenvector can be recovered by a cross product, but two cannot be chosen uniquely; to avoid jitter they must be chosen consistently over time, which requires a state variable — exactly what per-particle orientation supplies.

*Rods, cloth, shells, FEM.* Elastic rods via Cosserat theory as a boundary value problem [Pai 2002] lack a running-time bound; Bertails et al. [2006], Spillmann and Teschner [2007] and Bertails [2009] reduce this to quadratic/linear time; Bergou et al. [2010] simulate viscous threads with discrete differential geometry. Cloth: mass-spring networks [Provot 1995], semi-implicit integration [Baraff and Witkin 1998; Bridson et al. 2003], nonlinear springs [Volino et al. 2009], strain limiting [Goldenthal et al. 2007]; thin shells [Grinspun et al. 2003]. Volumetric solids are commonly linear tetrahedral FEM, used for fracture [O'Brien and Hodgins 1999] and plasticity [O'Brien et al. 2002; Bargteil et al. 2007; Wojtan and Turk 2008]; the co-rotational formulation [Müller and Gross 2004] reduces large-deformation artifacts; polyhedral elements [Martin et al. 2008] reduce element counts.

The term "oriented particle" comes from Szeliski and Tonnesen [1992], who used orientation to build energy potentials so unconnected particles form surfaces. That work is quite different: no mesh, isotropic particles, no collision handling, no skinning.

## 3 Generalized Shape Matching

Shape matching is the core of the method, so the authors first show how it profits from per-particle orientation.

Given $n$ particles with rest positions $\bar{\mathbf{x}}_i$, current positions $\mathbf{x}_i$ and masses $m_i$, we seek the translation $\mathbf{t}$ and rotation $\mathbf{R}$ of the rest shape that best fit the current positions in the least-squares sense. This requires the moment matrix

$$
\mathbf{A} = \sum_i m_i (\mathbf{x}_i - \mathbf{c})(\bar{\mathbf{x}}_i - \bar{\mathbf{c}})^T \in \mathbb{R}^{3\times 3}, \tag{1}
$$

with the mass centers

$$
\mathbf{c} = \sum_i m_i \mathbf{x}_i \Big/ \sum_i m_i \quad\text{and} \tag{2}
$$

$$
\bar{\mathbf{c}} = \sum_i m_i \bar{\mathbf{x}}_i \Big/ \sum_i m_i. \tag{3}
$$

The polar decomposition $\mathbf{A} = \mathbf{R}\mathbf{S}$ gives the least-squares optimal rotation $\mathbf{R}$, and the translation is $\mathbf{t} = \mathbf{c} - \bar{\mathbf{c}}$. Each particle's goal position is then

$$
\mathbf{g}_i = \mathbf{R}(\bar{\mathbf{x}}_i - \bar{\mathbf{c}}) + \mathbf{c}. \tag{4}
$$

When the particles are nearly co-planar or co-linear, $\mathbf{A}$ is ill-conditioned or singular, $\mathbf{R}$ is not well defined and the simulation becomes unstable. Particle orientations fix this.

**Combining groups.** Two groups with moment matrices $\mathbf{A}_1$, $\mathbf{A}_2$ cannot simply be summed, because each is taken about its own center of mass. Rivers and James [2007] rewrote Eq. (1) in a form suited to summation:

$$
\mathbf{A} = \sum_i m_i \mathbf{x}_i \bar{\mathbf{x}}_i^T - M \mathbf{c}\bar{\mathbf{c}}^T, \tag{5}
$$

with $M = \sum_i m_i$. Suppose each single particle had its own moment matrix $\mathbf{A}_i$ about its own center $\mathbf{x}_i$. Using Eq. (5), each $\mathbf{A}_i$ is shifted to the common center:

$$
\mathbf{A} = \sum_i \left( \mathbf{A}_i + m_i \mathbf{x}_i \bar{\mathbf{x}}_i^T - m_i \mathbf{c}\bar{\mathbf{c}}^T \right) \tag{6}
$$

so that Eq. (1) generalizes to the key formula

$$
\boxed{\;\mathbf{A} = \sum_i \left( \mathbf{A}_i + m_i \mathbf{x}_i \bar{\mathbf{x}}_i^T \right) - M \mathbf{c}\bar{\mathbf{c}}^T\;} \tag{7}
$$

**Moment matrix of one particle.** For a particle with orthonormal orientation $\mathbf{R}$, integrating Eq. (1) over its volume gives, for a sphere of radius $r$ and volume $V_r$ (density $\rho$),

$$
\mathbf{A}_{\text{sphere}} = \int_{V_r} \rho (\mathbf{R}\mathbf{x})\mathbf{x}^T \, dV = \rho \mathbf{R} \int_{V_r} \mathbf{x}\mathbf{x}^T \, dV
= \frac{4}{15}\pi r^5 \rho \mathbf{R} = \frac{4}{15}\pi r^5 \frac{m}{V_r} \mathbf{R} = \frac{1}{5} m r^2 \mathbf{R}. \tag{8}
$$

For an ellipsoid with radii $a, b, c$:

$$
\mathbf{A}_{\text{ellipsoid}} = \frac{1}{5} m
\begin{bmatrix} a^2 & 0 & 0 \\ 0 & b^2 & 0 \\ 0 & 0 & c^2 \end{bmatrix} \mathbf{R}. \tag{9}
$$

*[Rewriter's note: Eq. (9) is printed with the diagonal on the left. Deriving it the same way as Eq. (8), with the ellipsoid axes expressed in the particle's local frame and rest orientation $\bar{\mathbf{R}}$, gives $\mathbf{A}_i = \tfrac{1}{5} m\, \mathbf{R}\, \mathrm{diag}(a^2,b^2,c^2)\, \bar{\mathbf{R}}^T$. This reduces to the printed form for spheres, or when rest orientation is the identity and the diagonal commutes.]*

With this extension, **$\mathbf{A}$ has full rank even for a single particle**. Eq. (7) can be read as a special case of GMLS [Martin et al. 2010] in which the deformation derivatives contain only rotations. Unlike GMLS, it accounts for the finite size of particles (through the volume integral in Eq. (8)) instead of treating them as points.

## 4 Generalized Position Based Dynamics

Before the full model, the paper describes how oriented particles evolve in time. PBD is used as the integrator because shape matching is built for it; handling rotational state requires generalizing PBD.

*PBD recap.* Each step has three stages. (1) Prediction: explicit Euler gives a predicted position $\mathbf{x}_p \leftarrow \mathbf{x} + \mathbf{v}\Delta t$. (2) The solver iterates over all constraints several times and corrects the **predicted positions** (not the velocities — hence the name). (3) Integration: $\mathbf{v} \leftarrow (\mathbf{x}_p - \mathbf{x})/\Delta t$ and $\mathbf{x} \leftarrow \mathbf{x}_p$. Because the solver's position edits feed into the velocities, the system is second order in time. PBD is simple and unconditionally stable since positional corrections never overshoot.

Stiffness, friction and damping coefficients are scalars $s \in [0 \ldots 1]$. With constant time steps this is intuitive; with variable steps the coefficients should be defined as $s = s'\Delta t$ to reduce the dependence on step size.

### 4.1 Integration

Besides $\mathbf{x}$ and $\mathbf{v}$, each particle stores a unit quaternion $\mathbf{q}$ (orientation) and an angular velocity $\boldsymbol{\omega}$. The explicit-Euler prediction becomes

$$
\mathbf{x}_p \leftarrow \mathbf{x} + \mathbf{v}\Delta t \tag{10}
$$

$$
\mathbf{q}_p \leftarrow \left[ \frac{\boldsymbol{\omega}}{|\boldsymbol{\omega}|} \sin\!\left(\frac{|\boldsymbol{\omega}|\Delta t}{2}\right),\; \cos\!\left(\frac{|\boldsymbol{\omega}|\Delta t}{2}\right) \right] \mathbf{q}. \tag{11}
$$

For stability, set $\mathbf{q}_p = \mathbf{q}$ directly when $|\boldsymbol{\omega}| < \varepsilon$. After the solver has modified the predicted state $(\mathbf{x}_p, \mathbf{q}_p)$ (Section 5.1), the state is updated by

$$
\mathbf{v} \leftarrow (\mathbf{x}_p - \mathbf{x})/\Delta t \tag{12}
$$

$$
\mathbf{x} \leftarrow \mathbf{x}_p \tag{13}
$$

$$
\boldsymbol{\omega} \leftarrow \operatorname{axis}(\mathbf{q}_p\mathbf{q}^{-1}) \cdot \operatorname{angle}(\mathbf{q}_p\mathbf{q}^{-1})/\Delta t \tag{14}
$$

$$
\mathbf{q} \leftarrow \mathbf{q}_p, \tag{15}
$$

where $\operatorname{axis}()$ is the normalized rotation axis of a quaternion and $\operatorname{angle}()$ its angle. Again for stability, set $\boldsymbol{\omega} = 0$ when $|\operatorname{angle}(\mathbf{q}_p\mathbf{q}^{-1})| < \varepsilon$. Both $\mathbf{r} = \mathbf{q}_p\mathbf{q}^{-1}$ and $-\mathbf{r}$ rotate $\mathbf{q}$ into $\mathbf{q}_p$; always take the shorter one, i.e. use $-\mathbf{r}$ if $r.w < 0$.

As with translation, editing $\mathbf{q}_p$ in the solver changes $\boldsymbol{\omega}$ through the integration step, which gives the second-order behaviour. This is a simplification of rigid-body dynamics because precession is omitted. The error is zero for spherical particles and grows with the aspect ratio; for bodies made of many particles, correct precession emerges on its own, so the error is visible only for bodies made of few particles.

### 4.2 Friction

Plain PBD applies friction by scaling down the linear velocity by a constant after the update. When a particle has hit a solid object, the paper modifies both the linear and the angular velocity:

$$
\mathbf{v} \leftarrow \mathbf{v} + (\mathbf{v}_s - \mathbf{v})_{\perp \mathbf{n}} \cdot s_{lin} \tag{16}
$$

$$
\boldsymbol{\omega} \leftarrow \boldsymbol{\omega} + \frac{\mathbf{r}}{|\mathbf{r}|^2} \times (\mathbf{v}_s - \mathbf{v} - \boldsymbol{\omega} \times \mathbf{r}) \cdot s_{rot}, \tag{17}
$$

where $\mathbf{v}_s$ and $\mathbf{n}$ are the solid's velocity and normal at the contact, $\mathbf{r} = r\mathbf{n}$ with particle radius $r$, and $s_{lin}, s_{rot} \in [0 \ldots 1]$ set the amount of linear and angular friction. *[Rewriter's note: as printed $\mathbf{r} = r\mathbf{n}$; geometrically the contact point lies at $-r\mathbf{n}$ from the center if $\mathbf{n}$ points away from the solid — check the sign when implementing.]*

For two colliding particles the same idea gives

$$
\mathbf{v}_1 \leftarrow \mathbf{v}_1 + \left(\frac{\mathbf{v}_1 + \mathbf{v}_2}{2} - \mathbf{v}_1\right)_{\perp \mathbf{n}} \cdot s_{lin} \tag{18}
$$

$$
\mathbf{v}_2 \leftarrow \mathbf{v}_2 + \left(\frac{\mathbf{v}_1 + \mathbf{v}_2}{2} - \mathbf{v}_2\right)_{\perp \mathbf{n}} \cdot s_{lin} \tag{19}
$$

and

$$
\boldsymbol{\omega}_1 \leftarrow \boldsymbol{\omega}_1 + \frac{\mathbf{r}_1}{|\mathbf{r}_1|^2} \times (\mathbf{v}_{avg} - \mathbf{v}_1 - \boldsymbol{\omega}_1 \times \mathbf{r}_1) \cdot s_{rot} \tag{20}
$$

$$
\boldsymbol{\omega}_2 \leftarrow \boldsymbol{\omega}_2 + \frac{\mathbf{r}_2}{|\mathbf{r}_2|^2} \times (\mathbf{v}_{avg} - \mathbf{v}_2 - \boldsymbol{\omega}_2 \times \mathbf{r}_2) \cdot s_{rot} \tag{21}
$$

with $\mathbf{n} = (\mathbf{x}_2 - \mathbf{x}_1)/|\mathbf{x}_2 - \mathbf{x}_1|$, $\mathbf{r}_1 = r\mathbf{n}$, $\mathbf{r}_2 = -r\mathbf{n}$ and $\mathbf{v}_{avg} = (\mathbf{v}_1 + \boldsymbol{\omega}_1 \times \mathbf{r}_1 + \mathbf{v}_2 + \boldsymbol{\omega}_2 \times \mathbf{r}_2)/2$.

## 5 Simulation Model

An object is a set of oriented particles plus a set of edges between them. This mesh need not be a valid triangle or tetrahedral mesh: in volumetric regions it may locally resemble a tet mesh, while thin parts can be plain particle chains (Fig. 3(d)).

### 5.1 Implicit Shape Matching

One shape-matching group is defined **per particle**: the particle plus every particle connected to it by one edge. Ordinary shape matching would blow up immediately in sparse regions of such a mesh; with oriented particles any connectivity works.

After prediction, the solver loops several times over all shape-match constraints, Gauss–Seidel style. For each constraint, goals come from Eq. (4), and every particle in the group is moved toward its goal by the same fraction $s_{\text{stiffness}}$, which acts as stiffness as in [Müller et al. 2006]. Stiffness can be set per particle (Fig. 3(c)).

For orientation, only the **center particle** of a group is updated: its orientation is replaced by the group's optimal rotation. Generalized shape matching has a useful property here: it only affects the particle's orientation along the directions contained in $\mathbf{A}$. Two extremes illustrate this. A group with a single particle returns that particle's own orientation (Eq. (7)), so the solver leaves it unchanged. A group whose particles robustly span 3D gives an orientation dominated by the group as a whole. Everything in between blends smoothly — for a chain, shape matching fixes the orientations along the chain direction while the particles can still spin freely about the chain axis.

### 5.2 Stretching vs. Bending

Per-node shape matching resists stretching and bending together, which often suffices. When an artist wants separate control, regular PBD distance constraints on the edges are also supported: to lower only bending resistance, reduce the shape-match stiffness and enable the distance constraints. Even at zero shape-match stiffness, shape matching must still run, because it is what updates particle orientations for collision and skinning — distance constraints only touch positions.

### 5.3 Explicit Shape Matching

Users may also define explicit shape-matching groups over any subset of particles. Particles in explicit groups skip implicit shape matching; their positions and orientations are governed only by the explicit group. Unlike the implicit case, **every** member receives the group's shape-match rotation, which yields rigid components (Section 9). Exception: a particle that belongs to more than one explicit group is treated as **non-oriented** — its $\mathbf{A}_i$ in Eq. (7) is set to zero. This makes joints possible (as in the monster truck); otherwise rotation would leak from one group into the other and stop the wheels from spinning freely.

### 5.4 Plastic Deformation

Explicit groups can also deform plastically. Plasticity is triggered when any group particle collides with relative velocity above a user threshold. The group is then disabled for a fixed number of frames (5 in the paper) and implicit shape matching takes over; afterwards the explicit group is re-enabled and the deformation is absorbed into the rest state.

Updating the rest state needs care. Explicit groups must **not** keep their own copies of particle rest positions: the rest configuration must be consistent across all groups, otherwise **ghost forces** appear. The original poses are still needed while rest poses are being distorted; these are called **bind poses**.

Let $b_i$, $r_i$, $d_i$ be rigid transforms $f(\mathbf{x}) = \mathbf{R}\mathbf{x} + \mathbf{t}$ with rotation $\mathbf{R}$:

- $b_i$ (bind pose) maps a zero-centered, axis-aligned particle to its original position and orientation, as authored by the user plus the ellipsoid fit of Section 6.2;
- $r_i$ (rest pose): before any plastic deformation $\forall i: r_i = b_i$;
- $d_i$ maps a particle from its rest pose to its current pose — the deformation, which is what shape matching delivers.

Without plasticity, $d_i$ can be used directly for skinning (Section 7). Once rest and bind poses differ, skinning must use $d_i \circ r_i \circ b_i^{-1}$ (applied right to left), while collision detection uses the particle pose $d_i \circ r_i$.

After the deformation phase, particle $i$ deviates from its rest pose $r_i$ by $d_i$, and this deviation should be absorbed into $r_i$. Since the object is not aligned with its rest state in world space, the world-space $d_i$ has to be brought back to rest space first. The rest-to-world transform varies over the object, so one specific transform is chosen: the transform $s$ that the explicit group's shape matching returns in the first frame after re-activation. Then

$$
r_i \leftarrow s^{-1} \circ d_i \circ r_i .
$$

### 5.5 Torsion Resistance

Torsion is controlled by looping over all edges and, similarly to friction, pulling the rotations of the two end particles toward each other:

$$
\mathbf{q}_1 \leftarrow \operatorname{slerp}\!\left(\mathbf{q}_1, \mathbf{q}_2, \tfrac{1}{2} s_{\text{torsion}}\right) \tag{22}
$$

$$
\mathbf{q}_2 \leftarrow \operatorname{slerp}\!\left(\mathbf{q}_2, \mathbf{q}_1, \tfrac{1}{2} s_{\text{torsion}}\right). \tag{23}
$$

$\operatorname{slerp}(\mathbf{q}_1, \mathbf{q}_2, s)$ returns $\mathbf{q}_1$ at $s = 0$, $\mathbf{q}_2$ at $s = 1$, and the spherical interpolation in between.

*Per-step loop (rewriter's summary of Sections 4–5, not a listing from the paper):*

```text
for each particle i:                      # prediction, Eq. (10)-(11)
    x_p[i] = x[i] + v[i]*dt
    q_p[i] = (|w[i]| < eps) ? q[i] : quat(axis=w[i]/|w[i]|, angle=|w[i]|*dt) * q[i]
repeat solverIterations:                  # Gauss-Seidel over constraints
    for each shape-match group G (implicit: particle + 1-ring; explicit: user subset):
        A = sum_{j in G} (A_j + m_j x_p[j] xbar[j]^T) - M c cbar^T     # Eq. (7); A_j = m_j r_j^2/5 * R(q_p[j])
                                                                       # A_j = 0 for particles shared by >1 explicit group
        R = polar(A)
        for j in G: x_p[j] += s_stiffness[j] * (R (xbar[j]-cbar) + c - x_p[j])   # Eq. (4)
        if implicit: q_p[center(G)] = quat(R)            # only the center particle's orientation
        else:        q_p[j] = quat(R) * restOrientation[j] for all j in G
    optional: PBD distance constraints on edges (5.2); torsion slerp on edges, Eq. (22)-(23)
    collisions: ellipsoid-plane / ellipsoid-ellipsoid (Section 6, Appendix A)
for each particle i:                      # integration, Eq. (12)-(15)
    v[i] = (x_p[i]-x[i])/dt ;  x[i] = x_p[i]
    r = q_p[i]*inverse(q[i]);  if r.w < 0: r = -r
    w[i] = (|angle(r)| < eps) ? 0 : axis(r)*angle(r)/dt ;  q[i] = q_p[i]
    friction on contact: Eq. (16)-(21)
```

> Figure 2: Top row, particle–plane collision; bottom row, particle–particle collision. Left to right: sphere collision (offset $r$, or $r + R$ for two spheres), approximate ellipsoid collision using the ellipsoid radius along $\mathbf{n}$ ($r_\mathbf{n}$, $R_\mathbf{n}$), and correct ellipsoid collision using the true separating distance $d$.

## 6 Collision Handling

In classic PBD, particles are spheres, and sphere collision geometry is bumpy, which causes unnatural friction and other visual artifacts. Since the particles here carry orientation, they can be ellipsoids, which fit flat surfaces much better — as Yu and Turk [2010] showed for fluid surfaces (see Fig. 3(c)). That raises two questions: how to collide ellipsoids correctly, and how to choose their principal radii before the simulation starts.

### 6.1 Ellipsoid Collision

A sphere collides with a plane once it is closer than $r$; PBD then pushes it out along the plane normal $\mathbf{n}$ until it touches (Fig. 2(a)). Ellipsoids are harder. A cheap approximation uses the ellipsoid's radius in direction $\mathbf{n}$, but that is exact only when $\mathbf{n}$ is aligned with a principal axis (Fig. 2(b)). Appendix A.1 gives the correct distance $d$ (Fig. 2(c)) at slightly higher cost. Particle–particle collisions (Fig. 2(d)–(f)) are analogous; the equations are in Appendix A.2.

### 6.2 Ellipsoid Representation of Objects

Assume the user has placed particles over a visual mesh and set radii. The paper uses **one common radius** for all particles, chosen from the particle spacing, so that spatial hashing [Teschner et al. 2003] works well for finding overlaps.

Principal directions and radii are then computed automatically, similarly to Yu and Turk [2010]:

1. for each particle, gather all visual-mesh vertices within the particle radius;
2. compute the covariance matrix of this vertex cloud about the particle center, and take the ellipsoid orientation from its **polar decomposition**;
3. do **not** use the covariance eigenvalues as radii (they relate to sums of squared distances, not distances); instead use the extents of the vertices' **oriented bounding box (OBB)** in that frame as principal radii;
4. for stability, clamp radii to $[\tfrac{1}{\sigma} r \ldots r]$, where $\sigma$ limits the aspect ratio; the paper uses $\sigma = 2$.

A useful extension: also move each particle to the center of mass of its surrounding vertices. Iterating "re-orient, re-center" makes particles placed on the surface drift toward the middle of features such as an arm; this was used to build the skeleton in Fig. 3(c).

## 7 Visual Mesh Skinning

A standard way to animate a visual mesh is to embed it in a tetrahedral simulation mesh [Müller and Gross 2004] and move each vertex with barycentric weights of its closest tetrahedron. That is only robust when the vertex lies inside a tetrahedron (all barycentric coordinates positive) [Twigg and Kacic-Alesic 2010], and approximating a complex, branching surface needs many tetrahedra.

Because every particle here carries a full rest-to-current rigid transform, a more robust binding is possible: each visual vertex precomputes links and weights to nearby particles (**at most 4**) and is moved by **linear blend skinning**. This gives plausible results even when the visual geometry is far from the particles and the simulation mesh is very sparse — it is well defined even for a single particle. LBS was sufficient in practice; dual quaternion blending [Kavan et al. 2008] could improve results further.

## 8 Simulation Framework

A design-and-simulation tool was built for the demo scenes. After loading a visual mesh, the user sprays simulation particles onto its surface (or places them one by one). A second spray tool creates edges, within the tool radius, between particles closer than a given distance; edges can also be added one by one. Skinning weights are generated automatically, after which the model can already be previewed in the editor. Further tools paint node and torsion stiffness, define explicit shape-matching groups, adjust skinning weights, and fit ellipsoids automatically.

Building the physical model takes only minutes, but painting skinning weights is often tedious: vertices must not be linked to particles of independently moving parts (for example another tentacle of the octopus in Fig. 3). The tool solves this with selections: the user picks a subset of particles (e.g. one tentacle) and a subset of vertices, and links are created only between them; this is repeated until every vertex is linked.

> Figure 3: Model creation, top-left to bottom-right: (a) original visual mesh; (b) particles placed with the spray tool; (c) fitted ellipsoids and painted stiffness; (d) edges created with the spray tool; (e) soft deformation; (f) complex collisions and interaction.

> Figure 4: Underwater scene with a lion fish and six plants, showing simulation and collision handling of thin features.

> Figure 5: Two monster trucks colliding; the lower truck's body deforms plastically in the crash.

> Figure 6: Left — a rope modelled as a chain of ellipsoids with orientation. Right — capturing the twist dynamics with a comparable collision volume needs six times more non-oriented spherical particles.

## 9 Results

All examples ran in real time on **one core of an Intel Core2 at 2.4 GHz** with an NVIDIA Quadro FX 5800 GPU. A GPU solver was in progress, but CPU timings are reported to show the method is fast even sequentially.

| Scene | Particles | Edges | Visual mesh | Solver | Skinning |
|---|---|---|---|---|---|
| Octopus (Fig. 3), one instance, incl. self-collision | 300 | 750 | 5k vertices, 10k triangles | 4 ms | 6 ms (skinning + rendering) |
| Octopus, three interacting instances (Fig. 3(f)) | 3 × 300 | 3 × 750 | — | 10 ms | — |
| Lion fish + six plants (Fig. 4) | 1k total | 3.5k | 30k vertices, 48k triangles | 10 ms | 9 ms |
| Two monster trucks (Figs. 1, 5) | 300 per truck | 800 per truck | 63k vertices, 100k triangles per truck | 8 ms | 30 ms (≈20 fps with rendering) |

*Octopus (Fig. 3).* Particles were sprayed at a set density; the ellipsoid tool set orientations and shapes; per-particle stiffness was painted from 0 (green) to 1 (red); the edge tool created edges up to a maximal length. Tentacle tips are 1D chains; near the head the mesh is a triangulated surface, and further down it fills space like a tet mesh.

*Lion fish (Fig. 4).* Buoyancy acts on plant nodes; random initial impulses on the leaves break symmetry in the first frame. Only the fish's head motion is scripted. Compared against the elaston lion fish of Martin et al. [2010] (7 s per frame), this is about three orders of magnitude faster, with more visual degrees of freedom on the fish and interaction with complex plants. The authors concede the comparison is not fair computationally (1k particles vs. 5k elastons) but argue that visual outcome is what matters in graphics.

*Monster trucks (Figs. 1, 5).* With only 300 particles against a 63k-vertex mesh, **skinning is the bottleneck**. Free-spinning wheels come from three explicit shape-matching groups — one for the body and one per axle. The body group shares exactly two particles with each axle group, leaving each axle one rotational degree of freedom.

*Rope (Fig. 6).* The oriented rope is a simple chain of ellipsoids. Without orientation, each cross-section needs three connected particles so the rope's orientation is encoded by positions alone, and the segment count must double to avoid gaps in the collision volume — six times the particles and twelve times the edges. Since cost is dominated by per-particle shape matching and integrating orientation is negligible, the oriented version is roughly six times faster than standard shape matching here.

## 10 Conclusion and Future Work

Shape matching on a small number of particles connected by meshes of arbitrary topology can simulate many kinds of solids, provided particles carry orientation and rotation; the same information yields tighter collision volumes and skinning. The editor lets artists build physical models from any visual mesh in minutes.

Limitations of this geometric approach: making it time-step independent for variable steps is hard, and behaviour depends on the mesh and does not converge under refinement as continuum models do — mainly a problem if one wants to auto-generate multiple resolutions for run-time level of detail. The two main bottlenecks are **shape matching and skinning**; a parallel GPU solver is in progress. Future work: unified solid–fluid interaction.

## Acknowledgements

NVIDIA and the PhysX team, in particular Gordon Yeoman, for support and feedback.

## References

Full list omitted. Works most relevant to this repository:

- Müller, Heidelberger, Teschner, Gross 2005 — *Meshless deformations based on shape matching* (SIGGRAPH 2005). Base shape matching, Eq. (1)–(4).
- Müller, Heidelberger, Hennix, Ratcliff 2006 — *Position based dynamics* (VRIPHYS 2006). Integrator and $[0,1]$ stiffness.
- Rivers, James 2007 — *FastLSM: fast lattice shape matching* (SIGGRAPH 2007). Summation form, Eq. (5).
- Martin, Kaufmann, Botsch, Grinspun, Gross 2010 — *Unified simulation of elastic rods, shells, and solids* (elastons, GMLS).
- Becker, Ihmsen, Teschner 2009; Schmedding, Teschner 2008 — stabilized polar decomposition for degenerate particle sets.
- Kavan, Collins, Žára, O'Sullivan 2008 — *Geometric skinning with approximate dual quaternion blending*.
- Yu, Turk 2010 — *Reconstructing surfaces of particle-based fluids using anisotropic kernels* (covariance-based ellipsoids).
- Teschner et al. 2003 — *Optimized spatial hashing for collision detection of deformable objects*.

## A Appendix

### A.1 Ellipsoid–Plane Collision

Take an ellipsoid centered at the origin with principal radii $a, b, c$ and orientation $\mathbf{R}$, and a plane $p$: $\mathbf{n}^T\mathbf{x} = d$. First find the contact point: the point on the ellipsoid whose normal is parallel to $\mathbf{n}$ (where $p$ would be tangent). The ellipsoid is the zero level set of

$$
c(\mathbf{x}) = \mathbf{x}^T\mathbf{A}\mathbf{x} - 1, \tag{24}
$$

with

$$
\mathbf{A} = \mathbf{R}\begin{bmatrix} \frac{1}{a^2} & 0 & 0 \\ 0 & \frac{1}{b^2} & 0 \\ 0 & 0 & \frac{1}{c^2} \end{bmatrix}\mathbf{R}^T
\quad\text{and}\quad
\mathbf{A}^{-1} = \mathbf{R}\begin{bmatrix} a^2 & 0 & 0 \\ 0 & b^2 & 0 \\ 0 & 0 & c^2 \end{bmatrix}\mathbf{R}^T. \tag{25}
$$

The sought point satisfies

$$
\nabla c(\mathbf{x}) = \lambda\mathbf{n} \quad\text{and} \tag{26}
$$

$$
c(\mathbf{x}) = 0. \tag{27}
$$

Since $\nabla c(\mathbf{x}) = 2\mathbf{A}\mathbf{x}$, the first condition gives $\mathbf{x} = \tfrac{1}{2}\mathbf{A}^{-1}\lambda\mathbf{n}$; inserting into the second and solving for $\lambda$:

$$
\lambda = \pm\frac{2}{\sqrt{\mathbf{n}^T\mathbf{A}^{-1}\mathbf{n}}}
\quad\text{and so}\quad
\mathbf{x} = \pm\frac{\mathbf{A}^{-1}\mathbf{n}}{\sqrt{\mathbf{n}^T\mathbf{A}^{-1}\mathbf{n}}}. \tag{28}
$$

The contact point is the solution with the smaller $\mathbf{n}^T\mathbf{x}$; if it lies below the plane, $\mathbf{n}^T\mathbf{x} < d$, there is a collision.

### A.2 Ellipsoid–Ellipsoid Collision

Place both ellipsoids at the origin and separate them by moving ellipsoid 2 along a given normal $\mathbf{n}$. The constraint functions are

$$
c_1(\mathbf{x}) = \mathbf{x}^T\mathbf{A}_1\mathbf{x} - 1 \quad\text{and} \tag{29}
$$

$$
c_2(\mathbf{x}) = (\mathbf{x} - d\mathbf{n})^T\mathbf{A}_2(\mathbf{x} - d\mathbf{n}) - 1. \tag{30}
$$

We need scalars $d$, $\lambda$ and a contact point $\mathbf{x}$ with

$$
c_1(\mathbf{x}) = 0 \tag{31}
$$

$$
c_2(\mathbf{x}) = 0 \tag{32}
$$

$$
\nabla c_1(\mathbf{x}) = \lambda\nabla c_2(\mathbf{x}). \tag{33}
$$

$d$ is the shift of ellipsoid 2 along $\mathbf{n}$ at which the two just touch (from outside when $\lambda < 0$). Expanding the third condition:

$$
\mathbf{A}_1\mathbf{x} = \lambda\mathbf{A}_2(\mathbf{x} - d\mathbf{n}). \tag{34}
$$

Solving for $\mathbf{x}$:

$$
\mathbf{x} = (\lambda\mathbf{A}_2 - \mathbf{A}_1)^{-1}\mathbf{A}_2\lambda d\mathbf{n}. \tag{35}
$$

With $\mathbf{B} = (\lambda\mathbf{A}_2 - \mathbf{A}_1)^{-1}\mathbf{A}_2$, using symmetry of the $\mathbf{A}_i$ and substituting into the first two constraints gives two equations in $\lambda$ and $d$:

$$
\lambda^2\mathbf{n}^T\mathbf{B}^T\mathbf{A}_1\mathbf{B}\mathbf{n} = \frac{1}{d^2} \tag{36}
$$

$$
\mathbf{n}^T(\lambda\mathbf{B} - \mathbf{I})^T\mathbf{A}_2(\lambda\mathbf{B} - \mathbf{I})\mathbf{n} = \frac{1}{d^2}. \tag{37}
$$

Equating the left-hand sides and multiplying by $(\mathbf{B}^T)^{-1}$ from the left and $\mathbf{B}^{-1}$ from the right yields

$$
\lambda^2\mathbf{n}^T\mathbf{A}_1\mathbf{n} = \mathbf{n}^T(\lambda\mathbf{I} - \mathbf{B}^{-1})^T\mathbf{A}_2(\lambda\mathbf{I} - \mathbf{B}^{-1})\mathbf{n}. \tag{38}
$$

Back-substituting $\mathbf{B}$, the right-hand side is

$$
\mathbf{n}^T\left[\lambda\mathbf{I} - \mathbf{A}_2^{-1}(\lambda\mathbf{A}_2 - \mathbf{A}_1)\right]^T\mathbf{A}_2\left[\lambda\mathbf{I} - \mathbf{A}_2^{-1}(\lambda\mathbf{A}_2 - \mathbf{A}_1)\right]\mathbf{n}. \tag{39}
$$

After cancellation the paper obtains

$$
\lambda = \pm\sqrt{\mathbf{n}^T\mathbf{A}_1\mathbf{A}_2^{-1}\mathbf{n}}. \tag{40}
$$

With $\lambda$ known, Eq. (36) gives $d$ and Eq. (35) gives $\mathbf{x}$. Sign convention: $\lambda$ negative (touching from outside) and $d$ positive (ellipsoid 2 shifted along $+\mathbf{n}$).

*[Rewriter's note: the step to Eq. (38) multiplies inside quadratic forms $\mathbf{n}^T(\cdot)\mathbf{n}$, which is not an equivalence in general; exact algebra from Eq. (39) gives $\lambda^2\,\mathbf{n}^T\mathbf{A}_1\mathbf{n} = \mathbf{n}^T\mathbf{A}_1\mathbf{A}_2^{-1}\mathbf{A}_1\mathbf{n}$. Eq. (40) is exact for spheres and close otherwise. A throwaway numerical check with four random ellipsoid pairs gave $d$ values of −2.5 %, −6.6 %, −1.1 % and +0.1 % relative to the true touching distance found by bisection. Treat A.2 as an approximation.]*

## Slides

The SIGGRAPH 2011 talk slides (Müller, Chentanez) add the following beyond the paper.

- **Motivation, in numbers:** a visual mesh approximated by **60 triangles (~200 tetrahedra)** with tet embedding needs only **20 ellipsoids** as oriented particles. Tet meshes need enough elements to resolve separate parts, hide piecewise-linear deformation and approximate collision well, and building them is non-trivial.
- **Three uses of orientation:** positioning anisotropic collision shapes, stabilizing simulation in sparse regions, robust skinning.
- **Related work framing:** "oriented particles" also appear in Pfister et al. 2000 (surfels, rendering) besides Szeliski and Tonnesen 1992. Elastons: accurate and continuum-based but seconds per frame. Shape matching: geometric, simple and fast, but fails in sparsely sampled regions.
- **Singularity problem, illustrated:** regions are under-sampled in 1D and 2D structures, so the rest-to-current transform is not unique.
- **Intuition for the fix ("our solution"):** conceptually, replace each particle with **6 virtual particles** at fixed distance and fixed relative arrangement. That needs particle orientation, and since the orientation affects the rest of the object it must be simulated properly. *[Rewriter's note: six points of mass $m/6$ at $\pm s$ along the particle's local axes reproduce $\mathbf{A}_{\text{sphere}} = \tfrac15 m r^2\mathbf{R}$ exactly when $s = r\sqrt{3/5}$.]*
- **Generalized shape matching, slide form:** the per-particle term follows from
  $\int_{V_r}\rho\,(\mathbf{R}\mathbf{x} + \mathbf{x}_i - \mathbf{c})(\mathbf{x} + \bar{\mathbf{x}}_i - \bar{\mathbf{c}})^T dV = \mathbf{A}_i + m_i(\mathbf{x}_i - \mathbf{c})(\bar{\mathbf{x}}_i - \bar{\mathbf{c}})^T$, which gives the centered form
  $$\mathbf{A} = \sum_i \left[\mathbf{A}_i + m_i(\mathbf{x}_i - \mathbf{c})(\bar{\mathbf{x}}_i - \bar{\mathbf{c}})^T\right].$$
- **Arbitrary shape-match groups:** rigid parts; joints via shared particles. Free rotation needs the shared particles to be **non-oriented**: omit $\mathbf{A}_i$ for shared particles in the sum above. A "simplified chain" slide shows chain links coupled only through shared particles.
- **Skinning comparison:** barycentric interpolation in the surrounding tetrahedron is piecewise linear; LBS over the $k$ closest oriented particles gives **curved** interpolation.
- **Newer timings** (Intel Core i7 @ 3 GHz for simulation, GeForce GTX 480 for skinning):

| Demo | Particles | Triangles | Rate |
|---|---|---|---|
| demo video, slide 29 | 900 | 63k | 60 fps |
| demo video, slide 30 | 3000 | 90k | 25 fps |
| demo video, slide 32 (after "arbitrary shape match groups") | 2000 | 240k | 40 fps |
| simplified chain, slide 34 | 600 chain links | — | 45 fps (simulation + skinning) |
| demo video, slide 35 | 1000 | 100k | 35 fps |
| monster truck, 10 instances, slide 37 | 300 each | 100k each | 20 fps (simulation + skinning) |

- **Monster truck structure:** 2 rigid axle groups, a rigid chassis group, and a **plastic body**.
- **Future work (slides):** volume conservation; GPU implementation and game-engine integration.
