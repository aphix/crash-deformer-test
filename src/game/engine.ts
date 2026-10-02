import * as THREE from "three";
import { CAR_HALF, DeformableCar, type CarPaint } from "./car.ts";
import { WheelBatch } from "./car-mesh.ts";
import { bleedAfterSlide, leftoverCrumple, separateSphereFromAabb } from "./physics-util.ts";
import { COMPACTOR, CompactorRig, compactorStage } from "./compactor.ts";
import { PISTON, PISTON_DEFAULTS, PISTON_IDS, PistonRig, type PistonConfig } from "./piston-rig.ts";
import { PISTON_ORBIT_RATE, PistonBank, pistonAhead, pistonBearing, pistonToGo } from "./engine-pistons.ts";
import { DOOR_LANES, DoorRig, RAM, RAM_DEFAULTS, type DoorScenario, type RamShot } from "./door-rig.ts";
import { DoorRam } from "./engine-doors.ts";
import { physicsSlice, sliceSpeed } from "./sat.ts";
import { resolveCarPair } from "./pair-contact.ts";
import { partContactPair } from "./external-contact.ts";
import { INITIAL_HUD, KNOB_RANGES, publishHud, type CrashPhase } from "./hud-store.ts";
import type { DeformMode } from "./streamed-deform.ts";
import { MAX_CARS, fleetClass, fleetStyle, layoutFleet, layoutDerby } from "./fleet.ts";
import type { CarStyleId } from "./car-variants.ts";
import { assignClass, carClass, CLASSES, damageStage, HANDLING, killTravel, type VehicleClassId } from "./vehicle-classes.ts";
import { WorldStage, makeLamp } from "./engine-world.ts";
import { Cinematics } from "./engine-cine.ts";
import { FX_TIERS, type FxTier } from "./engine-post.ts";
import { DebrisSystem, SparkSystem, GlassDotSystem, TireSmokeSystem, CrashAudio, bounceGround, bounceOffCar } from "./engine-fx.ts";
import { ChaseCamera, centroid } from "./engine-camera.ts";
import {
  CompactorPress,
  JerseyBarrier,
  StrongestContact,
  buildRampBalls,
  resetLampPoles,
  resolveLampPoles,
  resolveRampBalls,
  scatterRampBalls,
  type LampPole,
  type RampBall,
} from "./engine-props.ts";
import { TraceRecorder, type TraceClock, type TraceSetup } from "./engine-trace.ts";
import { DerbyMatch, snapshotAiCar } from "./derby.ts";
import { LampLights } from "./lamp-lights.ts";
import { applyDrive, DriverSeat, BOOST } from "./car-drive.ts";
import { GamepadInput, PAD_BUTTON } from "./gamepad.ts";
import { makeDerbyArena, clipToDerbyBowl, DERBY_RADIUS } from "./derby-arena.ts";
import { NetPlay } from "./net/net-play.ts";
import { RaceDirector } from "./engine-race.ts";
import { TrackArt } from "./race/track-art.ts";
import type { RaceCommand } from "./race/types.ts";

export type { CrashHudState, CrashPhase } from "./hud-store";

const PAINT_A: CarPaint = { body: 0xc5c8ce, accent: 0x9aa0a8, name: "Titanium" };
const PAINT_B: CarPaint = { body: 0x3d8a86, accent: 0x2a6360, name: "Petrol" };
const FLEET_PAINT: CarPaint[] = [
  PAINT_A,
  PAINT_B,
  { body: 0x8b4540, accent: 0x5c2e2b, name: "Oxide" },
  { body: 0x3d4d7a, accent: 0x2a3458, name: "Ink" },
  { body: 0x6b5a3e, accent: 0x4a3e2c, name: "Bronze" },
  { body: 0x4a5c4c, accent: 0x334038, name: "Moss" },
  { body: 0x8a704c, accent: 0x5c4a32, name: "Sand" },
  { body: 0x5a4a62, accent: 0x3c3344, name: "Slate" },
  { body: 0x7a7e86, accent: 0x4e5258, name: "Ash" },
  { body: 0x2f3a42, accent: 0x1c2428, name: "Coal" },
  { body: 0x9a8a6a, accent: 0x6a5e48, name: "Khaki" },
  { body: 0x4a6a72, accent: 0x324850, name: "Teal" },
];

const FIXED = 1 / 60;
const IMPACT_SCALE = 0.032;
const PRE_IMPACT_LEAD = 0.07;
/** Piston loop: the next ram is parked this long (s) before its shot, and no sooner after the last one. */
const PISTON_PARK_LEAD = 1;
/** Deform LoD: sphere around a car — rest half-diagonal 2.5 m plus crumple slack and the
 *  ≈0.9 m the sun throws the roof's shadow, so an off-screen car's shadow is never stale either. */
const LOD_RADIUS = 3.5;
/** Projected sphere radius (CSS px) below which a car skins every 2nd / every 4th frame. */
const LOD_SMALL_PX = 40;
const LOD_TINY_PX = 20;
const _lodSphere = new THREE.Sphere();

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _bn = new THREE.Vector3();
const _bp = new THREE.Vector3();

export class CrashEngine {
  playing = true;
  looping = true;
  showRig = false;
  showParticles = false;
  showBarrier = false;
  showBalls = false;
  showCompactor = false;
  showPistons = false;
  showDoors = false;
  autoRotate = true;
  autoSlomo = true;
  audioOn = false;
  deformMode: DeformMode = "shape";
  captureTrace = false;
  derbyMode = false;

  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private cars: DeformableCar[] = [];
  private liveBuf: DeformableCar[] = [];
  private carCount = 2;
  private get carA(): DeformableCar {
    return this.cars[0]!;
  }
  private get carB(): DeformableCar {
    return this.cars[1] ?? this.cars[0]!;
  }
  private disposed = false;
  private acc = 0;
  private last = 0;
  private phase: CrashPhase = "approach";
  private timeScale = 1;
  private targetScale = 1;
  private userTimeScale: number | null = null;
  private fps = 0;
  private wallSinceImpact = 0;
  private impactKph: number | null = null;
  private elapsedWall = 0;
  private elapsedSim = 0;
  private reduceMotion = false;
  private impactLight: THREE.PointLight;
  private stage!: WorldStage;
  private cine: Cinematics;
  private impactLightLife = 0;
  private envMap: THREE.Texture | null = null;
  private debris: DebrisSystem;
  private readonly wheels = new WheelBatch(MAX_CARS * 4);
  private readonly lampLights: LampLights;
  private sparks: SparkSystem;
  private glassDots: GlassDotSystem;
  private smoke: TireSmokeSystem;
  private audio: CrashAudio;
  private hudAcc = 0;
  private resizeObs: ResizeObserver;
  private ring!: THREE.Mesh;
  private barrier: JerseyBarrier;
  private barrierHits: boolean[] = [];
  private fxPoofed = false;
  private sparkAt = -10;
  private deadSmokeAcc: number[] = [];
  private readonly lodFrustum = new THREE.Frustum();
  private readonly lodMatrix = new THREE.Matrix4();
  private lodFrame = 0;
  /** Per car index: skin stride from the last LoD pass (0 = off-screen). */
  private lodStride: number[] = [];
  private squash = INITIAL_HUD.squash;
  /** Slot 0's class: the HUD's pick for the player's car. */
  private playerClass: VehicleClassId = fleetClass(0);
  private buckle = INITIAL_HUD.buckle;
  private fxDensity = 0.7;
  private speedMin = 0;
  private speedMax = 32;
  private balls: RampBall[] = [];
  private poles: LampPole[] = [];
  private smokeUntil: number[] = [];
  private readonly compactor = new CompactorRig();
  private compactFxAt = 0;
  private press: CompactorPress;
  private pistons = new PistonRig();
  private pistonBank: PistonBank;
  private pistonSelected = 0;
  /** A shot went off since the car was parked; the loop (`stepPistonLoop`) re-parks for the next one. */
  private pistonFired = false;
  /** Last shot fired all eight: show the whole bank, not just the selected ram. */
  private pistonAll = false;
  /** Wall seconds since the last shot (loop pacing). */
  private pistonSinceFire = 0;
  private pistonFxAt = 0;
  private doorRig = new DoorRig();
  private doorRam: DoorRam;
  /** Last finished door shot, for the HUD. */
  private doorShot: RamShot | null = null;
  private doorFx = false;
  private derby = new DerbyMatch();
  private seat = new DriverSeat();
  private keys = new Set<string>();
  private readonly pad = new GamepadInput();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private arena!: THREE.Group;
  private winnerLight!: THREE.PointLight;
  private view: ChaseCamera;
  private trace: TraceRecorder;
  private readonly strongest = new StrongestContact();
  /** Netplay (docs/MULTIPLAYER.md): a client draws host snapshots instead of simulating. */
  readonly net = new NetPlay({
    cars: () => this.live(),
    setCarCount: (n) => this.setCarCount(n),
    matchCar: (i, style, cls) => this.matchCar(i, style, cls),
    setRealism: (v) => this.setRealism(v),
    phase: () => this.phase,
    timeScale: () => this.timeScale,
    mirrorClock: (phase, timeScale) => {
      this.phase = phase;
      this.timeScale = timeScale;
      this.targetScale = timeScale;
    },
    seat: this.seat,
  });
  /** Sandbox floor, grid and rings: hidden while a race course is up. */
  private readonly studio: THREE.Object3D[] = [];
  private sun!: THREE.DirectionalLight;
  private race!: RaceDirector;
  /** Car count to restore when leaving race mode. */
  private sandboxCars = 2;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: (window.devicePixelRatio || 1) <= 1,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(0x12141a, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.45;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 180);
    this.view = new ChaseCamera(this.camera, canvas, this.seat, this.pad.state, this.reduceMotion, (x, y) =>
      this.pickCar(x, y),
    );

    this.scene.background = new THREE.Color(0x12141a);
    this.scene.fog = new THREE.FogExp2(0x12141a, 0.008);
    this.attachStudioEnv();

    this.buildWorld();
    this.arena = makeDerbyArena();
    this.scene.add(this.arena);
    this.winnerLight = new THREE.PointLight(0xffe08a, 0, 18, 2);
    this.scene.add(this.winnerLight);
    this.barrier = new JerseyBarrier(this.scene);
    this.press = new CompactorPress(this.scene, this.compactor.face);
    this.pistonBank = new PistonBank(this.scene, this.pistons);
    this.doorRam = new DoorRam(this.scene);

    this.glassDots = new GlassDotSystem(this.scene);
    this.ensureCars(2);
    this.scene.add(this.wheels.mesh);
    // After the renderer's scene matrix update, before culling/upload: every render path draws current wheels.
    this.scene.onBeforeRender = () => this.wheels.sync(this.live());

    this.debris = new DebrisSystem(this.scene);
    this.sparks = new SparkSystem(this.scene);
    this.smoke = new TireSmokeSystem(this.scene);
    this.cine = new Cinematics(this.renderer, this.scene, this.view, { sparks: this.sparks, glass: this.glassDots }, MAX_CARS, this.reduceMotion);
    // `?fx=off|low|high` picks the starting tier (bench A/B); high otherwise.
    const fxParam = new URLSearchParams(window.location.search).get("fx");
    this.cine.setTier(FX_TIERS.find((t) => t === fxParam) ?? "high");
    this.audio = new CrashAudio();
    this.trace = new TraceRecorder({
      barrier: this.barrier,
      balls: this.balls,
      sparks: this.sparks,
      smoke: this.smoke,
      debris: this.debris,
    });

    this.impactLight = new THREE.PointLight(0xffc27a, 0, 22, 2);
    this.scene.add(this.impactLight);
    this.lampLights = new LampLights(this.scene, MAX_CARS * 4);
    this.race = new RaceDirector({
      scene: this.scene,
      camera: this.camera,
      sun: this.sun,
      seat: this.seat,
      live: () => this.live(),
      setCarCount: (n) => this.ensureCars(n),
      dress: (car) => this.dressCar(car),
      setPaused: (on) => {
        this.playing = !on;
        this.emitHud(true);
      },
      leave: () => this.toggleRace(),
      hitFx: (contact, normal, impulse) => {
        if (this.elapsedWall - this.sparkAt < 0.12) return;
        this.sparkAt = this.elapsedWall;
        this.sparks.poof(contact, normal, Math.min(56, 12 + impulse * 1.2) * this.fxDensity);
        if (impulse > 6) this.debris.burst(contact, normal, Math.min(40, impulse * 1.5) * this.fxDensity);
      },
      buildArt: (track, placed) => new TrackArt(track, placed),
    });

    this.resize();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas.parentElement ?? canvas);

    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.pad.attach(() => this.emitHud(true));
    this.view.attach();
    try {
      this.randomizeAndReset();
    } catch (err) {
      console.error("randomizeAndReset failed", err);
      throw err;
    }
    (window as unknown as { __crush?: CrashEngine }).__crush = this;
    this.emitHud(true);
    this.renderer.render(this.scene, this.camera);
  }

  start(): void {
    this.last = performance.now();
    this.renderer.setAnimationLoop(this.tick);
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.pad.detach();
    this.net.leave();
    this.view.detach();
    this.resizeObs.disconnect();
    for (const car of this.cars) car.dispose();
    this.race.dispose();
    this.wheels.mesh.geometry.dispose();
    this.wheels.mesh.dispose();
    this.sparks.dispose();
    this.cine.dispose();
    this.glassDots.dispose();
    this.smoke.dispose();
    this.lampLights.dispose();
    this.audio.dispose();
    this.envMap?.dispose();
    this.envMap = null;
    this.scene.environment = null;
    this.scene.clear();
    const gl = this.renderer.getContext();
    this.renderer.dispose();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }

  togglePlay(): void {
    this.playing = !this.playing;
    this.tryUnlockAudio();
    this.emitHud(true);
  }

  toggleLoop(): void {
    this.looping = !this.looping;
    this.emitHud(true);
  }

  toggleRig(): void {
    this.showRig = !this.showRig;
    for (const car of this.live()) car.setRigVisible(this.showRig);
    this.emitHud(true);
  }

  toggleParticles(): void {
    this.showParticles = !this.showParticles;
    for (const car of this.live()) car.deform.setParticlesVisible(this.showParticles);
    this.emitHud(true);
  }

  toggleOrbit(): void {
    this.autoRotate = !this.autoRotate;
    this.emitHud(true);
  }

  toggleSlomo(): void {
    this.autoSlomo = !this.autoSlomo;
    if (!this.autoSlomo) {
      if (this.userTimeScale == null) {
        this.timeScale = 1;
        this.targetScale = 1;
      }
    }
    this.emitHud(true);
  }

  toggleAudio(): void {
    this.audioOn = !this.audioOn;
    this.tryUnlockAudio();
    this.emitHud(true);
  }

  /** Cinematic FX quality: off renders exactly as before; low / high add post, tyre marks and the crash cam. */
  setFxTier(tier: FxTier): void {
    this.cine.setTier(tier);
    this.emitHud(true);
  }

  cycleFxTier(): void {
    this.setFxTier(FX_TIERS[(FX_TIERS.indexOf(this.cine.tier) + 1) % FX_TIERS.length]!);
  }

  setNight(on: boolean): void {
    this.stage.setNight(on);
    this.smoke.shade = this.cine.tyreSmoke.shade = this.stage.smokeShade;
    if (this.scene.environment) this.scene.environmentIntensity = this.stage.envIntensity;
    this.emitHud(true);
  }

  setWet(on: boolean): void {
    this.stage.setWet(on);
    this.emitHud(true);
  }

  toggleDeformMode(): void {
    this.deformMode = this.deformMode === "shape" ? "lattice" : "shape";
    for (const car of this.live()) car.deform.setMode(this.deformMode);
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud(true);
  }

  private tryUnlockAudio(): void {
    if (this.audioOn) this.audio.unlock();
  }

  toggleBarrier(): void {
    if (this.showCompactor || this.showPistons || this.showDoors) return;
    if (this.derbyMode) this.setDerby(false);
    if (this.race.active) this.setRace(false);
    this.showBarrier = !this.showBarrier;
    this.barrier.group.visible = this.showBarrier;
    if (this.showBarrier) this.barrier.orient(this.carA.group.position);
    this.tryUnlockAudio();
    this.emitHud(true);
  }

  toggleBalls(): void {
    if (this.showCompactor || this.showPistons || this.showDoors) return;
    if (this.derbyMode) this.setDerby(false);
    if (this.race.active) this.setRace(false);
    this.showBalls = !this.showBalls;
    scatterRampBalls(this.balls, this.showBalls);
    this.tryUnlockAudio();
    this.emitHud(true);
  }

  toggleCompactor(): void {
    if (this.derbyMode) this.setDerby(false);
    if (this.race.active) this.setRace(false);
    this.showCompactor = !this.showCompactor;
    this.showPistons = false;
    this.showDoors = false;
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud(true);
  }

  togglePistons(): void {
    if (this.derbyMode) this.setDerby(false);
    if (this.race.active) this.setRace(false);
    this.showPistons = !this.showPistons;
    this.showCompactor = false;
    this.showDoors = false;
    this.tryUnlockAudio();
    this.randomizeAndReset();
    // Frame only on entering: re-parks and loop hops keep the user's view and the orbit running. The camera
    // starts 1.2 s of orbit short of the front-right ram so the first synced shot comes from its side.
    if (this.showPistons) this.view.frameReset(true, this.live(), pistonBearing(2) - PISTON_ORBIT_RATE * 1.2);
    this.emitHud(true);
  }

  /** Fire piston `index` (0–7 in key order) or all eight (8). A free car already shoved off the pad is parked fresh first. */
  firePiston(index: number): void {
    if (!this.showPistons || this.pistons.busy) return;
    if (this.pistonFired && this.carA.group.position.lengthSq() > 0.09) this.randomizeAndReset();
    if (index < PISTON_IDS.length) this.pistonSelected = index;
    this.pistonAll = index >= PISTON_IDS.length;
    this.pistonFired = true;
    this.pistonSinceFire = 0;
    this.pistons.fire(index < PISTON_IDS.length ? PISTON_IDS[index]! : "all");
    // The run-up lasts a few hundredths of a second: slow down now so it reads.
    if (this.autoSlomo && this.userTimeScale == null && this.phase === "approach") {
      this.targetScale = 0.15;
      this.timeScale = Math.min(this.timeScale, 0.15);
    }
    this.tryUnlockAudio();
    this.emitHud(true);
  }

  setPistonConfig(patch: Partial<PistonConfig>): void {
    this.pistons.setConfig(patch);
    this.pistonBank.sync(this.pistons, this.pistonSelected, this.pistonAll);
    this.emitHud(true);
  }

  toggleDoors(): void {
    if (this.derbyMode) this.setDerby(false);
    if (this.race.active) this.setRace(false);
    this.showDoors = !this.showDoors;
    this.showCompactor = false;
    this.showPistons = false;
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud(true);
  }

  /** Fire a sketch scene (A/B/C) on the selected side; a car missing that side's door or mirror is parked fresh first. */
  fireDoorRam(scenario: DoorScenario): void {
    if (!this.showDoors || this.doorRig.phase === "run") return;
    const side = this.doorRig.side;
    if (this.carA.partOff(side < 0 ? "doorL" : "doorR") || this.carA.partOff(side < 0 ? "mirrorL" : "mirrorR")) {
      this.randomizeAndReset();
    }
    this.doorShot = null;
    this.doorFx = false;
    this.doorRig.fire(scenario, side);
    // A fast ram crosses the car in a few tenths of a second: slow it down so it reads.
    if (this.autoSlomo && this.userTimeScale == null) this.targetScale = this.doorRig.kph > 15 ? 0.3 : 1;
    this.tryUnlockAudio();
    this.emitHud(true);
  }

  setDoorConfig(patch: { kph?: number; kg?: number; side?: -1 | 1 }): void {
    if (patch.kph != null) this.doorRig.kph = THREE.MathUtils.clamp(patch.kph, 1, 120);
    if (patch.kg != null) this.doorRig.kg = THREE.MathUtils.clamp(patch.kg, 5, 5000);
    if (patch.side != null && this.doorRig.phase === "idle") {
      this.doorRig.side = patch.side;
      this.doorRam.sync(this.doorRig);
    }
    this.emitHud(true);
  }

  /** Swing the selected door between shut (latched) and the B/C start angle. */
  toggleDoorOpen(): void {
    if (!this.showDoors || this.doorRig.phase === "run") return;
    const side = this.doorRig.side;
    this.carA.setDoorOpen(side, this.carA.doorHinge(side).theta > 0.01 ? 0 : DOOR_LANES.overOpen.open);
    this.emitHud(true);
  }

  toggleDerby(): void {
    if (this.race.active) this.setRace(false);
    this.setDerby(!this.derbyMode);
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud(true);
  }

  private setDerby(on: boolean): void {
    this.derbyMode = on;
    this.arena.visible = on;
    for (const p of this.poles) p.group.visible = !on;
    if (on) {
      this.showBarrier = false;
      this.showBalls = false;
      this.showCompactor = false;
      this.showPistons = false;
      this.showDoors = false;
      this.barrier.group.visible = false;
      this.autoSlomo = false;
      if (this.userTimeScale == null) {
        this.timeScale = 1;
        this.targetScale = 1;
      }
    } else {
      this.derby.end();
      this.winnerLight.intensity = 0;
      for (const car of this.cars) car.setHighlight(false);
    }
  }

  /** Race scene on / off (scene picker, X). */
  toggleRace(): void {
    this.setRace(!this.race.active);
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud(true);
  }

  /** HUD → race. The HUD never touches race state itself. */
  raceCommand(cmd: RaceCommand): void {
    this.race.command(cmd);
    this.emitHud(true);
  }

  private setRace(on: boolean): void {
    if (on === this.race.active) return;
    if (on) {
      if (this.derbyMode) this.setDerby(false);
      this.showBarrier = false;
      this.showBalls = false;
      this.showCompactor = false;
      this.showPistons = false;
      this.showDoors = false;
      this.barrier.group.visible = false;
      scatterRampBalls(this.balls, false);
      this.press.group.visible = false;
      this.pistonBank.group.visible = false;
      this.doorRam.group.visible = false;
      if (this.userTimeScale == null) {
        this.timeScale = 1;
        this.targetScale = 1;
      }
      this.sandboxCars = this.carCount;
    }
    for (const o of this.studio) o.visible = !on;
    for (const p of this.poles) p.group.visible = !on;
    if (on) {
      this.race.enter();
    } else {
      this.race.exit();
      this.ensureCars(this.sandboxCars);
    }
  }

  setSquash(value: number): void {
    this.squash = THREE.MathUtils.clamp(value, KNOB_RANGES.squash.min, KNOB_RANGES.squash.max);
    for (const car of this.live()) car.deform.squash = this.squash;
    this.emitHud(true);
  }

  setBuckle(value: number): void {
    this.buckle = THREE.MathUtils.clamp(value, KNOB_RANGES.buckle.min, KNOB_RANGES.buckle.max);
    for (const car of this.live()) car.deform.buckle = this.buckle;
    this.emitHud(true);
  }

  setFxDensity(value: number): void {
    this.fxDensity = THREE.MathUtils.clamp(value, 0, 1.2);
    this.emitHud(true);
  }

  /** Arcade (0) ↔ realistic (1): grip and drift assists in applyDrive, and when every car's drivetrain dies. */
  setRealism(value: number): void {
    HANDLING.realism = THREE.MathUtils.clamp(value, KNOB_RANGES.realism.min, KNOB_RANGES.realism.max);
    for (const car of this.cars) car.deform.killTravel = killTravel(carClass(car), HANDLING.realism, this.derbyMode ? "derby" : "default");
    this.emitHud(true);
  }

  /** The player's car (slot 0) becomes `id`, rebuilt on that class's body; the field respawns and the camera follows it. */
  setPlayerClass(id: VehicleClassId): void {
    if (!(id in CLASSES)) return;
    this.playerClass = id;
    const old = this.cars[0];
    if (old && carClass(old) !== id) {
      this.scene.remove(old.group);
      old.dispose();
      this.cars[0] = this.buildCar(0);
      this.cars[0].group.visible = true;
    }
    this.randomizeAndReset();
    this.seat.focus(0);
    this.emitHud(true);
  }

  setCarCount(n: number): void {
    // The race sets its own field (setup menu); the sandbox slider must not reshape it.
    if (this.race.active) return;
    this.ensureCars(n);
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud(true);
  }

  setSpeedRange(min: number, max: number): void {
    const a = Number.isFinite(min) ? THREE.MathUtils.clamp(min, 0, 48) : 0;
    const b = Number.isFinite(max) ? THREE.MathUtils.clamp(max, 0, 48) : 32;
    this.speedMin = Math.min(a, b);
    this.speedMax = Math.max(a, b);
    this.emitHud(true);
  }

  setTimeScale(value: number | null): void {
    if (value == null || !Number.isFinite(value)) {
      this.userTimeScale = null;
      this.targetScale = 1;
      this.timeScale = 1;
    } else {
      const v = THREE.MathUtils.clamp(value, 0.02, 2);
      this.userTimeScale = v;
      this.targetScale = v;
      this.timeScale = v;
    }
    this.emitHud(true);
  }

  toggleCapture(): void {
    this.captureTrace = !this.captureTrace;
    if (this.captureTrace && this.trace.samples.length === 0) this.beginTrace();
    this.emitHud(true);
  }

  resetDefaults(): void {
    this.playing = INITIAL_HUD.playing;
    this.looping = INITIAL_HUD.looping;
    this.showRig = INITIAL_HUD.showRig;
    this.showParticles = INITIAL_HUD.showParticles;
    this.showBarrier = INITIAL_HUD.showBarrier;
    this.showBalls = INITIAL_HUD.showBalls;
    this.showCompactor = INITIAL_HUD.showCompactor;
    this.showPistons = INITIAL_HUD.showPistons;
    this.pistons.setConfig(PISTON_DEFAULTS);
    this.showDoors = INITIAL_HUD.showDoors;
    this.doorRig.kph = RAM_DEFAULTS.kph;
    this.doorRig.kg = RAM_DEFAULTS.kg;
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
    this.userTimeScale = null;
    this.timeScale = 1;
    this.targetScale = 1;
    this.view.userFramed = false;
    this.setDerby(false);
    this.setRealism(INITIAL_HUD.realism);
    if (this.playerClass !== INITIAL_HUD.playerClass) this.setPlayerClass(INITIAL_HUD.playerClass);
    this.ensureCars(INITIAL_HUD.carCount);
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud(true);
  }

  copyTraceJson(): string {
    if (!this.trace.initial) this.trace.snapshotInitial(this.traceSetup(), this.live());
    if (!this.captureTrace) {
      const json = this.trace.setupJson(this.deformMode, this.autoSlomo, this.userTimeScale);
      this.emitHud(true);
      return json;
    }
    return this.trace.traceJson(this.traceSetup(), this.deformMode);
  }

  reset(): void {
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud(true);
  }

  private live(): DeformableCar[] {
    const n = this.carCount;
    const buf = this.liveBuf;
    if (buf.length !== n) buf.length = n;
    for (let i = 0; i < n; i++) buf[i] = this.cars[i]!;
    return buf;
  }

  private ensureCars(n: number): void {
    const count = THREE.MathUtils.clamp(Math.round(n) || 1, 1, MAX_CARS);
    this.carCount = count;
    while (this.cars.length < count) this.cars.push(this.buildCar(this.cars.length));
    for (let i = 0; i < this.cars.length; i++) {
      this.cars[i]!.group.visible = i < count;
    }
    this.barrierHits = Array.from({ length: count }, () => false);
    while (this.smokeUntil.length < count) this.smokeUntil.push(0);
    this.smokeUntil.length = count;
    if (this.seat.carIndex >= count) this.seat.clear();
  }

  private buildCar(
    i: number,
    cls: VehicleClassId = i === 0 ? this.playerClass : fleetClass(i),
    style: CarStyleId = i === 0 ? CLASSES[cls].style : fleetStyle(i),
  ): DeformableCar {
    const base = FLEET_PAINT[i % FLEET_PAINT.length]!;
    const paint: CarPaint =
      i < FLEET_PAINT.length ? base : { ...base, name: `${base.name}-${Math.floor(i / FLEET_PAINT.length) + 1}` };
    const car = new DeformableCar(paint, this.scene, (origin, vel, count) => this.glassDots.burst(origin, vel, count), style);
    assignClass(car, cls);
    car.group.visible = false;
    car.group.userData.carIndex = i;
    this.scene.add(car.group);
    return car;
  }

  /** Netplay client: car `i` takes the host's body style and class, rebuilt only when either differs. */
  matchCar(i: number, style: CarStyleId, cls: VehicleClassId): void {
    const old = this.cars[i];
    if (!old || (old.style.id === style && carClass(old) === cls)) return;
    this.scene.remove(old.group);
    old.dispose();
    const car = this.buildCar(i, cls, style);
    car.group.visible = i < this.carCount;
    this.dressCar(car);
    this.cars[i] = car;
  }

  private dressCar(car: DeformableCar): void {
    car.deform.squash = this.squash;
    car.deform.buckle = this.buckle;
    car.deform.setMode(this.deformMode);
    car.setRigVisible(this.showRig);
    car.deform.setParticlesVisible(this.showParticles);
    // Re-dress after a respawn re-attached its parts, and arm the slider's kill travel (a derby's is shorter).
    const cls = carClass(car);
    assignClass(car, cls);
    car.deform.killTravel = killTravel(cls, HANDLING.realism, this.derbyMode ? "derby" : "default");
  }

  private onKey = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    // Text fields keep their keys; a focused range slider does not swallow drive keys.
    if (target?.tagName === "TEXTAREA" || (target?.tagName === "INPUT" && (target as HTMLInputElement).type !== "range")) return;
    // A race menu owns the keyboard (and the pad) through the HUD.
    if (this.race.menuOpen) return;
    this.keys.add(e.code);
    const driving = this.seat.mode === "drive";
    if (this.seat.mode !== "global" && e.code.startsWith("Arrow")) e.preventDefault();
    // Every Space keydown, repeats included: an unprevented repeat arms a focused HUD button and the release clicks it.
    if (e.code === "Space") e.preventDefault();
    if (e.repeat) return;
    if (this.race.active && this.raceKey(e.code, driving)) return;
    if (e.code === "Space") {
      if (!driving) this.togglePlay();
    } else if (e.code === "Escape") {
      this.seat.esc();
      this.emitHud(true);
    } else if (e.code === "KeyV" || e.code === "KeyT" || (e.code === "KeyC" && driving)) {
      if (driving) {
        this.seat.cycleView();
        this.emitHud(true);
      }
    } else if (e.code === "KeyQ" || e.code === "KeyE") {
      this.seat.cycle(e.code === "KeyE" ? 1 : -1, this.carCount);
      this.emitHud(true);
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
    } else if (e.code === "KeyC") {
      this.toggleCompactor();
    } else if (e.code === "KeyI") {
      this.togglePistons();
    } else if (e.code === "KeyN") {
      this.toggleDoors();
    } else if (this.showDoors && /^Digit[1-5]$/.test(e.code)) {
      const n = Number(e.code.slice(5));
      if (n <= 3) this.fireDoorRam(n === 1 ? "mirror" : n === 2 ? "overOpen" : "shut");
      else if (n === 4) this.toggleDoorOpen();
      else this.setDoorConfig({ side: this.doorRig.side < 0 ? 1 : -1 });
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
  private raceKey(code: string, driving: boolean): boolean {
    switch (code) {
      case "Escape":
        this.raceCommand({ type: "pause" });
        return true;
      case "KeyR":
        this.race.requestRespawn();
        return true;
      case "KeyQ":
      case "KeyE":
        this.race.cycle(code === "KeyE" ? 1 : -1);
        this.emitHud(true);
        return true;
      case "KeyV":
      case "KeyT":
      case "KeyC":
        if (driving) this.seat.cycleView();
        this.emitHud(true);
        return true;
      case "KeyH":
        this.raceCommand({ type: "fullUi", on: !this.race.fullUi });
        return true;
      default:
        return !this.race.fullUi;
    }
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  /** Keys released while the tab is unfocused never send keyup; drop them all. */
  private onBlur = (): void => {
    this.keys.clear();
  };

  /** Once per frame: keys + pad → seat intent; pad button presses → seat / scene actions. */
  private pollInput(): void {
    const pad = this.pad.poll();
    // Polled every frame so button edges stay fresh; a race menu reads the pad itself through the HUD.
    if (this.race.menuOpen) return;
    if (this.seat.sample(this.keys, pad)) this.emitHud(true);
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
    if (driving && (hit & (1 << PAD_BUTTON.north)) !== 0) this.seat.cycleView();
    if (driving && (hit & (1 << PAD_BUTTON.down)) !== 0) this.recoverDriven();
    this.emitHud(true);
  }

  /** Pad buttons during a race (no menu up): Start / Back pause, LB/RB spectate, Y view, D-pad ↓ respawn. */
  private racePad(hit: number): void {
    const press = (b: number) => (hit & (1 << b)) !== 0;
    if (press(PAD_BUTTON.start) || press(PAD_BUTTON.back)) this.race.command({ type: "pause" });
    if (press(PAD_BUTTON.lb)) this.race.cycle(-1);
    if (press(PAD_BUTTON.rb)) this.race.cycle(1);
    if (this.seat.mode === "drive" && press(PAD_BUTTON.north)) this.seat.cycleView();
    if (press(PAD_BUTTON.down)) this.race.requestRespawn();
    this.emitHud(true);
  }

  /**
   * R / D-pad down while driving: back on its wheels where it stands, at rest and
   * repaired. In a derby only a flipped car that still runs may, so it is no free heal.
   */
  private recoverDriven(): void {
    const car = this.seat.carIndex < this.carCount ? this.cars[this.seat.carIndex] : undefined;
    if (!car) return;
    car.refreshBasis();
    const upright = car.group.matrixWorld.elements[5]! > 0.5;
    if (this.derbyMode && (upright || !car.deform.drivetrainAlive)) return;
    car.spawnFacing(car.group.position.x, car.group.position.z, Math.atan2(car.fwdFlat.x, car.fwdFlat.z), 0);
    this.dressCar(car);
  }

  private pickCar(clientX: number, clientY: number): void {
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
          this.emitHud(true);
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
    this.emitHud(true);
  }

  private randomizeAndReset(): void {
    this.compactor.face = COMPACTOR.startFace;
    this.compactFxAt = 0;
    if (this.race.active) {
      this.race.reset();
      this.finishResetCommon();
      return;
    }
    if (this.showCompactor) {
      this.parkCompactor();
      this.finishResetCommon();
      return;
    }
    if (this.showPistons) {
      this.parkPistons();
      this.finishResetCommon();
      return;
    }
    if (this.showDoors) {
      this.parkDoors();
      this.finishResetCommon();
      return;
    }
    this.press.group.visible = false;
    this.pistonBank.group.visible = false;
    this.doorRam.group.visible = false;
    if (this.derbyMode) this.spawnDerby();
    else this.spawnFleet();
    this.barrierHits.fill(false);
    this.barrier.group.visible = this.showBarrier;
    if (this.showBarrier) this.barrier.orient(this.carA.group.position);
    scatterRampBalls(this.balls, this.showBalls);
    resetLampPoles(this.poles, !this.derbyMode);
    this.finishResetCommon();
  }

  private spawnFleet(): void {
    const cars = this.live();
    const slots = layoutFleet(cars.length, this.speedMin, this.speedMax);
    for (let i = 0; i < cars.length; i++) {
      const slot = slots[i]!;
      const car = cars[i]!;
      car.group.visible = true;
      car.spawn(slot.x, slot.z, slot.speed);
      this.dressCar(car);
    }
    for (let i = this.carCount; i < this.cars.length; i++) {
      const extra = this.cars[i]!;
      extra.group.visible = false;
      extra.group.position.set(80 + i * 6, 0, 80);
      extra.velocity.set(0, 0, 0);
    }
  }

  private spawnDerby(): void {
    const cars = this.live();
    const slots = layoutDerby(cars.length, DERBY_RADIUS, 12);
    this.derby.begin(cars.map((c, i) => ({ id: i, name: c.paint.name })));
    this.winnerLight.intensity = 0;
    for (let i = 0; i < cars.length; i++) {
      const slot = slots[i]!;
      const car = cars[i]!;
      car.group.visible = true;
      car.spawnFacing(slot.x, slot.z, slot.yaw, slot.speed);
      this.dressCar(car);
      car.setHighlight(false);
    }
    for (let i = this.carCount; i < this.cars.length; i++) {
      const extra = this.cars[i]!;
      extra.group.visible = false;
      extra.setHighlight(false);
      extra.group.position.set(80 + i * 6, 0, 80);
      extra.velocity.set(0, 0, 0);
    }
    this.arena.visible = true;
    for (const p of this.poles) p.group.visible = false;
  }

  /** One car parked at the origin facing +Z, everything else put away. */
  private parkSolo(): DeformableCar {
    this.ensureCars(Math.max(this.carCount, 1));
    const parked = this.carA;
    parked.resetVisual();
    parked.group.visible = true;
    parked.yaw = 0;
    parked.pitch = 0;
    parked.roll = 0;
    parked.group.position.set(0, 0, 0);
    parked.group.rotation.set(0, 0, 0, "YXZ");
    parked.group.quaternion.identity();
    parked.velocity.set(0, 0, 0);
    parked.angular.set(0, 0, 0);
    parked.crashed = false;
    parked.speed = 0;
    parked.spawnSpeed = 0;
    parked.refreshBasis();
    this.dressCar(parked);
    parked.deform.bindKinematic(parked.group, parked.velocity, parked.angular);

    for (let i = 1; i < this.cars.length; i++) {
      const extra = this.cars[i]!;
      extra.resetVisual();
      extra.group.visible = false;
      extra.group.position.set(48 + i * 4, 0, 48);
      extra.velocity.set(0, 0, 0);
    }

    this.barrier.group.visible = false;
    this.barrierHits.fill(false);
    for (const b of this.balls) b.mesh.visible = false;
    this.press.group.visible = false;
    this.pistonBank.group.visible = false;
    this.doorRam.group.visible = false;
    return parked;
  }

  private parkCompactor(): void {
    const parked = this.parkSolo();
    this.compactor.attach(parked);
    this.press.group.visible = true;
    this.press.sync(this.compactor.face);
  }

  private parkPistons(): void {
    const parked = this.parkSolo();
    this.pistonFired = false;
    this.pistonFxAt = 0;
    this.pistons.attach(parked);
    this.pistonBank.group.visible = true;
    this.pistonBank.sync(this.pistons, this.pistonSelected, this.pistonAll);
  }

  private parkDoors(): void {
    const parked = this.parkSolo();
    this.doorRig.attach(parked);
    this.doorShot = null;
    this.doorFx = false;
    this.doorRam.group.visible = true;
    this.doorRam.sync(this.doorRig);
  }

  private finishResetCommon(): void {
    this.phase = "approach";
    if (this.userTimeScale != null) {
      this.timeScale = this.userTimeScale;
      this.targetScale = this.userTimeScale;
    } else {
      this.timeScale = 1;
      this.targetScale = 1;
    }
    this.wallSinceImpact = 0;
    this.elapsedWall = 0;
    this.elapsedSim = 0;
    this.impactKph = null;
    this.impactLightLife = 0;
    this.impactLight.intensity = 0;
    this.debris.reset();
    this.sparks.reset();
    this.glassDots.reset();
    this.smoke.reset();
    this.cine.reset();

    if (!this.showPistons) this.view.frameReset(this.showCompactor || this.showDoors, this.live());
    this.smokeUntil.fill(0);
    this.deadSmokeAcc.length = 0;
    this.sparkAt = -10;
    this.fxPoofed = false;
    this.barrier.reset();
    this.trace.setupCopied = false;
    this.trace.snapshotInitial(this.traceSetup(), this.live());
    if (this.captureTrace) this.beginTrace();
    else this.trace.clear();
  }

  private traceSetup(): TraceSetup {
    return {
      barrier: this.showBarrier,
      barrierYaw: this.barrier.yaw,
      squash: this.squash,
      buckle: this.buckle,
      fxDensity: this.fxDensity,
      balls: this.showBalls,
      compactor: this.showCompactor,
      compactFace: this.compactor.face,
      carCount: this.carCount,
      speedMin: this.speedMin,
      speedMax: this.speedMax,
    };
  }

  private traceClock(): TraceClock {
    return {
      wall: this.elapsedWall,
      sim: this.elapsedSim,
      phase: this.phase,
      timeScale: this.timeScale,
      closing: this.fleetClosing(),
      barrierHit: this.barrierHits.some(Boolean),
    };
  }

  private beginTrace(): void {
    this.trace.begin(this.traceSetup(), this.live(), this.traceClock());
  }

  private fleetClosing(): number {
    if (this.showCompactor) return COMPACTOR.speed * 2;
    if (this.showPistons) {
      let u = 0;
      for (const h of this.pistons.heads) u = Math.max(u, h.u);
      return u;
    }
    if (this.showDoors) return this.doorRig.u;
    const cars = this.live();
    if (cars.length < 2) return cars[0]?.velocity.length() ?? 0;
    let best = 0;
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const d = cars[i]!.velocity.distanceTo(cars[j]!.velocity);
        if (d > best) best = d;
      }
    }
    return best;
  }

  private tick = (now: number): void => {
    if (this.disposed) return;
    try {
      this.tickInner(now);
    } catch (err) {
      console.error("Crush Stream tick failed", err);
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
    }
  };

  private tickInner(now: number): void {
    if (this.disposed) return;
    // The first rAF stamp can predate `start()`'s performance.now(): a negative dt froze the sim for seconds.
    const wallDt = Math.min(Math.max(0, (now - this.last) / 1000), 0.1);
    this.last = now;
    if (wallDt > 1e-4) {
      const inst = 1 / wallDt;
      this.fps = this.fps > 1 ? this.fps * 0.85 + inst * 0.15 : inst;
    }
    this.pollInput();

    if (this.playing) {
      this.elapsedWall += wallDt;
      // A netplay client mirrors the host's phase and slow-mo (`net.frame`) instead of running its own.
      if (!this.net.client) this.maybePreSlowmo(wallDt);
      this.timeScale += (this.targetScale - this.timeScale) * Math.min(1, wallDt * (this.phase === "aftermath" ? 1.15 : 3.2));
      const simDt = wallDt * this.timeScale * this.cine.timeWarp;
      const cars = this.live();
      const vmax = sliceSpeed(cars);
      this.acc += simDt;
      if (this.acc > 0.05) this.acc = 0.05;
      const budget = now + 8;
      let steps = 0;
      while (!this.net.client && this.acc > 1e-5 && steps < 8) {
        const h = physicsSlice(this.acc, vmax);
        this.fixedStep(h);
        this.elapsedSim += h;
        this.acc -= h;
        for (const car of cars) {
          if (car.deform.massActive && !car.deform.drivetrainAlive) car.deform.cutDrive(h);
          if (this.wallSinceImpact > 0.2 && car.crashed) bleedAfterSlide(car, h);
        }
        steps++;
        if (steps >= 2 && performance.now() > budget) break;
      }
      this.scheduleSkins(cars);
      for (const car of cars) {
        if (this.net.client) break;
        if ((this.showCompactor || this.showPistons || this.showDoors) && car !== this.carA) continue;
        car.updateDeform(simDt);
      }
      this.net.frame(wallDt);
      if (!this.net.client) this.updatePhase(wallDt);
      if (this.showPistons && this.looping) this.stepPistonLoop(wallDt);
      if (this.phase !== "approach") this.emitContactFx();
      if (this.impactLightLife > 0) {
        this.impactLightLife -= wallDt;
        this.impactLight.intensity = Math.max(0, this.impactLightLife * 90);
      }
      this.view.trauma = Math.max(0, this.view.trauma - wallDt * 1.6);
      if (this.showBarrier) this.barrier.step(simDt);
      const fxDt = Math.max(simDt, wallDt * 0.6);
      this.debris.update(fxDt, this.bounceWorld);
      this.sparks.update(fxDt, bounceGround);
      this.glassDots.update(fxDt, bounceGround);
      this.smoke.update(fxDt, bounceGround, this.camera);
      for (let i = 0; i < cars.length; i++) {
        const car = cars[i]!;
        if (!car.deform.drivetrainAlive) {
          this.deadSmokeAcc[i] = (this.deadSmokeAcc[i] ?? 0) + wallDt;
          if (this.deadSmokeAcc[i]! > 0.14) {
            this.deadSmokeAcc[i] = 0;
            this.puffDeadEngine(car);
          }
        } else if (this.elapsedWall < (this.smokeUntil[i] ?? 0)) {
          this.puffEngine(car);
        } else if (damageStage(car) === "limping") {
          // A limping engine trails a thin thread, half the dead engine's rate.
          this.deadSmokeAcc[i] = (this.deadSmokeAcc[i] ?? 0) + wallDt;
          if (this.deadSmokeAcc[i]! > 0.28) {
            this.deadSmokeAcc[i] = 0;
            this.puffDeadEngine(car);
          }
        }
      }
      if (this.trace.due(wallDt, this.captureTrace)) this.trace.push(this.traceSetup(), cars, this.traceClock());
      this.stepDerby(simDt);
      this.seat.step(simDt);
      this.cine.update(wallDt, simDt, cars, this.followedCar(), this.seat.mode === "drive", this.fxDensity);
      if (this.derbyMode) {
        for (const id of this.derby.consumeBoosts()) {
          if (id === this.seat.carIndex && this.seat.mode === "drive") this.seat.addBoost(BOOST.takedown);
        }
      }
    }

    if (this.race.active) this.race.frame(this.playing ? wallDt : 0);
    this.updateCamera(wallDt);
    this.flushVisibleSkins();
    this.lampLights.update(this.live(), this.camera, this.followedCar());
    if (this.stage.night) this.stage.syncPools(this.poles);
    this.cine.render(this.scene, this.camera, wallDt);

    this.hudAcc += wallDt;
    if (this.hudAcc > (this.timeScale < 0.5 ? 0.05 : 0.12)) {
      this.hudAcc = 0;
      this.emitHud(false);
    }
  }

  /**
   * Deform LoD. Skinning (+ normals) is the per-vertex cost, so a car outside the view frustum
   * defers it and a small one skins every 2nd / 4th frame; the cage/shape solve always runs.
   * Deferred cars carry `skinOwed`, which `flushVisibleSkins` settles once the camera has moved,
   * so no car is ever drawn on-screen with a dent it has not been given. The followed car always skins.
   */
  private scheduleSkins(cars: DeformableCar[]): void {
    this.updateLodFrustum();
    this.lodFrame++;
    const followed = this.followedCar();
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      const stride = car === followed ? 1 : this.skinStride(car);
      this.lodStride[i] = stride;
      car.deform.skinDeferred = stride === 0 || (this.lodFrame + i) % stride !== 0;
    }
  }

  /** After the camera update: any owed car now on screen at full rate, or just entering the view, skins before it draws. */
  private flushVisibleSkins(): void {
    const cars = this.live();
    let followed: DeformableCar | null | undefined;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      if (!car.deform.skinOwed) continue;
      if (followed === undefined) {
        this.updateLodFrustum();
        followed = this.followedCar();
      }
      const stride = car === followed ? 1 : this.skinStride(car);
      if (stride === 1 || (stride > 1 && this.lodStride[i] === 0)) car.flushDeferredSkin();
      this.lodStride[i] = stride;
    }
  }

  private updateLodFrustum(): void {
    this.camera.updateMatrixWorld();
    this.lodMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.lodFrustum.setFromProjectionMatrix(this.lodMatrix);
  }

  /** 0 off-screen, else skin every Nth frame by projected size. Needs `updateLodFrustum` this frame. */
  private skinStride(car: DeformableCar): number {
    _lodSphere.center.set(car.group.position.x, car.group.position.y + 0.6, car.group.position.z);
    _lodSphere.radius = LOD_RADIUS;
    if (!this.lodFrustum.intersectsSphere(_lodSphere)) return 0;
    const d = _v.setFromMatrixPosition(this.camera.matrixWorld).distanceTo(_lodSphere.center);
    if (d <= LOD_RADIUS) return 1;
    const halfHeightPx = (this.renderer.domElement.height / this.renderer.getPixelRatio()) * 0.5;
    const px = (LOD_RADIUS / (d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)))) * halfHeightPx;
    return px >= LOD_SMALL_PX ? 1 : px >= LOD_TINY_PX ? 2 : 4;
  }

  private followedCar(): DeformableCar | null {
    return this.seat.mode !== "global" && this.seat.carIndex >= 0 && this.seat.carIndex < this.carCount
      ? this.cars[this.seat.carIndex]!
      : null;
  }

  private maybePreSlowmo(wallDt: number): void {
    if (this.derbyMode || this.race.active) return;
    if (this.userTimeScale != null) return;
    if (!this.autoSlomo) return;
    if (this.showCompactor || this.showPistons || this.showDoors) return;
    if (this.phase !== "approach") return;
    const scale = this.reduceMotion ? 0.16 : IMPACT_SCALE;
    if (this.timeScale <= scale * 1.2) return;
    const eta = this.contactEta();
    if (!Number.isFinite(eta)) return;
    if (eta > Math.max(PRE_IMPACT_LEAD, wallDt + FIXED)) return;
    this.timeScale = scale;
    this.targetScale = scale;
  }

  private contactEta(): number {
    const cars = this.live();
    for (const car of cars) car.refreshBasis();
    let eta = Number.POSITIVE_INFINITY;

    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i]!;
        const b = cars[j]!;
        const ax = a.group.position.x;
        const az = a.group.position.z;
        const bx = b.group.position.x;
        const bz = b.group.position.z;
        const dx = bx - ax;
        const dz = bz - az;
        const dist = Math.hypot(dx, dz);
        if (dist <= 0.001) continue;
        const nx = dx / dist;
        const nz = dz / dist;
        const relVx = b.velocity.x - a.velocity.x;
        const relVz = b.velocity.z - a.velocity.z;
        const closing = -(relVx * nx + relVz * nz);
        if (closing > 0.35) {
          const halfA =
            Math.abs(a.right.x * nx + a.right.z * nz) * CAR_HALF.x +
            Math.abs(a.forward.x * nx + a.forward.z * nz) * CAR_HALF.z;
          const halfB =
            Math.abs(b.right.x * nx + b.right.z * nz) * CAR_HALF.x +
            Math.abs(b.forward.x * nx + b.forward.z * nz) * CAR_HALF.z;
          const gap = dist - halfA - halfB;
          eta = Math.min(eta, Math.max(0, gap) / closing);
        }
      }
    }

    return this.showBarrier ? this.barrier.contactEta(cars, eta) : eta;
  }

  private fixedStep(dt: number): void {
    const cars = this.live();
    // Race: every car (the player too) is driven through its controller slot by the director.
    if (this.race.active) this.race.drive(dt);
    const driven = this.seat.mode === "drive" && !this.race.active ? this.seat.carIndex : -1;
    if (driven >= 0 && driven < cars.length) {
      const car = cars[driven]!;
      if (car.deform.drivetrainAlive) applyDrive(car, this.seat.input(car, dt), dt);
      if (this.seat.selfRight(car.group.matrixWorld.elements[5]!, car.velocity.length(), dt)) this.recoverDriven();
    }
    this.net.drive(cars, dt, driven);
    if (this.derbyMode && this.derby.winnerId == null) {
      const snaps = this.derby.snapshots(cars.length);
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i]!;
        snapshotAiCar(
          snaps[i]!,
          i,
          c.group.position.x,
          c.group.position.z,
          c.yaw,
          c.velocity.x,
          c.velocity.z,
          c.deform.drivetrainAlive,
          c.deform.masses,
        );
      }
      for (let i = 0; i < cars.length; i++) {
        if (i === driven) continue;
        applyDrive(cars[i]!, this.derby.think(snaps[i]!, snaps, dt), dt);
      }
    }
    let nearWall = false;
    if (this.showBarrier) {
      for (const car of cars) {
        if (car.group.position.lengthSq() < 160) {
          nearWall = true;
          break;
        }
      }
    }
    const slices = nearWall && dt > 0.006 ? 3 : dt > 0.012 ? 2 : 1;
    const h = dt / slices;
    const strongest = this.strongest;
    strongest.clear();

    for (let i = 0; i < slices; i++) {
      if (this.showCompactor) {
        this.stepCompactor(h);
        this.carA.afterContacts(h, this.bounceWorld);
        continue;
      }
      if (this.showPistons) {
        this.stepPistons(h);
        this.carA.afterContacts(h, this.bounceWorld);
        continue;
      }
      if (this.showDoors) {
        this.stepDoors(h);
        continue;
      }
      for (const car of cars) {
        if (!car.deform.massActive) car.integrate(h);
        if (car.deform.massActive) car.syncPose(h);
        else car.refreshBasis();
      }

      for (let a = 0; a < cars.length; a++) {
        for (let b = a + 1; b < cars.length; b++) {
          const ca = cars[a]!;
          const cb = cars[b]!;
          if (this.showBarrier && this.barrier.blocksPair(ca, cb)) continue;
          const dx = ca.group.position.x - cb.group.position.x;
          const dz = ca.group.position.z - cb.group.position.z;
          // Cars on different levels (one on a bridge, one under it) never touch.
          if (dx * dx + dz * dz > 28 || Math.abs(ca.group.position.y - cb.group.position.y) > 2.5) continue;
          if (ca.deform.massActive || cb.deform.massActive) ca.deform.collideWith(cb.deform, h);
          partContactPair(ca, cb);
        }
      }

      let satBusy = false;
      let wrecked = true;
      for (const car of cars) {
        if (car.velocity.lengthSq() > 1.4) satBusy = true;
        if (!car.crashed || leftoverCrumple(car.deform.crumpleTravelCorner()) >= 0.2) wrecked = false;
      }
      for (let k = 0; k < (satBusy && !wrecked ? 3 : 1); k++) {
        for (const car of cars) {
          if (car.deform.massActive) car.syncPose(0);
          else car.refreshBasis();
        }

        const feed = k === 0;
        let moved = false;
        if (this.showBarrier) {
          for (let ci = 0; ci < cars.length; ci++) {
            const car = cars[ci]!;
            const hit = this.barrier.resolve(car, true, feed, h);
            if (hit) {
              this.barrierHits[ci] = true;
              moved = true;
              strongest.offer(hit);
            }
          }
        }

        for (let a = 0; a < cars.length; a++) {
          for (let b = a + 1; b < cars.length; b++) {
            if (this.showBarrier && this.barrier.blocksPair(cars[a]!, cars[b]!)) continue;
            if (Math.abs(cars[a]!.group.position.y - cars[b]!.group.position.y) > 2.5) continue;
            const pair = resolveCarPair(cars[a]!, cars[b]!, feed, h);
            if (pair) {
              moved = true;
              if (this.derbyMode) {
                const n = pair.normal;
                const aInto = -(cars[a]!.velocity.x * n.x + cars[a]!.velocity.z * n.z);
                const bInto = cars[b]!.velocity.x * n.x + cars[b]!.velocity.z * n.z;
                this.derby.noteHit(a, b, aInto, bInto, pair.impulse);
              }
              strongest.offer(pair);
            }
          }
        }

        if (this.showBalls) {
          for (const car of cars) {
            const ballHit = resolveRampBalls(
              this.balls,
              car,
              this.debris,
              this.sparks,
              this.fxDensity,
              this.elapsedWall,
              this.trace.ballHits,
            );
            if (ballHit) {
              moved = true;
              strongest.offer(ballHit);
            }
          }
        }
        for (const car of cars) {
          if (!this.derbyMode && !this.race.active && resolveLampPoles(this.poles, car, this.debris, this.sparks, this.fxDensity)) moved = true;
        }

        if (this.showBarrier) {
          for (const car of cars) {
            if (this.barrier.resolve(car, false, false, h)) moved = true;
          }
        }
        if (!moved) break;
      }

      for (const car of cars) {
        if (car.deform.massActive) car.deform.stepStructure(h);
        if (car.deform.massActive) car.syncPose(h);
        if (this.showBarrier) this.barrier.clip(car);
        car.afterContacts(h, this.bounceWorld);
        if (this.derbyMode) this.clipDerbyCar(car);
      }
      if (this.race.active) for (let ci = 0; ci < cars.length; ci++) this.race.collide(cars[ci]!, ci);
    }
    if (this.race.active) this.race.step(dt);

    const { impulse, contact, normal } = strongest;
    if (!this.derbyMode && !this.race.active && this.phase === "approach" && contact && normal && impulse > 0.4) {
      this.beginCinematic(contact, normal, impulse);
    } else if ((this.derbyMode || this.race.active) && contact && normal && impulse > 1.2 && this.elapsedWall - this.sparkAt > 0.16) {
      this.sparkAt = this.elapsedWall;
      this.sparks.poof(contact, normal, Math.min(56, 18 + impulse * 0.8) * this.fxDensity);
    }
  }

  private clipDerbyCar(car: DeformableCar): void {
    const p = car.group.position;
    const v = car.velocity;
    const next = clipToDerbyBowl(p.x, p.z, v.x, v.z, 2.15);
    if (!next.hit) return;
    const dx = next.x - p.x;
    const dz = next.z - p.z;
    if (car.deform.massActive) car.deform.translateMasses(dx, dz, next.vx - v.x, next.vz - v.z);
    p.set(next.x, p.y, next.z);
    v.set(next.vx, v.y, next.vz);
  }

  private stepDerby(dt: number): void {
    if (!this.derbyMode) return;
    const cars = this.live();
    const status = this.derby.step(
      dt,
      cars.map((c, i) => ({ id: i, name: c.paint.name, alive: c.deform.drivetrainAlive })),
    );
    const winId = this.derby.winnerId;
    if (winId != null) {
      const champ = cars[winId];
      for (let i = 0; i < cars.length; i++) cars[i]!.setHighlight(i === winId);
      if (champ) {
        this.winnerLight.position.set(champ.group.position.x, 2.1, champ.group.position.z);
        this.winnerLight.intensity = 5.5;
      }
    } else {
      this.winnerLight.intensity = 0;
    }
    if (status === "loop" && this.looping) this.randomizeAndReset();
  }

  private beginCinematic(contact: THREE.Vector3, normal: THREE.Vector3, impulse: number): void {
    this.phase = "impact";
    this.wallSinceImpact = 0;
    this.impactKph = impulse * 3.6;
    if (this.userTimeScale != null) {
      this.targetScale = this.userTimeScale;
      this.timeScale = this.userTimeScale;
    } else if (this.autoSlomo) {
      const scale = this.reduceMotion ? 0.16 : IMPACT_SCALE;
      this.targetScale = scale;
      if (this.timeScale > scale * 1.15) this.timeScale = scale;
    } else {
      this.targetScale = 1;
      this.timeScale = 1;
    }
    this.view.kick(this.carCount);
    const rigScene = this.showPistons || this.showCompactor || this.showDoors;
    this.cine.impact(contact, normal, impulse, !rigScene && this.autoSlomo && this.userTimeScale == null && this.seat.mode === "global" && !this.view.userFramed);
    this.impactLight.position.copy(contact);
    this.impactLight.position.y = 0.8;
    this.impactLightLife = 0.35;
    this.debris.burst(contact, normal, Math.min(90, 28 + impulse * 0.9) * this.fxDensity);
    this.sparks.poof(contact, normal, Math.min(90, 36 + impulse * 1.1) * this.fxDensity);
    const src =
      this.nearestCar(contact);
    this.smoke.plume(contact, src.velocity, Math.max(8, (14 * this.fxDensity) | 0));
    this.armEngineSmoke(src, 4.5);
    for (const car of this.live()) {
      if (car.crashed && car !== src) this.armEngineSmoke(car, 4.5);
    }
    this.fxPoofed = true;
    if (this.audioOn) this.audio.impact(impulse);
    this.emitHud(true);
  }

  private emitContactFx(): void {
    if (this.phase === "approach" || this.fxPoofed) return;
    const cars = this.live();
    let contact: THREE.Vector3 | null = null;
    let normal: THREE.Vector3 | null = null;
    outer: for (let i = 0; i < cars.length; i++) {
      const ca = cars[i]!;
      const massesA = ca.deform.masses;
      for (let j = i + 1; j < cars.length; j++) {
        const cb = cars[j]!;
        const dxg = ca.group.position.x - cb.group.position.x;
        const dzg = ca.group.position.z - cb.group.position.z;
        if (dxg * dxg + dzg * dzg > 36) continue;
        const massesB = cb.deform.masses;
        for (let ia = 0, nA = massesA.length; ia < nA; ia++) {
          const a = massesA[ia]!;
          const ax = a.world.x;
          const ay = a.world.y;
          const az = a.world.z;
          const ar = a.radius;
          for (let ib = 0, nB = massesB.length; ib < nB; ib++) {
            const b = massesB[ib]!;
            const dx = ax - b.world.x;
            const dy = ay - b.world.y;
            const dz = az - b.world.z;
            const maxR = ar + b.radius + 0.08;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 >= maxR * maxR || d2 < 1e-10) continue;
            const dist = Math.sqrt(d2);
            _p.set((ax + b.world.x) * 0.5, (ay + b.world.y) * 0.5, (az + b.world.z) * 0.5);
            _n.set(dx / dist, dy / dist, dz / dist);
            contact = _p;
            normal = _n;
            break outer;
          }
        }
      }
    }
    if (!contact && this.showBarrier) {
      const hi = this.barrierHits.findIndex(Boolean);
      const hitCar = hi >= 0 ? cars[hi] : null;
      if (hitCar) {
        _bp.copy(hitCar.deform.massWorld("bumperFL")).add(hitCar.deform.massWorld("bumperFR")).multiplyScalar(0.5);
        _bp.y = 0.32;
        _bn.set(Math.cos(this.barrier.yaw), 0, -Math.sin(this.barrier.yaw));
        contact = _bp;
        normal = _bn;
      }
    }
    if (!contact) return;
    const src = this.nearestCar(contact);
    this.armEngineSmoke(src, 2.8);
    if (!this.fxPoofed) {
      this.sparks.poof(contact, normal!, Math.max(24, (48 * this.fxDensity) | 0));
      this.smoke.plume(contact, src.velocity, Math.max(10, (16 * this.fxDensity) | 0));
      this.fxPoofed = true;
    }
  }

  private nearestCar(point: THREE.Vector3): DeformableCar {
    const cars = this.live();
    let best = cars[0]!;
    let bestD = best.group.position.distanceToSquared(point);
    for (let i = 1; i < cars.length; i++) {
      const d = cars[i]!.group.position.distanceToSquared(point);
      if (d < bestD) {
        bestD = d;
        best = cars[i]!;
      }
    }
    return best;
  }


  private armEngineSmoke(car: DeformableCar, extra: number): void {
    if (!car.crashed) return;
    const until = this.elapsedWall + extra;
    const i = Math.max(0, this.cars.indexOf(car));
    this.smokeUntil[i] = Math.max(this.smokeUntil[i] ?? 0, until);
  }

  private puffDeadEngine(car: DeformableCar): void {
    const m = car.deform.massWorld("engineL");
    _v.copy(m);
    _v.y = Math.max(0.35, m.y);
    this.smoke.wisp(_v, car.velocity);
  }

  private puffEngine(car: DeformableCar): void {
    if (!car.crashed || !car.deform.massActive) return;
    if (car.deform.drivetrainAlive && car.deform.partCompression("bonnet") < 0.08) return;
    const n = Math.max(2, (4 * this.fxDensity) | 0);
    for (const name of ["engineL", "engineR"] as const) {
      const m = car.deform.massWorld(name);
      _v.copy(m);
      _v.y = 0.12;
      this.smoke.plume(_v, car.velocity, n);
    }
  }

  private updatePhase(wallDt: number): void {
    if (this.derbyMode || this.race.active) return;
    if (this.phase === "approach") return;
    this.wallSinceImpact += wallDt;
    if (this.phase === "impact") {
      if (this.wallSinceImpact > 0.12) this.phase = "slowmo";
    } else if (this.phase === "slowmo") {
      const hold = this.reduceMotion ? 1.4 : 6.5;
      if (this.wallSinceImpact > hold) {
        if (this.userTimeScale == null) this.targetScale = 1;
        this.phase = "aftermath";
      }
    } else if (this.phase === "aftermath") {
      if (this.wallSinceImpact > 8.2 && this.userTimeScale == null) this.targetScale = 1;
      if (this.looping && !this.showPistons && this.wallSinceImpact > (this.showCompactor ? 14 : 10.4)) this.randomizeAndReset();
    }
  }

  private updateCamera(wallDt: number): void {
    if (this.cine.direct(this.camera, wallDt, !this.view.userFramed && this.seat.mode !== "drive")) return;
    const followed = this.followedCar();
    if (followed && followed.group.visible && (this.seat.mode === "drive" || this.race.chase)) {
      this.view.frameDrive(followed, wallDt, this.playing);
      return;
    }
    const look = this.view.look;
    if (followed && followed.group.visible) {
      look.set(followed.group.position.x, 0.7, followed.group.position.z);
    } else if (this.showCompactor || this.showPistons || this.showDoors) {
      look.set(this.carA.group.position.x, 0.55, this.carA.group.position.z);
    } else if (this.derbyMode && this.derby.winnerId != null) {
      const champ = this.cars[this.derby.winnerId];
      if (champ) look.set(champ.group.position.x, 0.7, champ.group.position.z);
    } else if (this.derbyMode) {
      const live = this.live().filter((c) => c.deform.drivetrainAlive);
      centroid(_v, live.length ? live : this.live());
      look.set(_v.x, 0.7, _v.z);
    } else {
      centroid(_v, this.live());
      look.set(_v.x, 0.7, _v.z);
    }

    let spinRate = 0;
    if (this.autoRotate && this.playing && this.seat.mode !== "drive") {
      spinRate = this.showPistons ? PISTON_ORBIT_RATE : this.phase === "approach" ? 0.12 : 0.32;
    }
    this.view.orbit(wallDt, spinRate, this.playing);
  }

  private bounceWorld = (pos: THREE.Vector3, vel: THREE.Vector3, r: number): void => {
    bounceGround(pos, vel, r);
    for (const car of this.live()) bounceOffCar(car, pos, vel, r);
    if (this.showCompactor) {
      const hz = 0.24;
      const hy = 1.05;
      const hx = 1.8;
      const z = this.compactor.face + 0.24;
      separateSphereFromAabb(pos, vel, r, 0, 1.02, z, hx, hy, hz);
      separateSphereFromAabb(pos, vel, r, 0, 1.02, -z, hx, hy, hz);
    }
    if (this.showBarrier) this.barrier.bounce(pos, vel, r);
  };

  private stepCompactor(dt: number): void {
    const hit = this.compactor.step(dt);
    this.press.sync(this.compactor.face);
    if (this.carA.deform.massActive) {
      if (hit.hits > 0 && this.elapsedWall > this.compactFxAt) {
        this.compactFxAt = this.elapsedWall + 0.2;
        _bp.set(0, 0.34, this.compactor.face);
        _bn.set(0, 0, -1);
        this.sparks.poof(_bp, _bn, Math.max(10, (18 * this.fxDensity) | 0));
        _bp.z = -this.compactor.face;
        _bn.set(0, 0, 1);
        this.sparks.poof(_bp, _bn, Math.max(10, (18 * this.fxDensity) | 0));
        if (this.phase === "approach") {
          this.beginCinematic(_bp, _bn, COMPACTOR.speed * 8);
          if (this.autoSlomo) this.targetScale = this.reduceMotion ? 0.28 : 0.42;
        }
      }
    }
    const stage = compactorStage(this.compactor.face);
    if (stage === "contact" || stage === "wells") this.phase = this.phase === "approach" ? "impact" : this.phase;
    if (stage === "mid") this.phase = "slowmo";
    if (stage === "max") this.phase = "aftermath";
  }

  /** The orbit paces the piston loop: turning, untouched by the user, and visibly moving. */
  private pistonHopSynced(): boolean {
    return this.autoRotate && !this.view.userFramed && !this.reduceMotion && this.seat.mode !== "drive";
  }

  /**
   * Piston loop: park the next ram `PISTON_PARK_LEAD` before its shot, then fire it. While the
   * orbit paces the hops each ram fires as the camera passes behind it (one per eighth of a turn,
   * next in the orbit's direction); otherwise every `hopSeconds`, in key order.
   */
  private stepPistonLoop(wallDt: number): void {
    this.pistonSinceFire += wallDt;
    const synced = this.pistonHopSynced();
    const bearing = this.view.bearing;
    if (this.pistonFired) {
      if (this.pistonSinceFire < PISTON_PARK_LEAD) return;
      let next = (this.pistonSelected + 1) % PISTON_IDS.length;
      if (synced) {
        next = pistonAhead(bearing, 0);
        if (pistonToGo(next, bearing) > PISTON_ORBIT_RATE * PISTON_PARK_LEAD) return;
      } else if (this.pistonSinceFire < this.pistons.config.hopSeconds - PISTON_PARK_LEAD) {
        return;
      }
      this.pistonSelected = next;
      this.pistonAll = false;
      this.randomizeAndReset();
      this.emitHud(true);
      return;
    }
    if (!synced) {
      if (this.elapsedWall >= PISTON_PARK_LEAD) this.firePiston(this.pistonSelected);
      return;
    }
    const togo = pistonToGo(this.pistonSelected, bearing);
    if (togo <= 0 && togo > -0.3) {
      this.firePiston(this.pistonSelected);
      return;
    }
    // Parked for a ram the camera isn't heading to (orbit just took over): wait for the next one instead.
    const ahead = pistonAhead(bearing, 0);
    if (ahead === this.pistonSelected) return;
    this.pistonSelected = ahead;
    this.pistonAll = false;
    this.pistonBank.sync(this.pistons, ahead, false);
    this.emitHud(true);
  }

  private stepPistons(dt: number): void {
    const rig = this.pistons;
    rig.step(dt);
    this.pistonBank.sync(rig, this.pistonSelected, this.pistonAll);
    if (rig.takeHit()) {
      _bn.copy(rig.hitNormal).negate();
      if (this.phase === "approach") this.beginCinematic(rig.hitPoint, _bn, rig.hitClosing);
      else this.sparks.poof(rig.hitPoint, _bn, Math.max(10, (24 * this.fxDensity) | 0));
    }
    if (this.elapsedWall < this.pistonFxAt) return;
    for (const h of rig.heads) {
      if (!h.touching) continue;
      this.pistonFxAt = this.elapsedWall + 0.15;
      const s = h.face(rig.honey) + h.pad;
      _bp.set(h.ax + h.nx * s, PISTON.faceY, h.az + h.nz * s);
      _bn.set(-h.nx, 0.35, -h.nz).normalize();
      this.sparks.poof(_bp, _bn, Math.max(6, (12 * this.fxDensity) | 0));
      break;
    }
  }

  private stepDoors(dt: number): void {
    const rig = this.doorRig;
    const was = rig.phase;
    this.carA.integrate(dt);
    rig.step(dt);
    this.doorRam.sync(rig);
    if (rig.touched && !this.doorFx) {
      this.doorFx = true;
      rig.centre(_bp);
      _bp.z += rig.lane.dir * RAM.length * 0.5;
      _bn.set(0, 0.35, -rig.lane.dir).normalize();
      this.sparks.poof(_bp, _bn, Math.max(6, (14 * this.fxDensity) | 0));
    }
    if (was !== "idle" && rig.phase === "idle") {
      this.doorShot = rig.result();
      this.emitHud(true);
    }
  }

  private emitHud(force: boolean): void {
    void force;
    const cars = this.live();
    const relVel = this.fleetClosing();
    const eta =
      this.phase === "approach" && !this.showCompactor && !this.showPistons && !this.showDoors ? this.contactEta() : 0;
    const carMass = this.carA.deform.totalMass;
    const pistonEnergy = this.pistons.shotEnergy(carMass);
    publishHud({
      playing: this.playing,
      looping: this.looping,
      showRig: this.showRig,
      showParticles: this.showParticles,
      showBarrier: this.showBarrier,
      showBalls: this.showBalls,
      showCompactor: this.showCompactor,
      showPistons: this.showPistons,
      pistons: {
        selected: this.pistonSelected,
        speedKph: this.pistons.config.speedKph,
        massKg: this.pistons.config.massKg,
        hardness: this.pistons.config.hardness,
        holdCar: this.pistons.config.holdCar,
        hopSeconds: this.pistons.config.hopSeconds,
        hopSynced: this.pistonHopSynced(),
        busy: this.pistons.busy,
        energyKj: pistonEnergy / 1000,
        ebsKph: Math.sqrt((2 * pistonEnergy) / carMass) * 3.6,
      },
      showDoors: this.showDoors,
      doors: {
        side: this.doorRig.side,
        kph: this.doorRig.kph,
        kg: this.doorRig.kg,
        open: this.carA.doorHinge(this.doorRig.side).theta > 0.01,
        busy: this.doorRig.phase === "run",
        energyJ: 0.5 * this.doorRig.kg * (this.doorRig.kph / 3.6) ** 2,
        shot: this.doorShot && {
          detached: this.doorShot.detached,
          doorDeg: this.doorShot.doorDeg,
          latched: this.doorShot.latched,
          bodyMm: Math.max(this.doorShot.bodyParticleMm, this.doorShot.bodyVertexMm),
        },
      },
      autoRotate: this.autoRotate,
      autoSlomo: this.autoSlomo,
      audioOn: this.audioOn,
      fxTier: this.cine.tier,
      night: this.stage.night,
      wet: this.stage.wet,
      deformMode: this.deformMode,
      phase: this.phase,
      timeScale: this.timeScale,
      userTimeScale: this.userTimeScale,
      elapsed: this.elapsedWall,
      speedA: this.showCompactor ? 0 : (cars[0]?.velocity.length() ?? 0),
      speedB: this.showCompactor ? 0 : (cars[1]?.velocity.length() ?? 0),
      closingKph: relVel * 3.6,
      impactKph: this.impactKph,
      eta: Number.isFinite(eta) ? eta : 0,
      cageCount: this.carA.deform.cageCount,
      sensorCount: this.carA.deform.sensorCount,
      squash: this.squash,
      buckle: this.buckle,
      fxDensity: this.fxDensity,
      carCount: this.carCount,
      speedMin: this.speedMin,
      speedMax: this.speedMax,
      traceSamples: this.captureTrace ? this.trace.samples.length : this.trace.setupCopied ? 1 : 0,
      wallGap: this.showCompactor ? this.compactor.face * 2 : 0,
      compactStage: this.showCompactor ? compactorStage(this.compactor.face) : "open",
      fps: this.fps,
      captureTrace: this.captureTrace,
      derby: this.derbyMode,
      derbyWinner: this.derby.winnerName,
      derbyBoard: this.derby.hud().board.map((r) => ({
        id: r.id,
        name: r.name,
        score: r.score,
        alive: r.alive,
        watched: this.seat.mode !== "global" && this.seat.carIndex === r.id,
      })),
      race: this.race.active ? this.race.hud() : null,
      seat: this.seat.mode,
      boost: this.seat.boost,
      view: this.seat.view,
      pad: this.pad.label,
      realism: HANDLING.realism,
      playerClass: this.playerClass,
    });
  }

  private resize = (): void => {
    const parent = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.renderer.setSize(w, h, false);
    this.cine.post.setSize();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  /** Pre-baked RoomEnvironment (public/env-studio.jpg) — PMREM from an equirect, not fromScene. */
  private attachStudioEnv(): void {
    new THREE.TextureLoader().load(
      `${import.meta.env.BASE_URL}env-studio.jpg`,
      (tex) => {
        if (this.disposed) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.mapping = THREE.EquirectangularReflectionMapping;
        const gen = new THREE.PMREMGenerator(this.renderer);
        const env = gen.fromEquirectangular(tex).texture;
        this.scene.environment = env;
        this.scene.environmentIntensity = this.stage.envIntensity;
        this.envMap?.dispose();
        this.envMap = env;
        tex.dispose();
        gen.dispose();
      },
      undefined,
      () => {},
    );
  }

  private buildWorld(): void {
    this.stage = new WorldStage(this.scene);
    this.sun = this.stage.sun;
    this.studio.push(this.stage.ground);

    const grid = new THREE.GridHelper(60, 30, 0x2a2c32, 0x18191e);
    grid.position.y = 0.012;
    this.scene.add(grid);
    this.studio.push(grid);

    const ringGeo = new THREE.RingGeometry(2.15, 2.32, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xd8d4cc,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.scene.add(this.ring);
    this.studio.push(this.ring);

    const inner = new THREE.Mesh(
      new THREE.RingGeometry(0.12, 0.22, 24),
      new THREE.MeshBasicMaterial({ color: 0xd8d4cc, transparent: true, opacity: 0.35, side: THREE.DoubleSide, forceSinglePass: true }),
    );
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.03;
    this.scene.add(inner);
    this.studio.push(inner);

    buildRampBalls(this.scene, this.balls);

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const pole = makeLamp();
      pole.position.set(Math.sin(a) * 16, 0, Math.cos(a) * 16);
      this.scene.add(pole);
      this.poles.push({ group: pole, intact: true, radius: 0.12, kicked: new Set() });
    }
  }
}
