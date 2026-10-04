<!-- Generated: 2026-10-03 | Files scanned: 34 | Token estimate: ~1480 -->
# Architecture

Browser crash lab: TanStack Start shell → one React page → `CrashEngine` (three.js, plain classes). All physics is in `src/game/`; React only renders the HUD. The server side is just the WebRTC signaling relay (`/api/rtc`).

```
src/routes/index.tsx  Home ─► src/components/crash-lab.tsx  CrashLab (+ NetPanel)
                                   │ dynamic import("@/game/engine")
                                   ▼
src/game/engine/engine.ts  CrashEngine(canvas)  ── window.__crush (bench / devtools handle)
  │  one class in layers, each `extends` the one before: engine-core.ts EngineCore (state, car roster, shared queries,
  │  crash FX) → engine-warm.ts (shader warm-up, loads the skin kernel) → engine-hud.ts (emitHud) → engine-scenes.ts
  │  (sceneId, setScene and the scene fade, reset / spawn / park, derby netplay, disc edge) → engine-rigs.ts (press,
  │  pistons, doors) → engine-input.ts (keys, pad, picks, HUD commands) → engine-reel.ts (crash highlights) →
  │  engine-share.ts (the `#` URL) → engine.ts CrashEngine (constructor, netplay host, frame loop, LoD, camera)
  ├─ cars: DeformableCar[]        car.ts (layers car-core.ts → car-parts.ts) ─► StreamedDeformation (streamed-deform.ts, layers deform-*.ts; skin-kernel.ts WASM skin); car-panels.ts / loose-dent.ts (peeling panels), car-load.ts LoadTransfer; lamp-lights.ts LampLights
  ├─ classes / handling           vehicle-classes.ts (CLASSES, HANDLING.realism, killTravel), car-drive.ts
  ├─ contacts                     sat.ts, pair-contact.ts, external-contact.ts, engine-props.ts
  ├─ scenes                       fleet.ts, derby*.ts, compactor.ts, piston-rig.ts + engine-pistons.ts,
  │                               door-rig.ts DoorRig + engine-doors.ts DoorRam
  ├─ input/camera                 drive-input.ts, gamepad.ts, engine-camera.ts; spectate-cam.ts (CineCam, DutchCam, camUsable, SightLines, EyePull), shot-cam.ts ShotCam, auto-cam.ts AutoCam, highlight-cam.ts, ride-cam.ts RideCam
  ├─ FX / world                   engine-fx.ts, engine-world.ts WorldStage (night / wet), ground.ts
  ├─ thrown drivers               ragdoll-trigger.ts EjectionWatch → engine-ragdoll.ts RagdollSystem (Rapier through rapier.ts loadRapier; a fixed 1/120 s step out of an accumulator, the draw blends the last two) over ragdoll-body.ts (parts, joints, damping, energy-only soft edits) and ragdoll-ground.ts (the fixed colliders: pad, disc + ramp wedges, corkscrew trimesh, derby bowl, sandbox poles, a course's heightfield and road walls) + ragdoll-solids.ts `courseSolids` (the same prop footprints the cars hit, bridge decks and bents, tunnel shells, gantry legs; built once per course, per throw only those near it), ragdoll-mesh.ts DummyMesh, ragdoll-debug.ts RagdollDebug (limb boxes and joints in the Rig / Particles views); the ride-along's shots are ride-cam.ts
  ├─ cinematics                   engine-cine.ts Cinematics → engine-post.ts PostFX, engine-marks.ts SkidMarks; scene-fade.ts SceneFade (scene switch transition); witness.ts Witness
  ├─ netplay                      net/net-play.ts NetPlay (engine port net/net-ports.ts NetGame) → net/codec.ts, net/net-view.ts drawSnapshots, net/rtc-transport.ts (→ @/lib/multiplayer P2PRoom), net/matchmaking.ts findMatch / RoomPoller (Play online, live rooms), net/net-constants.ts (rates, windows, limits), net/car-pose.ts, net/reel-codec.ts
  ├─ race                         engine-race.ts RaceDirector (+ engine-race-field.ts RaceField) → world/ (track, placements), match/ (session, campaign), ai/ (race-ai, traffic, police), present/track-art.ts
  ├─ trace                        engine-trace.ts (J key, JSON button)
  └─ emitHud() ─► hud-store.ts publishHud ─► useSyncExternalStore in CrashLab ─► components/hud*.tsx
```

## Module boundaries
- `*-core.js` (`physics-core.js`, `shape-match-core.js`): number-only hot kernels, no THREE; typed by `*.d.ts`, re-exported by `physics-util.ts` / `shape-match.ts`.
- `rig-spec.ts`, `vehicle-classes.ts`, `world/catalog.ts`, `world/tracks/*.json` (and the off-menu `havana.json`, the Survival course: `docs/SURVIVAL.md`): data tables. Race rules and campaign (`match/`), AI and traffic (`ai/`) and placements (`world/`) never touch the scene graph or the DOM (`docs/RACE_DESIGN.md`).
- `streamed-deform.ts` and its `deform-*.ts` layers: own masses, clusters, cages, skin. Never touches the scene graph beyond its debug helpers.
- `engine*.ts`: orchestration; `CrashEngine` is the only owner of the frame loop. `engine-cine.ts` and friends read sim state only; the hit-stop is their one sim-side effect (`timeWarp`).
- `ground.ts`: `activeGround()` is what physics, wheels and marks read; `setGround` swaps in a track heightfield, `FLAT_GROUND` is the y = 0 asphalt (derby, rigs). The fleet / barrier / balls scenes set `DISC_GROUND`: the same plane inside `DISC_RADIUS` (48 m), and `NO_FLOOR` (-Infinity, grip 0) past it. Every `floor + k` clamp tests `=== NO_FLOOR` first (`car.integrate`, `followGroup`, the `stepStructure` mass loop, `applyDrive`).

## Per-frame flow (`engine.ts`)
```
tickInner(now)                               wallDt ≤ 0.1 s
 ├ pollInput()                               keys + pad → DriverSeat
 ├ stepSceneFade(wallDt)                    scene switch: cel pulse → black → switch → fade-in; the new scene's sim waits while it is black (never in netplay or the results replay)
 ├ simDt = wallDt × timeScale × cine.timeWarp (slow-mo ramp, hit-stop)
 ├ SimPacer.run: whole steps of h = physicsSlice(∞, sliceSpeed(cars)) × min(1, timeScale) while sim time is owed, the last one running past the
 │   frame's time by < h; ≤ 8 steps, 8 ms of steps (counted from the first step); what a stopped frame did not step is dropped (`lost`), never carried
 │   (sim-pace.ts). Per step PoseBlend.begin/end keep the cars' poses either side of it.
 │   fixedStep(h):
 │     applyDrive (player seat, derby AI via DerbyBrain.think, net.drive for remote peers on the host; in a race, race.drive drives every car)
 │     stepWorld(world, h)  (world-step.ts; every headless harness calls it too) → 1–3 slices:
 │       integrate / syncPose
 │       collideWith (mass spheres) + partContactPair (doors / mirrors), car pairs ≤ ~5.3 m
 │       contact loop ×1..3: barrier.resolve · resolveCarPair (derby hit credit) · ramp balls · lamp poles
 │       deform.stepStructure(h) → syncPose → barrier.clip → afterContacts → clipDerbyCar → race.collide (walls, props)
 │       (rig scenes: stepCompactor / stepPistons / stepDoors instead)
 │     race.step(h) (rules: gates, laps, respawns); the strongest hit starts the impact (beginImpact)
 │   cutDrive, bleedAfterSlide
 ├ stepEdge()                               fleet disc: `edgeAction` (fleet.ts): 2 m below the top a car becomes a fake (`beginFakeFall`: soft body off, ballistic drop + constant spin), 20 m below it vaporizes (`setVaporized`: smoke, hidden, out of the sim), the driven one respawns after 2 s (`respawnOnDisc`)
 ├ scheduleSkins(cars) → car.updateSkin()           witness.aim(camera), then LoD stride (0 outside the cone, else by projected size) → skin
 ├ updatePhase (stepPhase) · FX (`witness.sees` gates the spawns) · ragdolls.update · trace · stepDerby · seat.step · cine.update (marks, tyre smoke, punch)
 ├ net.frame(wallDt)                         host: send snapshots; client: apply them instead of physics
 ├ PoseBlend.present(cars, pace.alpha)       every car (group, torn parts, popped wheels) drawn at the frame's time between its poses either side of the last step; restore() after the draw puts the sim's own poses back bit for bit (present/pose-blend.ts)
 ├ race.frame(wallDt)
 ├ updateCamera(wallDt)                      cine.direct crash cam first, else chase / orbit / ride / spectator cams
 ├ flushVisibleSkins() (aims `witness` at the final camera, catches owed skins up) · cullFarDetail · lampLights.update · stage.syncPools (night)
 ├ cine.render(scene, camera)                tier off: renderer.render; low / high: HDR post chain (with the scene fade's cel pass)
 └ emitHud()  every 0.05–0.12 s
```
`phase`: `approach → impact → slowmo → aftermath` (`phase.ts`: `CrashPhase`, `PhaseClock`, `easeTimeScale`, `beginImpact`, `stepPhase`, shared with the headless harnesses); `beginCinematic` fires on the first strong contact and calls `cine.impact`.
`Witness` (`present/witness.ts`): the one broad "could the camera see this?" test, `mayWitness(center, radius)` = the camera frustum grown by 1.5 m + the radius, occluders ignored on purpose. It only gates cosmetic work: off-cone skins (`skinStride` 0, caught up by `flushVisibleSkins`) and FX spawns (`sees(at, FX_REACH.x)`: sparks, debris, glass, engine smoke, tyre smoke and scrape sparks). Never gated: the sim, audio, tyre marks, the crash cinematic's own bursts, ragdoll exits. `witness.enabled` / `gateFx` switch it off for A/B probes. `cullFarDetail` (distance, not view): past `DETAIL_NEAR` (35 m) a car's small non-shadow parts leave camera layer 0 until it is back within `DETAIL_BACK` (32 m); lamp seats go too (the lamp batch skips a seat off layer 0), a hinged panel's shell stays (the body under it is primer).
`SceneFade` (`present/scene-fade.ts`): the scene picker's transition, wall-clock presentation only. `setScene` requests it; `stepSceneFade` advances it each frame: the view eases into a cel look (`PostFX.cel`: 5 bands plus Sobel outlines in the existing composite pass, 0.25 s), cuts to black, `applyScene` switches on the first black frame, black holds through the new scene's first-use warm-ups (`warmsInFlight`, up to `FADE.waitMax` = 3 s; the new scene's sim waits too, `holding`, except in netplay and the results replay), then it fades in (0.2 s black, 0.35 s cel). With the canvas-only tiers (off / minimal) or reduced motion it is a plain 0.2 s fade. Black is a DOM veil over the canvas and the HUD (no pointer events) at every tier. The boot, the shared `#` link and netplay switch at once, and so does `window.__crush.fadeScenes = false` (probes).

## Scenes (one at a time: `sceneId` + `setScene()` in `engine-scenes.ts`)
| Scene | Key | Entry | Code |
|---|---|---|---|
| Fleet (default) | R | `spawnFleet` | `fleet.ts` `layoutFleet`, `fleetStyle` |
| Barrier | B | `toggleBarrier` | `engine-props.ts` `JerseyBarrier`, `sat.ts` |
| Ramp balls | K | `toggleBalls` | `engine-props.ts` `buildRampBalls`, `resolveRampBalls` |
| Jump ramps | . (period) | `toggleRamps` | `fleet-ramps.ts` `FleetRamps` (a `Ground` on the slab's ends, `contact` for its side and back faces); cars fly through `car-air.ts` `stepAir` |
| Compactor | C | `toggleCompactor` | `compactor.ts` `CompactorRig`, `engine-props.ts` `CompactorPress` |
| Pistons | I, 0–8 | `togglePistons`, `firePiston` | `piston-rig.ts`, `engine-pistons.ts` `PistonBank` |
| Doors | N, 1–5 | `toggleDoors`, `fireDoorRam`, `toggleDoorOpen`, `setDoorConfig` | `door-rig.ts` `DoorRig`; `engine-doors.ts` `DoorRam` |
| Corkscrew | , (comma) | `toggleCorkscrew` | `corkscrew.ts` `Corkscrew` (a `Ground`: the twisted channel over the pad, `contact` for its walls), `CORKSCREW`; the world step flies the car, `EngineRigs.watchCorkscrew` times slow-mo and the cinematic. The spawn-speed slider decides the stunt: ≤ 7 m/s no air, 12–15 roof, 20–25 a full roll back onto the wheels, 26–28 roof, 29–32 two rolls onto the wheels |
| Range | (HUD) | `toggleRange` | `scenes/range.ts` `RANGE`, `RangeRun`; `present/range-art.ts` `makeRangeArt`; the thrown driver above |
| Derby | D | `toggleDerby` | `derby.ts` `DerbyMatch`, `derby-ai.ts` `DerbyBrain`, `derby-arena.ts` |
| Race | Z | `toggleRace`, `raceCommand(cmd)` | `engine-race.ts` `RaceDirector`; `match/session.ts` `RaceSession`, `race-ai.ts` `RaceBrain`, `track.ts` `Track` / `TrackGround` (via `setGround`) |
| Survival | bottom bar, `#scene=survival` | `toggleSurvival`, `raceCommand(cmd)` | `engine-race.ts` `RaceDirector` (`enter(true)`), `engine-race-field.ts` (`start` with `survival`, `hidden`, `settle`); `ai/hunter.ts` `HunterBrain`, `ai/police.ts` (`attackTarget`, `pursuitSteer`, `Backoff`); `match/session.ts` (`survival` option), `match/survival.ts`; `engine/survival-store.ts`; `components/survival-hud.tsx` |

Every transition, loop and reset ends in `randomizeAndReset`, whose first act is `clearScene()` (`EngineCore`: bumps the count snapshots carry so a netplay client clears the same way, then `clearLocal()` = `clearTransients(...)`). A race start, retry and next (`RaceField.start` via `RaceHost.clear`) go through it too; the results reel clears locally with `clearLocal()` when a clip sets up and when the reel ends (every peer plays its own reel, so no count) (`engine/scene-clear.ts`, before the scene spawns its cars, so under the fade's black or not). It resets every built car (hidden ones past the live count too: their torn panels and loose wheels hang in the scene root), the lamp poles, the debris / spark / glass-dot / smoke pools, the ragdolls (dummies and their Rapier bodies), `RangeRun` and `cine` (tyre marks, tyre smoke). A new debris-like system joins the `Transients` interface and `EngineCore.clearLocal()`; `scene-clear.test.ts` has a row per `Transients` key (a key without a row fails tsc).

Rig scenes (press, pistons, doors) park one car and drive a kinematic striker through `external-contact.ts`. Lamp poles are hit in the fleet / barrier / balls contact loop and hidden in derby. A race hides the sandbox floor and swaps in its course; while a race menu is open the HUD owns the keyboard and pad. In the fleet scenes a car driven or shoved past the disc's rim falls under the real sim (`DISC_GROUND`) for 2 m, then as a frozen fake (`car.falling`: no masses, contacts or skin, skipped by the pair loops), shrinks over its last 4 m and vaporizes 20 m down. `car.vaporized` cars skip `integrate` / `updateDeform`, are hidden, and stay gone until reset unless they are the driven car. A followed falling car gets `ChaseCamera.watchFall`: the eye settles at shoulder height just inside the rim and keeps the car centred, then holds. Netplay replicates the fake and vaporize events.

## Deploy
Nitro builds either the Vercel preset (`npm run build`) or a `node-server` (`npm run build:node`, `APP_BASE` sub-path). The self-hosted kit in `deploy/` is pull-based: a systemd timer runs `crush-deploy.sh` (fetch `main`, build a release, health-check on a spare port, swap the `current` symlink, restart `crush.service`), and nginx proxies the base path. See `docs/DEPLOY.md`.

## Related
[physics.md](physics.md) · [frontend.md](frontend.md) · [testing.md](testing.md) · [dependencies.md](dependencies.md) · `docs/RIG_ANALYSIS.md` · `docs/MULTIPLAYER.md` · `docs/CINEMATIC.md` · `.extraResearch/SYNTHESIS.md`
