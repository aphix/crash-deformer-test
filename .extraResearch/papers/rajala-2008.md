# Dynamic Controllable Mesh Deformation in Interactive Environments

- **Author:** Johannes Rajala
- **Venue:** Master's thesis (Examensarbete in media technology), Department of Science and Technology (ITN), Linköping University, Norrköping, Sweden. Report LiU-ITN-TEK-A--08/081--SE, dated 2008-06-11.
- **Industry partner:** Bugbear Entertainment (FlatOut series). Supervisors: Tatu Blomberg, Panu Liukkonen. Examiner: Matt Cooper.
- **Companion talk:** "Dynamic Mesh Deformation for Car Games" (seminar recording, YouTube `VNS-0cJlpIs`). Talk-only material is collected in `rajala-2008.analysis.md` → *Talk transcript extras*.

> Rewrite note: this is a section-by-section paraphrase, not a transcription. Headings, equation numbering, parameter values and figure numbering follow the thesis. Equations were rebuilt from a badly extracted PDF; any reconstruction that relies on context rather than legible glyphs is marked `[reconstructed]`.

## Abstract

The project investigated ways to manage the deformation of complex geometric meshes for interactive games. Bugbear Entertainment builds racing games, and real-time deformable meshes matter there because they let a player see the consequences of a crash. The reader is assumed to know basic graphics simulation and matrix algebra.

## Acknowledgments

Thanks go to the author's parents, Matthias Müller, Sasan Gooran, Roger Johannesson, Quan Ho, Mattias Unger, the supervisors and the Bugbear staff.

## Chapter 1 — Introduction

Simulating collision and deformation in real time has become an active research topic. The underlying mathematics long only suited offline work (film, offline animation), but current consoles and PCs can approximate it at interactive rates. Interactive applications impose hard time budgets but tolerate lower accuracy, which many approaches exploit. The thesis compares approaches for deforming cars and other dynamic objects made of different materials in racing games; this chapter introduces deformation physically and in the context of car games.

### 1.1 Introduction to Deformation

An object deforms when a physical force acting on it is large enough. Hooke's law [7] models a linear relation between stress (force) and strain (deformation). The focus here is deformation caused by collisions, with these working definitions:

**Definition 1.1 (Collision [3]).** An isolated event in which two or more bodies exert relatively strong forces on each other over a relatively short time.

**Definition 1.2 (Deformation [19]).** A change of shape, for example under pressure or stress.

Hooke (17th century) studied materials with a linear stress–strain relation. His law is usually cited for springs but applies to other non-rigid bodies, and has been extended to plastic materials. The stress–strain curve (Figure 1.1) captures the phases common to all materials even though its exact shape varies:

- In the **elastic region**, strain grows linearly with stress and fully recovers when the load is removed.
- Brittle materials **fracture** soon after the elastic limit, with little or no plastic region.
- Ductile materials may have only a short elastic region; further loading puts them in the **plastic region**, where they keep their deformed shape after unloading.
- Even ductile materials eventually fracture.

Varying these features lets one model materials ranging from rubber to metal to clay.

> Figure 1.1: Material stress–strain curve — a linear elastic region, followed by a plastic region, ending in fracture.

### 1.2 Collision and Deformation in Car Games

Games have become mainstream entertainment, and players expect more realism and better effects. Car games are among the most demanding real-time genres: players notice input lag or dropped frames at high speed immediately, so real-time destruction must be both fast and convincing.

*Destruction Derby* (1995) was the first game with car deformation and part loss; its deformations were precomputed and triggered by collisions. Other notable damage systems include *Carmageddon*, *Colin McRae: Dirt*, *TOCA Race Driver*, *FlatOut: Ultimate Carnage* and *Burnout Paradise*. Shooters also deform models, but their limited field of view and slower targets make their problem different, so they are left out.

For part detachment, essentially all these games build the car from several connected meshes and detach a part once the physics engine stresses its connection enough. They also use some form of dynamic deformation. The simplest is a linear blend from the intact mesh to a fully wrecked mesh, which artists model by hand or generate with modelling-package tools. That looks good but can never go beyond the prebuilt wreck, and it cannot express extreme dynamic damage such as bending or twisting.

Demand for realism has pushed research toward solving these limits, partly by speeding up offline methods through better algorithms, simplification and preprocessing, and partly through unconventional approaches. The thesis surveys recent techniques, weighs their pros and cons, and then picks one to implement in detail.

## Chapter 2 — Theoretical Basis

This chapter lays out the theory behind the implementation and reviews the available techniques, so that the one best suited to real-time use within the thesis's scope can be chosen.

Hooke's law [7] is the first-order linear model of how deformation relates to force. It holds for linear-elastic materials and must be extended to cover plasticity, where a material keeps its deformation after the force is removed (Figure 1.1). Car-crash materials behave this way and are nearly entirely non-elastic at higher speeds, so the chosen method has to support it.

### 2.1 Studies about Deformation

As compute budgets grow, more simulations become feasible in real time. Simulating material properties at the molecular level is still out of reach, so approximations and preprocessing are always needed.

Two broad surveys exist: *Physically Based Deformable Models in Computer Graphics* [13] and *A Survey of Computer-Based Deformable Models* [12]. The second sorts methods into non-physical, physical and approximate-physical, covering fewer methods in more depth. That grouping is debatable: FEM is filed under "physical" because it comes from continuum mechanics, but it discretises the material and is really an approximation. The first survey covers physically based methods only and splits them into Lagrangian mesh-based, Lagrangian mesh-free and mesh-free; Appendix A tabulates its contents.

Some of these methods are still too costly for real time. Real-time work favours speed over accuracy, and what looks right is not always what is physically correct. The following subsections describe the main candidates.

#### 2.1.1 Mass-Spring Method

Mass-spring models are common in games, for example for cloth and rigid bodies. Point masses are joined by springs that carry rules or constraints, typically length and angle but possibly other material properties. A system of ODEs drives the particles under forces while keeping the constraints as close as possible to their target values. Figure 2.1 shows a cloth-style network and a rigid body made from infinitely stiff springs.

> Figure 2.1: A mass-spring cloth, and a rigid body built from stiff springs.

Each step has two phases: (1) apply forces and move the particles; (2) enforce the constraints on the system or on individual particles. Phase 1 can use explicit forward Euler:

$$v_i' = v_i + \Delta t\,\frac{F_i}{m_i} \tag{2.1}$$

$$x_i' = x_i + \Delta t\,v_i' \tag{2.2}$$

Thomas Jakobsen [8] (written "Jacobsen" in the thesis) recommends a velocity-less scheme for better stability: Verlet integration (Verlet, 1967 [20]), originally from molecular dynamics. It stores each particle's current and previous position and derives the next position from them plus the acceleration. Besides being more stable it is time-reversible, which helps collision response.

$$x_i' = 2x_i - x_i^{*} + a\,\Delta t^2 \tag{2.3}$$

$$x_i^{*} = x_i \tag{2.4}$$

Here $x_i^{*}$ is the previous position. `[reconstructed]` — the extracted glyphs only show "$x'_i$, $x_i$, $x^0_i$"; $x_i^{*}$ is used for the previous position to avoid clashing with the rest positions $x_i^0$ of §2.1.4. Equation 2.4 is the history shift performed after each step.

If a velocity is needed, for example to compute kinetic energy for energy bookkeeping ($E = K + V$), it can be estimated with a central difference, which according to the thesis carries an error of order $\Delta t^4$. Alternatives are modified Verlet schemes such as leap-frog [9] or velocity Verlet [4].

$$v = \frac{x_i' - x_i^{*}}{2\,\Delta t} \tag{2.5}$$

`[reconstructed]`: the numerator is the difference between the next and previous positions.

Mass-spring systems depend on constraints, which can encode material behaviour and even parts of the environment. Keeping a particle inside the box $[-1,-1,-1]$–$[1,1,1]$ is a simple example:

$$x_i = \min(\max(x_i, -1), 1) \tag{2.6}$$

A more useful constraint fixes the distance $d$ between two connected particles $x_1, x_2$:

$$\lvert x_2 - x_1 \rvert = d \tag{2.7}$$

It is satisfied by moving the two endpoints toward or away from each other, each by half of the error:

$$
\begin{aligned}
b_1 &= x_2 - x_1 \\
b_2 &= \lvert b_1 \rvert = \sqrt{b_1 \cdot b_1} \\
b_3 &= \frac{b_2 - d}{b_2} \\
x_1 &\leftarrow x_1 + \tfrac{1}{2}\, b_1 b_3 \\
x_2 &\leftarrow x_2 - \tfrac{1}{2}\, b_1 b_3
\end{aligned}
\tag{2.8}
$$

`[reconstructed]`: the extraction showed $b_2 = (b_1)^2$. The form above is Jakobsen's standard projection, which matches the stated "half of the difference to each particle".

Satisfying several constraints at once exactly would require solving them as one system of equations. Alternatively, iterating over the constraints a fixed number of times converges toward the solution. The thesis calls this relaxation or Jacobi iteration, and it suits systems with many constraints.

That is everything a working mass-spring system needs. Jakobsen's 2001 paper [8] covers a rigid-body-oriented variant in implementation detail; it was used for character physics in *Hitman*.

Mass-spring models are easy to build but struggle to represent many materials realistically:

- constraint strengths and damping are hard to tune;
- many cross-braces are needed to stop shearing;
- building the network gets tedious as it grows, and the cost grows with it;
- strong springs for stiff objects make simple integrators unstable. With Verlet integration the rigid-body case has no stability problem.

#### 2.1.2 Free Form Deformation

Free-form deformation (FFD) was one of the first techniques to deform the space an object sits in rather than the object itself. The model is placed in a lattice; each cell has a space-warping function, introduced by Barr in 1984 [1], supporting scaling, tapering, twisting and bending. Deforming the lattice drags the embedded object with it. Sederberg and Parry [17] (1986) generalised the functions and the lattices by using trivariate hyper-patches (Figure 2.2). The approach is still in use, extended to other lattice types, animation and direct manipulation, and modelling packages often expose it because it is intuitive.

> Figure 2.2: An undeformed object inside its lattice, and the same object after FFD.

Moving the lattice control points displaces the embedded points through a blending stage. The lattice consists of tricubic hyper-patches, and in a single rectangular FFD block each face is one hyper-patch. Following Sederberg, points inside a block get local coordinates relative to the patch. After the control points are moved, by the user or by a simulation, the deformed positions of the control points and of the interior points are evaluated with blending functions whose form is set by the chosen degree and formulation.

Bézier patches are one option, but fine local detail requires more control points, which raises the curve degree and makes every control point influence even distant regions. Cubic B-spline hyper-patches give local control instead; B-splines generalise Bézier curves. Figure 2.3 shows a planar curve with five control points; the hyper-patch is the 3D extension [5].

> Figure 2.3: A cubic spline curve defined by five control points.

Sederberg et al. blend with Bernstein polynomials. The undeformed object lives in a rectilinear coordinate system and the deformed object in a curvilinear one whose axes come from the Bernstein functions. With control points $p_{ijk}$ and parametric coordinates $(u, v, w)$:

$$P(u,v,w) = \sum_{i=0}^{3}\sum_{j=0}^{3}\sum_{k=0}^{3} p_{ijk}\, B_i^3(u)\, B_j^3(v)\, B_k^3(w) \tag{2.9}$$

This maps every model point to its new position. Any polynomial degree can be used. Local deformation needs a piecewise FFD, for example with cubic B-splines, whose order can also be chosen freely.

A B-spline curve with $n$ control points $P_k$ and order $d \in [2, n+1]$ uses blending functions $B_{k,d}$ of degree $d-1$:

$$X(t) = \sum_{k=0}^{n} P_k\, B_{k,d}(t) \tag{2.10}$$

Each $B_{k,d}$ is nonzero only over a short range of $t$, which is where local control comes from, and is defined recursively. The knot vector $(t_0, t_1, \dots, t_{n+d})$ is non-decreasing, $t_0 \le t_1 \le \dots \le t_{n+d}$. For uniform cubic B-splines it is $(-3, -2, -1, 0, 1, \dots, n+1)$. The cubic blending function is

$$
B_{0,4}(t) = \frac{1}{6}
\begin{cases}
(t+3)^3 & -3 \le t < -2\\
-3t^3 - 15t^2 - 21t - 5 & -2 \le t < -1\\
3t^3 + 3t^2 - 3t + 1 & -1 \le t < 0\\
(1-t)^3 & 0 \le t < 1
\end{cases}
\tag{2.11}
$$

(The pieces were checked for continuity: they meet at $1/6$, $4/6$ and $1/6$ at $t=-2,-1,0$.)

Many extensions of this basic FFD exist. Even with the local control of cubic B-splines, the basic limitation remains: deformation needs a well-formed lattice, which usually restricts models to uniform solids, and material properties are hard to control intuitively.

#### 2.1.3 Finite Element Analysis

Finite element analysis (FEA) was developed for structural dynamics: first aeroelastic effects on aircraft wings, then the space programme. In 1956 Turner et al. showed how simple strain fields give a better way to compute shear fields; their paper *Stiffness and deflection analysis of complex structures* [10] contains the FEA basics still used today [16].

FEA simulates with the finite element method (FEM). The aim is to conserve energy in a system where physical reactions take place. Energy functions are hard to integrate over irregular shapes, so the object is split into an assembly of discrete finite elements. Turner et al. describe triangular, quadrilateral and rectangular 2D elasticity elements; their triangle, for example, has three constant strain components and three rigid-body displacements. Hooke's law [7] gives stresses from nodal displacements, and replacing boundary stresses with equivalent nodal forces yields the stiffness matrix.

Figure 2.4 shows the basic 1D/2D/3D element types in linear and higher-order versions. In 3D, 2D elements can serve the boundary element method (BEM), which works only on the surface; volumetric FEM needs 3D elements. Free and commercial tools can generate tetrahedral or other volumetric meshes. Each node stores variables, including material properties, that act as parameters of the differential equations being solved.

> Figure 2.4: Basic finite element types — 1D (linear, quadratic, cubic); 2D triangular and quadrilateral/rectangular; 3D tetrahedron, right prism and hexahedron.

Element approximations are usually found with the Rayleigh–Ritz procedure, which analyses each element type's load response and seeks the minimising solution. Its result is a matrix sized by element type and nodal degrees of freedom: 3×3 for a triangle with one DOF per node, 9×9 with three DOFs (x, y, z displacement) per node. Each element's entries come from its shape functions and nodal values. The element matrices are then assembled into one global matrix, accounting for shared nodes and weights, nodal forces are added, and the system is solved, e.g. by Gauss–Jordan elimination.

FEM is the most realistic option but also the most expensive. Many objects made of dense tetrahedral meshes, each needing a large solve, quickly exceed a real-time budget, although some recent methods claim near-interactive speed. Pixelux built an FEM-based system, Digital Molecular Matter (DMM), which also claims real-time fracture of different materials. It has not been published in detail, relies on preprocessing to build interior volume data, and was not available for evaluation. At the time of writing no public FEM solution handled tens or hundreds of simultaneously deforming objects alongside a game's other workload.

#### 2.1.4 Mesh-Free Methods

Mesh-free methods ignore mesh connectivity when computing the physical response. The mesh is point-sampled and the samples are simulated as unconnected particles, which relates these methods to point-based animation. Their main advantage is that the physics is simple when there are no connectivity relations to maintain.

*Meshless deformations based on shape matching* by Müller et al. [11] uses least squares to fit the particles' current relative positions to their original ones. The original configuration stands in for the missing connectivity, so proportions survive rotation and deformation in the mesh-free simulation. Figure 2.5 shows the steps: the original positions define a reference; the particles are moved by physics (gravity, collision response, …); a transform describing the current state is computed; and comparing the two gives an optimal transformation and from it the goal positions. Because matching is always done against a stable original state, particles keep correct relative proportions even with large time steps.

> Figure 2.5: Shape matching — original configuration; result of the particle-based physics step; shape-matched position correction.

The calculations are simple enough to run many complex objects in real time. The cost is limited flexibility: a linear fit only expresses linear deformations (scaling, stretching, shearing). Quadratic features such as bending require a quadratic least-squares fit.

The mesh is sampled into control points $x_i^0$. Weighted by their masses $m_i$, they define the rest centre of mass

$$x_{cm}^0 = \frac{\sum_{i}^{n} m_i\, x_i^0}{\sum_i m_i} \tag{2.12}$$

A second set $x_i$ holds the control points after a simulation step in which only forces such as gravity and collision response moved them; $x_{cm}$ is defined in the same way. This intermediate set feeds the shape matching that produces the goal positions. The final positions blend the goals with the actual positions according to a stiffness factor $\alpha$.

The optimal linear transformation $A$ minimises, in the least-squares sense,

$$\sum_{i}^{n} m_i \Big( A\,(x_i^0 - x_{cm}^0) - (x_i - x_{cm}) \Big)^2 \tag{2.13}$$

With the shorthand

$$q_i = x_i^0 - x_{cm}^0 \tag{2.14}$$

$$p_i = x_i - x_{cm} \tag{2.15}$$

this becomes

$$\sum_{i}^{n} m_i\, (A q_i - p_i)^2 \tag{2.16}$$

Setting the derivatives with respect to the coefficients of $A$ to zero gives [11]

$$A = \Big(\sum_i^n m_i\, p_i q_i^T\Big)\Big(\sum_i^n m_i\, q_i q_i^T\Big)^{-1} = A_{pq}\, A_{qq} \tag{2.17}$$

(Following Müller's notation, $A_{qq}$ here denotes the inverse $\big(\sum m_i q_i q_i^T\big)^{-1}$.)

A fully rigid simulation needs the rotation separated from the scale/stretch. This is done with the **polar decomposition**. Müller suggests a Jacobi-type iteration; Shoemake and Duff [18] describe another fast method and give a thorough introduction to polar decomposition, its pitfalls and its uses.

$$A_{pq} = R S, \qquad S = \sqrt{A_{pq}^T A_{pq}}, \qquad R = A_{pq} S^{-1} \tag{2.18}$$

Equation 2.18 does not involve $A_{qq}$, because that matrix is symmetric and contains only scaling. Most materials are not perfectly rigid, so the optimal transformation blends the linear fit and the rotation with a material parameter $\beta$:

$$T = \beta A + (1 - \beta) R \tag{2.19}$$

$T$ then gives the goal positions

$$g_i = T q_i + x_{cm} \tag{2.20}$$

which drive the next state (time step $h$, velocity $v$, external force $F_{ext}$):

$$v_i(t+h) = v_i(t) + \alpha\,\frac{g_i(t) - x_i(t)}{h} + h\,\frac{F_{ext}(t)}{m_i} \tag{2.21}$$

$$x_i(t+h) = x_i(t) + h\, v_i(t+h) \tag{2.22}$$

Müller et al. [11] prove that this scheme is unconditionally stable and adds no damping relative to explicit Euler integration.

##### Extensions and improvements

Going beyond stretch, scale and rotation means a more complex least-squares fit. The quadratic version makes $A_{pq}$ and $A_{qq}$ 9×9, which costs more memory and computation. Staying linear, the mesh can instead be split into **clusters**: this enlarges the space of possible deformations while keeping linear transforms. Müller presents clustering as one extension and also covers **plastic** deformation alongside the elastic case. Since plasticity is exactly what metal deformation needs (see the start of Chapter 2), this makes meshless shape matching attractive.

The shape matching paper (released 2004) has been extended with object cutting [6] and with fracture and smoother inter-cell transitions [15]. Rivers and James [15] cover fracture in more detail and speed up the computation (notably by caching the input to the Jacobi polar-decomposition iteration) and the overall stiffness of clustered systems. They do not discuss plasticity, though, nor how to obtain a linear transform. Interpenetration and the complexity of the deformation remain open issues.

### 2.2 The Method of Choice

##### Similarities between the methods

The reviewed methods each have drawbacks but share one concept: a **control particle** that stores physical data about its neighbourhood. Control particles are linked by a connectivity structure that is usually coarser than the render mesh. Physics runs on the particles, constraints or formulas are satisfied, and the particles are moved to their final positions. Mesh vertices then follow, either through a geometric relation to the particles or through some other mathematical mapping from the particles that influence them.

Because of this shared structure, several methods could in principle run side by side, each handling a special case with the same or similar properties. Given the thesis's time and scope, only one method was chosen for real-time plastic deformation, and the framework was kept extensible so that other, hybrid or improved techniques can be added for comparison later.

##### Issues with different methods

- **Mass-spring:** it is hard to build a spring network automatically that covers a complex mesh well, and hard to pick constraints with sensible parameters.
- **FFD:** good for mesh editing and elastic effects, and evaluating Bernstein functions is cheap enough for real time. However, the lattice restricts shape, and complex objects need many sub-sections throughout the mesh.
- **FEA:** impressive and finely tunable, but existing implementations cost too much for tens to hundreds of simultaneously deforming complex objects. Once compute allows, models will also need accurate physical parameters; even simple objects shatter if they are too thin or their density is too low. A preprocessing step to build interior geometry will probably be required, since fracture depends on internal structure.
- **Shape matching [11]:** fits the real-time constraints and handles varied materials and plasticity. The maths is cheap and the method is stable under variable time steps. Because no connectivity is stored, objects can interpenetrate, but filling empty interiors with connected cells should prevent this. Linear transforms restrict the motion, yet a denser cell cluster can approximate quadratic effects such as bending. Linear transforms also use far less memory than quadratic ones and cost far less, especially for plasticity, where the quadratic version needs a polar decomposition and an inverse of 9×9 matrices.

##### The Selection

For a demanding real-time engine, real-time capability and stability come first. Given the review and the time available, which did not allow fully implementing every candidate, the thesis picks Müller et al.'s meshless shape matching. The implementation chapter covers building a deformation framework on top of it.

##### Rotation Inclusion Improvement

While testing a system like Müller's, the author found an improvement. In the original plasticity extension, the permanent deformation keeps only the linear (stretch) part of the transform. That is enough for a few clusters but already limits plasticity, and with many interconnected cells linear-only plasticity becomes unstable under large deformation. The fix is to include the rotation in the plastic update as well. This gives bending-like, quadratic-looking effects at linear cost, though in a more discrete form. Section 3.5 illustrates it with stacked cubes (Figure 3.9 linear, Figure 3.10 with rotation). Including rotation means updating not only the static matrices $A_{qq}$, as in the linear case, but also the original centres of mass.

## Chapter 3 — Implementation

The thesis set out to find a workable real-time dynamic mesh deformation method. Chapter 2 evaluated the common theories and selected *Meshless deformations based on shape matching* [11]. This chapter covers the implementation: a deformation framework that runs both inside an external editor and inside the actual game engine.

### 3.1 Deformation Framework

The framework is a self-contained C++ component meant to drop into a game engine easily. Its structure allows individual parts to be optimised. The plan for the final version is to parallelise the critical parts, use platform-specific instruction sets, and possibly move some work to the GPU. The first version was written to run well on a plain CPU so that porting between target platforms stays simple; games also tend to be GPU-bound because of their visual demands. Chentanez's documented GPU implementation of quadratic elastic shape matching [2] could serve as a reference should a GPU version become attractive.

#### 3.1.1 Data Structures

Figure 3.1 shows how data is split between components. From the engine's point of view a **model** contains **meshes**; a mesh may hold batches if needed but in the simple case holds only vertex data. Shape matching needs its own structures, so a **deformable model** owns a **cluster** that is split into **cells**, and each cell links to the actual vertex data.

> Figure 3.1: Data distribution in the framework. Car model → Model (1..* Mesh → VertexData: vertex, normal) and DeformableModel (1 Cluster → 1..* Cell, each linked to vertex data). The shape-matching data needed for deformation is kept separate from the render mesh data.

#### 3.1.2 General Operation Flow

The deformable model does not drive itself; the host system drives it so the framework stays portable. In the editor, the scene runs these steps in order, repeatedly, while simulation is on:

```text
1. Physical simulation (gravity and other forces)
2. Collision detection and responses
3. Shape matching
4. Final integration to positions
5. Move vertices
```

Inside the game engine the order differs slightly and some steps are conditional. Cars use a **plastic** material, so simulating when nothing collides would be wasted work. (Elastic objects, by contrast, must be simulated continuously.)

```text
1. Physical simulation
2. Collision detection and responses
   (a) on a collision, start shape matching for plastic objects
   (b) final integration to positions
3. A separate update thread re-deforms the drawn vertices, only if they changed
```

Vertex positions are thus transformed separately from the simulation, possibly on another thread and only after an update. This works because shape matching leaves its result in each cell's transformation matrix, and that matrix alone is enough to place the cell's vertices for rendering.

##### Pre-Calculation

Car models usually consist of several separate meshes, which keeps modelling clean and allows parts to detach after enough damage. It is too costly to give every part its own deformation object, so one model's data is restructured into a **single deformation model**.

Every vertex belongs to some mesh, and meshes carry normals and texture data. To build a deformable model, vertices are assigned to cluster cells. The simulation runs on the cells, and each cell's transform then updates the vertices and normals of every mesh in the model (Figure 3.1).

Müller [11] shows that clustering improves physical plausibility. He used overlapping cubic regions and noted that tetrahedra would also work. In fact almost any clustering works **as long as the cells overlap**; the overlap is what holds the object together. Chentanez [2] uses k-means for his GPU version. The thesis also tried a k-tree style split driven by data volume, treating the particles on region borders as the shared ones.

Clustering looks like a minor detail but strongly affects the result. Dynamically sized cells make overlap hard to build: one picks representative particles per cell and links them to matching particles in neighbouring cells, using edge particles found through triangles shared between cells and letting neighbours share them. In practice, as models get more complex and particle masses grow, these thin overlap bands **stop holding the model together**.

With Müller's cubic cells, overlap is simple: just use the neighbouring cells' particles. A cubic cell also uses its particles more completely and can hold any structure together. Tetrahedra should do equally well, since each cell has the same number of corner particles to overlap with neighbours. The thesis therefore uses **cubic clustering, built when the model is first loaded**.

Clustering has a general drawback. Each cell has its own $A_{qq}$ and $A_{pq}$ (§2.1.4), and the least-squares fit plus the stiffness $\alpha$ move its particles to their optimal positions. A particle shared by several cells therefore receives several transforms and stiffness contributions, which must be combined. The thesis counts the cells that use each particle and weights each cell's contribution by

$$\text{scale} = \frac{1}{n_{cells}}$$

where $n_{cells}$ is the number of cells using that particle, applied when computing goal positions. This averaging makes shared particles agree more closely. The same averaging **cannot** be applied when cell transforms move the actual vertex data, which sometimes produces visibly unpleasant overlapping vertices.

##### Collision response

A game engine, or a separate physics engine, handles collisions in phases. Geometry is grouped into "islands" of possibly colliding objects. A **broad phase** checks them with simple volumes (AABBs, bounding spheres, OBBs), and candidate pairs go to a **narrow phase**, which produces contact points, normals and momenta. The narrow phase may test volumes against polygons or do full polygon–polygon checks.

In the engine integration, the deformation model gets the contact information from the physics library: a number of contact points, the contact normal, and the collision momentum. Shape matching uses this event to move the cell particles of the cluster to their target positions. From the algorithm's point of view this produces the set $x_i$, which together with $x_i^0$ yields the goal positions.

##### Shape Matching

Figure 3.2 shows the full flow. Preprocessing loads the mesh and builds the cell cluster. Next the static centres of mass are computed for every cell, along with the symmetric matrices $A_{qq}$ from the static particles $x_i^0$; $A_{qq}$ holds scaling only, no rotation. For plastic materials, vertices must store, and update, the **static transformation matrix** that describes where the $x_i^0$ particles currently are. Vertices are moved every time step. This can also run on a separate update thread: drawn vertices are produced by transforming the original vertices with matrices, not by iterating their positions, so a skipped or doubled update does no harm.

```text
[reconstructed from the Figure 3.2 state diagram labels]
Start application
Pre-process:
    Load mesh
    Sample / clusterize mesh
    Calculate x0_cm            (per cell)
    Calculate Aqq              (per cell, from static particles x0_i)
    Prepare static vertex transform
Loop:
    Pre-integrate:
        apply external forces
        apply collision responses
        calculate intermediate positions x_i  (move x_next)
    repeat  ("iterate for stiffness and stability"):
        calculate x_cm
        calculate Apq
        if flipping (det(Apq) < 0):
            T = T_prev
        else:
            A = Apq * Aqq
            R = poldec(Apq)
            [optional] conserve volume
            T = beta * A + (1 - beta) * R
        g_i = T * q_i + x_cm
        (when iterating, goal positions are passed on as the new x_i)
    integrate (eqs 2.21, 2.22)
    if plasticity yield exceeded:
        update static vertex transform / static particles, recompute Aqq
    move vertices
```

> Figure 3.2: State diagram of the operation flow of the shape matching implementation.

**Pre-integration** produces intermediate positions and velocities with Euler integration (equations 2.1, 2.2). Müller [11] notes that shape matching stabilises Euler integration by driving the motion through the centres of mass. Verlet (equation 2.3) could still be used here to give shape matching better input $x_i$.

**Real-time matching** begins by computing the current centre of mass of each cell's particles, and from that $A_{pq}$. At this point **inversion ("flipping")** can already be detected from the sign of $\det A_{pq}$. Truly reversing a flip is hard: one would need to find the flipped axis and clamp the corresponding particles. Rivers [15] simply multiplies the matrix by −1, which negates every axis and leaves one or two of them wrong. The empirically better choice found here is to **reuse the previous valid transformation** while the cell is flipped.

Usually no flip happens and the optimal transform is computed normally. Polar decomposition [18] splits off the rotation $R$ and the scale/stretch $S$. Chentanez [2] reports trouble with singular matrices here, possibly because his version is quadratic; in the thesis test environment singular matrices were rare.

**Volume conservation** simply divides $A$ by the cube root of its determinant, $A \leftarrow A / \sqrt[3]{\det A}$. It is a configuration option because it tends to destabilise cases dominated by the linear transform.

The final matrix $T$ blends the purely rotational matrix with the optimal linear one using $\beta$ (equation 2.19), which sets how much of the linear part is used. For the system to work, $\beta$ must lie in $[0, 1)$; as $\beta \to 1$ nothing really supports the shape and it cannot be held.

The goal positions follow from $T$. In the clustered tests, denser clusters needed **more than one shape matching pass** to get reasonable stiffness; each extra pass replaces $x_i$ by $g_i$ and matches again.

The particles are then moved to their final positions with equations 2.21 and 2.22, and the **plasticity yield** is tested to decide whether the static $A_{qq}$ matrices must be updated. Müller's paper [11] defines the yield as a *spectral norm* of $(S - I)$. A spectral norm needs the largest singular value, i.e. an eigenvalue decomposition, which is too expensive here. When asked, Müller explained that his system actually used the **Frobenius norm** and that the paper's notation was misleading. The Frobenius norm is far cheaper:

$$\lVert A \rVert_F^2 = \sum_{i=1}^{m}\sum_{j=1}^{n} \lvert a_{ij} \rvert^2 \tag{3.1}$$

The result is compared with a user-set yield value. Above it, plastic deformation occurs and the static matrices are recomputed; otherwise the simulation continues, applying forces or waiting for collision responses.

### 3.2 Additional stiffness

Müller [11] sets material stiffness with $\alpha$ (equation 2.21). That suffices for an object in one cluster, but bending-like metal behaviour with linear transforms needs many cells, since the cell count sets how flexible local deformation can be. More cells cost more matching time, and $\alpha$ also **loses its effect** through averaging with neighbours. It works within a cell, but doubling the number of cells roughly **halves** the stiffness it provides, because each cell now has more neighbours pulling on it (Figure 3.6).

Possible remedies:

1. **Iterate** the shape matching loop several times (the traditional approach). Iteration could also be **prioritised** around the collision point.
2. Use a **hierarchical cluster**. $\alpha$ has more effect on fewer cells, so large cells near the top of the hierarchy add stiffness while small cells add detail when an impact is big enough.

The implementation uses the first, plain iteration, because it needed no rework of the clustering. The hierarchical approach is left for future study; it would also allow other parameters to be applied hierarchically. Prioritised iteration is considered only a minor optimisation.

### 3.3 Deformation Editor

Most development happened outside the game engine, which gave an isolated test bed and ensured the framework really worked as a standalone component. For repeated experiments and live parameter tweaking, the author built an editor called **DeformEd**. It loads objects dynamically, builds clusters of different sizes, and, most importantly, deforms models in real time (Figure 3.3).

> Figure 3.3: The editor interface — a model inside a very simple cluster of cells, with the basic parameters that control the deformation (colours altered for print).

The editor and its GUI are written in C#, which reinforces the component split: it loads the framework as a DLL (class diagram in Figure 3.4). Having a separate editor paid off for studying the simulation in isolation, but it took real work, because engine features could not simply be lifted out. Several pieces had to be written from scratch: OBJ loading, a basic DirectX renderer with debug visualisation, mouse selection, interaction and camera control, simple physics, collision response, animation components, and live parameter editing from the GUI.

> Figure 3.4: Class diagram of the editor (MainApplication, MainForm, GUI, Scene, Camera, Model, ObjLoader, RenderThread, DeformLibWrapper) and the deformation library (DeformableSM, DeformCluster / DeformClusterCell, CubeCluster / CubeClusterCell).

The editor makes many features easy to see. Figure 3.5 contrasts mostly linear with mostly rotational transforms, i.e. different values of $\beta$ in equation 2.19: the bottom vertex is pinned in place and the top one is dragged to the right. Blending between the two extremes covers behaviour from rigid to more elastic materials.

> Figure 3.5: Linear vs. rotational transform for the same fixed vertex positions.

Figure 3.6 shows how cluster size affects flexibility. Larger clusters are more flexible, but they are also **less stiff**: all images use the same material settings and vary only the cluster size. This is the reason for the additional stiffness mechanism of §3.2 on top of the one in [11].

> Figure 3.6: Cluster sizes 1, 8, 27 and 64 cells — more cells make the object less stiff.

Figure 3.7 shows a real in-game car body deformed by hand in the editor. It uses **39 cells**, which seems enough for a basic level of deformation. A future editor could allow hand-tuned clustering to add detail where needed.

> Figure 3.7: Original and deformed car in the editor.

### 3.4 Integration with the Game Engine

The framework only pays off once it is in the engine. Engines are the core of a game: some studios license one, some build their own, and many buy middleware for specific areas (physics, menus, vegetation, …), whether for lack of resources or because a publisher requires it. An engine built from isolated components makes swapping any one of them mostly a matter of matching interfaces.

Because the framework was designed as an isolated component from the start, replacing the engine's old deformation system was fairly easy. Still, the integration needed these additions and changes:

- A game car consists of several meshes with their own transforms, not one mesh as in the editor; the meshes are mapped onto **one deformation model** so the deformation stays consistent across the car.
- Besides vertices, **normals, binormals and tangents** must be transformed.
- Parameters must be adjustable at run time to suit different materials.
- A cluster must support **additional components with parameters of their own**.
- Common parameters must be set **automatically for specific car parts** (engine, base, etc.).
- Many **visual debugging** tools.
- Platform-specific optimisation.

The isolated test environment was clearly useful for building the framework, but similar tools inside the running game are useful for fine-tuning the deformation parameters. The engine therefore offers similar visualisation and live parameter editing through its existing external interface. Figure 3.8 shows a cluster after some car deformation in the test environment.

> Figure 3.8: Shape matching deformation in the test environment.

An ongoing optimisation study, together with a comparison against the engine's previous deformation system, will decide how far the shape matching system is adopted. It already runs very well on the CPU; another question is whether to use it for objects besides cars. Comparing **artist-modelled deformation** with shape matching suggests each offers something the other lacks, so a **hybrid** may look best: shape matching for large-scale deformation, artist-authored high-frequency detail on top, and the result blended between the two.

### 3.5 Plasticity extension

Simulating plastic objects was the main goal. Müller [11] covers plasticity only briefly and does not say how to choose plasticity coefficients or where plasticity belongs in the pipeline. The paper proposes a norm of the linear part of the least-squares matrix (§3.1.2); when it exceeds a user-set **plasticity yield**, deformation becomes permanent. Two further parameters are named: **creep**, the rate (slope) of plastic flow, and **maximum plasticity**, the cap on how much deformation can occur in one time step.

Experiments showed that linear-only plasticity, especially combined with volume-conserving cells, goes **unstable quickly** under extreme deformation. The rotational part appeared to make the system more robust because it does not overshoot, which led to the idea of folding rotation into the plasticity as well.

The change is small:

- The yield measure uses the blended matrix of equation 2.19, which contains both parts, instead of the linear $(S - I)$ of equation 2.18:
  $$\text{yield if}\quad \lVert T - I \rVert_F > \text{plasticity yield}$$
- When it is exceeded, the **control particle positions are updated by the transform**.
- The per-cell matrices $U$ that transform the original mesh vertices are updated incrementally:
  $$U_{vertices} \leftarrow T\, U_{vertices}$$
- The **static centres of mass are moved to the current ones** for every cell:
  $$x_{cm}^0 \leftarrow x_{cm}$$
  This is required because the transforms are expressed relative to these positions and could not be recomputed otherwise without needless overhead.

No separate transform from the original to the static particle positions is stored; applying the static part directly to the control particles is cheaper. Figures 3.9 and 3.10 compare linear-only plasticity with the rotation-included version.

> Figure 3.9: Initial state, two steps of linear plasticity, and release — no bending is achieved.

Linear plasticity cannot express bending (Figure 3.9). In more complex meshes it also causes a failure mode where neighbouring cells cannot agree on compatible linear deformations and **keep pushing each other apart**.

> Figure 3.10: Initial state, one plasticity step, release and fall — the object stays bent.

With the full simulation transform included, the object bends (Figure 3.10). The current implementation does **not** apply creep to blend the transform: metal deformation in a car crash is close to instantaneous, so once the yield is crossed the deformation simply stays.

### 3.6 Transforming normals

The lighting normals of the original vertices must be recomputed as well. The vertex transforms can be reused, but normals must be multiplied by the **inverse transpose** of the transformation; see Matt Pharr's article [14] for the derivation:

$$n_{new} = \left(T^{-1}\right)^{T} n_{old} \tag{3.2}$$

Binormals, tangents and similar vertex attributes are updated the same way.

## Chapter 4 — Conclusions

### 4.1 Results

Realistic real-time deformation remains a research goal. Different approaches suit different needs, and full physical accuracy may not even be wanted given its cost. Games in particular will keep relying on approximations that look right.

*Meshless deformations based on shape matching* [11] proved able to simulate plastic deformation in real time. It needed two extensions: **extra stiffness** for objects with many cluster cells, and **rotation in the plastic part**, which enables discrete bending with only the linear least-squares fit. Meshless and point-based methods look promising because they are fairly easy to tune and flexible. Finer visual detail could come from a hybrid with the existing mesh-morphing method. The method also suits the GPU, but that is mostly a load-balancing question, since GPU shaders are already busy.

Overall the chosen method worked well: simple, yet flexible enough to support several materials and other features. The thesis also surveys the most common mesh deformation methods and gives the maths needed to start working with them.

### 4.2 Future Work

The framework will stay in the engine and will probably gain some of the other reviewed methods, allowing an extensive real-time comparison. It should also support **fracture**, which would need fast mesh-capping and probably extra adjustable per-cell parameters.

Damage-system deformation and fracture matter to everyone doing real-time simulation, since current hardware allows things that were impossible before, and the scope for accurate, large-scale physics will keep growing. Interest in FEM has recently grown and research seems to be heading there. As in many graphics and physics topics, better preprocessing and faster consumer hardware will widen what is possible.

### 4.3 Summary

The thesis introduces deformation in interactive simulation, with real-time deformation for car racing games as the focus. It describes the theory and current methods with the necessary maths.

To improve dynamic collisions in a racing game, it uses *Meshless Deformations Based on Shape Matching*. Its core parts are shape matching itself, splitting the mesh into a cluster of cells for more deformation freedom, and plasticity.

The implementation chapter describes the framework's structure, discusses implementation issues and possible improvements, and introduces two extensions to the original method: **additional stiffness** and **rotation in the plasticity**. Diagrams and screenshots illustrate the framework and the theory.

## References (subset relevant to this repo)

The full bibliography (20 entries) is omitted. Entries relevant to this codebase:

- [2] N. Chentanez, *Deformable body simulation on GPU*, NVIDIA SDK 10 whitepaper, 2007 — quadratic shape matching on GPU, k-means clustering.
- [8] T. Jakobsen, *Advanced Character Physics*, GDC 2001 — Verlet integration and constraint projection.
- [11] M. Müller, B. Heidelberger, M. Teschner, M. Gross, *Meshless deformations based on shape matching*, SIGGRAPH 2005 — the base method (see `MeshlessDeformations_SIG05.pdf`).
- [14] M. Pharr, *Transforming normals*, 2005 — derivation of equation 3.2.
- [15] A. R. Rivers, D. L. James, *FastLSM: fast lattice shape matching for robust real-time deformation*, ACM TOG 26(3), 2007 — lattice clusters, flip handling, polar caching.
- [17] T. W. Sederberg, S. R. Parry, *Free-form deformation of solid geometric models*, SIGGRAPH 1986 — FFD cages.
- [18] K. Shoemake, T. Duff, *Matrix animation and polar decomposition*, Graphics Interface 1992 — polar decomposition.

## Appendix A — Deformation Methods in Use

A condensed summary of the 2006 *Computer Graphics Forum* survey [13], meant as a quick index to methods with the desired properties and their key references. See the original papers for details.

| Category | Method | Properties noted |
|---|---|---|
| Lagrangian mesh-based | Finite Element (FEM) | PDEs solved on an irregular grid; volumetric computation; explicit, implicit (expensive) and semi-implicit variants; a few real-time implementations |
| Lagrangian mesh-based | Finite Differences (FD) | semi-implicit; boundary handling issues; local adaptation only for irregular meshes; extended to plasticity and fracture |
| Lagrangian mesh-based | Finite Volume | an improvement over FEM |
| Lagrangian mesh-based | Boundary Element (BEM) | surface-only computation; interior assumed homogeneous; reduces the integral of motion from 3D to 2D; topology changes are hard; reaches real time |
| Lagrangian mesh-based | Mass-spring systems | point-mass network built from a discrete model; coupled ODEs; shear and structural springs; damping as a viscosity force; many real-time implementations; stability problems |
| Lagrangian mesh-based | Particle systems | mass-spring extended with deformation energies; forces preserve distances, areas, volumes; separate bending models |
| Lagrangian mesh-free | Loosely coupled particle systems | no well-defined surface; spatial coupling (faster when limited to neighbours); can use an implicit surface; volume conservation is problematic; influence graph over a sphere of influence; used for granular materials |
| Lagrangian mesh-free | Smoothed Particle Hydrodynamics (SPH) | discrete smoothed particles approximate field values; mass conserved trivially; suits real time; incompressibility cannot be maintained; implicit surface coating; used for fluids, hair, deformable bodies, … |
| Mesh-free | Point-based animation | mesh-free physics with point-sampled surfaces; first-order accurate (moving least squares); from stiff elastic to highly plastic; extends to fluids; real-time possible; implicit for fluids, explicit for solids; extended to fracture; deformable collision detection; surface skinning; efficient ray tracing |
