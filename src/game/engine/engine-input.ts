import * as THREE from "three";
import { PISTON_DEFAULTS, PISTON_IDS } from "../scenes/piston-rig.ts";
import { RAM_DEFAULTS } from "../scenes/door-rig.ts";
import { INITIAL_HUD, KNOB_RANGES } from "../hud/hud-store.ts";
import { armKill, carClass, CLASSES, HANDLING, killClass, type VehicleClassId } from "../vehicle/vehicle-classes.ts";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { cleanName, DRIVER_CARS } from "../match/types.ts";
import { driverCarApplies } from "../match/driver-pick.ts";
import { FX_TIERS, type FxTier } from "../present/engine-post.ts";
import { gameKey } from "../vehicle/drive-input.ts";
import type { SceneId } from "../scenes/scene-id.ts";
import { MouseLook } from "./mouse-look.ts";
import { PAD_BUTTON, type TouchPad } from "../vehicle/gamepad.ts";
import type { BenchParts } from "./engine-bench.ts";
import { EngineRigs } from "./engine-rigs.ts";

/**
 * Player input: keyboard, gamepad, pointer picks and the HUD's commands and settings.
 */
export abstract class EngineInput extends EngineRigs {
  protected abstract tickInner(now: number): void;

  /**
   * Fast-forward for probes: the exact per-frame path of `tick` on a synthetic clock, synchronously (so the rAF loop
   * cannot interleave). Only the last frame (or every frame with `render`) draws, so a screenshot after it shows the state.
   */
  advance(seconds: number, opts: { frameDt?: number; render?: boolean } = {}): void {
    const dt = (opts.frameDt ?? 1 / 60) * 1000;
    const frames = Math.max(1, Math.round((seconds * 1000) / dt));
    const real = this.last;
    let t = real;
    try {
      for (let i = 0; i < frames; i++) {
        t += dt;
        this.skipDraw = !opts.render && i < frames - 1;
        this.tickInner(t);
      }
    } finally {
      this.skipDraw = false;
      this.last = performance.now();
    }
  }

  /** The protected parts the `?bench=city` page times (`engine-bench.ts`). */
  benchParts(): BenchParts {
    return { renderer: this.renderer, cine: this.cine, race: this.race, seat: this.seat, live: () => this.live() };
  }

  /** The touch HUD's stick and buttons; merged into the pad on every poll, so every pad path takes them. */
  get touch(): TouchPad {
    return this.pad.touch;
  }

  togglePlay(): void {
    // The host owns the scene: on a netplay client the scene actions are no-ops (viewing toggles stay local).
    if (this.net.client) return;
    this.playing = !this.playing;
    this.tryUnlockAudio();
    this.emitHud();
  }

  toggleLoop(): void {
    this.looping = !this.looping;
    this.emitHud();
  }

  toggleRig(): void {
    this.showRig = !this.showRig;
    for (const car of this.live()) car.setRigVisible(this.showRig);
    this.ragdolls.debug.set(this.showRig, this.showParticles);
    this.emitHud();
  }

  toggleParticles(): void {
    this.showParticles = !this.showParticles;
    for (const car of this.live()) car.deform.setParticlesVisible(this.showParticles);
    this.ragdolls.debug.set(this.showRig, this.showParticles);
    this.emitHud();
  }

  toggleOrbit(): void {
    this.autoRotate = !this.autoRotate;
    this.emitHud();
  }

  toggleSlomo(): void {
    this.autoSlomo = !this.autoSlomo;
    if (!this.autoSlomo) {
      if (this.clock.userTimeScale == null) {
        this.clock.timeScale = 1;
        this.clock.targetScale = 1;
      }
    }
    this.emitHud();
  }

  toggleAudio(): void {
    this.audioOn = !this.audioOn;
    this.tryUnlockAudio();
    this.emitHud();
  }

  /** Cinematic FX quality (`FX_TIERS`): off and minimal draw straight to the canvas; minimal adds tyre marks and the crash cam, low / high the post chain. The user's pick turns the auto tier off. */
  setFxTier(tier: FxTier): void {
    this.autoFx.auto = false;
    this.cine.setTier(tier);
    this.emitHud();
  }

  /** The auto tier back on (the HUD's "auto"): the next frame applies its tier. */
  setFxAuto(): void {
    this.autoFx.resume(this.cine.tier);
    this.emitHud();
  }

  /** The HUD's cel look: a strength (clamped) holds it on under the scene-switch pulse, null is Auto (the pulse alone). */
  setCelLook(value: number | null): void {
    this.celLook = value === null || !Number.isFinite(value) ? null : THREE.MathUtils.clamp(value, KNOB_RANGES.cel.min, KNOB_RANGES.cel.max);
    this.emitHud();
  }

  /** Per frame after boot: a match (a race from the grid to the flag, a derby until its winner) starts on minimal, the auto tier otherwise. */
  protected fxFrame(wallDt: number): void {
    const p = this.race.phase;
    const matchTime = p === "grid" || p === "countdown" || p === "racing" ? this.race.time : this.derbyMode && this.derby.active && this.derby.winnerId === null ? this.derby.time : null;
    const tier = this.autoFx.frame(wallDt * 1000, matchTime);
    if (tier === null) return;
    console.info(`Crush Stream FX auto: ${tier} (last window ${this.autoFx.fps.toFixed(1)} fps)`);
    this.cine.setTier(tier);
    this.emitHud();
  }

  cycleFxTier(): void {
    this.setFxTier(FX_TIERS[(FX_TIERS.indexOf(this.cine.tier) + 1) % FX_TIERS.length]!);
  }

  setNight(on: boolean): void {
    this.stage.setNight(on);
    this.smoke.shade = this.cine.tyreSmoke.shade = this.stage.smokeShade;
    if (this.scene.environment) this.scene.environmentIntensity = this.stage.envIntensity;
    this.emitHud();
  }

  setWet(on: boolean): void {
    this.stage.setWet(on);
    this.emitHud();
  }

  toggleDeformMode(): void {
    this.deformMode = this.deformMode === "shape" ? "lattice" : "shape";
    for (const car of this.live()) car.deform.setMode(this.deformMode);
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud();
  }
  setSquash(value: number): void {
    this.squash = THREE.MathUtils.clamp(value, KNOB_RANGES.squash.min, KNOB_RANGES.squash.max);
    for (const car of this.live()) car.deform.squash = this.squash;
    this.emitHud();
  }

  setBuckle(value: number): void {
    this.buckle = THREE.MathUtils.clamp(value, KNOB_RANGES.buckle.min, KNOB_RANGES.buckle.max);
    for (const car of this.live()) car.deform.buckle = this.buckle;
    this.emitHud();
  }

  setFxDensity(value: number): void {
    this.fxDensity = THREE.MathUtils.clamp(value, KNOB_RANGES.fxDensity.min, KNOB_RANGES.fxDensity.max);
    this.emitHud();
  }

  /** Arcade (0) ↔ realistic (1): grip and drift assists in applyDrive, and when every car's drivetrain dies. */
  setRealism(value: number): void {
    HANDLING.realism = THREE.MathUtils.clamp(value, KNOB_RANGES.realism.min, KNOB_RANGES.realism.max);
    for (const car of this.cars) armKill(car.deform, killClass(car), HANDLING.realism, this.derbyMode ? "derby" : "default");
    this.emitHud();
  }

  /** The player's car (slot 0) becomes `id`, rebuilt on that class's body; the field respawns and the camera follows it. */
  setPlayerClass(id: VehicleClassId): void {
    if (this.net.client) return;
    if (!(id in CLASSES)) return;
    this.setPlayerCar(id, CLASSES[id].style);
    this.randomizeAndReset();
    this.seat.focus(0);
    this.emitHud();
  }

  /** The last car pick `setDriver` saw (null before the first) and whether the page's `#` named a car (`attachShare`). */
  private driverCar: string | null = null;
  protected linkNamedCar = false;

  /**
   * The player's pick from the race setup (the HUD keeps it in localStorage and sends it at boot and
   * on every change): the name on the race standings and netplay seats ("" → "You"), and the car
   * type (`DRIVER_CARS` id; unknown → the first) slot 0 is built as (`driverCarApplies`: a `#` that named a car wins at
   * boot). A new car re-parks the field with the run's own seed, so the pick never re-rolls a shared link's layout.
   */
  setDriver(name: string, car: string): void {
    this.race.playerName = cleanName(name) || "You";
    const applies = driverCarApplies(this.driverCar, car, this.linkNamedCar);
    this.driverCar = car;
    const type = DRIVER_CARS.find((c) => c.id === car) ?? DRIVER_CARS[0]!;
    if (this.net.client || !applies || !this.setPlayerCar(type.cls, type.style)) return;
    this.pinnedSeed = this.sceneSeed;
    try {
      this.randomizeAndReset();
    } finally {
      this.pinnedSeed = null;
    }
    this.emitHud();
  }

  /** Slot 0 becomes class `cls` on body `style`; true when that rebuilt the car. */
  private setPlayerCar(cls: VehicleClassId, style: CarStyleId): boolean {
    this.playerClass = cls;
    this.playerStyle = style;
    const old = this.cars[0];
    if (!old || (carClass(old) === cls && old.style.id === style)) return false;
    this.scene.remove(old.group);
    old.dispose();
    this.cars[0] = this.buildCar(0);
    this.cars[0].group.visible = true;
    return true;
  }

  setCarCount(n: number): void {
    if (this.net.client) return;
    // The race sets its own field (setup menu), the range runs one car and the stack its own count; the sandbox slider must not reshape them.
    if (this.race.active || this.showRange || this.showStack) return;
    this.ensureCars(n);
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud();
  }

  setSpeedRange(min: number, max: number): void {
    const a = Number.isFinite(min) ? THREE.MathUtils.clamp(min, KNOB_RANGES.speed.min, KNOB_RANGES.speed.max) : 0;
    const b = Number.isFinite(max) ? THREE.MathUtils.clamp(max, KNOB_RANGES.speed.min, KNOB_RANGES.speed.max) : 32;
    this.speedMin = Math.min(a, b);
    this.speedMax = Math.max(a, b);
    this.emitHud();
  }

  setTimeScale(value: number | null): void {
    if (value == null || !Number.isFinite(value)) {
      this.clock.userTimeScale = null;
      this.clock.targetScale = 1;
      this.clock.timeScale = 1;
    } else {
      const v = THREE.MathUtils.clamp(value, KNOB_RANGES.timeScale.min, KNOB_RANGES.timeScale.max);
      this.clock.userTimeScale = v;
      this.clock.targetScale = v;
      this.clock.timeScale = v;
    }
    this.emitHud();
  }

  toggleCapture(): void {
    this.captureTrace = !this.captureTrace;
    if (this.captureTrace && this.trace.samples.length === 0) this.beginTrace();
    this.emitHud();
  }

  resetDefaults(): void {
    this.playing = INITIAL_HUD.playing;
    this.looping = INITIAL_HUD.looping;
    this.showRig = INITIAL_HUD.showRig;
    this.showParticles = INITIAL_HUD.showParticles;
    this.ragdolls.debug.set(this.showRig, this.showParticles);
    this.showBarrier = INITIAL_HUD.showBarrier;
    this.showBalls = INITIAL_HUD.showBalls;
    this.showRamps = INITIAL_HUD.showRamps;
    if (this.rigScene) this.sceneId = "fleet";
    this.pistons.setConfig(PISTON_DEFAULTS);
    this.doorRig.kph = RAM_DEFAULTS.kph;
    this.doorRig.kg = RAM_DEFAULTS.kg;
    this.doorRig.side = INITIAL_HUD.doors.side;
    this.autoRotate = INITIAL_HUD.autoRotate;
    this.autoSlomo = INITIAL_HUD.autoSlomo;
    this.audioOn = INITIAL_HUD.audioOn;
    this.deformMode = INITIAL_HUD.deformMode;
    this.squash = INITIAL_HUD.squash;
    this.buckle = INITIAL_HUD.buckle;
    this.fxDensity = INITIAL_HUD.fxDensity;
    this.speedMin = INITIAL_HUD.speedMin;
    this.speedMax = INITIAL_HUD.speedMax;
    this.captureTrace = false;
    this.clock.userTimeScale = null;
    this.clock.timeScale = 1;
    this.clock.targetScale = 1;
    this.view.userFramed = false;
    this.setDerby(false);
    this.setNight(INITIAL_HUD.night);
    this.setWet(INITIAL_HUD.wet);
    this.setRealism(INITIAL_HUD.realism);
    this.autoFx.resume(this.cine.tier);
    this.celLook = INITIAL_HUD.celLook;
    if (this.playerClass !== INITIAL_HUD.playerClass) this.setPlayerClass(INITIAL_HUD.playerClass);
    this.ensureCars(INITIAL_HUD.carCount);
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud();
  }

  copyTraceJson(): string {
    if (!this.trace.initial) this.trace.snapshotInitial(this.traceSetup(), this.live());
    if (!this.captureTrace) {
      const json = this.trace.setupJson(this.traceSetup());
      this.emitHud();
      return json;
    }
    return this.trace.traceJson(this.traceSetup());
  }

  reset(): void {
    if (this.net.client) return;
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud();
  }
  /** Mouse look (pointer lock on the canvas): raw movement looks round like a held drag; any loss of the lock pauses a run. */
  protected readonly mouseLook = new MouseLook({
    move: (dx, dy) => this.view.lookBy(dx, dy),
    changed: () => {
      this.view.locked = this.mouseLook.on;
      this.emitHud();
    },
    lost: () => this.pauseRun(),
  });
  private lookScene: SceneId = "fleet";

  /** The toggle key and the HUD button: a fine pointer and no menu or reel only. Call inside the user gesture. */
  toggleMouseLook(): void {
    if (this.mouseLook.on) {
      this.mouseLook.exit();
      return;
    }
    if (this.race.menuOpen || !window.matchMedia("(pointer: fine)").matches) return;
    this.lookScene = this.sceneId;
    this.mouseLook.request(this.canvas);
  }

  /** The same pause Esc and the pad's Start give: a race, Survival (a race) or the derby's clock. Once: a paused run ignores it. */
  private pauseRun(): void {
    if (this.race.active) this.raceCommand({ type: "pause" });
    else if (this.derbyMode && this.derby.active && this.derby.winnerId === null && this.playing) this.togglePlay();
  }

  protected onKey = (e: KeyboardEvent): void => {
    if (!gameKey(e)) return;
    // A race menu owns the keyboard (and the pad) through the HUD.
    if (this.race.menuOpen) return;
    // Not a game key (no chord, no seat action): only ever asks for the lock, inside this keydown (the user gesture).
    if (e.code === "Semicolon") {
      e.preventDefault();
      if (!e.repeat) this.toggleMouseLook();
      return;
    }
    this.keys.add(e.code);
    const driving = this.seat.mode === "drive";
    if (this.seat.mode !== "global" && e.code.startsWith("Arrow")) e.preventDefault();
    // Every Space keydown, repeats included: an unprevented repeat arms a focused HUD button and the release clicks it.
    if (e.code === "Space") e.preventDefault();
    if (e.repeat) return;
    if (this.race.active && this.raceKey(e.code)) return;
    if (e.code === "Space") {
      if (!driving) this.togglePlay();
    } else if (e.code === "Escape") {
      this.seat.esc();
      this.emitHud();
    } else if (e.code === "KeyV" || e.code === "KeyT" || (e.code === "KeyC" && driving)) {
      this.cycleCamera();
    } else if (e.code === "KeyQ" || e.code === "KeyE") {
      this.seat.cycle(e.code === "KeyE" ? 1 : -1, this.carCount);
      this.emitHud();
    } else if (e.code === "KeyR") {
      e.preventDefault();
      if (driving) this.recoverDriven();
      else this.reset();
    } else if (e.code === "KeyL") {
      this.toggleLoop();
    } else if (e.code === "KeyG") {
      this.toggleRig();
    } else if (e.code === "KeyP") {
      this.toggleParticles();
    } else if (e.code === "KeyB") {
      this.toggleBarrier();
    } else if (e.code === "KeyK") {
      this.toggleBalls();
    } else if (e.code === "KeyD") {
      if (this.seat.mode === "global") this.toggleDerby();
    } else if (e.code === "KeyS") {
      // The scene key, like D: S is the brake once a car is driven, so only from the whole-field view.
      if (this.seat.mode === "global") this.toggleSurvival();
    } else if (e.code === "KeyC") {
      this.toggleCompactor();
    } else if (e.code === "KeyI") {
      this.togglePistons();
    } else if (e.code === "KeyN") {
      this.toggleDoors();
    } else if (e.code === "Comma") {
      this.toggleCorkscrew();
    } else if (e.code === "Slash") {
      e.preventDefault(); // Firefox's quick find
      this.toggleStack();
    } else if (e.code === "Period") {
      this.toggleRamps();
    } else if (this.showDoors && /^Digit[1-7]$/.test(e.code)) {
      const n = Number(e.code.slice(5));
      if (n <= 3) this.fireDoorRam(n === 1 ? "mirror" : n === 2 ? "overOpen" : "shut");
      else if (n === 4) this.toggleDoorOpen();
      else if (n === 5) this.setDoorConfig({ side: this.doorRig.side < 0 ? 1 : -1 });
      else this.fireDoorRam(n === 6 ? "panelPush" : "panelPull");
    } else if (this.showPistons && /^Digit[0-8]$/.test(e.code)) {
      const n = Number(e.code.slice(5));
      this.firePiston(n === 0 ? PISTON_IDS.length : n - 1);
    } else if (e.code === "KeyO") {
      this.toggleOrbit();
    } else if (e.code === "KeyM") {
      this.toggleSlomo();
    } else if (e.code === "KeyU") {
      this.toggleAudio();
    } else if (e.code === "KeyY") {
      this.toggleDeformMode();
    } else if (e.code === "KeyJ") {
      this.toggleCapture();
    } else if (e.code === "KeyF") {
      this.cycleFxTier();
    } else if (e.code === "KeyH") {
      this.setNight(!this.stage.night);
    } else if (e.code === "KeyX") {
      this.setWet(!this.stage.wet);
    } else if (e.code === "KeyZ") {
      this.toggleRace();
    }
  };

  /**
   * Keys during a race (no menu up). True when consumed. Race keys always work; the sandbox's hotkeys
   * only in the full view (H), so the focus view can't be knocked out of the race by a stray key.
   */
  private raceKey(code: string): boolean {
    switch (code) {
      case "Escape":
        this.raceCommand({ type: "pause" });
        return true;
      case "KeyR":
        this.requestRespawn();
        return true;
      case "KeyQ":
      case "KeyE":
        this.race.cycle(code === "KeyE" ? 1 : -1);
        this.emitHud();
        return true;
      case "KeyV":
      case "KeyT":
      case "KeyC":
        this.cycleCamera();
        return true;
      case "KeyH":
        this.raceCommand({ type: "fullUi", on: !this.race.fullUi });
        return true;
      default:
        return !this.race.fullUi;
    }
  }

  protected onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  /** Keys released while the tab is unfocused never send keyup; drop them all. */
  protected onBlur = (): void => {
    this.keys.clear();
  };

  /** Once per frame: keys + pad → seat intent and the rear-view hold; pad button presses → seat / scene actions. */
  protected pollInput(): void {
    const pad = this.pad.poll();
    // A menu or a scene switch ends mouse look cleanly (the pointer comes back).
    if (this.mouseLook.on && (this.race.menuOpen || this.sceneFade.pending !== null || this.sceneId !== this.lookScene)) this.mouseLook.exit();
    // Held, not toggled: Backquote, R3 or the touch button looks back until released.
    this.view.rear = !this.race.menuOpen && (this.keys.has("Backquote") || (pad.held & (1 << PAD_BUTTON.r3)) !== 0);
    // Polled every frame so button edges stay fresh; a race menu reads the pad itself through the HUD.
    if (this.race.menuOpen) return;
    if (this.seat.sample(this.keys, pad)) this.emitHud();
    const hit = pad.pressed;
    if (hit === 0) return;
    if (this.race.active) {
      this.racePad(hit);
      return;
    }
    const driving = this.seat.mode === "drive";
    if ((hit & (1 << PAD_BUTTON.start)) !== 0) this.togglePlay();
    if ((hit & (1 << PAD_BUTTON.back)) !== 0) this.seat.esc();
    if ((hit & (1 << PAD_BUTTON.lb)) !== 0) this.seat.cycle(-1, this.carCount);
    if ((hit & (1 << PAD_BUTTON.rb)) !== 0) this.seat.cycle(1, this.carCount);
    if ((hit & (1 << PAD_BUTTON.north)) !== 0) this.cycleCamera();
    if (driving && (hit & (1 << PAD_BUTTON.down)) !== 0) this.recoverDriven();
    this.emitHud();
  }

  /** Pad buttons during a race (no menu up): Start / Back pause, LB/RB spectate, Y view, D-pad ↓ respawn. */
  private racePad(hit: number): void {
    const press = (b: number) => (hit & (1 << b)) !== 0;
    // Through raceCommand: a client may not pause (the host runs the race), so it can't get stuck in a pause it can't leave.
    if (press(PAD_BUTTON.start) || press(PAD_BUTTON.back)) this.raceCommand({ type: "pause" });
    if (press(PAD_BUTTON.lb)) this.race.cycle(-1);
    if (press(PAD_BUTTON.rb)) this.race.cycle(1);
    if (press(PAD_BUTTON.north)) this.cycleCamera();
    if (press(PAD_BUTTON.down)) this.requestRespawn();
    this.emitHud();
  }

  /** View (V / T / Y, the HUD camera button): the driven car's chase view, or the followed car's spectator cam (not on the rigs). */
  cycleCamera(): void {
    if (this.seat.mode === "drive") this.seat.cycleView();
    else if (this.seat.mode === "follow" && !this.rigScene) this.view.cycleSpec(this.race.chase);
    this.emitHud();
  }

  /** R / D-pad down while driving: the driven car back on its wheels (`recoverCar`). */
  protected recoverDriven(): void {
    const car = this.seat.carIndex < this.carCount ? this.cars[this.seat.carIndex] : undefined;
    if (car) this.recoverCar(car);
  }

  /**
   * Press R for `car`, the player's or a derby AI's: back on its wheels where it stands, at rest and
   * repaired. In a derby only a flipped car that still runs may, so it is no free heal.
   */
  protected recoverCar(car: DeformableCar): void {
    car.refreshBasis();
    if (!this.mayRecover(car)) return;
    car.spawnFacing(car.group.position.x, car.group.position.z, Math.atan2(car.fwdFlat.x, car.fwdFlat.z), 0);
    this.dressCar(car);
  }

  protected pickCar(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const roots = this.live().map((c) => c.group);
    const hits = this.raycaster.intersectObjects(roots, true);
    for (const hit of hits) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj) {
        const idx = obj.userData.carIndex;
        if (typeof idx === "number" && idx >= 0 && idx < this.carCount) {
          if (this.race.active) this.race.watch(idx);
          else this.seat.focus(idx);
          this.emitHud();
          return;
        }
        obj = obj.parent;
      }
    }
  }

  /** Follow car `index` (HUD board click). Leaves drive mode; a fresh pedal press takes the wheel again. */
  watchCar(index: number): void {
    if (index < 0 || index >= this.carCount) return;
    if (this.race.active) this.race.watch(index);
    else this.seat.focus(index);
    this.emitHud();
  }
}
