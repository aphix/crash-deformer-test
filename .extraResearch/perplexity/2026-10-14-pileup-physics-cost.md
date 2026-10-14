For a 20–30-car pile-up, the largest gains usually come from **reducing the number of active constraints**, not from choosing between broadphase algorithms. Use persistent islands, aggressive but safe sleeping, contact persistence, warm starting, capped manifolds, and physics LOD.

## Recommended pipeline

1. **Broadphase**
   - Maintain separate static and dynamic broadphase structures. Jolt, for example, uses separate layers because static geometry is expensive to update while dynamic bodies change every step.[6]
   - Use sweep-and-prune when cars mostly move coherently along roads or a small number of axes.
   - Use a dynamic BVH/AABB tree for irregular 3D wrecks and mixed motion.
   - Use a uniform grid only when object sizes are reasonably similar; cars with widely varying debris sizes can cause excessive cell overlap.
   - Filter aggressively before narrow phase:
     - chassis–chassis
     - wheel–ground
     - wheel–vehicle only if needed
     - suppress wheel–wheel, hidden debris, and already-disabled decorative parts.

2. **Persistent islands and sleeping**
   - Build connected components from contacts and joints, then solve each awake island independently.
   - If every body in an island remains below linear/angular velocity and energy thresholds for several frames, sleep the entire island. Sleeping bodies are removed from the solver while retaining collision detection against awake bodies.[5][6]
   - Wake the complete connected island when:
     - an awake body contacts it,
     - a force or impulse exceeds a threshold,
     - a body is picked up or receives gameplay input,
     - a sleeping body’s AABB is penetrated by a sufficiently energetic object.
   - Avoid waking an entire scene for a tiny local impact. Use island-level propagation, but cap propagation distance or impulse attenuation for secondary debris.

Box2D reports that persistent islands can be roughly **an order of magnitude faster than rebuilding islands with DFS**, although this is an engine-specific result rather than a universal 10× guarantee.[5] In a pile-up, sleeping can reduce solver work by **50–95% after the wreck settles**, depending on how many cars remain connected and moving; benchmark this with your vehicle setup rather than assuming a fixed percentage.

## Speculative contacts versus substepping

**Speculative contacts** are usually the better default for a pile-up. They create constraints for pairs expected to become touching during the timestep, avoiding some tunneling without full swept-volume CCD. This is generally cheaper than exact time-of-impact processing.[4][8]

Use:

- speculative contacts for ordinary chassis and low-to-moderate-speed impacts;
- discrete detection for already-slow bodies;
- selective CCD or substeps only for fast, small, gameplay-critical objects.

A practical policy:

| Situation | Method |
|---|---|
| Resting or slow wreck | Discrete contacts, one main step |
| Normal vehicle motion | Speculative contacts |
| High-speed car approaching pile | 2–4 substeps or swept CCD for that car only |
| Small debris | Speculative contacts or enlarged collision margin |
| Very high-speed impact | CCD during the impact window, then return to speculative contacts |

Substepping the entire 30-car island is expensive because it multiplies broadphase, narrow-phase, and solver work. Selective substepping can reduce the cost by approximately **2–4× versus globally running 2–4 substeps**, assuming only a small fraction of bodies require it. The exact gain depends on whether the engine can isolate the fast body without forcing the whole island to substep.

## Contact caching and warm starting

Persist contact pairs and manifolds across frames. Reuse:

- feature IDs;
- contact points;
- normal and friction impulses;
- cached separating distances;
- accumulated solver impulses.

Warm starting gives the solver a near-correct impulse estimate when configurations change only slightly. Persistent contacts also prevent stacks from repeatedly rebuilding from scratch. Box2D’s island design explicitly persists contact pairs, and warm-started contact caches are a major reason settled stacks remain stable with fewer iterations.[4][5]

Recommended settings:

- Keep **2–4 chassis contact points per pair**, not every generated point.
- Preserve the deepest point and points spanning the contact patch.
- Match contacts by geometric feature ID where possible.
- Do not discard a manifold merely because one point disappears; retain it briefly with a tolerance.
- Invalidate cached impulses after teleportation, major deformation, large friction changes, or a large relative transform jump.
- Warm-start friction separately from normal impulses if your solver supports it.

For a stable pile, warm starting commonly allows a reduction from something like **8–12 solver iterations to 4–8** without an obvious loss of stability. That can produce roughly **20–50% lower solver time**, but only if contact persistence is good. Flickering manifolds can eliminate most of the benefit.

## Adaptive solver iterations

Use different iteration budgets per island rather than one global value:

- **Sleeping island:** 0
- **Nearly settled island:** 2–4 velocity/position iterations
- **Ordinary pile-up:** 4–8
- **Fresh high-energy impact:** 8–12 for a short window
- **Severe penetration or rollover:** temporarily raise iterations or use a corrective substep

Drive the budget from measurable error:

- maximum penetration;
- relative normal velocity;
- angular velocity;
- residual constraint error;
- number of new contacts;
- impulse variance between iterations.

A useful decay scheme is:

1. Start an impacted island at the high budget.
2. Keep it high for 2–5 frames.
3. Reduce iterations when penetration and residual velocity fall below thresholds.
4. Return to the low budget after a quiet period.

Do not spend high iterations on all contacts equally. Prioritize chassis-ground and chassis-chassis contacts; use cheaper treatment for cosmetic panels, wheels hidden inside wreckage, and low-mass debris.

## Broadphase selection

| Broadphase | Best use | Main risk |
|---|---|---|
| Sweep and prune | Coherent motion, road scenes, mostly axis-aligned movement | Less attractive when objects rotate heavily or move in all directions |
| Uniform grid | Similar-sized objects and dense local areas | Large cars span many cells; varying scales create duplicate candidates |
| Dynamic BVH/AABB tree | General 3D vehicle piles and irregular wrecks | Tree maintenance and fat-AABB tuning |
| Separate static/dynamic structures | Large environments with few moving bodies | Requires careful layer filtering |

For 20–30 cars, broadphase is often not the dominant cost once the pile is dense: the potentially colliding set approaches \(O(n^2)\) locally. At 30 cars there are 435 unordered body pairs before filtering, so collision-layer masks and contact persistence matter as much as the broadphase itself.

Use fattened AABBs to avoid tree updates for tiny motion, but keep the margin velocity-aware. Excessive margins increase candidate pairs; small margins cause frequent reinsertion.

## Physics LOD

Physics LOD is often the most reliable way to guarantee a frame-time budget.

### Near camera or gameplay-critical

- Full deformable or articulated vehicle model.
- Full chassis, wheels, suspension, and damage constraints.
- High contact budget.
- CCD or selective substeps.
- High solver iterations during impacts.

### Mid-distance

- Rigidified damaged vehicle or reduced-body vehicle.
- Fewer collision shapes.
- Approximate suspension.
- Lower contact-point cap.
- 30–60 Hz simulation while rendering at full rate.

### Far or off-screen

- One rigid proxy per vehicle.
- Kinematic or impulse-based pile motion.
- Sleep immediately after settling.
- Low-rate simulation, such as 10–20 Hz.
- Replace detailed deformation with precomputed damage state or animation.

### Off-screen pile

- Simulate only aggregate momentum, bounding boxes, and gameplay-relevant collisions.
- Keep a deterministic seed/state so the detailed wreck can be reconstructed when it becomes visible.
- Convert back to full physics only when within a distance and relevance threshold.

The goal is not merely fewer solver iterations; it is fewer shapes, contacts, bodies, and wake events. A reduced proxy can cut per-vehicle collision work by **roughly 3–10×** depending on how many wheels, panels, and internal constraints the full model contains. Treat those figures as engineering targets, not universal measurements.

## Burnout, BeamNG, Wreckfest, and engine comparisons

- **BeamNG-style soft-body deformation** is substantially more expensive than rigid-body vehicle physics because deformation introduces many additional constraints and collision elements. Keep the full soft-body model limited to nearby vehicles and use rigid or simplified proxies elsewhere.
- **Wreckfest-style damage** can use a lower-dimensional structural model for most contacts, activating detailed deformation only during impactful events.
- **Burnout-style gameplay** benefits from event-driven destruction, animation-assisted deformation, and aggressive LOD rather than continuously solving every damaged panel.
- **Box2D** demonstrates the value of persistent islands, sleeping solver sets, persistent contacts, and compact data layouts; it is useful conceptually, although its 2D performance does not directly predict a 3D vehicle simulation.[5][9]
- **Jolt** uses island sleeping and a dynamic broadphase with separate static and dynamic layers, making it a useful reference for a general-purpose 3D implementation.[6]
- **PhysX** supports speculative CCD, contact caching, contact reduction, solver iteration controls, and configurable depenetration behavior; speculative CCD and contact-offset tuning should be applied selectively because larger offsets can increase collision work.[8][10]

## A practical starting budget

For 30 cars at 60 Hz:

- 1 main physics step per frame.
- 2–4 solver iterations for settled islands.
- 6–8 iterations for active pile islands.
- 10–12 iterations for a newly impacted island for 2–5 frames.
- 2–4 chassis contact points per pair.
- Speculative contacts by default.
- CCD/substeps only for cars exceeding a velocity or time-to-impact threshold.
- Full detail for 4–8 nearest vehicles.
- Reduced rigid proxies for the rest.
- Sleep an island after roughly 0.3–1.0 seconds below velocity/energy thresholds, with thresholds tuned against visible jitter.
- Rebuild or aggressively refresh cached manifolds after large deformation or teleportation.

A realistic optimization target is:

- **2–5×** lower active solver cost from sleeping, contact reduction, warm starting, and adaptive iterations;
- **2–4×** lower collision cost from selective rather than global substepping;
- **3–10×** lower cost for far vehicles from physics LOD;
- potentially **5–20× total frame-time reduction** in a scene where most cars settle or are outside the high-detail region.

These ranges are workload-dependent. The most useful benchmark is a fixed replay measuring broadphase pairs, narrow-phase contacts, solver constraints, awake bodies, island count, iteration count, and milliseconds per stage.

[1] Phaser Box2D - High-Performance 2D Physics (https://phaser.io/box2d)
[2] Phaser World Issue 210 (https://phaser.world/phaser-world-issue-210)
[3] phaser-world-issue-210.md (https://phaser.world/phaser-world-issue-210.md)
[4] 13continuous Collision... (https://mightyprofessionalgaming.com/tutorials/physics-from-scratch)
[5] Simulation Islands (https://box2d.org/posts/2023/10/simulation-islands/)
[6] Architecture of Jolt Physics - GitHub Pages (https://jrouwe.github.io/JoltPhysics/)
[7] Box2D physics engine: install and use guide - Hysen Labs (https://hysenlabs.com/projects/erincatto-box2d)
[8] Collision Behavior Guide# (https://nvidia-omniverse.github.io/PhysX/ovphysx/latest/guides/collision_tuning.html)
[9] Solver Sets and Islands | erincatto/box2d | DeepWiki (https://deepwiki.com/erincatto/box2d/2.7-solver-sets-and-islands)
[10] deepwiki.com · NVIDIAGameWorks · PhysXPhysics Simulation Pipeline | NVIDIAGameWorks/PhysX | DeepWiki (https://deepwiki.com/NVIDIAGameWorks/PhysX/2.1-physics-simulation-pipeline)
