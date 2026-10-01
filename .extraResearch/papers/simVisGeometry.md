# Simulating Visual Geometry

**Authors:** Matthias Müller, Nuttapong Chentanez, Miles Macklin (NVIDIA Research)
**Venue:** MIG '16 (Motion in Games), October 10–12, 2016, Burlingame, CA, USA. DOI: 10.1145/2994258.2994260

> Figure 1: Left — a car model driven by the method: it can be steered, dented, shattered, and it interacts with its surroundings as one would expect. Right — the underlying simulation model, made of convex polyhedra derived from the faces of the input mesh.

*Rewrite note: prose is paraphrased and condensed; section order, equations, numbers and captions are preserved in meaning. Equation reconstructions from garbled PDF text are flagged `[reconstructed]`.*

## Abstract

Simulated objects in graphics usually carry two or three separate representations: a render (visual) mesh, a simulation mesh, and a set of convex shapes for collision. Maintaining several representations costs authoring effort, complicates runtime handling, and causes artifacts when collision behaviour and visual appearance disagree. The reason for multiple representations is mostly performance in real-time settings. The authors argue that virtual worlds should ultimately be *WYSIWYS* — "what you see is what you simulate", manipulate and touch.

The paper proposes a single representation used for simulation and collision that is very close to, and derived directly from, the visual input mesh, plus a visualization mesh that is almost identical to it. The input mesh needs no preparation: it may be non-manifold, non-conforming and self-intersecting.

**Keywords:** deformation, fracture, tearing, convex primitives, oriented particles, rigid body simulation.
**CCS concepts:** Computing methodologies → Physical simulation.

## 1 Introduction

Film and game assets are authored in DCC tools as triangle or quad meshes describing the surface. They are tuned for rendering and rigged kinematic animation, not for physics. A key difficulty: visual meshes are usually *non-conforming* — elements overlap, and parts such as a cup and its handle are often separate meshes that intersect rather than one connected surface.

The common workaround is to not simulate the visual mesh but embed it in a simulation mesh or attach it to something more general such as a mass-spring network or a skeleton. Benefits: the simulation resolution is independent of the visual tessellation (usually coarser, so fine visual detail costs nothing), and the input mesh can be anything, even a triangle soup. Drawbacks: building a suitable simulation mesh is non-trivial; two representations complicate the code; tearing/fracturing the visual mesh in step with the physical one is hard; and the mismatch between representations can produce visible artifacts.

Simulating detailed visual geometry in real time has been limited by console memory and compute. Cloud gaming could change this since simulation could run on a powerful remote machine. The authors therefore aim at simulating every visible detail — WYSIWYS — which they consider especially important for VR.

As a step toward this, they use a simulation mesh that is very close to the visual mesh, with convex shapes as primitives. Primitives come either from extruding the visual mesh's polygonal faces along the negative normal, or from identifying convex regions enclosed by visual faces.

Primitives are linked in a general graph: two primitives are connected if they touch or overlap in the rest state. The structure is simulated efficiently by treating each primitive as an *oriented particle* [MC11]. Using convex polyhedra instead of the original ellipsoids lets the model represent flat faces, sharp edges and corners. Exact shapes matter most after fracture, when pieces sit close together (Figure 7). Because the primitives are convex polyhedra, the subdivision/fracture approach of [MCK13] applies directly. Hierarchically, larger parts (e.g. the car's doors and hood in Figure 1) are grouped into bodies connected by joints. Since rigid-body engines such as PhysX represent objects as collections of convex shapes, these bodies can be simulated directly at that higher level. The representation is quick to build and is maintained straightforwardly through deformation and fracture.

**Contributions:**
- Representing objects by convex polyhedra derived directly from the visual mesh, with connectivity defined by rest-state proximity.
- Simulating these polyhedra with the oriented-particle approach instead of ellipsoids.
- Deforming the primitives with the affine transform provided by shape matching (a general idea, usable in other frameworks).
- A graphical mesh that tracks the primitives closely, stays watertight under deformation, and is easy to tear and fracture.
- Extending [MCK13] from brittle to ductile fracture, and simulating detailed deformation in coarsely tessellated regions of the mesh.

## 2 Related Work

The method combines a few core ideas — a general, non-conforming unstructured mesh, a rigid-body formulation fused with a deformable model, fracture and tearing, and a unified position-based-dynamics (PBD) solver [BMM15]. Only the most relevant work in each area is cited.

### 2.1 Simulation Models

Solids have been modelled with mass-spring networks [SLF08] and regular grids with finite differences [TF88]. Regular grids have also been paired with FEM [MTG04]. Tetrahedral meshes simulated with FEM are the most popular choice for deformable volumes, e.g. [OH99], [ITF04]. Connectivity-free particle approaches exist too; FEM can be phrased for them via moving least squares (MLS) [MKN04]. MPM, a hybrid alternating between particles and a grid, has become popular [SSC13], [SSJ14], [RGJ15], and Eulerian grids have also been proposed for solids [PLF14].

The paper uses the oriented particles method of Müller et al. [MC11]: particles carrying orientation, connected in an arbitrary unstructured way — a generalization of shape matching [MHT05], [RJ07]. It is related to elastons [MKB10] in that it handles 1D, 2D and 3D objects uniformly. Faure et al. [FGBP11] similarly use oriented control points to define a continuous deformation field. Choi et al. [Cho] extended oriented particles with tearing and fracture.

The solver is the unified PBD solver of Macklin et al. [MMCK14], extended to handle convex polyhedra as primitives in addition to spheres, plus a position-based rigid-body formulation similar to Deul et al. [DCB14]. Bouaziz et al. [BML14] added an inertia term to PBD to make it consistent with implicit Euler and reduce damping; the same can be achieved with a second-order velocity update [BMM15].

### 2.2 Embedding of a Visual Mesh

Visual meshes in games and film are typically not tuned for simulation, so the dominant approach is to embed them in a simulation mesh — an idea going back to free-form deformation by Sederberg and Parry [SP86], where an object follows a deformed surrounding cage. Müller et al. embedded visual meshes in tetrahedral meshes [MG04] and regular grids [MTG04], and showed how to split the embedding when the simulation mesh fractures. Instead of interpolating vertices from a surrounding mesh, linear blend skinning combines the transforms of skeleton bones [MTLT]. In [MC11] a visual mesh is attached to oriented particles in a similar way, blending the transforms of nearby particles by position and orientation. Without an enclosing volumetric mesh, however, splitting the visual mesh is hard. Jones et al. [JML16] avoid arbitrary surface meshes and instead build a conforming tetrahedral mesh for visualization that they split along tetrahedral boundaries — which can expose tetrahedral structure as artifacts. The fracture method of [MCK13], in contrast, keeps the mesh structure hidden: after tearing/fracture only the tear lines of the fracture pattern are visible.

### 2.3 Fracturing and Tearing

Terzopoulos and Fleischer [TF88], pioneers of physically based animation, also introduced fracture to graphics: links in a regular finite-difference grid broke when stress exceeded a threshold. O'Brien et al. used tetrahedral FEM for brittle [OH99] and ductile [OBH02] fracture, deriving crack directions from internal stresses; much follow-up work used similar ideas. For games, FEM stress analysis is usually too costly. The traditional approach is pre-fractured models swapped in at runtime, which ignores the actual impact location. Bridging these extremes, Su et al. [SSF09] applied predefined fracture patterns at the impact point at runtime using signed distance fields. Müller et al. [MCK13] made this pixel-accurate and game-ready by representing both objects and fracture patterns as convex decompositions — the approach used here.

> Figure 2: From visual to simulation mesh (2D cut). Top: input triangles (dark blue) are extruded into convex primitives (light blue). Second row: vertices of the primitives (light blue) are grouped and their positions averaged (red) for visualization, giving a consistent inner surface. Third row: during simulation the primitives change pose, potentially opening gaps. Bottom: the gaps close when the averaged positions are used for visualization.

> Figure 3: Left: if enclosed convex shapes are found in the visual mesh, they become single primitives. Right: visual faces that do not belong to an enclosed volume are extruded.

> Figure 4: Joint definition. Joints are specified as boxes. A box's pose sets the joint's location and extent; its name encodes the joint type and the bodies it connects.

## 3 The Method

This section walks through the pipeline from a visual mesh to a physical simulation.

### 3.1 Physical Mesh Creation

**Input.** A visual mesh of triangles and quads whose faces may intersect each other. Physical properties that cannot be inferred from geometry are assigned by the user per sub-mesh, analogous to graphical material parameters — e.g. **thickness**, **material type** (soft, plastic or brittle) and **stiffness**.

**Primitives.** From this the simulation mesh is built automatically (Figures 2 and 3). Each face becomes a convex polyhedron by extruding it along its negative normal by the user-defined thickness; these polyhedra are the simulation primitives (Figure 2, top row, 2D cut: faces as dark segments, primitives as light boxes). Optionally, visual geometry that encloses a convex shape is turned into a single primitive (Figure 3); only faces not consumed this way are extruded. This permits more general convex primitives and filled shapes.

**Connectivity.** A link is created between every pair of primitives that touch or intersect, giving a general (graph) mesh structure. Separate input meshes that only overlap visually thereby become physically connected.

**Joints and attachments.** For assemblies like the car, the user connects sub-meshes with joints, specified as extra boxes whose (mesh) name gives the joint type and whose pose gives the orientation of the local axes (Figure 4). In addition, every primitive of a soft body is automatically attached to rigid bodies it overlaps — this is how soft tires get attached to their wheels with no extra authoring.

```
build_simulation_mesh(visual_mesh, materials):
    prims = []
    for each enclosed convex region C in visual_mesh (optional):
        prims += convex_primitive(C)                 # Figure 3, left
    for each face f not consumed above:
        t = materials[submesh(f)].thickness
        prims += convex_hull(f.vertices ∪ (f.vertices - t * f.face_normal))
    links = { (a,b) : a,b in prims, a touches or overlaps b in rest state }
    joints = user boxes → (type, bodyA, bodyB, frame, extent)  # from box name/pose
    for each soft-body primitive p, each rigid body B overlapping p:
        add attachment(p, B)
    return prims, links, joints
```

### 3.2 The Simulation Method

A unified solver operates on convex polyhedra. Because primitives have extent and orientation and their connectivity is an arbitrary graph, the oriented-particle approach [MC11] fits naturally. **One shape-matching group is defined per primitive together with its 1-ring neighbours.** These groups serve both for soft-body simulation of whole objects and for plasticity inside otherwise rigid objects. The stability of the method lets it handle fine structures robustly.

**Collision.** Since all primitives are convex polyhedra, standard sweep-and-prune (broad phase) and the separating axis theorem (narrow phase) apply. With so many primitives, collision detection becomes the bottleneck — notably even when only a few rigid objects are simulated, as in the car scene — yet detailed contact is still wanted. A three-stage scheme is used:

```
collide(objects):
    # stage 1: object-level broad phase
    pairs = sweep_and_prune(bounds(o) for o in objects)
    for (A, B) in pairs:
        box = intersect(bounds(A), bounds(B))
        # stage 2: primitive-level broad phase restricted to the overlap region
        PA = [p in A.prims if bounds(p) ∩ box ≠ ∅]
        PB = [q in B.prims if bounds(q) ∩ box ≠ ∅]
        cand = sweep_and_prune(PA ∪ PB, cross-object pairs only)
        # stage 3: narrow phase
        for (p, q) in cand:
            if SAT_convex_convex(p, q) reports overlap: emit contact(p, q)
```

> Figure 5: Simulating a curtain. Top: plain oriented particles. Middle: the local affine transform from shape matching is applied to the primitives, which reduces gaps substantially. Bottom: the visual mesh.

### 3.3 Deforming Primitives

Standard oriented particles only change the position and orientation of primitives, which can leave gaps and collision artifacts (Figure 2 third row; Figure 5 top). Changing primitive shapes arbitrarily, though, could break convexity, which both collision handling and fracture depend on. The authors' remedy: deform each primitive with the **local affine deformation matrix** that oriented particles already compute. A linear map preserves convexity, and gaps shrink a lot (Figure 5, middle).

Following [MC11], the local moment matrix of a primitive's neighbourhood (the particle and all its neighbours) is

$$
\mathbf{A} \;=\; \sum_i \left( \mathbf{A}_i + m_i\, \mathbf{x}_i \bar{\mathbf{x}}_i^{T} \right) \;-\; M\, \mathbf{c}\, \bar{\mathbf{c}}^{T}, \qquad \mathbf{A}_i = \tfrac{1}{5}\, m_i\, r_i^{2}\, \mathbf{R}_i \tag{1}
$$

`[reconstructed]` — the extracted text reads "$\mathbf{A}_i = m_i r_i \mathbf{R}_i$"; the $\tfrac15$ and $r_i^2$ follow the solid-sphere moment of [MC11] and the matching $\bar{\mathbf{A}}_i$ in Eq. (3).

Here $\mathbf{R}_i$, $m_i$, $r_i$, $\bar{\mathbf{x}}_i$, $\mathbf{x}_i$ are the orientation matrix, mass, radius, rest position and current position of primitive $i$; $M$ is the neighbourhood's total mass; $\bar{\mathbf{c}}$ and $\mathbf{c}$ are its rest and current centres of mass.

$\mathbf{A}$ suffices to extract an optimal rotation but is not the true best-fit affine transform (as noted in [MHT05]). Generalizing the [MHT05] normalization to oriented particles gives the deformation matrix

$$
\mathbf{D} \;=\; \mathbf{A}\, \bar{\mathbf{A}}^{-1} \tag{2}
$$

with

$$
\bar{\mathbf{A}} \;=\; \sum_i \left( \bar{\mathbf{A}}_i + m_i\, \bar{\mathbf{x}}_i \bar{\mathbf{x}}_i^{T} \right) \;-\; M\, \bar{\mathbf{c}}\, \bar{\mathbf{c}}^{T}, \qquad \bar{\mathbf{A}}_i = \tfrac{1}{5}\, m_i\, r_i^{2}\, \mathbf{I}. \tag{3}
$$

Rewriter's remark: $\sum_i m_i \mathbf{x}_i\bar{\mathbf{x}}_i^T - M\mathbf{c}\bar{\mathbf{c}}^T = \sum_i m_i(\mathbf{x}_i-\mathbf{c})(\bar{\mathbf{x}}_i-\bar{\mathbf{c}})^T$, so (1) is the familiar $\mathbf{A}_{pq}$ plus per-particle rotational terms and (3) is $\mathbf{A}_{qq}$ plus per-particle isotropic terms.

The normalization need not run every solver iteration — **once per time step, before collision handling**, is enough.

```
per time step:
    for each primitive p:
        N = {p} ∪ one_ring(p)
        A    = Σ_{i∈N} (1/5 m_i r_i² R_i + m_i x_i x̄_iᵀ) − M c c̄ᵀ
        Abar = Σ_{i∈N} (1/5 m_i r_i² I   + m_i x̄_i x̄_iᵀ) − M c̄ c̄ᵀ   # constant unless rest state changes
        D_p  = A · Abar⁻¹
        shape(p) = D_p applied to p's rest-local vertices   # linear map keeps p convex
    collision handling uses the deformed shapes
```

### 3.4 The Visualization Mesh

Affine-deformed primitives reduce collision artifacts but still leave small visible gaps (Figure 5). The authors therefore introduce a visualization mesh that stays close to the simulated primitives and for which tearing and fracture are straightforward — unlike attaching an arbitrary mesh to an independent simulation mesh, which requires on-the-fly boolean operations.

**Idea:** vertices belonging to different primitives are welded for display. Every vertex of every primitive stores an identifier `id` that is global within its body. Vertices sharing an `id` are joined in two passes:

```
visual_positions(body):
    sum[id] = 0; cnt[id] = 0
    for each primitive p in body:                  # pass 1: scatter
        for each vertex v of p (deformed, world space):
            sum[v.id] += v.pos; cnt[v.id] += 1
    avg[id] = sum[id] / cnt[id]
    for each primitive p, each vertex v of p:      # pass 2: gather
        v.visual_pos = avg[v.id]
```

Even undeformed, the inner surface of the simulation mesh has gaps (Figure 2, top); the visualization mesh has a consistent inner surface (second row), and the bottom row shows the visual mesh (red) over a deformed simulation mesh (blue). Since primitives come from faces of a polygon mesh, the input mesh's vertex index serves as the global id inside each primitive. Extruded vertices get the same connectivity structure, so the mesh is also closed on the inside — even though extrusion uses face normals rather than vertex normals.

### 3.5 Plastic Deformation

**Rigid between impacts.** A rigid part is simulated as *one* rigid body between deforming impacts. Only when it deforms plastically is the oriented-particle machinery used, to rearrange its primitives locally in a **quasi-static** simulation. This is a large speed-up: the Figure 1 car has 17k primitives but only 20 rigid parts and runs at over 100 fps. Because the detailed mesh is still used for collision, simulation fidelity is unchanged.

**Triggering.** The solver loops over the contacts reported by the collision engine and checks whether the **relative normal velocity exceeds a material threshold**. The **deformation offset** is that relative normal velocity times the time step; it is transformed into the objects' local frames and used to displace the participating primitive(s). After all contacts are processed, all primitives are relaxed quasi-statically while **primitives intersecting the joint shapes are held fixed**. That is why joints need a spatial extent: they are the boundary conditions of the static solve. Afterwards the containing object's centre of mass and inertia tensor must be recomputed.

```
on_contacts(contacts, dt):
    touched = {}
    for each contact k between primitive p (body B) and other body:
        vn = relative_normal_velocity(k)
        if |vn| > material(B).plastic_threshold:
            offset_world = vn * dt * n_k                # deformation offset
            offset_local = to_local_frame(B, offset_world)
            p.rest_local += offset_local                 # displace the primitive
            touched += B
    for each body B in touched:
        fixed = { p in B.prims : p intersects any joint box of B }
        quasi_static_shape_matching(B.prims, pinned = fixed)   # oriented particles, no dynamics
        recompute_center_of_mass_and_inertia(B)
```

> Figure 6: Tearing. To tear a mesh, a fracture pattern is first applied to subdivide the surface. Only some of the links between primitives are marked tearable, giving a predefined tear pattern.

> Figure 7: A glass fracture pattern applied to the car's window. The small pieces stay at the correct places on the detailed surface and inside the car.

### 3.6 Subdivision, Fracture and Tearing

Convex-polyhedron primitives also allow reuse of [MCK13] for fracture. A *fracture pattern* is a connected set of convex polyhedra, like the objects themselves. The pattern is aligned with the impact location, every primitive of the object is cut against every fracture cell, and all pieces inside one cell are merged into a new independent object. This yields brittle fracture, used for the shattering car windows (Figure 7).

**Modification for ductile fracture and adaptive detail.** Instead of separating the pieces right away, keep them all in the *same* object. Applying a pattern then simply **subdivides the mesh near the impact**, allowing detailed deformation where the original mesh was coarse. The door wings in Figure 10 start with only a few large faces; after a pattern is applied, small-scale dents appear. Fine tessellation is created only where and when needed.

Two more extensions enable ductile fracture and tearing (Figure 6):

1. **Strain-limit breaking.** For each connected pair of primitives, test whether their distance exceeds a threshold — the material's strain limit times the rest length:
   $$\lVert \mathbf{x}_a - \mathbf{x}_b \rVert > \varepsilon_{\max}\, \lVert \bar{\mathbf{x}}_a - \bar{\mathbf{x}}_b \rVert \;\Rightarrow\; \text{link } (a,b) \text{ broken}$$
   `[reconstructed: notation mine; text says "threshold = strain limit × rest length" applied to the pair distance]`
2. **Only some links are breakable.** Only links created by applying a fracture pattern may break, not those from the original mesh; otherwise the initial tessellation would show in the fracture lines. This also lets an artist pre-author tear lines (Figure 6).

**Updating the visual mesh.** Thanks to the one-to-one correspondence between visual faces and primitives, this is far simpler than updating an independent visual mesh: only the global vertex ids need updating/recomputing (Figure 8).

*Fracture.* Deriving new ids from old ones after many new primitives appear would be hard. The trick: **always apply fracture patterns in the undeformed (rest) configuration**. There, vertices that should share an id — new or old — are exactly the ones at the same position, which is found efficiently by sorting vertices along the x, y or z axis. In Figure 8, the cut is made in rest space (left), co-located vertices get shared ids and averaged positions (middle), giving the deformed result (right).

```
regroup_ids_after_fracture(body):
    verts = all primitive vertices in REST configuration
    sort verts by x (or y or z)
    sweep sorted list; vertices with identical rest position → same new global id
    val[id] = number of vertices with that id
```

*Tearing.* Invariant: primitives that share a global id must be linked. Let `val(id)` be the number of vertices sharing `id` (available from the averaging pass). For a primitive and one of its ids:

```
split_id(prim, id):
    visited = flood_fill(start = prim,
                         step to neighbour q only if link alive and q contains id)
    if |visited| < val(id):
        id0 = new_global_id()
        for q in visited: replace id by id0 in q
        val(id0) = |visited|
        val(id)  = val(id) - |visited|

on_link_broken(a, b):
    for prim in {a, b}:
        for id in ids(prim): split_id(prim, id)
```

Figure 9 shows the result.

**Updating joints.** Joints again profit from having spatial extent. If an object splits into two or more parts it is deleted and replaced by new objects. Every new object is tested against all joints adjacent to the original; if a new object intersects a joint's volume, a new joint with the same attributes referencing the new object is created. Once all new objects and joints exist, the old body and joints referencing it are removed.

> Figure 8: Fracture of the visual mesh. Fracture is performed in the undeformed state, and grouped vertices are recomputed from scratch after each fracture event. Left: all vertices (light blue) at the same location are grouped. Middle: averaged positions in the deformed state. Right: the fractured mesh in the deformed state.

> Figure 9: Tearing of the visual mesh. Top: a set of primitives shares one visual vertex only if they are mutually connected; if a torn link separates two sets, each set gets its own visual vertex. Bottom: this produces the correct crack in the visual mesh.

## 4 Results

All examples ran on a single core of an Intel Core i7 at 3.1 GHz with a non-optimized serial implementation; the authors expect large gains from GPU parallelization.

| Scene | Objects | Joints | Primitives | Other | Performance |
|---|---|---|---|---|---|
| Car (Fig. 1) | 21 | 28 | 16k (17k quoted in §3.5) | some interior geometry removed, outer input mesh mostly as authored; authoring in Blender (Fig. 4) < 1 h | > 60 fps (>100 fps quoted in §3.5); internal static solver 1–10 ms per deforming hit |
| Curtain (Fig. 5) | — | — | — | demonstrates primitive affine deformation | — |
| Door (Fig. 10) | 4 | 4 | 700 at start; +≈1k per object on its first hit (deformation pattern) | — | > 100 fps between impacts |
| Monster truck, bursting tires (Fig. 11 bottom) | unmodified model + 9 joints | 9 | 45k; soft tires 2.5k each | soft-body attachments persist through tearing | 30 fps (most time in soft tires) |
| Monster truck on shaky bridge (Fig. 11 top two) | truck + bridge | — | bridge: 600 primitives, 1.5k attachments | ropes = soft bodies attached to static blocks; wooden steps = rigid bodies attached to ropes; tires interact via collision; tires attached to wheels, wheels jointed to car | 20 fps, stable with unified PBD solver |

The car stays above 60 fps because only the high-level objects are normally simulated; the internal static solver runs only on deformation. The accompanying video shows bullets and shattered pieces interacting with the car's detailed geometry. Figure 5 (curtain) shows the effect of applying shape matching's local affine transform to the primitives.

> Figure 10: A metal door is dented and torn. Each wing starts with only 8 faces; at runtime, applying the deformation pattern raises the tessellation density so small-scale features can be represented.

> Figure 11: Top: complex interplay of several material types, joints and attachments. Bottom: bursting tires show that attachments of soft bodies to rigid objects survive fracture.

## 5 Conclusion and Future Work

The paper presents a way to simulate artist-provided visual geometry directly, targeting a WYSIWYS virtual environment where a user could manipulate every detail. Visual faces become convex polyhedral primitives, all touching or overlapping primitives are connected into a mesh, and that mesh is simulated with oriented particles. At a higher level, sub-meshes become simulation objects joined by joints. Plastic objects are treated as rigid between collisions, which accelerates them substantially. Convex polyhedra allow standard collision algorithms, sharp features, and precise tearing and fracture. Currently every visual detail becomes a simulation primitive; the authors suggest it may be sensible to convert very small features into normal maps or similar and keep only elements above a size threshold in the physical mesh.

## References

- [BML14] Bouaziz, Martin, Liu, Kavan, Pauly — Projective dynamics: fusing constraint projections for fast simulation. ACM TOG 33(4), 2014.
- [BMM15] Bender, Müller, Macklin — Position-based simulation methods in computer graphics. Eurographics Tutorial, 2015.
- [Cho] Choi — Real-time simulation of ductile fracture with oriented particles. Computer Animation and Virtual Worlds 25(3-4).
- [DCB14] Deul, Charrier, Bender — Position-based rigid body dynamics. CASA 2014.
- [FGBP11] Faure, Gilles, Bousquet, Pai — Sparse meshless models of complex deformable solids. SIGGRAPH 2011.
- [ITF04] Irving, Teran, Fedkiw — Invertible finite elements for robust simulation of large deformation. SCA 2004.
- [JML16] Jones, Martin, Levine, Shinar, Bargteil — Ductile fracture for clustered shape matching. 2016.
- [MC11] Müller, Chentanez — Solid simulation with oriented particles. ACM TOG 30(4), 2011.
- [MCK13] Müller, Chentanez, Kim — Real time dynamic fracture with volumetric approximate convex decompositions. ACM TOG 32(4), 2013.
- [MG04] Müller, Gross — Interactive virtual materials. Graphics Interface 2004.
- [MHT05] Müller, Heidelberger, Teschner, Gross — Meshless deformations based on shape matching. SIGGRAPH 2005.
- [MKB10] Martin, Kaufmann, Botsch, Grinspun, Gross — Unified simulation of elastic rods, shells, and solids. ACM TOG 29(4), 2010.
- [MKN04] Müller, Keiser, Nealen, Pauly, Gross, Alexa — Point based animation of elastic, plastic and melting objects. SCA 2004.
- [MMCK14] Macklin, Müller, Chentanez, Kim — Unified particle physics for real-time applications. ACM TOG 33(4), 2014.
- [MTG04] Müller, Teschner, Gross — Physically-based simulation of objects represented by surface meshes. CGI 2004.
- [MTLT] Magnenat-Thalmann, Laperrière, Thalmann — Joint-dependent local deformations for hand animation and object grasping. Graphics Interface 1988.
- [OBH02] O'Brien, Bargteil, Hodgins — Graphical modeling and animation of ductile fracture. SIGGRAPH 2002.
- [OH99] O'Brien, Hodgins — Graphical modeling and animation of brittle fracture. SIGGRAPH 1999.
- [PLF14] Pai, Levin, Fan — Eulerian solids for soft tissue and more. SIGGRAPH 2014 Courses.
- [RGJ15] Ram, Gast, Jiang, Schroeder, Stomakhin, Teran, Kavehpour — A material point method for viscoelastic fluids, foams and sponges. SCA 2015.
- [RJ07] Rivers, James — FastLSM: fast lattice shape matching for robust real-time deformation. SIGGRAPH 2007.
- [SLF08] Selle, Lentine, Fedkiw — A mass spring model for hair simulation. ACM TOG 27(3), 2008.
- [SP86] Sederberg, Parry — Free-form deformation of solid geometric models. SIGGRAPH 1986.
- [SSC13] Stomakhin, Schroeder, Chai, Teran, Selle — A material point method for snow simulation. ACM TOG 32(4), 2013.
- [SSF09] Su, Schroeder, Fedkiw — Energy stability and fracture for frame rate rigid body simulations. SCA 2009.
- [SSJ14] Stomakhin, Schroeder, Jiang, Chai, Teran, Selle — Augmented MPM for phase-change and varied materials. ACM TOG 33(4), 2014.
- [TF88] Terzopoulos, Fleischer — Modeling inelastic deformation: viscoelasticity, plasticity, fracture. SIGGRAPH 1988.
