<!-- Generated: 2026-10-01 | Files scanned: 14 | Token estimate: ~1050 -->
# Frontend: React HUD, input, camera

## Component tree
```
src/router.tsx getRouter() → routeTree.gen.ts
src/routes/__root.tsx  createRootRoute (head meta)
src/routes/index.tsx   "/" → Home
  └ components/crash-lab.tsx  CrashLab
      ├ <canvas>  ← new CrashEngine(canvas); engine.start(); cleanup engine.dispose()
      └ components/hud.tsx  Hud(HudProps)
          ├ hud-panels.tsx    DerbyBoard, PistonPanel   (only in their scene)
          ├ hud-sections.tsx  HudSections (accordion: Playback / Cars & crash / Debug views)
          └ ui/button.tsx
components/preview-host-bridge.tsx  PreviewHostBridge (platform preview hook, renders null)
```
`CrashLab` loads the engine with a dynamic `import("@/game/engine")`; boot errors render as text. The engine sets `window.__crush = this` (used by `scripts/bench-browser.mjs`).

## HUD state (`src/game/hud-store.ts`)
```
CrashEngine.emitHud(force) ──► publishHud(next: CrashHudState)
                                    │ module snapshot + listeners Set
CrashLab: useSyncExternalStore(subscribeHud, getHudSnapshot) ──► <Hud state=…>
Hud button ──► engineRef.current?.toggleX() / setX(v) ──► engine state ──► emitHud(true)
```
- `CrashHudState`: toggles (playing, looping, showRig, showParticles, showBarrier, showBalls, showCompactor, showPistons, autoRotate, autoSlomo, audioOn, deformMode), `PistonHud`, telemetry (`phase: CrashPhase`, timeScale, speeds, closingKph, impactKph, fps, `compactStage`), tunables (squash, buckle, fxDensity, carCount, speedMin/Max), derby board, seat/boost/view/pad label.
- `INITIAL_HUD` holds the defaults that `resetDefaults()` restores.
- Engine setters the HUD calls: `togglePlay`, `toggleLoop`, `toggleRig`, `toggleParticles`, `toggleBarrier`, `toggleBalls`, `toggleCompactor`, `togglePistons`, `firePiston(i)`, `setPistonConfig(patch)`, `toggleDerby`, `toggleOrbit`, `toggleSlomo`, `toggleAudio`, `toggleDeformMode`, `setSquash`, `setBuckle`, `setFxDensity`, `setCarCount`, `setSpeedRange(min, max)`, `setTimeScale`, `toggleCapture`, `copyTraceJson`, `resetDefaults`, `reset`.

## Input
```
keydown/keyup → CrashEngine.keys:Set<code> + onKey (scene keys)
tickInner → pollInput()
   pad.poll()           gamepad.ts GamepadInput → readPad(src, out: PadState)  (deadzone, edges)
   seat.sample(keys,pad) car-drive.ts DriverSeat → readIntent(keys, pad, out): DriveIntent  (drive-input.ts)
fixedStep(h)
   seat.input(car, dt) → shapeDrive(intent, feel, along, dt, out): DriveInput  (slew, lock, reverse)
   applyDrive(car, input: DriveInput, dt)        same call for derby AI (DerbyBrain.think)
```
- `DriverSeat`: `mode: "global" | "follow" | "drive"`, `view: "third" | "far" | "first"`, `focus(i)`, `cycle(dir, n)`, `esc()`, `cycleView()`, `step(dt)` (boost), `addBoost(amount)`.
- `DriveInput { throttle, steer, brake, ebrake, boost }`; constants `DRIVE`, `BOOST`, `FEEL`, `PAD_BUTTON`, `PAD_DEAD`.
- Click a car: `ChaseCamera` tap → `CrashEngine.pickCar(x, y)` (raycast) → `seat.focus(i)`.
- Keyboard and pad merge per axis (larger magnitude wins). The controls tables live in `README.md`.

## Camera (`src/game/engine-camera.ts`)
- `Spring`, `Spring3`: critically damped springs, exact for any dt.
- `CHASE`: tuning for third / far / hood-cam views, FOV, look-around.
- `DriveCam`: chase and hood cam for the driven car; mouse / right-stick look, eases back.
- `ChaseCamera(camera, canvas, seat, pad, reduceMotion, onClick)`: orbit / zoom / tap; `frameReset`, `orbit(wallDt, spinRate, shake)`, `frameDrive(car, wallDt, shake)`.
- `centroid(out, cars)`: orbit target.
- `CrashEngine.updateCamera(wallDt)`: driving → `frameDrive`; otherwise look at the followed car, compactor/piston car, derby winner or fleet centroid, then `orbit`.

## Related
[architecture.md](architecture.md) · [physics.md](physics.md) · `README.md` (controls)
