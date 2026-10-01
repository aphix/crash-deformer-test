Criterion’s Burnout crash system is best described as a realtime mesh deformation setup with authored damage states, while BeamNG.drive uses a true node-and-beam soft-body simulation with per-beam break/deform thresholds. Burnout’s system focused on dramatic visual tearing, part detachment, and slow-motion crash control; BeamNG’s system focuses on physically simulated structure, where different beam types and thresholds shape how a car crumples and preserves the occupant cell.[7][14][2]

## Burnout 3 / Revenge / Paradise

- Burnout 3 was already described as real-time deformation where cars “tear apart, morphing and bending,” with tires wobbling, parts falling off, and crash mode slow motion letting the player influence momentum during the wreck.[7][14]
- The public descriptions emphasize that the damage was not just a post-effect: the car could be “effectively” torn in half, with complex deformation plus sparks, smoke, and glass effects happening live during impact.[14][7]
- Burnout’s crash mode used slow motion as part of the gameplay loop, not just a replay feature, so the player could steer the wreck while the scene was slowed down.[7]
- The visible deformation in later Burnout games is generally understood as a hybrid of preauthored destruction states, real-time mesh warping, and detachable components, rather than a full soft-body simulation; however, the search results here do not provide enough developer-level documentation to confirm internal details like deformation cages or streaming strategy.

## BeamNG.drive node-and-beam model

- BeamNG vehicles are built from nodes connected by beams, where nodes are mass points and beams are spring/damper links that give the car its deformable structure.[2][1]
- Beams can break or permanently deform depending on force thresholds: **beamDeform** is the force required for permanent deformation, and **beamStrength** is the force required to break the beam.[2][1][4]
- A beam can deform first and then later snap, so the game can model a crumple zone that wrinkles before failure instead of instantly disintegrating.[2][4]
- BeamNG supports multiple beam types that are useful for different crash behaviors:
- **NORMAL**: standard spring/damper beams for general structure.[4][1]
- **SUPPORT**: resist compression but not extension, useful for keeping cabin volume and preventing collapse.[1][5]
- **ANISOTROPIC**: different behavior in compression vs extension, useful for tires, ropes, and soft tops.[1][9]
- **BOUNDED**: more complex beams with different stiffness/damping by compression and speed range, commonly used for suspension-like behavior such as dampers and bump stops.[1][10]
- **HYDRO**: beams whose length can change on demand, commonly used for steering racks.[1]
- BeamNG tuning often uses lower deform thresholds in front/rear crush structures and much stronger support-style beams in the passenger cell so the front end absorbs energy while the cabin stays rigid.[2][5][1]
- The documentation examples show that some parts use very high or effectively unlimited strength values, while body panels and crumple regions use lower deform and strength values to create progressive damage.[4][5]

## Practical comparison

| Aspect | Burnout | BeamNG.drive |
|---|---|---|
| Core model | Authored realtime mesh deformation and destruction states[7][14] | Physical node-and-beam soft body simulation[2][1] |
| Visible damage | Dramatic bending, tearing, part loss, crash-mode slow motion[7] | Physically driven crumple, snap, and progressive failure[2][4] |
| Rigid cabin strategy | Likely authored structural limits and damage tiers | Support beams and high-strength beams preserve the safety cell[1][5] |
| Part detachment | Tires and body parts can fall off during crashes[7] | Beams break when thresholds are exceeded, freeing connected structures[2][4] |

If needed, a second pass can turn this into a deeper technical breakdown focused separately on Burnout’s likely mesh/deformation pipeline versus BeamNG’s JBeam authoring patterns.

[1] Beams - BeamNG Documentation (https://documentation.beamng.com/modding/vehicle/sections/beams/)
[2] Soft-body Physics - BeamNG.drive (https://www.beamng.com/game/about/physics/)
[3] BeamNG.drive Physics & Tech - Shapes, Inc (https://shapes.inc/fandom/beamng-drive/physics-engine)
[4] Basic Car Tutorial - Autobello Kit Car - BeamNG Documentation (https://documentation.beamng.com/modding/vehicle/tutorials/basic_car_tutorial/)
[5] Support Beams - BeamNG Documentation (https://documentation.beamng.com/modding/vehicle/sections/beams/support/)
[6] WIP - How to Mod a Vehicle (Basics) 2021 (https://www.beamng.com/threads/how-to-mod-a-vehicle-basics-2021.79294/)
[7] Burnout 3: Takedown - IGN (https://www.ign.com/articles/2004/09/02/burnout-3-takedown-2)
[8] Camera - BeamNG Documentation (https://documentation.beamng.com/modding/vehicle/sections/camera/)
[9] Anisotropic Beams - BeamNG Documentation (https://documentation.beamng.com/modding/vehicle/sections/beams/anisotropic/)
[10] Bounded Beams - BeamNG Documentation (https://documentation.beamng.com/modding/vehicle/sections/beams/bounded/)
[11] Why is my JBeam broken? (https://www.beamng.com/threads/why-is-my-jbeam-broken.53869/)
[12] Pressure Wheels - BeamNG Documentation (https://documentation.beamng.com/modding/vehicle/sections/wheels/)
[13] [TUTORIAL] Dummiesman's JBeam Guide - Part 7 : MultiDae (https://www.beamng.com/threads/tutorial-dummiesmans-jbeam-guide-part-7-multidae.13152/)
[14] Burnout 3 Interview - IGN (https://www.ign.com/articles/2004/03/16/burnout-3-interview)
[15] WIP - Generic Shopping Cart (https://www.beamng.com/threads/generic-shopping-cart.52762/)
