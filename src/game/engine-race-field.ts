import * as THREE from "three";
import { idleDrive, type DriveInput, type DriverSeat } from "./car-drive.ts";
import type { DeformableCar } from "./car.ts";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { MAX_CARS } from "./fleet.ts";
import { setGround } from "./ground.ts";
import { impulseCar } from "./pair-contact.ts";
import { Campaign } from "./race/campaign.ts";
import { placeProps, propColliders, type Placed, type PropCollider } from "./race/placements.ts";
import { RaceBrain } from "./race/race-ai.ts";
import { fieldAggression } from "./ai-aggression.ts";
import { RaceSession } from "./race/session.ts";
import { DORMANT, TrafficBrain } from "./race/traffic.ts";
import type { TrackArt } from "./race/track-art.ts";
import { parseTrack } from "./race/track-schema.ts";
import { Track, blankProjection } from "./race/track.ts";
import { TRACKS } from "./race/tracks/index.ts";
import { carClass, classStats } from "./vehicle-classes.ts";
import { DEFAULT_RACE_OPTIONS, type CarPose, type Entrant, type RaceMenu, type RaceOptions } from "./race/types.ts";

/** What the director needs from `CrashEngine`. */
interface RaceHost {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly seat: DriverSeat;
  /** Cars in play; index = car id. */
  live(): DeformableCar[];
  setCarCount(n: number): void;
  /** Apply the sandbox's deform settings to a freshly spawned car. */
  dress(car: DeformableCar): void;
  setPaused(on: boolean): void;
  /** Leave race mode (setup menu → Back). */
  leave(): void;
  /** Sparks / debris at a wall or prop hit. */
  hitFx(contact: THREE.Vector3, normal: THREE.Vector3, impulse: number): void;
  /** The course's art (null headless: rules, AI, contacts and physics run without it). */
  buildArt(track: Track, placed: readonly Placed[]): TrackArt | null;
  /** Re-target the tyre-mark map to the course's bounds (headless: nothing to draw). */
  markBounds(minX: number, minZ: number, maxX: number, maxZ: number): void;
}

/** Seconds upside down before a car counts as dead. */
const FLIP_DEAD = 2.5;
/** Seconds a car not driven by this browser's driver sits still mid-race before it counts as dead (respawned). */
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
/** Wall restitution and the closing speed (m/s) that crumples a car on a wall. */
const WALL_E = 0.15;
const WALL_CRUSH = 5.5;
/** Car footprint half extents (m) for wall contact: corners and side midpoints. */
const HALF_W = 0.95;
const HALF_L = 2.3;
const PROBES: readonly (readonly [number, number])[] = [
  [-HALF_W, HALF_L],
  [HALF_W, HALF_L],
  [-HALF_W, -HALF_L],
  [HALF_W, -HALF_L],
  [-HALF_W, 0],
  [HALF_W, 0],
];

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * Push `car` out of a wall or a solid prop along the unit normal (nx, nz) by `pen`, bounce its `closing` speed with
 * `WALL_E`, and crumple it at `_c` / `_n` (the caller sets both) past `WALL_CRUSH`.
 */
function wallBounce(car: DeformableCar, nx: number, nz: number, pen: number, closing: number): void {
  const pos = car.group.position;
  const v = car.velocity;
  const dvx = closing > 0 ? nx * closing * (1 + WALL_E) : 0;
  const dvz = closing > 0 ? nz * closing * (1 + WALL_E) : 0;
  if (car.deform.massActive) car.deform.translateMasses(nx * pen, nz * pen, dvx, dvz);
  pos.x += nx * pen;
  pos.z += nz * pen;
  v.x += dvx;
  v.z += dvz;
  if (closing > WALL_CRUSH) {
    if (!car.deform.massActive) car.applyImpact(_c, _n, closing, closing);
    else car.deform.kickNearest(_c, nx, 0.1, nz, closing * 8);
  }
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
  /**
   * Seed of the field's random picks (each rival's aggression roll, `fieldAggression`). Every new
   * field (setup, start, campaign) bumps it, so each race rolls afresh; `reseed` pins it.
   */
  protected seed = 0;
  /** Cars driven by network peers (netplay host, `setSeats`): `remote` slots in the next field. */
  protected seats = new Set<number>();
  /** Traffic cars put away by the observer bubble. */
  protected readonly dormant = new Uint8Array(MAX_CARS);
  protected bubbleAcc = 0;
  private readonly observers: AiCar[] = [];
  private readonly viewProj = new THREE.Matrix4();
  private readonly frustum = new THREE.Frustum();
  private readonly sphere = new THREE.Sphere();
  protected readonly host: RaceHost;
  protected readonly courses: { id: string; name: string; blurb: string }[];
  private readonly tracks = new Map<string, Track>();
  protected track: Track | null = null;
  protected art: TrackArt | null = null;
  private placed: Placed[] = [];
  protected colliders: PropCollider[] = [];
  private knocked = new Uint8Array(0);
  protected session: RaceSession | null = null;
  /** NPC world traffic (courses with `traffic`); its cars follow the racers in car index order. */
  protected traffic: TrafficBrain | null = null;
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
  protected readonly proj = blankProjection();
  protected saved: { background: THREE.Color | THREE.Texture | null; fog: THREE.Fog | THREE.FogExp2 | null; far: number } | null = null;

  constructor(host: RaceHost) {
    this.host = host;
    this.courses = TRACKS.map((json) => {
      const t = parseTrack(json);
      return { id: t.id, name: t.name, blurb: t.blurb };
    });
  }


  /**
   * Player plus `aiCount` cars; ids are car indices, this browser's car is `self` (0). Cars seated by
   * `setSeats` are network peers' (`remote`); the AI fills the rest, each rolling its aggression in [0, slider].
   */
  protected field(): Entrant[] {
    let n = this.options.aiCount + 1;
    for (const id of this.seats) n = Math.max(n, id + 1);
    this.host.setCarCount(n);
    const cars = this.host.live();
    this.seed++;
    return cars.map((car, i): Entrant => {
      if (i === this.self) return { id: i, name: "You", kind: "player", aggression: 0 };
      if (this.seats.has(i)) return { id: i, name: `Player ${i}`, kind: "remote", aggression: 0 };
      return { id: i, name: car.paint.name, kind: "ai", aggression: fieldAggression(this.options.aggression, this.seed, i) };
    });
  }

  /** Single race: the AI field in car order, then the network peers, this browser's car at the back. */
  protected defaultGrid(): number[] {
    const ai = this.entrants.filter((e) => e.kind === "ai").map((e) => e.id);
    const remote = this.entrants.filter((e) => e.kind === "remote").map((e) => e.id);
    return [...ai, ...remote, this.self];
  }

  protected start(trackId: string, grid: readonly number[]): void {
    const tr = this.load(trackId);
    // Quitting to the menu comes back to the course just raced.
    this.options.trackId = tr.id;
    const racers = this.entrants.length;
    const traffic = tr.json.traffic ? new TrafficBrain(tr, racers) : null;
    const tcount = traffic ? Math.min(traffic.count, MAX_CARS - racers) : 0;
    this.traffic = tcount > 0 ? traffic : null;
    this.host.setCarCount(racers + tcount);
    this.grid = [...grid];
    const ordered = this.grid.map((id) => this.entrants[id]!);
    this.session = new RaceSession(tr, ordered, { laps: this.options.laps, noReset: this.options.noReset });
    this.brain = new RaceBrain(tr, racers);
    const n = racers + tcount;
    while (this.snaps.length < n) this.snaps.push(blankAiCar(this.snaps.length));
    while (this.poses.length < racers) this.poses.push({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true });
    this.snaps.length = n;
    this.poses.length = racers;
    const cars = this.host.live();
    this.dormant.fill(0);
    this.deadFor.fill(0);
    if (this.traffic) {
      this.traffic.spawns().slice(0, tcount).forEach((spot, k) => {
        const car = cars[racers + k]!;
        car.group.visible = true;
        this.place(car, spot.x, spot.z, spot.yaw, spot.y);
      });
    }
    this.grid.forEach((id, k) => {
      this.rowOf[id] = k;
      const slot = tr.gridSlot(k);
      const car = cars[id]!;
      this.place(car, slot.x, slot.z, slot.yaw, slot.y);
      this.brain!.setAggression(id, this.entrants[id]!.aggression);
      this.brain!.setClass(id, classStats(carClass(car)));
    });
    this.seg.fill(-1);
    this.flipFor.fill(0);
    this.stillFor.fill(0);
    this.markTime.fill(0);
    this.markProgress.fill(0);
    this.knocked.fill(0);
    this.art?.reset();
    this.overFor = 0;
    this.spectating = false;
    this.menu = null;
    const seat = this.host.seat;
    seat.focus(this.self);
    seat.mode = "drive";
    seat.boost = 1;
    this.host.setPaused(false);
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
      const json = TRACKS.find((j) => parseTrack(j).id === trackId) ?? TRACKS[0]!;
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
        this.seg[e.id] = -1;
        this.flipFor[e.id] = 0;
        this.stillFor[e.id] = 0;
        this.markTime[e.id] = s.time;
        this.markProgress[e.id] = s.cars[this.rowOf[e.id]!]!.progress;
      } else if (e.type === "out" && e.id === this.self && this.entrants[this.self]?.kind === "player") {
        if (s.phase !== "finished") this.menu = "dead";
      } else if (e.type === "over") {
        this.overFor = 0;
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
    for (let i = racers; i < cars.length; i++) {
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
  private readonly seen = (x: number, z: number): boolean => {
    const cam = this.host.camera;
    cam.updateMatrixWorld();
    this.viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    _c.set(x, (this.track?.ground().heightAt(x, z) ?? 0) + 0.8, z);
    this.sphere.set(_c, 3);
    return this.frustum.intersectsSphere(this.sphere);
  };

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

  /** Alive for the rules: running engine, not upside down for long, not parked for long unless this browser's driver has it. */
  protected judge(i: number, car: DeformableCar, dt: number, racing: boolean): boolean {
    if (!car.deform.drivetrainAlive) return false;
    const upY = car.group.matrixWorld.elements[5]!;
    this.flipFor[i] = upY < 0.35 ? this.flipFor[i]! + dt : 0;
    if (this.flipFor[i]! > FLIP_DEAD) return false;
    const still = racing && !this.seatDrives(i) && car.velocity.lengthSq() < 0.36;
    this.stillFor[i] = still ? this.stillFor[i]! + dt : 0;
    return this.stillFor[i]! <= STILL_DEAD;
  }

  /** Probe the footprint against the wall line on each side; push out, bounce, crumple on a hard hit. */
  protected wall(car: DeformableCar, k: number, lateral: number): void {
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
    for (const [ox, oz] of PROBES) {
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
    wallBounce(car, nx, nz, pen, closing);
    if (closing >= 1.5) this.host.hitFx(_c, _n, closing);
  }

  /** Solid props push the car out (and crumple it on a hard hit); knockable props fly off. */
  protected props(car: DeformableCar): void {
    const pos = car.group.position;
    const v = car.velocity;
    for (const col of this.colliders) {
      if (this.knocked[col.index]) continue;
      const reach = (col.kind === "circle" ? col.r : Math.max(col.hx, col.hz)) + HALF_L + 0.3;
      const dx = pos.x - col.x;
      const dz = pos.z - col.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      // Deepest footprint probe inside the collider; normal points out of it.
      let pen = 0;
      let nx = 0;
      let nz = 0;
      let cx = 0;
      let cz = 0;
      const cos = Math.cos(col.yaw);
      const sin = Math.sin(col.yaw);
      for (const [ox, oz] of PROBES) {
        const px = pos.x + car.rightFlat.x * ox + car.fwdFlat.x * oz;
        const pz = pos.z + car.rightFlat.z * ox + car.fwdFlat.z * oz;
        const ex = px - col.x;
        const ez = pz - col.z;
        if (col.kind === "circle") {
          const d = Math.hypot(ex, ez);
          const over = col.r - d;
          if (over > pen && d > 1e-6) {
            pen = over;
            nx = ex / d;
            nz = ez / d;
            cx = px;
            cz = pz;
          }
        } else {
          // Box frame: local x = (cos, −sin), local z = (sin, cos).
          const lx = ex * cos - ez * sin;
          const lz = ex * sin + ez * cos;
          const ox2 = col.hx - Math.abs(lx);
          const oz2 = col.hz - Math.abs(lz);
          if (ox2 <= 0 || oz2 <= 0) continue;
          const over = Math.min(ox2, oz2);
          if (over <= pen) continue;
          pen = over;
          const sx = ox2 < oz2 ? Math.sign(lx) || 1 : 0;
          const sz = ox2 < oz2 ? 0 : Math.sign(lz) || 1;
          nx = sx * cos + sz * sin;
          nz = -sx * sin + sz * cos;
          cx = px;
          cz = pz;
        }
      }
      if (pen <= 0) continue;
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
      wallBounce(car, nx, nz, pen, closing);
      if (closing > 1.5) this.host.hitFx(_c, _n, closing);
    }
  }

}
