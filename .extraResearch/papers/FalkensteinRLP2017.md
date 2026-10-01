# Reclustering for Large Plasticity in Clustered Shape Matching

Michael Falkenstein, Ben Jones, Joshua A. Levine, Tamar Shinar, Adam W. Bargteil — MiG '17 (Motion in Games), Barcelona, November 8–10, 2017. DOI: 10.1145/3136457.3136473. 6 pages.

Affiliations (as listed): University of Maryland, Baltimore County; University of Utah; University of Arizona; University of California, Riverside.

> Faithful section-by-section paraphrase. Equations are re-typeset in LaTeX; where the PDF text extraction garbled an equation, the reconstruction is marked **[reconstructed]**.

## Abstract

The paper returns to *online reclustering* in clustered shape matching (CSM). New clusters are created by two nonlinear optimizations:

1. an **embedding optimization** that places particles and clusters in 3-D space so that elastic energy is minimized (the *embedded space*);
2. a **cluster optimization** that picks the best location for the new cluster inside that embedded space.

This is more robust than prior reclustering when elastic deformation is present. Experiments indicate that results **converge as the cluster count grows**, i.e. reclustering does not change the effective material. The authors also show that **particle resampling is unnecessary** in their framework, so volume is trivially conserved. Finally they point out a **mistake in how rotations were estimated** in the original shape-matching paper [Müller et al. 2005], an error repeated in much follow-up work.

CCS concepts: Computing methodologies → Simulation by animation; Physical simulation. Keywords: shape matching, clustering, plasticity.

## 1 Introduction

Shape matching [Müller et al. 2005] is a geometric technique for animating deformable bodies (Figure 1). The body is sampled with particles that carry its degrees of freedom. Every step the best rigid transform from the rest shape to the current particle configuration is found, and Hookean springs pull each particle toward its rigidly transformed rest location.

Müller et al. also proposed splitting the body into several **overlapping clusters** (*clustered shape matching*). Multiple clusters give a richer deformation space; overlap keeps the body from separating. CSM lacks a rigorous mathematical foundation but is attractive for interactive applications such as games.

Chentanez et al. [2016] added the ability to dynamically add and remove clusters **and particles**, which handles very large plastic deformation where earlier approaches [Jones et al. 2016] break down. This paper offers an alternative reclustering scheme built on two nonlinear optimizations (embedding, then cluster placement in the embedding), which is more robust under elastic deformation, converges with increasing cluster count, does not need particle resampling (so volume is conserved trivially), and fixes the rotation-estimation error noted above.

> Figure 1: Shape-matching overview. (a) An object (a square) is sampled with particles $p_i$, giving rest positions $r_i$. (b) Under external forces and constraints the particles move to world positions $x_i$. (c) The best-fit rigid transform of the rest positions onto the world positions is computed; dotted red circles are the goal positions $g_i$. (d) Hookean springs pull the world positions toward the goals.

## 2 Background

First related work, then a short review of CSM, before the reclustering method of Section 3.

### 2.1 Related Work

- **Shape matching** was introduced by Müller et al. [2005], emphasizing efficiency, stability and controllability — which makes it attractive for games. They also proposed linear and quadratic deformation modes (beyond rigid), cluster-based deformation, and plasticity.
- **Lattice shape matching** (Rivers and James 2007) used hierarchical lattices to define clusters and exploited the regular structure for very high performance. Steinemann et al. [2008] moved the lattice approach to **octrees, giving spatial adaptivity**.
- **Oriented particles** (Müller and Chentanez 2011) track per-particle orientation to stabilize non-volumetric objects (shells, strands) and simplify sampling; useful for clothing and hair on animated characters.
- Bargteil and Jones [2014] added **strain limiting** to CSM. Jones et al. [2015] studied better **clustering strategies** and simple **collision proxies** for clusters. Jones et al. [2016] added a **plasticity model** and **ductile fracture** to CSM.
- Other real-time deformables: position-based dynamics [Bender et al. 2014; Kelager et al. 2010; Macklin et al. 2014; Müller et al. 2007], frame-based models [Faure et al. 2011; Gilles et al. 2011], projective dynamics [Bouaziz et al. 2014; Liu et al. 2013]. Plasticity and fracture have been shown for PBD, but such changes invalidate the precomputation that makes frame-based models and projective dynamics fast. Following Bargteil and Jones [2014], the authors argue CSM adheres better to Newton's first and second laws than PBD.

### 2.2 Clustered Shape Matching

For completeness the paper restates Müller et al. [2005] and the extensions of Bargteil, Jones et al. [2014; 2015; 2016], then the plasticity and fracture models, then the sampling and clustering choices.

### 2.3 Shape Matching

The object is discretized into particles $p_i \in P$ with masses $m_i$ and rest positions $r_i$; each follows a world-space path $x_i(t)$. Each frame, a rotation $R$ and translation $\bar x - \bar r$ are found that best (least squares) map the rest pose to the current pose:

$$
\min_{R,\;\bar x - \bar r}\; \sum_i m_i \,\big\| R\,(r_i - \bar r) - (x_i - \bar x) \big\|^2 . \tag{1}
$$

The optimal translation is the difference of the rest and world centers of mass $\bar r$, $\bar x$. For the rotation, first fit the least-squares **linear** deformation gradient $F$:

$$
\min_F\; \sum_i m_i \,\big\| F\,(r_i - \bar r) - (x_i - \bar x) \big\|^2 . \tag{2}
$$

Setting the derivative with respect to $F$ to zero gives

$$
F = \Big(\sum_i m_i\, O(x_i - \bar x,\; r_i - \bar r)\Big)\Big(\sum_i m_i\, O(r_i - \bar r,\; r_i - \bar r)\Big)^{-1} = A_{xr}\,A_{rr}^{-1}, \tag{3}
$$

with the outer product

$$
O(a_i, b_i) = a_i\, b_i^{T}, \tag{4}
$$

and $A_{**}$ as shorthand for the summed mass-weighted outer products. $R$ comes from the polar decomposition

$$
F = R\,S = U\,\Sigma\,V^{T}, \qquad R = U V^{T},\quad S = V\,\Sigma\,V^{T}, \tag{5}
$$

where $S$ is symmetric and $U\Sigma V^T$ is the SVD of $F$. Others (e.g. Rivers and James 2007) note that iterative polar decomposition is faster, especially warm-started; the authors keep the SVD for robustness and because the plasticity model (Section 2.3.1) needs it. Goal positions are

$$
g_i = R\,(r_i - \bar r) + \bar x , \tag{6}
$$

and Hookean springs pull particles toward $g_i$.

#### 2.3.1 Clustered Shape Matching

Splitting the body into overlapping clusters allows richer, more local deformation and is simple to implement. Each particle's mass is **shared among its clusters**: for particle $p_i$ in cluster $c \in C$, a weight $w_{ic}$ states how much of $m_i$ belongs to $c$, and $m_i$ is replaced by $w_{ic} m_i$ in Eqs. (1)–(3). If particle $i$ belongs to $n_i$ clusters, the cluster center of mass is

$$
\bar x_c = \frac{\sum_{i \in P_c} (w_{ic}\, m_i)\, x_i}{\sum_{i \in P_c} w_{ic}\, m_i}, \tag{7}
$$

with $P_c$ the member set of cluster $c$. The particle's goal is the weighted average of its per-cluster goals:

$$
g_i = \sum_c w_{ic}\, g_{ic}, \tag{8}
$$

where $g_{ic}$ is the goal for particle $i$ from cluster $c$.

**Clustering.** The clustering method of Jones et al. [2015] is used: a variant of **fuzzy c-means** producing overlapping clusters in which a particle may belong to several clusters to differing degrees. Like k-means, it alternates between updating memberships (the weights $w_{ic}$) and updating cluster centers (weighted centers of mass of the members). Jones et al. [2015] discuss weighting functions, cluster size, and overlap in detail.

**Strain limiting.** For stability the strain-limiting scheme of Bargteil and Jones [2014] is adopted. With plasticity present the maximum allowed stretch ($\gamma$ in that paper) is usually raised, to avoid instabilities when clusters disagree about the current rest shape.

**Collision handling.** Jones et al. [2015]: spheres intersected with half-spaces serve as per-cluster collision proxies; this fits a fracture approach that splits clusters with planes.

**Sampling geometry.** Particle distribution affects results. Grid sampling and blue-noise sampling were both tried; blue noise (Bridson's fast Poisson-disk sampling [2007]) gave preferred results over the highly structured grid. For a closed manifold boundary, particles are sampled within the bounding box and those outside the surface discarded.

**Plasticity.** The Bargteil et al. [2007] plasticity model is adapted to CSM. Each cluster $c$ stores and updates a plastic matrix $F^p$ (subscript $c$ dropped below). The elastic part of the deformation gradient is

$$
F^{e} = F\,(F^{p})^{-1}, \tag{9}
$$

with $F$ from Eq. (3). $F^e$ is decomposed as in Eq. (5). $F^p$ starts as the identity $I$. Each step the diagonalized elastic part is made volume-preserving:

$$
F^{e*} = \det(\Sigma^{e})^{-1/3}\,\Sigma^{e}, \tag{10}
$$

and the deviatoric strain magnitude

$$
\| F^{e*} - I \|_F \tag{11}
$$

($\|\cdot\|_F$ the Frobenius norm) is compared to a plastic yield threshold $\lambda$. Below threshold $F^p$ is unchanged. Otherwise **[reconstructed]**

$$
F^{p}_{\text{new}} = V\,(F^{e*})^{\gamma}\,V^{T}\,F^{p}_{\text{old}}, \tag{12}
$$

where $V$ holds the right singular vectors from Eq. (5) and **[reconstructed]**

$$
\gamma = \min\!\left( \frac{\nu\,\big(\|F^{e*} - I\|_F - \lambda - K\alpha\big)}{\|F^{e*} - I\|_F},\; 1 \right), \tag{13}
$$

with user-set **flow rate** $\nu$ and **work hardening/softening** constant $K$. $\alpha$ accumulates stress; it starts at zero and is updated **[reconstructed]**

$$
\alpha \leftarrow \alpha + \| F^{e*} - I \|_F . \tag{14}
$$

No additional left-hand rotations are applied when forming $F^p_{\text{new}}$, because they would be thrown away by the decomposition in Eq. (5). With plasticity, the optimal rotation must come from the polar decomposition of the **elastic** part:

$$
F^{e} = A_{xr}\,A_{rr}^{-1}\,(F^{p})^{-1}, \tag{15}
$$

and goal positions must include the plastic deformation:

$$
g_i = R\,F^{p}\,(r_i - \bar r) + \bar x . \tag{16}
$$

The authors note these details were left out by Jones et al. [2016].

## 3 Methods

### 3.1 The Best Rotation

The paper first flags an error in early shape-matching work. Müller et al. [2005] argued that because $A_{rr}$ is symmetric it has no effect on the rotation, and so computed $R$ directly from the polar decomposition of $A_{xr}$, skipping $A_{rr}^{-1}$. That yields the same rotation as the polar decomposition of $F$ **only** if $A_{rr}$ is diagonal or $F$ has condition number 1. When $A_{rr}$ is not diagonal **and** $F$ contains non-uniform scale, the polar decompositions of $A_{xr}$ and of $F$ give **different rotations**.

Concrete 2-D example. A non-diagonal $A_{rr}$ needs a shape that is asymmetric with respect to the reference frame, so sample four corners of a rectangle not aligned with the axes: $(1,3)$, $(3,1)$, $(-1,-3)$, $(-3,-1)$. Then

$$
A_{rr} = \begin{pmatrix} 20 & 12 \\ 12 & 20 \end{pmatrix}, \qquad A_{rr}^{-1} = \frac{1}{64}\begin{pmatrix} 5 & -3 \\ -3 & 5 \end{pmatrix}. \tag{17}
$$

Stretching by a factor of 2 along $x$ gives

$$
A_{xr} = \begin{pmatrix} 40 & 24 \\ 12 & 20 \end{pmatrix}, \tag{18}
$$

which is not symmetric. Its polar decomposition gives

$$
R \approx \begin{pmatrix} 0.9806 & 0.1961 \\ -0.1961 & 0.9806 \end{pmatrix} \tag{19}
$$

(an ≈11.3° rotation; sign layout recomputed here from Eq. 18 **[reconstructed]**), even though the applied transform contains no rotation. Using the full fit instead,

$$
F = A_{xr} A_{rr}^{-1} = \begin{pmatrix} 2 & 0 \\ 0 & 1 \end{pmatrix}, \tag{20}
$$

recovers the transform exactly (and $R = I$).

The error persists in the literature [Choi 2014; Müller and Chentanez 2011; Rivers and James 2007; Steinemann et al. 2008]. In practice it is probably minor: artists tend to align model symmetries with the axes so $A_{rr}$ is near-diagonal, and the object in the example would begin rotating as it undoes the deformation anyway. The authors could not produce a case where the wrong rotation looked implausible. More importantly, the belief that the polar decomposition of $A_{xr}$ gives the optimal rigid rotation **motivated the elaborate plasticity model of Choi [2014]**, adopted by Chentanez et al. [2016]. The authors instead adopt the simpler plasticity model of Jones et al. [2016], based on the correct rotation. As said above, with plasticity the optimal rotation is the polar decomposition of $F^e$.

### 3.2 Reclustering

Under plastic deformation the rest state generally stops being **embeddable in 3-D space**. Modest plastic deformation can be represented by per-cluster plastic offsets ($F^p$), but under large plasticity storing particle rest positions no longer makes sense. Instead each cluster stores the **position of each member relative to the cluster center**, $p_{ic}$, which replaces $r_i - \bar r$ everywhere. $p_{ic}$ may change to reflect shifting membership, but it does **not** absorb the plastic deformation accumulated over the cluster's lifetime, so $F^p_c$ must still be stored per cluster. This saves computation at the cost of storage. Equivalently, every cluster's rest center of mass sits at the origin. Chentanez et al. [2016] use the same storage.

#### 3.2.1 Cluster Removal

A cluster is removed when the **condition number of its $F^p$** exceeds a threshold, signalling that the cluster's rest state is badly distorted. This resembles Bargteil et al. [2007], who remeshed globally when any tetrahedron's condition number crossed a threshold, and differs from Chentanez et al. [2016], who triggered removal on the Frobenius norm of $F^p$ or on particle-membership statistics. The Frobenius norm measures absolute magnitude of $F^p$ and is limited because volume preservation forces $\det F^p = 1$; the condition number instead measures the **relative squash and stretch** that $F^p$ imposes on the rest space, which is the more meaningful quality measure. Also, $F^p$ must be inverted, and numerics degrade as it nears singularity; removing clusters with large condition number avoids singular matrices.

A cluster marked for removal **fades out over a user-set number of steps** by gradually reducing its weights $w_{ic}$. The mass of its particles is thereby redistributed to the other clusters, because the normalizing denominator in Eq. (2) shrinks. Changing weights moves cluster centers, so members' relative positions $p_{ic}$ are updated to keep each cluster's center of mass at the origin.

#### 3.2.2 Cluster Addition

To add clusters the algorithm loops over particles. Any particle that will **soon belong to no cluster** (all its clusters are marked for removal) becomes a **seed** for a new cluster. A **local embedding** of the rest space into an *embedded space* is computed, and the new cluster's position is optimized in that space. The three parts follow.

**Embedding optimization.** Several spaces could host new clusters. Chentanez et al. [2016] add clusters in world space, taking as members all particles within a radius — analogous to the world-space remeshing of Bargteil et al. [2007]. Wicke et al. [2010] showed that this is problematic under large elastic deformation, because world space then differs greatly from the minimum-stress configuration; they solve a nonlinear optimization for a minimum-stress configuration and remesh there (locally, avoiding the smoothing of whole-sale global remeshing). Jones et al. [2014] linearized the problem, finding the least-squares embedding into 3-D and doing nearest-neighbor queries there. Here, embedded positions $e_i$ for particles and $e_c$ for clusters are sought that minimize elastic energy **[reconstructed]**:

$$
\{e_i^{*}\},\{e_c^{*}\} = \arg\min_{e_i,\,e_c}\; \sum_c \sum_{i \in P_c} w_{ic}\, \big\| R_c\,F^{p}_c\,p_{ic} - (e_i - e_c) \big\|^2 . \tag{21}
$$

Eq. (21) is solved with the strain-limiting approach of Bargteil and Jones [2014] with the maximum allowed stretch $\gamma$ set to **zero** — essentially what most position-based dynamics implementations do [Müller et al. 2007]. **Twenty Jacobi iterations** appear more than enough. Convergence is declared when the sum of squared particle-position changes falls to $10^{-8}$ of that in the first iteration. Other solvers/criteria were not tried. Linearizing Eq. (21) as in Jones et al. [2014] — i.e. ignoring $R$, yielding three decoupled $n \times n$ linear systems with $n$ = #particles + #clusters — produced poor embeddings: the objective was **about two orders of magnitude larger** than with the nonlinear optimization.

```text
# Embedding optimization (Eq. 21), Jacobi / PBD-style with zero allowed stretch  [reconstructed from prose]
init e_i, e_c                      # e.g. current world positions / cluster centers
for it in 1..20:
    for each cluster c in C_e:     # local set, Eq. 22
        fit rotation R_c between targets {F^p_c p_ic} and current {e_i - e_c}   (polar/SVD)
        for each member i: goal_ic = e_c + R_c F^p_c p_ic
    for each particle i in P_e:  e_i <- weighted mean_c(goal_ic)          (Jacobi)
    for each cluster c in C_e:   e_c <- weighted center of its members
    stop if sum |Δe_i|^2 < 1e-8 * (sum |Δe_i|^2 at iteration 1)
```

**Local embedding.** Jones et al. [2014] embedded globally because all particles needed updated neighbor lists. Here clusters are added one at a time, so only a **local** embedding is computed — one likely to contain every particle that would fall inside the new cluster in embedded space. Take the clusters containing the candidate particle and their neighbors (clusters sharing a particle with them), and all particles in those clusters. If $p$ is the candidate and $C_p$ the set of clusters containing $p$, the clusters to embed are

$$
C_e = C_p \cup \{\, c \in C \mid \exists\, d \in C_p,\ \exists\, q \in c :\ q \in d \,\}, \tag{22}
$$

and the particles to embed are

$$
P_e = \{\, q \in P \mid \exists\, c \in C_e :\ q \in c \,\}. \tag{23}
$$

**Cluster optimization.** With embedded positions available, the new cluster's center is initialized at the candidate's embedded position and the same clustering optimization as at initialization (fuzzy c-means, Section 2.3.1) is run, **holding all other cluster centers and weights fixed**; within a few iterations the new center settles at a locally optimal location. Weights must reflect the **eventual** state of clusters: weights of clusters being removed are treated as zero, and a cluster being added is treated as if fully faded in. Following Chentanez et al. [2016], the new cluster starts with **no plastic deformation** ($F^p = I$; the paper phrases this as initializing the plastic deformation to zero **[reconstructed]**). Since the embedding error is small, residual plastic deformation is low, so this is a reasonable approximation. $F^e$ need not be estimated, because the elastic deformation is already (and more accurately) defined by the map from embedded space to world space. As with removal, the new cluster's weight **ramps up over several steps**.

After adding a cluster the loop continues over particles looking for more candidates. A particle that was a candidate at the start of the loop may be absorbed by another new cluster before its turn. Particles can be shuffled periodically to avoid ordering bias. Being chosen as a seed does not guarantee the particle ends up inside the new cluster; in experiments, however, such particles were added to clusters after a few steps. For this reason **removed clusters fade out over more steps than added clusters fade in**.

```text
# Reclustering pass, per step  [assembled from Sections 3.2.1-3.2.2]
for each cluster c:
    if cond(F^p_c) > threshold and not c.removing: c.removing = true
    if c.removing: ramp w_ic down (long fade); renormalize; shift p_ic so cluster rest COM = 0
    if c.adding:   ramp w_ic up (shorter fade)
for each particle p (periodically shuffled):
    if every cluster containing p is marked removing:
        C_e, P_e <- Eq. 22, Eq. 23
        e <- embedding optimization (Eq. 21) over C_e, P_e
        c_new.center <- e_p; fuzzy c-means on c_new only (others fixed, eventual weights)
        c_new.p_ic <- e_i - e_c_new for members;  c_new.F^p <- I;  c_new.adding = true
```

> Figure 2: A compressed beam. Left: highly plastic beam. Right: more elastic deformation. Colors show the nearest cluster center; grey particles are still in their original clusters.

## 4 Results

Two didactic examples show robustness. A compression force is applied to a beam for 4 seconds, then released: at position $(x, y, z)$ the force is $f = s \cdot (-x, 0, 0)$ for a scale factor $s$.

- **Example 1:** plastic yield threshold $\lambda = 0$, so all volume-preserving deformation is plastic. In the video, the simulation goes **unstable without reclustering**.
- **Example 2:** larger $s$ and $\lambda = 0.1$, allowing some elastic deformation. The method is compared with one that reclusters **in world space**, choosing new centers from particles belonging to the minimum number of clusters — similar to Chentanez et al. [2016] — but omitting the crucial estimate of $F^e$ from neighboring clusters. Without optimizing the embedding space or the cluster location, the simulation shows more **spurious oscillations**.

Final frames are in Figure 2. Table 1 gives timings from unoptimized research code. Versus no reclustering, reclustering in the highly plastic example roughly **doubles** simulation cost; tuning the conservative convergence thresholds would likely reduce that. The method is cheaper when there is less plastic deformation and hence less reclustering: raising the yield threshold cut reclustering cost by **more than 2×**. Embedding optimization is roughly **one third** of reclustering cost; cluster optimization is negligible.

Figure 3 shows the effect of increasing the number of clusters: as it grows, the simulation "converges" in the sense of approaching a limiting behavior.

> Figure 3: Cluster count decreases from left to right. As it decreases, apparent stiffness increases. The leftmost bars are visually almost indistinguishable.

The final example is a twisted plastic beam (Figure 4).

> Figure 4: A twisted plastic beam. Colors show the nearest cluster center; grey particles are still in their original clusters.

> Table 1: Timing results in ms per frame on a MacBook Pro with a 2.5 GHz Intel i7. The beam has 5317 particles and 200 initial clusters.

| Example | Dynamics | Plasticity | Reclustering | Embedding Optimization | Total |
|---|---|---|---|---|---|
| Compressed Beam (no reclustering) | 2.07 | 0.07 | 0 | 0 | 16.17 |
| Compressed Beam (our algorithm) | 0.56 | 0.07 | 18.60 | 6.64 | 35.54 |
| Compressed Beam (no optimization) | 0.57 | 0.07 | 9.85 | 0 | 24.99 |
| Compressed Beam (more elastic, our algorithm) | 0.59 | 0.04 | 8.03 | 2.60 | 20.62 |
| Twisted Beam | 1.12 | 0.16 | 12.56 | 3.31 | 46.54 |

**[reconstructed]** The extracted table text lists columns in this order, but the components do not add up to "Total" in any row (e.g. 2.07 + 0.07 = 2.14 ≪ 16.17), so at least one cost column (presumably shape matching/strain limiting/collision) was lost in extraction, or the "Dynamics" cells are misaligned. Trust **Total**, **Reclustering**, and **Embedding Optimization**: Embedding/Reclustering ≈ 6.64/18.60 ≈ 0.36 matches the prose ("roughly a third"), and 35.54/16.17 ≈ 2.2 matches "roughly doubles".

### Limitations and Future Work

Compared with Chentanez et al. [2016], this method does **not add or remove particles**. That trivially preserves volume but rules out **adaptive sampling** that concentrates computation on visually interesting areas of the scene. There is no surface tracking module either; the particles are rendered directly. The skinning method of Bhattacharya et al. [2011; 2015] (level sets over particles) could be used, or Steinemann et al.'s approach of embedding a surface mesh — though the mesh may tangle under very large plastic deformation. Incorporating fracture [Jones et al. 2016] is another avenue for future work.

## References (as cited)

Bargteil & Jones 2014 (Strain Limiting for CSM, MIG); Bargteil, Wojtan, Hodgins & Turk 2007 (FEM for large viscoplastic flow, TOG 26(3)); Bender, Müller, Otaduy, Teschner & Macklin 2014 (PBD survey, CGF); Bhattacharya, Gao & Bargteil 2011 (SCA) and 2015 (IEEE TVCG 21(3)) — level-set skinning of particle data; Bouaziz et al. 2014 (Projective Dynamics, TOG 33(4)); Bridson 2007 (Fast Poisson disk sampling, SIGGRAPH sketches); Chentanez, Müller & Macklin 2016 (Real-time large elasto-plastic deformation with shape matching, SCA); Choi 2014 (Real-time ductile fracture with oriented particles, CAVW 25(3–4)); Faure et al. 2011 (Sparse meshless models, TOG 30(4)); Gilles et al. 2011 (Frame-based elastic models, TOG 30(2)); Jones, Martin, Levine, Shinar & Bargteil 2015 (Clustering and collision detection for CSM, MIG); Jones et al. 2016 (Ductile fracture for CSM, I3D); Jones, Ward, Jallepalli, Perenia & Bargteil 2014 (Deformation embedding for point-based elastoplastic simulation, TOG 33(2)); Kelager, Niebe & Erleben 2010 (Triangle bending constraint for PBD, VRIPHYS); Liu, Bargteil, O'Brien & Kavan 2013 (Fast mass-spring, TOG 32(6)); Macklin, Müller, Chentanez & Kim 2014 (Unified particle physics, TOG 33(4)); Müller & Chentanez 2011 (Adding physics to animated characters with oriented particles, VRIPHYS; Solid simulation with oriented particles, TOG 30(4)); Müller, Heidelberger, Hennix & Ratcliff 2007 (Position based dynamics, JVCIR 18(2)); Müller, Heidelberger, Teschner & Gross 2005 (Meshless deformations based on shape matching, TOG 24(3)); Rivers & James 2007 (FastLSM, TOG 26(3)); Steinemann, Otaduy & Gross 2008 (Fast adaptive shape matching deformations, SCA); Wicke, Ritchie, Klingner, Burke, Shewchuk & O'Brien 2010 (Dynamic local remeshing for elastoplastic simulation, TOG 29(4)).
