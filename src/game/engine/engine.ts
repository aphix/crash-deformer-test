// First: every quaternion built from here on, constants at load included, takes the engine-identical trig (kernel/three-trig.ts).
import "../kernel/three-trig.ts";
import * as THREE from "three";
import { DeformableCar } from "../vehicle/car.ts";
import { PISTON_ORBIT_RATE, PistonBank } from "../present/engine-pistons.ts";
import { DoorRam } from "../present/engine-doors.ts";
import { sliceSpeed } from "../contact/sat.ts";
import { PACE_BUDGET_MS, SimPacer } from "./sim-pace.ts";
import { PoseBlend } from "../present/pose-blend.ts";
import { INITIAL_HUD, type HudStore } from "../hud/hud-store.ts";
import { easeTimeScale, PRE_IMPACT_LEAD, preImpact, stepPhase } from "../match/phase.ts";
import { settleStep, stepWorld } from "./world-step.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { damageStage } from "../vehicle/vehicle-classes.ts";
import { makeJerseyBarrier, makePoolTexture } from "../present/engine-world.ts";
import { Cinematics } from "../present/engine-cine.ts";
import { FX_TIERS } from "../present/engine-post.ts";
import { AutoFx, hardwareDesktop } from "../present/auto-fx.ts";
import { PHONE_LEVEL } from "../present/car-detail.ts";
import { DetailGovernor } from "../present/detail-governor.ts";
import { sortByDrawClass } from "../present/draw-order.ts";
import { DebrisSystem, SparkSystem, GlassDotSystem, TireSmokeSystem, CrashAudio } from "../present/engine-fx.ts";
import { FX_REACH } from "../present/witness.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import { throwComing } from "../present/ragdoll-trigger.ts";
import { ChaseCamera, centroid, type SpecScene } from "../present/engine-camera.ts";
import { activeGround, NO_FLOOR } from "../world/ground.ts";
import { armTops } from "../world/surfaces.ts";
import { CompactorPress, JerseyBarrier } from "../scenes/engine-props.ts";
import { FleetRamps } from "../scenes/fleet-ramps.ts";
import { Corkscrew } from "../scenes/corkscrew.ts";
import { TraceRecorder } from "./engine-trace.ts";
import { snapshotAiCar } from "../match/derby.ts";
import { FULL_POOL, LampLights, PHONE_POOL } from "../vehicle/lamp-lights.ts";
import { applyDrive } from "../vehicle/car-drive.ts";
import { makeDerbyArena, WinnerSpot } from "../scenes/derby-arena.ts";
import { NetPlay } from "../net/net-play.ts";
import { RaceDirector } from "./engine-race.ts";
import { ReelDirector } from "./engine-highlights.ts";
import { TrackArt } from "../present/track-art.ts";
import { EngineGarage } from "./engine-garage.ts";
import { GARAGE } from "../present/garage-art.ts";
import { detSin, detCos } from "../kernel/physics-core.js";

const FIXED = 1 / 60;
/** Deform LoD: sphere around a car — rest half-diagonal 2.5 m plus crumple slack and the
 *  ≈0.9 m the sun throws the roof's shadow, so an off-screen car's shadow is never stale either. */
const LOD_RADIUS = 3.5;
/** Projected sphere radius (CSS px) below which a car skins every 2nd / every 4th frame. */
const LOD_SMALL_PX = 40;
const LOD_TINY_PX = 20;
const _lodCenter = new THREE.Vector3();
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

/** The page's renderer: sRGB out, ACES at the game's exposure, PCF shadows, MSAA only at device pixel ratio 1. */
function makeRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: (window.devicePixelRatio || 1) <= 1,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setClearColor(0x12141a, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.45;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setOpaqueSort(sortByDrawClass);
  return renderer;
}

export class CrashEngine extends EngineGarage {
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
    hostFit: () => this.autoFx.canHost(),
    remoteDrivable: (i) => !this.derbyMode || (this.derbySeated.has(i) && !this.derby.held(i)),
    derbyPhase: () => (!this.derbyMode ? null : !this.derby.active ? "lobby" : this.derby.winnerId == null ? "running" : "over"),
    derbyState: () => this.derbyNetState(),
    applyDerby: (s, self) => this.applyNetDerby(s, self),
    derbyLobby: (field) => this.netDerbyMatch(false, field),
    startDerby: (field) => this.netDerbyMatch(true, field),
    setVaporized: (i, on) => this.setVaporized(i, on),
    clearGen: () => this.clearGen(),
    clearScene: () => this.clearLocal(),
    playReel: (reel, startAt) => this.highlights.play(reel, startAt),
    reelPlaying: () => this.highlights.playing,
    launchEjection: (e) => this.ragdolls.launch(e, this.live()),
    meterOf: (i) => this.meterOf(i),
    playerLook: () => this.playerLook(),
    wearLook: (i, look) => this.wearLook(i, look),
    dropLooks: () => this.dropLooks(),
    seat: this.seat,
  });
  /** The results reel and its solo view (docs/HIGHLIGHTS.md). */
  protected readonly highlights: ReelDirector;
  /** The sim's steps against the frames (`SimPacer`), and the cars drawn between the last two (`PoseBlend`). */
  readonly pace = new SimPacer(true);
  private readonly blend = new PoseBlend();
  /** One sim step of the frame (`SimPacer.run`): the cars' poses either side of it kept for the blend. */
  private readonly slice = (h: number): void => {
    const cars = this.live();
    this.blend.begin(cars);
    this.fixedStep(h);
    this.elapsedSim += h;
    settleStep(cars, h, this.clock.wallSinceImpact > 0.2);
    this.blend.end(cars);
  };
  private readonly hitFx = (contact: THREE.Vector3, normal: THREE.Vector3, impulse: number): void => {
    if (this.elapsedWall - this.sparkAt < 0.12 || !this.witness.sees(contact, FX_REACH.debris)) return;
    this.sparkAt = this.elapsedWall;
    this.sparks.poof(contact, normal, Math.min(56, 12 + impulse * 1.2) * this.fxDensity);
    if (impulse > 6) this.debris.burst(contact, normal, Math.min(40, impulse * 1.5) * this.fxDensity);
  };

  constructor(canvas: HTMLCanvasElement, hudStore: HudStore, veil: HTMLElement) {
    super();
    this.canvas = canvas;
    this.veil = veil;
    this.hudStore = hudStore;
    this.clock.reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.lab.load("cards");
    this.lab.fx = this.hitFx;

    this.renderer = makeRenderer(canvas);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 180);
    this.view = new ChaseCamera(this.camera, canvas, this.seat, this.pad.state, this.clock.reduceMotion, (x, y) =>
      this.pickCar(x, y),
    );

    this.scene.background = new THREE.Color(0x12141a);
    this.scene.fog = new THREE.FogExp2(0x12141a, 0.008);
    const env = this.attachStudioEnv();

    this.buildWorld();
    this.view.posts = this.poles;
    this.arena = makeDerbyArena();
    this.scene.add(this.arena);
    this.winnerSpot = new WinnerSpot(this.scene, makePoolTexture());
    this.barrier = new JerseyBarrier(this.scene, makeJerseyBarrier());
    this.ramps = new FleetRamps(this.scene);
    this.corkscrew = new Corkscrew(this.scene);
    this.press = new CompactorPress(this.scene, this.compactor.face);
    this.pistonBank = new PistonBank(this.scene, this.pistons);
    this.doorRam = new DoorRam(this.scene);

    this.glassDots = new GlassDotSystem(this.scene);
    this.ensureCars(INITIAL_HUD.carCount);
    this.scene.add(...this.wheels.meshes, ...this.lampBatch.meshes);
    // After the renderer's scene matrix update, before culling/upload: every render path draws current wheels and lamps.
    this.scene.onBeforeRender = (renderer) => {
      const live = this.live();
      this.wheels.sync(live, renderer);
      this.lampBatch.sync(live);
    };

    this.debris = new DebrisSystem(this.scene);
    this.sparks = new SparkSystem(this.scene);
    this.smoke = new TireSmokeSystem(this.scene);
    this.ragdolls = new RagdollSystem(this.scene, (i) => this.onThrow(i), (at, frame, inherit) => this.onExit(at, frame, inherit));
    this.ragdolls.poles = this.poles;
    this.ragdolls.lookOf = (car) => this.looks.of(car, this.ownCar());
    this.lab.dolls = this.ragdolls;
    this.cine = new Cinematics(this.renderer, this.scene, this.view, { sparks: this.sparks, glass: this.glassDots, witness: this.witness }, MAX_CARS, this.clock.reduceMotion);
    // `?fx=off|minimal|low|high|ultra` picks the tier for the session (bench A/B); the auto tier otherwise. Ultra loads after boot (below).
    const fxParam = FX_TIERS.find((t) => t === new URLSearchParams(window.location.search).get("fx"));
    this.cine.setTier(fxParam === "ultra" ? "high" : (fxParam ?? INITIAL_HUD.fxTier));
    const gl = this.renderer.getContext();
    const gpu = gl.getExtension("WEBGL_debug_renderer_info");
    const desktop = hardwareDesktop(gpu ? String(gl.getParameter(gpu.UNMASKED_RENDERER_WEBGL)) : null, window.matchMedia("(pointer: fine)").matches);
    this.autoFx = new AutoFx(desktop, fxParam === undefined);
    // A phone starts on the nearer rung (a ~20 px car loses nothing the eye can use); the governor walks either way from the first match.
    this.detailGov = new DetailGovernor(desktop ? 0 : PHONE_LEVEL);
    this.detail.setLevel(this.detailGov.level);
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
    // Four body lamps per car plus at most one lit siren (police flash red, then blue). `?lamps=lean` trims a phone's pool to 2 spots
    // + 2 points (about 0.5 ms a frame at 4x CPU; at night the second-nearest car loses its tail wash). Fixed here, before the programs
    // link: a light-count change relinks every lit shader.
    const leanLamps = !desktop && new URLSearchParams(window.location.search).get("lamps") === "lean";
    this.lampLights = new LampLights(this.scene, MAX_CARS * 5, leanLamps ? PHONE_POOL : FULL_POOL);
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
      leave: () => this.setScene("fleet"),
      watchCam: () => void (this.view.spec = "auto"),
      hitFx: this.hitFx,
      knockProp: (index, car, vx, vy, vz) => this.ragdolls.knockProp(index, car, vx, vy, vz),
      buildArt: (track, placed) => {
        this.queueWarm();
        const art = new TrackArt(track, placed, this.stage);
        this.ragdolls.setCourse(track, placed, art.props);
        return art;
      },
      markBounds: (minX, minZ, maxX, maxZ) => this.cine.marks.setBounds(minX, minZ, maxX, maxZ),
      // tickInner's wreck-slide rule (`bleedAfterSlide` once the crash clock is past the hit).
      bleeds: () => this.clock.wallSinceImpact > 0.2,
      reelReady: (clips, since) => this.startReel(clips, since),
      clear: () => this.clearScene(),
      heardMeter: (i) => this.net.heard(i),
    });
    this.highlights = new ReelDirector({
      carsOf: (clip) => clip.cars.map((c) => this.cars[c.slot]!),
      live: () => this.live(),
      scene: { dress: (car) => this.dressCar(car), collide: (car, slot, h) => this.race.courseHit(car, slot, h), restore: (slot, mem, at) => this.race.remember(slot, mem, at), knocks: (bits) => this.race.knockTo(bits), bounce: this.bounceWorld, blend: this.blend },
      resetProps: () => this.race.resetProps(),
      clear: () => this.clearLocal(),
      sight: (focus) => this.sceneSight(focus, true),
      still: () => this.sceneSight(null, false),
      clock: this.clock,
      impact: (contact, normal, closing) => this.beginCinematic(contact, normal, closing, true),
      hit: this.hitFx,
      eject: (e, ride) => { this.ragdolls.launch(e, this.live(), ride); if (ride) this.ragdolls.follow(); },
      ride: (camera, wallDt, subject) => this.ragdolls.rideAlong && this.ragdolls.frameCamera(camera, wallDt, false, this.cars.indexOf(subject), false, this.view.lens, () => this.sceneSight(subject, true)) !== "none",
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
      // Applies the page's `#` as this first reset, so the first run already uses it.
      this.attachShare();
    } catch (err) {
      console.error("first reset failed", err);
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
        if (fxParam === "ultra") this.setFxTier("ultra");
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
    this.mouseLook.exit();
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("keydown", this.onKey);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.pad.detach();
    this.detachShare();
    this.net.leave();
    this.view.detach();
    this.resizeObs.disconnect();
    for (const car of this.cars) car.dispose();
    this.race.dispose();
    this.labArt?.dispose();
    this.garage?.dispose();
    this.looks.dispose();
    this.wheels.dispose();
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
      this.blend.restore();
    }
  };

  protected tickInner(now: number): void {
    if (this.disposed) return;
    const t0 = performance.now();
    // The first rAF stamp can predate `start()`'s performance.now(): a negative dt froze the sim for seconds.
    const wallDt = Math.min(Math.max(0, (now - this.last) / 1000), 0.1);
    this.last = now;
    if (wallDt > 1e-4) {
      const inst = 1 / wallDt;
      this.fps = this.fps > 1 ? this.fps * 0.85 + inst * 0.15 : inst;
    }
    this.pollInput(wallDt);
    if (this.warming) return;
    this.stepSceneFade(wallDt);
    this.fxFrame(wallDt, this.pace.lost);
    // The new scene's sim waits behind the transition's black (a slow first-use warm-up would play its opening unseen).
    // Local presentation only: a netplay session or the results replay owns time, so they never wait.
    const held = this.sceneFade.holding && this.net.role === "off" && !this.highlights.playing;

    // The results reel lives until its race is left or the next one sets up (a client's host may start it). Not "until
    // the phase leaves finished": a client's race state comes 5 times a second, unreliably, so the host's reel (reliable,
    // sent at the finish) can land while it still reads "racing" (measured: stopped 106 ms after it arrived).
    const p = this.race.phase;
    if (this.highlights.hasReel && (!this.race.active || p === null || p === "grid" || p === "countdown")) this.stopReel();
    if (this.playing && !held) {
      this.elapsedWall += wallDt;
      const reelDt = this.highlights.frame(now / 1000);
      this.reelFrame(reelDt !== null);
      const cars = this.live();
      let simDt: number;
      if (reelDt !== null) simDt = reelDt;
      else {
        // A netplay client mirrors the host's phase and slow-mo (`net.frame`) instead of running its own.
        if (!this.net.client) this.maybePreSlowmo(wallDt);
        easeTimeScale(this.clock, wallDt);
        simDt = wallDt * this.clock.timeScale * this.cine.timeWarp;
        if (!this.net.client) this.pace.run(simDt, this.clock.timeScale * this.cine.timeWarp, sliceSpeed(cars), performance.now() + PACE_BUDGET_MS, this.slice);
      }
      this.stepEdge();
      this.scheduleSkins(cars);
      // A client draws the host's skins; the reel's replay (a client's too) skins its own cars, the hidden ones wait.
      if (reelDt !== null || !this.net.client) {
        for (let i = 0; i < cars.length; i++) {
          const car = cars[i]!;
          if (reelDt !== null || this.showStack ? car.group.visible : !this.rigScene || car === this.carA) car.updateSkin();
        }
      }
      if (reelDt === null && !this.net.client) this.updatePhase(wallDt);
      if (this.showStack) this.stepStack(); else if (this.showPistons && this.looping) this.stepPistonLoop(wallDt);
      if (reelDt === null && this.clock.phase !== "approach") this.emitContactFx();
      if (this.impactLightLife > 0) {
        this.impactLightLife -= wallDt;
        this.impactLight.intensity = Math.max(0, this.impactLightLife * 90);
      }
      this.view.trauma = Math.max(0, this.view.trauma - wallDt * 1.6);
      if (this.barrierUp) this.barrier.step(simDt);
      // Debris, sparks, glass and smoke run on the world's own time (the replay's presented clip time, or the slow-mo scaled frame), so they slow with it.
      const fxDt = simDt;
      // The bits land on the ground and the cars' tops of the world this frame stepped, the replay's while a clip plays (`landOn`).
      armTops(this.highlights.surfaces ?? this.world.surfaces);
      this.debris.update(fxDt, this.bounceWorld);
      this.sparks.update(fxDt, this.bounceWorld);
      this.glassDots.update(fxDt, this.bounceWorld);
      armTops(null);
      this.smoke.update(fxDt, this.camera);
      const sandbox = !this.race.active && !this.derbyMode;
      // Who the drivers look like: the clip on screen's race, else this race's, this derby round's, or this run's scene seed.
      this.ragdolls.lookSeed = this.highlights.look ?? (this.race.active ? this.race.look : this.derbyMode ? this.derbyRound : this.sceneSeed);
      this.ragdolls.update(simDt, cars, !this.net.client, sandbox, this.derbyMode ? this.derbyR : 0, this.barrierUp ? this.barrier.group : null);
      for (let i = 0; i < cars.length; i++) {
        const car = cars[i]!;
        if (reelDt !== null && !car.group.visible) continue;
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
      if (this.trace.due(wallDt, this.captureTrace)) this.trace.sample(this.traceSetup(), cars, this.traceClock());
      this.stepDerby(simDt);
      this.seat.step(simDt);
      this.cine.update(wallDt, simDt, cars, this.followedCar(), this.seat.mode === "drive", this.fxDensity);
      if (this.derbyMode) {
        const boosts = this.derby.consumeBoosts();
        for (let k = 0; k < boosts.length; k++) this.takedownBoost(boosts[k]!);
      }
    }

    // Paused or not: a paused host keeps serving its (frozen) world, so clients never think it is gone.
    this.net.frame(wallDt);
    // The reel's replay presents its own steps through the same blend (`ClipSim.present`, before the skins above): the world's pace has no step to show.
    if (!this.highlights.playing) this.blend.present(this.live(), this.pace.alpha);
    if (this.race.active) this.race.frame(this.playing && !held ? wallDt : 0);
    const focus = this.highlights.playing ? this.highlights.focus() : null;
    if (focus) this.race.followSun(focus);
    this.updateCamera(wallDt);
    this.flushVisibleSkins();
    this.detail.update(this.cars, this.camera, this.followedCar(), this.highlights.playing ? this.highlights.focus() : null);
    this.lampLights.update(this.live(), this.camera, this.followedCar());
    if (this.stage.night) this.stage.syncPools(this.poles);
    if (!this.skipDraw) this.cine.render(this.scene, this.camera, wallDt);
    this.blend.restore();
    this.hudAcc += wallDt;
    if (this.hudAcc > (this.clock.timeScale < 0.5 ? 0.05 : 0.12)) {
      this.hudAcc = 0;
      this.emitHud();
    }
    this.workMs = performance.now() - t0;
  }

  /**
   * Deform LoD. Skinning (+ normals) is the per-vertex cost, so a car outside the view frustum
   * defers it and a small one skins every 2nd / 4th frame; the cage/shape solve always runs.
   * Deferred cars carry `skinOwed`, which `flushVisibleSkins` settles once the camera has moved,
   * so no car is ever drawn on-screen with a dent it has not been given. The followed car always skins.
   */
  private scheduleSkins(cars: DeformableCar[]): void {
    this.witness.aim(this.camera);
    this.lodFrame++;
    const followed = this.followedCar();
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      const stride = car === followed ? 1 : this.skinStride(car);
      this.lodStride[i] = stride;
      car.deform.skinDeferred = stride === 0 || (this.lodFrame + i) % stride !== 0;
    }
  }

  /**
   * After the camera update: any owed car now on screen at full rate, or just entering the view, skins before it draws.
   * Always reads the final camera into `witness`: next frame's FX spawns (decided before its rigs aim) ask that cone.
   */
  private flushVisibleSkins(): void {
    this.witness.aim(this.camera);
    const cars = this.live();
    let followed: DeformableCar | null | undefined;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      if (!car.deform.skinOwed) continue;
      if (followed === undefined) followed = this.followedCar();
      const stride = car === followed ? 1 : this.skinStride(car);
      if (stride === 1 || (stride > 1 && this.lodStride[i] === 0)) car.flushDeferredSkin();
      this.lodStride[i] = stride;
    }
  }

  /** 0 off-screen, else skin every Nth frame by projected size. Needs `witness.aim` this frame. */
  private skinStride(car: DeformableCar): number {
    _lodCenter.set(car.group.position.x, car.group.position.y + 0.6, car.group.position.z);
    if (!this.witness.mayWitness(_lodCenter, LOD_RADIUS)) return 0;
    const d = _v.setFromMatrixPosition(this.camera.matrixWorld).distanceTo(_lodCenter);
    if (d <= LOD_RADIUS) return 1;
    const halfHeightPx = (this.renderer.domElement.height / this.renderer.getPixelRatio()) * 0.5;
    const px = (LOD_RADIUS / (d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)))) * halfHeightPx;
    return px >= LOD_SMALL_PX ? 1 : px >= LOD_TINY_PX ? 2 : 4;
  }

  private maybePreSlowmo(wallDt: number): void {
    if (this.derbyMode || this.race.active || !this.autoSlomo || this.rigScene || this.clock.phase !== "approach") return;
    preImpact(this.clock, this.contactEta(), this.elapsedSim, Math.max(PRE_IMPACT_LEAD, wallDt + FIXED), FIXED, this.throwSoon);
  }

  /** Whether the coming hit will throw a driver: his exit then plays at 1× (`THROW_ONSET`). */
  private readonly throwSoon = (): boolean => throwComing(this.live(), this.barrierUp ? this.barrier : null);

  private fixedStep(dt: number): void {
    const cars = this.live();
    // Race: every car (the player too) is driven through its controller slot by the director.
    if (this.race.active) this.race.drive(dt);
    const driven = this.seat.mode === "drive" && !this.race.active ? this.seat.carIndex : -1;
    if (driven >= 0 && driven < cars.length) {
      const car = cars[driven]!;
      if (car.deform.drivetrainAlive && !(this.derbyMode && this.derby.held(driven))) applyDrive(car, this.seat.input(car, dt), dt);
      if (this.seat.selfRight(car.group.matrixWorld.elements[5]!, car.velocity.length(), dt)) this.recoverDriven();
    }
    this.net.drive(cars, dt, driven);
    if (this.derbyMode && this.derby.winnerId == null) {
      const snaps = this.derby.snapshots(cars.length);
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i]!;
        snapshotAiCar(snaps[i]!, i, c, c.deform.drivetrainAlive);
      }
      for (let i = 0; i < cars.length; i++) {
        if (i === driven || this.derbySeated.has(i)) continue;
        applyDrive(cars[i]!, this.derby.think(snaps[i]!, snaps, dt), dt);
        if (this.derby.recoverDue(i, cars[i]!, dt)) this.recoverCar(cars[i]!);
      }
    }
    const w = this.world;
    w.cars = cars;
    w.barrier = this.barrierUp ? this.barrier : null;
    w.barrierHits = this.barrierHits;
    w.bounce = this.bounceWorld;
    w.beforeSlice = this.rigScene && !this.showStack ? this.rigSlice : this.showLab ? this.lab.slice : null;
    w.pairHit = this.derbyMode ? this.derbyHit : this.race.active ? this.race.pairHit : this.showLab ? this.lab.pairHit : null;
    w.partTouch = this.race.active ? this.race.partTouch : null;
    w.ballHit = this.ballsUp ? this.ballHit : null;
    // The corkscrew hides the lamp posts its run passes through; the Lab has none.
    w.poleHit = this.derbyMode || this.race.active || this.showCorkscrew || this.showLab ? null : this.poleHit;
    w.afterCar = this.derbyMode ? this.clipDerby : null;
    // The rig scenes put the ramps away (`SCENE_PROPS`), like the slab and the balls: their faces must not stand in for
    // the corkscrew's walls (a 6 m/s car slid off the bank onto its roof) or wall in a parked car.
    w.collide = this.race.active ? this.raceCollide : this.showCorkscrew ? this.corkCollide : this.rampsUp ? this.rampCollide : this.showLab ? this.lab.collide : null;
    this.ejection.ctx = this.derbyMode ? "derby" : "default";
    w.fine = this.pace.fine;
    stepWorld(w, dt);
    // A driver thrown out this step (`EjectionWatch`): his dummy flies, the race recorder and the netplay peers hear of it.
    const ejected = this.ejection.take();
    for (let k = 0; k < ejected.length; k++) {
      const e = ejected[k]!;
      this.ragdolls.launch(e, cars);
      if (this.race.active) this.race.recorder.eject(e);
      this.net.sendEject(e);
    }
    if (this.race.active) this.race.step(dt, w.shape);

    const { impulse, contact, normal } = w.strongest;
    // The Lab's crash is its throw's first contact (`Lab.shot`): a stack settling before any throw is no crash.
    const shot = this.showLab ? this.lab.shot : null;
    if (shot && shot.contactS !== null && this.clock.phase === "approach") {
      this.beginCinematic(shot.contactAt, shot.normal, shot.speedBefore);
    } else if (!this.derbyMode && !this.race.active && !this.showStack && !this.showLab && this.clock.phase === "approach" && contact && normal && impulse > 0.4) {
      this.beginCinematic(contact, normal, impulse);
    } else if ((this.derbyMode || this.race.active) && contact && normal && impulse > 1.2 && this.elapsedWall - this.sparkAt > 0.16 && this.witness.sees(contact, FX_REACH.sparks)) {
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
    if (!contact && this.barrierUp) {
      const hi = this.barrierHits.findIndex(Boolean);
      const hitCar = hi >= 0 ? cars[hi] : null;
      if (hitCar) {
        _bp.copy(hitCar.deform.massWorld("bumperFL")).add(hitCar.deform.massWorld("bumperFR")).multiplyScalar(0.5);
        _bp.y = 0.32;
        _bn.set(detCos(this.barrier.yaw), 0, -detSin(this.barrier.yaw));
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
    // A thrown range driver holds the loop until his landing has been shown (`RangeRun`); otherwise it runs as the
    // fleet's, after any ride-along with thrown drivers. The Lab never loops: the wreckage stays until the player resets.
    const still = this.showRange ? this.ragdolls.latest(_v) : -1;
    const shown = this.showRange && this.rangeRun.step(still >= 0, this.ragdolls.latestSettled, _v.x, wallDt);
    if (this.looping && !this.showLab && !this.showGarage && (shown || (still < 0 && settled && !this.ragdolls.rideAlong && !this.showPistons && this.clock.wallSinceImpact > (this.showCompactor ? 14 : 10.4)))) this.randomizeAndReset();
  }

  /** `aimRigs`'s derby centroid set, refilled per frame. */
  private readonly aliveBuf: DeformableCar[] = [];

  /** Where the crash cam's cuts land while a ride-along holds the real camera (its bars and clock run on). */
  private readonly crashProbe = new THREE.PerspectiveCamera();

  /**
   * What the spectator cams read from the scene: the solids and the rival racers when they pick a shot, the course's own
   * solids per frame (the chase push-out); `cut` is the Auto cam's cut, where the Auto driver may hand over another car.
   */
  private readonly specScene: SpecScene = {
    sight: () => this.sceneSight(this.followedCar(), true),
    rivals: () => (this.race.active ? this.live().slice(0, this.race.racers.length) : this.live()),
    fixed: () => (this.race.active ? this.race.courseSight() : null),
    cut: (car) => {
      if (this.race.auto) this.race.autoStep(this.view.auto.cuts, true);
      return this.followedCar() ?? car;
    },
  };

  /** The rigs' shot, then the rear-view hold over it (undone before the next frame's rigs, so they never see it). */
  private updateCamera(wallDt: number): void {
    this.view.unflip();
    // The ride's end hands the camera to the rigs below it: they work on the pose they left (`unfadeRide`), and the
    // camera shown eases out of the ride's last pose into theirs, never a jump (a reel's shots are its own).
    this.ragdolls.unfadeRide(this.camera);
    this.aimRigs(wallDt);
    this.ragdolls.fadeRide(this.camera, wallDt, !this.highlights.playing);
    if (this.highlights.playing) return;
    const back = this.view.rear ? this.followedCar() : null;
    if (back?.group.visible) this.view.lookBack(back);
  }

  private aimRigs(wallDt: number): void {
    if (this.highlights.playing) {
      // The reel frames its own shots; the subject's thrown driver's ride-along takes the camera over them, the crash cam on a probe lens.
      this.reelFov ??= this.camera.fov;
      this.highlights.aim(this.camera, this.crashProbe, wallDt, this.cine);
      return;
    }
    // A thrown driver's ride-along holds the camera from his exit (the windshield shot, then the dummy), over the crash
    // cam's cuts: those keep their bars and clock on a probe lens and apply only when no driver is out. A drag hands
    // the ride to the orbit around the dummy, the ride's cuts waiting; the ride then picks up from the user's view.
    const watched = this.followedCar() ? this.seat.carIndex : -1;
    const held = this.view.rideHeld(this.ragdolls.rideAlong, wallDt);
    const ride = this.ragdolls.frameCamera(this.camera, wallDt, this.showRange, watched, held, this.view.lens, this.specScene.sight);
    this.view.frameRide(ride === "none" ? null : this.ragdolls.rideLook);
    const cut = this.cine.direct(ride === "none" ? this.camera : this.crashProbe, wallDt, !this.view.userFramed && this.seat.mode !== "drive");
    if (ride === "held") this.view.orbit(wallDt, 0, false);
    if (ride !== "none" || cut) return;
    // The Auto driver (race spectating): a camera that makes no cuts is itself the cut; the Auto cam cuts in `specScene.cut`.
    if (this.race.auto) this.race.autoStep(this.view.specView(this.race.chase) === "auto" ? this.view.auto.cuts : -1, this.view.specView(this.race.chase) !== "auto");
    const followed = this.followedCar();
    // Off the disc's rim (from the first centimetre of drop): the eye settles on the rim at shoulder height and keeps
    // the falling car centred, then holds once it vaporizes.
    const fp = followed?.group.position;
    if (followed && fp && (followed.falling || followed.vaporized || (fp.y < -0.01 && activeGround().heightAt(fp.x, fp.z, fp.y) === NO_FLOOR))) {
      this.view.watchFall(followed, wallDt, followed.vaporized);
      return;
    }
    if (followed && followed.group.visible && this.seat.mode === "drive") {
      // The body's ride reaches the chase and hood cams on every FX tier but "off" (0.0004 ms a frame), unless motion is reduced.
      this.view.drive.ride = this.cine.tier !== "off" && !this.clock.reduceMotion;
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
      look.set(this.carA.group.position.x, this.showStack ? this.stackLookY(wallDt) : 0.55, this.carA.group.position.z);
    } else if (this.derbyMode && this.derby.winnerId != null) {
      const champ = this.cars[this.derby.winnerId];
      if (champ) look.set(champ.group.position.x, 0.7, champ.group.position.z);
    } else if (this.derbyMode) {
      const alive = this.aliveBuf;
      const live = this.live();
      let n = 0;
      for (let i = 0; i < live.length; i++) if (live[i]!.deform.drivetrainAlive) alive[n++] = live[i]!;
      alive.length = n;
      centroid(_v, n ? alive : live);
      look.set(_v.x, 0.7, _v.z);
    } else if (this.showLab) {
      // A phone turned on its side (or back) gets that shape's shot, unless the user framed one.
      if (this.camera.aspect < 1 !== this.labUpright && !this.view.userFramed) this.frameLab();
      look.copy(this.labLook);
    } else if (this.showGarage) {
      look.set(GARAGE.shot.lookX, GARAGE.shot.lookY, GARAGE.shot.lookZ);
    } else {
      centroid(_v, this.live());
      look.set(_v.x, 0.7, _v.z);
    }

    // The Lab holds still for the aim, and the garage while the can is on: a turning view would turn every flick or stroke.
    let spinRate = 0;
    if (this.autoRotate && this.playing && this.seat.mode !== "drive" && !this.showLab && !(this.showGarage && this.garage?.tool.on)) {
      spinRate = this.showPistons ? PISTON_ORBIT_RATE : this.clock.phase === "approach" ? 0.12 : 0.32;
    }
    this.view.orbit(wallDt, spinRate, this.playing);
  }
}
