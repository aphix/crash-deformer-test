# Physically Based Shape Matching

**Authors:** Matthias Müller, Miles Macklin, Nuttapong Chentanez, Stefan Jeschke (NVIDIA)
**Venue:** ACM SIGGRAPH / Eurographics Symposium on Computer Animation (SCA) 2022 — *Computer Graphics Forum* Vol. 41 (2022), No. 8. Guest editors D. L. Michels and S. Pirk.
**Keywords:** finite element method, physically-based animation, elasticity, real-time physics
**CCS concepts:** Computing methodologies → Physical simulation

> Rewrite note: this is a section-by-section paraphrase of the paper, not a verbatim copy. Equations, algorithms, parameter values and figure captions are preserved in meaning. Equations damaged by PDF extraction were rebuilt from context; uncertain ones are marked `[reconstructed]`.

> Figure 1: A lion fish represented by a cut-cell mesh whose cells have arbitrary shapes; the simulation mesh reproduces the input surface exactly. The right-hand, low-resolution version (195 cells) still deforms plausibly.

## Abstract

Shape matching is widely used for interactive deformables because it is stable, simple, and needs no mesh: it operates on arbitrary local groups of particles. Its weakness is that it is a purely geometric construction rather than a discretisation of continuum mechanics, so it is hard to calibrate, and it does not preserve volume (e.g. a squeezed tire does not bulge). The authors propose a meshless method that keeps the flavour of shape matching but is derived from continuous constitutive models, so stiffness and volume preservation are set through physical parameters. When the groups are the elements of a tetrahedral mesh, the method reproduces FEM results exactly.

## 1. Introduction

Deformable-solid simulation has a long history in graphics, with applications such as character flesh and rubbery objects like tires. Many methods are mesh based, i.e. they simulate a volumetric mesh around the object; producing such a mesh is itself hard and is a research field of its own.

Meshless methods sidestep this by sampling the object with particles that are held together by forces or constraints acting within local particle groups. Besides not needing a mesh, they make topology changes easy (include/exclude particles from groups), and after large plastic deformation the object can be resampled and groups rebuilt from particle distances.

Mass–spring networks are the simplest example: particle interactions are springs. They depend on the tessellation, require tuning spring stiffnesses to obtain a desired global behaviour, and — most importantly — cannot recover from inverted configurations. Shape matching [MHTG05] was introduced to fix the inversion problem; as a position-based method it is also unconditionally stable. However it rests on a geometric constraint instead of a discretised continuum model: it does not preserve volume (a stretched object does not thin out sideways), and choosing a parameter that reproduces a target elastic modulus is difficult.

The goal of this work is a method as simple and robust as shape matching but grounded in physics. Like shape matching it uses positional constraints, but these are derived from energy terms of established material models, following Macklin and Müller [MM21]. As in [MM21], XPBD is used as the solver, giving an unconditionally stable method that fits in a few lines of code. [MM21] showed this for Neo-Hookean material; this paper extends the approach to other models, in particular by expressing the Hookean model as a *single* positional constraint.

Allowing an arbitrary number of particles per element creates *zero-energy modes*: particle motions invisible to the energy that lead to ugly artifacts. Kugelstadt et al. [KBFF*21] suppress them with an extra, non-physical stiff penalty energy that is numerically awkward. Here, instead, a projection step akin to shape matching filters these modes out.

Contributions:

- a physically based simulation method that accepts arbitrary particle groups as elements;
- a formulation of the Hookean model as one position-based constraint;
- a simple and stable filter for zero-energy modes.

## 2. Related Work

Deformable solids have been studied in graphics for decades; [NMK*06] surveys work up to 2005 and the underlying principles, and Kim and Eberle's SIGGRAPH course [KE20] is a recent overview. FEM is among the most popular approaches [BWHT07, KMBG08, WJST15], but it requires a consistent volumetric (tetrahedral or hexahedral) mesh — the problem that point-based / meshless methods avoid.

The most popular meshless method in graphics today is the Material Point Method (MPM) [Jia, HFG*18, WCL*20, WDG*19, DHW*19]. It is hybrid: particle quantities are transferred to a regular background grid, equations are solved on the grid, and results are interpolated back to the particles.

Shape matching [MHTG05] is a position-based method; [BMM17] surveys position based dynamics (PBD). Extended PBD (XPBD) [MMC16] adds a physical stiffness that does not depend on time step or iteration count. Macklin and Müller [MM21] expressed continuum models such as stable Neo-Hookean [SGK18] as XPBD constraints; that idea is what this paper uses to make shape matching physically based. Earlier extensions of shape matching — ductile fracture [JML*16], large plasticity via cluster resampling [FJL*17], and [CMM16] — are orthogonal and could build on a physically based variant.

## 3. Method

### 3.1. Constraint Based Formulation

The solver is XPBD. Energies are expressed as compliant constraints, each with a scalar compliance $\alpha$, the inverse of a physical stiffness that is independent of the time step. Setting $\alpha = 0$ models infinitely stiff material stably. Effective stiffness still depends on how far the solver converges, but no ad-hoc stiffness tuning is needed and there are no instabilities at or near the inextensible / incompressible limit. [MM21] showed that a Neo-Hookean material maps exactly onto two positional XPBD constraints; that derivation is restated next to keep the paper self-contained.

### 3.2. Neo-Hookean Model

The Neo-Hookean energy density

$$
\Psi_{\text{Neo}} = \frac{\lambda}{2}\left(\det(\mathbf{F}) - \gamma\right)^2 + \frac{\mu}{2}\left(\operatorname{tr}(\mathbf{F}^T\mathbf{F}) - 3\right) \tag{1}
$$

$$
= \Psi_H + \Psi_D \tag{2}
$$

splits into a hydrostatic part $\Psi_H$ and a deviatoric part $\Psi_D$. Per mesh element they are replaced by two constraints

$$
C_H(\mathbf{F}) = \det(\mathbf{F}) - \gamma \tag{3}
$$

$$
C_D(\mathbf{F}) = \sqrt{\operatorname{tr}(\mathbf{F}^T\mathbf{F})} \tag{4}
$$

with compliances

$$
\alpha_H = \frac{1}{\lambda V_e} \tag{5}
$$

$$
\alpha_D = \frac{1}{\mu V_e}. \tag{6}
$$

$\mathbf{F}$ is the deformation gradient, $\lambda,\mu$ are the Lamé parameters and $V_e$ is the element volume. The classic Neo-Hookean model uses $\gamma = 1$; for rest stability Smith et al. [SGK18] set $\gamma = 1 + \mu/\lambda$.

A constraint function $C$ is zero exactly when the constraint is satisfied. The equivalence follows from the energy that XPBD associates with a compliant constraint:

$$
U(\mathbf{x}) = \frac{1}{2}\,\alpha^{-1}\,C(\mathbf{x})^2 \tag{7}
$$

where $\alpha$ is the inverse stiffness. Inserting (3)–(6) into (7) gives back the Neo-Hookean potentials, minus the constant $-3$ — which does not affect forces. Because $\Psi_{\text{Neo}}$ is a *density* while $U$ is an energy, integrating a per-element-constant $\mathbf{F}$ over the element multiplies by $V_e$, which is why $V_e$ appears in (5) and (6).

### 3.3. Hookean Model

The paper also derives a constraint for a Hookean (St. Venant–Kirchhoff style, Green-strain) material. Bender et al. [BKCW14] gave a PBD constraint for Hooke's law that drives elements to rest, but it is not equivalent to the actual model. Following them, strain is computed from $\mathbf{F}$ with the Green–Lagrange tensor

$$
\boldsymbol{\varepsilon} = \frac{1}{2}\left(\mathbf{F}^T\mathbf{F} - \mathbf{I}\right) \tag{8}
$$

($\mathbf{I}$ the identity). Hooke's law gives the stress

$$
\mathbf{S} = \mathbf{C}\,\boldsymbol{\varepsilon} \tag{9}
$$

with the fourth-order elasticity tensor $\mathbf{C}$, and the elastic energy density is

$$
W = \frac{1}{2}\,\boldsymbol{\varepsilon} : \mathbf{S} = \frac{1}{2}\,\boldsymbol{\varepsilon} : \mathbf{C}\boldsymbol{\varepsilon}, \tag{10}
$$

using $\mathbf{A}:\mathbf{B} = \sum_{i,j} a_{ij} b_{ij}$. Bender et al. use $C_{\text{Hooke}}(\mathbf{F}) = W(\mathbf{F})$ as the constraint (zero at zero energy) and obtain stiffness by PBD's non-physical scaling of the correction vectors. To instead match real forces, one needs the link between Young's modulus $E$ and the XPBD compliance. The key observation is that $E$ factors out of the energy: $W = E\,\hat W$ with $\hat W = W|_{E=1}$ (Appendix 6.1). Defining

$$
C_{\text{Hooke}}(\mathbf{F}) = \sqrt{2\,\hat W(\mathbf{F})} \tag{11}
$$

and

$$
\alpha = \frac{1}{E\,V_e} \tag{12}
$$

reproduces the Hookean model exactly, as substituting into (7) shows: $\tfrac12 E V_e\, 2\hat W = V_e W$. The model is parametrised by Young's modulus and Poisson's ratio; other pairs (e.g. Lamé parameters, as in the Neo-Hookean case) would work, but the authors find $E,\nu$ simpler and more intuitive to tune.

### 3.4. Meshless Discretization

An object is a set of particles at positions $\mathbf{x}_i$ plus a set of local particle *groups*, which play the role of mesh elements. The heart of any discretisation is estimating $\mathbf{F}$ from particle (or node) positions. For a tetrahedron (four nodes) $\mathbf{F}$ is unique; with more than four particles it is over-determined, so a least-squares fit is used. The paper adopts the shape-matching fit [MHTG05]:

$$
\mathbf{F} = \left(\sum_{i=1}^{n} m_i\,\mathbf{r}_i\,\bar{\mathbf{r}}_i^T\right)\left(\sum_{i=1}^{n} m_i\,\bar{\mathbf{r}}_i\,\bar{\mathbf{r}}_i^T\right)^{-1} = \mathbf{P}\,\mathbf{Q}^{-1} \tag{13}
$$

where $n$ is the group size, $\mathbf{r}_i = \mathbf{x}_i - \mathbf{x}_{cm}$ and $\bar{\mathbf{r}}_i = \bar{\mathbf{x}}_i - \bar{\mathbf{x}}_{cm}$ (bars denote rest quantities). The centre of mass is

$$
\mathbf{x}_{cm} = \frac{\sum_{i=1}^{n} m_i\,\mathbf{x}_i}{\sum_{i=1}^{n} m_i} \tag{14}
$$

and likewise for $\bar{\mathbf{x}}_{cm}$. With fixed connectivity, $\mathbf{Q}^{-1}$ and $\bar{\mathbf{x}}_{cm}$ are constants that can be precomputed. Plugging this $\mathbf{F}$ into the constraint functions of §3.2–3.3 yields constraints directly on the positions of a group's particles.

Computing the compliance via (5), (6) or (12) requires a volume per group. Options discussed:

- regular sampling: object volume divided by the number of groups;
- general case: volume of a sphere of radius $\bar r = \sum_{i=1}^{n} |\bar{\mathbf{r}}_i| / n$;
- one group per particle: compute a density $\rho_i$ per particle with a normalised kernel as in [MKN*04] and set $V_i = m_i/\rho_i$;
- (used for Fig. 1) a **cut-cell mesh**: the input volume is cut by a regular grid; interior cells are regular hexahedra, boundary cells are the parts of the original surface clipped to the cell plus the clipped grid faces, so the cells match the input volume exactly. All input-surface vertices and all vertices created by clipping become particles. Clipping may split a boundary cell into several disconnected pieces; each piece and each interior cell becomes one group whose particles are all the clipped-mesh vertices inside that cell. Group volumes are then computed exactly from each cell's surface.

### 3.5. Filtering Zero-Energy Modes

Using only the constraints above produces disturbing artifacts: particles drift without restraint and the object can wander into random, chaotic shapes. With more than four particles a group has more degrees of freedom than $\mathbf{F}$ from (13) can describe, so there are subspaces of particle configurations sharing the same $\mathbf{F}$. The constraints cannot tell these apart, and motion inside them — *zero-energy modes* — is invisible to the energy.

The same issue arises in hybrid particle/grid methods, where particles carry more degrees of freedom than grid cells. FLIP [ZB05], MPM's predecessor, has zero-energy modes because many particle-velocity arrangements look divergence-free once sampled to the grid, and FLIP only transfers velocity *corrections*. Blending in PIC removes them because PIC *overwrites* particle quantities with smoothed grid values; traditional MPM behaves likewise — the round trip particle → grid → particle smooths away the extra particle degrees of freedom.

The paper transfers that idea to the gridless setting with one extra projection step: after the material constraint is applied, recompute $\mathbf{F}$ and $\mathbf{x}_{cm}$ with (13) and (14) (they now include the material response) and overwrite every particle of the group with

$$
\mathbf{x}_i \leftarrow \mathbf{x}_{cm} + \mathbf{F}\,\bar{\mathbf{r}}_i. \tag{15}
$$

For a tetrahedron (four particles) this changes nothing. For an over-determined group it replaces the particle positions with the configuration that matches $\mathbf{F}$ and is closest to rest up to rotation and translation. This step takes the place of shape matching's projection, but uses the physically derived deformation gradient instead of a rotation matrix.

### 3.6. Algorithm

**Algorithm 1:** XPBD solver (one solver iteration per substep).

```text
while simulating do
    h ← Δt / numSubsteps
    for s substeps do
        for n particles do
            x_prev ← x
            v ← v + h · f_ext / m
            x ← x + h · v
        end
        for all groups g do
            project(g, x_1, …, x_{n_g})
        end
        for n particles do
            v ← (x − x_prev) / h
        end
        for all groups g do
            applyDamping(g, v_1, …, v_{n_g})
        end
    end
end
```

Each simulation step is split into $s$ substeps; each substep does XPBD's prediction, a *single* solver iteration, and the velocity update, followed by a pass over all groups that adjusts velocities for damping (§3.7). A single iteration may look inaccurate, but [MSL*19] showed that for a fixed per-step budget $b = s \cdot n$ ($s$ substeps, $n$ iterations each), choosing $s = b$, $n = 1$ is most accurate and converges fastest, resolves the most temporal detail, and introduces the least numerical damping. Many iterations solve the implicit equations more exactly, but even the exact implicit solution only approximates the true trajectory, and more poorly as the step grows — it is better to solve a more accurate equation approximately than a less accurate one almost exactly.

`project(g, x_1, …, x_{n_g})` applies positional corrections to group $g$'s particles to satisfy the group constraint. Per XPBD, each group gets one Lagrange multiplier

$$
\lambda = \frac{-C(\mathbf{x})}{\sum_{i=1}^{n} w_i\,\left|\nabla_{\mathbf{x}_i} C(\mathbf{x})\right|^2 + \alpha / h^2} \tag{16}
$$

with substep $h$, compliance $\alpha$ (inverse stiffness, §3.2–3.4), inverse masses $w_i$, and $\mathbf{x}$ the stacked group positions. The numerator follows from computing $\mathbf{F}$ via (13) and evaluating the constraint as a function of $\mathbf{F}$. The denominator needs the constraint gradients with respect to particle positions, which turn out to be simple. Writing $\mathbf{F} = [\mathbf{f}_1, \mathbf{f}_2, \mathbf{f}_3]$ (columns):

$$
\nabla_{\mathbf{x}_i} C_H(\mathbf{x}) = m_i\,\left[\mathbf{f}_2\times\mathbf{f}_3,\ \mathbf{f}_3\times\mathbf{f}_1,\ \mathbf{f}_1\times\mathbf{f}_2\right]\mathbf{Q}^{-T}\,\bar{\mathbf{r}}_i, \tag{17}
$$

$$
\nabla_{\mathbf{x}_i} C_D(\mathbf{x}) = \frac{m_i}{r}\,\left[\mathbf{f}_1, \mathbf{f}_2, \mathbf{f}_3\right]\mathbf{Q}^{-T}\,\bar{\mathbf{r}}_i, \tag{18}
$$

$$
\nabla_{\mathbf{x}_i} C_{\text{Hooke}}(\mathbf{x}) = \frac{m_i}{C_{\text{Hooke}}(\mathbf{x})}\,\mathbf{S}\mathbf{F}\,\mathbf{Q}^{-T}\,\bar{\mathbf{r}}_i, \tag{19}
$$

where $r = \sqrt{|\mathbf{f}_1|^2 + |\mathbf{f}_2|^2 + |\mathbf{f}_3|^2}$ and $\mathbf{Q}$ is from (13). `[reconstructed]` Eq. (19) is printed as $\mathbf{S}\mathbf{F}$; since $\partial \hat W/\partial \mathbf{F} = \mathbf{F}\hat{\mathbf{S}}$ (first Piola–Kirchhoff stress, with $\hat{\mathbf{S}} = \hat{\mathbf{C}}\boldsymbol\varepsilon$ the $E{=}1$ stress), the product $\mathbf{F}\hat{\mathbf{S}}$ is presumably intended. Once $\lambda$ is known, each particle of the group is updated by

$$
\mathbf{x}_i \leftarrow \mathbf{x}_i + \lambda\,w_i\,\nabla_{\mathbf{x}_i} C(\mathbf{x}). \tag{20}
$$

Sequential XPBD applies each group's projection immediately before moving to the next group, i.e. non-linear Gauss–Seidel. Compared with methods that ignore neighbouring groups' updates, this is more stable because it avoids overshooting, but results depend on constraint order. The recommendation is to randomise the order once and keep it fixed for the whole simulation to avoid artifacts.

### 3.7. Damping

Damping is a velocity pass after the position solve of Algorithm 1, using the method of Müller et al. [MHR06]:

**Algorithm 2:** ApplyDamping

```text
x_cm ← (Σ_i x_i m_i) / (Σ_i m_i)
v_cm ← (Σ_i v_i m_i) / (Σ_i m_i)
L    ← Σ_i r_i × (m_i v_i)
I    ← Σ_i R̃_i R̃_iᵀ m_i
ω    ← I⁻¹ L
for all particles i do
    v̄_i ← v_cm + ω × r_i
    v_i ← v_i + min(c·Δt, 1) · (v̄_i − v_i)
end
```

Here $\mathbf{r}_i = \mathbf{x}_i - \mathbf{x}_{cm}$, $\tilde{\mathbf{R}}_i$ is the cross-product matrix with $\tilde{\mathbf{R}}_i\mathbf{v} = \mathbf{r}_i \times \mathbf{v}$, and $c$ is the damping coefficient. A fully damped connected group moves as a rigid body with velocity $(\mathbf{v}_{cm}, \boldsymbol\omega)$; the pass pulls each particle velocity toward that rigid motion, independent of time step through $c$. Because the blend factor is clamped (to at most 1), it cannot overshoot, so the scheme stays stable for any $c$.

## 4. Results

All tests ran single-threaded on a Core i7-9700K at 3.6 GHz. The method parallelises easily with a Jacobi-style solver as described in [BMM17].

> Figure 2: Stretching experiment. Left to right: shape matching, Neo-Hookean, Hookean ($\nu = 0.49$), Hookean ($\nu = 0.0$).

**Stretching (Fig. 2).** A bar made of randomly shaped hexahedral elements is stretched. The shape-matching bar (blue, left) does not preserve volume because shape matching produces no forces orthogonal to the stretch. The Neo-Hookean bar (green) shows the typical necking of a volume-preserving hyperelastic material; volume stays within 3%. The red bars use the Hookean model with $\nu = 0.49$ and $\nu = 0.0$. With $\nu = 0.49$ volume preservation is *over*-compensated, because Hooke's law encodes incompressibility through off-diagonal entries of the constitutive matrix, a small-strain approximation. With $\nu = 0.0$ the Hookean bar behaves like shape matching. 1700 elements and 2300 particles per bar; all bars together take 170 ms per frame.

> Figure 3: Twisting experiment. The Neo-Hookean model is the most stable of the four; it keeps the correct shape while the other three blocks collapse.

**Twisting (Fig. 3).** The bar is twisted by 270°. Shape matching and Neo-Hookean both cope; Neo-Hookean gives a slightly smoother shape. The Hookean model fails because it generates no forces that restore inverted elements. 1400 elements and 1800 particles per bar, 140 ms per frame.

> Figure 4: Thin layers under user interaction, showing the stability of the position-based formulation.

**Thin shells (Fig. 4).** Sheets of 1060 elements and 2300 particles remain stable however fast the user drags them, thanks to the position-based compliant formulation; 100 ms per frame.

**Cut-cell lion fish (Fig. 1).** Built as in §3.4 with one group per disconnected cell. Particle masses come from distributing each cell's mass (cell volume × density) evenly over its adjacent particles. A 20k-triangle surface was cut into 840 cells; the simulation mesh matches the input surface exactly; the Neo-Hookean material is used; 82 ms per frame. The low-resolution version (right of Fig. 1) has only 195 cells and still behaves plausibly; it costs about the same as the high-resolution one because each cell now has many more adjacent particles.

## 5. Conclusion and Future Work

The paper presents a meshless method for elastic solids that resembles shape matching but is derived from physical principles, demonstrated with Hookean and Neo-Hookean constitutive models. The linear zero-energy-mode filter causes *shear locking*, visible only on fairly soft objects undergoing large deformation; a possible fix is the non-linear (quadratic) shape matching discussed in the original paper [MHTG05]. The cut-cell mesh matches the input exactly, but an approximate mesh often suffices, so the authors are investigating how to simplify cells while keeping the mesh consistent. Another direction is applying the method to large plastic deformation, tearing and cutting.

## 6. Appendix

### 6.1. Hookean Constitutive Matrix

For isotropic material, write strain and stress as 6-vectors

$$
\boldsymbol\varepsilon = [\varepsilon_{xx}, \varepsilon_{yy}, \varepsilon_{zz}, \varepsilon_{xy}, \varepsilon_{yz}, \varepsilon_{zx}]^T \tag{21}
$$

$$
\boldsymbol\sigma = [\sigma_{xx}, \sigma_{yy}, \sigma_{zz}, \sigma_{xy}, \sigma_{yz}, \sigma_{zx}]^T. \tag{22}
$$

The fourth-order Hookean tensor then becomes the matrix

$$
\mathbf{C} = \frac{E}{(1+\nu)(1-2\nu)}
\begin{bmatrix}
1-\nu & \nu & \nu & 0 & 0 & 0\\
\nu & 1-\nu & \nu & 0 & 0 & 0\\
\nu & \nu & 1-\nu & 0 & 0 & 0\\
0 & 0 & 0 & 1-2\nu & 0 & 0\\
0 & 0 & 0 & 0 & 1-2\nu & 0\\
0 & 0 & 0 & 0 & 0 & 1-2\nu
\end{bmatrix} \tag{23}
$$

with Young's modulus $E$, Poisson ratio $\nu$, and $\boldsymbol\sigma = \mathbf{C}\boldsymbol\varepsilon$. As (23) shows, $E$ factors out as a pure stiffness scale: $\boldsymbol\sigma = E\,\hat{\mathbf{C}}\,\boldsymbol\varepsilon$ with $\hat{\mathbf{C}} = \mathbf{C}|_{E=1}$.

> Note (not in the paper): with tensor shear components $\varepsilon_{xy}$ in (21), the shear diagonal $1-2\nu$ gives $\sigma_{xy} = 2\mu\,\varepsilon_{xy}$, which is correct; but the energy $\tfrac12\boldsymbol\varepsilon^T\mathbf{C}\boldsymbol\varepsilon$ over this 6-vector counts each off-diagonal pair once, i.e. half the full tensor contraction $\tfrac12\boldsymbol\varepsilon:\mathbf{C}\boldsymbol\varepsilon$ for the shear part. An implementation should pick one convention consistently.

### 6.2. Implementation Notes

For dense sampling the entries of $\mathbf{P}$ and $\mathbf{Q}$ in (13) can become very small, and $\det\mathbf{Q}$, needed to invert $\mathbf{Q}$, smaller still — possibly underflowing single precision. The fix: compute a normalisation factor $s = 1/\sum_{i,j} q_{ij}$ over the entries $q_{ij}$ of $\mathbf{Q}$, scale $\mathbf{Q}$ by $s$ before inverting, and scale $\mathbf{P}$ and all gradients by $s$ as well.

## References

Reference list body omitted. Works cited by the paper that matter for this repository:

- **[MHTG05]** Müller, Heidelberger, Teschner, Gross — *Meshless deformations based on shape matching*, ACM TOG 24(3), 2005. (The kernel in `src/game/shape-match-core.js`.)
- **[MM21]** Macklin, Müller — *A constraint-based formulation of stable Neo-Hookean materials*, MIG 2021.
- **[MMC16]** Macklin, Müller, Chentanez — *XPBD: Position-based simulation of compliant constrained dynamics*, MIG 2016.
- **[MSL*19]** Macklin, Storey, Lu, Terdiman, Chentanez, Jeschke, Müller — *Small steps in physics simulation*, SCA 2019.
- **[MHR06]** Müller, Heidelberger, Hennix, Ratcliff — *Position based dynamics*, VRIPHYS 2006 (damping, Algorithm 2).
- **[BKCW14]** Bender, Koschier, Charrier, Weber — *Position-based simulation of continuous materials*, Computers & Graphics 44, 2014.
- **[BMM17]** Bender, Müller, Macklin — *A survey on position based dynamics*, EG 2017 Tutorials.
- **[CMM16]** Chentanez, Müller, Macklin — *Real-time simulation of large elasto-plastic deformation with shape matching*, SCA 2016.
- **[FJL*17]** Falkenstein, Jones, Levine, Shinar, Bargteil — *Reclustering for large plasticity in clustered shape matching*, MIG 2017.
- **[JML*16]** Jones, Martin, Levine, Shinar, Bargteil — *Ductile fracture for clustered shape matching*, I3D 2016.
- **[KBFF*21]** Kugelstadt, Bender, Fernández-Fernández, Jeske, Löschner, Longva — *Fast corotated elastic SPH solids with implicit zero-energy mode control*, PACMCGIT 4(3), 2021.
- **[SGK18]** Smith, de Goes, Kim — *Stable Neo-Hookean flesh simulation*, ACM TOG 37, 2018.
