<!-- Generated: 2026-10-02 | Files scanned: 34 | Token estimate: ~1480 -->
# Architecture

Browser crash lab: TanStack Start shell → one React page → `CrashEngine` (three.js, plain classes). All physics is in `src/game/`; React only renders the HUD. The server side is just the WebRTC signaling relay (`/api/rtc`).

```
src/routes/index.tsx  Home ─► src/components/crash-lab.tsx  CrashLab (+ NetPanel)
                                   │ dynamic import("@/game/engine")
                                   ▼
src/game/engine.ts  CrashEngine(canvas)  ── window.__crush (bench / devtools handle)
  ├─ cars: DeformableCar[]        car.ts ─► StreamedDeformation (streamed-deform.ts); lamp-lights.ts LampLights
  ├─ classes / handling           vehicle-classes.ts (CLASSES, HANDLING.realism, killTravel), car-drive.ts
  ├─ contacts                     sat.ts, pair-contact.ts, external-contact.ts, engine-props.ts
  ├─ scenes                       fleet.ts, derby*.ts, compactor.ts, piston-rig.ts + engine-pistons.ts,
  │                               door-rig.ts DoorRig + engine-doors.ts DoorRam
  ├─ input/camera                 drive-input.ts, gamepad.ts, engine-camera.ts
  ├─ FX / world                   engine-fx.ts, engine-world.ts WorldStage (night / wet), ground.ts
  ├─ cinematics                   engine-cine.ts Cinematics → engine-post.ts PostFX, engine-marks.ts SkidMarks
  ├─ netplay                      net/net-play.ts NetPlay (engine port net/net-ports.ts NetGame) → net/codec.ts, net/net-view.ts drawSnapshots, net/rtc-transport.ts (→ @/lib/multiplayer P2PRoom)
  ├─ race                         engine-race.ts RaceDirector → race/ (track, session, campaign, race-ai, traffic, track-art)
  ├─ trace                        engine-trace.ts (J key, JSON button)
  └─ emitHud() ─► hud-store.ts publishHud ─► useSyncExternalStore in CrashLab ─► components/hud*.tsx
```

## Module boundaries
- `*-core.js` (`physics-core.js`, `shape-match-core.js`): number-only hot kernels, no THREE; typed by `*.d.ts`, re-exported by `physics-util.ts` / `shape-match.ts`.
- `rig-spec.ts`, `vehicle-classes.ts`, `race/catalog.ts`, `race/tracks/*.json`: data tables. `race/` rules, campaign, AI, traffic and placements never touch the scene graph or the DOM (`docs/RACE_DESIGN.md`).
- `streamed-deform.ts`: owns masses, clusters, cages, skin. Never touches the scene graph beyond its debug helpers.
- `engine*.ts`: orchestration; `CrashEngine` is the only owner of the frame loop. `engine-cine.ts` and friends read sim state only; the hit-stop is their one sim-side effect (`timeWarp`).
- `ground.ts`: `activeGround()` is what physics, wheels and marks read; `setGround` swaps in a track heightfield, `FLAT_GROUND` is the y = 0 asphalt (derby, rigs). The fleet / barrier / balls scenes set `DISC_GROUND`: the same plane inside `DISC_RADIUS` (48 m), and `NO_FLOOR` (-Infinity, grip 0) past it. Every `floor + k` clamp tests `=== NO_FLOOR` first (`car.integrate`, `followGroup`, the `stepStructure` mass loop, `applyDrive`).

## Per-frame flow (`engine.ts`)
```
tickInner(now)                               wallDt ≤ 0.1 s
 ├ pollInput()                               keys + pad → DriverSeat
 ├ simDt = wallDt × timeScale (slow-mo ramp, hit-stop); acc ≤ 0.05
 ├ while acc: h = physicsSlice(acc, sliceSpeed(cars))   ≤ 8 steps, 8 ms budget
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
 ├ scheduleSkins(cars) → car.updateDeform(simDt)   LoD stride / frustum → skin
 ├ net.frame(wallDt)                         host: send snapshots; client: apply them instead of physics
 ├ updatePhase (stepPhase) · FX · cine.update (marks, tyre smoke, punch) · trace · stepDerby · seat.step · race.frame
 ├ updateCamera(wallDt)                      cine.direct crash cam first, else chase / orbit
 ├ flushVisibleSkins() · lampLights.update · stage.syncPools (night)
 ├ cine.render(scene, camera)                tier off: renderer.render; low / high: HDR post chain
 └ emitHud(false)  every 0.05–0.12 s
```
`phase`: `approach → impact → slowmo → aftermath` (`phase.ts`: `CrashPhase`, `PhaseClock`, `easeTimeScale`, `beginImpact`, `stepPhase`, shared with the headless harnesses); `beginCinematic` fires on the first strong contact and calls `cine.impact`.

## Scenes (one at a time; toggles in `engine.ts`)
| Scene | Key | Entry | Code |
|---|---|---|---|
| Fleet (default) | R | `spawnFleet` | `fleet.ts` `layoutFleet`, `fleetStyle` |
| Barrier | B | `toggleBarrier` | `engine-props.ts` `JerseyBarrier`, `sat.ts` |
| Ramp balls | K | `toggleBalls` | `engine-props.ts` `buildRampBalls`, `resolveRampBalls` |
| Compactor | C | `toggleCompactor` | `compactor.ts` `CompactorRig`, `engine-props.ts` `CompactorPress` |
| Pistons | I, 0–8 | `togglePistons`, `firePiston` | `piston-rig.ts`, `engine-pistons.ts` `PistonBank` |
| Doors | N, 1–5 | `toggleDoors`, `fireDoorRam`, `toggleDoorOpen`, `setDoorConfig` | `door-rig.ts` `DoorRig`; `engine-doors.ts` `DoorRam` |
| Derby | D | `toggleDerby` | `derby.ts` `DerbyMatch`, `derby-ai.ts` `DerbyBrain`, `derby-arena.ts` |
| Race | Z | `toggleRace`, `raceCommand(cmd)` | `engine-race.ts` `RaceDirector`; `race/session.ts` `RaceSession`, `race-ai.ts` `RaceBrain`, `track.ts` `Track` / `TrackGround` (via `setGround`) |

Rig scenes (press, pistons, doors) park one car and drive a kinematic striker through `external-contact.ts`. Lamp poles are hit in the fleet / barrier / balls contact loop and hidden in derby. A race hides the sandbox floor and swaps in its course; while a race menu is open the HUD owns the keyboard and pad. In the fleet scenes a car driven or shoved past the disc's rim falls under the real sim (`DISC_GROUND`) for 2 m, then as a frozen fake (`car.falling`: no masses, contacts or skin, skipped by the pair loops), shrinks over its last 4 m and vaporizes 20 m down. `car.vaporized` cars skip `integrate` / `updateDeform`, are hidden, and stay gone until reset unless they are the driven car. A followed falling car gets `ChaseCamera.watchFall`: the eye settles at shoulder height just inside the rim and keeps the car centred, then holds. Netplay replicates the fake and vaporize events.

## Deploy
Nitro builds either the Vercel preset (`npm run build`) or a `node-server` (`npm run build:node`, `APP_BASE` sub-path). The self-hosted kit in `deploy/` is pull-based: a systemd timer runs `crush-deploy.sh` (fetch `main`, build a release, health-check on a spare port, swap the `current` symlink, restart `crush.service`), and nginx proxies the base path. See `docs/DEPLOY.md`.

## Related
[physics.md](physics.md) · [frontend.md](frontend.md) · [testing.md](testing.md) · [dependencies.md](dependencies.md) · `docs/RIG_ANALYSIS.md` · `docs/MULTIPLAYER.md` · `docs/CINEMATIC.md` · `.extraResearch/SYNTHESIS.md`
