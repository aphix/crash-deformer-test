import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CAR_HALF, DeformableCar, type CarPaint, type Hull } from "./car.ts";
import { leftoverCrumple, round4, vec3, snapshotPoints, applyGroundFriction, CRASH, separateSphereFromAabb, cancelClosing, satPushCap } from "./physics-util.ts";
import { COMPACTOR, compactorStage, enforceWalls } from "./compactor.ts";
import { BARRIER_HALF, BARRIER_MASS, clipCarToBarrier, physicsSlice, satCarBarrier, satCars } from "./sat.ts";
import { INITIAL_HUD, publishHud, type CrashPhase } from "./hud-store.ts";
import type { DeformMode } from "./streamed-deform.ts";
import { MAX_CARS, layoutFleet } from "./fleet.ts";

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
  private traceInitial: Record<string, unknown> | null = null;
  private traceSamples: Record<string, unknown>[] = [];
  private traceAcc = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setClearColor(0x12141a, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.55;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 180);
    this.camera.position.copy(this.camPos);

    this.scene.background = new THREE.Color(0x12141a);
    this.scene.fog = new THREE.FogExp2(0x12141a, 0.008);
    this.scene.environmentIntensity = 0.4;

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.06).texture;
    pmrem.dispose();

    this.buildWorld();
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
    this.showBarrier = !this.showBarrier;
    this.barrier.visible = this.showBarrier;
    if (this.showBarrier) this.orientBarrier();
    this.tryUnlockAudio();
    this.emitHud(true);
  }

  toggleBalls(): void {
    if (this.showCompactor) return;
    this.showBalls = !this.showBalls;
    this.scatterBalls();
    this.tryUnlockAudio();
    this.emitHud(true);
  }

  toggleCompactor(): void {
    this.showCompactor = !this.showCompactor;
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud(true);
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
    this.ensureCars(INITIAL_HUD.carCount);
    this.tryUnlockAudio();
    this.randomizeAndReset();
    this.emitHud(true);
  }

  copyTraceJson(): string {
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
      this.scene.add(car.group);
      this.cars.push(car);
    }
    for (let i = 0; i < this.cars.length; i++) {
      this.cars[i]!.group.visible = i < count;
    }
    this.barrierHits = Array.from({ length: count }, () => false);
    while (this.smokeUntil.length < count) this.smokeUntil.push(0);
    this.smokeUntil.length = count;
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
    if (e.code === "Space") {
      e.preventDefault();
      this.togglePlay();
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

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.orbitDragging = true;
    this.orbitLastX = e.clientX;
    this.orbitLastY = e.clientY;
    this.userFramed = true;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.orbitDragging) return;
    const dx = e.clientX - this.orbitLastX;
    const dy = e.clientY - this.orbitLastY;
    this.orbitLastX = e.clientX;
    this.orbitLastY = e.clientY;
    this.orbitAngle -= dx * 0.005;
    this.orbitPitch = THREE.MathUtils.clamp(this.orbitPitch + dy * 0.004, 0.08, 1.22);
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (!this.orbitDragging) return;
    this.orbitDragging = false;
    this.canvas.style.cursor = "grab";
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const delta = e.deltaY;
    const scale = Math.exp(delta * 0.00115);
    this.orbitRadius = THREE.MathUtils.clamp(this.orbitRadius * scale, 4.2, 32);
    this.userFramed = true;
  };

  private randomizeAndReset(): void {
    this.compactFace = COMPACTOR.startFace;
    this.compactFxAt = 0;
    if (this.showCompactor) {
      this.parkCompactor();
      this.finishResetCommon();
      return;
    }
    if (this.press) this.press.visible = false;
    this.spawnFleet();
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
    if (this.captureTrace) this.beginTrace();
    else {
      this.traceAcc = 0;
      this.traceSamples.length = 0;
      this.ballHits.length = 0;
      this.traceInitial = null;
    }
  }

  private beginTrace(): void {
    this.traceAcc = 0;
    this.traceSamples = [];
    this.ballHits = [];
    this.traceInitial = {
      barrier: this.showBarrier,
      barrierYaw: this.barrierYaw,
      squash: this.squash,
      buckle: this.buckle,
      fxDensity: this.fxDensity,
      balls: this.showBalls,
      compactor: this.showCompactor,
      compactFace: this.compactFace,
      carCount: this.carCount,
      speedMin: this.speedMin,
      speedMax: this.speedMax,
      cars: this.live().map((car) => ({
        paint: car.paint.name,
        spawn: {
          x: car.group.position.x,
          y: car.group.position.y,
          z: car.group.position.z,
        },
        yaw: car.yaw,
        speed: car.spawnSpeed,
        vel: { x: car.velocity.x, y: car.velocity.y, z: car.velocity.z },
      })),
    };
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
      while (this.acc > 1e-5) {
        const h = physicsSlice(this.acc, vmax);
        this.fixedStep(h);
        this.elapsedSim += h;
        this.acc -= h;
        for (const car of cars) {
          if (car.deform.massActive && !car.deform.drivetrainAlive) car.deform.cutDrive(h);
          if (this.wallSinceImpact > 0.2 && car.crashed) this.bleedAfterSlide(car, h);
        }
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
      for (const car of cars) {
        if (car.velocity.lengthSq() > 1.4) {
          satBusy = true;
          break;
        }
      }
      for (let k = 0; k < (satBusy ? 3 : 1); k++) {
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
            const pair = this.resolvePair(cars[a]!, cars[b]!, !(cars[a]!.crashed && cars[b]!.crashed), feed, h);
            if (pair) {
              moved = true;
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
          if (this.resolvePoles(car, h)) moved = true;
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
      }
    }

    if (this.phase === "approach" && cinematicContact && cinematicNormal && cinematicImpulse > 0.4) {
      this.beginCinematic(cinematicContact, cinematicNormal, cinematicImpulse);
    }
  }

  private impulseCar(car: DeformableCar, nx: number, ny: number, nz: number, j: number): void {
    if (j === 0) return;
    if (car.deform.massActive) {
      car.deform.applyImpulse(nx, ny, nz, j);
      return;
    }
    const inv = 1 / car.deform.totalMass;
    car.velocity.x += nx * j * inv;
    car.velocity.y += ny * j * inv;
    car.velocity.z += nz * j * inv;
  }

  private pushCar(car: DeformableCar, nx: number, ny: number, nz: number, amount: number): void {
    if (car.deform.massActive) {
      const sep = Math.min(amount, 0.09);
      car.deform.separateAlong(nx, ny, nz, sep);
      car.deform.followGroup(car.group, car.velocity, car.angular, 0);
      car.refreshBasis();
      return;
    }
    car.group.position.x += nx * amount;
    car.group.position.y += ny * amount;
    car.group.position.z += nz * amount;
    car.group.updateMatrixWorld();
    car.refreshBasis();
    car.deform.bindKinematic(car.group, car.velocity, car.angular);
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
      this.pushCar(car, _bn.x, 0, _bn.z, push);
      if (feed && remain > 0.3) {
        const pass = car.deform.frontTransfer();
        const e = pass >= 0.97 ? 0.02 : 0;
        const invC = 1 / car.deform.totalMass;
        const invB = 1 / BARRIER_MASS;
        const j = Math.min(cancelClosing(remain, pass, invC + invB, dt, e), 18 + pass * 40);
        this.impulseCar(car, _bn.x, 0, _bn.z, j);
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

  private resolvePair(
    carA: DeformableCar,
    carB: DeformableCar,
    deform: boolean,
    feed: boolean,
    dt: number,
  ): { impulse: number; contact: THREE.Vector3; normal: THREE.Vector3 } | null {
    const dist = carA.group.position.distanceTo(carB.group.position);
    if (dist > 5.2) return null;
    if (this.showBarrier && this.barrierBlocksPair(carA, carB)) return null;

    const crushHit = satCars(carA, carB, _cn, _cp, (c) => c.crushHulls());
    const hit = satCars(carA, carB, _n, _p, (c) => c.hulls());
    if (!crushHit && !hit) return null;
    carA.deform.notifyContact();
    carB.deform.notifyContact();

    const n = crushHit ? _cn : _n;
    n.y = 0;
    if (n.lengthSq() > 1e-8) n.normalize();
    _n.y = 0;
    if (_n.lengthSq() > 1e-8) _n.normalize();
    _cn.y = 0;
    if (_cn.lengthSq() > 1e-8) _cn.normalize();
    const p = crushHit ? _cp : _p;
    const rel = _v.copy(carA.velocity).sub(carB.velocity);
    const closing = -rel.dot(n);

    if (deform && closing > 0.2 && (crushHit ?? hit ?? 0) > 0.006) {
      if (!carA.crashed) carA.applyImpact(p, n.clone(), closing);
      if (!carB.crashed) carB.applyImpact(p, n.clone().negate(), closing);
    }

    let remain = Math.max(0, closing);
    if (feed && crushHit) {
      const remainA = carA.deform.feedOverlap(_cp, _cn, crushHit, Math.max(0, closing), dt);
      const remainB = carB.deform.feedOverlap(_cp, _w.copy(_cn).negate(), crushHit, Math.max(0, closing), dt);
      remain = Math.max(0, Math.min(remainA, remainB));
    }

    const leftoverA = leftoverCrumple(carA.deform.crumpleTravelCorner());
    const leftoverB = leftoverCrumple(carB.deform.crumpleTravelCorner());
    const pass = Math.min(carA.deform.frontTransfer(), carB.deform.frontTransfer());

    if (hit) {
      const leftover = Math.min(leftoverA, leftoverB);
      const maxPen = leftover * 0.1;
      const extra = Math.max(0, hit - maxPen);
      const push = Math.min(extra + 0.006, satPushCap(dt));
      const both = carA.deform.massActive && carB.deform.massActive;
      const aAmt = both ? push * 0.5 : carA.deform.massActive ? push * 0.62 : push * 0.38;
      this.pushCar(carA, _n.x, 0, _n.z, aAmt);
      this.pushCar(carB, -_n.x, 0, -_n.z, push - aAmt);
    } else if (crushHit) {
      const allowed = leftoverA * 0.45 + leftoverB * 0.45 + 0.08;
      const extra = Math.min(crushHit - allowed, 0.04);
      if (extra > 0.012) {
        this.pushCar(carA, _cn.x, 0, _cn.z, extra * 0.5);
        this.pushCar(carB, -_cn.x, 0, -_cn.z, extra * 0.5);
      }
    }

    const minSep = 2.15 + leftoverA * 0.28 + leftoverB * 0.28;
    if (dist < minSep && dist > 1e-4) {
      _w.copy(carA.group.position).sub(carB.group.position).setY(0);
      if (_w.lengthSq() > 1e-8) {
        _w.normalize();
        const extra = Math.min((minSep - dist) * 0.5, satPushCap(dt));
        this.pushCar(carA, _w.x, 0, _w.z, extra);
        this.pushCar(carB, -_w.x, 0, -_w.z, extra);
      }
    }

    if (hit && feed && remain > 0.25) {
      const e = pass >= 0.97 ? 0.02 : 0;
      const invA = 1 / carA.deform.totalMass;
      const invB = 1 / carB.deform.totalMass;
      const jMax = 18 + pass * 36;
      const j = Math.min(cancelClosing(remain, pass, invA + invB, dt, e), jMax);
      this.impulseCar(carA, _n.x, 0, _n.z, j);
      this.impulseCar(carB, -_n.x, 0, -_n.z, j);

      const tAx = carA.velocity.x - carB.velocity.x;
      const tAz = carA.velocity.z - carB.velocity.z;
      const relT = tAx * _n.z - tAz * _n.x;
      const mu = 0.45;
      const jt = THREE.MathUtils.clamp(relT / (invA + invB), -mu * j, mu * j);
      this.impulseCar(carA, _n.z, 0, -_n.x, -jt);
      this.impulseCar(carB, _n.z, 0, -_n.x, jt);

      _r.copy(_p).sub(carA.group.position);
      carA.angular.y += (_r.x * _n.z - _r.z * _n.x) * j * 0.00008;
      _r.copy(_p).sub(carB.group.position);
      carB.angular.y += (_r.x * -_n.z - _r.z * -_n.x) * j * 0.00008;
    }

    return { impulse: Math.max(closing, (crushHit ?? hit ?? 0) * 6), contact: p.clone(), normal: n.clone() };
  }

  /** True when the jersey slab sits between this pair so they must not SAT through it. */
  private barrierBlocksPair(a: DeformableCar, b: DeformableCar): boolean {
    _bRight.set(Math.cos(this.barrierYaw), 0, -Math.sin(this.barrierYaw));
    const ax = a.group.position.x * _bRight.x + a.group.position.z * _bRight.z;
    const bx = b.group.position.x * _bRight.x + b.group.position.z * _bRight.z;
    const pad = BARRIER_HALF.x + 0.2;
    return ax * bx < 0 && Math.abs(ax) > pad && Math.abs(bx) > pad;
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
    if (this.showCompactor) {
      this.camLook.set(this.carA.group.position.x, 0.55, this.carA.group.position.z);
    } else {
      this.centroid(_v);
      this.camLook.set(_v.x, 0.7, _v.z);
    }

    const spinning = this.autoRotate && this.playing && !this.orbitDragging && !this.reduceMotion;
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
        this.pushCar(car, _mtv.x, 0, _mtv.z, push);
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
      pole.group.visible = true;
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
        this.pushCar(car, _mtv.x, 0, _mtv.z, Math.min(overlap, 0.04));
        car.deform.notifyContact();
        const vn = car.velocity.x * _mtv.x + car.velocity.z * _mtv.z;
        const closing = -vn;
        if (!pole.kicked.has(id) && closing > 0.8) {
          pole.kicked.add(id);
          const j = THREE.MathUtils.clamp(closing * 40, 80, 400);
          this.impulseCar(car, _mtv.x, 0, _mtv.z, j);
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
      traceSamples: this.traceSamples.length,
      wallGap: this.showCompactor ? this.compactFace * 2 : 0,
      compactStage: this.showCompactor ? compactorStage(this.compactFace) : "open",
      fps: this.fps,
      captureTrace: this.captureTrace,
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

  private buildWorld(): void {
    const hemi = new THREE.HemisphereLight(0xb7c4d8, 0x1a1816, 1.1);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xf2f5ff, 2.4);
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
    const pad = new THREE.SpotLight(0xe8eef8, 32, 40, 0.55, 0.6, 1.1);
    pad.position.set(4, 18, 6);
    pad.target.position.set(0, 0, 0);
    pad.castShadow = true;
    pad.shadow.mapSize.set(512, 512);
    pad.shadow.bias = -0.0003;
    this.scene.add(pad, pad.target);
    const bounce = new THREE.PointLight(0xc5d0e0, 12, 28, 1.6);
    bounce.position.set(0, 6, 0);
    this.scene.add(bounce);
    const fill = new THREE.DirectionalLight(0xc9d3e0, 1.35);
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


function makeConcrete(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#b7b1a4";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2800; i++) {
    const n = Math.random();
    ctx.fillStyle = n > 0.55 ? `rgba(255,255,255,${n * 0.07})` : `rgba(30,26,22,${(1 - n) * 0.1})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, n > 0.88 ? 3 : 1, 1);
  }
  ctx.fillStyle = "rgba(40,38,34,0.18)";
  ctx.fillRect(0, 200, 256, 56);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeAsphalt(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#17181d";
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const n = Math.random();
    ctx.fillStyle = `rgba(255,255,255,${n * 0.045})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, n > 0.8 ? 2 : 1, 1);
  }
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.08 + Math.random() * 0.12})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 3, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(18, 18);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeJerseyBarrier(): THREE.Group {
  const g = new THREE.Group();
  g.name = "jersey-barrier";

  const shape = new THREE.Shape();
  shape.moveTo(-0.305, 0);
  shape.lineTo(0.305, 0);
  shape.lineTo(0.305, 0.075);
  shape.lineTo(0.215, 0.33);
  shape.lineTo(0.075, 0.81);
  shape.lineTo(-0.075, 0.81);
  shape.lineTo(-0.215, 0.33);
  shape.lineTo(-0.305, 0.075);
  shape.closePath();

  const concreteTex = makeConcrete();
  const concrete = new THREE.MeshStandardMaterial({
    color: 0xc4bfb3,
    roughness: 0.94,
    metalness: 0.05,
    map: concreteTex,
  });
  const weathered = new THREE.MeshStandardMaterial({
    color: 0xaea99d,
    roughness: 0.96,
    metalness: 0.04,
    map: concreteTex,
  });
  const jointMat = new THREE.MeshStandardMaterial({
    color: 0x5c5852,
    roughness: 0.8,
    metalness: 0.2,
  });

  const segLen = 1.78;
  for (const [zOff, mat] of [
    [-0.95, concrete],
    [0.95, weathered],
  ] as const) {
    const geo = new THREE.ExtrudeGeometry(shape, { depth: segLen, bevelEnabled: false, steps: 1 });
    geo.translate(0, 0, -segLen / 2);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = zOff;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.rest = (geo.getAttribute("position") as THREE.BufferAttribute).array.slice();
    g.add(mesh);
  }

  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.18, 8), jointMat);
  pin.position.set(0, 0.09, 0);
  pin.castShadow = true;
  g.add(pin);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.12), jointMat);
  cap.position.set(0, 0.82, 0);
  g.add(cap);
  return g;
}

function restoreBarrierRest(group: THREE.Group): void {
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const rest = obj.userData.rest as Float32Array | undefined;
    if (!rest) return;
    const geo = obj.geometry as THREE.BufferGeometry;
    const attr = geo.getAttribute("position") as THREE.BufferAttribute;
    (attr.array as Float32Array).set(rest);
    attr.needsUpdate = true;
    geo.computeVertexNormals();
  });
}

function makeLamp(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.1, 5.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x2a2c32, roughness: 0.7, metalness: 0.4 }),
  );
  pole.position.y = 2.6;
  pole.castShadow = true;
  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.1, 0.22),
    new THREE.MeshStandardMaterial({
      color: 0xf0e6c8,
      emissive: 0xf0e6c8,
      emissiveIntensity: 1.4,
      roughness: 0.4,
    }),
  );
  head.position.set(0, 5.15, 0.15);
  const light = new THREE.PointLight(0xf0e6c8, 2.4, 14, 2);
  light.position.set(0, 5, 0.2);
  g.add(pole, head, light);
  return g;
}

class DebrisSystem {
  private mesh: THREE.InstancedMesh;
  private life: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private dummy = new THREE.Object3D();
  private vel = new THREE.Vector3();
  private n: number;

  constructor(scene: THREE.Scene, n = 180) {
    this.n = n;
    const geo = new THREE.BoxGeometry(0.038, 0.016, 0.026);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6a6e74,
      metalness: 0.72,
      roughness: 0.4,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.count = 0;
    this.life = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    scene.add(this.mesh);
  }

  reset(): void {
    this.mesh.count = 0;
    this.life.fill(0);
  }

  snapshot() {
    const items: { x: number; y: number; z: number; life: number }[] = [];
    for (let i = 0; i < this.mesh.count && items.length < 16; i++) {
      if (this.life[i]! <= 0) continue;
      this.mesh.getMatrixAt(i, this.dummy.matrix);
      this.dummy.position.setFromMatrixPosition(this.dummy.matrix);
      items.push({
        x: round4(this.dummy.position.x),
        y: round4(this.dummy.position.y),
        z: round4(this.dummy.position.z),
        life: round4(this.life[i]!),
      });
    }
    return { count: items.length, items };
  }

  burst(origin: THREE.Vector3, normal: THREE.Vector3, count: number): void {
    const n = Math.min(this.n, Math.floor(count));
    this.mesh.count = n;
    for (let i = 0; i < n; i++) {
      this.life[i] = 0.9 + Math.random() * 1.5;
      const side = Math.random() - 0.5;
      this.vx[i] = -normal.x * (2 + Math.random() * 6) + (Math.random() - 0.5) * 5 + normal.z * side * 4;
      this.vy[i] = 1.4 + Math.random() * 4.2;
      this.vz[i] = -normal.z * (2 + Math.random() * 6) + (Math.random() - 0.5) * 5 - normal.x * side * 4;
      this.dummy.position.copy(origin);
      this.dummy.position.y += 0.08;
      this.dummy.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      this.dummy.scale.setScalar(0.45 + Math.random() * 0.7);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number, bounce: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void): void {
    if (this.mesh.count === 0) return;
    let any = false;
    for (let i = 0; i < this.mesh.count; i++) {
      if (this.life[i]! <= 0) continue;
      any = true;
      this.life[i]! -= dt;
      this.vy[i]! -= 9.6 * dt;
      this.mesh.getMatrixAt(i, this.dummy.matrix);
      this.dummy.position.setFromMatrixPosition(this.dummy.matrix);
      this.dummy.position.x += this.vx[i]! * dt;
      this.dummy.position.y += this.vy[i]! * dt;
      this.dummy.position.z += this.vz[i]! * dt;
      this.vel.set(this.vx[i]!, this.vy[i]!, this.vz[i]!);
      bounce(this.dummy.position, this.vel, 0.03);
      this.dummy.position.y = Math.max(0.04, this.dummy.position.y);
      this.vx[i] = this.vel.x;
      this.vy[i] = this.vel.y;
      this.vz[i] = this.vel.z;
      this.dummy.rotation.x += dt * 5;
      this.dummy.rotation.y += dt * 3.2;
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!any) this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

function makeDotTexture(color: string, glow: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, color);
  g.addColorStop(0.35, glow);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

class SparkSystem {
  private points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private life: Float32Array;
  private tmp = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private n: number;
  private cursor = 0;
  private anyAlive = false;

  constructor(scene: THREE.Scene, n = 480) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.life = new Float32Array(n);
    for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = 250;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setDrawRange(0, n);
    const mat = new THREE.PointsMaterial({
      map: makeDotTexture("rgba(255,248,220,1)", "rgba(255,170,70,0.7)"),
      color: 0xffffff,
      size: 0.055,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  reset(): void {
    this.life.fill(0);
    this.cursor = 0;
    this.anyAlive = false;
    for (let i = 0; i < this.n; i++) this.pos[i * 3 + 1] = 250;
    this.geo.setDrawRange(0, this.n);
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  burst(origin: THREE.Vector3, normal: THREE.Vector3, count: number): void {
    this.poof(origin, normal, count);
  }

  poof(origin: THREE.Vector3, normal: THREE.Vector3, count: number): void {
    const n = Math.min(this.n, Math.max(0, Math.floor(count)));
    for (let i = 0; i < n; i++) {
      const k = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;
      const ox = (Math.random() - 0.5) * 2;
      const oy = Math.random();
      const oz = (Math.random() - 0.5) * 2;
      const mag = Math.hypot(ox, oy, oz) || 1;
      this.pos[k * 3] = origin.x + (Math.random() - 0.5) * 0.22;
      this.pos[k * 3 + 1] = Math.max(0.08, origin.y) + Math.random() * 0.12;
      this.pos[k * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.22;
      const speed = 1.1 + Math.random() * 2.4;
      this.vx[k] = (ox / mag) * speed - normal.x * 0.6;
      this.vy[k] = (oy / mag) * speed * 0.85 + 0.8;
      this.vz[k] = (oz / mag) * speed - normal.z * 0.6;
      this.life[k] = 0.14 + Math.random() * 0.2;
    }
    if (n > 0) this.anyAlive = true;
    this.geo.setDrawRange(0, this.n);
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  snapshot() {
    return snapshotPoints(this.pos, null, null, this.life, true);
  }

  update(dt: number, bounce: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void): void {
    if (!this.anyAlive) return;
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue;
      any = true;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) {
        this.pos[i * 3 + 1] = 250;
        continue;
      }
      this.tmp.set(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
      this.vel.set(this.vx[i]!, this.vy[i]!, this.vz[i]!);
      this.tmp.addScaledVector(this.vel, dt);
      this.vel.y -= 6.5 * dt;
      bounce(this.tmp, this.vel, 0.025);
      this.tmp.y = Math.max(0.04, this.tmp.y);
      this.pos[i * 3] = this.tmp.x;
      this.pos[i * 3 + 1] = this.tmp.y;
      this.pos[i * 3 + 2] = this.tmp.z;
      this.vx[i] = this.vel.x;
      this.vy[i] = this.vel.y;
      this.vz[i] = this.vel.z;
    }
    this.anyAlive = any;
    if (any) (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    const mat = this.points.material as THREE.PointsMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}

class GlassDotSystem {
  private points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private life: Float32Array;
  private tmp = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private n: number;
  private cursor = 0;
  private anyAlive = false;

  constructor(scene: THREE.Scene, n = 320) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.life = new Float32Array(n);
    for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = 250;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setDrawRange(0, n);
    const mat = new THREE.PointsMaterial({
      map: makeDotTexture("rgba(255,255,255,1)", "rgba(210,230,245,0.55)"),
      color: 0xffffff,
      size: 0.042,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  reset(): void {
    this.life.fill(0);
    this.cursor = 0;
    this.anyAlive = false;
    for (let i = 0; i < this.n; i++) this.pos[i * 3 + 1] = 250;
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  burst(origin: THREE.Vector3, inherit: THREE.Vector3, count: number): void {
    const n = Math.min(this.n, Math.floor(count));
    for (let i = 0; i < n; i++) {
      const k = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;
      this.pos[k * 3] = origin.x + (Math.random() - 0.5) * 0.55;
      this.pos[k * 3 + 1] = Math.max(0.12, origin.y) + (Math.random() - 0.2) * 0.28;
      this.pos[k * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.4;
      this.vx[k] = inherit.x * 0.85 + (Math.random() - 0.5) * 5.5;
      this.vy[k] = inherit.y * 0.55 + 1.4 + Math.random() * 3.6;
      this.vz[k] = inherit.z * 0.85 + (Math.random() - 0.5) * 5.5;
      this.life[k] = 1.1 + Math.random() * 1.1;
    }
    if (n > 0) this.anyAlive = true;
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number, bounce: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void): void {
    if (!this.anyAlive) return;
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue;
      any = true;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) {
        this.pos[i * 3 + 1] = 250;
        continue;
      }
      this.tmp.set(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
      this.vel.set(this.vx[i]!, this.vy[i]!, this.vz[i]!);
      this.tmp.addScaledVector(this.vel, dt);
      this.vel.y -= 9.6 * dt;
      bounce(this.tmp, this.vel, 0.02);
      this.tmp.y = Math.max(0.04, this.tmp.y);
      this.pos[i * 3] = this.tmp.x;
      this.pos[i * 3 + 1] = this.tmp.y;
      this.pos[i * 3 + 2] = this.tmp.z;
      this.vx[i] = this.vel.x;
      this.vy[i] = this.vel.y;
      this.vz[i] = this.vel.z;
    }
    this.anyAlive = any;
    if (any) (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    const mat = this.points.material as THREE.PointsMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}

class TireSmokeSystem {
  private mesh: THREE.InstancedMesh;
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private dummy = new THREE.Object3D();
  private n: number;
  private cursor = 0;
  private anyAlive = false;

  constructor(scene: THREE.Scene, n = 420) {
    this.n = n;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size = new Float32Array(n);
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: makeDotTexture("rgba(210,210,206,0.95)", "rgba(70,70,68,0.25)"),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = n;
    scene.add(this.mesh);
    this.hideAll();
  }

  private hideAll(): void {
    this.dummy.scale.setScalar(0.001);
    this.dummy.position.set(0, 250, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  reset(): void {
    this.life.fill(0);
    this.cursor = 0;
    this.anyAlive = false;
    this.hideAll();
  }

  emitAt(origin: THREE.Vector3, inherit: THREE.Vector3, count: number): void {
    this.spawn(origin, inherit, count, 0.28, 1.2, 0.7);
  }

  plume(origin: THREE.Vector3, inherit: THREE.Vector3, count: number): void {
    this.spawn(origin, inherit, count, 0.55, 2.2, 1.4);
  }

  private spawn(
    origin: THREE.Vector3,
    inherit: THREE.Vector3,
    count: number,
    size: number,
    life: number,
    rise: number,
  ): void {
    const n = Math.min(this.n, Math.max(0, Math.floor(count)));
    for (let i = 0; i < n; i++) {
      const k = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;
      this.px[k] = origin.x + (Math.random() - 0.5) * 0.35;
      this.py[k] = Math.max(0.08, origin.y);
      this.pz[k] = origin.z + (Math.random() - 0.5) * 0.35;
      this.vx[k] = inherit.x * 0.04 + (Math.random() - 0.5) * 0.22;
      this.vy[k] = rise + Math.random() * 0.7;
      this.vz[k] = inherit.z * 0.04 + (Math.random() - 0.5) * 0.22;
      const L = life + Math.random() * 1.1;
      this.life[k] = L;
      this.maxLife[k] = L;
      this.size[k] = size + Math.random() * 0.4;
    }
    if (n > 0) this.anyAlive = true;
  }

  snapshot() {
    return snapshotPoints(this.px, this.py, this.pz, this.life, false);
  }

  update(
    dt: number,
    _bounce: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void,
    camera: THREE.Camera,
  ): void {
    void _bounce;
    if (!this.anyAlive) return;
    const damp = Math.exp(-0.7 * dt);
    let any = false;
    let wrote = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      const fade = Math.max(0, this.life[i]! / Math.max(this.maxLife[i]!, 1e-4));
      if (fade <= 0) {
        this.life[i] = 0;
        this.dummy.position.set(0, 250, 0);
        this.dummy.scale.setScalar(0.001);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        wrote = true;
        continue;
      }
      any = true;
      this.px[i]! += this.vx[i]! * dt;
      this.py[i]! += this.vy[i]! * dt;
      this.pz[i]! += this.vz[i]! * dt;
      this.vy[i]! += 0.55 * dt;
      this.vx[i]! *= damp;
      this.vz[i]! *= damp;
      this.dummy.position.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      this.dummy.scale.setScalar(this.size[i]! * (0.7 + (1 - fade) * 1.8));
      this.dummy.quaternion.copy(camera.quaternion);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      const g = 0.55 + fade * 0.4;
      this.mesh.setColorAt(i, _smokeColor.setRGB(g, g, g * 0.96));
      wrote = true;
    }
    this.anyAlive = any;
    if (wrote) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    const mat = this.mesh.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}

const _smokeColor = new THREE.Color();

class CrashAudio {
  private ctx: AudioContext | null = null;
  unlocked = false;

  unlock(): void {
    if (this.unlocked) {
      void this.ctx?.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.unlocked = true;
    void this.ctx.resume();
  }

  impact(impulse: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.35 + Math.min(0.4, impulse * 0.01);

    const thump = ctx.createOscillator();
    const thumpG = ctx.createGain();
    thump.type = "sine";
    thump.frequency.setValueAtTime(48, t);
    thump.frequency.exponentialRampToValueAtTime(22, t + dur);
    thumpG.gain.setValueAtTime(Math.min(0.7, 0.22 + impulse * 0.012), t);
    thumpG.gain.exponentialRampToValueAtTime(0.001, t + dur);
    thump.connect(thumpG).connect(ctx.destination);
    thump.start(t);
    thump.stop(t + dur);

    const noise = ctx.createBufferSource();
    const nbuf = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
    const data = nbuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    noise.buffer = nbuf;
    const ng = ctx.createGain();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 0.7;
    ng.gain.setValueAtTime(Math.min(0.45, 0.12 + impulse * 0.008), t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    noise.connect(bp).connect(ng).connect(ctx.destination);
    noise.start(t);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
