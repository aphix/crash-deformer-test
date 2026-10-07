# Query

How do arcade and semi-sim racing games with crash physics (Burnout 3/Paradise, FlatOut, Wreckfest, BeamNG.drive, Next Car Game) handle crashed and airborne cars: is the wrecked car still a full rigid body (Havok/PhysX/custom), raycast vs collision wheels, ballistic flight when wheels lose ground contact, landing on ramps/slopes (restitution only on approaching normal velocity, settling pitch/roll to ground), car-to-car contact using 3D collision shapes vs 2D, soft-body/deformation layered on rigid body (visual mesh deformation vs node-beam), and how crash impulses are applied to airborne cars. Cite GDC talks, developer interviews, postmortems.

# Result

These games split crash handling into two layers: a driveable vehicle simulation and a wreck/debris simulation. Burnout leans heavily on game-specific crash physics and aftertouch, FlatOut uses a bespoke physics engine with persistent procedural damage, and BeamNG.drive/Next Car Game era tech moves much closer to full soft-body-style vehicle deformation layered on rigid-body or node-beam-style simulation.[2][3][5][11]

## What happens to a crashed or airborne car

- **Burnout 3 / Paradise:** the wreck is still simulated in real time, but the game treats crash-state vehicles specially so they can be steered, explode, and produce large airborne debris; Criterion explicitly described the crashes as real-time deformation rather than pre-baked replay effects.[2][13]
- **FlatOut / Ultimate Carnage:** Bugbear described a bespoke physics system with persistent damage and full dynamic vehicle deformation, implying the wreck remains a live simulated object rather than a purely cinematic prop.[1][3]
- **Wreckfest / Next Car Game lineage:** Bugbear’s later crash-racing work continues that same “active wreck” philosophy, using persistent damage and realistic mass/momentum handling rather than resetting the car after impacts.[3][12]
- **BeamNG.drive:** BeamNG’s public devblog shows the project is centered on ongoing tire/vehicle physics development, and the game is widely known for soft-body-style vehicle simulation rather than a simple rigid car with visual damage.[7]

## Rigid body, soft body, or hybrid?

- **Burnout:** the car is best understood as a hybrid of authored crash behavior and physics-driven wreck motion; the interviews emphasize deformation, collision correctness, and special crash-mode handling rather than a straightforward full rigid-body vehicle simulator.[2][5][13]
- **FlatOut / Wreckfest / Next Car Game:** Bugbear’s wording points to a hybrid with a full physics engine for motion plus procedural/persistent deformation; the damaged car is still an active physical object, but the bodywork damage is layered on top.[1][3]
- **BeamNG.drive:** the vehicle is much closer to a true deformable simulation than a simple rigid body, with the engine built around physically modeled vehicle behavior instead of only visual damage overlays.[7]

## Wheels, ground contact, and airborne motion

- These games generally separate wheel contact from the car body: when wheels lose ground contact, the vehicle continues as a ballistic body under gravity until wheels or body hit something again; Burnout’s crash mode even required special handling so cars could fly naturally off ramps instead of being artificially pinned to the road.[6][13]
- In practice, that means the “drive” model may use tire/contact logic when grounded, but once airborne the car follows free-flight motion until landing re-establishes contact.[6][13]

## Landing on ramps and slopes

- Burnout interviews describe heavy tuning to prevent normal driving physics from launching cars unrealistically, while crash mode used a separate treatment so wrecks could arc through the air convincingly.[6][13]
- The landing behavior in these kinds of systems is usually a mix of collision response and damping: the car bounces only as far as the impact normal allows, then settles as friction and suspension dissipation kill pitch and roll. Criterion’s comments about “magic” layered on top of collision correctness fit that kind of stabilization approach.[5]
- FlatOut’s emphasis on accurate forces, mass, and momentum suggests the same general principle: contact response is physical, but heavily tuned for fun and readability.[3]

## Car-to-car contact: 3D shapes, not 2D

- These games use 3D collision volumes for vehicle interaction, not 2D proxies, because the crashes depend on rollovers, airborne impacts, and deforming chassis geometry.[3][5][13]
- Criterion specifically stressed making sure collisions stay correct in the background, while Bugbear stressed realistic forces and momentum in a full physics engine.[3][5]

## Visual deformation vs true deformation

- **Burnout:** deformation is heavily authored and cinematic, with parts of the car bending, twisting, and squishing in real time; the interview language strongly suggests visual deformation plus crash-specific behavior.[2]
- **FlatOut / Wreckfest:** deformation is procedural and persistent, with damaged geometry tied to the physics engine instead of being a pure cosmetic effect.[1][3]
- **BeamNG.drive:** deformation is the most physically explicit of the group, aiming for simulation of the vehicle structure itself rather than only a deforming mesh.[7]

## How crash impulses are applied to airborne cars

- In Burnout-style crash modes, once the car is no longer under normal driving control, the crash system applies impulses to the wreck so it keeps traveling through the air, and aftertouch lets the player influence that post-impact trajectory.[2][13]
- In Bugbear’s games, the same general idea appears as procedural damage tied to a physics engine that preserves momentum and continues simulating the wreck after the hit.[1][3]
- The key design choice is that crash impulses are not just one-time effects; they become part of the ongoing rigid-body or hybrid simulation until the wreck comes to rest.[3][5]

## Bottom line

- **Burnout**: highly tuned arcade crash simulation with real-time deformation and special crash-state flight/control.[2][5][13]
- **FlatOut / Wreckfest / Next Car Game**: bespoke physics with persistent, procedural damage layered onto active vehicle simulation.[1][3]
- **BeamNG.drive**: the closest to full deformable vehicle physics, with tire and vehicle systems built around simulation rather than cinematic damage.[7]

[1] FlatOut: Ultimate Carnage - Bugbear Interview (https://games.kikizo.com/news/200706/084_p1.asp)
[2] Burnout 3 Interview - IGN (https://www.ign.com/articles/2004/03/16/burnout-3-interview)
[3] FlatOut: Ultimate Carnage Q&A - GameSpot (https://www.gamespot.com/articles/flatout-ultimate-carnage-qanda/1100-6178022/)
[4] FlatOut (2004) - MobyGames (https://www.mobygames.com/game/15632/flatout/)
[5] The Criterion Tech Interview: Part Two | Digital Foundry (https://www.digitalfoundry.net/articles/digital-foundry-criterion-interview-part-two)
[6] Criterion's Crash Physics Secrets Revealed: Burnout's ... (LinkedIn post) (https://www.linkedin.com/posts/mayankgrover_%F0%9D%90%93%F0%9D%90%A1%F0%9D%90%9E-%F0%9D%90%9B%F0%9D%90%9E%F0%9D%90%AC%F0%9D%90%AD-%F0%9D%90%9C%F0%9D%90%AB%F0%9D%90%9A%F0%9D%90%AC%F0%9D%90%A1%F0%9D%90%9E%F0%9D%90%AC-%F0%9D%90%A2%F0%9D%90%A7-activity-7433760450355564544-BVXQ)
[7] Devblog - BeamNG.drive (https://beamng.com/game/news/blog/)
[8] Burnout 3: Takedown (https://gamicus.fandom.com/wiki/Burnout_3:_Takedown)
[9] Episode 54: Burnout 3: Takedown - Retro Spectives Podcast (https://www.rspodcast.net/episodes/episode-54-burnout-3-takedown)
[10] Crash (Burnout 3) - Burnout Wiki - Fandom (https://burnout.fandom.com/wiki/Crash_(Burnout_3))
[11] Iain Angus Burnout Paradise interview (https://caneandrinse.com/iain-angus-burnout-paradise-interview/)
[12] Bugbear Entertainment (https://vgtimes.ru/tags/Bugbear/)
[13] Burnout 3: Takedown Feature Preview - GameSpot (https://www.gamespot.com/articles/burnout-3-takedown-feature-preview/1100-6104473/)
[14] Have You Played... FlatOut: Ultimate Carnage? (https://www.rockpapershotgun.com/flatout-pc-review)
[15] 10-02-26 FULL SHOW (https://www.audacy.com/podcasts/ae7afee10343563af627f05c6559042f/episodes/100226_full_show-8721924)
