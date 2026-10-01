A practical way to build this is a **two-layer simulation**: a coarse deformable skeleton for global car structure, and a finer surface particle layer for dents and local impact response. Use a multigrid-style PBD solver to push large-scale deformation through the coarse nodes first, then project those corrections down to the fine layer; activate fine particles only near contacts or strong strain to keep the cost low.[1][5][7][14]

## Recommended structure

- **Coarse layer**
- Model major regions as a small set of structural nodes or clustered nodes: front crumple zone, rear crumple zone, passenger cabin, roof rails, doors, etc.
- Connect them with stretch, bend, and volume-preservation constraints, but keep coarse constraints relatively sparse.
- Treat the cabin as stiffer and the crumple zones as weaker, with asymmetric constraint strengths so the front/rear can fold while the cabin stays mostly intact.[5][7]

- **Fine layer**
- Add a dense surface particle shell for dents, panel ripples, and localized buckling.
- Embed fine particles in coarse clusters so each particle inherits a parent region and rest offset.
- Fine particles should follow the coarse deformation first, then add local corrections only where needed.[14]

## Practical solver flow

1. Build a hierarchy of clusters from coarse to fine.
2. At each frame, integrate velocities and predict positions.
3. Solve coarse constraints first, starting from the coarsest level and moving finer, as in hierarchical PBD / multigrid-style projection.[1][5]
4. Prolong the coarse correction to child clusters or embedded particles.
5. Activate fine particles only in contact regions, high-curvature zones, or where strain exceeds a threshold.
6. Solve local dent constraints on the active subset.
7. Recompute velocities from corrected positions and apply damping.

This follows the HPBD idea of a coarse-to-fine pass that accelerates convergence while preserving the robustness of PBD.[1][5][7]

## How to make the fine layer cheap

- Use **sleeping islands**: keep most particle clusters inactive until they are touched, highly strained, or near a collision manifold.
- Wake only the connected component around the impact and a small halo of neighboring clusters.
- Store fine particles in contiguous arrays by island to improve cache behavior.
- Run broad-phase and contact detection only on active islands; leave sleeping islands frozen except for coarse inherited motion.

## Shape matching use

For the fine shell, multi-resolution shape matching is a good fit:

- Cluster particles into overlapping or nested groups.
- Compute a goal shape for each cluster from current positions.
- Pull particles toward the matched goal to preserve local panel shape and recover after impacts.[14]
- Use smaller clusters near the surface and larger clusters deeper in the hierarchy for stability and faster convergence.

A hybrid approach works well: **shape matching for local cohesion**, **PBD constraints for edges, attachments, and panel limits**, and **hierarchical propagation for global deformation**.[14]

## What performance is realistic

For **100–1000 particles per object**, 60 Hz in JavaScript or WebAssembly is realistic if the solver stays simple and activation is sparse. WebAssembly SIMD helps most when the workload is dominated by vector math over arrays, and particle-style simulation is one of the cases where SIMD usually pays off.[4]

Practical expectations:

- **100–300 active particles** per vehicle: comfortable in JS/Wasm with modest iterations.
- **300–1000 particles** per vehicle: feasible if only a fraction are active per frame and constraint iterations are limited.
- **Multiple cars at once**: needs aggressive sleeping, island management, and reduced iterations for distant objects.[4]

## Main pitfalls

- **Too many solver iterations**
- HPBD helps convergence, but if the hierarchy is too deep or the iteration count is high, frame time will spike.[1][5]

- **Overconstrained coarse levels**
- Coarse constraints should not overly resist bending or folding; otherwise large deformations get blocked and the object feels rigid.[5]

- **Bad activation thresholds**
- If islands wake too often, performance collapses.
- If they wake too late, impacts look mushy or delayed.

- **Broken coupling between coarse and fine layers**
- If fine particles are not properly embedded in coarse clusters, dents can drift, detach, or jitter.
- Keep a stable parent-child mapping and update fine rest offsets consistently.

- **Branch-heavy contact code**
- SIMD helps less when logic is branchy, so keep collision code simple and separate from the vectorized solve where possible.[4]

- **JavaScript allocation churn**
- Avoid per-frame object creation.
- Use typed arrays and reuse buffers to prevent GC spikes.

- **Too many active constraints per contact**
- Local denting looks better with a small active patch than by waking the whole mesh.

## A good implementation recipe

- Use a coarse cluster graph for the vehicle body.
- Use embedded surface particles for visible panel deformation.
- Solve coarse PBD constraints with a hierarchical coarse-to-fine pass.
- Wake fine islands only near impacts.
- Use shape matching inside each active island for local cohesion.
- Keep data in flat typed arrays and move the heavy solve into WebAssembly if possible.
- Start with one or two solver iterations on inactive frames, then raise iterations only for active impacts.

If helpful, a concrete data layout and frame loop in JavaScript/Wasm style can be sketched next.

[1] [PDF] Hierarchical Position Based Dynamics - GitHub Pages (https://matthias-research.github.io/pages/publications/hpbd.pdf)
[2] vriphys08 (https://diglib.eg.org/collections/f1a6a1cb-8230-469a-978c-0118bfbed367)
[3] [PDF] Hierarchical Position Based Dynamics | Semantic Scholar (https://www.semanticscholar.org/paper/Hierarchical-Position-Based-Dynamics-M%C3%BCller/f9c62b65e442e353f0ab0937de3d84fa65873828)
[4] Graphics, Games & Simulation (https://www.webassembly-wasm.com/production-wasm-workloads-and-deployment/graphics-games-and-simulation/)
[5] Constraint Solver - Physics-Based Simulation (https://phys-sim-book.github.io/position-based-simulations/position-based-dynamics-pbd/solver.html)
[6] [PDF] mathematics-12-03175.pdf - Bournemouth University (https://eprints.bournemouth.ac.uk/40403/1/mathematics-12-03175.pdf)
[7] Position-Based Simulation Methods in Computer Graphics (https://animation.rwth-aachen.de/media/papers/2015-EG-Tutorial.pdf)
[8] MERROUCHE ET AL: DEFORMATION-GUIDED UNSUPERVISED SHAPE MATCHING (https://arxiv.org/pdf/2311.15668v1)
[9] application to cardiac modeling (https://diec.unizar.es/intranet/articulos/uploads/Automatic%20construction%20of%20multiple-object%20three-dimensional%20statistical%20shape%20models.pdf)
[10] Rig Retargeting for 3D Animation (https://dl.acm.org/doi/pdf/10.5555/1555880.1555907)
[11] Generalized Surface Flows for Deformable Registration and ... (https://sipi.usc.edu/~ajoshi/corticalFlows.pdf)
[12] Multiresolution elastic matching (https://www.sciencedirect.com/science/article/pii/S0734189X89800143)
[13] Applications (https://onlinelibrary.wiley.com/doi/10.1111/cgf.12346)
[14] Meshless Deformations Based on Shape Matching (https://matthias-research.github.io/pages/publications/MeshlessDeformations_SIG05.pdf)
[15] Eurographics Symposium on Geometry Processing 2011 (https://projet.liris.cnrs.fr/imagine/pub/proceedings/SGP-2011/pdf/v30i5pp1471-1480.pdf)
