# Stacking / resting contact in real engines — research note

Date: 2026-10-04

Scope: cited background on how real physics engines and vehicle games handle stacked/resting contact (friction and sleeping, solver stability, deformable-vs-rigid load paths, gravity/solve ordering, raycast vehicles on top of other bodies, networked/deterministic ordering, and OBB/SAT box-on-box manifolds), to inform fixing a deformable-car "Stack" scene where dropped cars slide off instead of piling. Method: every answer below is the verbatim output of the owner's Perplexity script (`perplexityWithSourcesFormattedIntoSingleResponse.cjs`), 7 topic queries plus 6 targeted follow-ups (Q3b, Q5b-d, Q6b, Q7b); Q1, Q6 and Q7 each had an earlier successful run whose wording differed (Perplexity is nondeterministic); this file records only the final sequential run of every query. No other source was consulted and nothing here was independently verified against engine source. Perplexity's inline `[n]` markers refer to the numbered Sources list of the same query; several answers contain sentences with no inline citation or whose cited pages do not obviously contain the claim, so the Key takeaways flag those. Answers' markdown headings are demoted to level 5 so they nest under this note's structure.

## 1. Contact normal & friction for resting/stacked bodies (topic 1)

### Q1 — Friction, restitution threshold, sleeping for resting/stacked bodies

**Query (sent verbatim to the script):**

> In rigid-body physics engines (Box2D, Bullet, PhysX), how are static versus kinetic friction handled for stacked or resting bodies? Explain the Coulomb friction cone, the tangential impulse clamp of mu times the accumulated normal impulse, persistent contact points / friction anchors, accumulated impulses with warm starting, the restitution (bounce) velocity threshold at rest, and sleeping/islands. Why must a body resting on a near-level surface not slide, and what makes a solver without a friction clamp or anchor let it creep?

**Answer (script output, verbatim; inline [n] = Sources list below):**

In rigid-body engines, resting and stacked contacts are usually handled as a **static friction** problem in the solver: the contact can “stick” as long as the tangential impulse stays inside the Coulomb limit \( \|J_t\| \le \mu J_n \), where \(J_n\) is the accumulated normal impulse for that contact and \( \mu \) is the friction coefficient. When the tangential demand exceeds that limit, the solver switches to sliding, and the tangential impulse is clamped on the friction cone boundary. [2][4][11][12]

##### What the Coulomb friction cone means

Coulomb friction combines normal and tangential contact reaction into a cone of admissible forces: the tangential component can vary freely only while it remains inside the cone, and slip begins when the cone boundary is reached. Geometrically, the cone half-angle is \( \arctan(\mu) \), so larger \( \mu \) means a wider range of sticking before motion. [4][6][7][11]

##### Why the tangential impulse is clamped to \( \mu \) times the normal impulse

In a time-step solver, the normal contact impulse is what keeps bodies from interpenetrating and supports the weight of stacked bodies. Friction is then limited by that support impulse, so the maximum tangential impulse is proportional to the current accumulated normal impulse, not to some fixed force. This is what makes a box resting on another box able to resist small lateral pushes without sliding. [4][6][11][12]

##### Persistent contact points, friction anchors, and warm starting

Engines such as Box2D keep contact points persistent across frames when possible, and they reuse the previously solved impulses as a starting guess (“warm starting”). That persistence matters because friction is not just based on instantaneous velocity; it depends on the history of the contact so the solver can keep a body stuck from frame to frame instead of re-solving from zero every step. Box2D also exposes warm starting and sleeping controls, which are used to stabilize resting contacts and reduce jitter. [1][3][15]

##### Why a resting body should not slide on a near-level surface

A body at rest on a nearly level surface should remain at rest because gravity’s tangential component is tiny or zero, so the required friction impulse is also tiny. If that required tangential impulse stays below \( \mu J_n \), the solver can represent static friction and keep the body stuck. Physically, “static friction” is exactly the regime where the contact force adjusts as needed, up to its limit, to prevent motion. [2][4][11][12]

##### Restitution threshold at rest

Restitution is the bounce response, but engines suppress bounce for low-speed contacts using a restitution threshold. Box2D notes that collisions with small relative speed are treated as inelastic to prevent jitter, and it recommends not setting the threshold too low because that interferes with sleeping. This helps a resting stack stay quiet instead of bouncing microscopically every frame. [1][3]

##### Sleeping and islands

Sleeping lets a body or island of connected bodies stop being actively solved once everything has settled. In a stable stack, all bodies can fall asleep together, which prevents tiny numerical errors from accumulating and making the pile drift. Box2D explicitly supports sleep, and disabling sleep increases CPU cost and usually makes rest-state stabilization harder. [1][3][15]

##### Why a solver without a friction clamp or anchor creeps

Without a friction clamp tied to the normal impulse, the solver has no true static-friction limit, so it tends to behave like a sliding model with a small viscous or dynamic friction force. Without persistent contact anchors and warm-started impulses, the solver re-discovers the contact every frame from scratch, so tiny numerical errors in the tangential direction are not “remembered” and canceled out. Over many frames those errors accumulate into visible creep, especially on shallow slopes or in stacked bodies. [1][4][11][12]

##### Short version

- **Static friction in engines is usually an impulse inequality**, not a separate magical mode: keep \(J_t\) inside \( \mu J_n \) and the contact sticks. [4][11][12]
- **Warm starting and persistent contacts** preserve that stickiness across frames. [1][3][15]
- **Resting contacts use a restitution threshold and sleeping** so they do not jitter or bounce. [1][3]
- **No clamp, no anchor, no persistence** means tiny solver errors become repeated tangential drift, i.e. creep. [11][12]

**Sources:**

- [1] Box2D: World — https://box2d.org/documentation/group__world.html
- [2] Peiret-IDETC2017-A-friction-model-for-non-singular- ... — https://biomec.upc.edu/wp-content/uploads/2018/01/Peiret-IDETC2017-A-friction-model-for-non-singular-complementarity-formulations-for-multibody-systems-with-contacts.pdf
- [3] Simulation — https://box2d.org/documentation/md_simulation.html
- [4] Solve problems involving the friction cone concept (intro) — https://www.varsitytutors.com/practice/subjects/statics/lessons/friction-cone
- [5] BALKCOM — https://citeseerx.ist.psu.edu/document?repid=rep1&type=pdf&doi=63d0e1aa31a97fff0446e1c804814d4b566ba974
- [6] An iterative approach for cone complementarity problems for nonsmooth dynamics — https://hal.science/hal-01631636/document
- [7] Lecture 17 Friction — https://www.cs.cmu.edu/afs/cs/academic/class/16741-s07/www/lectures/Lecture17.pdf
- [8] 15-494 Cognitive Robotics — https://www.cs.cmu.edu/afs/cs/academic/class/15494-s07/lectures/motion_by_friction.pdf
- [9] Constrained rigid body — https://sites.cc.gatech.edu/classes/AY2017/cs7496_fall/slides/ConstrRigid.pdf
- [10] [PDF] Constrained rigid body — https://sites.cc.gatech.edu/classes/AY2016/cs4496_spring/slides/ConstrRigid.pdf
- [11] NUMERICAL TREATMENT OF CONTACT AND FRICTION: THE CONTACT DYNAMICS METHOD — https://hal.science/hal-01825208/file/Numerical_treatment_contact_friction_Moreau_Jean_1996.pdf
- [12] Primal-dual algorithm for quasi-static contact problem — https://www.arxiv.org/pdf/2101.11763
- [13] Rigid Body Dynamics (II) — https://www.cs.umd.edu/class/fall2022/cmsc828X/LEC/rbd2.pdf
- [14] Penalty Force for Coupling Materials with Coulomb Friction — https://www.cs.ucr.edu/~craigs/papers/2017-rigid-mpm/paper.pdf
- [15] Box2D v2.2.0 User Manual — https://calhoun137.github.io/box2dgame/manual.pdf

## 2. Stacking stability (topic 2)

### Q2 — Stack stability: warm starting, manifolds, ordering, shock propagation

**Query (sent verbatim to the script):**

> How do physics engines keep tall stacks of rigid bodies stable? Cover sequential impulse solvers: warm starting, contact caching and persistent contact manifolds, constraint/iteration ordering, shock propagation (Havok, Guendelman et al. 'Nonconvex rigid bodies with stacking'), and how solver iteration count relates to stack height. Cite Erin Catto's Box2D GDC talks and blog posts ('Solver2D', 'Contact manifolds', 'Fast and Simple Physics using Sequential Impulses', 'Understanding Constraints') where relevant.

**Answer (script output, verbatim; inline [n] = Sources list below):**

Tall stacks stay stable because modern rigid-body engines do not solve contacts in one exact shot; they use iterative sequential impulses, plus several stack-specific tricks that make the early iterations behave like a good approximation of a resting support network[2][3][4]. The biggest wins are warm starting, persistent contact manifolds/caching, solving contacts in a good order, and sometimes special “shock propagation” schemes that bias the solver from the ground upward[1][2][8][12].

##### Sequential impulse basics

Erin Catto’s sequential impulse method is a projected Gauss-Seidel-style solver: integrate forces, then apply impulses one constraint at a time, updating velocities immediately after each constraint is processed[3][4]. This immediate update is important for stacks because each contact can “see” the effect of the contacts solved just before it, which makes the solver propagate support upward through the pile[3][4].

Catto emphasizes that constraints represent joints, contacts, and collisions, and that the solver works in terms of impulses rather than forces[3][6]. Box2D also groups nearby contact points into a **contact manifold**, which is an approximation of the local contact region rather than treating each point in isolation[1][6].

##### Warm starting

Warm starting means reusing the impulses from the previous time step as the initial guess for the current step[5]. This gives the solver a head start, especially for resting contacts in stacks, because the correct impulses for a box resting on another box are usually similar from frame to frame[5].

Catto’s Box2D material describes the solver pipeline as preparing contacts, warm starting, then iteratively solving velocities[5]. In practice, warm starting reduces the number of iterations needed to keep a stack from sinking or jittering because the solver does not begin from zero every frame[5].

##### Contact caching and persistent manifolds

Persistent contact manifolds are critical for stacking because they keep the same logical contacts alive across frames as long as the shapes are still touching[1][6][14]. Box2D computes contact points at the beginning of the step and records an initial manifold before solving, which lets it reuse contact information consistently across frames[1][14].

This persistence matters because a stack is only stable if the solver keeps recognizing the same support points. If contacts flicker on and off, the effective support changes every frame, which introduces jitter, extra penetration, and loss of stability[1][6]. Catto’s manifold-focused material frames the manifold as a compact representation of a continuous contact region, which helps the solver treat a block resting on another block as a stable contact patch instead of a noisy sequence of isolated impacts[1][6].

##### Constraint and iteration ordering

Sequential impulse solvers are order-dependent because they are local, iterative methods[4]. Catto’s GDC constraint talk notes that the solver processes constraints one at a time in arbitrary order, but the order still affects convergence speed and transient behavior[4]. For stacks, a good ordering can make support impulses propagate upward more effectively, while a poor ordering can leave the top of the stack under-supported until later iterations.

A common practical strategy is to solve contacts in an order that roughly follows the support graph from the ground upward. That way, lower bodies settle first, and the solver’s later constraints operate on already-updated velocities[3][4][12]. This is not exact physics; it is a convergence strategy for an approximate solver.

##### Shock propagation

Shock propagation is a stronger version of “solve from the bottom up.” In Guendelman et al.’s *Nonconvex Rigid Bodies with Stacking*, the idea is to handle contacts layer by layer so that bodies below the current layer are treated as effectively immovable while the upper layer is solved[8][12]. That reduces the tendency of the whole stack to compress under load while the solver is still iterating.

Havok-style shock propagation uses a similar intuition: build a contact or dependency graph, identify the supporting bodies, and temporarily freeze lower layers or give them infinite mass while resolving higher layers[11][12]. This makes stacks look much more rigid with fewer iterations, but it is an approximation and can introduce artifacts because it breaks the symmetry of the physical system[8][12].

##### How iteration count relates to stack height

More stack height generally means more iterations are needed for comparable stability. The reason is simple: information travels through a sequential impulse solver one contact at a time, so a stack of height \(N\) needs multiple passes for support corrections at the bottom to reach the top[3][4]. With too few iterations, the top of a tall stack lags behind the bottom, causing compression, wobble, or collapse.

There is no universal “one iteration per box” rule, but the trend is clear: taller and more tightly coupled stacks require more iterations, especially if friction is involved and contacts are not perfectly persistent[3][4][12]. Shock propagation reduces that dependence by making support propagate more directly upward, which is why it is attractive for large stacks[8][11][12].

##### Practical summary

- Use persistent contact manifolds so the solver keeps the same support contacts from frame to frame[1][6][14].
- Warm start with previous impulses so resting contacts start near the right answer[5].
- Solve contacts sequentially and let each impulse update velocities immediately[3][4].
- Order constraints to favor bottom-up support propagation when possible[4][12].
- Increase iterations as stack height grows, because convergence becomes slower in taller piles[3][4].
- If you need extreme stacking robustness, consider shock propagation or a related layered solve, accepting the approximation it introduces[8][11][12].

If helpful, a follow-up can turn this into a diagram of the solver pipeline or a pseudocode sketch of a stack-friendly sequential impulse loop.

**Sources:**

- [1] Simulation — https://box2d.org/documentation/md_simulation.html
- [2] Solver2D — https://box2d.org/posts/2024/02/solver2d/
- [3] Modeling and Solving — https://ubm-twvideo01.s3.amazonaws.com/o1/vault/gdc09/slides/04-GDC09_Catto_Erin_Solver.pdf
- [4] [PDF] GDC2014 Understanding Constraints.key - Box2D — https://box2d.org/files/ErinCatto_UnderstandingConstraints_GDC2014.pdf
- [5] Features | erincatto/box2d | DeepWiki — https://deepwiki.com/erincatto/box2d/1.1-features
- [6] Dynamics Module - Box2D — https://box2d.org/doc_version_2_4/md__e_1_2github_2box2d__24_2docs_2dynamics.html
- [7] Microsoft PowerPoint - cs7057-1516-10-MultipleContacts-mm — https://www.scss.tcd.ie/michael.manzke/CS7057/cs7057-1516-10-MultipleContacts-mm.pdf
- [8] Nonconvex Rigid Bodies with Stacking - Stanford University — https://graphics.stanford.edu/papers/rigid_bodies-sig03/
- [9] Realtime Rigid Body Simulation Using Impulses — https://www.slembcke.net/projects/RealtimePhysicsPaper/RigidBodies.pdf
- [10] b2ContactListener Class Reference - Box2D — https://box2d.org/doc_version_2_4/classb2_contact_listener.html
- [11] Constraint-based collision and contact handling using ... — https://animation.rwth-aachen.de/media/papers/2006-CASA-ConstraintBasedCollisions.pdf
- [12] [PDF] Long Range Constraints for Rigid Body Simulations - GitHub Pages — https://matthias-research.github.io/pages/publications/LongRangeConstraintsSCA.pdf
- [13] Physics Simulation · Mighty Professional Tutorials — https://mightyprofessionalgaming.com/tutorials/physics-from-scratch
- [14] Events — https://box2d.org/documentation/group__events.html
- [15] Multiple Contacts — https://www.scss.tcd.ie/John.Dingliana/cs7057/cs7057-1415-10-MultipleContacts.pdf

## 3. Soft-body / deformable vs rigid contact (topic 3)

### Q3 — Soft-body/deformable vs rigid contact, load-bearing surfaces, crush vs load

**Query (sent verbatim to the script):**

> In soft-body or deformable vehicle crash games and simulators (BeamNG.drive node-beam soft body, Rigs of Rods, Wreckfest, Burnout, FlatOut), how is contact between a deformable car and another car or the ground handled? Which surfaces carry load when one car rests on another (roof, pillars, frame/chassis versus hood), how do penalty-based versus constraint-based contact differ, how does BeamNG's node-beam collision work, how do hybrid rigid-body-plus-deformation approaches work, and how does crush depth relate to contact load / contact force?

**Answer (script output, verbatim; inline [n] = Sources list below):**

In these games, contact is usually not “one solid car body hitting another solid car body,” but a set of point or surface contacts that push deformable nodes around. In BeamNG specifically, collision is handled by nodes only; beams do not collide, and nodes collide with ground, map geometry, and other vehicles’ triangles[1][3][9].

When one car rests on another, the load is carried by whichever parts still have structural stiffness and contact geometry where the bodies touch. In a soft-body model that usually means roof rails, pillars, windshield frame, sill/rocker, floor, and any internal frame or cage elements that are modeled as load-bearing nodes/beams; a thin hood or roof skin may deform and transfer only limited load unless it is backed by stronger structure[2][3][8]. BeamNG’s documentation also notes that vehicle triangles have thickness and that dynamic collision between vehicles is mediated by nodes interacting with triangles[3].

Penalty-based contact and constraint-based contact differ mainly in how strictly they enforce non-penetration. Penalty methods act like a stiff spring: some small penetration is allowed, and the contact force grows with penetration depth[4][11][12]. Constraint-based methods enforce near-zero penetration more rigidly, but they are usually less forgiving numerically and can be less stable in complex contact situations[4][11][15].

BeamNG’s node-beam collision works by treating nodes as the actual colliders and beams as distance-preserving links between them[1][2][9]. A node can collide with the heightmap/ground, static map collision, or dynamic vehicle triangles, and BeamNG distinguishes self-collision from external vehicle collision; the beams transmit the load through the structure after the node contact occurs[1][3]. The practical result is that crush and load path emerge from the node layout and beam strengths rather than from a continuous shell contact model.

Hybrid rigid-body-plus-deformation approaches, like those used in some crash games and simulators, typically keep the vehicle as a rigid body for overall motion while attaching deformable parts, bones, or damage zones for local crush. This gives stable vehicle dynamics and cheaper computation, while allowing visible deformation and some force transfer at impact points; the deformable layer handles crush while the rigid chassis carries the global mass and inertia. That is a common way to get convincing impacts without fully simulating a complete soft body everywhere.

Crush depth usually correlates with contact load in penalty-based systems: deeper indentation means larger restoring force, up to the model’s stiffness limits[11][12][14]. In constraint-based systems, the solver instead tries to prevent penetration directly, so “crush depth” is less a physical spring-like measure of force and more a result of how much the structure yields before the constraint is satisfied[4][15]. In practice, more crush depth generally means a longer collision pulse and often a different force history, but not necessarily a simple one-to-one force relationship because stiffness, damping, geometry, and solver settings all matter[11][12].

**Sources:**

- [1] Nodes - BeamNG Documentation — https://documentation.beamng.com/modding/vehicle/sections/nodes/
- [2] How import cars from 3d program to Beamng? — https://www.beamng.com/threads/how-import-cars-from-3d-program-to-beamng.2628/
- [3] Jbeam Tips and Tricks - BeamNG Documentation — https://documentation.beamng.com/modding/vehicle/intro_jbeam/jbeamtips/
- [4] [PDF] Robuste und effiziente Kontaktmodellierung in LS-DYNA — http://www1.beuth-hochschule.de/~kleinsch/Expl_FEM/2012_Explizit_Kontakte_UM.pdf
- [5] JBeam 技巧与窍门 — https://documentation.beamng.com/cn/modding/vehicle/intro_jbeam/jbeamtips/
- [6] SMO096-SMO.dvi (UFL paper) — https://web.mae.ufl.edu/nkim/Papers/paper3.pdf
- [7] MechanicalContactConstraint — https://mooseframework.inl.gov/mastodon/source/constraints/MechanicalContactConstraint.html
- [8] Debug Tools - BeamNG Documentation — https://documentation.beamng.com/modding/vehicle/intro_jbeam/debugtools/
- [9] Soft-body Physics - BeamNG.drive — https://beamng.com/game/about/physics/
- [10] Use of penalty variable in finite element analysis of contacting objects — https://www.sciencedirect.com/science/article/abs/pii/S0045794902003309
- [11] Numerical Modeling of Contact — https://innovationspace.ansys.com/courses/wp-content/uploads/sites/5/2021/01/2.5.3-Numerical-Modeling-of-Contacts_latest-revised.pdf
- [12] [PDF] Numerical Modeling of Contact — https://innovationspace.ansys.com/courses/wp-content/uploads/sites/5/2019/05/2.5.3-Numerical-Modeling-of-Contacts_New_Template_Master.pdf
- [13] Creating Node/Beam, Jbeam? — https://www.beamng.com/threads/creating-node-beam-jbeam.72183/
- [14] [PDF] A novel 2D penalty formulation for frictionless contact — https://d-nb.info/1386325015/34
- [15] 36.2.3 Contact constraint enforcement methods in Abaqus/Explicit — http://abaqusdocs.eait.uq.edu.au/v6.11/books/usb/pt09ch36s02aus177.html

### Q3b (follow-up) — Rigs of Rods / Wreckfest / Burnout / FlatOut contact and load paths

**Query (sent verbatim to the script):**

> How do Rigs of Rods (node-beam with collision triangles/cabs), Wreckfest (BugBear Next Car Game soft-body), Burnout 3 (Criterion crash deformation) and FlatOut (BugBear) handle vehicle-to-vehicle contact and deformation? For stacked cars specifically (one car landing or resting on another's roof), which parts transmit load: roof/pillar/frame beams versus a thin hood/body skin? Cite developer talks, papers or documentation (e.g. Rigs of Rods wiki, BeamNG physics docs, GDC talks on Burnout crash deformation, Wreckfest developer interviews) and say explicitly where public information is missing.

**Answer (script output, verbatim; inline [n] = Sources list below):**

Rigs of Rods is the clearest case: vehicle structure is modeled as nodes connected by beams, and the docs explicitly say “anything that is not triangulated will fold,” so stacked load is meant to travel through triangulated beam structure such as the roof/pillars/frame, not through a thin skin alone[3]. Its collision system also supports node-to-node and node-to-beam interactions between actors, plus node collisions with static collision triangles and cab triangles, with “contacters” on the truck defining which nodes participate in cab-triangle contact[2][1].

For Wreckfest, public information strongly indicates a soft-body vehicle model where momentum, mass, and damage are tied together, but the available public material is much less explicit about the exact internal load paths for one car resting on another[5][14]. The public-facing descriptions and interviews emphasize that crashes deform the vehicle body and that heavier/faster cars cause and receive damage differently, but they do not clearly spell out whether a roof skin, roof rails, pillars, or a chassis frame carries stacked load in a structural sense[5][14].

Burnout 3’s public crash information is mostly about authored crash deformation and spectacular breakage rather than a documented node-beam-style structural simulation, so there is no public developer documentation here showing a detailed load-transfer model for stacked cars. In other words, public material supports “cars deform when hit,” but does not describe roof-versus-skin load paths or a physics-based support structure for a vehicle resting on another vehicle.

FlatOut, from the available public BugBear-era material, is similarly described in terms of destructive crashes and derby-style impacts, but public documentation does not expose a formal structural model for vehicle-on-vehicle stacking. So for FlatOut too, public information is missing on whether load is transmitted through pillars/frame elements or just through a damage mesh/skin.

##### Practical takeaway for stacked cars
- Rigs of Rods: load is intended to propagate through the node-beam structure; triangulated beams and roof/pillar/frame nodes matter, while a thin body skin by itself is not the structural carrier[3][2].
- Wreckfest: likely some meaningful chassis/body deformation and load sharing exists, but public sources do not precisely document stacked-car load paths[5][14].
- Burnout 3: public info describes crash deformation, not a detailed structural support model.
- FlatOut: public info describes destructive impacts, not a documented roof/frame load-transfer model.

##### Where public information is missing
- Wreckfest: no public document found that explicitly says how stacked cars distribute weight across roof, pillars, chassis, or body panels.
- Burnout 3: no public developer talk or paper found that explains vehicle-to-vehicle contact as a structural simulation.
- FlatOut: no public documentation found that details load transfer in stacked-car scenarios.

If useful, a follow-up answer can turn this into a side-by-side table with “contact model,” “deformation model,” and “stacked-car load path” for all four games.

**Sources:**

- [1] Physics Simulation | RigsOfRods/rigs-of-rods | DeepWiki — https://deepwiki.com/RigsOfRods/rigs-of-rods/3-physics-simulation
- [2] rigs-of-rods/doc/doxygen/MainPage.h at master · RigsOfRods/rigs-of-rods — https://github.com/RigsOfRods/rigs-of-rods/blob/master/doc/doxygen/MainPage.h
- [3] Vehicle (Node/Beam) concepts - Rigs of Rods Documentation — https://docs.rigsofrods.org/vehicle-creation/vehicle-concepts/
- [4] Rigs of Rods: source/main/physics/collision/Collisions.h Source File — https://developer.rigsofrods.org/db/da3/_collisions_8h_source.html
- [5] Wreckfest is bringing the destruction derby back with a bang — https://www.redbull.com/th-th/wreckfest-game-developer-interview
- [6] Namespace List - Rigs of Rods Scripting (and Developer) Manual — https://developer.rigsofrods.org/namespaces.html
- [7] Truck File Format — https://docs.rigsofrods.org/vehicle-creation/fileformat-truck/
- [8] Rigs of Rods — https://en.wikipedia.org/wiki/Rigs_of_Rods
- [9] RigsOfRods/rigs-of-rods: Main development repository for ... — https://github.com/RigsOfRods/rigs-of-rods
- [10] Rigs of Rods: Physics — https://developer.rigsofrods.org/d5/d74/group___physics.html
- [11] Collision meshes — https://docs.rigsofrods.org/terrain-creation/collision-meshes/
- [12] Jargon — https://docs.rigsofrods.org/gameplay/jargon/
- [13] Rigs of Rods (Video Game) - TV Tropes — https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/RigsOfRods
- [14] Wreckfest 2: a robust overhaul that showcases phenomenal soft-body physics — https://www.digitalfoundry.net/articles/digitalfoundry-2025-wreckfest-2-a-superb-overhaul-of-a-boundary-pushing-game
- [15] | Jesus Behind The Wheel — https://jesusbehindthewheel.com/2020/03/17/wreckfest-the-racing-game-we-need-right-now

## 4. Gravity order vs contact solve; sub-stepping (topic 4)

### Q4 — Gravity application order vs contact solve, sub-stepping / soft step / TGS

**Query (sent verbatim to the script):**

> In a fixed-timestep rigid-body physics engine using semi-implicit (symplectic) Euler, what is the correct order of gravity application versus the contact solve? Explain: integrate velocities with gravity and forces first, then solve contact constraints (velocity level), then integrate positions; why resting contact needs gravity applied before the solve so the normal impulse can cancel it; the role of sub-stepping, Box2D v3 'soft step' / TGS soft solver (Erin Catto 'Solver2D'), Rapier and PhysX TGS solver, and what resting-contact jitter or sliding occurs if gravity is applied after the solve.

**Answer (script output, verbatim; inline [n] = Sources list below):**

The correct order in a fixed-timestep rigid-body engine with semi-implicit Euler is: integrate velocities first with gravity and other forces, solve velocity-level contact/joint constraints, then integrate positions from the corrected velocities. That ordering lets resting contacts generate a normal impulse that cancels gravity within the same step, which is why a body can sit stably on the ground instead of sinking or vibrating.

##### Why gravity must be applied before the contact solve

Semi-implicit Euler typically does:

- \(v_{n+1} = v_n + \Delta t \, a\)
- solve constraints on \(v_{n+1}\)
- \(x_{n+1} = x_n + \Delta t \, v_{n+1}\)

If gravity is applied before the solver, a resting body briefly acquires a downward velocity from gravity, and the contact solver can produce an equal-and-opposite normal impulse to cancel that velocity. That is the mechanism that maintains static rest.

If gravity is applied after the contact solve, the solver never “sees” the downward velocity caused by gravity, so it cannot cancel it in the same step. The body then carries a small downward velocity into the position integration, which shows up as resting-contact jitter, gradual sinking, or a tiny bounce/slide cycle.

##### Why sub-stepping helps

Sub-stepping improves stability by splitting one frame into several smaller solves, so gravity, contacts, and constraint corrections are applied more frequently with smaller \(\Delta t\). This reduces penetration, improves stacking, and makes resting contacts less noisy.

Box2D v3’s **Soft Step** solver is explicitly based on soft constraints and sub-stepping, and Box2D’s documentation notes that it uses sub-stepping and solves contacts and joints as part of the step. Erin Catto also describes the earlier Solver2D work as the foundation for this soft-constraint approach.

##### How this relates to Box2D v3, Solver2D, Rapier, and PhysX TGS

- **Box2D v3 / Soft Step**: designed around sub-stepping and soft constraints for more stable contact handling, especially for stacks and resting contact.[1][2][4]
- **Solver2D**: Catto’s experiment that developed the soft-constraint formulation used by Soft Step.[3]
- **Rapier**: uses a timestep-based rigid-body solver with constraint stabilization and TGS-style techniques in its pipeline, aiming to keep contacts stable across frames.[13]
- **PhysX TGS**: the Temporal Gauss-Seidel idea is to improve convergence by solving constraints in a way that better accounts for motion over the timestep, which is especially helpful for resting contacts and stacking.[15]

##### What goes wrong if gravity is applied after the solve

If gravity is added after the velocity solve:

- resting bodies tend to jitter because each frame leaves a small uncorrected downward velocity
- stacks can “creep” or settle unevenly
- contacts can appear soft or slightly bouncy
- friction is less effective because the normal load is not properly established before the solve, so bodies may slide more than expected

In short: for stable resting contact in a semi-implicit Euler engine, apply gravity and other forces first, solve contacts at the velocity level, then integrate positions. Sub-stepping and soft/TGS-style solvers make that basic order work much better for stacks and resting bodies.[1][2][3][4][15]

**Sources:**

- [1] box2d/docs/migration.md at main - GitHub — https://github.com/erincatto/box2d/blob/main/docs/migration.md
- [2] Releasing Box2D 3.0 — https://box2d.org/posts/2024/08/releasing-box2d-3.0/
- [3] Solver2D — https://box2d.org/posts/2024/02/solver2d/
- [4] Simulation — https://box2d.org/documentation/md_simulation.html
- [5] Phaser Box2D — https://phaser.io/box2d
- [6] A selection of beginner to advanced Box2D Tutorials - Phaser — https://phaser.io/tutorials/box2d-tutorials
- [7] Module solverCopy item path — https://docs.rs/nphysics2d/latest/nphysics2d/solver/index.html
- [8] Box2D is a 2D physics engine for games - GitHub — https://github.com/erincatto/box2d
- [9] Phaser Box2D Released — https://phaser.io/news/2024/12/announcing-phaser-box2d
- [10] box2d package - github.com/simpletondl/box2d - Go Packages — https://pkg.go.dev/github.com/simpletondl/box2d
- [11] box2d package - github.com/c0nsult ... — https://pkg.go.dev/github.com/c0nsult/box2d
- [12] box2d package - github.com/ByteArena/box2d — https://pkg.go.dev/github.com/ByteArena/box2d
- [13] Simulation structures — https://rapier.rs/docs/user_guides/javascript/simulation_structures/
- [14] Overview - Box2D — https://box2d.org/documentation/
- [15] Slide 1 — https://developer.download.nvidia.com/video/gputechconf/gtc/2019/presentation/s9990-physx-4-raising-the-fidelity-and-performance-of-physics-simulation-in-games.pdf

## 5. Vehicle wheels/suspension vs another car's body (topic 5)

### Q5 — Raycast/arcade vehicle wheels vs body collision, wheels on another car's roof

**Query (sent verbatim to the script):**

> How do game vehicle physics systems handle wheels and suspension versus body collision? Cover raycast / arcade vehicles (Bullet btRaycastVehicle, Rapier DynamicRayCastVehicleController, Unity WheelCollider, PhysX vehicle SDK): what happens when a vehicle's wheel raycasts hit another car's roof or body (dynamic body as ground), how suspension force and wheel friction/traction are applied to the body hit, whether the ray hit body receives equal and opposite force, and typical problems when one car rests or lands on top of another car.

**Answer (script output, verbatim; inline [n] = Sources list below):**

Raycast-wheel vehicle systems generally **do not treat the wheel ray hit like a normal rigid-body contact pair**. They use the ray hit mainly to compute **suspension compression** and then apply the resulting force to the **vehicle chassis body**, while tire friction/traction is also applied through the vehicle controller rather than as a standard collision response on the hit object.[1][2][3]

For the systems you named, the common pattern is:

- **Bullet btRaycastVehicle / Rapier DynamicRayCastVehicleController**: the vehicle is a **single dynamic chassis rigid body**, and each wheel is only a ray-cast that detects ground contact and drives spring-like suspension.[1][2]
- **Unity WheelCollider**: it also uses a downward raycast, with built-in spring/damper suspension and slip-based tire friction.[3][4]
- **PhysX vehicle SDK / Unity’s PhysX vehicle integration**: the wheel assembly is simulated by the vehicle system, with suspension and tire forces handled by the vehicle model rather than by ordinary wheel colliders behaving as free bodies.[3]

##### What happens when the wheel ray hits another car’s roof or body

If a wheel raycast hits the roof or body of another vehicle, that surface is usually treated as the **supporting contact surface** for suspension and traction calculations, even though it is a dynamic body rather than static ground.[1][2][3]

- The vehicle controller uses the hit point and surface normal to compute **suspension compression** and then applies a force to the **chassis**.[1][2][3]
- Tire friction / traction is also computed from that contact and applied as a force contribution to the vehicle’s motion.[1][2][3]
- The hit body is **not** usually given a special, equal-and-opposite “wheel force” through the raycast vehicle system itself in the same way a normal rigid-body contact solver would do; the raycast vehicle primarily affects the chassis.[1][2][3]

##### Does the ray-hit body receive equal and opposite force?

**Usually not in the direct, explicit sense people expect from rigid-body contact impulses.** The vehicle controller applies suspension and traction forces to its own chassis, and the other body is affected only insofar as the physics engine’s normal contact/collision response also exists for the actual bodies involved.[1][2][3]

So the practical answer is:

- **Suspension force**: applied to the vehicle chassis.[1][2][3]
- **Tire friction / traction**: applied as vehicle-wheel forces to the vehicle system, not as a special wheel-body impulse on the struck object.[1][2][3]
- **Equal and opposite on the hit body**: typically **not a guaranteed raycast-vehicle feature**; if the other car moves, that is usually from ordinary rigid-body collision/contact, not from a dedicated “wheel presses on body” interaction model.[1][2][3]

##### Typical problems when one car rests or lands on top of another car

This setup often behaves poorly in raycast-wheel systems because they were designed around **ground contact**, not vehicle-on-vehicle stacking.[1][2][3]

Common issues include:

- **Unstable suspension** when the ray hits a curved roof or hood instead of flat ground.[1][2][3]
- **Artificial traction** that lets the top car “drive” on the other car as if it were terrain.[1][2][3]
- **Snagging or popping** when ray hits shift between body panels, edges, and the roofline.[1][2][3]
- **Tipping or jitter** because the chassis force is applied through suspension points while the supporting surface itself is moving and tilting.[1][2][3]
- **Poor reciprocity**: the lower car may not feel a convincing downward load from the upper car’s wheels, because the system is not a full contact-patch tire model.[1][2][3]

In practice, many games address this by **filtering out vehicles as valid wheel-ray ground**, or by using custom rules so wheel rays only consider terrain and designated drivable surfaces, not other cars.[1][2][3]

##### Short version

Raycast/arcade vehicle systems model wheels as **sensing devices**, not physical wheel bodies. When a wheel ray hits another car, the vehicle controller usually treats that car as a temporary support surface, applies suspension and traction to the **hitting car’s chassis**, and does **not** reliably transmit a full equal-and-opposite wheel load to the struck car the way a true body-to-body contact model would.[1][2][3]

If helpful, a follow-up can break this down engine by engine with implementation details and the usual filtering tricks for Bullet, Rapier, Unity WheelCollider, and PhysX.

**Sources:**

- [1] DynamicRayCastVehicleController | @dimforge/rapier3d — https://rapier.rs/javascript3d/classes/DynamicRayCastVehicleController.html
- [2] Controllers - Rapier.rs — https://rapier.rs/docs/user_guides/c/character_controller/
- [3] Controllers | Rapier — https://rapier.rs/docs/user_guides/python/character_controller/
- [4] dimforge/rapier3d — https://app.unpkg.com/@dimforge/rapier3d@0.21.0/files/src/control/ray_cast_vehicle_controller.ts
- [5] deepwiki.com · dimforge · rapierRay-Cast Vehicle Controller | dimforge/rapier | DeepWiki — https://deepwiki.com/dimforge/rapier/6.3-ray-cast-vehicle-controller
- [6] github.com · dimforge · rapierrapier/src/control/ray_cast_vehicle_controller.rs at master ... — https://github.com/dimforge/rapier/blob/master/src/control/ray_cast_vehicle_controller.rs
- [7] World | @dimforge/rapier3d — https://rapier.rs/javascript3d/classes/World.html
- [8] Character controller — https://rapier.rs/docs/user_guides/bevy_plugin/character_controller/
- [9] docs.unity.com › collider-shapes › wheel-collidersWheel colliders • Unity Editor • Unity Docs - docs.unity.com — https://docs.unity.com/en-us/engine/6000.0/manual/physics-section/physics-overview/collision-section/collider-shapes/wheel-colliders
- [10] Character Controllers | dimforge/rapier | DeepWiki — https://deepwiki.com/dimforge/rapier/6-character-controllers
- [11] Wheel collider suspension - Unity - Manual — https://docs.unity3d.com/6000.1/Documentation/Manual/wheel-colliders-suspension.html
- [12] Scripting API: WheelCollider — https://docs.unity3d.com/ScriptReference/WheelCollider.html
- [13] https://raw.githubusercontent.com/dimforge/rapier.... — https://raw.githubusercontent.com/dimforge/rapier.js/48cc68ba038f256b492ce73091f36a790e9fef4f/CHANGELOG.md
- [14] Character Controller and Vehicle — https://www.orillusion.com/en/guide/physics-rapier/character_vehicle.html
- [15] Create a vehicle with Wheel Colliders — https://docs.unity3d.com/2019.4/Documentation/Manual/WheelColliderTutorial.html

### Q5b (follow-up) — Bullet btRaycastVehicle / Rapier / PhysX with a dynamic body as ground

**Query (sent verbatim to the script):**

> In Bullet's btRaycastVehicle source code, what happens in rayCast(), updateSuspension(), and updateFriction() when a wheel ray hits another dynamic rigid body (for example another car's roof) instead of static ground? Specifically: is m_groundObject stored, is the suspension force applied only to the chassis or also to the hit body, does updateFriction apply side/forward friction impulses to both the chassis and the ground body (resolveSingleBilateral), and does the btRaycastVehicle docs or forum say anything about driving onto or stacking on top of other dynamic bodies or vehicles? Also compare Rapier's DynamicRayCastVehicleController (does it apply impulses to the hit collider's rigid body?) and PhysX Vehicle SDK suspension raycasts hitting dynamic actors.

**Answer (script output, verbatim; inline [n] = Sources list below):**

In Bullet’s `btRaycastVehicle`, a wheel ray hit on another dynamic rigid body is still treated as the wheel’s `m_groundObject`, but the vehicle code does not push suspension force into that hit body; the suspension force is applied only to the vehicle chassis, while friction impulses are also applied only through the chassis-side vehicle solver. The forum discussion also suggests the vehicle is fundamentally designed around “the object under each wheel” and that setting a ground object is enough for friction handling, but it does not describe full support for driving onto or stacking on arbitrary dynamic bodies or vehicles[15][13].

##### Bullet behavior

- `rayCast()` stores the hit body in `btWheelInfo::m_groundObject` when the ray hits something under the wheel, and forum commentary explicitly points out that this value is later used by `updateFriction()`[15].
- `updateSuspension()` computes the suspension force from the raycast result and applies it to the vehicle chassis dynamics, not as an equal-and-opposite force directly on the contacted rigid body; the vehicle model is a single rigid body chassis with wheels simulated by rays[9][3].
- `updateFriction()` uses the ground object for the friction solve, but the vehicle’s own implementation is still chassis-centric; the forum description frames it as using the body under each wheel for friction values rather than as a two-body vehicle-to-ground constraint system[15][9].
- In practice, this means a ray that hits a dynamic roof can become the “ground” for that wheel in the vehicle data, but Bullet’s raycast vehicle is not a general-purpose suspension/contact solver that meaningfully transfers suspension load into the hit rigid body the way a full rigid-body contact manifold would[9][15].

##### What the docs/forum imply about dynamic bodies and stacking

- The Bullet manual describes `btRaycastVehicle` as a simplified model where the entire vehicle is one rigid-body chassis and wheel contact is approximated by ray casts[9].
- The forum answer about “driving on dynamic bodies” focuses on using the ground object and surface friction, but it does not promise robust support for riding on moving/stacked rigid bodies or other vehicles[13][15].
- A practical interpretation is that dynamic objects can be detected by the raycast, but the vehicle system itself is not built to mechanically support stable “vehicle-on-vehicle” stacking behavior as a first-class feature[9][15].

##### Rapier comparison

- Rapier’s `DynamicRayCastVehicleController` is explicitly described as a single dynamic chassis body with wheel raycasts, and the controller updates the chassis velocity directly from suspension, engine, and brake forces[1][2][7].
- Rapier’s docs say the resulting suspension and friction forces are applied to the chassis, and the chassis colliders are excluded from raycasts by default[1][10][14].
- The available documentation does not indicate that Rapier applies these vehicle impulses to the hit collider’s rigid body; the emphasis is on modifying the chassis rigid-body velocity, not on coupling forces back into the contacted body[2][7][1].

##### PhysX Vehicle SDK comparison

- The search results gathered here did not include a direct PhysX Vehicle SDK source quote, so a fully cited claim about PhysX internals cannot be made from the retrieved material.
- In general terms, PhysX vehicle suspension raycasts are also typically used to find contact and compute wheel forces, while the vehicle solver applies those forces to the vehicle’s rigid body rather than to the contacted static/dynamic actor; however, that statement is not directly supported by the retrieved sources here.

If helpful, the next step can be a line-by-line walkthrough of Bullet’s `rayCast()`, `updateSuspension()`, and `updateFriction()` logic from the source code to show exactly where `m_groundObject` is assigned and where impulses are applied.

**Sources:**

- [1] Controllers - Rapier.rs — https://rapier.rs/docs/user_guides/c/character_controller/
- [2] DynamicRayCastVehicleController | @dimforge/rapier3d — https://rapier.rs/javascript3d/classes/DynamicRayCastVehicleController.html
- [3] btRaycastVehicle Class Reference — https://docs.ros.org/en/diamondback/api/bullet/html/classbtRaycastVehicle.html
- [4] Bullet Collision Detection & Physics Library: btRaycastVehicle.h Source File — https://pybullet.org/Bullet/BulletFull/btRaycastVehicle_8h_source.html
- [5] deepwiki.com · dimforge · rapierRay-Cast Vehicle Controller | dimforge/rapier | DeepWiki — https://deepwiki.com/dimforge/rapier/6.3-ray-cast-vehicle-controller
- [6] github.com · dimforge · rapierrapier/src/control/ray_cast_vehicle_controller.rs at master ... — https://github.com/dimforge/rapier/blob/master/src/control/ray_cast_vehicle_controller.rs
- [7] World | @dimforge/rapier3d — https://rapier.rs/javascript3d/classes/World.html
- [8] Character Controllers | dimforge/rapier | DeepWiki — https://deepwiki.com/dimforge/rapier/6-character-controllers
- [9] Physics_Samples-Walkthrough_e — https://www.cs.cmu.edu/afs/andrew/scs/cs/15-494-sp20/dst/D/A/sw/BULLET/Bullet_User_Manual.pdf
- [10] Character controller — https://rapier.rs/docs/user_guides/bevy_plugin/character_controller/
- [11] Controllers | Rapier — https://rapier.rs/docs/user_guides/python/character_controller/
- [12] Bullet Collision Detection & Physics Library: btRaycastVehicle.cpp Source File — https://pybullet.org/Bullet/BulletFull/btRaycastVehicle_8cpp_source.html
- [13] driving on dynamic bodies - Real-Time Physics Simulation Forum — https://www.pybullet.org/Bullet/phpBB3/viewtopic.php?t=13332
- [14] Character controller — https://rapier.rs/docs/user_guides/javascript/character_controller/
- [15] Real-Time Physics Simulation Forum — https://pybullet.org/Bullet/phpBB3/viewtopic.php?t=12086

### Q5c (follow-up) — btRaycastVehicle updateFriction/updateSuspension impulses

**Query (sent verbatim to the script):**

> Bullet btRaycastVehicle::updateFriction source code: show how it calls resolveSingleBilateral between the chassis rigid body and wheelInfo.m_raycastInfo.m_groundObject, and whether the resulting side impulse and forward impulse are applied to BOTH the chassis and the ground rigid body (equal and opposite), including the sideFactor and rollInfluence scaling. Also state how updateSuspension applies the suspension force (applyImpulse on chassis only?) in btRaycastVehicle.cpp.

**Answer (script output, verbatim; inline [n] = Sources list below):**

In Bullet’s `btRaycastVehicle::updateFriction`, `resolveSingleBilateral` is used to compute the wheel’s **side impulse** between `m_chassisBody` and `wheelInfo.m_raycastInfo.m_groundObject` using the contact point, wheel axle, and a time step; the result is then scaled by `sideFrictionStiffness2` and later used as a lateral friction impulse.[1]

The friction impulses are **not** applied symmetrically to both bodies in `updateFriction`: the code applies the side and forward impulses to the **chassis body only** via `m_chassisBody->applyImpulse(...)`, while the ground object is only involved in the constraint/force calculation, not given an explicit equal-and-opposite impulse there.[1]

The `rollInfluence` scaling is applied to the chassis-side impulse by modifying the relative position used for the impulse application, which reduces the rolling torque transmitted to the chassis.[1]

For `updateSuspension`, the suspension force is turned into an impulse and applied to the **chassis only** with `m_chassisBody->applyImpulse(...)`; the wheel’s ground contact point is used to build the impulse direction and application point, but there is no matching explicit impulse call on the ground rigid body in that function.[1]

> In short: `updateFriction` computes wheel-ground bilateral friction terms but applies the resulting impulses only to the chassis body in the vehicle code path shown, and `updateSuspension` likewise applies suspension as a chassis-only impulse.[1]

**Sources:**

- [1] Bullet Collision Detection & Physics Library: btRaycastVehicle.cpp Source File — https://pybullet.org/Bullet/BulletFull/btRaycastVehicle_8cpp_source.html
- [2] btRaycastVehicle Class Reference — https://docs.ros.org/en/diamondback/api/bullet/html/classbtRaycastVehicle.html
- [3] src/objects/RaycastVehicle.js - cannon — https://schteppe.github.io/cannon.js/docs/files/src_objects_RaycastVehicle.js.html
- [4] github.com · dimforge · rapierrapier/src/control/ray_cast_vehicle_controller.rs at master ... — https://github.com/dimforge/rapier/blob/master/src/control/ray_cast_vehicle_controller.rs
- [5] Class PhysicsVehicle — https://javadoc.jmonkeyengine.org/v3.7.0-stable/com/jme3/bullet/objects/PhysicsVehicle.html
- [6] PhysicsVehicle (jMonkeyEngine3) — https://javadoc.jmonkeyengine.org/v3.5.0-beta4/com/jme3/bullet/objects/PhysicsVehicle.html
- [7] Raycast vehicle shaking when resting · Issue #1400 · bulletphysics/bullet3 — https://github.com/bulletphysics/bullet3/issues/1400
- [8] Real-Time Physics Simulation Forum — https://pybullet.org/Bullet/phpBB3/viewtopic.php?t=8419
- [9] btRayCastVehicle positionalfriction - Real-Time Physics Simulation ... — https://pybullet.org/Bullet/phpBB3/viewtopic.php?t=9797
- [10] Bullet Vehicles — https://docs.panda3d.org/1.9/python/programming/physics/bullet/vehicles
- [11] ammo.js/bullet/src/BulletDynamics/Vehicle/btRaycastVehicle.h at main · kripken/ammo.js — https://github.com/kripken/ammo.js/blob/main/bullet/src/BulletDynamics/Vehicle/btRaycastVehicle.h
- [12] Bullet Collision Detection & Physics Library: Class Members — https://www.staff.city.ac.uk/~andrey/INM377/bullet-2.82-html/html/functions_func_s.html
- [13] Trying to create Ray-cast Suspension; Editable, Open, Stable ... — https://devforum.roblox.com/t/trying-to-create-ray-cast-suspension-editable-open-stable-and-optimized/3494597
- [14] Raycast Suspension Car System - Community Resources ... - Roblox — https://devforum.roblox.com/t/raycast-suspension-car-system/4527231
- [15] deepwiki.com · dimforge · rapierRay-Cast Vehicle Controller | dimforge/rapier | DeepWiki — https://deepwiki.com/dimforge/rapier/6.3-ray-cast-vehicle-controller

### Q5d (follow-up) — exact btRaycastVehicle updateFriction ground-impulse lines

**Query (sent verbatim to the script):**

> Quote the exact code from Bullet Physics btRaycastVehicle.cpp updateFriction() where m_sideImpulse is applied: does it contain 'btRigidBody* groundObject = (btRigidBody*) m_wheelInfo[wheel].m_raycastInfo.m_groundObject;' followed by 'm_chassisBody->applyImpulse(sideImp, rel_pos);' and 'groundObject->applyImpulse(-sideImp, rel_pos2);' with the comment 'apply friction impulse on the ground'? Is the forward (drive/brake) impulse m_forwardImpulse applied to the chassis only, with no equal-and-opposite impulse on the ground body? Give the source URL for the code you quote.

**Answer (script output, verbatim; inline [n] = Sources list below):**

Yes. The Bullet source shows `btRaycastVehicle::updateFriction()` applying the side impulse to the chassis with `m_chassisBody->applyImpulse(sideImp, rel_pos);`, followed by the comment `//apply friction impulse on the ground`, and then the ground-body line is present but commented out as `//groundObject->applyImpulse(-sideImp,rel_pos2);`[1].

The forward/driving impulse is not applied to the ground body in that code path; the quoted source applies the forward impulse calculation to the chassis-side vehicle state, and the ground-body equal-and-opposite forward impulse is not present in the shown `updateFriction()` implementation[1].

Source URL: https://pybullet.org/Bullet/BulletFull/btRaycastVehicle_8cpp_source.html[1]

**Sources:**

- [1] Bullet Collision Detection & Physics Library: btRaycastVehicle.cpp Source File — https://pybullet.org/Bullet/BulletFull/btRaycastVehicle_8cpp_source.html
- [2] Classes — https://pybullet.org/Bullet/BulletFull/classbtRaycastVehicle.html
- [3] src/objects/RaycastVehicle.js - cannon — https://schteppe.github.io/cannon.js/docs/files/src_objects_RaycastVehicle.js.html
- [4] godot/scene/3d/physics/vehicle_body_3d.cpp at master ... - GitHub — https://github.com/godotengine/godot/blob/master/scene/3d/physics/vehicle_body_3d.cpp
- [5] Raycast vehicle shaking when resting · Issue #1400 · bulletphysics/bullet3 — https://github.com/bulletphysics/bullet3/issues/1400
- [6] Real-Time Physics Simulation Forum — https://pybullet.org/Bullet/phpBB3/viewtopic.php?t=8419
- [7] github.com · dimforge · rapierrapier/src/control/ray_cast_vehicle_controller.rs at master ... — https://github.com/dimforge/rapier/blob/master/src/control/ray_cast_vehicle_controller.rs
- [8] Bullet Collision Detection & Physics Library: btRaycastVehicle.h Source File — https://pybullet.org/Bullet/BulletFull/btRaycastVehicle_8h_source.html
- [9] Real-Time Physics Simulation Forum — https://pybullet.org/Bullet/phpBB3/viewtopic.php?t=12086
- [10] Bullet Collision Detection & Physics Library: Class Members — https://www.staff.city.ac.uk/~andrey/INM377/bullet-2.82-html/html/functions_func_s.html
- [11] DynamicRayCastVehicleController | @dimforge/rapier3d — https://rapier.rs/javascript3d/classes/DynamicRayCastVehicleController.html
- [12] RaycastVehicle | cannon-es — https://pmndrs.github.io/cannon-es/docs/classes/RaycastVehicle.html
- [13] GTAviceCity/src/vehicles/Vehicle.cpp at master · daynz ... — https://github.com/daynz/GTAviceCity/blob/master/src/vehicles/Vehicle.cpp
- [14] BulletVehicle Class Reference — https://www.panda3d.org/reference/cxx/classBulletVehicle.html
- [15] deepwiki.com · dimforge · rapierRay-Cast Vehicle Controller | dimforge/rapier | DeepWiki — https://deepwiki.com/dimforge/rapier/6.3-ray-cast-vehicle-controller

## 6. Networked physics and collision ownership (topic 6)

### Q6 — Networked physics, authority, deterministic stage order

**Query (sent verbatim to the script):**

> How do networked physics games handle collision authority and deterministic ordering? Cover Glenn Fiedler's Gaffer on Games articles ('Networked Physics', 'State Synchronization', 'Snapshot Compression', 'Deterministic Lockstep', 'Fix Your Timestep'), authority per object / ownership, and how racing sims and games (Assetto Corsa, rFactor, iRacing, Forza) handle car-to-car contact in netcode. Why does the deterministic order of the dynamic update stages (wheels and suspension, body integration, deformation, pair contact solving) matter for stable stacks of bodies and for replays?

**Answer (script output, verbatim; inline [n] = Sources list below):**

Networked physics games usually choose between three broad approaches: deterministic lockstep, snapshot interpolation, and state synchronization. Glenn Fiedler describes deterministic lockstep as sending only inputs and waiting for all players’ inputs for frame \(n\), while state synchronization sends both input and state so the simulation can keep moving even without perfect determinism[1][4][5].

##### Collision authority and per-object ownership

In practice, “authority” is often assigned per object rather than globally. The owning machine usually has the right to authoritatively integrate that object’s motion and to decide what state gets replicated, while other machines treat the state as replicated or predicted and then corrected[4].

That matters for collision because two objects can be owned by different peers or by the server, so the netcode must decide whose simulation result wins when they touch. Fiedler’s state-synchronization approach avoids requiring perfect determinism and instead periodically snaps or corrects state, which is a common way to reconcile ownership and collision disagreement across machines[4].

##### Why deterministic lockstep is attractive, and why it is limited

Deterministic lockstep is bandwidth-efficient because only inputs are transmitted, but it only works well if all machines produce identical results from the same inputs[5]. Fiedler notes that this becomes awkward as player count rises, because everyone waits for the most delayed player before simulating the next frame[1][5][7].

That makes lockstep a poor fit for physics-heavy games with frequent collisions, floating-point sensitivity, and many interacting objects. For those cases, state sync or server authority is usually more practical[4][7].

##### Gaffer on Games: the key ideas

- **Networked Physics / State Synchronization**: send both input and state; do not require perfect determinism; use sequence numbers, importance-based object selection, and jitter buffering[1][4].
- **Snapshot Compression**: reduce bandwidth by sending only changed state and encoding it efficiently rather than resending everything[8].
- **Deterministic Lockstep**: send only inputs; all clients simulate the same world; everyone stalls if one input is late[5][7].
- **Fix Your Timestep**: use a fixed simulation step so physics updates are stable and reproducible rather than tied to variable rendering rate[9].
- **Fixed timestep in networking**: fixed-step simulation is the usual basis for making reconciliation and replay possible because the same inputs produce the same sequence of simulation steps[9].

##### Racing sims and car-to-car contact

Racing games generally treat car-to-car contact as something that must be made consistent enough for gameplay, but not necessarily perfectly identical on every client. The common solutions are:

- Server or authoritative-host decides the canonical contact result.
- Remote cars are interpolated/predicted, then corrected.
- Damage and collision responses may be simplified or biased toward the authority that owns the affected car.

This is why racing sims often tolerate a bit of visual divergence if the authoritative simulation remains coherent. In practice, a car contact event is usually resolved by whichever simulation owns the relevant car or by the server, rather than by letting every client independently “win” the contact locally[4][5].

For the specific titles you named, public descriptions and community understanding generally line up like this:
- **Assetto Corsa / rFactor / iRacing**: their multiplayer behavior is typically built around authoritative or semi-authoritative replication with prediction/interpolation rather than full peer-to-peer agreement.
- **Forza**: also relies on replicated state and correction rather than strict lockstep-style determinism.

The important point is that contact between two cars is exactly the kind of event that becomes fragile under pure lockstep, because it depends on the same ordered sequence of contact generation and constraint solving on every machine[4][5][7].

##### Why deterministic update order matters

The order of the dynamic physics stages matters because many stages feed the next ones:

- wheels and suspension generate forces from the current chassis pose,
- body integration advances the rigid body state,
- deformation and damage may alter mass/shape/contact points,
- pair-contact solving applies impulses and constraint corrections.

If that order changes, even slightly, the simulation can diverge. In a stack of bodies, tiny differences in when contacts are generated, when impulses are applied, or when one contact pair is solved relative to another can produce unstable or inconsistent results. That is why fixed, deterministic ordering is so important for stable stacks and for replay systems[9].

For replays, the game needs the same simulation path to be reproducible from recorded inputs or state. If the stage order is nondeterministic, the replay can drift: the same inputs no longer produce the same contacts, impulses, or final positions. Deterministic ordering plus fixed timesteps makes replay and rollback-style correction much more reliable[5][9].

##### Bottom line

- **Collision authority** is usually assigned per object or per simulated entity, not “everyone at once.”[4]
- **Deterministic lockstep** is elegant but fragile for physics-heavy racing because contact ordering and floating-point details must match exactly.[5][7]
- **State synchronization / server authority** is the practical choice for most modern racing netcode.[1][4][8]
- **Fixed timestep and deterministic stage order** are essential for stable stacks, reproducible replays, and predictable collision resolution.[9]

If useful, a follow-up can turn this into a concrete architecture diagram for a racing sim netcode stack: authority, prediction, interpolation, reconciliation, and replay.

**Sources:**

- [1] Networked Physics — https://gafferongames.com/categories/networked-physics/
- [2] Physics | Gaffer On Games — https://gafferongames.com/tags/physics/
- [3] Gaffer On Games — https://gafferongames.com/
- [4] State Synchronization - Gaffer On Games — https://gafferongames.com/post/state_synchronization/
- [5] Deterministic Lockstep | Gaffer On Games — https://gafferongames.com/post/deterministic_lockstep/
- [6] Game Physics on Gaffer On Games — https://new.gafferongames.com/categories/game-physics/index.xml
- [7] Snapshot Interpolation — https://gafferongames.com/post/snapshot_interpolation/
- [8] Snapshot Compression | Gaffer On Games — https://gafferongames.com/post/snapshot_compression/
- [9] game-mechanics-optimizations/06_fixed_timestep.md at main — https://github.com/raduacg/game-mechanics-optimizations/blob/main/06_fixed_timestep.md
- [10] Just showing IRacing players how netcode should be — https://www.reddit.com/r/assettocorsa/comments/1qm99qn/just_showing_iracing_players_how_netcode_should_be/
- [11] GitHub - gafferongames/GameNetworkingResources: A Curated ... — https://github.com/gafferongames/GameNetworkingResources
- [12] Game Physics — https://www.kth.se/social/upload/5294c3b1f276542fb7468bf6/game_physics.pdf
- [13] Where does AC stack up in terms of online net code? — https://www.reddit.com/r/assettocorsa/comments/6mmhge/where_does_ac_stack_up_in_terms_of_online_net_code/
- [14] Assetto Corsa Windows, VR game — https://www.moddb.com/games/assetto-corsa
- [15] Физическое моделирование - Документация - Unigine Developer — https://developer.unigine.com/ru/docs/latest/principles/physics/simulation

### Q6b (follow-up) — Racing sims' online car-to-car collision handling, Rocket League rollback

**Query (sent verbatim to the script):**

> How do racing simulators and games handle car-to-car collisions online? Specifically iRacing (peer-to-server, each client simulates its own car and how contact is resolved), Assetto Corsa and Assetto Corsa Competizione (server authority, collision handling, ghosting), rFactor 2, Forza Motorsport/Horizon (peer-to-peer or dedicated servers, collision ghosting), and Rocket League (Psyonix's GDC talk 'It IS Rocket Science' about physics prediction and rollback with fixed 120Hz ticks and authoritative server resimulation). Describe authority per car, client-side prediction, and why the order of physics sub-steps must be identical for replays or rollback.

**Answer (script output, verbatim; inline [n] = Sources list below):**

Online car-to-car collision handling in these games falls into three broad models: server-authoritative with client prediction, mixed authority with per-car ownership, and partial ghosting/loss-tolerance for unstable connections. Rocket League is the clearest example of strict server authority plus client prediction and rollback-style correction at a fixed 120 Hz physics step[2].

- **iRacing** uses dedicated servers and “net code” to reconcile each driver’s car positions; its infrastructure is explicitly based on reliable servers plus net code, and current development notes say collision netcode for both car-to-car and car-to-world is still being improved[3][4].
- In practice, iRacing behaves like a **per-car ownership/prediction** model: each client predicts its own car locally, the server reconciles authoritative state, and contact is resolved from the server’s best estimate of both cars’ positions, which is why “netcode” incidents can show cars touching in-session but separated in replay[3][4].
- **Assetto Corsa Competizione** is generally described as **server authoritative** for online sessions, with collision behavior handled centrally; public server administration docs and community/server material reflect a dedicated-server model, and practical reports describe collision/impact handling plus ghosting or reduced collision effects for troubled cars or session states[1].
- **Assetto Corsa** online likewise relies on session/server mediation rather than pure peer-to-peer, but its older multiplayer collision behavior is known to be less robust than ACC’s and often uses latency compensation/ghosting-like behavior to avoid extreme desync cases[1].
- **rFactor 2** also uses a **dedicated-server authoritative** model in online play, with each client simulating cars locally and the server resolving the final shared state; like the others, this depends on consistent physics order for deterministic reconciliation.
- **Forza Motorsport / Horizon** are generally built around **online session servers with latency compensation**, not true peer-to-peer in the classic sense; collision handling commonly softens or ghosts unstable interactions when synchronization is poor, especially for transient or heavily desynced vehicles.
- **Rocket League**: Psyonix’s GDC talk states a **fixed 120 Hz tick**, **100% server authority**, and **client prediction for everything**; the server later resimulates from stored history when late inputs arrive, which is the rollback-like part[2].

The key technical reason the **order of physics sub-steps must match exactly** is determinism: if the server, client, replay system, or rollback system runs sub-steps in a different order, the tiny differences compound and the simulation diverges, producing different collision outcomes, different bounces, and different contact timing. That is why fixed-tick games that support replays or rollback must reproduce the same step order, same inputs, and same contact resolution path to get identical results[2].

A practical summary:

- **Per-car authority/prediction**: each client is responsible for its own car’s motion locally, while the server reconciles contact and other players.
- **Server authority**: the server decides final positions/contact; clients predict to hide latency.
- **Ghosting**: when a car is too desynced or unstable, the game may temporarily reduce or remove collision to prevent impossible contact.
- **Deterministic sub-step order**: required so replays and rollback recreate the same collision results frame-for-frame[2].

If you want, this can be turned into a side-by-side table for iRacing, ACC, AC, rFactor 2, Forza, and Rocket League.

**Sources:**

- [1] Assetto Corsa Competizione server · GitHub — https://github.com/renaudallard/assettocorsa_competizione_server
- [2] It IS Rocket Science! — https://ubm-twvideo01.s3.amazonaws.com/o1/vault/gdc2018/presentations/Cone_Jared_It_Is_Rocket.pdf
- [3] Race Technology - iRacing.com — https://www.iracing.com/cars-and-tracks/race-technology/
- [4] iRacing Development Update: August 2026 — https://www.iracing.com/iracing-development-update-august-2026/
- [5] I want to know if this crash could be protestable — https://www.reddit.com/r/Simracingstewards/comments/1noytsg/i_want_to_know_if_this_crash_could_be_protestable/
- [6] Comandos de Administrador en Assetto Corsa Competizione — https://server.nitrado.net/es-ES/guides/comandos-de-administrador-en-assetto-corsa-competizione-es
- [7] iRacing: The Core Issues With the Damage Model — https://boxthislap.org/iracing-the-core-issues-with-the-damage-model/
- [8] Lets play "should it have been a demo!" — https://www.reddit.com/r/RocketLeague/comments/1chg4te/lets_play_should_it_have_been_a_demo/
- [9] Car contact in game and crash, but it seemed like there was no contact at all — https://www.reddit.com/r/iRacing/comments/1bfj4zf/car_contact_in_game_and_crash_but_it_seemed_like/
- [10] How are you meant to race against this? — https://www.reddit.com/r/iRacing/comments/1ecuevy/how_are_you_meant_to_race_against_this/
- [11] Assetto Corsa Competizione: Problemas comuns — https://zap-hosting.com/guides/pt/docs/assetto-competizione-troubleshooting-common-issues/
- [12] OFFICIAL SPORTING CODE - iRacing — https://ir-core-sites.iracing.com/members/pdfs/20231205-official_sporting_code_dated_Dec_05_2023.pdf
- [13] Assetto Corsa Competizione: Problemas comunes | ZAP-Hosting Docs — https://zap-hosting.com/guides/es/docs/assetto-competizione-troubleshooting-common-issues/
- [14] Assetto Corsa Competizione, online e novità - News - Automoto.it — https://www.automoto.it/news/assetto-corsa-competizione-online-e-novita.html
- [15] ÃltalÃĄnos szabÃĄlyzat — https://drfliga.hu/szabalyzatok/altalanos-szabalyzat/

## 7. Box-on-box SAT contact generation (topic 7)

### Q7 — OBB/SAT box-box contact generation and manifolds

**Query (sent verbatim to the script):**

> How do physics engines generate contacts for box-on-box (OBB) stacking using the separating axis theorem? Cover: choosing the contact normal when two boxes overlap (minimum penetration axis), preferring face axes over edge-edge axes with a bias/tolerance, reference face and incident face clipping to produce a manifold of up to 4 contact points (Box2D b2CollideBox / b2CollidePolygons, Bullet btBoxBoxDetector, ODE dBoxBox, Gino van den Bergen / Dirk Gregorius GDC 'Robust Contact Creation'), and why a naive 'push apart along the SAT minimum penetration axis' with no friction makes boxes slide off each other.

**Answer (script output, verbatim; inline [n] = Sources list below):**

For OBB-on-OBB stacking, physics engines usually use SAT to find the axis of **minimum penetration** and take that as the contact normal, but they do **not** stop there: they then choose a **reference face** and **incident face** and clip the incident face against the side planes of the reference face to build a small contact manifold, often up to 2 points in classic 2D/3D box routines and up to 4 points for polygon-box style manifolds such as Box2D’s polygon collision path.[1][2]

A common rule is to **prefer face axes over edge-edge axes** when the separations are close, because face contacts are more stable for stacking; implementations add a bias or tolerance so that if a face-axis penetration is nearly as good as the best edge-edge axis, the face axis wins.[2]  
That is the idea behind the ODE/Bullet-style box-box detector lineage and the “robust contact creation” approach associated with van den Bergen and Gregorius: use SAT only to select the best candidate axis, but apply a bias toward face contacts to avoid unstable edge-edge manifolds in resting stacks.[2]

The usual manifold construction flow is:  
- Find the separating axis candidates from the 6 face normals of box A and box B, plus the 9 cross-product edge-edge axes.  
- Pick the axis with the least penetration as the provisional normal.  
- If the best axis is ambiguous, biased, or nearly tied, prefer a face axis over an edge-edge axis.  
- Treat the box that owns the reference face as the **reference box** and the other as the **incident box**.  
- Select the incident face whose normal is most anti-parallel to the contact normal.  
- Clip the incident face polygon against the side planes of the reference face to generate the contact points, then keep the points whose depth is within tolerance.[2]

Box2D exposes this through its polygon collision manifold routine, `b2CollidePolygons`, which computes the contact manifold between two polygons, and its box shape is just a polygon convenience constructor, so box-on-box contact is handled by the same polygon manifold machinery.[1][3]  
Bullet’s `btBoxBoxDetector` is explicitly described as an ODE-adapted box-box collision routine that returns the contact normal, penetration depth, and generated contacts.[2]  
ODE’s classic `dBoxBox` routine follows the same idea: SAT chooses the axis, then a clipped contact set is produced from the reference and incident faces.[2]

The reason a **naive “push apart along the SAT minimum penetration axis”** approach makes boxes slide off each other is that, by itself, it provides only a geometric separation vector, not a frictional constraint or a stable contact manifold.[2]  
If two boxes are resting with a slight tilt, the minimum-penetration direction often has a sideways component; repeatedly applying only that correction nudges the top box laterally, and with no friction constraint there is nothing to resist the tangential motion, so the stack creeps and slides apart instead of settling stably.[2]  
A manifold with multiple contact points plus friction constraints is what turns that single correction into a stable resting contact, especially for stacking.[1][2]

In short, the robust recipe is: SAT for candidate axes, face-axis bias for stability, reference/incident face selection, clipping to create a manifold, and then solver constraints with friction; that combination is what keeps stacked boxes from behaving like they are on ice.[1][2]

**Sources:**

- [1] Collision — https://box2d.org/documentation/group__collision.html
- [2] Bullet Collision Detection & Physics Library: btBoxBoxDetector. ... — https://pybullet.org/Bullet/BulletFull/btBoxBoxDetector_8cpp_source.html
- [3] E:/github/box2d/include/box2d/collision.h Source File — https://box2d.org/documentation/collision_8h_source.html
- [4] Overview - Box2D — https://box2d.org/documentation/
- [5] Collision - Box2D — https://box2d.org/documentation/md_collision.html
- [6] Collision Module — https://box2d.org/doc_version_2_4/md__e_1_2github_2box2d__24_2docs_2collision.html
- [7] Simulation — https://box2d.org/documentation/md_simulation.html
- [8] Features | erincatto/box2d | DeepWiki — https://deepwiki.com/erincatto/box2d/1.1-features
- [9] Macros — https://pybullet.org/Bullet/BulletFull/btBoxBoxDetector_8cpp.html
- [10] box2d package - github.com/c0nsult ... — https://pkg.go.dev/github.com/c0nsult/box2d
- [11] E:/github/box2d_24/include/box2d/b2_collision.h Source File — https://box2d.org/doc_version_2_4/b2__collision_8h_source.html
- [12] Bullet Collision Detection & Physics Library: Class List — https://www.staff.city.ac.uk/~andrey/INM377/bullet-2.82-html/html/annotated.html
- [13] box2d — https://pkg.go.dev/github.com/bytearena/box2d
- [14] box2d package - github.com/simpletondl/box2d - Go Packages — https://pkg.go.dev/github.com/simpletondl/box2d
- [15] box2d package - github.com/E4/box2d — https://pkg.go.dev/github.com/E4/box2d

### Q7b (follow-up) — Box2D b2CollidePolygons face-selection hysteresis, clipping, Dirk Gregorius

**Query (sent verbatim to the script):**

> In Box2D v3 (Erin Catto), how does b2CollidePolygons choose between the reference face of polygon A and polygon B when two boxes overlap? Explain the linearSlop based tolerance (for example 0.1 * linearSlop) that biases face selection to avoid flip-flopping between polygons (temporal coherence / hysteresis), how b2ClipPolygons builds up to two manifold points in 2D, and why Dirk Gregorius' GDC 2013 'Robust Contact Creation for Physics Simulations' and the Bullet/ODE box-box code prefer face contacts and persist contact points across frames. Also what goes wrong with box stacking if contact normals flip between frames or friction is missing.

**Answer (script output, verbatim; inline [n] = Sources list below):**

When two boxes overlap, `b2CollidePolygons` picks the reference face by comparing the best separating axes for polygon A and polygon B, then choosing the face whose separation is “more valid” as the contact plane. Box2D adds a small bias based on `linearSlop` so the choice does not oscillate when the two candidates are nearly tied; that hysteresis favors reusing the previous face unless the other face is clearly better, which improves temporal coherence and prevents flip-flopping.

The `linearSlop` tolerance is a tiny distance used as a collision/constraint slack. In practice, the face-selection code uses a fraction of that slack, such as `0.1 * linearSlop`, as a deadband: if the two face candidates differ by less than that amount, Box2D keeps the old choice or otherwise breaks ties consistently. This avoids unstable contact normals caused by tiny numerical noise.

`b2ClipPolygons` then takes the chosen reference face and clips the incident edge against the reference side planes. In 2D, an edge clipped against a face can produce at most two valid points, so the resulting manifold contains up to two contact points. Those points share the same normal, which is why Box2D stores them as a small manifold rather than as independent contacts.

This is the same design Dirk Gregorius emphasized in his “Robust Contact Creation for Physics Simulations” talk: face contacts are preferred because they give a stable contact normal and a small persistent manifold, and contact points should be persisted across frames instead of recreated from scratch every step. The Bullet and ODE box-box routines follow the same general idea: they build face-based manifolds, keep the feature IDs stable, and preserve contact points so the solver gets coherent constraints over time.

What goes wrong without that coherence is exactly what stack stability depends on. If box contact normals flip between frames, the solver sees a changing constraint direction, so resting boxes can jitter, drift, or collapse as impulses fight each other. If friction is missing, there is nothing to resist tangential motion, so stacked boxes slide and “creep” much more easily, and any instability from normal flipping becomes even more visible.

If you want, I can also sketch the exact Box2D v3 polygon-vs-polygon manifold flow step by step: axis test, face choice, incident edge selection, clipping, and point filtering.

**Sources:**

- [1] results matching " " — https://box2d.realjf.io/collision-module.html
- [2] [PDF] Box2D v2.3.0 User Manual — https://home.fizyka.umk.pl/~jacek/dydaktyka/modsym/studenci/2015-2016/box2d.org/box2d_manual_v2.3.0.pdf
- [3] Box2D — https://documentation.help/Box2D/
- [4] Overview - Box2D — https://box2d.org/documentation/
- [5] https://people.duke.edu/~nts9/time/Time/libs/Box2D... — https://people.duke.edu/~nts9/time/Time/libs/Box2D/Collision/b2Collision.h
- [6] b2Settings - Box2DFlash Documentation — https://www.tud.ttu.ee/im/Jaak.Henno/FlashDevelop/Box2D/Docs/Box2D/Common/b2Settings.html
- [7] Simulation — https://box2d.org/documentation/md_simulation.html
- [8] Robust Contact Creation in Physics Simulations | PDF - Scribd — https://www.scribd.com/document/835484718/Dirk-Gregorius-Contacts
- [9] Box2D: Geometry — https://box2d.org/documentation/group__geometry.html
- [10] Box2D API Documentation — https://documentation.help/Box2D/documentation.pdf
- [11] Collision — https://box2d.org/documentation/group__collision.html
- [12] Shape Collision - Box3D — https://box2d.org/documentation3d/group__collision.html
- [13] Collision - Box2D — https://box2d.org/documentation/md_collision.html
- [14] box2d/docs/migration.md at main - GitHub — https://github.com/erincatto/box2d/blob/main/docs/migration.md
- [15] Physics 공부 계획 다시 — http://chanhaeng.blogspot.com/2019/02/physics.html?m=1

## Key takeaways

1. Engines treat static friction as an impulse inequality: the tangential impulse stays inside the Coulomb limit `|J_t| <= mu * J_n` (J_n = that contact's accumulated normal impulse), so friction is limited by the support impulse and a box resting on a box resists small lateral pushes; past the limit the contact slides on the cone boundary. The script's citations for this are academic/statics pages, not engine docs. https://hal.science/hal-01825208/file/Numerical_treatment_contact_friction_Moreau_Jean_1996.pdf

2. Box2D keeps contact points persistent across frames and reuses solved impulses (warm starting). The script's explanation that a solver without a normal-impulse-tied clamp, persistent anchors and warm start "creeps" because tangential errors are never remembered/cancelled is its own reasoning, citation only generic — treat as partly [INFERENCE]. https://box2d.org/documentation/md_simulation.html

3. Low-speed collisions are treated as inelastic via a restitution threshold (Box2D: do not set it too low, it interferes with sleeping); sleeping stops solving a settled island so numerical error cannot accumulate into pile drift. https://box2d.org/documentation/group__world.html

4. Stack stability recipe: persistent contact manifolds + warm starting + sequential impulses that update velocities immediately so support propagates upward; constraint order affects convergence, and solving roughly bottom-up from the support graph is the practical strategy (the ordering advice is the script's reading of Catto's GDC talk). https://box2d.org/files/ErinCatto_UnderstandingConstraints_GDC2014.pdf

5. Shock propagation (Guendelman et al.): solve layer by layer from the ground, treating lower layers as effectively immovable while higher ones are solved; it makes stacks rigid with fewer iterations but is an approximation with artifacts. Taller stacks need more iterations since corrections travel one contact at a time; the script states there is no universal iterations-per-box rule. https://graphics.stanford.edu/papers/rigid_bodies-sig03/

6. Semi-implicit Euler step order: v += g*dt (plus forces), then solve velocity-level contacts, then x += v*dt. Gravity must enter before the solve so the normal impulse can cancel it; the script says gravity after the solve leaves uncorrected downward velocity (jitter, sinking, slide) — that consequence is uncited, partly [INFERENCE]. https://box2d.org/documentation/md_simulation.html

7. Box2D v3 is built on "Soft Step": sub-stepping plus soft constraints developed in Catto's Solver2D experiments, for steadier stacks and resting contact; the Rapier / PhysX-TGS lines in the answer are generic and thinly sourced. https://box2d.org/posts/2024/02/solver2d/

8. Soft-body load path: in BeamNG only nodes collide (beams do not); nodes hit ground/map geometry and other vehicles' triangles and beams then carry the load. Rigs of Rods: "anything that is not triangulated will fold", with node-node, node-beam and cab-triangle contact (contacters), so stacked load must travel through triangulated roof/pillar/frame structure, not a thin skin. https://documentation.beamng.com/modding/vehicle/sections/nodes/ and https://docs.rigsofrods.org/vehicle-creation/vehicle-concepts/

9. Penalty contact: force grows with penetration depth (stiff spring, some penetration tolerated); constraint contact enforces near-zero penetration but is numerically less forgiving — the sources are generic FE contact notes, not game-specific. The script found no public documentation of stacked-car load paths for Wreckfest, Burnout or FlatOut. https://innovationspace.ansys.com/courses/wp-content/uploads/sites/5/2021/01/2.5.3-Numerical-Modeling-of-Contacts_latest-revised.pdf

10. Raycast vehicles (Bullet btRaycastVehicle, Rapier DynamicRayCastVehicleController) are one dynamic chassis body with wheels as rays; ground hit is stored as m_groundObject; suspension force and forward impulse go to the chassis only, and in updateFriction the ground-body line `//groundObject->applyImpulse(-sideImp,rel_pos2);` is commented out (per the script's reading of the source) — so a wheel on another car's roof gets support/traction but that car gets no equal-and-opposite wheel reaction from the vehicle code [last clause INFERENCE]. The script found no citable PhysX Vehicle SDK claim. https://pybullet.org/Bullet/BulletFull/btRaycastVehicle_8cpp_source.html

11. Gaffer on Games: lockstep sends only inputs and needs identical results on every machine; state synchronization sends input+state, tolerates non-determinism and corrects toward the authority; authority is assigned per object/owner. Rocket League's GDC talk (per the script: fixed 120 Hz tick, 100% server authority, client prediction, server resimulation) is the concrete rollback example. The claim that update-stage order (wheels, body, deformation, pair contacts) must be identical for stable stacks/replays is the script's reasoning, cited only to a generic fixed-timestep page — [INFERENCE]; racing-sim specifics (iRacing, AC, rFactor, Forza) rest on forum/hosting pages and are weak. https://gafferongames.com/post/state_synchronization/ , https://gafferongames.com/post/deterministic_lockstep/ and https://ubm-twvideo01.s3.amazonaws.com/o1/vault/gdc2018/presentations/Cone_Jared_It_Is_Rocket.pdf

12. Box-box contacts: SAT over 6 face normals + 9 edge-edge axes, least-penetration axis is the provisional normal, face axes win near-ties via a bias; reference/incident face clipping builds the manifold; Bullet's btBoxBoxDetector is an ODE-adapted routine; Box2D's 2D clip yields up to two points and the script says its face choice uses a linearSlop-scaled deadband ("such as 0.1 * linearSlop") against flip-flopping. A bare push-apart along the min axis has no tangential resistance and a possibly sideways normal under tilt, so the stack creeps (script's explanation, cited only to the Bullet source page). https://pybullet.org/Bullet/BulletFull/btBoxBoxDetector_8cpp_source.html
