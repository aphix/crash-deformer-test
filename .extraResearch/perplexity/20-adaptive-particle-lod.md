Fast Adaptive Shape Matching Deformations uses an octree over control particles and adapts the set of active nodes at runtime by refining regions that need more detail and coarsening regions that can be represented more coarsely[1][2]. The key idea is to preserve consistency of the shape-matching state across LOD changes by transferring both geometry and deformation history through prolongation/restriction operators on the hierarchy, including the accumulated plastic deformation state[2].

## Runtime refinement/coarsening

The paper defines an octree-based nodal sampling of the deformable object and builds shape-matching regions hierarchically with interval tests, so the simulation can switch between fine and coarse control particles without recomputing everything from scratch[1][2]. When the octree changes, data is transferred between parent and child nodes so that the current deformed positions, rest-shape information, and plastic state remain coherent across levels[2].

## Plastic deformation preservation

Octree shape matching can “easily model plastic deformation,” and the dissertation summary explicitly notes dynamic resampling on top of this framework[2]. In practice, preserving plasticity during refinement/coarsening means the per-node deformation state is not discarded when the hierarchy changes; it is propagated between levels so the material remembers previous inelastic changes[2].

## Refinement criteria

The sources show the adaptive framework is meant for dynamic level-of-detail and thin-feature handling, and the hierarchy is driven by geometric support intervals rather than a fixed uniform grid[1][2]. The material also supports adaptive selection of LOD and efficient collision handling, so refinement is naturally tied to where more geometric detail is needed, such as thin regions and areas under strong interaction[2].  

The gathered results do not expose a single explicit list like “strain/contact/camera/screen-space error” from the paper text snippets, so those criteria cannot be confirmed here from the retrieved sources alone[1][2].

## Performance and speed

The paper reports that the adaptive sampling framework makes thin features feasible “at a much lower cost” than the earlier uniform lattice method[1]. However, the retrieved snippets do not include the paper’s concrete per-particle or per-cluster timings, nor exact speedup factors, so those numbers cannot be stated reliably from the available evidence[1][2].

If useful, a follow-up can reconstruct the actual runtime formulas and hierarchy-transfer steps from the paper’s algorithmic description, but the present sources only support the high-level octree/interval/adaptive-LOD and plasticity-preserving claims[1][2].

[1] Fast Adaptive Shape Matching Deformations - CGL @ ETHZ (https://cgl.ethz.ch/Downloads/Publications/Papers/2008/Ste08b/Ste08b.pdf)
[2] Diss. ETH No. 18071 (https://cgl.ethz.ch/Downloads/Publications/Dissertations/Ste08c.pdf)
[3] SCA 08: Eurographics/SIGGRAPH Symposium on Computer Animation (https://diglib.eg.org/collections/485cec70-d7bb-4ab7-979c-774558136454)
[4] CGL @ ETHZ - Papers (https://cgl.ethz.ch/publications/papers/papers.php)
[5] Position-based Methods for the Simulation of Solid Objects (https://animation.rwth-aachen.de/media/papers/2013-EG-STAR_PositionBased.pdf)
[6] Applications (https://onlinelibrary.wiley.com/doi/10.1111/cgf.12346)
[7] 00_GeometricCloth.dvi (https://diglib.eg.org/server/api/core/bitstreams/e0a52adc-43ee-47e3-a4e3-d911018559e0/content)
[8] Reclustering for Large Plasticity in Clustered Shape Matching (https://users.cs.utah.edu/~benjones/FalkensteinRLP2017.pdf)
[9] 論文 (https://www.jstage.jst.go.jp/article/iieej/40/4/40_4_549/_pdf)
[10] CS 348C: Computer Graphics: Animation and Simulation (http://graphics.stanford.edu/courses/cs348c/)
[11] Multi‐layer Lattice Model for Real‐Time Dynamic Character Deformation (https://onlinelibrary.wiley.com/doi/pdfdirect/10.1111/cgf.12749)
[12] [PDF] Robust Real-Time Deformation of Incompressible Surface Meshes (https://animation.rwth-aachen.de/media/papers/2011-SCA-RobustRealTimeDeformation.pdf)
[13] [PDF] [hal-00975220, v3] Seamless Adaptivity of Elastic Models - LIRMM (https://www.lirmm.fr/~gilles/papers/tournier_GI14.pdf)
[14] A Soft Hand Model for Physically-based Manipulation of Virtual Objects (https://www.uni-weimar.de/fileadmin/user/fak/medien/professuren/Virtual_Reality/documents/publications/2011-VR-Soft_Hand_Model_for_Physically_based_Manipuplation-preprint.pdf)
[15] [PDF] Fast and stable cloth simulation based on multi-resolution shape ... (https://animation.rwth-aachen.de/media/papers/2013-CAG-MultiResShapeMatching.pdf)
