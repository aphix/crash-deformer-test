<!-- Generated: 2026-10-03 | Files scanned: 16 | Token estimate: ~1310 -->
# Frontend: React HUD, input, camera, netplay panel

## Component tree
```
src/router.tsx getRouter() → routeTree.gen.ts
src/routes/__root.tsx  createRootRoute (head meta); components/boot-loader.tsx BootLoaderStyle + BootLoader: a server-rendered full-viewport loading cover
                       (CSS inlined, so it paints before any JS); lib/boot-loader.ts dismissBootLoader() fades it out when engine.ready resolves,
                       on a boot error, or 20 s after mount (a CSS animation hides it after 45 s if the bundle never loads)
src/routes/index.tsx   "/" → Home
  └ components/crash-lab.tsx  CrashLab
      ├ <canvas>  ← new CrashEngine(canvas, hudStore, veil): engine.start(); cleanup engine.dispose(); use-driver.ts useDriver: stored name + car type → engine.setDriver
      ├ components/net-panel.tsx  NetPanel        top-centre "Net" button → host / join / Public race / Public derby, invite link + QR
      ├ components/live-rooms.tsx  LiveRooms      race mode, top-left: Play online + "N live" pill → list (Join / Play online / Host); a session chip with Leave (use-live-rooms.ts: useLiveRooms, useNetStatus; net/matchmaking.ts RoomPoller)
      ├ components/hud.tsx  Hud(HudProps)
      │   ├ hud-panels.tsx  PistonPanel · DoorPanel · RangePanel · DerbyBoard   (only in their scene)
      │   ├ race-hud.tsx  RaceStandings · RaceOverlay (menus) · SpectateBar · RaceViewToggle; race-menu-shell.tsx MenuShell · race-reel.tsx ReelList / SavedList / SoloExit (highlights) · race-driver.tsx DriverRows (setup) · race-busted.tsx BustedBanner;
      │   │   use-pad-menu.ts: pad / keyboard menu focus (hud/menu-nav.ts); HUD → engine.raceCommand(cmd)
      │   ├ race-readouts.tsx  RaceReadouts · Gauge: position, lap, race time + completion %, clocks and the speed / gear / boost gauge of the driven or watched car (use-speed-unit.ts: km/h or mph from the browser's language)
      │   ├ race-gauge.tsx  DriveCluster (big screen, bottom right): rev dial (faked from `carRpm`), damage arc, repair wrench (`canReset` / `needsReset`), nitrous bottle (boost)
      │   ├ race-status.tsx  RaceStatus: pursuit strip ("chased by N cops" + bust hold) and the last-lap near-goal banner
      │   ├ start-lights.tsx  StartLights: the 3-2-1-GO numeral of a race or derby match clock
      │   ├ reset-prompt.tsx  ResetPrompt ← hud/reset-prompt.ts resetInput / resetPromptLabel: the pulsing "R to reset" pill at 2+ wheels off
      │   ├ hud-sections.tsx  HudSections   accordion: Playback · Driving · Cars & crash · Debug views (use-stored-string.ts: which sections stay open)
      │   ├ touch-controls.tsx  TouchControls (thumb pad, coarse pointer only, via use-coarse-pointer.ts) · FullscreenButton
      │   ├ use-hud-idle.ts  useHudIdle: touch only, collapses the HUD to its short bar (`data-idle`, the `idle:` variant) after 5 s without a tap (`game/hud/hud-collapse.ts`; taps on `data-keep-idle`, the thumb pad, don't count) or on the hide button; expands only on a click or slide up on the collapsed bar, never a bare pointerdown
      │   └ ui/button.tsx
      └ <div veil>  the scene switch's black (SceneFade), over the canvas and the HUD, no pointer events
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
- `CrashHudState`: scene toggles (playing, looping, showRig, showParticles, showBarrier, showBalls, showRamps, showCompactor, showPistons, showDoors, showCorkscrew, `range`, derby, `pendingScene` (the scene a fading pick heads for), autoRotate, autoSlomo, audioOn, deformMode), cinematic (`fxTier`, `fxAuto`, `night`, `wet`), `PistonHud`, `DoorHud`, telemetry (`phase: CrashPhase`, timeScale, speeds, closingKph, impactKph, fps, `compactStage`), tunables (squash shown as stroke, buckle shown as wrinkle, fxDensity, carCount, speedMin/Max), driving (`playerClass`, `realism`, boost, seat / view / pad label), derby board.
- `INITIAL_HUD` holds the defaults that `resetDefaults()` restores; `KNOB_RANGES`, `STROKE_RANGE_M`, `strokeAt56` / `squashForStroke` map slider units.
- Engine setters the HUD calls: `togglePlay`, `toggleLoop`, `toggleRig`, `toggleParticles`, `toggleBarrier`, `toggleBalls`, `toggleRamps`, `toggleCorkscrew`, `toggleRange`, `toggleRace`, `raceCommand(cmd)`, `toggleCompactor`, `togglePistons`, `firePiston(i)`, `setPistonConfig(patch)`, `toggleDoors`, `fireDoorRam(scenario)`, `toggleDoorOpen`, `setDoorConfig(patch)`, `toggleDerby`, `toggleOrbit`, `toggleSlomo`, `toggleAudio`, `setFxTier`, `setFxAuto`, `setNight`, `setWet`, `toggleDeformMode`, `setSquash`, `setBuckle`, `setFxDensity`, `setRealism`, `setPlayerClass`, `setCarCount`, `setSpeedRange(min, max)`, `setTimeScale`, `toggleCapture`, `copyTraceJson`, `resetDefaults`, `reset`, `watchCar(i)`.

## Netplay panel (`net-panel.tsx`)
Polls `engine.net.status()` every 0.5 s. Host / Join take a room code (`[A-Z0-9]`, ≤ 12) and a link: Internet (WebRTC, `rtc`) or This browser (BroadcastChannel, `bc`). **Public race** / **Public derby** call `net.publicMatch("race" | "derby")`: `findMatch` (`net/matchmaking.ts`) joins the best open room of that kind and build from `GET api/rtc?list=public&kind=…` (not full; a lobby or results stage before a running match, then the most distinct addresses, then the first name), else hosts a new one with a lobby countdown (a weak device searches ~12 s before it hosts, with a smaller field; a guest hosts after `MAX_DEAD_ROOMS` dead rooms). Race mode's **Play online** (`live-rooms.tsx`) is the same call; its list is polled by `RoomPoller` (10 s collapsed, 4 s open, none while the tab is hidden). A private room shows **Copy invite link** (`<origin><BASE_URL>?net=join&room=CODE`) and a QR (`@/lib/qr`); opening such a link auto-joins. Room size: `ROOM_MAX` (8) in `src/lib/multiplayer/rooms.ts`.

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
- Scene / FX keys in `onKey`: Space R L G P B K D C I N O M U Y J F H X Z, `.` (jump ramps), `,` (corkscrew), digits for the piston and door rigs. In a race, `raceKey` / `racePad` take Esc R Q E V C T H first; with a race menu open the HUD reads keys and pad itself. The controls tables live in `docs/CONTROLS.md`.
- Touch: the stick maps x → left stick, up → RT, down → LT; buttons set `PAD_BUTTON` bits (south handbrake, west boost, north view, down recover / respawn, lb / rb car, back Esc / pause, r3 look back). `tapped` latches a press shorter than a frame. Only the engine's `GamepadInput` merges it; the menus' own instance never sees it.
- Reset prompt: `resetInput(pad, touch, driving)` names the control in use (a connected pad wins; a touch screen only has the reset button while driving), `resetPromptLabel(view, input, race)` the caption (`R`, `D-pad ↓`, `Respawn` / `Recover`), null until `view.wheelsOff` ≥ 2 and `view.canReset` (not in a no-reset race, while spectating, or in a derby while the car cannot recover). `ResetPrompt` draws it in the race overlay, under the standings on a phone, and in the derby HUD.
- Shareable URL: `engine-share.ts` `EngineShare` keeps the page's `#` in step with the HUD state (`hud/share-url.ts` `encodeShare` / `decodeShare`: only what differs from the defaults, in a fixed key order; read as untrusted, every value goes through the HUD's own setter; a netplay client writes only `room=CODE` and applies no settings; the `#` is the only input of a page load, joining the private room it names; `joinsRoom`, `shareFragment`, `roomLink`). The keys are in `docs/CONTROLS.md`. `components/room-share.tsx` `RoomShare` shows the hosted or joined room's code with Copy link, Share and (for a room with no host) Host this room.
- Click a car: `ChaseCamera` tap → `CrashEngine.pickCar(x, y)` (raycast) → `seat.focus(i)`. A second finger on the canvas pinch-zooms.

## Camera (`src/game/present/engine-camera.ts`, `spectate-cam.ts`, `engine-cine.ts`)
- `Spring`, `Spring3`: critically damped springs, exact for any dt. `CHASE`: third / far / hood-cam tuning, FOV, look-around.
- `DriveCam`: chase and hood cam for the driven car; mouse / right-stick look, eases back (a spectator's `keep` holds a dragged look).
- `ChaseCamera`: orbit / zoom / tap; `frameReset`, `orbit(wallDt, spinRate, shake)`, `frameDrive`, `kick` on impact; `userFramed` stops cinematic re-aiming. The orbit's target bends along its radius round each lamp post (`posts`: the engine's array, standing and visible ones count), so the eye stays 3 m clear of every post's axis: one smooth swell reaching 3× the clearance either side, inward (the post behind the eye) unless the post's circle is well inside the orbit's. A drag moves whatever framed the last frame (`rig`): the orbit, a chase's look, or nothing (trackside, wheel cam). `lookBack(car)` / `unflip()`: the rear-view hold, the chase offset mirrored ahead of the car, snapped; the rigs' own shot is parked and restored before the next frame's rigs run.
- Spectator cams (following, not driving): `SpecView` = the three chase views, `"cine"`, `"dutch"`, `"orbit"`, `"auto"`; View (V / T, Y, the Spectating bar's camera button) runs `CrashEngine.cycleCamera` → `cycleSpec`. A race opens on the seat's chase view, fleet / derby on the orbit; back to the whole field resets it. `frameSpectate(car, view, scene, dt, shake)`. `"auto"` = `AutoCam` (`auto-cam.ts`): the highlight reel's shot director (`shot-cam.ts` `pickShot` / `ShotCam`, shared with `ReelDirector`) live on the followed car; a shot is held while its spot stays usable (`camUsable`, re-asked every 0.5 s), then cuts. The next spot's search and the re-ask each spend 250 sight-line samples a frame (`SightLines` in `spectate-cam.ts`: a spot's sight lines go on over the frames, one line at a time, so no frame pays for a whole spot: stunt worst frame 3.0 → 1.4 ms). The crash cam, which runs before any spectator cam, takes each hit.
- Chase eyes (`ChaseCamera.pushOut` for the three chase views, `ShotCam.pose` for the Auto and reel chase) stand `CINE.pad` clear of solids through one pull-in, `EyePull` (`spectate-cam.ts`): the first clear metre along the view, bisected to 1.6 cm, so the distance changes smoothly with the eye; it snaps in as a solid closes on the eye and eases back out (`PULL_OMEGA`, never through a solid). The Auto chase passes its frame time; the reel passes none (no easing: its camera is a pure function of the poses). The Auto chase follows the car's travel as `foldHeading` (`shot-cam.ts`, 0.3 s low-pass, the same as `ClipSim.heading`) folds it each frame; a cut onto another car forgets the held shot and the heading, so the chase poses the new car while its opener is searched.
- Auto driver (a race being spectated): `RaceDirector.auto` is one more entry after the last car in the Q / E (`cycle`) list, the Standings' Auto row (`watch` id -1) and the Spectating bar's label (`RaceHud.auto`). `autoStep(cuts, atCut)` once a frame scores every racing car (`match/auto-watch.ts` `AutoWatch`: predicted contact, wreck in the highlight ledger, bust, close battle, airborne, overtake, hard jolt; the MAX of them, never a sum) and moves `seat.focus` only on a camera cut, at most once per 4 s (`WATCH.floor`), except to the car of an imminent big crash or off a finished / out car. Local to the viewer; nothing goes on the net.
- `CineCam` (`spectate-cam.ts`): a fixed eye ahead of the car (along the race loop, or along its travel off a race), 0.6–4.1 m up, out of every solid (`Sight`: ground and bridge slabs, race walls and tunnels, props at their drawn size, the gantry legs, bridge pillars, the other cars, the derby rim) with `CLEAR.radius` (2 m) of room (`clearSpot`) and clear sight to the car now and over the next seconds (`camUsable`: `aheadPoints` samples the car along the course, or along its velocity off one); it cuts `CINE.after` s after the car passes. The crash cam asks `camUsable` of each eye too, and a cut with none keeps the chase / reel camera. The search spends `CINE.perFrame` sight-line samples a frame; nothing runs per frame between searches. `DutchCam`: eight wheel-well mounts (forward / back), rolled 0.3 rad, cutting every ~3.5 s to the mount with the most rivals in its frustum. Both are deterministic from the car poses (`reset(seed)`).
- `CrashEngine.updateCamera(wallDt)`: `unflip`, `ragdolls.unfadeRide`, `aimRigs`, `ragdolls.fadeRide`, then (not while the reel plays) `lookBack` while `view.rear` is held and a car is followed. `aimRigs` takes the first that applies: the results reel (`cine.direct` over the clip's hit, else `highlights.camera`); a thrown driver's ride-along (`ragdolls.frameCamera`, `RideCam`; the crash cam's cuts then run on a probe lens); `cine.direct` (crash cam: three cuts in the slow-mo, letterboxed; only when no ride, no user framing and not driving); a followed car off the disc's rim → `watchFall`; driving → `frameDrive`; following (off the rigs) → `race.autoStep` for the Auto driver, then `frameSpectate`; else look at the followed car, rig car, derby winner or fleet centroid, then `orbit`.
- `RideCam` (`ride-cam.ts`; placed by `RagdollSystem.frameCamera`): the thrown driver's ride-along. It opens on the windshield (the eye ahead of the car on its forward axis: low when `camUsable` sees the dummy from there, else high and out of every solid; `GLASS_T` 0.8 s), then follows the dummies (behind or ahead of their travel, alternating per ride) and now and then takes a `CineCam` trackside turn. Every shot change, cut to another dummy and return from the user's orbit eases from the pose the camera was left in (`BLEND_T` 0.9 s, longer for a longer fly, at most 3 s); an eye over 90 m away, and the first frame, cut. The end eases into the engine's own view over 1 s (`fade` / `unfade`). A click or touch drag orbits the dummy (`ChaseCamera.rideHeld`, `frameRide`): the shots wait while it is held and for `RIDE_PAUSE` (2.5 s) after.

## Related
[architecture.md](architecture.md) · [physics.md](physics.md) · `docs/CONTROLS.md` · `docs/CINEMATIC.md` · `docs/MULTIPLAYER.md`
