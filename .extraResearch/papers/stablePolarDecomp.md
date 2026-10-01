# A Robust Method to Extract the Rotational Part of Deformations

**Authors:** Matthias Müller¹, Jan Bender², Nuttapong Chentanez¹, Miles Macklin¹
¹ NVIDIA Physics Research · ² RWTH Aachen University
**Venue:** MiG '16 (Motion in Games), October 10–12, 2016, Burlingame, CA, USA. ACM. DOI [10.1145/2994258.2994269](http://dx.doi.org/10.1145/2994258.2994269)

> Rewrite note: this is a section-by-section paraphrase of the paper (prose condensed in our own words). Equations, parameter values, figure captions and the algorithm are preserved in meaning. Where the PDF text extraction lost symbols (cross products, minus signs, fractions) the equation was rebuilt from the surrounding derivation and is marked `[reconstructed]`. Matrices are written with column vectors: $\mathbf{A} = [\mathbf{a}_1\ \mathbf{a}_2\ \mathbf{a}_3]$, $\mathbf{R} = [\mathbf{r}_1\ \mathbf{r}_2\ \mathbf{r}_3]$.

> Figure 1: Core idea. Red arrows are the columns of the input matrix $\mathbf{A}$; green arrows are the columns of the extracted rotation $\mathbf{R}$. The optimal rotation is an equilibrium: the torques acting on the three axes (red triangles) cancel.

## Abstract

The paper introduces a new algorithm that extracts the rotational part of an arbitrary $3\times3$ matrix. This sub-problem sits at the heart of co-rotational FEM and of shape matching. Unlike the classic polar-decomposition route, degenerate (singular) and inverted matrices need no special-case handling. The method is a handful of branch-free lines, which makes it a good fit for GPUs. Robustness, temporal coherence and speed are demonstrated against a stabilized polar decomposition in several simulations.

**Keywords:** rotation, shape matching, co-rotational FEM, polar decomposition. **CCS concepts:** Computing methodologies → Physical simulation.

## 1 Introduction

Simulating deformable objects has two recurring difficulties: degenerate configurations and inversions. For co-rotational FEM [Müller and Gross 2004; Hauth and Strasser 2004] and shape matching [Müller et al. 2005] both reduce to one question: how to get a proper rotation out of an arbitrary deformation gradient. Formally, given any $3\times3$ matrix $\mathbf{A}$, find an orthonormal $\mathbf{R}$ with $\det(\mathbf{R}) = +1$ minimizing

$$\|\mathbf{A} - \mathbf{R}\|_F^2 .$$

This is Wahba's problem [Wahba 1965], originally posed for estimating spacecraft attitude from measured direction vectors to stars, and it has been studied for decades.

The most common solution is to take the rotation factor of the polar decomposition $\mathbf{A} = \mathbf{R}\mathbf{U}$, first suggested by Farrell et al. [1966]. Its weakness: the decomposition is undefined for singular $\mathbf{A}$, and when $\det(\mathbf{A}) < 0$ it returns a reflection ($\det(\mathbf{R}) = -1$). Many fixes reflect $\mathbf{R}$ back along a carefully chosen axis.

A second family solves a constrained optimization (minimize the Frobenius distance subject to $\det(\mathbf{R}) = +1$). Parametrizing $\mathbf{R}$ by a quaternion $\mathbf{q}$ turns it into finding the dominant eigenvector of a $4\times4$ system — robust, but doing a $4\times4$ eigen-solve per element per step easily dominates simulation cost.

The paper's contribution is a method that is both cheap and robust for *every* $\mathbf{A}$.

## 2 Related Work

**Gram–Schmidt.** The simplest extraction: normalize column 1 of $\mathbf{A}$ to get $\mathbf{r}_1$; take column 2, remove its component along $\mathbf{r}_1$ and normalize to get $\mathbf{r}_2$; set $\mathbf{r}_3 = \mathbf{r}_1 \times \mathbf{r}_2$. The result is always a proper rotation, and it even tolerates singular $\mathbf{A}$ as long as two directions survive. The drawback is order dependence: which column is processed first biases the result, which breaks momentum conservation and produces ghost forces.

**Other fields.** Wessner [1966] derived $\mathbf{R} = (\mathbf{A}\mathbf{A}^T)^{-1/2}\mathbf{A}$ [reconstructed: superscripts lost in extraction]. It can be rewritten as $\mathbf{R} = \mathbf{A}(\mathbf{A}^T\mathbf{A})^{-1/2}$, the usual way of computing the polar decomposition (discussed below). Higham [1986] proposed an iteration initialised with $\mathbf{R} \leftarrow \mathbf{A}$ and refined by

$$\mathbf{R} \leftarrow \tfrac12\left(\mathbf{R} + \mathbf{R}^{-T}\right),$$

which converges to a matrix with $\det(\mathbf{R}) = -1$ when $\det(\mathbf{A}) < 0$ and only works for non-singular $\mathbf{A}$. Davenport's q-method [Markley and Mortari 1999] parametrizes $\mathbf{R}$ by a quaternion and finds the optimum as the eigenvector of the largest eigenvalue of a $4\times4$ matrix — noticeably slower than the alternatives.

**Polar decomposition / SVD in graphics.** The dominant graphics approach is the polar decomposition $\mathbf{A} = \mathbf{R}\mathbf{S}$ ($\mathbf{R}$ rotation, $\mathbf{S}$ symmetric). The SVD $\mathbf{A} = \mathbf{U}\mathbf{D}\mathbf{V}^T$ gives the same rotation via $\mathbf{R} = \mathbf{U}\mathbf{V}^T$, with the singular values on the diagonal of $\mathbf{D}$. Inversions and singularities show up as negative or zero singular values and are repaired by editing the corresponding columns of $\mathbf{U}$ and $\mathbf{V}$. Irving et al. [2004], among the first in graphics to treat inversion, find the smallest singular value and negate the matching column of the rotation — i.e. they reflect the element along its direction of minimal inversion. Schmedding et al. [2008] instead reflect along the direction in which vertices have the shortest distance to travel; they note this need not equal the minimal-inversion direction, particularly for badly shaped elements. Civit-Flores and Susin [2012], in the spirit of continuous collision detection, solve a cubic for the instant an element inverts to decide how to undo it; their paper also surveys inversion/degeneracy handling in depth.

## 3 The Method

Restating the goal: for an arbitrary $3\times3$ matrix $\mathbf{A}$, find the rotation closest to it, i.e. an orthonormal $\mathbf{R}$ with $\det(\mathbf{R}) = +1$ minimizing $F(\mathbf{R}) = \|\mathbf{A} - \mathbf{R}\|_F^2$.

**Key idea.** Do not solve for $\mathbf{R}$ from scratch. Assume an approximation is already available — from the previous simulation step or the previous solver iteration — and improve it with a multiplicative update

$$\mathbf{R} \leftarrow \exp(\boldsymbol{\omega})\,\mathbf{R}, \tag{1}$$

where $\exp(\boldsymbol{\omega})$ (the exponential map) is the rotation about axis $\boldsymbol{\omega}/|\boldsymbol{\omega}|$ by angle $|\boldsymbol{\omega}|$. The exponential map is always a proper rotation (orthonormal, determinant $+1$), including at $\boldsymbol{\omega} = \mathbf{0}$ where it is the identity. Hence if $\mathbf{R}$ starts as a proper rotation, the update keeps it one.

**Direction of $\boldsymbol{\omega}$ — physical interpretation.** The best direction is the one that lowers $F$ fastest. Treat $\mathbf{A}$ as a fixed (static) object and $\mathbf{R}$ as a rigid body that may only rotate about the origin. Define the energy

$$E_F = \tfrac12 F(\mathbf{R}) = \tfrac12 \sum_i (\mathbf{r}_i - \mathbf{a}_i)^2 . \tag{2}$$

The force acting at the tip of each axis of $\mathbf{R}$ is

$$\mathbf{f}_i = -\frac{\partial E_F}{\partial \mathbf{r}_i} = \mathbf{a}_i - \mathbf{r}_i , \tag{3}$$

and the resulting total torque on the rigid body is

$$\boldsymbol{\tau} = \sum_i \mathbf{r}_i \times (\mathbf{a}_i - \mathbf{r}_i) = \sum_i \mathbf{r}_i \times \mathbf{a}_i . \tag{4}$$

So $\boldsymbol{\omega}$ is chosen parallel to the torque, $\boldsymbol{\omega} = \alpha\,\boldsymbol{\tau}$ for some scalar $\alpha$. This also gives a new reading of both the Frobenius-optimal rotation and the polar-decomposition rotation: Appendices A and B show $\boldsymbol{\tau} = \mathbf{0}$ for each, i.e. they are equilibrium states of $E_F$ (Figure 1).

**Magnitude of $\boldsymbol{\omega}$.** Consider one pair $\mathbf{a}_i, \mathbf{r}_i$ with angle $\phi$ between them. Choosing $\boldsymbol{\omega} = \mathbf{r}_i \times \mathbf{a}_i$ [reconstructed: cross symbol lost in extraction] gives $|\boldsymbol{\omega}| = |\mathbf{a}_i||\mathbf{r}_i|\sin\phi$, but aligning the pair (zero torque) needs a rotation of exactly $\phi$. Dividing by the dot product instead,

$$\boldsymbol{\omega} = \frac{\mathbf{r}_i \times \mathbf{a}_i}{\mathbf{r}_i \cdot \mathbf{a}_i}, \tag{5}$$

yields

$$|\boldsymbol{\omega}| = \frac{|\mathbf{a}_i||\mathbf{r}_i|\sin\phi}{|\mathbf{a}_i||\mathbf{r}_i|\cos\phi} = \tan\phi \approx \phi \tag{6}$$

for small $\phi$. Summing over all three axes gives the final iteration:

$$\mathbf{R} \leftarrow \exp\!\left( \frac{\sum_i \mathbf{r}_i \times \mathbf{a}_i}{\left|\sum_i \mathbf{r}_i \cdot \mathbf{a}_i\right| + \varepsilon} \right) \mathbf{R}, \tag{7}$$

with safety parameter $\varepsilon = 10^{-9}$ in all examples. The absolute value in the denominator matters: without it a negative dot-product sum would flip the torque direction.

**Properties.**

- *Rank-deficient $\mathbf{A}$ is handled.* Missing information is inherited from the previous $\mathbf{R}$, which is the right answer inside a simulation. If some $\mathbf{a}_i = \mathbf{0}$, its torque contribution vanishes and $\mathbf{R}$ is left untouched about that direction. For $\mathbf{A} = \mathbf{0}$ the torque is zero and $\mathbf{R}$ does not change at all. If only $\mathbf{a}_1$ is non-zero, $\mathbf{R}$ is rotated in the plane spanned by $\mathbf{r}_1$ and $\mathbf{a}_1$ until $\mathbf{r}_1$ aligns with $\mathbf{a}_1$.
- *Inversion is handled.* Because $\mathbf{R}$ is treated as a rigid body, $\det(\mathbf{R})$ stays $+1$ even when $\det(\mathbf{A}) < 0$.
- *Warm starting is built in*, which makes it efficient in simulations.

Appendix D lists a C++ implementation using Eigen. In practice $\mathbf{R}$ is stored as a quaternion $\mathbf{q}$; comparing it with the Irving et al. [2004] code in Appendix C shows how much simpler it is. The input is the previous step's solution; when none exists the authors recommend the cold start

$$\mathbf{q} = \frac{\mathrm{Quat}(\mathbf{A})}{|\mathrm{Quat}(\mathbf{A})|},$$

i.e. the matrix-to-quaternion conversion applied directly to $\mathbf{A}$, then normalized.

**Energy maxima.** The torque also vanishes where $F$ is *maximized*, and such equilibria exist. For example, with $\mathbf{A} = \mathbf{I}$ and

$$\mathbf{R} = \begin{bmatrix} 0 & 1 & 0 \\ 1 & 0 & 0 \\ 0 & 0 & -1 \end{bmatrix} \tag{8}$$

[reconstructed: the extracted matrix lost its minus sign; any symmetric proper rotation by $\pi$ — here about $(1,1,0)/\sqrt2$ — has zero torque against $\mathbf{A} = \mathbf{I}$], the torque is zero, so an iteration started there never reaches the true minimizer $\mathbf{R} = \mathbf{I}$. A small random perturbation almost always escapes such a maximum (unless it happens to lie along a ridge/plane of maxima). In the experiment of Figure 2 ($\mathbf{A} = \mathbf{I}$, one million random starting rotations) the method always converged to $\mathbf{R} = \mathbf{I}$ — expected if the maxima form a null set, so hitting one by chance has probability zero in theory and is tiny numerically. To *guarantee* escape: whenever $\boldsymbol{\tau} = \mathbf{0}$, apply a small random rotation and compare $F$. If $F$ drops, restart the iteration from the perturbed $\mathbf{R}$; if it rises, discard the perturbation and stop; if it is unchanged, keep trying random rotations until $F$ changes. Alternatively, perturb $\mathbf{R}$ by a small $\varepsilon$ at the start of each solve. The authors never met a maximum in their simulations and use neither safeguard.

> Figure 2: Histogram of how many iterations are needed to reach $F < 0.001$ with $\mathbf{A} = \mathbf{I}$ from random starting rotations $\mathbf{R}$ (blue, "cold start"). Restricting the Euler angles of $\mathbf{R}$ to $[-\pi/3, \pi/3]$ gives the orange distribution ("warm start"). Axes: number of solver iterations (x) vs. number of test cases, up to 1000k (y).

> Figure 3: A tetrahedron is inverted by dragging the green vertex to the yellow position.

## 4 Results

**Convergence.** Reusing the Figure 2 setup: from uniformly random starting rotations (blue bars) the number of iterations to reach $F < 0.001$ is spread out; emulating a warm start by limiting the Euler angles of $\mathbf{R}$ to $[-\pi/3, \pi/3]$ (orange bars), the method converges after 3 iterations in almost every case.

**Agreement with Irving et al. [2004].** A tetrahedron is driven into inversion: three vertices are fixed and the fourth slides along the $x$-axis from rest, through a degenerate (flat) state, to a fully inverted configuration (Figure 3). Figure 4 plots the angular distance between the two methods' rotations with our method warm-started. With enough iterations both give the same answer. With few iterations the gap is largest near $\det(\mathbf{F}) \approx 0$, because Irving's method is discontinuous there [Civit-Flores and Susin 2012]; since our method only ever applies a rotation per iteration, it needs more iterations to cross that jump. Even so the worst gap is only about 0.01 rad.

> Figure 4: Angular distance between our rotation and that of Irving et al. [2004] for various iteration counts (curves labelled up to 5, 10 and 20 iterations; y-axis 0–0.012 rad). The x-axis is $\det(\mathbf{F})$ of the deformation gradient as the tetrahedron goes from rest ($\det(\mathbf{F}) = 1$) through degenerate ($\det(\mathbf{F}) = 0$) to fully inverted ($\det(\mathbf{F}) = -1$).

**Starting quaternion.** Convergence is better the closer the initial quaternion is to the answer (Figure 5). A warm start from the previous solution is best; without one, $\mathbf{q} = \mathrm{Quat}(\mathbf{A})/|\mathrm{Quat}(\mathbf{A})|$ beats the identity quaternion. Further tests that invert the tetrahedron twice (moving two different vertices into inverted positions) also converged toward Irving's solution.

> Figure 5: Angular distance (y-axis 0–0.08 rad) versus $\det(\mathbf{F})$ when our method is started from different quaternions, 10 iterations each: warm start, $\mathbf{q} = \mathrm{Quat}(\mathbf{A})/|\mathrm{Quat}(\mathbf{A})|$, and $\mathbf{q} = (1, 0, 0, 0)$ (identity).

**Simulations.** The scenes of Figure 6 use clustered shape matching; each cluster's orientation is drawn as a local frame. Although the cluster layouts are sparse, the simulations stay stable. In Figure 7 a dragon whose vertices are completely randomized returns to its original shape. Three iterations per solve were enough for artifact-free results in all their experiments, and at that setting the method ran 60–80 % faster than Irving et al. An optimized SVD such as McAdams et al. [2011] would shrink this gap on the CPU, but a GPU port of such an SVD is far more complicated than this method.

> Figure 6: Several objects simulated with clustered shape matching; clusters and their orientations are drawn as local coordinate frames. The method extracts rotations stably even for sparse cluster distributions.

> Figure 7: After the vertex positions of a complex model are fully randomized, the method lets the model recover its original shape.

## 5 Conclusion

A new way to extract the rotational part of an arbitrary $3\times3$ matrix was presented. It is short, simple and branch-free (well suited to GPUs) and faster than previous approaches. It has not yet been tried inside co-rotational FEM, but since it does not depend on the application the authors expect it to work equally well there.

## References (selection relevant to this repo)

- Müller, Heidelberger, Teschner, Gross. *Meshless deformations based on shape matching.* SIGGRAPH 2005 — the shape-matching method whose $\mathbf{A}_{pq}\mathbf{A}_{qq}^{-1}$ rotation step this paper replaces.
- Irving, Teran, Fedkiw. *Invertible finite elements for robust simulation of large deformation.* SCA 2004 — SVD with smallest-singular-value flip (the baseline).
- Higham. *Computing the polar decomposition with applications.* SIAM J. Sci. Stat. Comput. 7(4), 1986 — the $\tfrac12(\mathbf{R} + \mathbf{R}^{-T})$ iteration.
- Civit-Flores, Susin. *Robust treatment of degenerate elements in interactive corotational FEM simulations.* CGF 33(6), 2012 — survey of inversion handling; discontinuity of the SVD fix.
- Schmedding, Teschner. *Inversion handling for stable deformation modeling.* The Visual Computer 24(7), 2008.
- McAdams, Selle, Tamstorf, Teran, Sifakis. *Computing the SVD of 3×3 matrices with minimal branching and elementary floating point operations.* UW-Madison TR1690, 2011.
- Also cited: Farrell & Stuelpnagel 1966; Wahba 1965; Wessner 1966; Markley & Mortari 1999; Müller & Gross 2004; Hauth & Strasser 2004.

## Appendix A — Equilibrium and the Frobenius Norm

Claim: $\mathbf{R}$ minimizes (or maximizes) $F$ exactly when $\boldsymbol{\tau} = \mathbf{0}$. Write

$$F = \sum_i (\mathbf{r}_i - \mathbf{a}_i)^2 . \tag{9}$$

*Extremum ⇒ zero torque.* At an extremum the derivative of $F$ vanishes in every direction. Take any rotation axis $\boldsymbol{\omega}$; for a small angle $\phi$ the rotation linearizes to $\mathbf{r}_i \mapsto \mathbf{r}_i + \phi\,\boldsymbol{\omega}\times\mathbf{r}_i$, giving

$$F(\phi) = \sum_i \left(\mathbf{r}_i + \phi\,\boldsymbol{\omega}\times\mathbf{r}_i - \mathbf{a}_i\right)^2 \tag{10}$$

$$\frac{\partial F}{\partial \phi} = 2\sum_i \left(\mathbf{r}_i + \phi\,\boldsymbol{\omega}\times\mathbf{r}_i - \mathbf{a}_i\right)\cdot\left(\boldsymbol{\omega}\times\mathbf{r}_i\right). \tag{11}$$

At $\phi = 0$, using $\mathbf{r}_i\cdot(\boldsymbol{\omega}\times\mathbf{r}_i) = 0$ and the scalar triple product,

$$\left.\frac{\partial F}{\partial \phi}\right|_{\phi=0} = -2\sum_i \mathbf{a}_i\cdot(\boldsymbol{\omega}\times\mathbf{r}_i) = -2\Big(\sum_i \mathbf{r}_i\times\mathbf{a}_i\Big)\cdot\boldsymbol{\omega} = -2\,\boldsymbol{\tau}\cdot\boldsymbol{\omega} = 0 \tag{12}$$

[reconstructed: factor and sign arrangement]. Since this holds for every $\boldsymbol{\omega}$, $\boldsymbol{\tau} = \mathbf{0}$.

*Zero torque ⇒ extremum.* Conversely, for any axis $\boldsymbol{\omega}$ and angle $\phi$,

$$\frac{\partial F(\phi)}{\partial \phi} = 2\sum_i \left(\mathbf{r}_i + \phi\,\boldsymbol{\omega}\times\mathbf{r}_i - \mathbf{a}_i\right)\cdot\left(\boldsymbol{\omega}\times\mathbf{r}_i\right), \tag{13}$$

which at $\phi = 0$ equals $-2\boldsymbol{\tau}\cdot\boldsymbol{\omega} = 0$ when $\boldsymbol{\tau} = \mathbf{0}$: $F$ is stationary in every rotational direction, i.e. minimized or maximized. Hence $\boldsymbol{\tau} = \mathbf{0}$ iff $F$ is at an extremum.

## Appendix B — Equilibrium and the Polar Decomposition

Claim: if $\mathbf{A} = \mathbf{R}\mathbf{P}$ with $\mathbf{R}$ orthogonal and $\mathbf{P}$ symmetric positive semi-definite, then $\boldsymbol{\tau} = \mathbf{r}_1\times\mathbf{a}_1 + \mathbf{r}_2\times\mathbf{a}_2 + \mathbf{r}_3\times\mathbf{a}_3 = \mathbf{0}$.

Proof sketch (re-derived; extraction of the original lines is garbled). From $\mathbf{R}^T\mathbf{A} = \mathbf{P}$ we get $\mathbf{r}_i\cdot\mathbf{a}_j = p_{ij}$. Because $\mathbf{R}$ is orthonormal (right-handed), $\mathbf{a}_j = \sum_k p_{kj}\,\mathbf{r}_k$ and $\mathbf{r}_1\times\mathbf{r}_2 = \mathbf{r}_3$, $\mathbf{r}_2\times\mathbf{r}_3 = \mathbf{r}_1$, $\mathbf{r}_3\times\mathbf{r}_1 = \mathbf{r}_2$. Expanding,

$$\boldsymbol{\tau} = \mathbf{r}_1\,(p_{32} - p_{23}) + \mathbf{r}_2\,(p_{13} - p_{31}) + \mathbf{r}_3\,(p_{21} - p_{12}),$$

which vanishes because $\mathbf{P}$ is symmetric. (Only the symmetry of $\mathbf{P}$ is used for $\boldsymbol{\tau} = \mathbf{0}$; positive semi-definiteness is what makes it the minimum rather than another equilibrium.)

## Appendix C — Source Code: Irving et al. [2004]

The paper lists a full Eigen implementation (Jacobi eigen-solver + inversion/degeneracy repair). Condensed structure, same steps and constants, in pseudocode:

```text
jacobiRotate(A, R, p, q):            // one Jacobi rotation zeroing A[p][q]
  if A[p][q] == 0: return
  d = (A[p][p] - A[q][q]) / (2 A[p][q])
  t = 1 / (|d| + sqrt(d*d + 1));  if d < 0: t = -t
  c = 1 / sqrt(t*t + 1);  s = t*c
  update A (diagonal p,q; zero A[p][q]; rotate rows/cols k != p,q) and accumulate columns p,q of R

eigenDecomposition(A, V, lambda):    // symmetric 3x3, at most 10 Jacobi sweeps, eps = 1e-15
  D = A; V = I
  repeat up to 10 times:
    pick (p,q) with largest |off-diagonal| of D
    if that value < eps: break
    jacobiRotate(D, V, p, q)
  lambda = diag(D)

rotationMatrixIrving(A) -> R:
  eigenDecomposition(A^T A, V, S)
  if det(V) < 0: negate column of V with the smallest S
  clamp S to >= 0;  sigma = sqrt(S)
  count singular values with |sigma| < 1e-4 (chk), remember index pos
  if chk > 1:      U = I
  elif chk == 1:   U = A V; normalize the two healthy columns by 1/sigma;
                   U.col(pos) = normalize(cross of the two healthy columns)
  else:            U = A V * diag(1/sigma)
  if det(U) < 0:   pos = argmin sigma; sigma[pos] = -sigma[pos]; negate U.col(pos)
  R = U V^T
```

## Appendix D — Source Code: Our Method

The authors' Eigen routine `extractRotation(A, q, maxIter)`, rendered as pseudocode with identical operations and constants (column vectors; `q` is the warm-start quaternion, updated in place):

```text
extractRotation(A, q, maxIter):
  for iter in 0 .. maxIter-1:
    R     = matrix(q)
    omega = (R.col0 x A.col0 + R.col1 x A.col1 + R.col2 x A.col2)
            * ( 1 / |R.col0·A.col0 + R.col1·A.col1 + R.col2·A.col2|  + 1e-9 )   // as printed
    w = |omega|
    if w < 1e-9: break
    q = quatFromAxisAngle(omega / w, w) * q      // left-multiply: R <- exp(omega) R
    q = normalize(q)
```

Note on the listing: as printed, the parenthesization evaluates $1/|\sum_i \mathbf{r}_i\cdot\mathbf{a}_i| + 10^{-9}$, whereas Eq. (7) — and the text's stated purpose of $\varepsilon$ — is $1/(|\sum_i \mathbf{r}_i\cdot\mathbf{a}_i| + 10^{-9})$. Implement Eq. (7): with the printed form, $\mathbf{A} = \mathbf{0}$ yields $0\cdot\infty = \text{NaN}$ and poisons $\mathbf{q}$ (confirmed in a JS port; see the analysis file).

## Slides

The MiG talk slides (19 slides, speaker notes included) follow the paper closely; the additions are:

- **Problem picture (slide 2).** Rest shape → affine deformation $\mathbf{A}$ → best-fit rotation $\mathbf{R}$.
- **Where $\mathbf{A}$ comes from (slide 3).** Co-rotational FEM: the affine map of a tetrahedron's 4 nodes. Shape matching: $\mathbf{A}$ built from the point cloud ($\mathbf{A} = \mathbf{A}_{pq}\mathbf{A}_{qq}^{-1}$ in Müller 2005 notation).
- **The standard pipeline spelled out (slides 4–5).** $\mathbf{A} = \mathbf{R}\mathbf{S}$ ⇒ $\mathbf{A}^T\mathbf{A} = \mathbf{S}^T\mathbf{R}^T\mathbf{R}\mathbf{S} = \mathbf{S}^2$, so $\mathbf{S} = (\mathbf{A}^T\mathbf{A})^{1/2}$ and $\mathbf{R} = \mathbf{A}\mathbf{S}^{-1}$. Diagonalize the symmetric $\mathbf{A}^T\mathbf{A} = \mathbf{U}\mathbf{D}\mathbf{U}^T$ with Jacobi iterations; then $(\mathbf{A}^T\mathbf{A})^{-1/2} = \mathbf{U}\mathbf{D}^{-1/2}\mathbf{U}^T$, where $\mathbf{D}^{-1/2}$ takes inverse square roots of the eigenvalues (squared singular values of $\mathbf{A}$).
- **Failure catalogue (slides 6–7).** Near-coplanar or near-collinear points make $\det(\mathbf{A}) \to 0$, the inverse blows up, and the optimal rotation is not unique. Inversion ($\det(\mathbf{A}) < 0$) yields a reflection. Standard repairs: one missing eigenvector → cross product of the other two; two or three missing → no principled choice (cross with a canonical axis, or identity), which the speaker says typically causes *temporal incoherence*; inversion → flip the smallest-eigenvalue axis (Irving 04) or the smallest-extent axis (Schmedding 08). Slide 8 shows the full Irving pipeline as "long, with many branches".
- **Motivation (slide 9).** Simpler GPU-friendly code; no discrete choices; take the previous $\mathbf{R}$ as an *input* and use it to fill missing information — "natural for simulations (temporal coherence)".
- **Interactive demo (slides 12, 16).** Manipulating either $\mathbf{A}$ or $\mathbf{R}$ shows $\mathbf{R}$ continuously chasing $\mathbf{A}$; shrinking some axes of $\mathbf{A}$ (ill-conditioned, near-singular) still gives plausible rotations. A second demo shows a configuration parked on an energy maximum being released by a tiny perturbation; the maxima form a measure-zero set and caused no artifacts in practice.
- **Forces stated explicitly (slide 13).** $\mathbf{f}_i = \mathbf{a}_i - \mathbf{r}_i$; torque $\boldsymbol{\tau} = \sum_i \mathbf{r}_i \times \mathbf{a}_i$; $\boldsymbol{\omega} \parallel \boldsymbol{\tau}$.
- **Performance claim (slide 17).** "Much simpler than Irving, no branches"; up to 2× faster depending on iteration count (the paper says 60–80 % faster at 3 iterations).
- **Iteration count rationale (slide 18).** Setup $\mathbf{A} = \mathbf{I}$, random $\mathbf{R}$; with warm-start-like starts (Euler angles in $[-\pi/3, \pi/3]$) 3 iterations sufficed *in all cases* to reach $F < 0.001$, so 3 iterations were used for all examples.
