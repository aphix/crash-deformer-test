import * as THREE from "three";
import { CAR_HALF, DeformableCar, type CarPaint } from "./car.ts";
import { leftoverCrumple, applyGroundFriction, CRASH, separateSphereFromAabb } from "./physics-util.ts";
import { COMPACTOR, compactorStage, enforceWalls } from "./compactor.ts";
import { physicsSlice } from "./sat.ts";
import { resolveCarPair } from "./pair-contact.ts";
import { INITIAL_HUD, publishHud, type CrashPhase } from "./hud-store.ts";
import type { DeformMode } from "./streamed-deform.ts";
import { MAX_CARS, layoutFleet, layoutDerby } from "./fleet.ts";
import { makeAsphalt, makeLamp } from "./engine-world.ts";
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
import { applyDrive, DriverSeat, BOOST } from "./car-drive.ts";
import { makeDerbyArena, clipToDerbyBowl, DERBY_RADIUS } from "./derby-arena.ts";

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
  private impactLightLife = 0;
  private envMap: THREE.Texture | null = null;
  private debris: DebrisSystem;
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
  private squash = 0.4;
  private buckle = 0.45;
  private fxDensity = 0.7;
  private speedMin = 0;
  private speedMax = 32;
  private balls: RampBall[] = [];
  private poles: LampPole[] = [];
  private smokeUntil: number[] = [];
  private compactFace: number = COMPACTOR.startFace;
  private compactFxAt = 0;
  private press: CompactorPress;
  private derby = new DerbyMatch();
  private seat = new DriverSeat();
  private keys = new Set<string>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private arena!: THREE.Group;
  private winnerLight!: THREE.PointLight;
  private view: ChaseCamera;
  private trace: TraceRecorder;
  private readonly strongest = new StrongestContact();

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
    this.view = new ChaseCamera(this.camera, canvas, this.seat, this.reduceMotion, (x, y) => this.pickCar(x, y));

    this.scene.background = new THREE.Color(0x12141a);
    this.scene.fog = new THREE.FogExp2(0x12141a, 0.008);
    this.attachStudioEnv();

    this.buildWorld();
    this.arena = makeDerbyArena();
    this.scene.add(this.arena);
    this.winnerLight = new THREE.PointLight(0xffe08a, 0, 18, 2);
    this.scene.add(this.winnerLight);
    this.barrier = new JerseyBarrier(this.scene);
    this.press = new CompactorPress(this.scene, this.compactFace);

    this.glassDots = new GlassDotSystem(this.scene);
    this.ensureCars(2);

    this.debris = new DebrisSystem(this.scene);
    this.sparks = new SparkSystem(this.scene);
    this.smoke = new TireSmokeSystem(this.scene);
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

    this.resize();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas.parentElement ?? canvas);

    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKeyUp);
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
    this.view.detach();
    this.resizeObs.disconnect();
    for (const car of this.cars) car.dispose();
    this.sparks.dispose();
    this.glassDots.dispose();
    this.smoke.dispose();
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
    if (this.showCompactor) return;
    if (this.derbyMode) this.setDerby(false);
    this.showBarrier = !this.showBarrier;
    this.barrier.group.visible = this.showBarrier;
    if (this.showBarrier) this.barrier.orient(this.carA.group.position);
    this.tryUnlockAudio();
    this.emitHud(true);
  }

  toggleBalls(): void {
    if (this.showCompactor) return;
    if (this.derbyMode) this.setDerby(false);
    this.showBalls = !this.showBalls;
    scatterRampBalls(this.balls, this.showBalls);
    this.tryUnlockAudio();
    this.emitHud(true);
  }

  toggleCompactor(): void {
    if (this.derbyMode) this.setDerby(false);
    this.showCompactor = !this.showCompactor;
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud(true);
  }

  toggleDerby(): void {
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

  setSquash(value: number): void {
    this.squash = THREE.MathUtils.clamp(value, 0, 1);
    for (const car of this.live()) car.deform.squash = this.squash;
    this.emitHud(true);
  }

  setBuckle(value: number): void {
    this.buckle = THREE.MathUtils.clamp(value, 0, 1);
    for (const car of this.live()) car.deform.buckle = this.buckle;
    this.emitHud(true);
  }

  setFxDensity(value: number): void {
    this.fxDensity = THREE.MathUtils.clamp(value, 0, 1.2);
    this.emitHud(true);
  }

  setCarCount(n: number): void {
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
    while (this.cars.length < count) {
      const i = this.cars.length;
      const base = FLEET_PAINT[i % FLEET_PAINT.length]!;
      const paint: CarPaint =
        i < FLEET_PAINT.length ? base : { ...base, name: `${base.name}-${Math.floor(i / FLEET_PAINT.length) + 1}` };
      const car = new DeformableCar(paint, this.scene, (origin, vel, count) => this.glassDots.burst(origin, vel, count));
      car.group.visible = false;
      car.group.userData.carIndex = i;
      this.scene.add(car.group);
      this.cars.push(car);
    }
    for (let i = 0; i < this.cars.length; i++) {
      this.cars[i]!.group.visible = i < count;
    }
    this.barrierHits = Array.from({ length: count }, () => false);
    while (this.smokeUntil.length < count) this.smokeUntil.push(0);
    this.smokeUntil.length = count;
    if (this.seat.carIndex >= count) this.seat.clear();
  }

  private dressCar(car: DeformableCar): void {
    car.deform.squash = this.squash;
    car.deform.buckle = this.buckle;
    car.deform.setMode(this.deformMode);
    car.setRigVisible(this.showRig);
    car.deform.setParticlesVisible(this.showParticles);
  }

  private onKey = (e: KeyboardEvent): void => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    this.keys.add(e.code);
    this.seat.poke(this.keys);
    if (e.repeat) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (this.seat.mode === "global") this.togglePlay();
    } else if (e.code === "Escape") {
      this.seat.esc();
      this.emitHud(true);
    } else if (e.code === "KeyT" && this.seat.mode === "drive") {
      this.seat.toggleView();
      this.emitHud(true);
    } else if (e.code === "KeyR") {
      e.preventDefault();
      this.reset();
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
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
    this.seat.poke(this.keys);
  };

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
          this.seat.focus(idx);
          this.emitHud(true);
          return;
        }
        obj = obj.parent;
      }
    }
  }

  private randomizeAndReset(): void {
    this.compactFace = COMPACTOR.startFace;
    this.compactFxAt = 0;
    if (this.showCompactor) {
      this.parkCompactor();
      this.finishResetCommon();
      return;
    }
    this.press.group.visible = false;
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

  private parkCompactor(): void {
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
    parked.deform.bidirectional = true;
    parked.deform.deepCrush = false;
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
    this.press.group.visible = true;
    this.press.sync(this.compactFace);
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

    this.view.frameReset(this.showCompactor, this.live());
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
      compactFace: this.compactFace,
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
      this.renderer.render(this.scene, this.camera);
    }
  };

  private tickInner(now: number): void {
    if (this.disposed) return;
    const wallDt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    if (wallDt > 1e-4) {
      const inst = 1 / wallDt;
      this.fps = this.fps > 1 ? this.fps * 0.85 + inst * 0.15 : inst;
    }

    if (this.playing) {
      this.elapsedWall += wallDt;
      this.maybePreSlowmo(wallDt);
      this.timeScale += (this.targetScale - this.timeScale) * Math.min(1, wallDt * (this.phase === "aftermath" ? 1.15 : 3.2));
      const simDt = wallDt * this.timeScale;
      const cars = this.live();
      let vmax = 8;
      for (const car of cars) if (car.speed > vmax) vmax = car.speed;
      this.acc += simDt;
      if (this.acc > 0.05) this.acc = 0.05;
      const budget = now + 8;
      let steps = 0;
      while (this.acc > 1e-5 && steps < 8) {
        const h = physicsSlice(this.acc, vmax);
        this.fixedStep(h);
        this.elapsedSim += h;
        this.acc -= h;
        for (const car of cars) {
          if (car.deform.massActive && !car.deform.drivetrainAlive) car.deform.cutDrive(h);
          if (this.wallSinceImpact > 0.2 && car.crashed) this.bleedAfterSlide(car, h);
        }
        steps++;
        if (steps >= 2 && performance.now() > budget) break;
      }
      for (const car of cars) {
        if (this.showCompactor && car !== this.carA) continue;
        car.updateDeform(simDt);
      }
      this.updatePhase(wallDt);
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
        }
      }
      if (this.trace.due(wallDt, this.captureTrace)) this.trace.push(this.traceSetup(), cars, this.traceClock());
      this.stepDerby(simDt);
      this.seat.step(simDt);
      if (this.derbyMode) {
        for (const id of this.derby.consumeBoosts()) {
          if (id === this.seat.carIndex && this.seat.mode === "drive") this.seat.addBoost(BOOST.takedown);
        }
      }
    }

    this.updateCamera(wallDt);
    this.renderer.render(this.scene, this.camera);

    this.hudAcc += wallDt;
    if (this.hudAcc > (this.timeScale < 0.5 ? 0.05 : 0.12)) {
      this.hudAcc = 0;
      this.emitHud(false);
    }
  }

  private maybePreSlowmo(wallDt: number): void {
    if (this.derbyMode) return;
    if (this.userTimeScale != null) return;
    if (!this.autoSlomo) return;
    if (this.showCompactor) return;
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
    const driven = this.seat.mode === "drive" ? this.seat.carIndex : -1;
    if (driven >= 0 && driven < cars.length) {
      const car = cars[driven]!;
      if (car.deform.drivetrainAlive) applyDrive(car, this.seat.input(this.keys), dt);
    }
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
          if (dx * dx + dz * dz > 28) continue;
          if (ca.deform.massActive || cb.deform.massActive) ca.deform.collideWith(cb.deform);
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
            const hit = this.barrier.resolve(car, !car.crashed, feed, h);
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
            const pair = resolveCarPair(cars[a]!, cars[b]!, !(cars[a]!.crashed && cars[b]!.crashed), feed, h);
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
          if (!this.derbyMode && resolveLampPoles(this.poles, car, this.debris, this.sparks, this.fxDensity)) moved = true;
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
    }

    const { impulse, contact, normal } = strongest;
    if (!this.derbyMode && this.phase === "approach" && contact && normal && impulse > 0.4) {
      this.beginCinematic(contact, normal, impulse);
    } else if (this.derbyMode && contact && normal && impulse > 1.2 && this.elapsedWall - this.sparkAt > 0.16) {
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

  private bleedAfterSlide(car: DeformableCar, dt: number): void {
    if (!car.crashed) return;
    const q = car.deform.quietTime();
    const mu = q < 0.15 ? CRASH.muScuff : CRASH.muSlide * (1 + Math.min(1.4, q));
    applyGroundFriction(car.velocity, dt, mu, true);
    if (car.deform.massActive && q > 0.08) {
      car.deform.dragGround(dt, THREE.MathUtils.clamp((q - 0.08) / 1.1, 0, 1));
    }
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
    if (this.derbyMode) return;
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
      if (this.looping && this.wallSinceImpact > (this.showCompactor ? 14 : 10.4)) this.randomizeAndReset();
    }
  }

  private updateCamera(wallDt: number): void {
    const followed =
      this.seat.mode !== "global" && this.seat.carIndex >= 0 && this.seat.carIndex < this.carCount
        ? this.cars[this.seat.carIndex]
        : null;
    if (followed && followed.group.visible && this.seat.mode === "drive") {
      this.view.frameDrive(followed, wallDt);
      return;
    }
    const look = this.view.look;
    if (followed && followed.group.visible) {
      look.set(followed.group.position.x, 0.7, followed.group.position.z);
    } else if (this.showCompactor) {
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
    if (this.autoRotate && this.playing && this.seat.mode !== "drive") spinRate = this.phase === "approach" ? 0.12 : 0.32;
    this.view.orbit(wallDt, spinRate, this.playing);
  }

  private bounceWorld = (pos: THREE.Vector3, vel: THREE.Vector3, r: number): void => {
    bounceGround(pos, vel, r);
    for (const car of this.live()) bounceOffCar(car, pos, vel, r);
    if (this.showCompactor) {
      const hz = 0.24;
      const hy = 1.05;
      const hx = 1.8;
      const z = this.compactFace + 0.24;
      separateSphereFromAabb(pos, vel, r, 0, 1.02, z, hx, hy, hz);
      separateSphereFromAabb(pos, vel, r, 0, 1.02, -z, hx, hy, hz);
    }
    if (this.showBarrier) this.barrier.bounce(pos, vel, r);
  };

  private stepCompactor(dt: number): void {
    const target = COMPACTOR.maxFace;
    this.compactFace = Math.max(target, this.compactFace - COMPACTOR.speed * dt);
    this.press.sync(this.compactFace);
    this.carA.refreshBasis();
    if (!this.carA.deform.massActive && this.compactFace < COMPACTOR.bumperZ + 0.12) {
      this.carA.deform.beginCrush(
        new THREE.Vector3(0, 0.36, 2.06),
        new THREE.Vector3(0, 0, -1),
        18,
        this.carA.group,
        this.carA.velocity,
        this.carA.angular,
      );
      this.carA.crashed = true;
    }
    this.carA.deform.bidirectional = true;
    this.carA.deform.deepCrush = this.compactFace < COMPACTOR.midFace;
    if (this.carA.deform.massActive) {
      this.carA.deform.notifyContact();
      const hit = enforceWalls(this.carA.deform, this.compactFace, dt);
      this.carA.deform.stepStructure(dt);
      enforceWalls(this.carA.deform, this.compactFace, dt);
      this.carA.syncPose(dt);
      if (hit.hits > 0 && this.elapsedWall > this.compactFxAt) {
        this.compactFxAt = this.elapsedWall + 0.2;
        _bp.set(0, 0.34, this.compactFace);
        _bn.set(0, 0, -1);
        this.sparks.poof(_bp, _bn, Math.max(10, (18 * this.fxDensity) | 0));
        _bp.z = -this.compactFace;
        _bn.set(0, 0, 1);
        this.sparks.poof(_bp, _bn, Math.max(10, (18 * this.fxDensity) | 0));
        if (this.phase === "approach") {
          this.beginCinematic(_bp, _bn, COMPACTOR.speed * 8);
          if (this.autoSlomo) this.targetScale = this.reduceMotion ? 0.28 : 0.42;
        }
      }
    }
    const stage = compactorStage(this.compactFace);
    if (stage === "contact" || stage === "wells") this.phase = this.phase === "approach" ? "impact" : this.phase;
    if (stage === "mid") this.phase = "slowmo";
    if (stage === "max") this.phase = "aftermath";
  }

  private emitHud(force: boolean): void {
    void force;
    const cars = this.live();
    const relVel = this.fleetClosing();
    const eta = this.phase === "approach" && !this.showCompactor ? this.contactEta() : 0;
    publishHud({
      playing: this.playing,
      looping: this.looping,
      showRig: this.showRig,
      showParticles: this.showParticles,
      showBarrier: this.showBarrier,
      showBalls: this.showBalls,
      showCompactor: this.showCompactor,
      autoRotate: this.autoRotate,
      autoSlomo: this.autoSlomo,
      audioOn: this.audioOn,
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
      wallGap: this.showCompactor ? this.compactFace * 2 : 0,
      compactStage: this.showCompactor ? compactorStage(this.compactFace) : "open",
      fps: this.fps,
      captureTrace: this.captureTrace,
      derby: this.derbyMode,
      derbyWinner: this.derby.winnerName,
      derbyBoard: this.derby.hud().board.map((r) => ({ name: r.name, score: r.score, alive: r.alive })),
      seat: this.seat.mode,
      boost: this.seat.boost,
      view: this.seat.view,
    });
  }

  private resize = (): void => {
    const parent = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  /** Pre-baked RoomEnvironment (public/env-studio.jpg) — PMREM from an equirect, not fromScene. */
  private attachStudioEnv(): void {
    new THREE.TextureLoader().load(
      "/env-studio.jpg",
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
        this.scene.environmentIntensity = 0.72;
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
    const hemi = new THREE.HemisphereLight(0xb7c4d8, 0x1a1816, 1.35);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xf2f5ff, 2.6);
    dir.position.set(-10, 22, 9);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 2;
    dir.shadow.camera.far = 60;
    dir.shadow.camera.left = -24;
    dir.shadow.camera.right = 24;
    dir.shadow.camera.top = 24;
    dir.shadow.camera.bottom = -24;
    dir.shadow.bias = -0.0004;
    this.scene.add(dir);
    const fill = new THREE.DirectionalLight(0xc9d3e0, 0.9);
    fill.position.set(10, 12, -14);
    this.scene.add(fill);

    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(48, 64),
      new THREE.MeshStandardMaterial({
        color: 0x2a2c34,
        roughness: 0.88,
        metalness: 0.06,
        map: makeAsphalt(),
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    const grid = new THREE.GridHelper(60, 30, 0x2a2c32, 0x18191e);
    grid.position.y = 0.012;
    this.scene.add(grid);

    const ringGeo = new THREE.RingGeometry(2.15, 2.32, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xd8d4cc,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
    });
    this.ring = new THREE.Mesh(ringGeo, ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.scene.add(this.ring);

    const inner = new THREE.Mesh(
      new THREE.RingGeometry(0.12, 0.22, 24),
      new THREE.MeshBasicMaterial({ color: 0xd8d4cc, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    );
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.03;
    this.scene.add(inner);

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
