import * as THREE from "three";
import { idleDrive, type DriveInput, type DriverSeat } from "../vehicle/car-drive.ts";
import { CAR_HALF, type DeformableCar } from "../vehicle/car.ts";
import { blankAiCar, type AiCar } from "../ai/derby-ai.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { setGround } from "../world/ground.ts";
import { impulseCar, wallBounce, WALL_HALF_L, WALL_PROBES } from "../contact/pair-contact.ts";
import { footprintOverlap, type Overlap } from "../contact/prop-contact.ts";
import { Campaign } from "../match/campaign.ts";
import { placeProps, propColliders, type Placed, type PropCollider } from "../world/placements.ts";
import { RaceBrain } from "../ai/race-ai.ts";
import { POLICE_CAP, PoliceBrain, type CopBrain, type HunterWorld } from "../ai/police.ts";
import { HUNT, HunterBrain } from "../ai/hunter.ts";
import { fieldAggression } from "../ai/ai-aggression.ts";
import { RaceSession } from "../match/session.ts";
import { SURVIVAL, settleRun } from "../match/survival.ts";
import { loadBest, saveBest } from "./survival-store.ts";
import { DORMANT, TrafficBrain } from "../ai/traffic.ts";
import type { TrackArt } from "../present/track-art.ts";
import { raceSight, sightLine, type Sight } from "../present/spectate-cam.ts";
import { parseTrack } from "../world/track-schema.ts";
import { Track, blankProjection } from "../world/track.ts";
import { OFF_MENU, TRACKS } from "../world/tracks/index.ts";
import { HAVANA } from "../world/tracks/havana.ts";
import { carClass, classStats, HANDLING } from "../vehicle/vehicle-classes.ts";
import { DEFAULT_RACE_OPTIONS, type CarPose, type Entrant, type RaceMenu, type RaceOptions, type SurvivalHud } from "../match/types.ts";
import { CrashRecorder } from "./engine-record.ts";
import type { HighlightClip } from "../match/highlights.ts";

/** What the director needs from `CrashEngine`. */
interface RaceHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly seat: DriverSeat;
  /** Cars in play; index = car id. */
  live(): DeformableCar[];
  setCarCount(n: number): void;
  /**
   * Cars `from … from + count − 1` wear the police look; every police car below `from` goes back to
   * its fleet look (cars past the range keep theirs until a field needs them). Call before `setCarCount`.
   */
  setPolice(from: number, count: number): void;
  /** Apply the sandbox's deform settings to a freshly spawned car. */
  dress(car: DeformableCar): void;
  setPaused(on: boolean): void;
  /** Leave to the fleet (setup menu → Back; Quit or Leave in Survival). */
  leave(): void;
  /** Sparks / debris at a wall or prop hit. */
  hitFx(contact: THREE.Vector3, normal: THREE.Vector3, impulse: number): void;
  /** The course's art (null headless: rules, AI, contacts and physics run without it). */
  buildArt(track: Track, placed: readonly Placed[]): TrackArt | null;
  /** Re-target the tyre-mark map to the course's bounds (headless: nothing to draw). */
  markBounds(minX: number, minZ: number, maxX: number, maxZ: number): void;
  /** The engine's wreck-slide rule is on (`settleStep`'s `bleed`): a highlight replays with the same. */
  bleeds(): boolean;
  /** The race is over: its highlights (best first; empty when nothing ranked) for the results reel. */
  reelReady(clips: readonly HighlightClip[]): void;
  /** A run starts (start, retry, next, a campaign leg): the last run's torn parts, loose wheels, dummies and fx go (`CrashEngine.clearScene`). */
  clear(): void;
  /** A race starts with no car of ours: the spectator camera goes to Auto. */
  watchCam(): void;
}

/** Seconds upside down before a car counts as dead. */
const FLIP_DEAD = 2.5;
/** Seconds a car no human drives (a rival; a peer or this browser's driver may sit, and press R) sits still mid-race before it counts as dead (respawned). */
const STILL_DEAD = 8;
/**
 * A car the race AI drives (a rival, or the player's car while its seat isn't driving) that gains
 * less than `STALL_GAIN` m of track in `STALL_WINDOW` s (wedged on a wall, shoving a stopped car, two
 * wrecks hooked together) takes the reset a player has on R.
 */
const STALL_WINDOW = 8;
const STALL_GAIN = 25;
/** Seconds a dead traffic car stays put before the bubble puts it away. */
const TRAFFIC_DEAD = 6;
/** Where put-away traffic waits (far off every course). */
const PARK_X = 4000;
const PARK_Z = 4000;
/** A Survival drop-in must be this many metres outside the camera's view (or behind a solid): the view swings while the cop is already on the road. */
const HIDE_MARGIN = 8;
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _o: Overlap = { pen: 0, nx: 0, nz: 0, cx: 0, cz: 0 };

/**
 * Height (m) of the lowest point of `car`'s body box (`CAR_HALF` about its ground point), as tilted: the origin's height plus
 * the box middle's rise along up, less the box's extent along up (`|right.y|·hx + |up.y|·hy + |fwd.y|·hz`). Read from the
 * group's own quaternion, never a slice stale. A level car reads its ground point's height, a nose-down one its front corner's.
 */
export function lowestY(car: DeformableCar): number {
  const { x, y, z, w } = car.group.quaternion;
  const up = 1 - 2 * (x * x + z * z);
  const extent = Math.abs(2 * (x * y + w * z)) * CAR_HALF.x + Math.abs(up) * CAR_HALF.y + Math.abs(2 * (y * z - w * x)) * CAR_HALF.z;
  return car.group.position.y + up * CAR_HALF.y - extent;
}

/**
 * The race field: course loading (track, art, ground, props), the grid, spawns and respawns, the traffic bubble and
 * the wall / prop contacts. `RaceDirector` extends it with the rules glue, menus, netplay and the HUD read model.
 */
export abstract class RaceField {
  active = false;
  menu: RaceMenu = null;
  options: RaceOptions = { ...DEFAULT_RACE_OPTIONS };
  /** Full sandbox HUD and hotkeys (true) or the race focus view (false). */
  fullUi = false;
  /** The car this browser drives: 0 on a host or offline, the host-assigned car on a netplay client. */
  self = 0;
  /** This browser's player's name on the standings (`CrashEngine.setDriver`, already clean). */
  playerName = "You";
  /**
   * Seed of the field's random picks (each rival's aggression roll, `fieldAggression`). Every new
   * field (setup, start, campaign) bumps it, so each race rolls afresh; `reseed` pins it.
   */
  protected seed = 0;
  /**
   * The field's driver-look seed (`driverLook`: tees, hair, women): rolled with each new field, so the drivers keep
   * their look through the race (resets, re-throws, its replays). Presentation only: the sim never reads it. The
   * netplay host sends it with the race state and a client adopts it.
   */
  look = 0;
  /** Cars driven by network peers and their names (netplay host, `setSeats`): `remote` slots in the next field. */
  protected seats: ReadonlyMap<number, string> = new Map();
  /** Traffic cars put away by the observer bubble. */
  protected readonly dormant = new Uint8Array(MAX_CARS);
  protected bubbleAcc = 0;
  /** Crash highlights (docs/HIGHLIGHTS.md): records each race this browser simulates. */
  readonly recorder = new CrashRecorder();
  /** A wall or solid prop hit car `i` closing at `closing` m/s at (x, z): the recorder, or a highlight replay while one runs. */
  onWallHit: (i: number, closing: number, x: number, z: number) => void = (i, closing, x, z) => this.recorder.wallHit(i, closing, x, z);
  private readonly observers: AiCar[] = [];
  private readonly viewProj = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly sphere = new THREE.Sphere();
  protected readonly host: RaceHost;
  private readonly survivalJson: unknown;
  /** The Survival course's id (`RaceDirector.enter(true)` starts the run on it). */
  protected readonly survivalId: string;
  readonly courses: { id: string; name: string; blurb: string }[];
  private readonly tracks = new Map<string, Track>();
  protected track: Track | null = null;
  protected art: TrackArt | null = null;
  private placed: Placed[] = [];
  protected colliders: PropCollider[] = [];
  private knocked = new Uint8Array(0);
  protected session: RaceSession | null = null;
  /** NPC world traffic (courses with `traffic`); its cars follow the racers in car index order. */
  protected traffic: TrafficBrain | null = null;
  /** Police chase (`options.police`): its cars are ids `policeFrom…`, after the racers and traffic; `policeFrom` is the car count without police. */
  protected police: CopBrain | null = null;
  protected policeFrom = MAX_CARS;
  /** Survival (docs/SURVIVAL.md): the next `start` is a run on the Survival course with the hunters, not a race. */
  survival = false;
  /** This course's best Survival time before this run (s, null: none), and the run's result once it is over. */
  protected bestBefore: number | null = null;
  protected run: SurvivalHud["result"] = null;
  /** Per racer id: still racing (the police's quarry), refreshed each patrol. */
  private readonly hunt = new Uint8Array(MAX_CARS);
  private readonly patrolWorld: HunterWorld = {
    park: (id, x, y, z, yaw) => {
      const car = this.host.live()[id]!;
      this.dormant[id] = 0;
      this.deadFor[id] = 0;
      this.flipFor[id] = 0;
      this.seg[id] = -1;
      car.group.visible = true;
      this.place(car, x, z, yaw, y);
    },
    store: (id) => this.putAway(id, this.host.live()[id]!),
    seen: (x, z) => this.seen(x, z),
    hidden: (x, z) => this.hidden(x, z),
    down: (id) => this.deadFor[id]! > 0,
    sirens: (id, on) => {
      const car = this.host.live()[id]!;
      if (car.sirens !== on) car.setSirens(on);
    },
  };
  /** Seconds a traffic car has been dead (put away after `TRAFFIC_DEAD`). */
  protected readonly deadFor = new Float64Array(MAX_CARS);
  protected brain: RaceBrain | null = null;
  protected campaign: Campaign | null = null;
  /** Index = car id. */
  protected entrants: Entrant[] = [];
  /** Car ids in grid order for the current race. */
  protected grid: number[] = [];
  /** Car id → row in `session.cars`. */
  protected readonly rowOf = new Int16Array(MAX_CARS);
  protected spectating = false;
  protected overFor = -1;
  protected readonly seg = new Int32Array(MAX_CARS).fill(-1);
  private readonly flipFor = new Float64Array(MAX_CARS);
  private readonly stillFor = new Float64Array(MAX_CARS);
  /** Per AI racer: race time and track progress at the start of the current stall window. */
  private readonly markTime = new Float64Array(MAX_CARS);
  private readonly markProgress = new Float64Array(MAX_CARS);
  protected readonly snaps: AiCar[] = [];
  protected readonly poses: CarPose[] = [];
  protected readonly scratch: DriveInput = idleDrive();
  /** Per car id: last input received for a remote slot. */
  protected readonly remote: DriveInput[] = Array.from({ length: MAX_CARS }, () => idleDrive());
  protected readonly cruise: DriveInput = idleDrive();
  protected readonly hold: DriveInput = { ...idleDrive(), brake: 1 };
  /** A car whose driver was thrown out (`driverOut`) freewheels: no throttle, brake or steering and no engine braking (`DriveInput.neutral`), only the tyres and the road. */
  protected readonly coast: DriveInput = { ...idleDrive(), neutral: true };
  protected readonly proj = blankProjection();
  protected saved: { background: THREE.Color | THREE.Texture | null; fog: THREE.Fog | THREE.FogExp2 | null; far: number } | null = null;

  /** `survivalCourse`: the Survival course's file (a test passes a variant); it is not in `TRACKS`, so the race menu never lists it. */
  constructor(host: RaceHost, survivalCourse: unknown = HAVANA) {
    this.host = host;
    this.survivalJson = survivalCourse;
    this.survivalId = parseTrack(survivalCourse).id;
    this.courses = TRACKS.map((json) => {
      const t = parseTrack(json);
      return { id: t.id, name: t.name, blurb: t.blurb };
    });
  }

  /** The loaded course's solids for the spectator cams' sight lines (built once per course); null off a race. */
  courseSight(): Sight | null {
    return this.track ? raceSight(this.track, this.placed) : null;
  }


  /**
   * Player plus `aiCount` cars; ids are car indices, this browser's car is `self` (0). Cars seated by
   * `setSeats` are network peers' (`remote`); the AI fills the rest, each rolling its aggression in [0, slider].
   * Spectate (`options.spectate`): this browser's car is one more AI racer, so there is no player car.
   */
  protected field(): Entrant[] {
    let n = this.survival ? 1 : this.options.aiCount + 1;
    for (const id of this.seats.keys()) n = Math.max(n, id + 1);
    this.host.setPolice(n, 0);
    this.host.setCarCount(n);
    const cars = this.host.live();
    this.seed++;
    this.look = (Math.random() * 0x100000000) >>> 0;
    return cars.map((car, i): Entrant => {
      if (i === this.self && (this.survival || !this.options.spectate)) return { id: i, name: this.playerName, kind: "player", aggression: 0 };
      const peer = this.seats.get(i);
      if (peer !== undefined) return { id: i, name: peer, kind: "remote", aggression: 0 };
      return { id: i, name: car.paint.name, kind: "ai", aggression: fieldAggression(this.options.aggression, this.seed, i) };
    });
  }

  /** Single race: the AI field in car order, then the network peers, this browser's car (if it races) at the back. */
  protected defaultGrid(): number[] {
    const ai = this.entrants.filter((e) => e.kind === "ai").map((e) => e.id);
    const remote = this.entrants.filter((e) => e.kind === "remote").map((e) => e.id);
    return this.entrants[this.self]?.kind === "player" ? [...ai, ...remote, this.self] : [...ai, ...remote];
  }

  protected start(trackId: string, grid: readonly number[]): void {
    this.host.clear();
    const tr = this.load(trackId);
    // Quitting to the menu comes back to the course just raced.
    if (!this.survival) this.options.trackId = tr.id;
    const sv = this.survival ? tr.survival : null;
    if (this.survival && !sv) throw new Error(`${tr.id} has no survival anchors`);
    const racers = this.entrants.length;
    const traffic = !sv && tr.json.traffic ? new TrafficBrain(tr, racers) : null;
    const tcount = traffic ? Math.min(traffic.count, MAX_CARS - racers) : 0;
    this.traffic = tcount > 0 ? traffic : null;
    this.policeFrom = racers + tcount;
    const pcount = sv ? HUNT.units : this.options.police ? Math.min(POLICE_CAP, MAX_CARS - this.policeFrom) : 0;
    this.host.setPolice(this.policeFrom, pcount);
    this.host.setCarCount(this.policeFrom + pcount);
    this.grid = [...grid];
    const ordered = this.grid.map((id) => this.entrants[id]!);
    this.session = new RaceSession(tr, ordered, { laps: this.options.laps, noReset: sv ? true : this.options.noReset, survival: sv ? SURVIVAL : undefined });
    this.brain = new RaceBrain(tr, racers);
    this.brain.guarded = this.policeFrom;
    this.police = sv ? new HunterBrain(tr, this.colliders, racers, this.policeFrom, pcount, this.seed) : pcount > 0 ? new PoliceBrain(tr, this.brain, this.policeFrom, pcount, this.seed) : null;
    const n = this.policeFrom + pcount;
    while (this.snaps.length < n) this.snaps.push(blankAiCar(this.snaps.length));
    while (this.poses.length < racers) this.poses.push({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true });
    this.snaps.length = n;
    this.poses.length = racers;
    const cars = this.host.live();
    this.dormant.fill(0);
    this.deadFor.fill(0);
    this.bubbleAcc = 0;
    if (this.traffic) {
      this.traffic.spawns().slice(0, tcount).forEach((spot, k) => {
        const car = cars[racers + k]!;
        car.group.visible = true;
        this.place(car, spot.x, spot.z, spot.yaw, spot.y);
      });
    }
    for (let i = this.policeFrom; i < n; i++) {
      this.putAway(i, cars[i]!);
      this.police!.setClass(i, classStats(carClass(cars[i]!)));
    }
    this.grid.forEach((id, k) => {
      this.rowOf[id] = k;
      const slot = sv ? { ...sv.start, y: 0 } : tr.gridSlot(k);
      const car = cars[id]!;
      this.place(car, slot.x, slot.z, slot.yaw, slot.y);
      this.brain!.setAggression(id, this.entrants[id]!.aggression);
      this.brain!.setClass(id, classStats(carClass(car)));
    });
    if (this.police instanceof HunterBrain) {
      this.police.launch(this.patrolWorld);
      this.bestBefore = loadBest(tr.id);
      this.run = null;
    }
    this.seg.fill(-1);
    this.flipFor.fill(0);
    this.stillFor.fill(0);
    this.markTime.fill(0);
    this.markProgress.fill(0);
    this.knocked.fill(0);
    this.art?.reset();
    this.overFor = 0;
    this.menu = null;
    const seat = this.host.seat;
    if (this.entrants[this.self]?.kind === "player") {
      this.spectating = false;
      seat.focus(this.self);
      seat.mode = "drive";
      seat.boost = 1;
    } else {
      // Spectator race: no car of ours; the camera follows pole (Q/E, LB/RB, standings switch cars).
      this.spectating = true;
      seat.focus(this.grid[0]!);
    }
    this.host.setPaused(false);
    this.recorder.begin(tr.id, HANDLING.realism, this.host.bleeds(), racers, (i) => this.entrants[i]?.name ?? "Traffic", this.look);
  }

  /** Every knocked prop back on its spot (a race start, each highlight clip). */
  resetProps(): void {
    this.knocked.fill(0);
    this.art?.reset();
  }

  /** Whether car contact has knocked placed prop `i` off its spot (the ragdolls leave those out of their world). */
  propKnocked(i: number): boolean {
    return this.knocked[i] === 1;
  }

  protected park(): void {
    const tr = this.load(this.options.trackId);
    this.entrants = this.field();
    this.grid = this.defaultGrid();
    const cars = this.host.live();
    this.grid.forEach((id, k) => {
      this.rowOf[id] = k;
      const slot = tr.gridSlot(k);
      this.place(cars[id]!, slot.x, slot.z, slot.yaw, slot.y);
    });
  }

  /** Build (or reuse) the course: art, colliders, sky, fog, far plane, ground. */
  protected load(trackId: string): Track {
    if (this.track?.id === trackId) return this.track;
    this.unload();
    let tr = this.tracks.get(trackId);
    if (!tr) {
      const json = [...TRACKS, this.survivalJson, ...OFF_MENU].find((j) => parseTrack(j).id === trackId) ?? TRACKS[0]!;
      tr = new Track(json);
      this.tracks.set(trackId, tr);
    }
    this.track = tr;
    this.placed = placeProps(tr);
    this.colliders = propColliders(this.placed);
    this.knocked = new Uint8Array(this.placed.length);
    this.art = this.host.buildArt(tr, this.placed);
    if (this.art) this.host.scene.add(this.art.group);
    const env = tr.json.environment;
    const sky = new THREE.Color(env.sky);
    this.host.scene.background = sky;
    this.host.scene.fog = new THREE.FogExp2(sky.getHex(), env.fog);
    this.host.camera.far = 900;
    this.host.camera.updateProjectionMatrix();
    setGround(tr.ground());
    // Tyre marks cover the course instead of the sandbox disc.
    const b = tr.bounds;
    this.host.markBounds(b.minX, b.minZ, b.maxX, b.maxZ);
    this.seg.fill(-1);
    return tr;
  }

  protected unload(): void {
    if (this.art) {
      this.host.scene.remove(this.art.group);
      this.art.dispose();
    }
    this.art = null;
    this.track = null;
    this.placed = [];
    this.colliders = [];
    setGround(null);
    this.host.markBounds(-48, -48, 48, 48);
  }

  /** Handle the rules' events: respawn teleports, the dead menu, the end. */
  protected drain(): void {
    const s = this.session;
    if (!s) return;
    const cars = this.host.live();
    for (const e of s.events()) {
      if (e.type === "respawn") {
        const car = cars[e.id];
        if (!car) continue;
        // Back on the layer it was racing on (decks): the path height where it went down.
        const k = this.track!.project(e.x, e.z, this.seg[e.id]!, this.proj).k;
        this.place(car, e.x, e.z, e.yaw, this.track!.path.y[k]!);
        this.brain?.respawned(e.id);
        this.police?.respawned?.(e.id, s.time);
        this.seg[e.id] = -1;
        this.flipFor[e.id] = 0;
        this.stillFor[e.id] = 0;
        this.markTime[e.id] = s.time;
        this.markProgress[e.id] = s.cars[this.rowOf[e.id]!]!.progress;
      } else if (e.type === "out" && e.id === this.self && this.entrants[this.self]?.kind === "player") {
        if (s.phase !== "finished") this.menu = "dead";
      } else if (e.type === "over") {
        this.overFor = 0;
        if (this.survival) this.settle(s);
        this.recorder.end();
        this.host.reelReady(this.recorder.ledger.kept);
      }
    }
  }

  /**
   * Traffic bubble round the observers (every racer still on track): cars far from all of them, dead
   * for a while, or off the end of an open street are put away; put-away cars wake on their lane
   * out of the local player's view.
   */
  protected bubble(): void {
    const traffic = this.traffic;
    if (!traffic) return;
    const cars = this.host.live();
    const racers = this.entrants.length;
    const observers = this.observers;
    observers.length = 0;
    for (let i = 0; i < racers; i++) {
      const st = this.session?.cars[this.rowOf[i]!]?.status;
      if (st === "racing" || st === "respawning") observers.push(this.snaps[i]!);
    }
    if (observers.length === 0) return;
    for (let i = racers; i < this.policeFrom; i++) {
      const car = cars[i]!;
      if (this.dormant[i]) {
        const spot = traffic.spawnPoint(i, observers, this.snaps, this.seen);
        if (!spot) continue;
        this.dormant[i] = 0;
        car.group.visible = true;
        this.place(car, spot.x, spot.z, spot.yaw, spot.y);
        traffic.respawned(i);
        continue;
      }
      const p = car.group.position;
      let near = Infinity;
      for (const o of observers) near = Math.min(near, Math.hypot(o.x - p.x, o.z - p.z));
      if (near > DORMANT || this.deadFor[i]! > TRAFFIC_DEAD || traffic.atEnd(i, p.x, p.z)) this.putAway(i, car);
    }
  }

  /** Police patrol beat (`dt` s): knock-outs, wake-ups, pursuits, reinforcements and stakeouts (`PoliceBrain.update`). */
  protected patrol(dt: number): void {
    const police = this.police;
    const s = this.session;
    if (!police || !s) return;
    let lead = 0;
    for (let i = 0; i < this.entrants.length; i++) {
      const rec = s.cars[this.rowOf[i]!]!;
      this.hunt[i] = rec.status === "racing" ? 1 : 0;
      lead = Math.max(lead, rec.progress);
    }
    police.update(s.time, dt, this.snaps, this.hunt, lead, this.patrolWorld);
  }

  /** Park a traffic car off the course, hidden and still, until the bubble wakes it. */
  private putAway(i: number, car: DeformableCar): void {
    this.dormant[i] = 1;
    this.deadFor[i] = 0;
    car.spawnFacing(PARK_X + i * 12, PARK_Z, 0, 0);
    car.group.visible = false;
    this.snaps[i]!.x = PARK_X + i * 12;
    this.snaps[i]!.z = PARK_Z;
  }

  /** True when (x, z) is inside the local camera's view (traffic never pops in there). */
  private readonly seen = (x: number, z: number, radius = 3): boolean => {
    const cam = this.host.camera;
    cam.updateMatrixWorld();
    this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    _c.set(x, (this.track?.ground().heightAt(x, z) ?? 0) + 0.8, z);
    this.sphere.set(_c, radius);
    return this.frustum.intersectsSphere(this.sphere);
  };

  /**
   * True when a car at (x, z) cannot be seen from the local camera: `HIDE_MARGIN` m outside its view, or behind the course's
   * solids (terrain, buildings, props) from the eye to both its belly and its roof. What a Survival drop-in must satisfy.
   */
  private hidden(x: number, z: number): boolean {
    if (!this.seen(x, z, HIDE_MARGIN)) return true;
    const sight = this.courseSight();
    if (!sight) return false;
    const eye = this.host.camera.position;
    const y = (this.track?.ground().heightAt(x, z) ?? 0) + 0.4;
    return sightLine(sight, eye.x, eye.y, eye.z, x, y, z) < 0 && sightLine(sight, eye.x, eye.y, eye.z, x, y + 0.9, z) < 0;
  }

  /** A Survival run is over: its time, the best (kept when beaten) and why it ended. */
  private settle(s: RaceSession): void {
    const me = s.cars[this.rowOf[this.self]!]!;
    const time = me.outTime ?? s.time;
    const { best, isNew } = settleRun(this.bestBefore, time);
    if (isNew) saveBest(s.track.id, time);
    const cause = me.bustedAt != null ? "busted" : me.status === "out" ? "wrecked" : "ended";
    this.run = { time, best, isNew, cause, wrecked: this.police instanceof HunterBrain ? this.police.stats.disabled : 0 };
  }

  /** Survival's part of the HUD read model (null in a race). */
  protected survivalHud(): SurvivalHud | null {
    const s = this.session;
    if (!this.survival || !s) return null;
    const hunter = this.police instanceof HunterBrain ? this.police : null;
    return {
      cops: hunter?.hunting ?? 0,
      wrecked: hunter?.stats.disabled ?? 0,
      best: this.bestBefore,
      result: this.run,
    };
  }

  /** Spawn a car at (x, z) facing `yaw`, standing on the ground layer nearest `y`, dressed. */
  private place(car: DeformableCar, x: number, z: number, yaw: number, y: number): void {
    car.spawnFacing(x, z, yaw, 0);
    car.group.position.y = this.track ? this.track.ground().heightAt(x, z, y + 0.5) : 0;
    this.host.dress(car);
  }

  /** This browser's driver has car `i` (its own car, in drive mode, not spectating); otherwise the race AI or a peer does. */
  protected seatDrives(i: number): boolean {
    const seat = this.host.seat;
    return this.entrants[i]?.kind === "player" && !this.spectating && seat.mode === "drive" && seat.carIndex === i;
  }

  /** A human has car `i`: this browser's driver or a netplay peer (who can press R too). Only the AI needs the rules' automatic resets. */
  private humanDrives(i: number): boolean {
    return this.seatDrives(i) || this.entrants[i]?.kind === "remote";
  }

  /** The race AI drives car `i`: an AI rival, or the player's car while its seat isn't driving. */
  private aiDrives(i: number): boolean {
    const kind = this.entrants[i]?.kind;
    return kind === "ai" || (kind === "player" && !this.seatDrives(i));
  }

  /** Cars the race AI drives that made almost no track progress over the last window ask for a respawn (see `STALL_GAIN`). */
  protected stalls(s: RaceSession): void {
    for (let i = 0; i < this.entrants.length; i++) {
      if (!this.aiDrives(i) || s.time - this.markTime[i]! < STALL_WINDOW) continue;
      const rec = s.cars[this.rowOf[i]!]!;
      if (rec.status === "racing" && rec.progress - this.markProgress[i]! < STALL_GAIN) s.requestRespawn(i);
      this.markTime[i] = s.time;
      this.markProgress[i] = rec.progress;
    }
  }

  /**
   * Alive for the rules: a driver in the car, a running engine, not upside down for long, not parked for long unless a human
   * (this browser's driver or a netplay peer) has it. A thrown-out driver (`driverOut`) is a wreck like a dead engine, whoever's car it is: the
   * Respawn race's reset timer or the No-reset race's elimination follow.
   */
  protected judge(i: number, car: DeformableCar, dt: number, racing: boolean): boolean {
    if (car.driverOut !== null || !car.deform.drivetrainAlive) return false;
    const upY = car.group.matrixWorld.elements[5]!;
    this.flipFor[i] = upY < 0.35 ? this.flipFor[i]! + dt : 0;
    if (this.flipFor[i]! > FLIP_DEAD) return false;
    const still = racing && !this.humanDrives(i) && car.velocity.lengthSq() < 0.36;
    this.stillFor[i] = still ? this.stillFor[i]! + dt : 0;
    return this.stillFor[i]! <= STILL_DEAD;
  }

  /** Probe the footprint against the wall line on each side; push out, bounce, crumple on a hard hit. */
  protected wall(car: DeformableCar, i: number, k: number, lateral: number): void {
    const p = this.track!.path;
    const tx = p.tx[k]!;
    const tz = p.tz[k]!;
    const pos = car.group.position;
    const rx = car.rightFlat.x;
    const rz = car.rightFlat.z;
    const fx = car.fwdFlat.x;
    const fz = car.fwdFlat.z;
    let pen = 0;
    let side = 0;
    let cx = 0;
    let cz = 0;
    for (const [ox, oz] of WALL_PROBES) {
      const wx = rx * ox + fx * oz;
      const wz = rz * ox + fz * oz;
      // Left of travel = (tz, −tx).
      const lat = lateral + wx * tz - wz * tx;
      const left = lat > 0;
      if (!(left ? p.wallL[k] : p.wallR[k])) continue;
      const limit = p.half[k]! + (left ? p.runL[k]! : p.runR[k]!);
      const over = Math.abs(lat) - limit;
      if (over <= pen || over > 3) continue;
      pen = over;
      side = left ? 1 : -1;
      cx = pos.x + wx;
      cz = pos.z + wz;
    }
    if (pen <= 0) return;
    // Inward normal: back toward the road.
    const nx = -side * tz;
    const nz = side * tx;
    const v = car.velocity;
    const vn = v.x * nx + v.z * nz;
    const closing = Math.max(0, -vn);
    _c.set(cx, 0.5, cz);
    _n.set(nx, 0, nz);
    wallBounce(car, nx, nz, pen, closing, _c, _n);
    if (closing >= 1.5) this.host.hitFx(_c, _n, closing);
    this.onWallHit(i, closing, cx, cz);
  }

  /**
   * Solid props push the car out (and crumple it on a hard hit); knockable props fly off. A prop touches only a car whose
   * lowest point (the tilted body box, `lowestY`) is under the prop's top: a car flying over it clears it.
   */
  protected props(car: DeformableCar, i: number): void {
    const pos = car.group.position;
    const v = car.velocity;
    const low = lowestY(car);
    for (const col of this.colliders) {
      if (this.knocked[col.index] || low >= col.top) continue;
      const reach = col.r + WALL_HALF_L + 0.3;
      const dx = pos.x - col.x;
      const dz = pos.z - col.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      // The car's footprint against the collider; the normal points out of it.
      if (!footprintOverlap(car, col, _o)) continue;
      const { pen, nx, nz, cx, cz } = _o;
      const vn = v.x * nx + v.z * nz;
      const closing = Math.max(0, -vn);
      _c.set(cx, 0.5, cz);
      _n.set(nx, 0, nz);
      if (col.body === "knock") {
        this.knocked[col.index] = 1;
        const speed = Math.hypot(v.x, v.z);
        this.art?.knock(col.index, v.x * 1.1 - nx * 1.5, 2 + speed * 0.25, v.z * 1.1 - nz * 1.5);
        const keep = 1 - col.mass / (col.mass + 1400);
        if (car.deform.massActive) impulseCar(car, nx, 0, nz, col.mass * closing * 0.5);
        else {
          v.x *= keep;
          v.z *= keep;
        }
        if (closing > 2) this.host.hitFx(_c, _n, closing * 0.4);
        continue;
      }
      wallBounce(car, nx, nz, pen, closing, _c, _n);
      if (closing > 1.5) this.host.hitFx(_c, _n, closing);
      this.onWallHit(i, closing, cx, cz);
    }
  }

}
