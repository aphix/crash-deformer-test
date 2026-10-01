# Strain Based Dynamics

**Matthias Müller, Nuttapong Chentanez, Tae-Yong Kim, Miles Macklin** — NVIDIA
*Eurographics / ACM SIGGRAPH Symposium on Computer Animation (SCA) 2014*, eds. Vladlen Koltun and Eftychios Sifakis.

> Rewrite note: prose below is a paraphrased, condensed rewrite in section order; equations, parameters and captions are preserved in meaning. Equations damaged by PDF extraction were rebuilt from the surrounding text and are marked `[reconstructed]`.

> Figure 1: Left to right — a tight skirt in its bind pose; the same skirt failing in a pose far from the bind pose; lowering overall stiffness makes the dress sag; lowering stiffness only along the horizontal direction (anisotropically) fixes it.

## Abstract

The paper adds a family of Position Based Dynamics (PBD) constraints that control strain along directions chosen independently of the mesh edges. Rather than constraining point-to-point distances, each constraint targets one entry of the Green–St Venant strain tensor. Giving each strain entry its own stiffness yields anisotropic materials. Because Green strain is rotation invariant, no polar decomposition of the deformation gradient is needed (unlike most strain-limiting methods). Two refinements are proposed: the diagonal (stretch) constraints are rewritten so a single projection step solves them, and the off-diagonal (shear) constraints are normalized so shear and stretch resistance decouple. Since everything lives inside PBD, the constraints both *simulate* the body and *limit* its strain, whereas classical strain limiting must be bolted onto a separate solver.

*CCS: I.3.5 Computational Geometry and Object Modeling — Physically Based Modeling; I.3.7 Three-Dimensional Graphics and Realism — Animation and Virtual Reality.*

## 1. Introduction

PBD [MHR06] is widely used for cloth and soft bodies in games and film because it is simple, fast and robust. Meshes are normally simulated with edge-length and bending-angle constraints, which only control strain *along edges* — the same limitation mass–spring systems have. FEM removes this dependence and lets stiffness be specified in arbitrary directions. The goal here is the PBD analogue: constrain the entries of the Green–St Venant strain tensor computed from deformed particle positions. Unlike FEM, which turns strain into stress, energy and forces, the method derives positional constraints directly, one per strain-tensor entry.

Direction-specific strain control is motivated by:

- **Cloth anisotropy.** Real fabric differs in warp and weft stiffness and has low shear resistance. Artists also often animate clothing frames that stretch it more than the bind pose allows; enforcing the bind pose then causes collision trouble (Fig. 1). Softening stiffness only horizontally fixes this. Edge constraints can approximate it only on triangulations aligned with warp/weft, which characters rarely have, and diagonal edges in regular meshes still couple modes that should be independent.
- **Skin sliding.** A tetrahedral skin layer can slide over a character by lowering shear resistance along the surface (Fig. 5).
- **Locking.** Fully constraining every edge of a triangle mesh stops it from bending in general directions. English et al. [EB08] used non-conforming triangles (requiring a second mesh for collision); Goldenthal et al. [GHF07] constrained only edges of regular quad meshes. Here the same effect is obtained on arbitrary triangle meshes by reducing only shear stiffness.

Contributions:

- PBD constraints derived from strain-tensor entries for simulating deformable objects.
- Using Green's rotation-invariant strain instead of Cauchy strain plus a polar decomposition.
- A reformulated diagonal constraint solvable in one step.
- A reformulated off-diagonal constraint that decouples stretch from shear resistance.

## 2. Related Work

Since PBD [MHR06] appeared it has been extended many times: Kubiak et al. [KPGF07] for surgical threads; Müller [Mül08] hierarchical PBD for high-resolution meshes; Kelager et al. [KNE10] a new triangle-mesh bending model; Diziol et al. [DBB11] a new volume-conservation constraint; Kim et al. [KCMF12] and Müller et al. [MKC12] fast inextensibility for 1D rods (hair, fur). Bender et al. [BMOT13] survey position-based methods.

Baraff and Witkin [BW98] used strain components for force-based cloth; this paper generalizes that idea to cloth and tetrahedra inside PBD.

Strain limiting in force-based simulators is close to PBD: positions or velocities are edited after each force step. The difference is that strain limiting activates only on over-stretch, while here strain components drive the whole simulation (though the method could also serve as a strain limiter in a force-based setting). Provot [Pro95] and Bridson et al. [BMF03] limited spring lengths in mass–spring cloth; Hong et al. [HCJ05] used an implicit formulation for larger steps; Goldenthal et al. [GHF07] used a global solver to upper-bound edge lengths of regular quad meshes. In FEM, Picinbono et al. [PDA03] limited strain anisotropically via an energy penalty; Perez et al. [PCH13] used Lagrange multipliers for isotropic strain constraints, extended to anisotropy by Hernandez et al. [HCPO13].

The closest works are Thomaszewski et al. [TPS09] and Wang et al. [WOR10], which also work per element with Gauss–Seidel or Jacobi iterations:

- **Wang et al. [WOR10]** limit strain isotropically (extending Tsiknis [Tsi06]): they polar-decompose the element's deformation gradient, clamp principal strains, rebuild a clamped gradient and use it to reshape the element's rest shape into a target. This paper instead computes a separate correction vector per stretch/shear mode and combines them with different weights to obtain anisotropy.
- **Thomaszewski et al. [TPS09]** use Cauchy (linear) strain and extract rotation via polar decomposition. Linear strain depends linearly on vertex velocities, so prescribing the strain components gives a $6\times 6$ system for the $3\times 2$ velocity components of a triangle, solved per element in addition to the polar decomposition; it can be accelerated by precomputing the inverse of a $5\times5$ sub-block (25 floats per triangle). For tetrahedra the system grows to $12\times12$, whereas in this method tetrahedra cost little more than triangles. Both methods treat attachments separately; in [TPS09] the system becomes over-constrained and must be solved by least squares, whereas in PBD a particle is attached by setting its inverse mass to zero.

## 3. Method

The new strain-based constraints replace the usual distance constraints. PBD basics are recapped first.

### 3.1 Basic PBD

There are $N$ particles with positions $\mathbf x_i$, velocities $\mathbf v_i$ and inverse masses $w_i$. The main loop:

```text
initialize x_i and v_i
while simulating do
    v_i <- v_i + Δt · w_i · f(x_i)          // external forces
    p_i <- x_i + Δt · v_i                   // predicted positions (explicit Euler)
    solve(p_1, ..., p_N)                    // project constraints C_j
    v_i <- (p_i - x_i) / Δt
    x_i <- p_i
end
```

After the velocity update, predicted positions $\mathbf p_i$ are obtained by an explicit Euler step and then modified by a solver to satisfy positional constraints $C_j$. A constraint is a scalar function $C(\mathbf p_1,\dots,\mathbf p_N)$ that vanishes when satisfied. The solver sweeps all constraints several times, Gauss–Seidel style, to handle the non-linear system. For one constraint the correction of particle $i$ is

$$\Delta\mathbf p_i = -s\,k\,w_i\,\nabla_{\mathbf p_i} C(\mathbf p_1,\dots,\mathbf p_N) \tag{1}$$

$$s = \frac{C(\mathbf p_1,\dots,\mathbf p_N)}{\sum_j w_j\,\lvert\nabla_{\mathbf p_j} C(\mathbf p_1,\dots,\mathbf p_N)\rvert^2} \tag{2}$$

with stiffness $k\in[0,1]$. $k$ is not a physical stiffness — its effect depends on time step and iteration count — but games usually fix both, so it is an intuitive tuning knob. These formulas come from linearizing the constraint at the current configuration; re-linearizing before every projection (instead of fixing it as global solvers do) is a big part of PBD's robustness. After solving, velocities and positions are updated from the corrected predictions.

Example: the distance constraint $C(\mathbf x_1,\mathbf x_2)=\lvert\mathbf x_1-\mathbf x_2\rvert-d$ plugged into Eqs. (1)–(2) gives the familiar corrections

$$\Delta\mathbf p_1 = -\frac{w_1}{w_1+w_2}\left(\lvert\mathbf p_1-\mathbf p_2\rvert-d\right)\frac{\mathbf p_1-\mathbf p_2}{\lvert\mathbf p_1-\mathbf p_2\rvert} \tag{3}$$

$$\Delta\mathbf p_2 = +\frac{w_2}{w_1+w_2}\left(\lvert\mathbf p_1-\mathbf p_2\rvert-d\right)\frac{\mathbf p_1-\mathbf p_2}{\lvert\mathbf p_1-\mathbf p_2\rvert} \tag{4}$$

### 3.2 Tetrahedral Constraints

The idea works for both triangles and tetrahedra; start with one tetrahedron. Instead of six edge constraints on pairwise distances, define constraints over all four particles that drive the strain components to prescribed values. Let $\mathbf q_0,\dots,\mathbf q_3$ be the material (rest) positions and $\mathbf p_0,\dots,\mathbf p_3$ the world positions. Translation does not create strain, so take $\mathbf q_0=\mathbf p_0=\mathbf 0$ (i.e. work with offsets from vertex 0). With

$$\mathbf P = [\mathbf p_1,\mathbf p_2,\mathbf p_3] \tag{5}$$

$$\mathbf Q = [\mathbf q_1,\mathbf q_2,\mathbf q_3] \tag{6}$$

the deformation gradient is

$$\mathbf F = \mathbf P\,\mathbf Q^{-1} \tag{7}$$

and the Green–St Venant strain tensor is

$$\mathbf G = \mathbf F^T\mathbf F - \mathbf I \tag{8}$$

(the usual factor $\tfrac12$ is dropped because it cancels in the constraint formulation). $\mathbf Q^{-1}$ is constant and precomputed. Diagonal entries $G_{ii}$ are stretches and off-diagonal $G_{ij}=G_{ji}$ shears, both relative to the material frame axes. Six constraints are introduced — three stretch, three shear:

$$C(\mathbf p_0,\mathbf p_1,\mathbf p_2,\mathbf p_3) = S_{ii} - s_i^2 \tag{9}$$

$$C(\mathbf p_0,\mathbf p_1,\mathbf p_2,\mathbf p_3) = S_{ij},\quad i<j \tag{10}$$

where $\mathbf S = \mathbf F^T\mathbf F$ and $s_i$ are rest stretches (usually 1). These pull particles toward zero stretch and zero shear. Giving each constraint its own stiffness $k_{ij}$ yields anisotropic material. Rotation independence is built into Green's tensor, so no rotation needs to be estimated with a polar decomposition, unlike most strain-limiting methods.

> Figure 2: Constraint values and projection vectors for one (white) vertex moved in the plane while the other two triangle vertices are pinned. Columns: x-strain, y-strain, shear (green positive, red negative, clamped). Top row: standard functions $S_{11}-1$, $S_{22}-1$, $S_{12}$. Bottom row: modified functions $\sqrt{S_{11}}-1$, $\sqrt{S_{22}}-1$, $S_{12}/(\lvert\mathbf f_1\rvert\lvert\mathbf f_2\rvert)$. Zero sets are identical, but the modified x/y constraints are solved in one step because their gradient is constant along the projection direction, and the modified shear tilts the projection vectors so shear is decoupled from stretch.

### 3.3 Triangle Constraints

For a triangle $\mathbf P$ and $\mathbf Q$ become non-square (one fewer particle, same spatial dimension), so $\mathbf Q^{-1}$ is undefined. The natural fix is to describe the rest state with 2D texture coordinates; for proper anisotropic cloth these must align with the warp and weft. Then $\mathbf Q\in\mathbb R^{2\times2}$ is invertible and

$$\mathbf S = \mathbf F^T\mathbf F = \mathbf Q^{-T}\mathbf P^T\mathbf P\,\mathbf Q^{-1} \tag{11}$$

holds with $\mathbf S\in\mathbb R^{2\times2}$, $\mathbf Q\in\mathbb R^{2\times2}$ and $\mathbf P\in\mathbb R^{3\times2}$. The strain constraints for both element types are blind to reflections; Section 3.7 deals with that.

### 3.4 The Square Root of Strain

Eq. (9) is the natural definition, but a more stable stretch formulation exists. Consider a distance constraint with rest length $d$; both

$$C(\mathbf p_1,\mathbf p_2) = \lvert\mathbf p_1-\mathbf p_2\rvert - d \tag{12}$$

$$C(\mathbf p_1,\mathbf p_2) = \lvert\mathbf p_1-\mathbf p_2\rvert^2 - d^2 \tag{13}$$

are valid. The first is linear along $\mathbf p_1-\mathbf p_2$, so PBD's linearization solves it exactly in one step; the second, which corresponds to the Green-strain stretch measure, is not. Hence Eq. (9) is replaced by

$$C(\mathbf p_0,\mathbf p_1,\mathbf p_2,\mathbf p_3) = \sqrt{S_{ii}} - s_i \tag{14}$$

Its gradient is constant along the projection direction, so an element's stretch constraint is satisfied by a single projection (bottom images of the first two columns of Fig. 2). Derivations of the corrections are in the Appendix. With the same iteration count, this reduces the remaining relative strain by 25% on average and, more importantly, improves stability by preventing overshoot.

### 3.5 Decoupling Shear from Stretch

The shear function can be written $S_{ij}=\mathbf f_i\cdot\mathbf f_j$, with $\mathbf f_i$ and $\mathbf f_j$ the $i$-th and $j$-th columns of $\mathbf F$. It penalizes the angle between the deformed material axes but *also* their lengths (the principal stretches). To decouple, the shear constraint is normalized:

$$\tilde S_{ij} = \frac{1}{\lvert\mathbf f_i\rvert\,\lvert\mathbf f_j\rvert}\,S_{ij} = \frac{\mathbf f_i\cdot\mathbf f_j}{\lvert\mathbf f_i\rvert\,\lvert\mathbf f_j\rvert} \tag{15}$$

The resulting projections appear in the last column of Fig. 2. Because $\tilde S_{ij}$ is non-linear along the projection direction, overshooting is possible; as a precaution the shear coefficient can be lowered (as in Fig. 2). The authors saw no instabilities from the shear constraints in their experiments.

### 3.6 General Strain Orientation

Eqs. (9) and (10) constrain strain along the global coordinate axes, which is not always wanted. Example: a tetrahedral layer on a character's surface should let skin slide easily tangentially but not along the normal. No change to the formulation is needed — only the rest shape of each tetrahedron is re-expressed. As preprocessing, a local frame is built per tetrahedron (here from the surface tangent and normal at the tetrahedron's location), and the constant rest positions $\mathbf q_0,\dots,\mathbf q_3$ are stored in that frame. Strain axes then follow the local frame.

### 3.7 Volume and Area Conservation

None of the above constraints controls volume (tetrahedra) or area (triangles) by itself; only when all are satisfied simultaneously is $\mathbf G=\mathbf 0$, hence $\det(\mathbf F)=1$, i.e. volume preserved. Separate control is often desirable, e.g. for soft material with strong volume conservation. In PBD this is just one more constraint:

$$C_{volume}(\mathbf p_0,\mathbf p_1,\mathbf p_2,\mathbf p_3) = \det(\mathbf F) - 1 \tag{16}$$

$$C_{area}(\mathbf p_0,\mathbf p_1,\mathbf p_2) = \det(\mathbf F) - 1 \tag{17}$$

for 3D solids and 2D cloth respectively (for triangles "$\det\mathbf F$" means the area ratio; the Appendix gives the explicit area form). The volume version is the volume term of [MHR06]. To support rest stretches other than one:

$$C_{volume}(\mathbf p_0,\mathbf p_1,\mathbf p_2,\mathbf p_3) = \det(\mathbf F) - s_1 s_2 s_3 \tag{18}$$

$$C_{area}(\mathbf p_0,\mathbf p_1,\mathbf p_2) = \det(\mathbf F) - s_1 s_2 \tag{19}$$

This constraint also handles **element inversion** for tetrahedra, since

$$\det(\mathbf F) = 1 \tag{20}$$

$$\Leftrightarrow\ \det(\mathbf P)\,\det(\mathbf Q^{-1}) = 1 \tag{21}$$

$$\Leftrightarrow\ \det(\mathbf P) = \det(\mathbf Q) \tag{22}$$

i.e. the *signed* volume must equal the signed rest volume. The explicit projection (Appendix) shows that an inverted tetrahedron's vertices are pushed back across the base face to the correct side. Inversion is a general FEM problem because forces derive from the (reflection-blind) strain tensor alone; papers such as [ITF04] focus solely on it. The volume term is a simple, effective fix (Fig. 4). However, adding a volume constraint on top of the strain constraints can cause **jitter** from over-constraining when deformation is extreme and both strain and volume stiffnesses are near 1; softening the volume constraint slightly usually cures it.

> Figure 3: Cloth with varied per-component stiffness. Top to bottom, resistance to (x-stretch, y-stretch, shear) is (high, high, high), (high, high, low), (low, high, high). The modes are controlled independently even on a highly irregular triangulation like the one shown.

> Figure 4: Soft-body stiffness variations on a torus. (a)–(d): recovery from a heavily entangled state as volume stiffness is increased. (e): all stiffnesses except volume conservation reduced — the torus deforms heavily but keeps its volume. (f): only volume stiffness and stiffness along the torus's main axis softened. (g): high shear and low stretch resistance — angles barely distort while the shape stretches. (h): the opposite — little stretch, strong bending.

> Figure 5: Skin sliding on an alien bull. Top: linear blend skinning stretches the surface unevenly. Bottom: a simulated tetrahedral surface layer with low tangential shear resistance produces correct skin sliding.

### 3.8 Bending

For cloth, strain is intrinsic and therefore does not affect bending, which is extrinsic; bending is handled separately. As in [MHR06], the dihedral angle between adjacent triangle pairs is constrained, but with simpler derivatives: the gradients of the dihedral angle with respect to the particle positions are exactly the bending modes of a triangle pair given by Bridson et al. [BMF03], including their scaling — a fact not stated in that paper. Only the sign must be flipped depending on the orientation of the triangle pair (Appendix).

### 3.9 Damping

A general PBD damping scheme damps relative velocities only along a constraint's correction mode. Given a constraint's correction $\Delta\mathbf p_1,\dots,\Delta\mathbf p_N$:

$$\mathbf v_i \leftarrow \mathbf v_i - k\left(\sum_{j=1}^{N}\mathbf v_j^T\mathbf n_j\right)\mathbf n_i,\qquad \mathbf n_i = \frac{\Delta\mathbf p_i}{\lvert\Delta\mathbf p\rvert} \tag{23}$$ `[reconstructed]`

where $k\in[0,1]$ is the damping stiffness and $\lvert\Delta\mathbf p\rvert$ the norm of the stacked correction. The sum $\sum_j\mathbf v_j^T\mathbf n_j$ restricts damping to mode $\mathbf n$; for rigid-body motion it cancels (the mode does not change), so no artificial rigid damping is added.

## 4. Results

- **Cloth (Fig. 3):** a rectangular cloth with irregular triangulation; x-stretch, y-stretch and shear stiffness changed one at a time. The expected behaviour appears despite the irregular mesh.
- **Tetrahedral torus (Fig. 4):** locally aligned elements. To show the volume term fixes inversion, the simulation starts from a heavily entangled state; the shape recovers within a few iterations. Varying the per-mode stiffnesses yields various volumetric effects: (e) all but volume stiffness lowered; (f) only volume stiffness and main-axis stiffness lowered; (g) high shear / low stretch resistance — edge lengths deform more than inter-edge angles; (h) the reverse — little stretch, much bending.
- **Timing (Fig. 6):** single thread on a 3 GHz Core i7. Strain-limiting-only cost of [WOR10] could not be isolated (they report limiting + simulation combined). From [TPS09], 5.3 ms per iteration over 3600 triangles on a 2 GHz CPU, divided by 1.5 for the clock difference. SBD is **more than 3× faster than continuum-based strain limiting (CSL)** and **about 30% slower than edge-based dynamics (EBD)**. For tetrahedra the slowdown versus EBD is a little larger: constraints per element go from 3 to 6 in both, but vertices per constraint go from 3 to 4 in SBD while staying at 2 in EBD. CSL was not measured for tetrahedra by [TPS09], but it is expected to be much slower since its per-element system grows to $12\times12$.
- **Bind-pose clothing (Fig. 1):** lowering overall stiffness makes clothes stretchy; lowering only horizontal stiffness solves the fit problem.
- **Skin layer (Fig. 5):** a very soft shear constraint lets skin slide, considerably reducing the uneven stretching of linear blend skinning.

> Figure 6: Time in milliseconds for one iteration over 3600 elements (bar chart, y-axis 0–3.5 ms). Bars: CSL-GS tri, SBD tri, EBD tri, SBD tet, EBD tet, SBD tet + vol, bend. CSL-GS = continuum-based strain limiting with Gauss–Seidel iterations; SBD = Strain Based Dynamics; EBD = Edge Based Dynamics. (Individual bar values are not recoverable from the extracted text; the prose gives ≈3.5 ms for CSL-GS tri after clock scaling, SBD tri > 3× faster, EBD ≈ 30% faster than SBD.)

## 5. Conclusion

The paper simulates deformable objects in PBD by projecting onto deformation modes that correspond to entries of the Green–St Venant strain tensor instead of edge distances. Modifications make the projections more robust and decouple shear from stretch; volume conservation, bending and damping are also covered. The authors see this as a step from game-oriented PBD toward continuum FEM (usually considered too expensive for real time), and hope the simple formulation and explicit Appendix formulas make it easy to adopt in games and film.

## Appendix A: Explicit Formulas for Constraint Projection

Explicit formulas to ease implementation. Recall $\mathbf p_0=\mathbf q_0=\mathbf 0$ (all positions are offsets from vertex 0). Equation numbers in this appendix follow the paper's ordering where legible; extraction of the appendix is heavily damaged, so formulas are rebuilt from the definitions above and marked `[reconstructed]` where the exact printed form could not be read.

### Strain based constraints

Let $\mathbf c_i$ be the columns of $\mathbf Q^{-1}$ and $\mathbf f_i$ the columns of $\mathbf F$:

$$[\mathbf c_1,\mathbf c_2] = \mathbf Q^{-1},\quad [\mathbf f_1,\mathbf f_2]=\mathbf F \qquad\text{(triangles, (24)–(25))}$$

$$[\mathbf c_1,\mathbf c_2,\mathbf c_3] = \mathbf Q^{-1},\quad [\mathbf f_1,\mathbf f_2,\mathbf f_3]=\mathbf F \qquad\text{(tetrahedra, (26)–(27))}$$

The entries of $\mathbf S$ are

$$S_{ij} = \mathbf f_i^T\mathbf f_j = (\mathbf P\mathbf c_i)^T(\mathbf P\mathbf c_j) \tag{28}$$

with $i,j\in\{1,2\}$ for triangles and $\{1,2,3\}$ for tetrahedra. The gradients needed by PBD, writing $c_{ki}$ for the $k$-th component of $\mathbf c_i$:

$$\nabla_{\mathbf p_k} S_{ij} = c_{ki}\,\mathbf f_j + c_{kj}\,\mathbf f_i,\qquad k=1,\dots,d \tag{29–30}$$ `[reconstructed]`

(equivalently, the $3\times d$ matrix $[\nabla_{\mathbf p_1}S_{ij},\dots,\nabla_{\mathbf p_d}S_{ij}] = \mathbf f_j\mathbf c_i^T + \mathbf f_i\mathbf c_j^T$), and by translation invariance

$$\nabla_{\mathbf p_0} S_{ij} = -\sum_{k=1}^{d}\nabla_{\mathbf p_k} S_{ij} \tag{31}$$

with $d=2$ for triangles and $d=3$ for tetrahedra. Following [BMF03] and [MHR06] the particle projections for a constraint $C$ are

$$\Delta\mathbf p_k = -\lambda\,w_k\,\nabla_{\mathbf p_k}C,\qquad \lambda = \frac{k_{ij}\,C}{\sum_l w_l\,\lvert\nabla_{\mathbf p_l}C\rvert^2} \tag{32–35}$$ `[reconstructed]`

where $w_k$ is the inverse mass of particle $k$ and $k_{ij}$ the stiffness of that strain component. For the square-root stretch of Eq. (14), $C=\sqrt{S_{ii}}-s_i$ and $\nabla C = \nabla S_{ii}/(2\sqrt{S_{ii}})$, i.e. $\nabla_{\mathbf p_k}C = c_{ki}\,\mathbf f_i/\lvert\mathbf f_i\rvert$. For the normalized shear of Eq. (15), with $\hat{\mathbf f}=\mathbf f/\lvert\mathbf f\rvert$:

$$\nabla_{\mathbf p_k}\tilde S_{ij} = c_{ki}\,\frac{\hat{\mathbf f}_j - \tilde S_{ij}\hat{\mathbf f}_i}{\lvert\mathbf f_i\rvert} + c_{kj}\,\frac{\hat{\mathbf f}_i - \tilde S_{ij}\hat{\mathbf f}_j}{\lvert\mathbf f_j\rvert} \tag{36}$$ `[reconstructed: derived from Eq. (15); printed form illegible]`

### Material coordinates for a triangle

Texture coordinates $(u_i,v_i)$ cannot serve directly as material coordinates because they may contain stretching. An orthonormal local frame is needed. Given rest world positions $\mathbf x_0,\mathbf x_1,\mathbf x_2\in\mathbb R^3$, compute world-space tangents $\mathbf t_u,\mathbf t_v$ along the $u$ and $v$ texture axes:

$$[\mathbf t_u,\mathbf t_v] = [\mathbf x_1-\mathbf x_0,\ \mathbf x_2-\mathbf x_0]\begin{bmatrix}u_1-u_0 & u_2-u_0\\ v_1-v_0 & v_2-v_0\end{bmatrix}^{-1} \tag{37}$$ `[reconstructed]`

Normalize $\mathbf t_u$; to keep the frame orthogonal, replace $\mathbf t_v$ by the cross product of the triangle normal with $\mathbf t_u$. The material coordinates are then

$$\mathbf q_i = \begin{bmatrix}\mathbf t_u^T\\ \mathbf t_v^T\end{bmatrix}(\mathbf x_i-\mathbf x_0) \tag{38}$$ `[reconstructed]`

### Volume / area conservation constraints

From Eq. (22):

$$C_{volume}(\mathbf p_1,\mathbf p_2,\mathbf p_3) = \det(\mathbf P) - \det(\mathbf Q) = \mathbf p_1\cdot(\mathbf p_2\times\mathbf p_3) - \det(\mathbf Q) \tag{47}$$

$$\nabla_{\mathbf p_1}C_{volume} = \mathbf p_2\times\mathbf p_3,\quad \nabla_{\mathbf p_2}C_{volume} = \mathbf p_3\times\mathbf p_1,\quad \nabla_{\mathbf p_3}C_{volume} = \mathbf p_1\times\mathbf p_2 \tag{48–50}$$

$$\nabla_{\mathbf p_0}C_{volume} = -\left(\nabla_{\mathbf p_1}+\nabla_{\mathbf p_2}+\nabla_{\mathbf p_3}\right)C_{volume} \tag{51}$$

Triangle area preservation (squared form avoids a square root):

$$C_{area}(\mathbf p_1,\mathbf p_2) = \lvert\mathbf p_1\times\mathbf p_2\rvert^2 - \lvert\mathbf q_1\times\mathbf q_2\rvert^2 \tag{53}$$

$$\nabla_{\mathbf p_1}C_{area} = 2\,\mathbf p_2\times(\mathbf p_1\times\mathbf p_2),\quad \nabla_{\mathbf p_2}C_{area} = 2\,(\mathbf p_1\times\mathbf p_2)\times\mathbf p_1,\quad \nabla_{\mathbf p_0}C_{area} = -(\nabla_{\mathbf p_1}+\nabla_{\mathbf p_2})C_{area} \tag{55–57}$$

Projection as before: $\Delta\mathbf p_k = -\lambda\,w_k\,\nabla_{\mathbf p_k}C_{volume(area)}$, $\lambda = k\,C_{volume(area)}/\sum_l w_l\lvert\nabla_{\mathbf p_l}C_{volume(area)}\rvert^2$ (58–60). Because $C_{volume}$ is the *signed* volume difference, an inverted element's gradient points back through the base face.

### Bending constraint

A bending element has particles $\mathbf p_1,\dots,\mathbf p_4$ forming triangles $(\mathbf p_1,\mathbf p_3,\mathbf p_4)$ and $(\mathbf p_2,\mathbf p_4,\mathbf p_3)$ sharing edge $\mathbf e=\mathbf p_4-\mathbf p_3$. With (unnormalized) normals $\mathbf n_1=(\mathbf p_1-\mathbf p_3)\times(\mathbf p_1-\mathbf p_4)$, $\mathbf n_2=(\mathbf p_2-\mathbf p_4)\times(\mathbf p_2-\mathbf p_3)$, the dihedral angle is

$$\varphi = \arccos\!\left(\frac{\mathbf n_1}{\lvert\mathbf n_1\rvert}\cdot\frac{\mathbf n_2}{\lvert\mathbf n_2\rvert}\right) \tag{39}$$ `[reconstructed]`

and its gradients are Bridson et al.'s bending modes:

$$\nabla_{\mathbf p_1}\varphi = \lvert\mathbf e\rvert\frac{\mathbf n_1}{\lvert\mathbf n_1\rvert^2},\qquad \nabla_{\mathbf p_2}\varphi = \lvert\mathbf e\rvert\frac{\mathbf n_2}{\lvert\mathbf n_2\rvert^2}$$

$$\nabla_{\mathbf p_3}\varphi = \frac{(\mathbf p_1-\mathbf p_4)\cdot\mathbf e}{\lvert\mathbf e\rvert}\frac{\mathbf n_1}{\lvert\mathbf n_1\rvert^2} + \frac{(\mathbf p_2-\mathbf p_4)\cdot\mathbf e}{\lvert\mathbf e\rvert}\frac{\mathbf n_2}{\lvert\mathbf n_2\rvert^2},\qquad \nabla_{\mathbf p_4}\varphi = -\frac{(\mathbf p_1-\mathbf p_3)\cdot\mathbf e}{\lvert\mathbf e\rvert}\frac{\mathbf n_1}{\lvert\mathbf n_1\rvert^2} - \frac{(\mathbf p_2-\mathbf p_3)\cdot\mathbf e}{\lvert\mathbf e\rvert}\frac{\mathbf n_2}{\lvert\mathbf n_2\rvert^2}$$ `[reconstructed from BMF03]`

All derivative signs are flipped when $(\mathbf n_1\times\mathbf n_2)\cdot\mathbf e>0$. The projection uses $C=\varphi-\varphi_0$ with the generic $\lambda$ above.

## References

Reference list body omitted. Works relevant to this repo:

- [MHR06] Müller, Heidelberger, Hennix, Ratcliff — *Position Based Dynamics*, VRIPHYS 2006 (base solver; volume constraint).
- [BMF03] Bridson, Marino, Fedkiw — *Simulation of clothing with folds and wrinkles*, SCA 2003 (bending modes, strain limiting).
- [TPS09] Thomaszewski, Pabst, Strasser — *Continuum-based strain limiting*, CGF 28(2) 2009.
- [WOR10] Wang, O'Brien, Ramamoorthi — *Multi-resolution isotropic strain limiting*, SIGGRAPH Asia 2010 (polar decompose + clamp principal strains).
- [ITF04] Irving, Teran, Fedkiw — *Invertible finite elements for robust simulation of large deformation*, SCA 2004.
- [BMOT13] Bender, Müller, Otaduy, Teschner — *Position-based methods for the simulation of solid objects*, EG STAR 2013.
- [Pro95] Provot — *Deformation constraints in a mass-spring model to describe rigid cloth behavior*, GI 1995.
