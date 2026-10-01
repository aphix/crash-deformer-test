# Fast Adaptive Shape Matching Deformations

**Denis Steinemann¹, Miguel A. Otaduy², Markus Gross¹**
¹ Computer Graphics Laboratory, ETH Zürich, Switzerland · ² Grupo de Modelado y Realidad Virtual, URJC Madrid, Spain
*Eurographics / ACM SIGGRAPH Symposium on Computer Animation (SCA) 2008, M. Gross and D. James (Editors).*

> This file restates the paper section by section in my own words. Section order, headings, equations, algorithms, parameters and figure captions follow the original. The prose is paraphrased and condensed. Equations marked `[reconstructed]` were rebuilt from a damaged PDF text layer, using the surrounding definitions and the cited prior work (Müller et al. 2005; Rivers & James 2007).

---

## Abstract

The paper introduces a shape-matching deformation model that handles topological changes (cuts) and dynamically adapted levels of detail (LOD) efficiently. Like Fast Lattice Shape Matching (FLSM), it gets node positions by blending rigid shape-matching transforms from many overlapping regions. It differs in two ways: nodes come from an **octree-based hierarchical sampling**, and regions are defined by **distance intervals**. The method keeps the efficiency, robustness, algorithmic simplicity and linear cost of FLSM, but drops FLSM's need for dense, uniform sampling. It supports adaptive spatial discretizations, so arbitrary regions of interest can get more degrees of freedom at little extra cost. It handles elastic and plastic deformation and interactive cuts. Its data structures are reused for efficient (self-)collision handling. The authors pitch it at interactive uses such as video games.

*ACM CCS:* I.3.7 [Computer Graphics]: Three-Dimensional Graphics and Realism — Animation.

---

## 1. Introduction

Deformable objects make many graphics applications more engaging, which explains twenty years of deformation-model research. Film animation values physical realism most. Interactive uses (games, surgery simulators) value speed and robustness, and give up physical accuracy for plausibility. Shape-matching models have grown popular for fast, robust large deformations in game-like settings. Müller et al. [MHTG05] introduced a meshless method that pulls points toward a globally consistent deformed shape. It is unconditionally stable and very fast. Rivers and James [RJ07] added many more degrees of freedom (DOFs) with *Fast Lattice Shape Matching* (FLSM). FLSM overlaps many rigid clusters of points on a lattice and uses the lattice's regularity to build a fast algorithm. The regular lattice, however, has unsolved problems: DOFs cannot be distributed flexibly, resolution scales badly, mechanical stiffness is uniform, and topological changes are costly.

### Our Contribution

The paper presents a dynamic, shape-matching-based deformation technique that removes many of these limits. It extends shape matching to scenes with interactive topological changes (Figure 3), non-uniform mechanical behavior (Figure 4), independently moving thin features (Figure 1), and adaptive, dynamic LOD selection (Figure 6). The algorithm is as simple as FLSM and also costs time linear in the number of deformation points. Adaptive sampling, however, makes much thinner features affordable than FLSM allows, at far lower cost (Figure 1). The technical contributions:

- A hierarchical fast-summation algorithm for shape-matching deformations on adaptive discretizations. It relies on octree-based sampling and interval-based region definitions.
- An algorithm for dynamically resampling the octree representation, which enables interactive topological changes and LOD selection.
- A fast way to compute distances in the octree setting, used to update shape-matching regions dynamically.

Roadmap: §2 related work (mostly earlier shape matching); §3 review of prior shape-matching algorithms; §4 octree shape matching; §5 fast resampling for topology changes and LOD; §6 the shortest-path algorithm used for resampling; §7 experiments; §8 discussion and future work.

> Figure 1: An object deformed with the octree shape-matching approach. A finger (top right) deforms independently of the rest. FLSM needs 35 000 nodes to resolve the thin fingers (bottom left). The adaptive method needs only 661 (bottom right), an 88× speed-up.

---

## 2. Related Work

Physically based simulation of deformable materials entered graphics with Terzopoulos et al. [TPBF87]. Since then, much work has sought robust models at low cost. Examples: fast solvers for implicitly integrated FEM [BNC96]; corotational FEM for large deformation with implicit integration [MDM\*02]; surface-only boundary element methods [JP99]; and mass–spring systems with volume-preservation constraints [THMG04]. Modal analysis gives fast global deformation of complex geometry by keeping only the main modes [PW89, JP02, BJ05]. A different route embeds the geometry in a lattice or coarse mesh and deforms that [CGC\*02a]. Meshless methods handle large deformation, state transitions and topology changes [BLG94, MKN\*04, SOG06]. The surveys [GM97, NMK\*05] cover more.

Shape-matching models [MHTG05, RJ07] are purely geometric. They move points toward goals derived from the rest geometry, which makes them stable. Effectively they get the robustness of implicit integration at roughly the cost of explicit integration, so they suit plausible interactive simulation. They are reviewed in §3.

Shape matching also appears in geometric modeling. Botsch et al.'s prism model [BPGK06] finds per-prism rigid transforms that minimize a deformation energy. It solves a global optimization, so it does not suit interactive simulation with many DOFs. It was later made adaptive [BPWG07]. Position-based dynamics [MHHR06] is related: it moves points toward goals defined by local constraints.

This paper's two main applications are adaptive simulation and topological change. There is a lot of adaptive-simulation work in graphics [DDCB01, GKS02, CGC\*02b, OGRG06], but it is orthogonal to this work. For topological changes, the paper shares some of the dynamic-resampling problems of meshless deformation [PKA\*05, SOG06].

---

## 3. Deformation through Shape Matching

This section reviews [MHTG05] and [RJ07] and lists their limitations.

### 3.1. Meshless Shape Matching

Take a region $R_r$ of simulation points with rest positions $\mathbf{x}^0_i$ and deformed positions $\mathbf{x}_i$. Müller et al. find the rotation $\mathbf{R}_r$ and translation that best map the rest configuration onto the deformed one in the least-squares sense. First a linear transform is computed:

$$
\mathbf{A} \;=\; \Big(\sum_{i\in R_r} m_i\,\mathbf{p}_i\,\mathbf{q}_i^{T}\Big)\,\mathbf{A}_{qq} \;=\; \mathbf{A}_r\,\mathbf{A}_{qq} \tag{1}
$$

Here $\mathbf{p}_i = \mathbf{x}_i - \mathbf{c}_r$ and $\mathbf{q}_i = \mathbf{x}^0_i - \mathbf{c}^0_r$. $\mathbf{c}_r$ and $\mathbf{c}^0_r$ are the deformed and rest centers of mass. $\mathbf{A}_{qq}$ is symmetric and holds scaling only; in [MHTG05] it is $\big(\sum m_i\mathbf{q}_i\mathbf{q}_i^T\big)^{-1}$ `[reconstructed: the inverse is implied by MHTG05]`. Polar decomposition $\mathbf{A}_r = \mathbf{R}_r\mathbf{S}$ yields $\mathbf{R}_r$. Each node's goal is then

$$
\mathbf{g}_i \;=\; \mathbf{R}_r\big(\mathbf{x}^0_i - \mathbf{c}^0_r\big) + \mathbf{c}_r \;=\; \mathbf{T}_r\,\mathbf{x}^0_i,
\qquad
\mathbf{T}_r = \big[\,\mathbf{R}_r \;\;\; \mathbf{c}_r - \mathbf{R}_r\mathbf{c}^0_r\,\big] \in \mathbb{R}^{3\times 4},
$$

with $\mathbf{x}^0_i$ taken in homogeneous form $[\mathbf{x}^{0T}_i\;1]^T$ when multiplied by $\mathbf{T}_r$.

The goals drive an unconditionally stable integration step:

$$
\mathbf{v}_i(t+h) \;=\; \mathbf{v}_i(t) + \frac{\mathbf{g}_i(t) - \mathbf{x}_i(t)}{h} + h\,\frac{\mathbf{f}_{ext}(t)}{m_i} \tag{2}
$$
$$
\mathbf{x}_i(t+h) \;=\; \mathbf{x}_i(t) + h\,\mathbf{v}_i(t+h) \tag{3}
$$

`[reconstructed]` The text layer shows no stiffness factor in (2). [MHTG05]'s original form multiplies the goal term by $\alpha\in[0,1]$. Here, as in FLSM, stiffness comes from region size instead (§3.3, §4.2).

Müller et al. extended the basic method to linear and quadratic deformation modes. They also gained DOFs by splitting the object into several clusters. That can leave artifacts at the discontinuities between regions, and choosing the clusters is itself hard.

### 3.2. Fast Lattice Shape Matching

Rivers and James [RJ07] applied [MHTG05] on cubic lattices. They overlapped many clusters, so blending rigid shape-matching transforms over regions gives smooth deformation. The surface is embedded in the lattice and moved by trilinear interpolation of lattice vertices. Every lattice point is a simulation node $i$. Its region $R_i$ holds $i$ and every node within distance $w$ in the max-norm. FLSM computes the per-region transforms $\mathbf{T}_r$ as above. Each node's goal is the average of the transforms of all regions that contain it. Regions are symmetric, so this is

$$
\mathbf{g}_i \;=\; \big\langle \mathbf{T}_r\,\mathbf{x}^0_i \big\rangle_{r\in R_i} \;=\; \mathbf{T}_i\,\mathbf{x}^0_i .
\qquad\text{[reconstructed]}
$$

Multiplying and summing vectors region by region as in (1) would cost $O(w^3 n)$ for $n$ nodes. FLSM avoids this by exploiting the redundant summations on a lattice, which makes the total linear in the number of nodes. Its *fast-summation operator*

$$
\mathbf{F}_{i\in R_r}\{\mathbf{v}_i\} \;\equiv\; \sum_{i\in R_r}\mathbf{v}_i \tag{4}
$$

denotes summing a quantity $\mathbf{v}_i$ over a region $R_r$. In essence it takes three recursive passes over all simulation nodes, one per lattice axis. It is used to compute both the region transforms and the node goals. The octree algorithm follows the same steps but replaces $\mathbf{F}$ with a hierarchical operator that works on adaptive discretizations (§4.3).

### 3.3. Limitations of the Lattice Setting

FLSM adds DOFs and smooths the deformation compared with [MHTG05]. The regular lattice still causes important limitations:

- **Small features blow up the cost.** A small surface feature may need fine sampling to move independently of nearby material. A uniform lattice must then be fine everywhere, so cost grows cubically with lattice resolution. Figure 1 shows adaptive sampling resolving thin features that FLSM cannot afford.
- **Stiffness is global.** Mechanical stiffness depends on the region half-width $w$, and FLSM uses one $w$ for the whole object. A varying $w$ would break the regularity FLSM depends on. Figure 4 shows non-uniform material in the octree setting.
- **Restructuring is expensive.** Topological changes force costly dynamic restructuring. Fast summation gets intricate where the lattice is irregular, e.g. near boundaries, where each node needs several sums. [RJ07] did show fracture, but the sum definitions are normally built as a preprocess and are expensive to rebuild at runtime.

---

## 4. Octree Shape Matching

This section presents the new deformation method, octree shape matching.

### 4.1. Adaptive Octree Sampling

Instead of [RJ07]'s uniform lattice, the object is sampled with an octree. The octree gives a framework for adaptively discretizing the shape-matching model. As shown below, it also supports a hierarchical fast-summation operator, in which a high octree node stores the sum over all its leaves. Where possible, those high-level sums are reused without visiting the subtrees.

Construction:

1. Build a very coarse cubic lattice, the **base lattice**, that encloses the object's surface. The maximum desired stiffness sets its resolution; Figure 1's example uses 28 base-lattice nodes.
2. Subdivide the lattice as an octree according to a user-defined criterion. One option is to subdivide until all surface features above a given size are resolved (Figure 1). Subdivision can also happen at runtime, e.g. driven by user interaction (Figure 6) or view-dependent LOD selection.
3. Put a **simulation node** at the center of every leaf cell. Put a **virtual node** at the center of every non-leaf cell. A virtual node stores the sums over all its descendant simulation nodes.
4. Give each simulation node a mass from its cell volume and the material density.

### 4.2. Interval-Based Shape Matching Regions

FLSM relies on lattice regularity to keep brute-force shape matching from costing time proportional to region size. The octree replaces that with an **interval-based region definition**. Together with the octree, it guarantees that every summation touches only $O(1)$ summands.

Take a simulation node $n_i$ with tentative region width $w_i$. Its region $R_i$ is defined as follows:

- a node $n_j$ closer than $w_i$ to $n_i$ **belongs** to $R_i$;
- a node farther than $(1+\varepsilon)\,w_i$ **does not belong**;
- a node in the band $[\,w_i,\;(1+\varepsilon)w_i\,]$ **may or may not** belong.

This resembles the $(1+\varepsilon)$-spanners of [GGN06]. Region width relates to local mechanical stiffness, so the interval rule effectively allows a small variance in the actual stiffness.

Regions are built hierarchically. Each region $R_i$ is represented by a set of **summation nodes**, which can be simulation or virtual nodes. A virtual node already holds the summed values of all its descendant leaves, so making it a summation node avoids visiting those leaves.

```text
BuildRegion(n_i, w_i, eps):
  1. for every octree node n_j:
       [a_j, b_j] := [min, max] distance from n_i over all leaves below n_j
  2. traverse the octree top-down; at node n_j:
       if a_j > w_i:               discard n_j and its whole subtree
       else if b_j < (1+eps)*w_i:  add n_j to R_i as a summation node (stop descending)
       else:                       recurse into the children of n_j
  3. enforce symmetry:  n_i ∈ R_j  <=>  n_j ∈ R_i
```

Figure 2 shows an example where the summation nodes sit at two different levels. For some minimum $\varepsilon$, the number of summation nodes in every region is bounded by a chosen constant. In practice $\varepsilon = 0.5$, which gives on average **6 summation nodes per region** for the adaptive model of Figure 1. The region definition does not depend on the distance metric or on how node distances are computed. §6 describes the efficient distance computation actually used.

> Figure 2: Hierarchical sampling of an object. (a) Distance intervals of $n_i$ and of virtual nodes, in the max-norm. Virtual node $n_b$ stores the interval $[0,1]$ and becomes a summation node of $n_i$. $n_a$ stores $[2,3]$ and is discarded. $n_c$ stores $[1,2]$ and is refined (its children are examined). (b) In red, the summation nodes of the region $R_i$ that belongs to $n_i$.

### 4.3. Hierarchical Fast Summation

With $O(1)$ summation nodes per region, a linear-cost **Hierarchical Fast-Summation** operator can be defined:

$$
\mathbf{HF}_{i\in R_r}\{\mathbf{v}_i\} \;\equiv\; \sum_{i\in R_r}\mathbf{v}_i \tag{5}
$$

It has two steps:

1. **Depth summation.** In every octree, accumulate $\mathbf{v}_i$ bottom-up so each virtual node holds the sum of its children.
2. **Breadth summation.** For every region, add up the already-available values of its summation nodes.

For $n$ simulation nodes, depth summation costs $O(n)$ if the octrees are roughly balanced. Breadth summation costs $O(n)$ because each region has a bounded number of summation nodes. The total is therefore linear.

As FLSM uses $\mathbf{F}$, the octree method uses $\mathbf{HF}$ to compute the region quantities $\mathbf{c}_r$ and $\mathbf{A}_r$ and the node goals $\mathbf{g}_i$. The one change from FLSM is the blend: each region's transform is **weighted by the mass $m_r$ of the region's own node**, and the sum is normalized by the summed mass $M_i$, which can be precomputed. The full step:

1. Per-region translation:
$$
\mathbf{c}_r \;=\; \frac{1}{M_r}\,\mathbf{HF}_{i\in R_r}\{\,m_i\,\mathbf{x}_i\,\} \tag{6}
$$
2. Per-region linear transform:
$$
\mathbf{A}_r \;=\; \mathbf{HF}_{i\in R_r}\{\,m_i\,\mathbf{x}_i\,\mathbf{x}^{0T}_i\,\} \;-\; M_r\,\mathbf{c}_r\,\mathbf{c}^{0T}_r \tag{7}
$$
3. Polar-decompose to get $\mathbf{R}_r$, then assemble the rigid transform $\mathbf{T}_r$.
4. Per-node goal:
$$
\mathbf{g}_i \;=\; \frac{1}{M_i}\,\mathbf{HF}_{r\in R_i}\{\,m_r\,\mathbf{T}_r\,\}\;\mathbf{x}^0_i \tag{8}
$$
5. Integrate with (2) and (3).

Here $M_r = \sum_{i\in R_r} m_i$. `[reconstructed]` The text layer drops symbols in (6)–(8). The forms above are the only ones consistent with the stated mass weighting and with (1). In (8), $M_i = \sum_{r\in R_i} m_r$.

Octree shape matching therefore has FLSM's algorithmic structure and linear cost. In addition it supports adaptive sampling, and so can simulate much thinner features for less total cost. The damping scheme of [RJ07] also works unchanged with $\mathbf{HF}$.

---

## 5. Dynamic Resampling

When the topology changes, or when new LODs are switched on or off locally, the object has to be resampled and the summation nodes of the affected regions recomputed. This section gives a general, robust and efficient resampling algorithm for the octree setting. It assumes some way to compute distances between pairs of nodes exists. The authors' method (§6) uses a visibility graph, and graph updates are mentioned along the way.

> Figure 3: A hanging liver model is cut interactively. Shape-matching regions are recomputed efficiently and self-collisions are handled interactively. The model starts with 500 nodes and ends with 1 550.

### 5.1. Topological Changes

Let $N_{update}$ be the set of nodes whose regions must be updated or built from scratch, i.e. whose summation nodes must be identified. A topological change is detected when an edge $e(n_i, n_j)$ of the visibility graph is cut. $N_{update}$ then contains the simulation nodes $n_i$ and $n_j$, plus every other simulation node whose region includes $n_i$ or $n_j$.

### 5.2. Dynamic LOD Updates

- **Refine** a simulation node $n_i$: subdivide its cell according to user-defined criteria and create a node for each new cell. All new leaves become simulation nodes. $n_i$ becomes virtual and its region is deleted.
- **Coarsen** a set of sibling simulation nodes $\{n_i\}$: remove them from the tree and make their parent a simulation node.

In both cases, $N_{update}$ is the newly created simulation nodes plus every node $n_j$ whose region $R_j$ contains a removed node. The visibility graph is updated by deleting edges incident on removed nodes and adding visibility edges for new ones (§6.1).

### 5.3. Updating Shape Matching Regions

Once $N_{update}$ is known, after an LOD update or a topological change, the summation nodes are recomputed. For each $n_i \in N_{update}$:

```text
UpdateRegion(n_i):
  1. recompute distances from n_i to the other simulation nodes;
     stop at (1+eps)*w_i, since farther nodes are never needed
     -- this step takes >80% of the summation-node rebuild time
  2. compute distance intervals [a_j, b_j] of virtual nodes bottom-up
  3. traverse the octrees top-down and choose summation nodes from the intervals;
     after a topological change, rest-state distances can only grow
     (a cut never shortens a path), so the traversal may start at
     n_i's previous summation nodes instead of at the roots
  4. recompute the region constants c^0_r and M_r
```

---

## 6. Efficient Distance Computation

This section explains how distances between simulation nodes are computed. Nodes are joined by a **visibility graph**, and distance is defined as the shortest path along the graph, as in [SOG06]. Below: graph initialization, then a new bucket-based version of Moore's shortest-path algorithm [Moo59].

### 6.1. Graph Initialization

After the object is sampled (§4.1), a visibility graph is built as in [SOG06]. If $n_i$ sits at an octree level where nodes are spaced $d_i$ apart, it gets edges to every other simulation node within distance $d_i$. Duplicate edges are then removed. So are edges that cross the surface in concave regions, so that material discontinuities are respected. The implementation uses the $\ell^\infty$ (max-norm) metric. Figure 1-d draws the graph edges.

### 6.2. Bucket-Moore Algorithm

With the graph built, shortest-path distances are needed to define summation nodes (§4.2). The authors found an adaptation of Moore's algorithm [Moo59] fastest. Moore's algorithm targets regular grids with unit-length edges, and they preferred it to general solvers such as Dijkstra or Floyd–Warshall [CLR90] and to adapted versions [SOG06]. Moore's algorithm is a breadth-first search from a source $n_0$. It keeps two buckets: $B_0$ holds the current BFS front and $B_1$ the next. It visits the nodes in $B_0$ and puts their unvisited neighbors into $B_1$. When $B_0$ is empty, $B_1$ moves into $B_0$ and the integer distance increases by one. A node's distance is fixed when it is removed from $B_0$. Moore's algorithm finds all pairwise distances below $D_{max}$ in $O(mn)$, where $n$ is the node count and $m$ the average number of nodes within $D_{max}$.

> Figure 4: A hand deformed with varying mechanical stiffness: the pinky is soft, the thumb is hard. The framework handles shape-matching regions of varying width efficiently.

> Figure 5: A block under collisions and plastic deformation. Both are incorporated efficiently into the hierarchical fast summation.

Under the max-norm, edge lengths can be quantized to integers: an edge between two adjacent nodes at the finest octree level has length 1. Region widths $w_i$ and $(1+\varepsilon)w_i$ are rounded to integers the same way. The paper then proposes a bucket-based Moore variant for graphs whose edge lengths are integers in a small range $[1, d_{max}]$. It still runs in $O(mn)$, with somewhat larger constants. It keeps $d_{max}+1$ buckets and always works on bucket $B_0$. When $n_i$ leaves $B_0$, a neighbor $n_j$ at edge length $d$ can be put into bucket $B_d$. When $B_0$ empties, every bucket shifts down, $B_d \leftarrow B_{d+1}$. A visited node holds a tentative minimum distance that may still decrease later.

```text
BucketMoore(n0, Dmax):                      # distances from n0 to all nodes closer than Dmax
  1. k := 0
     for all nodes: unmark, dmin := ∞
     put n0 in B[0]
  2. while B[0] not empty:
       n_i := pop front of B[0]
       if n_i is marked: discard; continue
       mark n_i
       for each neighbor n_j of n_i:
         d := k + len(n_i, n_j)
         if d >= n_j.dmin or d >= Dmax: discard n_j
         else: n_j.dmin := d;  push n_j into B[len(n_i, n_j)]
  3. k := k + 1
     shift buckets: B[d] := B[d+1] for all d;  B[dmax] := {}
  4. if k < Dmax and some bucket is non-empty: goto 2
```

---

## 7. Implementation and Results

All experiments ran on a **3.4 GHz Pentium 4 PC with 1 GB RAM**. The section covers effects the approach enables, implementation details of several features, and a performance and feature comparison with FLSM [RJ07].

**Surface animation.** The surface moves by interpolating the deformation fields of nearby simulation nodes, similar to [MKN\*04]. This runs on the CPU, although the GPU approach of [RJ07] would also work. To find nearby nodes quickly after topological changes, the visibility graph is augmented as in [SOG06].

**Comparison with FLSM — performance, adaptivity and inhomogeneity.** Figure 1 compares FLSM with octree shape matching:

| Configuration (Figure 1 hand) | Nodes | Frame rate | Implied time/frame | Implied time/node |
|---|---:|---:|---:|---:|
| FLSM, regular lattice (authors' implementation) | 35 000 | 2.5 fps | 400 ms | ≈ 11.4 µs |
| FLSM, as optimized in [RJ07] (per personal communication) | 35 000 | ≈ 10 fps | ≈ 100 ms | ≈ 2.9 µs |
| Octree method on the same regular sampling (no octree) | 35 000 | 4.6 fps | ≈ 217 ms | ≈ 6.2 µs |
| Octree method, adaptive sampling | 661 | 222 fps | ≈ 4.5 ms | ≈ 6.8 µs |

*(The last two columns are derived here from the reported fps and node counts; the paper reports only nodes and fps.)*

Fast summation/shape matching, polar decompositions and damping **each take about one third** of total time, and the other examples split time similarly. The authors' timings for both FLSM and their method have no low-level code optimization. The [RJ07] timings did include such optimizations, which is how FLSM would reach about 10 fps. The real strength of the method is adaptive sampling. In the adaptive model, surface resolution stays as high as before where needed, while the interior is much coarser. That model has 661 nodes and runs at 222 fps, almost two orders of magnitude faster than the resolution FLSM needs for the surface features. In this example the adaptive sampling is a one-off preprocess, so neither dynamic resampling nor the fast distance computation is used. Any other way of computing distances and choosing summation nodes would also work here.

Figure 4 shows a hand whose fingers each have a different stiffness (see the video). The non-uniform material comes from varying the region width $w$. The octree framework allows this naturally; FLSM's regularity requirement does not.

**Plasticity.** Figure 5 shows plastic behavior of a block under collisions, obtained by adapting the plasticity model of [MHTG05]. In that model each cluster stores a plastic deformation matrix $\mathbf{S}_r$. The octree method adopts it by changing how the region transforms $\mathbf{A}_r$ and $\mathbf{A}_{qq}$ are computed (see §3.1 and §4.3):

$$
\mathbf{A}_r \;=\; \Big(\mathbf{HF}_{i\in R_r}\{\,m_i\,\mathbf{x}_i\,\mathbf{x}^{0T}_i\,\} \;-\; M_r\,\mathbf{c}_r\,\mathbf{c}^{0T}_r\Big)\,\mathbf{S}^{T}_r \tag{9}
$$
$$
\mathbf{A}_{qq} \;=\; \Big[\;\mathbf{S}_r\Big(\mathbf{HF}_{i\in R_r}\{\,m_i\,\mathbf{x}^0_i\,\mathbf{x}^{0T}_i\,\} \;-\; M_r\,\mathbf{c}^0_r\,\mathbf{c}^{0T}_r\Big)\mathbf{S}^{T}_r\;\Big]^{-1} \tag{10}
$$

$\mathbf{A}_{qq}$ must be recomputed whenever $\mathbf{S}_r$ or the region changes. $\mathbf{S}_r$ also enters the region transform:

$$
\mathbf{T}_r \;=\; \big[\;\mathbf{R}_r\mathbf{S}_r \;\;\; \mathbf{c}_r - \mathbf{R}_r\mathbf{S}_r\,\mathbf{c}^0_r\;\big].
$$

`[reconstructed]` The bracket placement in (9)–(10) is rebuilt from a fragmentary text layer. Algebraically, (9) is $\sum m_i\mathbf{p}_i(\mathbf{S}_r\mathbf{q}_i)^T$ and (10) is $\big(\sum m_i(\mathbf{S}_r\mathbf{q}_i)(\mathbf{S}_r\mathbf{q}_i)^T\big)^{-1}$, i.e. shape matching against the plastically deformed rest offsets $\mathbf{S}_r\mathbf{q}_i$ as in [MHTG05]. The paper does not restate the yield/creep/clamp rule for updating $\mathbf{S}_r$. It defers to [MHTG05].

**Topology changes.** Figure 3 shows a liver being cut interactively. It starts with 500 nodes and ends with 1 550. While cutting, the method updates the visibility graph, resamples simulation nodes and recomputes summation nodes (§5). New surfaces are generated with the approach of [SOG06]. Simulation including collision handling takes **3.7–15.5 ms per frame**. Resampling takes **62–124 ms**.

**(Self-)collision handling.** Figure 3 also shows interactive self-collision handling between cut surfaces. The shortest-path data from §6 is reused to make collisions and self-collisions cheap:

- an approximate distance field inside the object is built by a simple flood fill seeded at simulation nodes near the surface;
- octree leaf cells are moved with the transforms of their simulation nodes and tested against other nodes using spatial hashing [THM\*03];
- the approximate distance field supplies penetration depth, which drives repulsive forces.

**Dynamic LOD selection.** Figure 6 shows 40 deformable flowers moving in the wind. Seen from far away, each flower has 142 simulation nodes, and the whole simulation runs at **20 fps**. When the user touches a flower, its sampling is refined dynamically to resolve the surface detail and let the petals move independently. FLSM would need an explosion of nodes to resolve the thin petals. With dynamic LOD, the total node count grows by only **6 %**, so the scene stays interactive. LOD updates are fast: three simultaneous refinement levels near the petals (**352 new nodes**) took **121 ms**. These timings exclude surface animation and rendering, which cost **4 ms per flower**.

> Figure 6: A complex scene with 40 deforming flowers, 5 680 nodes in total. Coarse sampling is used while the wind moves the flowers. Flowers the user touches are refined dynamically (left image). The dynamic adaptive sampling keeps the scene interactive (20 fps) at feature-level detail.

| Scene | Nodes | Reported time | Notes |
|---|---:|---|---|
| Hand, adaptive (Fig. 1) | 661 | 222 fps | static adaptive sampling (preprocess) |
| Hand, regular sampling (Fig. 1) | 35 000 | 4.6 fps (octree method), 2.5 fps (FLSM) | ≈ 10 fps for optimized FLSM |
| Liver cut (Fig. 3) | 500 → 1 550 | 3.7–15.5 ms/frame incl. collisions; resample 62–124 ms per event | topology changes |
| Flowers (Fig. 6) | 40 × 142 = 5 680 (+6 % on refine) | 20 fps; LOD update 121 ms for 352 new nodes (3 levels) | surface + render 4 ms/flower extra |

---

## 8. Limitations and Future Work

The paper presents a shape-matching deformation algorithm with (dynamic) adaptive sampling. It keeps the robustness and efficiency of other shape-matching models and adds interactive topological changes and dynamic LOD selection. It suits applications that favor plausibility, robustness and efficiency, such as games and surgical simulation.

Limitations:

- Like other geometric deformation methods, it lacks physical fidelity, and its behavior is hard to tune from measurable material parameters. Unlike earlier shape-matching methods, though, it does allow local control of stiffness.
- Topological changes are much cheaper than in earlier shape-matching approaches. Still, only a limited number of regions can be updated per frame at interactive rates. The same holds for dynamic LOD: very drastic LOD changes can stall the method. The authors note that every dynamically adaptive technique shares this limit.
- The model requires a volumetric sampling, so it cannot be applied directly to shells or rods. Shape-matching models for such objects are left as future work.

---

## Acknowledgements

The authors thank the anonymous reviewers, the Computer Graphics Lab in Zürich, and Alec Rivers and Doug James for helpful comments. The work was supported in part by the NCCR Co-Me of the Swiss National Science Foundation.

---

## References

- **[BJ05]** Barbič, James — Real-time subspace integration for St. Venant-Kirchhoff deformable models. SIGGRAPH 2005.
- **[BLG94]** Belytschko, Lu, Gu — Element-free Galerkin methods. Int. J. Numer. Methods Eng. 37, 1994.
- **[BNC96]** Bro-Nielsen, Cotin — Real-time volumetric deformable models for surgery simulation using finite elements and condensation. CGF 15(3), 1996.
- **[BPGK06]** Botsch, Pauly, Gross, Kobbelt — PriMo: Coupled prisms for intuitive surface modeling. SGP 2006.
- **[BPWG07]** Botsch, Pauly, Wicke, Gross — Adaptive space deformations based on rigid cells. Eurographics 2007.
- **[CGC\*02a]** Capell, Green, Curless, Duchamp, Popović — Interactive skeleton-driven dynamic deformations. SIGGRAPH 2002.
- **[CGC\*02b]** Capell, Green, Curless, Duchamp, Popović — A multiresolution framework for dynamic deformations. SCA 2002.
- **[CLR90]** Cormen, Leiserson, Rivest — Introduction to Algorithms, 2nd ed. MIT Press 1990.
- **[DDCB01]** Debunne, Desbrun, Cani, Barr — Dynamic real-time deformations using space and time adaptive sampling. SIGGRAPH 2001.
- **[GGN06]** Gao, Guibas, Nguyen — Deformable spanners and its applications. Comput. Geom. 35(1), 2006.
- **[GKS02]** Grinspun, Krysl, Schröder — CHARMS: A simple framework for adaptive simulation. SIGGRAPH 2002.
- **[GM97]** Gibson, Mirtich — A survey of deformable modeling in computer graphics. MERL TR, 1997.
- **[JP99]** James, Pai — ArtDefo: Accurate real-time deformable objects. SIGGRAPH 1999.
- **[JP02]** James, Pai — DyRT: Dynamic response textures for real-time deformation simulation with graphics hardware. SIGGRAPH 2002.
- **[MDM\*02]** Müller, Dorsey, McMillan, Jagnow, Cutler — Stable real-time deformations. SCA 2002.
- **[MHHR06]** Müller, Heidelberger, Hennix, Ratcliff — Position based dynamics. VRIPhys 2006.
- **[MHTG05]** Müller, Heidelberger, Teschner, Gross — Meshless deformations based on shape matching. SIGGRAPH 2005.
- **[MKN\*04]** Müller, Keiser, Nealen, Pauly, Gross, Alexa — Point-based animation of elastic, plastic, and melting objects. SCA 2004.
- **[Moo59]** Moore — The shortest path through a maze. Annals of the Harvard Computation Laboratory 30, 1959, 285–292.
- **[NMK\*05]** Nealen, Müller, Keiser, Boxerman, Carlson — Physically based deformable models in computer graphics. Eurographics STAR 2005.
- **[OGRG06]** Otaduy, Germann, Redon, Gross — Adaptive deformations with fast tight bounds. SCA 2006.
- **[PKA\*05]** Pauly, Keiser, Adams, Dutré, Gross, Guibas — Meshless animation of fracturing solids. SIGGRAPH 2005.
- **[PW89]** Pentland, Williams — Good vibrations: Modal dynamics for graphics and animation. SIGGRAPH 1989.
- **[RJ07]** Rivers, James — FastLSM: Fast lattice shape matching for robust real-time deformation. SIGGRAPH 2007.
- **[SOG06]** Steinemann, Otaduy, Gross — Fast arbitrary splitting of deforming objects. SCA 2006.
- **[THM\*03]** Teschner, Heidelberger, Müller, Pomeranets, Gross — Optimized spatial hashing for collision detection of deformable objects. VMV 2003.
- **[THMG04]** Teschner, Heidelberger, Müller, Gross — A versatile and robust model for geometrically complex deformable solids. CGI 2004.
- **[TPBF87]** Terzopoulos, Platt, Barr, Fleischer — Elastically deformable models. SIGGRAPH 1987.
