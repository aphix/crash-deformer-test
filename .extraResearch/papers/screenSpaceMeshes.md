# Screen Space Meshes

**Simon Schirm, Matthias Müller, Stephan Duthaler** — AGEIA
*Eurographics / ACM SIGGRAPH Symposium on Computer Animation (SCA) 2007*, San Diego, CA, 4–5 August 2007. Editors: D. Metaxas, J. Popović.

*(Faithful section-by-section paraphrase; equations, parameters, tables and captions preserved in meaning.)*

## Abstract

The paper turns the boundary of a 3D point cloud into a renderable surface by working in screen space. A depth map is splatted from the points, together with the inner and outer silhouettes; from these a 2D triangle mesh is built with a Marching-Squares-like procedure, and that mesh is lifted back to world space so ordinary shading (occlusion, reflection, refraction) applies. The main target is rendering particle (Lagrangian/SPH) fluids. Compared with full 3D Marching Cubes, surface is only produced where it is seen, level of detail follows the camera automatically, and screen-space filtering enables extra visual effects.

*ACM CCS:* I.3.7 [Computer Graphics]: Three-Dimensional Graphics and Realism — Animation and Virtual Reality.

## 1. Introduction

Marching Cubes [LC87] is the standard tool for extracting triangle meshes from iso-surfaces, including liquid–air interfaces. Eulerian solvers typically store the liquid as the zero level set of an advected function [FF01, EMF02] and mesh it with Marching Cubes; particle methods [GM77, MCG03, PTB\*03] define the surface as an iso-level of a density built by summing radial kernels per particle [Bli82], and again use Marching Cubes.

For liquid display this has two drawbacks: (1) it is view-independent, so it builds many triangles and details nobody sees; (2) it marches a 3D volume although only the front 2D surface is wanted.

Offline free-surface tracking is mature, but the authors know of no method fast enough for games that renders the full 3D liquid interface; this method fills that gap and is much faster, at the cost of showing only the front-most layer. That is harmless for opaque liquids (milk, oil) and, with fake refraction shaders, usually hardly noticeable for transparent ones. Claimed advantages:

- Near surface parts get more triangles than far ones — camera-dependent LOD.
- Working in 2D allows a Marching-Squares-derived method, much cheaper than 3D Marching Cubes.
- Unlike ray tracing or point splatting, the result is a normal triangle mesh in world space, so standard forward shading and occlusion culling apply.
- Depth smoothing and silhouette smoothing are separable and independently controllable.

> Figure 1: Left: final render. Middle: the screen space mesh. Right: the same mesh seen from a rotated viewpoint, showing that it depends on the view direction.

## 2. Related Work

The method belongs to the family of screen-space techniques. *Ray tracing* [Whi80] is the best known: one ray per pixel, followed through reflection/refraction, which also gives view-dependent detail; the pixel array can be seen as a fine screen grid back-projected into the world. But ray tracing cannot use the GPU triangle pipeline directly and is tied to pixel resolution, whereas a screen space mesh's resolution can be tuned to the frame budget.

Closer relatives are Johanson's *projected grid* [Joh04], built on real-time ocean work [HNC02]. It targets unbounded height-field water, so a plain projected grid suffices and no screen-space connectivity — hence no silhouettes — exists. Screen space meshes handle arbitrary 3D (fluid) surfaces with silhouettes.

Because the input is a point-sampled volume, the method also relates to point splatting [ZPvBG01]: building the depth map is essentially a splat pass, but everything after it is different.

## 3. Basic Algorithm

Input: points $\mathbf{x}_1, \dots, \mathbf{x}_N \in \mathbb{R}^3$ (SPH particle positions here), the projection matrix $\mathbf{P} \in \mathbb{R}^{4\times4}$, and the parameters of Table 1.

Pipeline:

```
1. Setup regular depth map
2. Find internal and external silhouettes
3. Smooth depth values                      (extension, Sec. 4)
4. Generate 2D triangle mesh (Marching-Squares-like)
5. Smooth silhouettes                       (extension, Sec. 4)
6. Transform mesh back into world space
7. Render the 3D triangle mesh
```

All steps re-run whenever particles move or the camera moves.

| Parameter | Description | Range |
|---|---|---|
| $h$ | screen spacing | $1 - 10$ |
| $r$ | particle size | $\ge 1$ |
| $n_\text{filter}$ | filter size for depth smoothing | $0 - 10$ |
| $n_\text{iters}$ | silhouette smoothing iterations | $0 - 10$ |
| $z_\text{max}$ | depth connection threshold | $> r_z$ |

*Table 1: Summary of parameters.*

### 3.1. Depth Map Setup

Screen size is $W \times H$ pixels. The (possibly non-integer) spacing $h$ defines a regular grid with $N_x = \frac{W}{h} + 1$ by $N_y = \frac{H}{h} + 1$ nodes; the depth map $\mathbf{Z} \in \mathbb{R}^{N_x \times N_y}$ holds one depth $z_{i,j}$ per node and is rebuilt every frame.

All $z_{i,j}$ start at $\infty$. The particles are then traversed twice: pass one writes depths, pass two adds extra depth samples where silhouettes cross grid edges (Fig. 2). Both passes need each particle's screen position and screen radius. With homogeneous $\mathbf{x} = [x, y, z, 1]^T$:

$$
\begin{bmatrix} x' \\ y' \\ z' \\ w \end{bmatrix} = \mathbf{P} \begin{bmatrix} x \\ y \\ z \\ 1 \end{bmatrix}. \tag{1}
$$

$\mathbf{P}$ is assumed to follow the OpenGL/DirectX convention, where dividing $x', y', z'$ by $w$ gives canonical coordinates in $[-1, 1]$. The authors divide only $x'$ and $y'$; depth is left undivided so it stays linear rather than being warped by the perspective divide:

$$
\begin{bmatrix} x_p \\ y_p \\ z_p \end{bmatrix} =
\begin{bmatrix} W \cdot \left(\tfrac12 + \tfrac12 x'/w\right) \\ H \cdot \left(\tfrac12 + \tfrac12 y'/w\right) \\ z' \end{bmatrix}. \tag{2}
$$

Hence $x_p \in [0, W]$, $y_p \in [0, H]$, and $z_p$ is an undistorted camera distance. With particle size $r$, the projected radii are

$$
\begin{bmatrix} r_x \\ r_y \\ r_z \end{bmatrix} =
\begin{bmatrix}
r W \sqrt{p_{1,1}^2 + p_{1,2}^2 + p_{1,3}^2} \,/\, w \\
r H \sqrt{p_{2,1}^2 + p_{2,2}^2 + p_{2,3}^2} \,/\, w \\
r \sqrt{p_{3,1}^2 + p_{3,2}^2 + p_{3,3}^2}
\end{bmatrix}, \tag{3}
$$

with $p_{i,j}$ the entries of $\mathbf{P}$. *(Transcribed as printed; given Eq. 2's $\tfrac12$ scaling, a factor $\tfrac12$ on $r_x, r_y$ would be expected — [reconstructed note].)* This is exact only at the screen center; wide-FOV distortion toward the edges changes particle shape, not position, and is ignored. The paper states that for OpenGL/DirectX $\sqrt{p_{3,1}^2 + p_{3,2}^2 + p_{3,3}^2} = 1$, so $r_z = r$ and $z_p$ is camera distance. If the projection's aspect ratio matches the viewport ($W/H$), $r_x = r_y = r_p$ and particles project to circles, not ellipses.

**Pass 1.** For every particle, each node $(i, j)$ inside its screen disk, $(ih - x_p)^2 + (jh - y_p)^2 \le r_p^2$, is updated:

$$
z_{i,j} \leftarrow \min\left(z_{i,j},\; z_p - r_z h_{i,j}\right), \tag{4}
$$

$$
h_{i,j} = \sqrt{1 - \frac{(ih - x_p)^2 + (jh - y_p)^2}{r_p^2}}. \tag{5}
$$

Dropping the square root gives an inverted paraboloid instead of a sphere cap — cheaper and usually good enough; other kernels can be tried. After pass 1 the point cloud's depth is coarsely sampled at the nodes. As in Marching Squares, extra nodes are then placed on grid edges whose end depths differ strongly, to follow the silhouette more precisely (Fig. 2, right).

```
// Pass 1: splat
Z[:,:] = INF
for each particle p:
    (xp, yp, zp, rp, rz) = project(p)                    // Eqs. 1-3
    for each node (i,j) with (i*h-xp)^2 + (j*h-yp)^2 <= rp^2:
        d2  = ((i*h-xp)^2 + (j*h-yp)^2) / rp^2
        hij = 1 - d2                                     // or sqrt(1 - d2) for a sphere
        Z[i,j] = min(Z[i,j], zp - rz*hij)
```

> Figure 2: Left: side view of a depth map made by three particles (screen radius $r_p$, spacing $h$, depth offset $r_z$); only the front-most hits are kept, and jumps between neighbouring depths larger than $z_\text{max}$ mark inner and outer silhouettes. Right: at most one extra node (white dot) is stored between two adjacent nodes to locate the silhouette.

### 3.2. Silhouette Detection

Pass 2 walks the particles again but only looks at grid edges whose two end depths differ by more than $z_\text{max}$ — *silhouette edges* (Fig. 3). Each such edge should receive exactly one *silhouette node*, lying between its endpoints and carrying the front layer's depth. For each particle, the intersections of its screen circle (center $(x_p, y_p)$, radius $r_p$) with silhouette edges are candidates; a candidate sits at the intersection point and has depth $z_p$. It is kept only if:

- $z_p$ is below the mean depth of the edge's endpoints (the particle is on the front layer) — this test can be done first to skip the intersection computation; and
- the intersection lies farther from the shallower endpoint than any node already stored on that edge, in which case it replaces that node (Fig. 3, right).

```
// Pass 2: silhouette nodes
for each particle p:
    for each silhouette edge e=(a,b) (|Z[a]-Z[b]| > z_max) touched by p's disk:
        if zp >= (Z[a]+Z[b])/2: continue                 // not front layer (early out)
        c = intersection of circle(xp,yp,rp) with e
        near = (Z[a] < Z[b]) ? a : b
        if dist(c, near) > dist(sil[e].pos, near) or sil[e] empty:
            sil[e] = { pos: c, depth: zp }
```

> Figure 3: Left: top view of the grid; bold segments have end-depth differences above $z_\text{max}$, so one or more silhouettes cross them. Right: side view; two lower particles cut the same edge at different points, and choosing the cut (white) farthest from the shallower (left) endpoint resolves the ambiguity.

### 3.3. Mesh Generation

Vertices are created as follows:

- Every node with a valid depth ($\neq \infty$) yields one vertex at its position and depth.
- A silhouette edge with exactly one valid endpoint yields one extra vertex at its silhouette node (position and depth) — this vertex lies on an **outer** silhouette.
- A silhouette edge with both endpoints valid yields **two** vertices at the silhouette node's position (an **inner** silhouette, Fig. 4): the *front vertex*, tied to the shallower endpoint, takes the silhouette node's depth; the *back vertex*, tied to the deeper endpoint, takes a depth extrapolated from that endpoint's neighbourhood. Linear extrapolation was found sufficient.

> Figure 4: Side view. Left: a silhouette node on a silhouette edge. Right: resulting vertices and triangles — the single silhouette node produces two vertices (front and back silhouette vertex) with different depths.

Triangles are produced cell by cell. Each of a cell's four edges is either regular or a silhouette edge, giving $2^4 = 16$ cases (Fig. 5); the case index is formed by one bit per edge, set when that edge carries a silhouette node.

```
for each grid cell:
    case = b0 | (b1 << 1) | (b2 << 2) | (b3 << 3)   // b_k = 1 iff edge k has a silhouette node
    for each template triangle of Fig. 5[case]:
        if all three referenced vertices exist: emit triangle
```

> Figure 5: The 16 cell cases (0–15) used to build the 2D triangle mesh from cut edges. Each cut is drawn "opened" to separate the silhouette vertex owned by one end node from the one owned by the other.

Only template triangles whose three vertices exist are emitted, so on outer silhouettes a subset is used. Case groups:

- **Case 0** — interior, no silhouette. The diagonal alternates between the shown layout and its 90°-rotated version for a more even interior mesh.
- **Cases 3, 5, 6, 9, 10, 12** — the ordinary situation: the silhouette enters through one edge and leaves through another; nothing special.
- **Cases 1, 2, 4, 8** — an inner silhouette begins inside the cell. The triangulation is not unique; any fixed choice works, but it must stay fixed to avoid flicker. The two silhouette vertices differ in depth by at most $3 z_\text{max}$, so connecting them cannot create arbitrarily stretched triangles.
- **Cases 7, 11, 13, 14, 15** — pathological. In case 7 the central triangle joins the two left triangles and shares their layer, while the upper-right and lower-right triangles may each belong to different, arbitrarily distant layers. A third vertex is therefore created for the right-hand silhouette node, with depth extrapolated from the four left vertices. Case 15 creates two extra vertices, attached to the layer of the lower-left triangle.

### 3.4. Transformation to World Space and Rendering

The mesh now has fixed connectivity and screen-space vertices $[x_p, y_p, z_p]^T$. To shade it — including reflections/refractions of the 3D scene — vertices are mapped back to world space, connectivity unchanged, by inverting Eqs. (1)–(2). With $\mathbf{Q} = \mathbf{P}^{-1}$:

$$
\begin{bmatrix} x \\ y \\ z \\ 1 \end{bmatrix} = \mathbf{Q}
\begin{bmatrix} (-1 + 2x_p/W)\,w \\ (-1 + 2y_p/H)\,w \\ z_p \\ w \end{bmatrix}. \tag{6}
$$

The divisor $w$ is unknown, but the last row of Eq. (6) gives it from known values before the full inverse is applied:

$$
w = \frac{1 - q_{4,3}\, z_p}{q_{4,1}(-1 + 2x_p/W) + q_{4,2}(-1 + 2y_p/H) + q_{4,4}}. \tag{7}
$$

World-space vertex normals are then computed as the normalized, **angle-weighted** sum of adjacent face normals, and the mesh goes through the standard graphics pipeline.

```
// Angle-weighted vertex normals
N[:] = 0
for each triangle (a,b,c):
    n = normalize(cross(x_b - x_a, x_c - x_a))
    N[a] += angle_at(a) * n;  N[b] += angle_at(b) * n;  N[c] += angle_at(c) * n
for each vertex v: N[v] = normalize(N[v])
```

## 4. Extensions

### 4.1. Depth Smoothing

The raw depth map is bumpy, which a filter fixes easily. The authors use a separable binomial filter with user-set half-size $n_\text{filter}$ (Fig. 6), run along $i$ and then along $j$.

| $i-3$ | $i-2$ | $i-1$ | $i$ | $i+1$ | $i+2$ | $i+3$ |
|---|---|---|---|---|---|---|
| $1/64$ | $6/64$ | $15/64$ | $20/64$ | $15/64$ | $6/64$ | $1/64$ |

> Figure 6: Separable binomial filter for $n_\text{filter} = 3$; the depth at $(i, j)$ is replaced by the weighted sum of its neighbours using the weights shown.

Pass one filters every valid ($z_{i,j} \neq \infty$) value horizontally; pass two filters the valid values vertically. Near silhouettes, a node only uses neighbours whose depth is within $z_\text{max}$ of its own. Done naively this tilts the mesh border toward the camera (Fig. 7): the kernel becomes one-sided and drags the center toward the valid side. The fix: whenever tap $i + k$ is rejected, also drop its mirror tap $i - k$, keeping the kernel symmetric. When a node's depth changes, its attached silhouette nodes are shifted by the same amount.

```
// One 1D pass (run along i, then along j) — symmetric-omission binomial filter
for each node i with z[i] != INF:
    sum = w[0] * z[i]; wsum = w[0]
    for k in 1..n_filter:
        a = z[i-k]; b = z[i+k]
        if |a - z[i]| > z_max or |b - z[i]| > z_max: continue   // drop BOTH taps
        sum += w[k] * (a + b); wsum += 2 * w[k]
    z_out[i] = sum / wsum
    shift silhouette nodes attached to i by (z_out[i] - z[i])
```

> Figure 7: Excluding some depth samples from the filter (one-sided kernel) tilts the mesh toward the camera.

> Figure 8: Top: unfiltered result is bumpy. Bottom: screen-space depth smoothing gives a flat surface.

### 4.2. Silhouette Smoothing

Depth smoothing leaves the outline untouched. To smooth the outline, the screen coordinates $[x_p, y_p]^T$ of mesh vertices are smoothed before back-projection, using simple iterated neighbour averaging: each vertex moves to the mean of itself and its adjacent vertices. The regular interior mesh (case 0 and its flipped variant) is a fixed point of this operation, so only the silhouettes move. Matching front/back vertices of an inner silhouette are kept "glued" at the same screen position so inner silhouettes do not open up. The iteration count is $n_\text{iters}$.

```
repeat n_iters times:
    for each vertex v: p'[v] = (p[v] + sum_{u in N(v)} p[u]) / (1 + |N(v)|)   // x_p, y_p only
    glue front/back vertices of each inner silhouette node to one (x_p, y_p)
    p = p'
```

This shrinks outer silhouettes, which is mostly welcome: particles must be fairly large to cover a puddle, so small detached clusters look like oversized blobs, and the shrinking makes such droplets look more natural — effectively a surface-tension look (Fig. 11).

## 5. Results

Hardware: Intel dual-core 2.6 GHz CPU, 2 GB RAM. The SPH simulation was usually the bottleneck.

| Scene | SPH particles | fps, no surface | $h = 6$ | $h = 3$ |
|---|---|---|---|---|
| Car wash (Fig. 1) | 16K | 20 | 19 fps, 13K tris | 18 fps, 40K tris |
| Dungeon (Fig. 11) | 10K | 23 | 22 fps, 15K tris | 21 fps, 60K tris |
| Slide (Fig. 9) / Wheels (Fig. 10) | 5K | 65 (slide) | 55 fps, 5K tris | 40 fps, 20K tris |

In the slide and wheels scenes the particle count is small relative to the generated triangle count, and 5K particles simulate quickly (65 fps for the slide), so surface generation becomes a noticeable share of the frame.

> Figure 9: Left: input particles, coloured by SPH density. Middle: screen space mesh. Right: final render.

> Figure 10: Left: scene with a complex 3D liquid boundary. Middle: screen space mesh including inner silhouettes. Right: rotating the frozen mesh shows inner silhouettes are correctly disconnected along the view direction.

> Figure 11: Left: a corridor being flooded. Middle: top view of the mesh without silhouette smoothing. Right: with silhouette smoothing, which produces a surface-tension-like look.

## 6. Conclusions and Future Work

Screen space meshes are an efficient way to build and display surfaces; the paper concentrates on particle fluids but the idea is broader. The speed comes with limits. The world-space mesh is valid only for the current camera, which breaks shadow casting; a suggested remedy is to build a separate mesh from each light's viewpoint. Only the front-most layer exists, which is rarely visible as an artifact. Most steps (depth splatting, vertex back-projection) map well to the GPU, which should be much faster than the authors' CPU implementation — though the CPU version already handles fairly complex surfaces in real time.

## References

Reference list body omitted. Cited works relevant to this repo:

- [LC87] Lorensen, Cline — Marching Cubes (SIGGRAPH 1987): the 3D baseline being replaced.
- [MCG03] Müller, Charypar, Gross — Particle-based fluid simulation for interactive applications (SCA 2003): the SPH particle source.
- [Bli82] Blinn — A generalization of algebraic surface drawing (ACM TOG 1982): kernel-sum ("metaball") density surfaces.
- [Joh04] Johanson — Real-time water rendering: the projected grid concept (MSc thesis, Lund 2004).
- [ZPvBG01] Zwicker, Pfister, van Baar, Gross — Surface splatting (SIGGRAPH 2001): depth-map setup is a splat step.
