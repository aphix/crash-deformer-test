import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import type { CarPaint } from "../vehicle/car-core.ts";
import { WheelBatch } from "../vehicle/wheel-batch.ts";
import { COMPACTOR, CompactorRig } from "../scenes/compactor.ts";
import { StackRig } from "../scenes/stack-rig.ts";
import { PistonRig } from "../scenes/piston-rig.ts";
import { PistonBank } from "../present/engine-pistons.ts";
import { DoorRig, type RamShot } from "../scenes/door-rig.ts";
import { DoorRam } from "../present/engine-doors.ts";
import { INITIAL_HUD } from "../hud/hud-store.ts";
import { beginImpact, holdForThrow, pairEta, phaseClock } from "../match/phase.ts";
import { newWorld } from "./world-step.ts";
import { EjectionWatch } from "../vehicle/ejection.ts";
import type { DeformMode } from "../deform/deform-rig.ts";
import { MAX_CARS, slotType, type CarType } from "../scenes/fleet.ts";
import { fleetProp, type SceneId } from "../scenes/scene-id.ts";
import { SceneFade } from "../present/scene-fade.ts";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import { armKill, assignClass, carClass, HANDLING, killClass, STYLE_CLASS, type VehicleClassId } from "../vehicle/vehicle-classes.ts";
import { DRIVER_CARS, type DriverCar } from "../match/types.ts";
import { WorldStage, makeLamp } from "../present/engine-world.ts";
import { Cinematics } from "../present/engine-cine.ts";
import { loadHdrEnv, STUDIO_ENV_URL } from "../present/look-env.ts";
import { CarDetail } from "../present/car-detail.ts";
import { addCars, occluder, type Occluder, type Sight } from "../present/spectate-cam.ts";
import { activeGround } from "../world/ground.ts";
import { BARRIER_HALF } from "../contact/sat.ts";
import type { AutoFx } from "../present/auto-fx.ts";
import type { DetailGovernor } from "../present/detail-governor.ts";
import { DebrisSystem, SparkSystem, GlassDotSystem, TireSmokeSystem, CrashAudio } from "../present/engine-fx.ts";
import { FX_REACH, Witness } from "../present/witness.ts";
import type { RagdollSystem } from "../present/engine-ragdoll.ts";
import { ChaseCamera } from "../present/engine-camera.ts";
import { CompactorPress, JerseyBarrier, buildRampBalls, type LampPole, type RampBall } from "../scenes/engine-props.ts";
import type { FleetRamps } from "../scenes/fleet-ramps.ts";
import type { Corkscrew } from "../scenes/corkscrew.ts";
import { TraceRecorder, type TraceClock, type TraceSetup } from "./engine-trace.ts";
import { DerbyMatch } from "../match/derby.ts";
import { LampBatch, LampLights } from "../vehicle/lamp-lights.ts";
import { DriverSeat } from "../vehicle/car-drive.ts";
import { GamepadInput } from "../vehicle/gamepad.ts";
import { DERBY_RADIUS, WinnerSpot } from "../scenes/derby-arena.ts";
import { groundMesh, LINE_LIFT } from "../scenes/ground-stack.ts";
import { RangeRun } from "../scenes/range.ts";
import { NetPlay } from "../net/net-play.ts";
import { RaceDirector } from "./engine-race.ts";
import { clearTransients } from "./scene-clear.ts";
import { Lab } from "./engine-lab.ts";
import type { LabFlick } from "./lab-flick.ts";
import type { LabArt } from "../present/lab-art.ts";
import type { Garage } from "./garage.ts";
import { PlayerLooks } from "./player-looks.ts";
import { wearCarLook } from "../present/car-look.ts";
import { NO_CAR_PICK } from "../match/look-data.ts";
import { FLOOR } from "../scenes/lab.ts";

const _v = new THREE.Vector3();
/** The masses a wreck's engine smoke rises from (`puffEngine`). */
const ENGINE_MASSES = ["engineL", "engineR"] as const;
/**
 * A thrown driver's shard cover (`onExit`), half extents (m) in his way out's frame: 1.4 m across, 0.6 m tall, 1.6 m
 * out of the pane (to the nose over the bonnet; past the door).
 */
const EXIT_COVER = new THREE.Vector3(0.7, 0.3, 0.8);

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

/**
 * The engine's state (renderer, cars, rigs, FX systems, clock), the car roster and the queries and crash FX every
 * other engine layer shares. Layers stack `EngineCore` → `EngineWarm` → `EngineHud` → `EngineDerby` → `EngineScenes` →
 * `EngineRigs` → `EngineInput` → `CrashEngine` (one class split by context; `CrashEngine` is the only one anything else constructs).
 */
export abstract class EngineCore {
  /** Defined by `CrashEngine` (its host callbacks reach every layer). */
  protected abstract readonly net: NetPlay;
  protected abstract emitHud(): void;
  /** The page URL's `#` follows the HUD state (`EngineShare`). */
  protected abstract syncShareUrl(): void;
  protected abstract queueWarm(): void;
  /** Which rig is in charge of the camera this frame, for the trace (`CrashEngine.cameraRig`). */
  protected abstract cameraRig(): string;
  playing = true;
  looping = true;
  showRig = false;
  showParticles = false;
  /** The user's fleet props (HUD, hash). A scene never writes them; read the `…Up` getters for what is on screen. */
  showBarrier = false;
  showBalls = false;
  showRamps = false;
  get barrierUp(): boolean {
    return fleetProp(this.sceneId, "barrier", this.showBarrier);
  }
  get ballsUp(): boolean {
    return fleetProp(this.sceneId, "balls", this.showBalls);
  }
  get rampsUp(): boolean {
    return fleetProp(this.sceneId, "ramps", this.showRamps);
  }
  /** The one scene in play; `derbyMode` and the three rig flags read it. The race director's `active` mirrors "race". */
  protected sceneId: SceneId = "fleet";
  /** The scene-switch transition (`engine-scenes.ts` drives it): the scene button reads its pending target for the HUD. */
  protected readonly sceneFade = new SceneFade<SceneId>();
  /** This run's random picks (the spawns of the seeded scenes) all derive from it; the share URL carries it. */
  protected sceneSeed = 0;
  /** A seed the next resets reuse instead of rolling one (a pasted URL's); `EngineShare` clears it once applied. */
  protected pinnedSeed: number | null = null;
  autoRotate = true;
  autoSlomo = true;
  audioOn = false;
  deformMode: DeformMode = "shape";
  captureTrace = false;
  get derbyMode(): boolean {
    return this.sceneId === "derby";
  }
  get showCompactor(): boolean {
    return this.sceneId === "press";
  }
  get showPistons(): boolean {
    return this.sceneId === "pistons";
  }
  get showDoors(): boolean {
    return this.sceneId === "doors";
  }
  /** The ejection range: car A into the jersey barrier, its driver over it into the sand field (`RANGE`). */
  get showRange(): boolean {
    return this.sceneId === "range";
  }
  get showCorkscrew(): boolean {
    return this.sceneId === "corkscrew";
  }
  /** Cars dropped one at a time onto a base car: the bottom roof crushes by the weight above it (`StackRig`). */
  get showStack(): boolean {
    return this.sceneId === "stack";
  }
  /** The Lab: toy cars, props and a pegboard on a giant workbench; the player flicks a thing at the others (`Lab`). */
  get showLab(): boolean {
    return this.sceneId === "lab";
  }
  /** The garage: the player's car and driver under a work light, recoloured and spray-painted from the HUD (`Garage`). */
  get showGarage(): boolean {
    return this.sceneId === "garage";
  }
  /** A staged scene: the press, the piston bank or the door ram moves the car; the corkscrew only times it; the stack's cars fall under the world step alone. */
  protected get rigScene(): boolean {
    return this.sceneId === "press" || this.sceneId === "pistons" || this.sceneId === "doors" || this.sceneId === "corkscrew" || this.sceneId === "stack";
  }

  protected canvas!: HTMLCanvasElement;
  /** A black full-screen div above the HUD (CrashLab's); its opacity is the transition's `black`. */
  protected veil!: HTMLElement;
  protected renderer!: THREE.WebGLRenderer;
  protected scene = new THREE.Scene();
  protected camera!: THREE.PerspectiveCamera;
  protected cars: DeformableCar[] = [];
  private liveBuf: DeformableCar[] = [];
  protected carCount = INITIAL_HUD.carCount;
  protected get carA(): DeformableCar {
    return this.cars[0]!;
  }
  protected disposed = false;
  protected last = 0;
  /** Set by `advance` on its silent frames: the frame steps everything but the post-chain draw. */
  protected skipDraw = false;
  protected readonly clock = phaseClock();
  protected fps = 0;
  /** Main-thread ms the last `tickInner` took (sim, camera, FX, draw submit): what the quality governors read as frame work. */
  protected workMs = 0;
  protected impactKph: number | null = null;
  protected elapsedWall = 0;
  protected elapsedSim = 0;
  protected impactLight!: THREE.PointLight;
  protected stage!: WorldStage;
  protected cine!: Cinematics;
  /** The automatic FX tier (`present/auto-fx.ts`); `fxFrame` applies it. */
  protected autoFx!: AutoFx;
  /** The Ultra tier is being fetched (`setFxTier`); the HUD shows it. */
  protected fxLoading = false;
  /** The distance detail's rung (`present/detail-governor.ts`), chosen by how the match runs; `fxFrame` applies it to `detail` while the tier is automatic. */
  protected detailGov!: DetailGovernor;
  protected impactLightLife = 0;
  protected envMap: THREE.Texture | null = null;
  protected debris!: DebrisSystem;
  protected readonly wheels = new WheelBatch(MAX_CARS * 4);
  protected readonly lampBatch = new LampBatch(MAX_CARS * 2);
  protected lampLights!: LampLights;
  protected sparks!: SparkSystem;
  protected glassDots!: GlassDotSystem;
  protected smoke!: TireSmokeSystem;
  protected ragdolls!: RagdollSystem;
  protected audio!: CrashAudio;
  protected hudAcc = 0;
  protected resizeObs!: ResizeObserver;
  private ring!: THREE.Mesh;
  protected barrier!: JerseyBarrier;
  protected barrierHits: boolean[] = [];
  /** The range's sand field and distance signs: built on first entering the range, shown in that scene only. */
  protected rangeArt: THREE.Group | null = null;
  protected readonly rangeRun = new RangeRun();
  /** The Lab's set and throw readback; its workshop art and flick are built on first entering the Lab. */
  protected readonly lab = new Lab();
  protected labArt: LabArt | null = null;
  protected labFlick: LabFlick | null = null;
  /** Every player's look this browser draws (its own and its netplay peers'); worn on each dress (`dressCar`). */
  protected readonly looks = new PlayerLooks();
  /** The garage's room, standing driver and spray can; built on first entering the garage. */
  protected garage: Garage | null = null;
  protected fxPoofed = false;
  protected sparkAt = -10;
  protected deadSmokeAcc: number[] = [];
  /** Per car: `elapsedWall` when it vaporized (fleet disc); unset while it is in play. */
  protected vaporAt: number[] = [];
  /** The camera cone every cosmetic skip asks (`present/witness.ts`); `scheduleSkins` and `flushVisibleSkins` read the camera into it. */
  protected readonly witness = new Witness();
  protected lodFrame = 0;
  /** Per car index: skin stride from the last LoD pass (0 = off-screen). */
  protected lodStride: number[] = [];
  /** Distance detail for every car (`present/car-detail.ts`); `CrashEngine` runs it once a frame before the draw. */
  protected readonly detail = new CarDetail();
  protected squash = INITIAL_HUD.squash;
  /** Slot 0's car type: the HUD's pick for the player's car (`setPlayerCar`, `setDriver`); the Stack drops it in every slot. */
  protected playerCar: DriverCar = DRIVER_CARS[0]!;
  /** Which scene's car types the cars were last built for (`followSceneTypes`): the Stack's, the Lab's or the fleet's (""). */
  private typedFor = "";
  /** Race police chase: cars `policeFrom … policeFrom + policeCount − 1` are built as police (`setPolice`). */
  private policeFrom = 0;
  private policeCount = 0;
  protected buckle = INITIAL_HUD.buckle;
  protected fxDensity = INITIAL_HUD.fxDensity;
  /** The HUD's cel look (`CrashHudState.celLook`): null = Auto. */
  protected celLook = INITIAL_HUD.celLook;
  protected speedMin = INITIAL_HUD.speedMin;
  protected speedMax = INITIAL_HUD.speedMax;
  protected balls: RampBall[] = [];
  protected poles: LampPole[] = [];
  protected smokeUntil: number[] = [];
  protected readonly compactor = new CompactorRig();
  protected compactFxAt = 0;
  protected press!: CompactorPress;
  protected pistons = new PistonRig();
  protected pistonBank!: PistonBank;
  protected pistonSelected = 0;
  /** A shot went off since the car was parked; the loop (`stepPistonLoop`) re-parks for the next one. */
  protected pistonFired = false;
  /** Last shot fired all eight: show the whole bank, not just the selected ram. */
  protected pistonAll = false;
  /** Wall seconds since the last shot (loop pacing). */
  protected pistonSinceFire = 0;
  protected pistonFxAt = 0;
  protected doorRig = new DoorRig();
  /** The stack scene's drops and settings (`scenes/stack-rig.ts`). */
  protected readonly stack = new StackRig();
  protected doorRam!: DoorRam;
  /** Last finished door shot, for the HUD. */
  protected doorShot: RamShot | null = null;
  protected doorFx = false;
  /** The fleet's jump ramps (`showRamps`) and the corkscrew scene's channel. */
  protected ramps!: FleetRamps;
  protected corkscrew!: Corkscrew;
  protected derby = new DerbyMatch();
  /** This match's bowl radius (grows with the field, `derbyRadius`). */
  protected derbyR = DERBY_RADIUS;
  /** Netplay host: peers' cars and names. A derby seats them (`derbySeated`) when a match begins, which bumps `derbyRound`. */
  protected netSeats: ReadonlyMap<number, string> = new Map();
  protected derbySeated = new Set<number>();
  protected derbyRound = 0;
  protected seat = new DriverSeat();
  protected keys = new Set<string>();
  protected readonly pad = new GamepadInput();
  protected readonly raycaster = new THREE.Raycaster();
  protected readonly ndc = new THREE.Vector2();
  protected arena!: THREE.Group;
  protected winnerSpot!: WinnerSpot;
  protected view!: ChaseCamera;
  protected trace!: TraceRecorder;
  /** Decides who is thrown out of which car (`stepWorld` runs it each step through `world.ejection`). */
  protected readonly ejection = new EjectionWatch();
  protected readonly world = newWorld([], null, this.ejection);
  /** Sandbox floor, grid and rings: hidden while a race course is up. */
  protected readonly studio: THREE.Object3D[] = [];
  protected sun!: THREE.DirectionalLight;
  protected race!: RaceDirector;
  /** Car count to restore when leaving race mode. */
  protected sandboxCars = 2;

  protected tryUnlockAudio(): void {
    if (this.audioOn) this.audio.unlock();
  }


  protected live(): DeformableCar[] {
    const n = this.carCount;
    const buf = this.liveBuf;
    if (buf.length !== n) buf.length = n;
    for (let i = 0; i < n; i++) buf[i] = this.cars[i]!;
    return buf;
  }

  /** Times the scene was cleared, mod 128; every snapshot carries it so a netplay client clears its own scene when it moves (`Snapshot.clearGen`). */
  private clears = 0;

  /** Empties every system a run leaves behind (`clearTransients`). Add a new debris-like system here and to `Transients`. */
  protected clearLocal(): void {
    clearTransients({ cars: this.cars, poles: this.poles, debris: this.debris, sparks: this.sparks, glassDots: this.glassDots, smoke: this.smoke, ragdolls: this.ragdolls, rangeRun: this.rangeRun, cine: this.cine });
  }

  /** A scene change, loop, reset or race start: the scene is emptied, the ejection watch forgets its history and netplay clients are told (their snapshots carry `clearGen`). */
  protected clearScene(): void {
    this.clears = (this.clears + 1) & 127;
    this.ejection.reset();
    this.clearLocal();
  }

  protected clearGen(): number {
    return this.clears;
  }

  protected ensureCars(n: number): void {
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

  /** The bench's one body for every non-police car (`?bench=strip&same=`). Not a setting: the HUD, the hash and storage never see it. */
  private oneBody: CarType | null = null;

  /** Every non-police car wears `style` (null: the fleet's mix again), rebuilt at once where it differs. */
  useOneBody(style: CarStyleId | null): void {
    this.oneBody = style ? { cls: STYLE_CLASS[style], style } : null;
    this.retypeCars();
  }

  /** What car slot `i` is now: a police cruiser inside the race's police range, else the bench's one body, else the Lab's car or `slotType`. */
  private slotCar(i: number): CarType {
    return this.isPolice(i) ? { cls: "police", style: "police" } : (this.oneBody ?? (this.showLab && i < this.lab.types.length ? this.lab.types[i]! : slotType(i, this.playerCar, this.showStack)));
  }

  protected buildCar(i: number, type: CarType = this.slotCar(i)): DeformableCar {
    const { cls, style } = type;
    const base = FLEET_PAINT[i % FLEET_PAINT.length]!;
    const paint: CarPaint =
      i < FLEET_PAINT.length ? base : { ...base, name: `${base.name}-${Math.floor(i / FLEET_PAINT.length) + 1}` };
    const car = new DeformableCar(paint, this.scene, (origin, vel, count) => this.witness.sees(origin, FX_REACH.glass) && this.glassDots.burst(origin, vel, count), style);
    assignClass(car, cls);
    car.group.visible = false;
    car.group.userData.carIndex = i;
    this.scene.add(car.group);
    this.queueWarm();
    return car;
  }

  /** Race police chase: car `i` (never the player's) is in the police range set by `setPolice`. */
  private isPolice(i: number): boolean {
    return i > 0 && i >= this.policeFrom && i < this.policeFrom + this.policeCount;
  }

  /**
   * Race police chase: cars `from … from + count − 1` are police cruisers; every police car below `from`
   * is rebuilt as its fleet self. Cars past the range keep their look until a field needs them (no
   * rebuild churn between races).
   */
  protected setPolice(from: number, count: number): void {
    this.policeFrom = from;
    this.policeCount = count;
    for (let i = 1; i < Math.min(this.cars.length, from + count); i++) {
      if ((this.cars[i]!.style.id === "police") !== this.isPolice(i)) this.rebuildCar(i);
    }
  }

  /** Car `i` rebuilt as what its slot is now (`slotCar`), keeping its visibility. */
  protected rebuildCar(i: number): void {
    const old = this.cars[i]!;
    this.scene.remove(old.group);
    old.dispose();
    const car = this.buildCar(i);
    car.group.visible = old.group.visible;
    this.dressCar(car);
    this.cars[i] = car;
  }

  /**
   * The Stack puts the player's pick in every slot, the Lab its layout's cars and every other scene the fleet's: when the scene
   * changed between them, every car whose body or class is not its slot's now is rebuilt (hidden ones too, so a later bigger
   * field is already right).
   */
  protected followSceneTypes(): void {
    const typedFor = this.showStack ? "stack" : this.showLab ? "lab" : "";
    if (typedFor === this.typedFor) return;
    this.typedFor = typedFor;
    this.retypeCars();
  }

  /**
   * Rebuilds every car that is not what its slot is now; true when any was. In the Lab a slot past the set's cars is a hidden
   * spare and keeps its body: rebuilding three spares to the fleet's bodies on every set change (and back to sedans on the
   * next) was the set picker's hitch (25-42 ms on desktop, the bench's 165 ms frame at 4x).
   */
  protected retypeCars(): boolean {
    let changed = false;
    for (let i = 0; i < this.cars.length; i++) {
      if (this.showLab && i >= this.lab.types.length) continue;
      const car = this.cars[i]!;
      const want = this.slotCar(i);
      if (car.style.id === want.style && carClass(car) === want.cls) continue;
      this.rebuildCar(i);
      changed = true;
    }
    return changed;
  }

  /** Netplay client: car `i` takes the host's body style and class, rebuilt only when either differs. */
  matchCar(i: number, style: CarStyleId, cls: VehicleClassId): void {
    const old = this.cars[i];
    if (!old || (old.style.id === style && carClass(old) === cls)) return;
    this.scene.remove(old.group);
    old.dispose();
    const car = this.buildCar(i, { cls, style });
    car.group.visible = i < this.carCount;
    this.dressCar(car);
    this.cars[i] = car;
  }

  protected dressCar(car: DeformableCar): void {
    car.deform.squash = this.squash;
    car.deform.buckle = this.buckle;
    car.deform.setMode(this.deformMode);
    car.setRigVisible(this.showRig);
    car.deform.setParticlesVisible(this.showParticles);
    // Re-dress after a respawn re-attached its parts, and arm the slider's kill travel (a derby's is shorter).
    const cls = carClass(car);
    assignClass(car, cls);
    armKill(car.deform, killClass(car), HANDLING.realism, this.derbyMode ? "derby" : "default");
    const look = this.looks.of(car.group.userData.carIndex as number, this.ownCar());
    wearCarLook(car, look?.car ?? NO_CAR_PICK, look?.carSpray ?? null);
  }

  /** This browser's own car: its netplay seat as a guest, else the player's car 0. */
  protected ownCar(): number {
    return this.net.client ? this.net.status().car : 0;
  }


  protected traceSetup(): TraceSetup {
    return {
      barrier: this.barrierUp,
      barrierYaw: this.barrier.yaw,
      squash: this.squash,
      buckle: this.buckle,
      fxDensity: this.fxDensity,
      balls: this.ballsUp,
      ramps: this.rampsUp,
      compactor: this.showCompactor,
      compactFace: this.compactor.face,
      carCount: this.carCount,
      speedMin: this.speedMin,
      speedMax: this.speedMax,
      scene: this.sceneId,
      seed: this.sceneSeed,
      night: this.stage.night,
      wet: this.stage.wet,
      realism: HANDLING.realism,
      fxTier: this.cine.tier,
      loop: this.looping,
      autoSlomo: this.autoSlomo,
      userTimeScale: this.clock.userTimeScale,
      deformMode: this.deformMode,
      playerClass: this.playerCar.cls,
      viewW: this.renderer.domElement.width,
      viewH: this.renderer.domElement.height,
      pixelRatio: this.renderer.getPixelRatio(),
      dpr: globalThis.devicePixelRatio ?? 1,
    };
  }

  protected traceClock(): TraceClock {
    return {
      wall: this.elapsedWall,
      sim: this.elapsedSim,
      phase: this.clock.phase,
      timeScale: this.clock.timeScale,
      closing: this.fleetClosing(),
      barrierHit: this.barrierHits.some(Boolean),
      camera: this.camera,
      rig: this.cameraRig(),
      follow: this.followedCar()?.paint.name ?? null,
    };
  }

  protected beginTrace(): void {
    this.trace.begin(this.traceSetup(), this.live(), this.traceClock());
  }

  protected fleetClosing(): number {
    if (this.showCompactor) return COMPACTOR.speed * 2;
    if (this.showPistons) {
      let u = 0;
      const heads = this.pistons.heads;
      for (let k = 0; k < heads.length; k++) u = Math.max(u, heads[k]!.u);
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
  protected followedCar(): DeformableCar | null {
    return this.seat.mode !== "global" && this.seat.carIndex >= 0 && this.seat.carIndex < this.carCount
      ? this.cars[this.seat.carIndex]!
      : null;
  }
  /** Sim seconds to the first hit coming between the live cars, or a car and the slab (`pairEta`), Infinity if none. */
  protected contactEta(): number {
    const cars = this.live();
    for (let i = 0; i < cars.length; i++) cars[i]!.refreshBasis();
    const eta = pairEta(cars);
    return this.barrierUp ? this.barrier.contactEta(cars, eta) : eta;
  }
  /** The crash's hit: slow-mo, kick, flash and burst; `crashCam` overrides the sandbox's rule for the crash cam (the reel always wants it). */
  protected beginCinematic(contact: THREE.Vector3, normal: THREE.Vector3, impulse: number, crashCam?: boolean): void {
    beginImpact(this.clock, this.autoSlomo);
    this.impactKph = impulse * 3.6;
    this.view.kick(this.carCount);
    const rigScene = this.rigScene;
    this.cine.impact(contact, normal, impulse, crashCam ?? (!rigScene && this.autoSlomo && this.clock.userTimeScale == null && this.seat.mode === "global" && !this.view.userFramed), this.sceneSight(null, false), this.clock.hold);
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
    this.emitHud();
  }

  /**
   * The scene's solids as the spectator and crash cams see them: the course's own, or the sandbox's lamp poles, barrier and
   * balls, within the derby bowl's rim. `cars`: every visible car but `followed` stands in it too (a crash cam leaves them out:
   * they are what it films).
   */
  protected sceneSight(followed: DeformableCar | null, cars: boolean): Sight {
    const course = this.race.active ? this.race.courseSight() : null;
    const occ: Occluder[] = course ? [...course.occ] : [];
    if (cars) addCars(occ, this.live(), followed);
    if (course) return { ...course, occ };
    for (const pole of this.poles) {
      if (pole.intact && pole.group.visible) occ.push(occluder(pole.group.position.x, pole.group.position.z, 0, 0.45, 0.45, true, 0, 5.3));
    }
    if (this.barrierUp) {
      const b = this.barrier.group.position;
      occ.push(occluder(b.x, b.z, this.barrier.yaw, BARRIER_HALF.x, BARRIER_HALF.z, false, 0, 0.9));
    }
    if (this.ballsUp) {
      for (const ball of this.balls) {
        const b = ball.mesh.position;
        if (ball.mesh.visible) occ.push(occluder(b.x, b.z, 0, ball.radius, ball.radius, true, b.y - ball.radius, b.y + ball.radius));
      }
    }
    if (this.showLab) {
      // The wall the pegboard hangs on (the Lab's last collider): the crash cam never stands behind the board.
      const w = this.lab.colliders.at(-1)!;
      occ.push(occluder(w.x, w.z, w.yaw, w.hx, w.hz, false, FLOOR, w.top));
    }
    return { ground: activeGround(), path: null, wallTop: 0, rim: this.derbyMode ? this.derbyR : Infinity, occ };
  }
  /**
   * A driver is being thrown, his way out centred on `at` (`frame`'s z out of the pane): a heavy, very short shatter
   * (owner, 2026-10-03) fills it, pane to bonnet or door, as he crosses it, with bits of trim and dust.
   */
  protected onExit(at: THREE.Vector3, frame: THREE.Quaternion, inherit: THREE.Vector3): void {
    const k = this.fxDensity;
    this.glassDots.shatter(at, frame, EXIT_COVER, inherit, 260 * k);
    this.debris.burst(at, _v.set(0, 0, -1).applyQuaternion(frame), 14 * k);
    this.smoke.glassDust(at, frame, EXIT_COVER, 14 * k);
  }

  /**
   * A sandbox driver left car i (`RagdollSystem` never calls this in a race or a derby): his exit plays at 1×, the
   * slow-mo `THROW_ONSET` on (`holdForThrow`, unless the hit's was held already), and the camera rides with the
   * thrown drivers from that moment (the crash cam's cuts wait), unless it follows another car or the user framed it.
   */
  protected onThrow(i: number): void {
    if (!this.net.client && !this.rigScene) holdForThrow(this.clock);
    const followed = this.followedCar();
    if (this.view.userFramed || (followed && followed !== this.cars[i])) return;
    this.ragdolls.follow();
  }

  protected nearestCar(point: THREE.Vector3): DeformableCar {
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


  protected armEngineSmoke(car: DeformableCar, extra: number): void {
    if (!car.crashed) return;
    const until = this.elapsedWall + extra;
    const i = Math.max(0, this.cars.indexOf(car));
    this.smokeUntil[i] = Math.max(this.smokeUntil[i] ?? 0, until);
  }

  protected puffDeadEngine(car: DeformableCar): void {
    const m = car.deform.massWorld("engineL");
    _v.copy(m);
    _v.y = Math.max(0.35, m.y);
    if (this.witness.sees(_v, FX_REACH.smoke)) this.smoke.wisp(_v, car.velocity);
  }

  protected puffEngine(car: DeformableCar): void {
    if (!car.crashed || !car.deform.massActive) return;
    if (car.deform.drivetrainAlive && car.deform.partCompression("bonnet") < 0.08) return;
    const n = Math.max(2, (4 * this.fxDensity) | 0);
    for (let k = 0; k < ENGINE_MASSES.length; k++) {
      const m = car.deform.massWorld(ENGINE_MASSES[k]!);
      _v.copy(m);
      _v.y = 0.12;
      if (this.witness.sees(_v, FX_REACH.smoke)) this.smoke.plume(_v, car.velocity, n);
    }
  }
  /** The orbit paces the piston loop: turning, untouched by the user, and visibly moving. */
  protected pistonHopSynced(): boolean {
    return this.autoRotate && !this.view.userFramed && !this.clock.reduceMotion && this.seat.mode !== "drive";
  }

  protected resize = (): void => {
    const parent = this.canvas.parentElement ?? this.canvas;
    const w = Math.max(1, parent.clientWidth);
    const h = Math.max(1, parent.clientHeight);
    this.renderer.setSize(w, h, false);
    this.cine.post.setSize();
    this.fitLens();
  };
  /** The camera's lens for the canvas's new size (`EngineReel`: the results reel frames the part the sheet leaves free). */
  protected abstract fitLens(): void;

  /** The studio environment (public/env-studio.hdr, RGBE) prefiltered to PMREM at boot. Settles once attached or failed. */
  protected async attachStudioEnv(): Promise<void> {
    const env = await loadHdrEnv(this.renderer, STUDIO_ENV_URL, () => !this.disposed);
    if (!env) return;
    this.scene.environment = env;
    this.scene.environmentIntensity = this.stage.envIntensity;
    this.envMap?.dispose();
    this.envMap = env;
  }

  protected buildWorld(): void {
    this.stage = new WorldStage(this.scene);
    this.sun = this.stage.sun;
    this.studio.push(this.stage.ground);

    const grid = new THREE.GridHelper(60, 30, 0x2a2c32, 0x18191e);
    grid.position.y = LINE_LIFT;
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
    this.ring = groundMesh(ringGeo, ringMat, "decal");
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.03;
    this.scene.add(this.ring);
    this.studio.push(this.ring);

    const inner = groundMesh(
      new THREE.RingGeometry(0.12, 0.22, 24),
      new THREE.MeshBasicMaterial({ color: 0xd8d4cc, transparent: true, opacity: 0.35, side: THREE.DoubleSide, forceSinglePass: true }),
      "decal",
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
