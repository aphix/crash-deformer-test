For shape-matching soft bodies, the most practical model is: compute the elastic goal shape from the current cluster, apply a plastic rest-shape update only when stress exceeds yield, and keep plastic change in a rest-space transform rather than directly in world space. The main pitfalls are updating plasticity in the wrong frame, letting scale drift accumulate, and allowing iterative stiffness or repeated corrections to create volume gain or inverted clusters.  

## Core model

A robust shape-matching loop usually looks like this:

1. Build cluster rest data from rest positions \(q_i\).
2. Each step, compute current centroid \(c\) and best-fit rotation \(R\) from current positions \(x_i\) to the rest shape.
3. Compute goal positions \(g_i = c + R \, S_p \, (q_i - q_{cm})\), where \(S_p\) is the plastic rest transform and \(q_{cm}\) is the rest centroid.
4. Move particles toward \(g_i\) with stiffness.
5. If deformation exceeds yield, update \(S_p\) slowly toward the elastic deformation part, usually using a creep-like filter.

The 2005 Müller shape-matching paper explicitly stores a plastic deformation state matrix \(S_p\) per cluster, initialized to identity[1]. Later descriptions of the plastic update use a creep-style blend such as \(S_p \leftarrow [I + h c_{creep}(S - I)] S_p\), with \(S\) representing the elastic stretch-like part before rotation[2].  

## What to store in plasticity

Use plasticity as a rest-state update, not as a direct velocity or force term.

- Store a cluster-local transform \(S_p\) or a rest-shape offset field.
- Keep \(S_p\) separate from the rigid rotation \(R\).
- If you want metal-like deformation, update plastic state only from the non-rotational part of the deformation.
- Clamp plastic change per step to avoid runaway drift.

A key detail from later work is that with plasticity, the optimal rotation should be extracted from the elastic part of the deformation, and goal positions must account for the plastic deformation state[3]. That is the frame error many implementations make: they compute rotation from already-plasticized data and then plasticize again.

## Yield, creep, and max limits

A practical implementation is:

- Compute a strain measure from the symmetric stretch or deformation gradient.
- If strain magnitude is below yield, do nothing.
- If above yield, move \(S_p\) toward the current deformation by a small fraction proportional to creep rate and timestep.
- Clamp the total accumulated plastic strain to a maximum.
- Optionally use separate thresholds for compression and tension.

Good defaults for stable behavior:

- Small creep rate per second.
- Low per-step plastic delta.
- Hard clamp on singular values of \(S_p\).
- Reset or reinitialize when \(S_p\) becomes too ill-conditioned.

If you update plasticity too aggressively, the body becomes jelly-like and can “forget” its shape in a few frames. If you update too slowly, you get permanent elastic recovery instead of true plastic deformation.

## Rotation-aware plasticity, like the Bugbear-style extension

The practical idea is to let plasticity affect the rest centers of mass and the final vertex transform incrementally, so the cluster remembers not just stretch but also accumulated rotational offsets.

A robust version is:

- Keep a rest centroid \(q_{cm}\).
- Accumulate a plastic rest transform \(P\) in cluster space.
- Update the effective rest positions as \(q'_i = P (q_i - q_{cm}) + q_{cm}\).
- Recompute the goal transform relative to \(q'_i\), not the original \(q_i\).
- If you want incremental “bent metal” behavior, apply the plastic update in small increments each frame rather than snapping the rest pose.

This gives the “deformed metal” feel without the rubber/jelly look because the object can permanently bend while still retaining local rigidity inside each cluster.

## Stiffness by iteration

With shape matching and PBD-style solvers, stiffness often increases with iteration count. That means “stiffness” is not automatically frame-rate independent.

Practical guidance:

- If using multiple solver iterations, reduce per-iteration correction strength.
- Avoid tuning one stiffness value assuming one iteration and then changing iteration count later.
- For consistent results, use an iteration-independent formulation if available, or calibrate stiffness against the chosen solver iteration count.
- More cluster overlap usually improves apparent rigidity but also increases the chance of overconstraint and volume artifacts.

A common pitfall is that a body becomes much stiffer when iteration count rises, even if the stiffness parameter is unchanged. That is the classic “stiffness by iteration” trap.

## Preventing volume gain and inverted clusters

This is where most implementations break.

### Prevent volume gain

- Normalize or clamp the determinant of the cluster transform.
- Remove unintended uniform scaling from the fitted transform.
- Prefer polar decomposition or SVD and explicitly discard scale if the model is supposed to stay volume-neutral.
- If plasticity changes shape, update only the allowed modes of deformation.

A simple safeguard is to separate the fit into rotation and stretch, then clamp stretch singular values to a safe interval like \([s_{min}, s_{max}]\). If you allow arbitrary affine updates, volume will drift.

### Prevent inverted clusters

- Reject transforms with negative determinant.
- If the best-fit transform flips orientation, fall back to a safer rotation-only fit.
- Use strong clamping on extreme compression.
- For tetrahedral or volumetric clusters, check signed volume after projection.
- If a cluster is about to invert, reduce plastic update or restore the previous valid rest state.

In practice, inversion often comes from one of these:
- too large a timestep,
- too much correction in one iteration,
- overly aggressive plasticity,
- allowing singular values to collapse near zero,
- averaging across too few particles.

## Recommended implementation pattern

A stable pattern is:

- Compute fit \(A\) from current positions to rest offsets.
- Extract \(R\) with polar decomposition or SVD.
- Compute elastic stretch \(S = R^T A\) or similar rest-space stretch measure.
- If \(\|S - I\|\) exceeds yield, update \(S_p\) by a small creep step.
- Rebuild goal positions from the plasticized rest frame.
- Apply only partial position correction per iteration.
- Clamp determinant and singular values of plastic state.

Pseudo-code sketch:

```cpp
// per cluster
fit current deformation A from x_i and q_i;
R = polarDecomposition(A);
S = transpose(R) * A;          // elastic stretch-like part

if (strainMagnitude(S) > yield)
{
    Matrix3 dP = clampMatrix(I + creep * dt * (S - I), minSingular, maxSingular);
    Sp = dP * Sp;
    Sp = clampDeterminantAndSingularValues(Sp);
}

for each particle i
{
    vec3 goal = c + R * Sp * (q_i - q_cm);
    x_i += stiffness * (goal - x_i);
}
```

## Practical pitfalls

- Updating plasticity in world space instead of cluster local space.
- Letting \(S_p\) absorb rotation as well as stretch.
- Using too few particles per cluster, which makes fit estimates noisy.
- Not clamping singular values, causing collapse or explosion.
- Mixing plasticity and solver correction in the wrong order.
- Recomputing rest data too often, which destroys long-term memory.
- Using large timesteps with aggressive creep.
- Ignoring determinant sign, which allows inverted clusters.
- Tuning stiffness without accounting for iteration count.

## Rule of thumb

If the result looks like jelly, plasticity is too strong or applied in the wrong frame. If it looks rigid but never keeps a bend, plasticity is too weak or not updating the rest frame. If volume grows, scale is leaking into the fit. If clusters invert, clamp the deformation harder and reduce per-step plastic update.

If useful, a concrete reference implementation sketch in C++/GLM or pseudocode for a cluster-based solver can be provided next.

[1] Meshless Deformations Based on Shape Matching (https://graphics.stanford.edu/courses/cs468-05-fall/Papers/p471-muller.pdf)
[2] Soft Body Deformation Dynamics Based on Shape Matching (https://nccastaff.bournemouth.ac.uk/jmacey/MastersProject/MSc13/18/report/i7762542_Report.pdf)
[3] Reclustering for Large Plasticity in Clustered Shape Matching (https://users.cs.utah.edu/~benjones/FalkensteinRLP2017.pdf)
[4] Position Based Dynamics (PBD): Cloth, Soft Bodies & Constraints (https://www.mysimulator.uk/content/articles/pbd-cloth.html)
[5] Publications (https://www.iam.uni-bonn.de/fileadmin/Variational_Methods/publication_mueller_all.pdf)
[6] Dynamic Controllable Mesh Deformation in Interactive ... (http://www.diva-portal.org/smash/get/diva2:635994/FULLTEXT01.pdf)
[7] Physically based shape matching (https://matthias-research.github.io/pages/publications/Physically_Based_Shape_Matching___SCA_2022.pdf)
[8] Shape Matching (https://interactivecomputergraphics.github.io/physics-simulation/examples/shape_matching.html)
[9] Mutable elastic models for sculpting structured shapes (https://inria.hal.science/hal-00797189/file/mutablemodels.pdf)
[10] IMPROVED MESHLESS DEFORMATION TECHNIQUES FOR (https://www.scitepress.org/Papers/2007/20855/20855.pdf)
[11] Modeling of Deformable Objects for Robotic Manipulation - PMC - NIH (https://pmc.ncbi.nlm.nih.gov/articles/PMC7805872/)
[12] XPBD (https://www.scribd.com/document/793877907/XPBD)
[13] [PDF] Real-time simulation of large elasto-plastic deformation with shape matching | Semantic Scholar (https://www.semanticscholar.org/paper/Real-time-simulation-of-large-elasto-plastic-with-Chentanez-M%C3%BCller/2554a91b4d189084ff5f5430649af886f5cccb9e)
[14] Degree project in Computer Science and Engineering (https://www.diva-portal.org/smash/get/diva2:1708156/FULLTEXT01.pdf)
[15] orientedParticles (https://www.scribd.com/document/581547043/orientedParticles)
