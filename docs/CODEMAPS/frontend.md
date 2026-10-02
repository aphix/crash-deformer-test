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
          ├ race-hud.tsx  RaceReadouts · RaceStandings · RaceOverlay (menus) · SpectateBar · RaceViewToggle;
          │   use-pad-menu.ts: pad / keyboard menu focus (race/menu-nav.ts); HUD → engine.raceCommand(cmd)
          ├ hud-sections.tsx  HudSections   accordion: Playback · Driving · Cars & crash · Debug views
          └ ui/button.tsx
src/routes/api/rtc.ts  /api/rtc → src/lib/multiplayer/signaling.server.ts (signaling relay, the only server route the game uses)
components/preview-host-bridge.tsx  PreviewHostBridge (platform preview hook, renders null)
```
`CrashLab` loads the engine with a dynamic `import("@/game/engine")`; boot errors render as text. The engine sets `window.__crush = this` (used by `scripts/bench-browser.mjs` and the `.bench` probes).

## HUD state (`src/game/hud-store.ts`)
```
CrashEngine.emitHud(force) ──► publishHud(next: CrashHudState)   module snapshot + listeners Set
CrashLab: useSyncExternalStore(subscribeHud, getHudSnapshot) ──► <Hud state=…>
Hud button ──► engineRef.current?.toggleX() / setX(v) ──► engine state ──► emitHud(true)
```
- `CrashHudState`: scene toggles (playing, looping, showRig, showParticles, showBarrier, showBalls, showCompactor, showPistons, doors, derby, autoRotate, autoSlomo, audioOn, deformMode), cinematic (`fxTier`, `night`, `wet`), `PistonHud`, `DoorHud`, telemetry (`phase: CrashPhase`, timeScale, speeds, closingKph, impactKph, fps, `compactStage`), tunables (squash shown as stroke, buckle shown as wrinkle, fxDensity, carCount, speedMin/Max), driving (`playerClass`, `realism`, boost, seat / view / pad label), derby board.
- `INITIAL_HUD` holds the defaults that `resetDefaults()` restores; `KNOB_RANGES`, `STROKE_RANGE_M`, `strokeAt56` / `squashForStroke` map slider units.
- Engine setters the HUD calls: `togglePlay`, `toggleLoop`, `toggleRig`, `toggleParticles`, `toggleBarrier`, `toggleBalls`, `toggleCompactor`, `togglePistons`, `firePiston(i)`, `setPistonConfig(patch)`, `toggleDoors`, `fireDoorRam(scenario)`, `toggleDoorOpen`, `setDoorConfig(patch)`, `toggleDerby`, `toggleOrbit`, `toggleSlomo`, `toggleAudio`, `setFxTier`, `setNight`, `setWet`, `toggleDeformMode`, `setSquash`, `setBuckle`, `setFxDensity`, `setRealism`, `setPlayerClass`, `setCarCount`, `setSpeedRange(min, max)`, `setTimeScale`, `toggleCapture`, `copyTraceJson`, `resetDefaults`, `reset`, `watchCar(i)`.

## Netplay panel (`net-panel.tsx`)
Polls `engine.net.status()` every 0.5 s. Host / Join take a room code (`[A-Z0-9]`, ≤ 12) and a link: Internet (WebRTC, `rtc`) or This browser (BroadcastChannel, `bc`). **Public race** / **Public derby** call `net.publicMatch("race" | "derby")`: the first room of that kind from `GET api/rtc?list=public&kind=…` (open rooms with a live host and a free seat, fullest first), else a new one hosted with a lobby countdown. A private room shows **Copy invite link** (`<origin><BASE_URL>?net=join&room=CODE`) and a QR (`@/lib/qr`); opening such a link auto-joins. Room size: `ROOM_MAX` (8) in `src/lib/multiplayer/rooms.ts`.

## Input
```
keydown/keyup → CrashEngine.keys: Set<code> + onKey (scene / FX keys)
tickInner → pollInput()
  pad.poll()   gamepad.ts GamepadInput → readPad(src, out: PadState) (deadzone, edges)
  seat.sample(keys, pad) → readIntent(keys, pad, out): DriveIntent   (drive-input.ts)
fixedStep(h)
  seat.input(car, dt) → shapeDrive(intent, feel, along, dt, out): DriveInput (slew, lock, reverse)
  applyDrive(car, input: DriveInput, dt)   same call for derby AI (DerbyBrain.think) and remote peers (NetPlay.drive)
```
- `DriverSeat` (`car-drive.ts`): `mode: "global" | "follow" | "drive"`, `view: "third" | "far" | "first"`, `focus(i)`, `cycle(dir, n)`, `esc()`, `cycleView()`, `step(dt)` (boost), `addBoost(amount)`.
- Scene / FX keys in `onKey`: Space R L G P B K D C I N O M U Y J F H X Z, digits for the piston and door rigs. In a race, `raceKey` / `racePad` take Esc R Q E V C T H first; with a race menu open the HUD reads keys and pad itself. The controls tables live in `README.md`.
- Click a car: `ChaseCamera` tap → `CrashEngine.pickCar(x, y)` (raycast) → `seat.focus(i)`.

## Camera (`src/game/engine-camera.ts`, `engine-cine.ts`)
- `Spring`, `Spring3`: critically damped springs, exact for any dt. `CHASE`: third / far / hood-cam tuning, FOV, look-around.
- `DriveCam`: chase and hood cam for the driven car; mouse / right-stick look, eases back.
- `ChaseCamera`: orbit / zoom / tap; `frameReset`, `orbit(wallDt, spinRate, shake)`, `frameDrive`, `kick` on impact; `userFramed` stops cinematic re-aiming.
- `CrashEngine.updateCamera(wallDt)`: `cine.direct` (crash cam: three cuts in the slow-mo, letterboxed) first; else driving → `frameDrive`; else look at the followed car, rig car, derby winner or fleet centroid, then orbit.

## Related
[architecture.md](architecture.md) · [physics.md](physics.md) · `README.md` (controls) · `docs/CINEMATIC.md` · `docs/MULTIPLAYER.md`
