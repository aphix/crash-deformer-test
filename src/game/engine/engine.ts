import * as THREE from "three";
import { bleedAfterSlide, DeformableCar } from "../vehicle/car.ts";
import { PISTON_ORBIT_RATE, PistonBank } from "../present/engine-pistons.ts";
import { DoorRam } from "../present/engine-doors.ts";
import { physicsSlice, sliceSpeed } from "../contact/sat.ts";
import { INITIAL_HUD, type HudStore } from "../hud/hud-store.ts";
import { easeTimeScale, impactScale, stepPhase } from "../match/phase.ts";
import { stepWorld } from "./world-step.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { damageStage } from "../vehicle/vehicle-classes.ts";
import { makeJerseyBarrier, makePoolTexture } from "../present/engine-world.ts";
import { Cinematics } from "../present/engine-cine.ts";
import { FX_TIERS } from "../present/engine-post.ts";
import { DebrisSystem, SparkSystem, GlassDotSystem, TireSmokeSystem, CrashAudio, bounceGround } from "../present/engine-fx.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import { ChaseCamera, centroid, type SpecScene } from "../present/engine-camera.ts";
import { occluder, type Occluder, type Sight } from "../present/spectate-cam.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { CompactorPress, JerseyBarrier } from "../scenes/engine-props.ts";
import { BARRIER_HALF } from "../contact/sat.ts";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { TraceRecorder } from "./engine-trace.ts";
import { snapshotAiCar } from "../match/derby.ts";
import { LampLights } from "../vehicle/lamp-lights.ts";
import { applyDrive, BOOST } from "../vehicle/car-drive.ts";
import { makeDerbyArena, WinnerSpot } from "../scenes/derby-arena.ts";
import { NetPlay } from "../net/net-play.ts";
import { RaceDirector } from "./engine-race.ts";
import { TrackArt } from "../present/track-art.ts";
import { EngineInput } from "./engine-input.ts";

const FIXED = 1 / 60;
const PRE_IMPACT_LEAD = 0.07;
/** Deform LoD: sphere around a car — rest half-diagonal 2.5 m plus crumple slack and the
 *  ≈0.9 m the sun throws the roof's shadow, so an off-screen car's shadow is never stale either. */
const LOD_RADIUS = 3.5;
/** Projected sphere radius (CSS px) below which a car skins every 2nd / every 4th frame. */
const LOD_SMALL_PX = 40;
const LOD_TINY_PX = 20;
const _lodSphere = new THREE.Sphere();
/**
 * Distance detail: beyond `DETAIL_NEAR` m from the camera a car (never the followed one) drops its small parts
 * that cast no shadow (trims, grille, mirrors, door linings: 12 of its 20 draws) and its 4 lamps from the lamp
 * batch. They are a few pixels there; body, panels, glass, interior and wheels stay. Back within `DETAIL_BACK`
 * they return (hysteresis).
 */
const DETAIL_NEAR = 35;
const DETAIL_BACK = 32;

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _bn = new THREE.Vector3();
const _bp = new THREE.Vector3();

/**
 * Lit shaders skip a point or spot light's BRDF where the light adds nothing: past its range, outside its cone,
 * or at intensity 0. Every lit program carries the lamp pool's 4 spots and 4 points (`lamp-lights.ts`: changing
 * the count relinks every program), the impact flash and the derby winner's spot, and three ran the full BRDF
 * for each of them on every fragment. Exact: three already zeroes such a light's colour and clears `visible`.
 */
const RE_DIRECT = "RE_Direct( directLight, ";
const SKIP_DARK = `if ( directLight.visible ) ${RE_DIRECT}`;
const lightsChunk = THREE.ShaderChunk.lights_fragment_begin;
if (!lightsChunk.includes(RE_DIRECT)) throw new Error("three's lights_fragment_begin changed: re-check the dark-light skip");
if (!lightsChunk.includes(SKIP_DARK)) THREE.ShaderChunk.lights_fragment_begin = lightsChunk.replaceAll(RE_DIRECT, SKIP_DARK);

export class CrashEngine extends EngineInput {
  /** Resolves when `warmPrograms` is done (a failure is logged): the loop simulates and draws only after it, so play never links a program. */
  readonly ready: Promise<void>;
  /** Netplay (docs/MULTIPLAYER.md): a client draws host snapshots instead of simulating. */
  readonly net = new NetPlay({
    cars: () => this.live(),
    // The host's field size. Race and derby own their field (they seat peers at their next start), and a
    // client takes the host's cars without the sandbox reset.
    setCarCount: (n) => (this.race.active || this.derbyMode || this.net.client ? this.ensureCars(n) : this.setCarCount(n)),
    matchCar: (i, style, cls) => this.matchCar(i, style, cls),
    setRealism: (v) => this.setRealism(v),
    phase: () => this.clock.phase,
    timeScale: () => this.clock.timeScale,
    mirrorClock: (phase, timeScale) => {
      this.clock.phase = phase;
      this.clock.timeScale = timeScale;
      this.clock.targetScale = timeScale;
    },
    race: () => (this.race.active ? this.race : null),
    enterRace: () => {
      if (this.race.active) return;
      this.setRace(true);
      this.emitHud();
    },
    exitRace: () => {
      if (!this.race.active) return;
      this.setRace(false);
      // Race unload leaves the flat track ground: back to the fleet's disc, poles and props like a host's Z.
      this.randomizeAndReset();
      this.emitHud();
    },
    startRace: () => this.raceCommand({ type: "start" }),
    setSeats: (seats) => {
      this.netSeats = seats;
      // A peer who leaves mid-match hands its car back to the AI.
      for (const i of this.derbySeated) if (!seats.has(i)) this.derbySeated.delete(i);
      if (this.race.active) this.race.setSeats(seats);
    },
    playerName: () => this.race.playerName,
    remoteDrivable: (i) => !this.derbyMode || (this.derbySeated.has(i) && !this.derby.isOut(i)),
    derbyPhase: () => (!this.derbyMode ? null : !this.derby.active ? "lobby" : this.derby.winnerId == null ? "running" : "over"),
    derbyState: () => this.derbyNetState(),
    applyDerby: (s, self) => this.applyNetDerby(s, self),
    derbyLobby: (field) => this.netDerbyMatch(false, field),
    startDerby: (field) => this.netDerbyMatch(true, field),
    setVaporized: (i, on) => this.setVaporized(i, on),
    seat: this.seat,
  });

  constructor(canvas: HTMLCanvasElement, hudStore: HudStore) {
    super();
    this.canvas = canvas;
    this.hudStore = hudStore;
    this.clock.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
    this.view = new ChaseCamera(this.camera, canvas, this.seat, this.pad.state, this.clock.reduceMotion, (x, y) =>
      this.pickCar(x, y),
    );

    this.scene.background = new THREE.Color(0x12141a);
    this.scene.fog = new THREE.FogExp2(0x12141a, 0.008);
    const env = this.attachStudioEnv();

    this.buildWorld();
    this.arena = makeDerbyArena();
    this.scene.add(this.arena);
    this.winnerSpot = new WinnerSpot(this.scene, makePoolTexture());
    this.barrier = new JerseyBarrier(this.scene, makeJerseyBarrier());
    this.press = new CompactorPress(this.scene, this.compactor.face);
    this.pistonBank = new PistonBank(this.scene, this.pistons);
    this.doorRam = new DoorRam(this.scene);

    this.glassDots = new GlassDotSystem(this.scene);
    this.ensureCars(2);
    this.scene.add(this.wheels.mesh, ...this.lampBatch.meshes);
    // After the renderer's scene matrix update, before culling/upload: every render path draws current wheels and lamps.
    this.scene.onBeforeRender = () => {
      const live = this.live();
      this.wheels.sync(live);
      this.lampBatch.sync(live);
    };

    this.debris = new DebrisSystem(this.scene);
    this.sparks = new SparkSystem(this.scene);
    this.smoke = new TireSmokeSystem(this.scene);
    this.ragdolls = new RagdollSystem(this.scene, (i) => this.onThrow(i));
    this.cine = new Cinematics(this.renderer, this.scene, this.view, { sparks: this.sparks, glass: this.glassDots }, MAX_CARS, this.clock.reduceMotion);
    // `?fx=off|low|high` picks the starting tier (bench A/B); the HUD default otherwise.
    const fxParam = new URLSearchParams(window.location.search).get("fx");
    this.cine.setTier(FX_TIERS.find((t) => t === fxParam) ?? INITIAL_HUD.fxTier);
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
    // Four body lamps per car plus at most one lit siren (police flash red, then blue).
    this.lampLights = new LampLights(this.scene, MAX_CARS * 5);
    this.race = new RaceDirector({
      scene: this.scene,
      camera: this.camera,
      sun: this.sun,
      seat: this.seat,
      live: () => this.live(),
      setCarCount: (n) => this.ensureCars(n),
      setPolice: (from, count) => this.setPolice(from, count),
      dress: (car) => this.dressCar(car),
      setPaused: (on) => {
        this.playing = !on;
        this.emitHud();
      },
      leave: () => this.toggleRace(),
      hitFx: (contact, normal, impulse) => {
        if (this.elapsedWall - this.sparkAt < 0.12) return;
        this.sparkAt = this.elapsedWall;
        this.sparks.poof(contact, normal, Math.min(56, 12 + impulse * 1.2) * this.fxDensity);
        if (impulse > 6) this.debris.burst(contact, normal, Math.min(40, impulse * 1.5) * this.fxDensity);
      },
      buildArt: (track, placed) => {
        this.queueWarm();
        this.ragdolls.course = track;
        return new TrackArt(track, placed);
      },
      markBounds: (minX, minZ, maxX, maxZ) => this.cine.marks.setBounds(minX, minZ, maxX, maxZ),
    });

    this.resize();
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas.parentElement ?? canvas);

    window.addEventListener("keydown", this.onKey);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    this.pad.attach(() => this.emitHud());
    this.view.attach();
    try {
      this.randomizeAndReset();
    } catch (err) {
      console.error("randomizeAndReset failed", err);
      // The window listeners above would keep calling into a half-built engine nobody can dispose.
      this.dispose();
      throw err;
    }
    (window as unknown as { __crush?: CrashEngine }).__crush = this;
    this.emitHud();
    this.ready = this.warmPrograms(env)
      .catch((err: unknown) => console.error("Crush Stream program warm-up failed", err))
      .then(() => {
        this.warming = false;
        // Only a throw needs Rapier, so boot never waits for it: it loads in the background from here, and a car
        // disabled before it is in simply throws nobody (`EjectionWatch` only judges edges it saw).
        this.ragdolls.preload().catch((err: unknown) => console.error("Crush Stream ragdoll load failed", err));
      });
  }

  /**
   * The loop runs from here, but until `ready` it only reads input (keys, pad, the seat's follow → drive), so a
   * press during the warm-up still counts; it simulates and draws once every program is linked.
   */
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
    this.lampBatch.dispose();
    this.sparks.dispose();
    this.debris.dispose();
    this.cine.dispose();
    this.glassDots.dispose();
    this.smoke.dispose();
    this.ragdolls.dispose();
    this.lampLights.dispose();
    this.audio.dispose();
    this.envMap?.dispose();
    this.envMap = null;
    this.scene.environment = null;
    // Props, arena, barrier and track art have no dispose of their own: free whatever the scene still holds.
    this.scene.traverse((o) => {
      if (!(o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.Line)) return;
      o.geometry.dispose();
      for (const m of [o.material].flat() as THREE.Material[]) m.dispose();
    });
    this.scene.clear();
    const g = window as unknown as { __crush?: CrashEngine };
    if (g.__crush === this) delete g.__crush;
    const gl = this.renderer.getContext();
    this.renderer.dispose();
    gl.getExtension("WEBGL_lose_context")?.loseContext();
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
    if (this.warming) return;

    if (this.playing) {
      this.elapsedWall += wallDt;
      // A netplay client mirrors the host's phase and slow-mo (`net.frame`) instead of running its own.
      if (!this.net.client) this.maybePreSlowmo(wallDt);
      easeTimeScale(this.clock, wallDt);
      const simDt = wallDt * this.clock.timeScale * this.cine.timeWarp;
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
          if (this.clock.wallSinceImpact > 0.2 && car.crashed) bleedAfterSlide(car, h);
        }
        steps++;
        if (steps >= 2 && performance.now() > budget) break;
      }
      this.stepEdge();
      this.scheduleSkins(cars);
      for (const car of cars) {
        if (this.net.client) break;
        if (this.rigScene && car !== this.carA) continue;
        car.updateDeform(simDt);
      }
      if (!this.net.client) this.updatePhase(wallDt);
      if (this.showPistons && this.looping) this.stepPistonLoop(wallDt);
      if (this.clock.phase !== "approach") this.emitContactFx();
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
      const sandbox = !this.race.active && !this.derbyMode;
      this.ragdolls.update(simDt, cars, !this.net.client, sandbox, this.derbyMode ? this.derbyR : 0, this.showBarrier ? this.barrier.group : null);
      for (let i = 0; i < cars.length; i++) {
        const car = cars[i]!;
        if (!car.deform.drivetrainAlive) {
          this.deadSmokeAcc[i] = (this.deadSmokeAcc[i] ?? 0) + wallDt;
          if (this.deadSmokeAcc[i]! > 0.14) {
            this.deadSmokeAcc[i] = 0;
            this.puffDeadEngine(car);
          }
        } else if (this.elapsedWall < (this.smokeUntil[i] ?? 0)) {
          // 60 puffs per wall second whatever the refresh rate (it was one per rendered frame).
          this.deadSmokeAcc[i] = (this.deadSmokeAcc[i] ?? 0) + wallDt;
          for (; this.deadSmokeAcc[i]! >= 1 / 60; this.deadSmokeAcc[i]! -= 1 / 60) this.puffEngine(car);
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

    // Paused or not: a paused host keeps serving its (frozen) world, so clients never think it is gone.
    this.net.frame(wallDt);
    if (this.race.active) this.race.frame(this.playing ? wallDt : 0);
    this.updateCamera(wallDt);
    this.flushVisibleSkins();
    this.cullFarDetail();
    this.lampLights.update(this.live(), this.camera, this.followedCar());
    if (this.stage.night) this.stage.syncPools(this.poles);
    this.cine.render(this.scene, this.camera, wallDt);

    this.hudAcc += wallDt;
    if (this.hudAcc > (this.clock.timeScale < 0.5 ? 0.05 : 0.12)) {
      this.hudAcc = 0;
      this.emitHud();
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

  /**
   * Distance detail (`DETAIL_NEAR`): a far car's small non-shadow-casting parts leave the camera's layer 0, so
   * `visible` stays the car's own (broken lamps, loose parts); they rejoin when it comes back within `DETAIL_BACK`.
   */
  private cullFarDetail(): void {
    _v.setFromMatrixPosition(this.camera.matrixWorld);
    const followed = this.followedCar();
    for (const car of this.cars) {
      const off = this.farDetail.get(car);
      const far = car !== followed && car.group.position.distanceToSquared(_v) > (off ? DETAIL_BACK : DETAIL_NEAR) ** 2;
      if (far === (off !== undefined)) continue;
      if (off) {
        for (const o of off) o.layers.enable(0);
        this.farDetail.delete(car);
        continue;
      }
      const parts: THREE.Object3D[] = [];
      car.group.traverse((o) => {
        const m = o as THREE.Mesh;
        // A lamp seat is drawn by the lamp batch, which skips a seat off layer 0.
        if (o.name !== "lamp" && (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || m.castShadow || m.name === "interior")) return;
        m.layers.disable(0);
        parts.push(m);
      });
      this.farDetail.set(car, parts);
    }
  }


  private maybePreSlowmo(wallDt: number): void {
    if (this.derbyMode || this.race.active) return;
    if (this.clock.userTimeScale != null) return;
    if (!this.autoSlomo) return;
    if (this.rigScene) return;
    if (this.clock.phase !== "approach") return;
    const scale = impactScale(this.clock);
    if (this.clock.timeScale <= scale * 1.2) return;
    const eta = this.contactEta();
    if (!Number.isFinite(eta)) return;
    if (eta > Math.max(PRE_IMPACT_LEAD, wallDt + FIXED)) return;
    this.clock.timeScale = scale;
    this.clock.targetScale = scale;
  }


  private fixedStep(dt: number): void {
    const cars = this.live();
    // Race: every car (the player too) is driven through its controller slot by the director.
    if (this.race.active) this.race.drive(dt);
    const driven = this.seat.mode === "drive" && !this.race.active ? this.seat.carIndex : -1;
    if (driven >= 0 && driven < cars.length) {
      const car = cars[driven]!;
      if (car.deform.drivetrainAlive && !(this.derbyMode && this.derby.isOut(driven))) applyDrive(car, this.seat.input(car, dt), dt);
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
        if (i === driven || this.derbySeated.has(i)) continue;
        applyDrive(cars[i]!, this.derby.think(snaps[i]!, snaps, dt), dt);
      }
    }
    const w = this.world;
    w.cars = cars;
    w.barrier = this.showBarrier ? this.barrier : null;
    w.barrierHits = this.barrierHits;
    w.bounce = this.bounceWorld;
    w.beforeSlice = this.rigScene ? this.rigSlice : null;
    w.pairHit = this.derbyMode ? this.derbyHit : null;
    w.ballHit = this.showBalls ? this.ballHit : null;
    w.poleHit = this.derbyMode || this.race.active ? null : this.poleHit;
    w.afterCar = this.derbyMode ? this.clipDerby : null;
    w.collide = this.race.active ? this.raceCollide : null;
    stepWorld(w, dt);
    if (this.race.active) this.race.step(dt);

    const { impulse, contact, normal } = w.strongest;
    if (!this.derbyMode && !this.race.active && this.clock.phase === "approach" && contact && normal && impulse > 0.4) {
      this.beginCinematic(contact, normal, impulse);
    } else if ((this.derbyMode || this.race.active) && contact && normal && impulse > 1.2 && this.elapsedWall - this.sparkAt > 0.16) {
      this.sparkAt = this.elapsedWall;
      this.sparks.poof(contact, normal, Math.min(56, 18 + impulse * 0.8) * this.fxDensity);
    }
  }


  private emitContactFx(): void {
    if (this.clock.phase === "approach" || this.fxPoofed) return;
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


  private updatePhase(wallDt: number): void {
    if (this.derbyMode || this.race.active) return;
    const settled = this.clock.phase === "aftermath";
    stepPhase(this.clock, wallDt);
    // A thrown range driver holds the loop until his landing has been shown (`RangeRun`); otherwise it runs as the fleet's.
    const still = this.showRange ? this.ragdolls.latest(_v) : -1;
    const shown = this.showRange && this.rangeRun.step(still, _v.x, wallDt);
    if (this.looping && (shown || (still < 0 && settled && !this.showPistons && this.clock.wallSinceImpact > (this.showCompactor ? 14 : 10.4)))) this.randomizeAndReset();
  }

  /** `aimRigs`'s derby centroid set, refilled per frame. */
  private readonly aliveBuf: DeformableCar[] = [];

  /** What the trackside and dutch cams read, only when they pick a shot: the scene's solids and the rival racers. */
  private readonly specScene: SpecScene = {
    sight: () => this.spectateSight(),
    rivals: () => (this.race.active ? this.live().slice(0, this.race.racers.length) : this.live()),
  };

  /** The course's (or the sandbox's) solids plus every other car where it stands now. */
  private spectateSight(): Sight {
    const course = this.race.active ? this.race.courseSight() : null;
    const occ: Occluder[] = course ? [...course.occ] : [];
    const followed = this.followedCar();
    for (const c of this.live()) {
      if (c === followed || c.vaporized || !c.group.visible) continue;
      const p = c.group.position;
      occ.push(occluder(p.x, p.z, 0, CAR_HALF.z, CAR_HALF.z, true, p.y - 0.3, p.y + 1.6));
    }
    if (course) return { ...course, occ };
    for (const pole of this.poles) {
      if (pole.intact && pole.group.visible) occ.push(occluder(pole.group.position.x, pole.group.position.z, 0, 0.45, 0.45, true, 0, 5.3));
    }
    if (this.showBarrier) {
      const b = this.barrier.group.position;
      occ.push(occluder(b.x, b.z, this.barrier.yaw, BARRIER_HALF.x, BARRIER_HALF.z, false, 0, 0.9));
    }
    if (this.showBalls) {
      for (const ball of this.balls) {
        const b = ball.mesh.position;
        if (ball.mesh.visible) occ.push(occluder(b.x, b.z, 0, ball.radius, ball.radius, true, b.y - ball.radius, b.y + ball.radius));
      }
    }
    return { ground: activeGround(), path: null, wallTop: 0, rim: this.derbyMode ? this.derbyR : Infinity, occ };
  }

  /**
   * A sandbox driver left car i (`RagdollSystem` never calls this in a race or a derby): the camera rides with the
   * thrown drivers unless it follows another car or the user framed it. The clock is the hit's: its slow-mo, the
   * letterbox and the post effects run on under the ride (`aimRigs`).
   */
  private onThrow(i: number): void {
    const followed = this.followedCar();
    if (this.view.userFramed || (followed && followed !== this.cars[i])) return;
    this.ragdolls.follow();
  }

  /** The rigs' shot, then the rear-view hold over it (undone before the next frame's rigs, so they never see it). */
  private updateCamera(wallDt: number): void {
    this.view.unflip();
    this.aimRigs(wallDt);
    const back = this.view.rear ? this.followedCar() : null;
    if (back?.group.visible) this.view.lookBack(back);
  }

  private aimRigs(wallDt: number): void {
    // The crash cam steps first, so its letterbox runs on under a ride-along, which then takes the camera itself
    // (the cut's position, and its lens: the ride keeps the one it started with).
    const fov = this.camera.fov;
    const cut = this.cine.direct(this.camera, wallDt, !this.view.userFramed && this.seat.mode !== "drive");
    if (this.ragdolls.frameCamera(this.camera, wallDt, this.showRange)) {
      if (this.camera.fov !== fov) {
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();
      }
      return;
    }
    if (cut) return;
    const followed = this.followedCar();
    // Off the disc's rim (from the first centimetre of drop): the eye settles on the rim at shoulder height and keeps
    // the falling car centred, then holds once it vaporizes.
    const fp = followed?.group.position;
    if (followed && fp && (followed.falling || followed.vaporized || (fp.y < -0.01 && activeGround().heightAt(fp.x, fp.z, fp.y) === NO_FLOOR))) {
      this.view.watchFall(followed, wallDt, followed.vaporized);
      return;
    }
    if (followed && followed.group.visible && this.seat.mode === "drive") {
      this.view.frameDrive(followed, wallDt, this.playing);
      return;
    }
    // Following (spectating) off the rigs: the chosen spectator cam; the orbit falls through.
    if (this.seat.mode === "global") this.view.spec = null;
    const spec = this.view.specView(this.race.chase);
    if (followed && followed.group.visible && !this.rigScene && this.view.frameSpectate(followed, spec, this.specScene, wallDt, this.playing)) return;
    const look = this.view.look;
    if (followed && followed.group.visible) {
      // Over the car's own height: a race course climbs hills and bridges.
      look.set(followed.group.position.x, followed.group.position.y + 0.7, followed.group.position.z);
    } else if (this.rigScene) {
      look.set(this.carA.group.position.x, 0.55, this.carA.group.position.z);
    } else if (this.derbyMode && this.derby.winnerId != null) {
      const champ = this.cars[this.derby.winnerId];
      if (champ) look.set(champ.group.position.x, 0.7, champ.group.position.z);
    } else if (this.derbyMode) {
      const alive = this.aliveBuf;
      alive.length = 0;
      for (const c of this.live()) if (c.deform.drivetrainAlive) alive.push(c);
      centroid(_v, alive.length ? alive : this.live());
      look.set(_v.x, 0.7, _v.z);
    } else {
      centroid(_v, this.live());
      look.set(_v.x, 0.7, _v.z);
    }

    let spinRate = 0;
    if (this.autoRotate && this.playing && this.seat.mode !== "drive") {
      spinRate = this.showPistons ? PISTON_ORBIT_RATE : this.clock.phase === "approach" ? 0.12 : 0.32;
    }
    this.view.orbit(wallDt, spinRate, this.playing);
  }

}
