import * as THREE from "three";
import { CAR_HALF, DeformableCar, type CarPaint, type Hull } from "./car.ts";
import { leftoverCrumple, round4, vec3, snapshotPoints, applyGroundFriction, CRASH, separateSphereFromAabb, cancelClosing, satPushCap } from "./physics-util.ts";
import { COMPACTOR, compactorStage, enforceWalls } from "./compactor.ts";
import { BARRIER_HALF, BARRIER_MASS, clipCarToBarrier, physicsSlice, satCarBarrier } from "./sat.ts";
import { impulseCar, pushCar, resolveCarPair } from "./pair-contact.ts";
import { INITIAL_HUD, publishHud, type CrashPhase } from "./hud-store.ts";
import type { DeformMode } from "./streamed-deform.ts";
import { MAX_CARS, layoutFleet, layoutDerby } from "./fleet.ts";
import { makeAsphalt, makeJerseyBarrier, restoreBarrierRest, makeLamp } from "./engine-world.ts";
import { DebrisSystem, SparkSystem, GlassDotSystem, TireSmokeSystem, CrashAudio } from "./engine-fx.ts";
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
const SLOWMO_STEP = 0.92;
const BALL_EXPOSE = 0.25;

type LampPole = {
  group: THREE.Group;
  intact: boolean;
  radius: number;
  kicked: Set<string>;
};

type RampBall = {
  mesh: THREE.Mesh;
  radius: number;
  intact: boolean;
  kicked: Set<string>;
};

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _n = new THREE.Vector3();
const _r = new THREE.Vector3();
const _p = new THREE.Vector3();
const _bn = new THREE.Vector3();
const _bp = new THREE.Vector3();
const _bRight = new THREE.Vector3();
const _bFwd = new THREE.Vector3();
const _ha = new THREE.Vector3();
const _hb = new THREE.Vector3();
const _mtv = new THREE.Vector3();
const _cn = new THREE.Vector3();
const _cp = new THREE.Vector3();

export class CrashEngine {
  playing = true;
  looping = true;
  showRig = false;
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
  private trauma = 0;
  private orbitAngle = 0;
  private orbitRadius = 14;
  private orbitPitch = 0.4;
  private orbitDragging = false;
  private orbitLastX = 0;
  private orbitLastY = 0;
  private userFramed = false;
  private elapsedWall = 0;
  private elapsedSim = 0;
  private camPos = new THREE.Vector3(10, 6, 16);
  private camLook = new THREE.Vector3();
  private camFrom = new THREE.Vector3();
  private camBlend = 1;
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
  private approachSide = new THREE.Vector3(1, 0, 0);
  private ring!: THREE.Mesh;
  private barrier!: THREE.Group;
  private barrierYaw = 0;
  private barrierVel = new THREE.Vector3();
  private barrierCrush = 0;
  private barrierHits: boolean[] = [];
  private fxPoofed = false;
  private squash = 0.4;
  private buckle = 0.45;
  private fxDensity = 0.7;
  private speedMin = 0;
  private speedMax = 32;
  private balls: RampBall[] = [];
  private poles: LampPole[] = [];
  private ballHits: Record<string, unknown>[] = [];
  private smokeUntil: number[] = [];
  private compactFace: number = COMPACTOR.startFace;
  private compactFxAt = 0;
  private press!: THREE.Group;
  private pressFront!: THREE.Mesh;
  private pressRear!: THREE.Mesh;
  private derby = new DerbyMatch();
  private seat = new DriverSeat();
  private keys = new Set<string>();
  private lookDragging = false;
  private pointerTravel = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private arena!: THREE.Group;
  private winnerLight!: THREE.PointLight;
  private traceInitial: Record<string, unknown> | null = null;
  private traceSamples: Record<string, unknown>[] = [];
  private traceAcc = 0;
  /** JSON button copied spawn while capture is off — HUD shows 1, does not tick. */
  private setupCopied = false;

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
    this.camera.position.copy(this.camPos);

    this.scene.background = new THREE.Color(0x12141a);
    this.scene.fog = new THREE.FogExp2(0x12141a, 0.008);
    this.attachStudioEnv();

    this.buildWorld();
    this.arena = makeDerbyArena();
    this.scene.add(this.arena);
    this.winnerLight = new THREE.PointLight(0xffe08a, 0, 18, 2);
    this.scene.add(this.winnerLight);
    this.barrier = makeJerseyBarrier();
    this.barrier.visible = false;
    this.scene.add(this.barrier);
    this.buildPress();

    this.glassDots = new GlassDotSystem(this.scene);
    this.ensureCars(2);

    this.debris = new DebrisSystem(this.scene);
    this.sparks = new SparkSystem(this.scene);
    this.smoke = new TireSmokeSystem(this.scene);
    this.audio = new CrashAudio();

    this.impactLight = new THREE.PointLight(0xffc27a, 0, 22, 2);
    this.scene.add(this.impactLight);

    this.resize();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas.parentElement ?? canvas);

    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKeyUp);
    this.canvas.style.touchAction = "none";
    this.canvas.style.cursor = "grab";
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
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
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
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
    this.barrier.visible = this.showBarrier;
    if (this.showBarrier) this.orientBarrier();
    this.tryUnlockAudio();
    this.emitHud(true);
  }

  toggleBalls(): void {
    if (this.showCompactor) return;
    if (this.derbyMode) this.setDerby(false);
    this.showBalls = !this.showBalls;
    this.scatterBalls();
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
      this.barrier.visible = false;
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
    if (this.captureTrace && this.traceSamples.length === 0) this.beginTrace();
    this.emitHud(true);
  }

  resetDefaults(): void {
    this.playing = INITIAL_HUD.playing;
    this.looping = INITIAL_HUD.looping;
    this.showRig = INITIAL_HUD.showRig;
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
    this.userFramed = false;
    this.setDerby(false);
    this.ensureCars(INITIAL_HUD.carCount);
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud(true);
  }

  copyTraceJson(): string {
    if (!this.traceInitial) this.snapshotInitial();
    if (!this.captureTrace) {
      this.setupCopied = true;
      this.emitHud(true);
      return JSON.stringify(
        {
          version: 1,
          kind: "setup",
          capturedAt: new Date().toISOString(),
          deformMode: this.deformMode,
          autoSlomo: this.autoSlomo,
          timeScale: this.userTimeScale,
          ...this.traceInitial,
        },
        null,
        2,
      );
    }
    return JSON.stringify(
      {
        version: 1,
        capturedAt: new Date().toISOString(),
        squash: this.squash,
        buckle: this.buckle,
        deformMode: this.deformMode,
        fxDensity: this.fxDensity,
        barrier: this.showBarrier,
        balls: this.showBalls,
        compactor: this.showCompactor,
        carCount: this.carCount,
        speedMin: this.speedMin,
        speedMax: this.speedMax,
        barrierYaw: this.barrierYaw,
        captureTrace: this.captureTrace,
        initial: this.traceInitial,
        ballHits: this.ballHits,
        samples: this.traceSamples,
      },
      null,
      2,
    );
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

  private centroid(out: THREE.Vector3, cars = this.live()): THREE.Vector3 {
    out.set(0, 0, 0);
    const n = cars.length;
    if (n === 0) return out;
    for (const car of cars) out.add(car.group.position);
    return out.multiplyScalar(1 / n);
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

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.pointerTravel = 0;
    this.lookDragging = this.seat.mode === "drive";
    this.orbitDragging = this.seat.mode !== "drive";
    this.orbitLastX = e.clientX;
    this.orbitLastY = e.clientY;
    if (this.orbitDragging) this.userFramed = true;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
  };

  private onPointerMove = (e: PointerEvent): void => {
    const dx = e.clientX - this.orbitLastX;
    const dy = e.clientY - this.orbitLastY;
    this.pointerTravel += Math.hypot(dx, dy);
    this.orbitLastX = e.clientX;
    this.orbitLastY = e.clientY;
    if (this.lookDragging) {
      this.seat.nudgeLook(dx, dy);
      return;
    }
    if (!this.orbitDragging) return;
    this.orbitAngle -= dx * 0.005;
    this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + dy * 0.004, 0.08, 1.22);
  };

  private onPointerUp = (e: PointerEvent): void => {
    const click = this.pointerTravel < 8;
    this.orbitDragging = false;
    this.lookDragging = false;
    this.canvas.style.cursor = "grab";
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (click) this.pickCar(e.clientX, e.clientY);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const delta = e.deltaY;
    const scale = Math.exp(delta * 0.00115);
    this.orbitRadius = THREE.MathUtils.clamp(this.orbitRadius * scale, 4.2, 32);
    this.userFramed = true;
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
    if (this.press) this.press.visible = false;
    if (this.derbyMode) this.spawnDerby();
    else this.spawnFleet();
    this.barrierHits.fill(false);
    this.barrier.visible = this.showBarrier;
    if (this.showBarrier) this.orientBarrier();
    this.scatterBalls();
    this.resetPoles();
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

    this.barrier.visible = false;
    this.barrierHits.fill(false);
    for (const b of this.balls) b.mesh.visible = false;
    this.press.visible = true;
    this.syncPress();
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
    this.userFramed = false;
    this.impactKph = null;
    this.trauma = 0;
    this.camBlend = 1;
    this.impactLightLife = 0;
    this.impactLight.intensity = 0;
    this.debris.reset();
    this.sparks.reset();
    this.glassDots.reset();
    this.smoke.reset();

    if (this.showCompactor) {
      this.camLook.set(0, 0.55, 0);
      this.orbitRadius = 9.4;
      this.orbitPitch = 0.44;
      this.orbitAngle = 0.85;
      const cp = Math.cos(this.orbitPitch);
      this.camPos.set(
        Math.sin(this.orbitAngle) * this.orbitRadius * cp,
        this.camLook.y + this.orbitRadius * Math.sin(this.orbitPitch),
        Math.cos(this.orbitAngle) * this.orbitRadius * cp,
      );
    } else {
      const cars = this.live();
      this.centroid(_v, cars);
      if (cars.length >= 2) {
        _w.copy(cars[1]!.group.position).sub(cars[0]!.group.position).normalize();
      } else {
        _w.copy(cars[0]?.forward ?? _w.set(0, 0, 1));
      }
      this.approachSide.crossVectors(_w, _n.set(0, 1, 0)).normalize();
      if (this.approachSide.lengthSq() < 0.1) this.approachSide.set(1, 0, 0);
      this.placeApproachCamera(1);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    this.orbitAngle = Math.atan2(this.camPos.x - this.camLook.x, this.camPos.z - this.camLook.z);
    const dx = this.camPos.x - this.camLook.x;
    const dy = this.camPos.y - this.camLook.y;
    const dz = this.camPos.z - this.camLook.z;
    this.orbitRadius = Math.hypot(dx, dy, dz);
    this.orbitPitch = Math.asin(THREE.MathUtils.clamp(dy / Math.max(this.orbitRadius, 0.01), -0.99, 0.99));
    this.smokeUntil.fill(0);
    this.fxPoofed = false;
    this.barrierVel.set(0, 0, 0);
    this.barrierCrush = 0;
    this.barrier.position.set(0, 0, 0);
    restoreBarrierRest(this.barrier);
    this.setupCopied = false;
    this.snapshotInitial();
    if (this.captureTrace) this.beginTrace();
    else {
      this.traceAcc = 0;
      this.traceSamples.length = 0;
      this.ballHits.length = 0;
    }
  }

  private snapshotInitial(): void {
    this.traceInitial = {
      barrier: this.showBarrier,
      barrierYaw: round4(this.barrierYaw),
      squash: this.squash,
      buckle: this.buckle,
      fxDensity: this.fxDensity,
      balls: this.showBalls,
      compactor: this.showCompactor,
      compactFace: round4(this.compactFace),
      carCount: this.carCount,
      speedMin: this.speedMin,
      speedMax: this.speedMax,
      cars: this.live().map((car) => ({
        paint: car.paint.name,
        spawn: {
          x: round4(car.group.position.x),
          y: round4(car.group.position.y),
          z: round4(car.group.position.z),
        },
        yaw: round4(car.yaw),
        speed: round4(car.spawnSpeed),
        vel: vec3(car.velocity),
      })),
    };
  }

  private beginTrace(): void {
    this.traceAcc = 0;
    this.traceSamples = [];
    this.ballHits = [];
    this.snapshotInitial();
    this.pushTraceSample();
  }

  private pushTraceSample(): void {
    if (!this.captureTrace) return;
    if (this.traceSamples.length >= 96) return;
    this.traceSamples.push({
      t: Math.round(this.elapsedWall * 1000) / 1000,
      sim: Math.round(this.elapsedSim * 1000) / 1000,
      phase: this.phase,
      timeScale: Math.round(this.timeScale * 1000) / 1000,
      squash: this.squash,
      buckle: this.buckle,
      fxDensity: this.fxDensity,
      compactFace: round4(this.compactFace),
      compactStage: compactorStage(this.compactFace),
      closing: Math.round(this.fleetClosing() * 3.6 * 10) / 10,
      collision: {
        leftover: this.live().map((c) => round4(leftoverCrumple(c.deform.crumpleTravelCorner()))),
        transfer: this.live().map((c) => round4(c.deform.frontTransfer())),
        dist: round4(this.nearestPairDist()),
        barrierHit: this.barrierHits.some(Boolean),
        barrierCrush: round4(this.barrierCrush),
      },
      ballHits: this.ballHits,
      barrier: {
        pos: vec3(this.barrier.position),
        vel: vec3(this.barrierVel),
        yaw: round4(this.barrierYaw),
        crush: round4(this.barrierCrush),
        mass: BARRIER_MASS,
      },
      balls: this.balls.map((b) => ({
        intact: b.intact,
        radius: round4(b.radius),
        expose: BALL_EXPOSE,
        kicked: [...b.kicked],
        pos: vec3(b.mesh.position),
      })),
      particles: {
        sparks: this.sparks.snapshot(),
        smoke: this.smoke.snapshot(),
        debris: this.debris.snapshot(),
      },
      cars: this.live().map((c) => c.snapshot()),
    });
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

  private nearestPairDist(): number {
    const cars = this.live();
    if (cars.length < 2) return 0;
    let best = Infinity;
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const d = cars[i]!.group.position.distanceTo(cars[j]!.group.position);
        if (d < best) best = d;
      }
    }
    return best;
  }

  private orientBarrier(): void {
    const a = this.carA.group.position;
    const len = Math.hypot(a.x, a.z);
    if (len < 0.01) {
      this.barrierYaw = 0;
    } else {
      const nx = a.x / len;
      const nz = a.z / len;
      this.barrierYaw = Math.atan2(-nz, nx);
    }
    this.barrier.rotation.y = this.barrierYaw;
  }

  private placeApproachCamera(alpha: number): void {
    const cars = this.live();
    const mid = this.centroid(_v, cars);
    mid.y = 0.6;
    if (cars.length >= 2) {
      _w.copy(cars[1]!.group.position).sub(cars[0]!.group.position);
    } else {
      _w.copy(cars[0]?.forward ?? _w.set(0, 0, 1));
    }
    const dist = Math.max(_w.length(), 4);
    if (_w.lengthSq() > 1e-8) _w.normalize();
    else _w.set(0, 0, 1);
    const side = this.approachSide;
    const pull = THREE.MathUtils.lerp(16, 11, THREE.MathUtils.clamp(1 - dist / 28, 0, 1)) + Math.max(0, cars.length - 2) * 0.55;
    this.camPos
      .copy(mid)
      .addScaledVector(side, pull)
      .addScaledVector(_n.set(0, 1, 0), 5.2)
      .addScaledVector(_w, -1.4);
    this.camLook.copy(mid);
    void alpha;
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
      this.trauma = Math.max(0, this.trauma - wallDt * 1.6);
      this.stepBarrier(simDt);
      const fxDt = Math.max(simDt, wallDt * 0.6);
      this.debris.update(fxDt, this.bounceWorld);
      this.sparks.update(fxDt, this.bounceGround);
      this.glassDots.update(fxDt, this.bounceGround);
      this.smoke.update(fxDt, this.bounceGround, this.camera);
      for (let i = 0; i < cars.length; i++) {
        if (this.elapsedWall < (this.smokeUntil[i] ?? 0)) this.puffEngine(cars[i]!);
      }
      this.traceAcc += wallDt;
      if (this.captureTrace && this.traceAcc >= 0.25) {
        this.traceAcc = 0;
        this.pushTraceSample();
      }
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

    if (!this.showBarrier) return eta;

    _bRight.set(Math.cos(this.barrierYaw), 0, -Math.sin(this.barrierYaw));
    _bFwd.set(Math.sin(this.barrierYaw), 0, Math.cos(this.barrierYaw));
    for (const car of cars) {
      const px = car.group.position.x;
      const pz = car.group.position.z;
      const lx = px * _bRight.x + pz * _bRight.z;
      const lz = px * _bFwd.x + pz * _bFwd.z;
      const rX =
        Math.abs(car.right.x * _bRight.x + car.right.z * _bRight.z) * CAR_HALF.x +
        Math.abs(car.forward.x * _bRight.x + car.forward.z * _bRight.z) * CAR_HALF.z;
      const rZ =
        Math.abs(car.right.x * _bFwd.x + car.right.z * _bFwd.z) * CAR_HALF.x +
        Math.abs(car.forward.x * _bFwd.x + car.forward.z * _bFwd.z) * CAR_HALF.z;
      const vLx = car.velocity.x * _bRight.x + car.velocity.z * _bRight.z;
      const vLz = car.velocity.x * _bFwd.x + car.velocity.z * _bFwd.z;
      const gapX = Math.abs(lx) - BARRIER_HALF.x - rX;
      const gapZ = Math.abs(lz) - BARRIER_HALF.z - rZ;
      const towardX = -(lx >= 0 ? 1 : -1) * vLx;
      const towardZ = -(lz >= 0 ? 1 : -1) * vLz;
      if (towardX > 0.4 && gapZ < 0.55) {
        eta = Math.min(eta, Math.max(0, gapX) / towardX);
      }
      if (towardZ > 0.4 && gapX < 0.55) {
        eta = Math.min(eta, Math.max(0, gapZ) / towardZ);
      }
    }
    return eta;
  }

  private fixedStep(dt: number): void {
    const cars = this.live();
    const driven = this.seat.mode === "drive" ? this.seat.carIndex : -1;
    if (driven >= 0 && driven < cars.length) {
      const car = cars[driven]!;
      if (car.deform.drivetrainAlive) applyDrive(car, this.seat.input(this.keys), dt);
    }
    if (this.derbyMode && this.derby.winnerId == null) {
      const snaps = cars.map((c, i) =>
        snapshotAiCar(
          i,
          c.paint.name,
          c.group.position.x,
          c.group.position.z,
          c.yaw,
          c.velocity.x,
          c.velocity.z,
          c.deform.drivetrainAlive,
          c.deform.crumpleTravel(),
        ),
      );
      for (let i = 0; i < cars.length; i++) {
        if (i === driven) continue;
        applyDrive(cars[i]!, this.derby.think(snaps[i]!, snaps), dt);
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
    let cinematicImpulse = 0;
    let cinematicContact: THREE.Vector3 | null = null;
    let cinematicNormal: THREE.Vector3 | null = null;

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
          if (this.showBarrier && this.barrierBlocksPair(ca, cb)) continue;
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
            const hit = this.resolveBarrier(car, !car.crashed, feed, h);
            if (hit) {
              this.barrierHits[ci] = true;
              moved = true;
              if (hit.impulse >= cinematicImpulse) {
                cinematicImpulse = hit.impulse;
                cinematicContact = hit.contact;
                cinematicNormal = hit.normal;
              }
            }
          }
        }

        for (let a = 0; a < cars.length; a++) {
          for (let b = a + 1; b < cars.length; b++) {
            if (this.showBarrier && this.barrierBlocksPair(cars[a]!, cars[b]!)) continue;
            const pair = resolveCarPair(cars[a]!, cars[b]!, !(cars[a]!.crashed && cars[b]!.crashed), feed, h);
            if (pair) {
              moved = true;
              if (this.derbyMode) {
                const n = pair.normal;
                const aInto = -(cars[a]!.velocity.x * n.x + cars[a]!.velocity.z * n.z);
                const bInto = cars[b]!.velocity.x * n.x + cars[b]!.velocity.z * n.z;
                this.derby.noteHit(a, b, aInto, bInto, pair.impulse);
              }
              if (pair.impulse >= cinematicImpulse) {
                cinematicImpulse = pair.impulse;
                cinematicContact = pair.contact;
                cinematicNormal = pair.normal;
              }
            }
          }
        }

        if (this.showBalls) {
          for (const car of cars) {
            const ballHit = this.resolveBalls(car, h);
            if (ballHit) {
              moved = true;
              if (ballHit.impulse >= cinematicImpulse) {
                cinematicImpulse = ballHit.impulse;
                cinematicContact = ballHit.contact;
                cinematicNormal = ballHit.normal;
              }
            }
          }
        }
        for (const car of cars) {
          if (!this.derbyMode && this.resolvePoles(car, h)) moved = true;
        }

        if (this.showBarrier) {
          for (const car of cars) {
            if (this.resolveBarrier(car, false, false, h)) moved = true;
          }
        }
        if (!moved) break;
      }

      for (const car of cars) {
        if (car.deform.massActive) car.deform.stepStructure(h);
        if (car.deform.massActive) car.syncPose(h);
        if (this.showBarrier) {
          clipCarToBarrier(
            car,
            this.barrierYaw,
            this.barrier.position,
            this.barrierHx(),
            leftoverCrumple(car.deform.crumpleTravelCorner()),
          );
        }
        car.afterContacts(h, this.bounceWorld);
        if (this.derbyMode) this.clipDerbyCar(car);
      }
    }

    if (!this.derbyMode && this.phase === "approach" && cinematicContact && cinematicNormal && cinematicImpulse > 0.4) {
      this.beginCinematic(cinematicContact, cinematicNormal, cinematicImpulse);
    }
  }

  private resolveBarrier(
    car: DeformableCar,
    deform: boolean,
    feed: boolean,
    dt: number,
  ): { impulse: number; contact: THREE.Vector3; normal: THREE.Vector3 } | null {
    const crushHit = satCarBarrier(car, this.barrierYaw, this.barrier.position, this.barrierHx(), _cn, _cp, car.crushHulls());
    const overlap = satCarBarrier(car, this.barrierYaw, this.barrier.position, this.barrierHx(), _bn, _bp, car.hulls());
    clipCarToBarrier(
      car,
      this.barrierYaw,
      this.barrier.position,
      this.barrierHx(),
      leftoverCrumple(car.deform.crumpleTravelCorner()),
    );
    if (!crushHit && !overlap) return null;
    car.deform.notifyContact();

    const n = crushHit ? _cn : overlap ? _bn : _cn;
    n.y = 0;
    if (n.lengthSq() > 1e-8) n.normalize();
    _bn.y = 0;
    if (_bn.lengthSq() > 1e-8) _bn.normalize();
    _cn.y = 0;
    if (_cn.lengthSq() > 1e-8) _cn.normalize();
    const p = crushHit ? _cp : _bp;
    const closing = -car.velocity.dot(n);

    if (deform && closing > 0.2 && (crushHit ?? overlap ?? 0) > 0.004 && !car.crashed) {
      car.applyImpact(p, n.clone(), closing);
    }

    let remain = Math.max(0, closing);
    if (feed && crushHit && crushHit > 0) {
      remain = car.deform.feedOverlap(_cp, _cn, crushHit, Math.max(0, closing), dt);
    }

    if (overlap) {
      const leftover = leftoverCrumple(car.deform.crumpleTravelCorner());
      const maxPen = car.deform.massActive ? leftover * 0.4 : 0.015;
      const extra = Math.max(0, overlap - maxPen);
      const push = Math.min(extra + 0.004, satPushCap(dt));
      pushCar(car, _bn.x, 0, _bn.z, push);
      if (feed && remain > 0.3) {
        const pass = car.deform.frontTransfer();
        const e = pass >= 0.97 ? 0.02 : 0;
        const invC = 1 / car.deform.totalMass;
        const invB = 1 / BARRIER_MASS;
        const j = Math.min(cancelClosing(remain, pass, invC + invB, dt, e), 18 + pass * 40);
        impulseCar(car, _bn.x, 0, _bn.z, j);
        this.barrierVel.addScaledVector(_bn, -j / BARRIER_MASS);
        _r.copy(_bp).sub(car.group.position);
        car.angular.y += (_r.x * _bn.z - _r.z * _bn.x) * remain * -0.04;
      }
      if (feed && crushHit) {
        this.indentBarrier(_cp, _cn, Math.min(0.012, crushHit * 0.12));
      }
    }
    clipCarToBarrier(car, this.barrierYaw, this.barrier.position, this.barrierHx(), leftoverCrumple(car.deform.crumpleTravelCorner()));

    const shown = crushHit ?? overlap ?? 0;
    return shown > 0.001
      ? { impulse: Math.max(closing, 0.5), contact: p.clone(), normal: n.clone() }
      : null;
  }


  /** True when the jersey slab sits between this pair so they must not SAT through it. */
  private barrierBlocksPair(a: DeformableCar, b: DeformableCar): boolean {
    _bRight.set(Math.cos(this.barrierYaw), 0, -Math.sin(this.barrierYaw));
    const ax = a.group.position.x * _bRight.x + a.group.position.z * _bRight.z;
    const bx = b.group.position.x * _bRight.x + b.group.position.z * _bRight.z;
    const pad = BARRIER_HALF.x + 0.2;
    return ax * bx < 0 && Math.abs(ax) > pad && Math.abs(bx) > pad;
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
    this.trauma = this.reduceMotion ? 0.15 : 0.85;
    this.camBlend = 1;
    if (!this.userFramed) {
      this.orbitAngle = Math.atan2(this.camera.position.x - this.camLook.x, this.camera.position.z - this.camLook.z);
      this.orbitRadius = THREE.MathUtils.clamp(this.orbitRadius + Math.max(0, this.carCount - 2) * 0.4, 8, 22);
    }
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
        _bn.set(Math.cos(this.barrierYaw), 0, -Math.sin(this.barrierYaw));
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
      this.frameDrive(followed, wallDt);
      return;
    }
    if (followed && followed.group.visible) {
      this.camLook.set(followed.group.position.x, 0.7, followed.group.position.z);
    } else if (this.showCompactor) {
      this.camLook.set(this.carA.group.position.x, 0.55, this.carA.group.position.z);
    } else if (this.derbyMode && this.derby.winnerId != null) {
      const champ = this.cars[this.derby.winnerId];
      if (champ) this.camLook.set(champ.group.position.x, 0.7, champ.group.position.z);
    } else if (this.derbyMode) {
      const live = this.live().filter((c) => c.deform.drivetrainAlive);
      this.centroid(_v, live.length ? live : this.live());
      this.camLook.set(_v.x, 0.7, _v.z);
    } else {
      this.centroid(_v);
      this.camLook.set(_v.x, 0.7, _v.z);
    }

    const spinning = this.autoRotate && this.playing && !this.orbitDragging && !this.reduceMotion && this.seat.mode !== "drive";
    if (spinning) {
      const rate = this.phase === "approach" ? 0.12 : 0.32;
      this.orbitAngle += rate * wallDt;
    }

    const cp = Math.cos(this.orbitPitch);
    const sp = Math.sin(this.orbitPitch);
    this.camPos.set(
      this.camLook.x + Math.sin(this.orbitAngle) * this.orbitRadius * cp,
      this.camLook.y + this.orbitRadius * sp,
      this.camLook.z + Math.cos(this.orbitAngle) * this.orbitRadius * cp,
    );

    const k = 1 - Math.exp((this.orbitDragging ? -18 : -5.5) * wallDt);
    this.camera.position.lerp(this.camPos, k);

    if (this.trauma > 0 && this.playing) {
      const shake = this.trauma * this.trauma;
      const t = performance.now() * 0.017;
      this.camera.position.x += Math.sin(t * 37.1) * shake * 0.28;
      this.camera.position.y += Math.cos(t * 29.4) * shake * 0.18;
      this.camera.rotation.z = Math.sin(t * 21.2) * shake * 0.025;
    } else {
      this.camera.rotation.z = 0;
    }
    this.camera.lookAt(this.camLook);
  }

  private frameDrive(car: DeformableCar, wallDt: number): void {
    const speed = Math.hypot(car.velocity.x, car.velocity.z);
    const head = speed > 1.2 ? Math.atan2(car.velocity.x, car.velocity.z) : car.yaw;
    const yaw = head + this.seat.camYaw;
    const pitch = this.seat.camPitch;
    if (this.seat.view === "first") {
      const eye = _v.set(0.32, 1.08, 0.2);
      car.group.localToWorld(eye);
      this.camPos.copy(eye);
      this.camLook.set(
        eye.x + Math.sin(yaw) * 8,
        eye.y + pitch * 2.2,
        eye.z + Math.cos(yaw) * 8,
      );
    } else {
      const dist = 7.4;
      this.camPos.set(
        car.group.position.x - Math.sin(yaw) * dist,
        car.group.position.y + 2.4 + pitch * 0.6,
        car.group.position.z - Math.cos(yaw) * dist,
      );
      this.camLook.set(
        car.group.position.x + Math.sin(head) * 2.4,
        car.group.position.y + 0.85,
        car.group.position.z + Math.cos(head) * 2.4,
      );
    }
    const k = 1 - Math.exp(-12 * wallDt);
    this.camera.position.lerp(this.camPos, k);
    this.camera.lookAt(this.camLook);
  }

  private barrierHx(): number {
    return Math.max(0.18, BARRIER_HALF.x * (1 - this.barrierCrush * 0.45));
  }

  private stepBarrier(dt: number): void {
    if (!this.showBarrier || dt <= 0) return;
    this.barrier.position.x += this.barrierVel.x * dt;
    this.barrier.position.z += this.barrierVel.z * dt;
    applyGroundFriction(this.barrierVel, dt, 1.8, true);
  }

  private indentBarrier(contact: THREE.Vector3, normal: THREE.Vector3, amount: number): void {
    this.barrierCrush = Math.min(0.55, this.barrierCrush + amount * 0.7);
    this.barrier.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const rest = obj.userData.rest as Float32Array | undefined;
      if (!rest) return;
      const geo = obj.geometry as THREE.BufferGeometry;
      const attr = geo.getAttribute("position") as THREE.BufferAttribute;
      const arr = attr.array as Float32Array;
      obj.updateMatrixWorld();
      for (let i = 0; i < arr.length; i += 3) {
        _v.set(arr[i]!, arr[i + 1]!, arr[i + 2]!);
        obj.localToWorld(_v);
        const dx = _v.x - contact.x;
        const dy = _v.y - contact.y;
        const dz = _v.z - contact.z;
        const dist = Math.hypot(dx, dy, dz);
        const fall = Math.exp(-dist * 2.2);
        _v.x -= normal.x * amount * fall;
        _v.z -= normal.z * amount * fall;
        obj.worldToLocal(_v);
        arr[i] = _v.x;
        arr[i + 1] = _v.y;
        arr[i + 2] = _v.z;
      }
      attr.needsUpdate = true;
      geo.computeVertexNormals();
    });
  }

  private bounceGround = (pos: THREE.Vector3, vel: THREE.Vector3, r: number): void => {
    if (pos.y < r) {
      pos.y = r;
      if (vel.y < 0) vel.y *= -0.28;
      vel.x *= 0.86;
      vel.z *= 0.86;
    }
  };

  private bounceWorld = (pos: THREE.Vector3, vel: THREE.Vector3, r: number): void => {
    this.bounceGround(pos, vel, r);
    for (const car of this.live()) this.bounceAgainstCar(car, pos, vel, r);
    if (this.showCompactor) {
      const hz = 0.24;
      const hy = 1.05;
      const hx = 1.8;
      const z = this.compactFace + 0.24;
      separateSphereFromAabb(pos, vel, r, 0, 1.02, z, hx, hy, hz);
      separateSphereFromAabb(pos, vel, r, 0, 1.02, -z, hx, hy, hz);
    }
    if (!this.showBarrier) return;
    _bRight.set(Math.cos(this.barrierYaw), 0, -Math.sin(this.barrierYaw));
    _bFwd.set(Math.sin(this.barrierYaw), 0, Math.cos(this.barrierYaw));
    const oxp = pos.x - this.barrier.position.x;
    const ozp = pos.z - this.barrier.position.z;
    const lx = oxp * _bRight.x + ozp * _bRight.z;
    const lz = oxp * _bFwd.x + ozp * _bFwd.z;
    const ox = this.barrierHx() + r - Math.abs(lx);
    const oz = BARRIER_HALF.z + r - Math.abs(lz);
    if (ox <= 0 || oz <= 0 || pos.y > 1.45) return;
    if (ox < oz) {
      const s = lx >= 0 ? 1 : -1;
      pos.addScaledVector(_bRight, s * ox);
      const vn = vel.x * _bRight.x * s + vel.z * _bRight.z * s;
      if (vn < 0) {
        vel.x -= _bRight.x * s * vn * 1.5;
        vel.z -= _bRight.z * s * vn * 1.5;
      }
    } else {
      const s = lz >= 0 ? 1 : -1;
      pos.addScaledVector(_bFwd, s * oz);
      const vn = vel.x * _bFwd.x * s + vel.z * _bFwd.z * s;
      if (vn < 0) {
        vel.x -= _bFwd.x * s * vn * 1.5;
        vel.z -= _bFwd.z * s * vn * 1.5;
      }
    }
  };

  private bounceAgainstCar(car: DeformableCar, pos: THREE.Vector3, vel: THREE.Vector3, r: number): void {
    car.group.updateMatrixWorld();
    _ha.copy(pos);
    car.group.worldToLocal(_ha);
    if (_ha.y < 0.02 - r || _ha.y > 1.45 + r) return;
    for (const h of car.hulls()) {
      const dx = _ha.x - h.cx;
      const dz = _ha.z - h.cz;
      const ox = h.hx + r - Math.abs(dx);
      const oz = h.hz + r - Math.abs(dz);
      if (ox <= 0 || oz <= 0) continue;
      if (ox < oz) {
        const s = dx >= 0 ? 1 : -1;
        _ha.x += s * ox;
        const nx = car.rightFlat.x * s;
        const nz = car.rightFlat.z * s;
        const vn = vel.x * nx + vel.z * nz;
        if (vn < 0) {
          vel.x -= vn * nx * 1.55;
          vel.z -= vn * nz * 1.55;
          vel.y += Math.abs(vn) * 0.15;
        }
      } else {
        const s = dz >= 0 ? 1 : -1;
        _ha.z += s * oz;
        const nx = car.fwdFlat.x * s;
        const nz = car.fwdFlat.z * s;
        const vn = vel.x * nx + vel.z * nz;
        if (vn < 0) {
          vel.x -= vn * nx * 1.55;
          vel.z -= vn * nz * 1.55;
          vel.y += Math.abs(vn) * 0.15;
        }
      }
      _hb.copy(_ha);
      car.group.localToWorld(_hb);
      pos.copy(_hb);
      return;
    }
  }

  private buildBalls(): void {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xb7bcc6,
      roughness: 0.52,
      metalness: 0.1,
    });
    for (let i = 0; i < 3; i++) {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 22, 16), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.visible = false;
      this.scene.add(mesh);
      this.balls.push({ mesh, radius: 0.78, intact: true, kicked: new Set() });
    }
  }

  private scatterBalls(): void {
    const ringOuter = 2.32;
    const base = Math.random() * Math.PI * 2;
    for (let i = 0; i < this.balls.length; i++) {
      const b = this.balls[i]!;
      b.radius = 0.68 + Math.random() * 0.24;
      b.mesh.scale.setScalar(b.radius);
      const a = base + (i / 3) * Math.PI * 2 + (Math.random() - 0.5) * 0.55;
      const r = ringOuter + 3 + Math.random();
      b.mesh.position.set(Math.sin(a) * r, -(1 - BALL_EXPOSE) * b.radius, Math.cos(a) * r);
      b.intact = true;
      b.kicked.clear();
      b.mesh.visible = this.showBalls;
    }
  }

  private resolveBalls(
    car: DeformableCar,
    dt: number,
  ): { impulse: number; contact: THREE.Vector3; normal: THREE.Vector3 } | null {
    void dt;
    let hit: { impulse: number; contact: THREE.Vector3; normal: THREE.Vector3 } | null = null;
    const px = car.group.position.x;
    const pz = car.group.position.z;
    const id = car.paint.name;
    for (const ball of this.balls) {
      if (!ball.intact || !this.showBalls) continue;
      const c = ball.mesh.position;
      for (const h of car.hulls()) {
        const relx = (c.x - px) * car.rightFlat.x + (c.z - pz) * car.rightFlat.z;
        const relz = (c.x - px) * car.fwdFlat.x + (c.z - pz) * car.fwdFlat.z;
        const qx = THREE.MathUtils.clamp(relx, h.cx - h.hx, h.cx + h.hx);
        const qz = THREE.MathUtils.clamp(relz, h.cz - h.hz, h.cz + h.hz);
        _hb.set(
          px + car.rightFlat.x * qx + car.fwdFlat.x * qz,
          0.28,
          pz + car.rightFlat.z * qx + car.fwdFlat.z * qz,
        );
        const dx = _hb.x - c.x;
        const dz = _hb.z - c.z;
        const distXz = Math.hypot(dx, dz);
        const ringR = Math.sqrt(Math.max(1e-6, ball.radius * ball.radius * (1 - (1 - BALL_EXPOSE) * (1 - BALL_EXPOSE))));
        if (distXz > ringR + Math.hypot(h.hx, h.hz)) continue;
        const overlap = ringR + 0.22 - distXz;
        if (overlap <= 0) continue;
        if (distXz < 1e-4) continue;
        // Ramp: mostly planar, a little up — not a vertical rocket off the buried center.
        _mtv.set(dx / distXz, 0.18, dz / distXz).normalize();
        const push = Math.min(overlap * 0.35, 0.018);
        pushCar(car, _mtv.x, 0, _mtv.z, push);
        car.deform.notifyContact();

        const vn = car.velocity.x * _mtv.x + car.velocity.z * _mtv.z;
        const closing = -vn;
        if (!ball.kicked.has(id) && closing > 0.4) {
          ball.kicked.add(id);
          if (!car.deform.massActive) {
            car.deform.armMasses(car.group, car.velocity, car.angular);
          }
          // Ramp: bleed a little closing into up/side, keep most of the heading.
          const dv = Math.min(closing * 0.08, 3.2);
          car.velocity.x += _mtv.x * dv;
          car.velocity.z += _mtv.z * dv;
          car.velocity.y += Math.min(1.6, closing * 0.035);
          const jUp = THREE.MathUtils.clamp(closing * 1.6, 3, 14);
          const hub = car.deform.kickNearestHub(_hb, jUp);
          const broken = closing > 7.5 || overlap > 0.22;
          if (broken) {
            ball.intact = false;
            ball.mesh.visible = false;
            this.debris.burst(_hb, _mtv, Math.min(48, 14 + closing * 1.2) * this.fxDensity);
            this.sparks.poof(_hb, _mtv, Math.min(28, 8 + closing * 0.6) * this.fxDensity);
            if (hub) {
              const node = car.deform.masses.find((m) => m.name === hub);
              if (node) car.deform.popHub(node);
            }
          }
          this.ballHits.push({
            t: round4(this.elapsedWall),
            car: id,
            hub,
            closing: round4(closing),
            lift: round4(jUp / 26),
            overlap: round4(overlap),
            broken,
            pos: vec3(_hb),
            n: { x: round4(_mtv.x), y: round4(_mtv.y), z: round4(_mtv.z) },
          });
        }
        hit = { impulse: Math.max(closing, 2), contact: _hb.clone(), normal: _mtv.clone() };
      }
    }
    return hit;
  }

  private resetPoles(): void {
    for (let i = 0; i < this.poles.length; i++) {
      const pole = this.poles[i]!;
      const a = (i / 6) * Math.PI * 2;
      pole.intact = true;
      pole.kicked.clear();
      pole.group.visible = !this.derbyMode;
      pole.group.position.set(Math.sin(a) * 16, 0, Math.cos(a) * 16);
      pole.group.rotation.set(0, 0, 0);
    }
  }

  private resolvePoles(
    car: DeformableCar,
    dt: number,
  ): { impulse: number; contact: THREE.Vector3; normal: THREE.Vector3 } | null {
    void dt;
    let hit: { impulse: number; contact: THREE.Vector3; normal: THREE.Vector3 } | null = null;
    const px = car.group.position.x;
    const pz = car.group.position.z;
    const id = car.paint.name;
    for (const pole of this.poles) {
      if (!pole.intact) continue;
      const c = pole.group.position;
      for (const h of car.hulls()) {
        const relx = (c.x - px) * car.rightFlat.x + (c.z - pz) * car.rightFlat.z;
        const relz = (c.x - px) * car.fwdFlat.x + (c.z - pz) * car.fwdFlat.z;
        const qx = THREE.MathUtils.clamp(relx, h.cx - h.hx, h.cx + h.hx);
        const qz = THREE.MathUtils.clamp(relz, h.cz - h.hz, h.cz + h.hz);
        _hb.set(
          px + car.rightFlat.x * qx + car.fwdFlat.x * qz,
          0.4,
          pz + car.rightFlat.z * qx + car.fwdFlat.z * qz,
        );
        _mtv.set(_hb.x - c.x, 0, _hb.z - c.z);
        const dist = Math.hypot(_mtv.x, _mtv.z);
        if (dist >= pole.radius + 0.04 || dist < 1e-5) continue;
        _mtv.multiplyScalar(1 / dist);
        const overlap = pole.radius + 0.04 - dist;
        pushCar(car, _mtv.x, 0, _mtv.z, Math.min(overlap, 0.04));
        car.deform.notifyContact();
        const vn = car.velocity.x * _mtv.x + car.velocity.z * _mtv.z;
        const closing = -vn;
        if (!pole.kicked.has(id) && closing > 0.8) {
          pole.kicked.add(id);
          const j = THREE.MathUtils.clamp(closing * 40, 80, 400);
          impulseCar(car, _mtv.x, 0, _mtv.z, j);
          if (!car.deform.massActive && closing > 4) {
            car.applyImpact(_hb, _mtv, closing);
          } else if (car.deform.massActive) {
            car.deform.kickNearest(_hb, _mtv.x, 0.15, _mtv.z, closing * 8);
          }
          if (closing > 3.5) {
            pole.intact = false;
            pole.group.rotation.z = Math.atan2(_mtv.x, _mtv.z) ? 1.15 * Math.sign(_mtv.x || 1) : 1.15;
            pole.group.rotation.x = _mtv.z > 0 ? -1.05 : 1.05;
            this.debris.burst(_hb, _mtv, Math.min(40, 10 + closing) * this.fxDensity);
            this.sparks.poof(_hb, _mtv, Math.min(22, 6 + closing * 0.5) * this.fxDensity);
          }
        }
        hit = { impulse: Math.max(closing, 2), contact: _hb.clone(), normal: _mtv.clone() };
      }
    }
    return hit;
  }

  private buildPress(): void {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6a6e76,
      roughness: 0.48,
      metalness: 0.72,
    });
    const geo = new THREE.BoxGeometry(3.6, 2.05, 0.48);
    this.pressFront = new THREE.Mesh(geo, mat);
    this.pressRear = new THREE.Mesh(geo, mat);
    this.pressFront.castShadow = true;
    this.pressRear.castShadow = true;
    this.pressFront.receiveShadow = true;
    this.pressRear.receiveShadow = true;
    this.press = new THREE.Group();
    this.press.add(this.pressFront, this.pressRear);
    this.press.visible = false;
    this.scene.add(this.press);
    this.syncPress();
  }

  private syncPress(): void {
    if (!this.pressFront) return;
    const z = this.compactFace + 0.24;
    this.pressFront.position.set(0, 1.02, z);
    this.pressRear.position.set(0, 1.02, -z);
  }

  private stepCompactor(dt: number): void {
    const target = COMPACTOR.maxFace;
    this.compactFace = Math.max(target, this.compactFace - COMPACTOR.speed * dt);
    this.syncPress();
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
      traceSamples: this.captureTrace ? this.traceSamples.length : this.setupCopied ? 1 : 0,
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

    this.buildBalls();

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const pole = makeLamp();
      pole.position.set(Math.sin(a) * 16, 0, Math.cos(a) * 16);
      this.scene.add(pole);
      this.poles.push({ group: pole, intact: true, radius: 0.12, kicked: new Set() });
    }
  }
}
