Bugbear’s damage system is best understood as a **hybrid soft-body / rigid-body model**: the car’s exterior is represented by many deformable control points or nodes that drive a damaged mesh, while the vehicle’s actual motion still comes from a conventional rigid-body chassis and suspension model. In FlatOut and Wreckfest, impacts deform the visual body procedurally, detach breakable parts, and feed resulting changes back into handling, rather than simulating a fully continuous soft-body car like BeamNG.

## How the damage mesh works

In FlatOut-era descriptions, Bugbear said each car had a meticulously modeled damage mesh with about **40 deformable and breakable panels** for parts like doors, boots, bonnets, and bumpers; these could bend, tear, and eventually rip off the car.[15] That same system was described as **procedural and persistent**, meaning damage accumulated over the race instead of resetting.[15]

For Wreckfest and the later Bugbear/Rajala explanation, the core approach is typically described as a **clustered shape-matching deformation system**: the car body is divided into many control particles/nodes, and the mesh follows them. The deformation is not a free finite-element simulation; it is a faster game-oriented scheme where groups of nodes preserve local shape and are iteratively solved to keep the car stable while still allowing crumpling.

## Control particles / nodes per car

The public technical descriptions associated with Bugbear and Rajala’s 2008 “Dynamic Mesh Deformation for Car Games” indicate that each car uses **many control particles** rather than simulating every triangle directly. The commonly cited implementation detail is that cars use **hundreds of nodes/particles** distributed through the body, with the visible mesh skinned or interpolated from them. This is what enables localized dents, folded panels, and large-scale crumpling without a supercomputer.

## Shape-matching clusters

The deformation is typically organized into **clusters**: each cluster is a set of nearby control nodes that tries to preserve its original shape using shape matching. When an impact occurs, the nodes are displaced, and the solver repeatedly pulls them toward the cluster’s rest configuration while still permitting plastic offsets. This makes it possible to have rigid-looking regions in one part of the car and heavily crushed metal in another.

## Plasticity, including rotation

Plasticity is the key to making the damage stay instead of springing back. In the Rajala/Bugbear style system, when deformation exceeds a threshold, the cluster’s rest shape is updated so the damage becomes permanent. Rotation is part of that update: a cluster does not just remember where its particles moved, it also tracks the **best-fit orientation** of the deformed shape so the “new rest pose” can be rotated and translated as well as shifted. That is what lets a crushed fender keep its twisted angle after the collision.

## Stiffness by iteration

The apparent stiffness of the car body is controlled largely by **how many solver iterations** are run per frame and how strongly the clusters are pulled back toward their rest shapes each iteration. More iterations and stronger projection produce a stiffer body; fewer iterations or weaker projection allow more give. This is a common real-time trick: stiffness is not only a material parameter, but also a function of the iterative solver’s convergence.

## Normal transformation

For rendering, the damaged mesh needs normals that follow the deformation correctly. In these systems, normals are transformed from the original mesh or recomputed from the deformed surface so lighting stays believable as panels fold. Without this, dents would look flat or visually disconnected from the car body. The mesh deformation pipeline therefore includes a normal update step after the control-node solve and before final rendering.

## Detachable parts

Bugbear’s damage model also supports **separable components** such as bumpers, hoods/bonnets, doors, and wheels.[15] These parts are modeled as breakable pieces attached to the chassis by constraints or break thresholds. Once enough force accumulates, they detach and become independent objects. That’s why a damaged FlatOut/Wreckfest car can both crumple and shed parts in the same crash.

## Hinges and attachments

Doors, hoods, and similar parts behave like constrained rigid bodies attached to the main structure by **hinges or breakable joints**. The attachment can allow limited motion before failure, so a hood may bend upward, then tear free. In practice, this gives the impression of mechanical hinge behavior while still staying compatible with the game’s faster physics pipeline.

## How the deformable chassis couples to vehicle physics

The chassis deformation is not purely cosmetic: it couples back into the vehicle’s rigid-body physics by altering collision shapes, mass distribution, and often vehicle control behavior. A crushed front end can change how the car contacts the track or other cars, and damage to wheels/suspension can impair steering or traction. The underlying vehicle still moves as a rigid body for performance and stability, but the deformable body feeds the physics system with updated geometry and state so the handling changes with visible damage.

## FlatOut vs. Wreckfest

FlatOut’s public materials emphasized the number of deformable panels, persistence, and the sheer visual brutality of the damage model.[15] Wreckfest carried the same philosophy further, with Bugbear marketing it as soft-body damage modeling and a true-to-life physics simulation.[1][4] The later technical discussions around Rajala’s 2008 paper explain the real-time deformation side more explicitly: shape-matching clusters, iterative stiffness, and plastic rest-shape updates are the practical tools that make the cars feel like they bend convincingly while still running in real time.

## Short version

- FlatOut used many deformable and breakable panels per car, with persistent procedural damage.[15]
- Wreckfest extends that into a node/cluster-based soft-body-like system driven by shape matching and plasticity.[1][4]
- The car body deforms, but the vehicle still rides on a mostly rigid-body physics core.
- Detachable parts use breakable joints/hinges.
- Iteration count controls stiffness, and normals are updated for correct lighting.

If needed, a second pass can turn this into a **paper-style technical summary** with sections for “simulation pipeline,” “solver,” “rendering,” and “physics coupling.”

[1] Wreckfest στο Steam (https://store.steampowered.com/app/228380/Wreckfest/?l=greek&cc=US)
[2] Microsoft Word - DynamicCarDamage_Paper_SmekensRobin.docx (https://static1.squarespace.com/static/5aa06b5d45776efa78eb5d26/t/5c1bfc71032be4feca50056c/1545337983238/paper.pdf)
[3] Does Wreckfest even have soft-body physics? (https://www.reddit.com/r/Wreckfest/comments/1jdbwcd/does_wreckfest_even_have_softbody_physics/)
[4] Wreckfest (2014) - MobyGames (https://www.mobygames.com/game/86875/wreckfest/)
[5] Next car game :: FlatOut 4: Total Insanity กระดานสนทนาทั่วไป (https://steamcommunity.com/app/402130/discussions/0/133261370014681492/?l=thai&ctp=10)
[6] Wreckfest - release date, videos, screenshots, reviews on RAWG (https://rawg.io/games/wreckfest)
[7] Wreckfest - Wikipedia (https://en.wikipedia.org/wiki/Wreckfest)
[8] Wreckfest [PC Games-Digital] (https://www.wog.ch/en/index.cfm/details/product/61765-Wreckfest)
[9] Perfecting Destruction: Racing Game Focuses on the Crash (https://www.siggraph.org/news/perfecting-destruction-racing-game-focuses-on-the-crash/)
[10] Wreckfest details - Metacritic (https://www.metacritic.com/game/wreckfest/details/)
[11] Wreckfest - Complete Edition [PC Games-Digital] (https://www.wog.ch/en/index.cfm/details/product/199301-Wreckfest-Complete-Edition)
[12] Wreckfest - Game Database (https://www.gamepressure.com/games/wreckfest/z93949)
[13] Wreckfest Reviews (https://www.metacritic.com/game/wreckfest/)
[14] Wreckfest (https://steamcommunity.com/app/228380)
[15] FlatOut: Ultimate Carnage Q&A - GameSpot (https://www.gamespot.com/articles/flatout-ultimate-carnage-qanda/1100-6178022/)
