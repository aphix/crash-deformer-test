# Query

Rapier physics engine DynamicRayCastVehicleController (rapier3d / @dimforge/rapier3d-compat 0.19 JavaScript API): how does it work internally — per-wheel raycast suspension, chassis rigid body, suspensionStiffness, suspensionCompression/Relaxation damping, maxSuspensionTravel, frictionSlip, sideFrictionStiffness, updateVehicle(dt) call order relative to world.step; what happens when wheel rays miss (airborne: no suspension or friction forces, chassis flies ballistically); applying external impulses to the chassis (applyImpulse, applyImpulseAtPoint) for crashes; performance cost per vehicle; cross-platform determinism of rapier wasm (enhanced-determinism feature); async WASM init / load before simulation. Cite docs, source code (vehicle_controller.rs) and examples.

# Result

The vehicle controller uses a single dynamic chassis rigid body plus per-wheel raycasts to simulate suspension and tire contact, and `updateVehicle(dt)` should be called before each physics step so the raycasts and resulting forces are applied for that frame[5][8][1]. When a wheel ray hits the ground, the controller computes suspension and friction forces from the contact point and applies them to the chassis rigid body; when a ray misses, that wheel contributes no suspension or friction force, so the chassis behaves ballistically until contact returns[5][8][10].

## How it works internally

- The chassis is a normal dynamic rigid body, and each wheel is represented only by a raycast, not by a separate wheel body[5][8].
- Each wheel is configured by its attachment point on the chassis, suspension direction, axle direction, suspension rest length, and wheel radius[8].
- The controller was ported from Bullet’s `btRaycastVehicle`, so the overall structure is the familiar “raycast car” model: spring-like suspension plus tire forces derived from ground contact[5][8].

## Parameters and what they affect

- `suspensionStiffness` controls how strongly the suspension pushes back as the ray compression changes[5][8].
- `suspensionCompression` and `suspensionRelaxation` control damping when the suspension is compressing versus extending[5][8].
- `maxSuspensionTravel` limits how far the wheel can move away from its rest position along the suspension axis[8].
- `frictionSlip` affects longitudinal tire grip / how much force the wheel can transmit before slipping[8].
- `sideFrictionStiffness` scales lateral grip, affecting how strongly the wheel resists sideways sliding[8].

## Update order relative to `world.step`

- The controller is updated before each timestep, meaning the usual pattern is: set wheel inputs, call `updateVehicle(dt)`, then call `world.step()`[5][8].
- That ordering matters because the update performs the raycasts and applies the vehicle’s suspension/friction impulses for the next physics integration step[5][8].

## Airborne behavior

- If a wheel ray does not hit anything, that wheel is effectively airborne: no suspension force, no tire friction force, and no ground reaction from that wheel[5][8][10].
- In that state the chassis continues under normal rigid-body forces only, so it can fly or tumble ballistically until wheels contact the ground again[5][8].

## External impulses for crashes

- The chassis is just a rigid body, so crash effects can be produced with ordinary rigid-body impulses such as `applyImpulse` and `applyImpulseAtPoint` on the chassis body[6].
- `applyImpulseAtPoint` is the better choice for off-center impacts because it adds both linear momentum and torque, which makes collisions look more like real hits on a vehicle body[6].

## Performance cost

- The main per-vehicle cost is the set of wheel raycasts and the subsequent force calculations each frame[5][8][10].
- In practice, the expense scales roughly with the number of wheels because each wheel needs its own ray query against the world; the controller is generally lightweight compared with full wheel-body contact simulation[5][10].

## Determinism

- The WASM/TypeScript/JavaScript build is documented as fully cross-platform deterministic, assuming the same initial conditions and the same version of Rapier[3][4].
- For native Rust builds, cross-platform determinism requires the `enhanced-determinism` feature and IEEE-754-compliant platforms; it cannot be enabled together with `simd8`[4][9][12].
- Determinism also depends on the rest of the simulation setup being deterministic, including any values you compute before feeding them into Rapier[4][9].

## Async WASM init / load order

- In JavaScript/WASM usage, Rapier must be loaded and initialized before any world or vehicle simulation code runs, because the physics types and controller objects are created from the initialized module[1][6][14].
- Practically, that means awaiting the WASM initialization step before creating the world, chassis body, or vehicle controller, and only then entering your simulation loop[1][6][14].

[1] DynamicRayCastVehicleController | @dimforge/rapier3d (https://rapier.rs/javascript3d/classes/DynamicRayCastVehicleController.html)
[2] rapier/src/control/ray_cast_vehicle_controller.rs at master · dimforge/rapier (https://github.com/dimforge/rapier/blob/master/src/control/ray_cast_vehicle_controller.rs)
[3] Determinism - Rapier physics engine (https://rapier.rs/docs/user_guides/templates/determinism/)
[4] Determinism - Rapier.rs (https://rapier.rs/docs/user_guides/templates_injected/determinism/)
[5] Controllers - Rapier physics engine (https://rapier.rs/docs/user_guides/rust/character_controller/)
[6] World | @dimforge/rapier3d (https://rapier.rs/javascript3d/classes/World.html)
[7] Collisions (https://rapier.rs/docs/user_guides/templates/character_controller/)
[8] Character controller (https://rapier.rs/docs/user_guides/javascript/character_controller/)
[9] Determinism (https://rapier.rs/docs/user_guides/rust/determinism/)
[10] Character Controllers | dimforge/rapier | DeepWiki (https://deepwiki.com/dimforge/rapier/6-character-controllers)
[11] rapier3d::control - Rust - Docs.rs (https://docs.rs/rapier3d/latest/rapier3d/control/index.html)
[12] Determinism - Rapier.rs (https://rapier.rs/docs/user_guides/c/determinism/)
[13] Rapier Physics v1 (https://tresjs.org/blog/tresjs-rapier-v1)
[14] Getting started | Rapier (https://rapier.rs/docs/user_guides/templates_injected/getting_started/)
[15] Build System and Development | dimforge/rapier | DeepWiki (https://deepwiki.com/dimforge/rapier/10-build-system-and-development)
