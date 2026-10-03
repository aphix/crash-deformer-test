<!-- Generated: 2026-10-02 | Files scanned: 16 | Token estimate: ~1310 -->
# Frontend: React HUD, input, camera, netplay panel

## Component tree
```
src/router.tsx getRouter() → routeTree.gen.ts
src/routes/__root.tsx  createRootRoute (head meta)
src/routes/index.tsx   "/" → Home
  └ components/crash-lab.tsx  CrashLab
      ├ <canvas>  ← new CrashEngine(canvas): engine.start(); cleanup engine.dispose()
      ├ components/net-panel.tsx  NetPanel        top-centre "Net" button → host / join / Public race, invite link + QR
      └ components/hud.tsx  Hud(HudProps)
          ├ hud-panels.tsx  PistonPanel · DoorPanel · DerbyBoard   (only in their scene)
          ├ race-hud.tsx  RaceStandings · RaceOverlay (menus) · SpectateBar · RaceViewToggle;
          │   use-pad-menu.ts: pad / keyboard menu focus (hud/menu-nav.ts); HUD → engine.raceCommand(cmd)
          ├ race-readouts.tsx  RaceReadouts: position, lap, clocks and the speed / gear / boost gauge of the driven or watched car
          ├ hud-sections.tsx  HudSections   accordion: Playback · Driving · Cars & crash · Debug views
          ├ touch-controls.tsx  TouchControls (thumb pad, coarse pointer only, via use-coarse-pointer.ts) · FullscreenButton
          └ ui/button.tsx
src/routes/api/rtc.ts  /api/rtc → src/lib/multiplayer/signaling.server.ts (signaling relay, the only server route the game uses)
components/preview-host-bridge.tsx  PreviewHostBridge (platform preview hook, renders null)
```
`CrashLab` loads the engine with a dynamic `import("@/game/engine")`; boot errors render as text. The engine sets `window.__crush = this` (used by `scripts/bench-browser.mjs` and the `.bench` probes).

## HUD state (`src/game/hud/hud-store.ts` `HudStore`)
```
CrashEngine.emitHud() ──► HudStore.publish(next: CrashHudState)   snapshot + listeners Set, one store per engine
CrashLab: new HudStore() ─► new CrashEngine(canvas, store); useSyncExternalStore(store.subscribe, store.get) ──► <Hud state=…>
Hud button ──► engineRef.current?.toggleX() / setX(v) ──► engine state ──► emitHud()
```
- `CrashHudState`: scene toggles (playing, looping, showRig, showParticles, showBarrier, showBalls, showCompactor, showPistons, doors, derby, autoRotate, autoSlomo, audioOn, deformMode), cinematic (`fxTier`, `night`, `wet`), `PistonHud`, `DoorHud`, telemetry (`phase: CrashPhase`, timeScale, speeds, closingKph, impactKph, fps, `compactStage`), tunables (squash shown as stroke, buckle shown as wrinkle, fxDensity, carCount, speedMin/Max), driving (`playerClass`, `realism`, boost, seat / view / pad label), derby board.
- `INITIAL_HUD` holds the defaults that `resetDefaults()` restores; `KNOB_RANGES`, `STROKE_RANGE_M`, `strokeAt56` / `squashForStroke` map slider units.
- Engine setters the HUD calls: `togglePlay`, `toggleLoop`, `toggleRig`, `toggleParticles`, `toggleBarrier`, `toggleBalls`, `toggleCompactor`, `togglePistons`, `firePiston(i)`, `setPistonConfig(patch)`, `toggleDoors`, `fireDoorRam(scenario)`, `toggleDoorOpen`, `setDoorConfig(patch)`, `toggleDerby`, `toggleOrbit`, `toggleSlomo`, `toggleAudio`, `setFxTier`, `setNight`, `setWet`, `toggleDeformMode`, `setSquash`, `setBuckle`, `setFxDensity`, `setRealism`, `setPlayerClass`, `setCarCount`, `setSpeedRange(min, max)`, `setTimeScale`, `toggleCapture`, `copyTraceJson`, `resetDefaults`, `reset`, `watchCar(i)`.

## Netplay panel (`net-panel.tsx`)
Polls `engine.net.status()` every 0.5 s. Host / Join take a room code (`[A-Z0-9]`, ≤ 12) and a link: Internet (WebRTC, `rtc`) or This browser (BroadcastChannel, `bc`). **Public race** / **Public derby** call `net.publicMatch("race" | "derby")`: the first room of that kind from `GET api/rtc?list=public&kind=…` (open rooms with a live host and a free seat, fullest first), else a new one hosted with a lobby countdown. A private room shows **Copy invite link** (`<origin><BASE_URL>?net=join&room=CODE`) and a QR (`@/lib/qr`); opening such a link auto-joins. Room size: `ROOM_MAX` (8) in `src/lib/multiplayer/rooms.ts`.

## Input
```
keydown/keyup → CrashEngine.keys: Set<code> + onKey (scene / FX keys)
touch-controls.tsx stick / buttons → engine.touch (GamepadInput.touch: x, y, held, tapped)
tickInner → pollInput()
  pad.poll()   gamepad.ts GamepadInput → readPad(src, out: PadState) (deadzone, edges) → mergeTouch(touch, out, prev)
  view.rear = Backquote or R3 held (no race menu)
  seat.sample(keys, pad) → readIntent(keys, pad, out): DriveIntent   (drive-input.ts)
fixedStep(h)
  seat.input(car, dt) → shapeDrive(intent, feel, along, dt, out): DriveInput (slew, lock, reverse)
  applyDrive(car, input: DriveInput, dt)   same call for derby AI (DerbyBrain.think) and remote peers (NetPlay.drive)
```
- `DriverSeat` (`car-drive.ts`): `mode: "global" | "follow" | "drive"`, `view: "third" | "far" | "first"`, `focus(i)`, `cycle(dir, n)`, `esc()`, `cycleView()`, `step(dt)` (boost), `addBoost(amount)`.
- Scene / FX keys in `onKey`: Space R L G P B K D C I N O M U Y J F H X Z, digits for the piston and door rigs. In a race, `raceKey` / `racePad` take Esc R Q E V C T H first; with a race menu open the HUD reads keys and pad itself. The controls tables live in `docs/CONTROLS.md`.
- Touch: the stick maps x → left stick, up → RT, down → LT; buttons set `PAD_BUTTON` bits (south handbrake, west boost, north view, down recover / respawn, lb / rb car, back Esc / pause, r3 look back). `tapped` latches a press shorter than a frame. Only the engine's `GamepadInput` merges it; the menus' own instance never sees it.
- Click a car: `ChaseCamera` tap → `CrashEngine.pickCar(x, y)` (raycast) → `seat.focus(i)`. A second finger on the canvas pinch-zooms.

## Camera (`src/game/present/engine-camera.ts`, `spectate-cam.ts`, `engine-cine.ts`)
- `Spring`, `Spring3`: critically damped springs, exact for any dt. `CHASE`: third / far / hood-cam tuning, FOV, look-around.
- `DriveCam`: chase and hood cam for the driven car; mouse / right-stick look, eases back (a spectator's `keep` holds a dragged look).
- `ChaseCamera`: orbit / zoom / tap; `frameReset`, `orbit(wallDt, spinRate, shake)`, `frameDrive`, `kick` on impact; `userFramed` stops cinematic re-aiming. A drag moves whatever framed the last frame (`rig`): the orbit, a chase's look, or nothing (trackside, wheel cam). `lookBack(car)` / `unflip()`: the rear-view hold, the chase offset mirrored ahead of the car, snapped; the rigs' own shot is parked and restored before the next frame's rigs run.
- Spectator cams (following, not driving): `SpecView` = the three chase views, `"cine"`, `"dutch"`, `"orbit"`; View (V / T, Y, the Spectating bar's camera button) runs `CrashEngine.cycleCamera` → `cycleSpec`. A race opens on the seat's chase view, fleet / derby on the orbit; back to the whole field resets it. `frameSpectate(car, view, scene, dt, shake)`.
- `CineCam` (`spectate-cam.ts`): a fixed eye ahead of the car (along the race loop, or along its travel off a race), 0.6–4.1 m up, out of every solid (`Sight`: ground and bridge slabs, race walls and tunnels, props at their drawn size, the gantry legs, bridge pillars, the other cars, the derby rim) with clear sight to the car; it cuts `CINE.after` s after the car passes. The search spends `CINE.perFrame` sight-line samples a frame; nothing runs per frame between searches. `DutchCam`: eight wheel-well mounts (forward / back), rolled 0.3 rad, cutting every ~3.5 s to the mount with the most rivals in its frustum. Both are deterministic from the car poses (`reset(seed)`).
- `CrashEngine.updateCamera(wallDt)`: `unflip`, then `aimRigs`: `cine.direct` (crash cam: three cuts in the slow-mo, letterboxed) first; else driving → `frameDrive`; following (off the rigs) → `frameSpectate`; else look at the followed car, rig car, derby winner or fleet centroid, then orbit. Then, while `view.rear` is held and a car is followed, `lookBack`.

## Related
[architecture.md](architecture.md) · [physics.md](physics.md) · `docs/CONTROLS.md` · `docs/CINEMATIC.md` · `docs/MULTIPLAYER.md`
