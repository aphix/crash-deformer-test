import * as THREE from "three";
import { applyDrive, idleDrive, type DriveInput, type DriverSeat } from "./car-drive.ts";
import type { DeformableCar } from "./car.ts";
import { blankAiCar, type AiCar } from "./derby-ai.ts";
import { snapshotAiCar } from "./derby.ts";
import { MAX_CARS } from "./fleet.ts";
import { setGround } from "./ground.ts";
import { impulseCar } from "./pair-contact.ts";
import { Campaign } from "./race/campaign.ts";
import { SURFACES } from "./race/catalog.ts";
import { placeProps, propColliders, type Placed, type PropCollider } from "./race/placements.ts";
import { RaceBrain, onSurface } from "./race/race-ai.ts";
import { RaceSession } from "./race/session.ts";
import { TrafficBrain } from "./race/traffic.ts";
import { TrackArt } from "./race/track-art.ts";
import { parseTrack } from "./race/track-schema.ts";
import { Track, blankProjection } from "./race/track.ts";
import { CAMPAIGN, TRACKS } from "./race/tracks/index.ts";
import {
  DEFAULT_RACE_OPTIONS,
  type CarPose,
  type Entrant,
  type RaceCommand,
  type RaceHud,
  type RaceHudRow,
  type RaceMenu,
  type RaceOptions,
  type RaceSnapshot,
} from "./race/types.ts";

/** What the director needs from `CrashEngine`. */
export interface RaceHost {
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
}

/** The car this browser drives. */
const PLAYER = 0;
/** Seconds upside down before a car counts as dead. */
const FLIP_DEAD = 2.5;
/** Seconds an AI car sits still mid-race before it counts as dead (respawned). */
const STILL_DEAD = 8;
/** Seconds a dead traffic car stays put before it is respawned well away from every racer. */
const TRAFFIC_RESPAWN = 6;
/** A respawned traffic car lands at least this far (m) from every other car. */
const TRAFFIC_CLEAR = 60;
/** Seconds the finish card shows before the results menu. */
const RESULTS_DELAY = 2.5;
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
const SUN_OFFSET = new THREE.Vector3(-10, 22, 9);

const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

function hash01(id: number, k: number): number {
  const x = Math.sin(id * 127.1 + k * 311.7 + 17.13) * 43758.5453;
  return x - Math.floor(x);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Race scene glue: owns the course (track, art, ground), the field's controller slots, the rules
 * session, the AI, the campaign and the menus, and turns them into car inputs, wall / prop contacts,
 * respawns and the HUD read model. `CrashEngine` calls `drive` at the start and `collide` / `step`
 * at the end of every physics slice, `frame` once per rendered frame.
 */
export class RaceDirector {
  active = false;
  menu: RaceMenu = null;
  options: RaceOptions = { ...DEFAULT_RACE_OPTIONS };
  private readonly host: RaceHost;
  private readonly courses: { id: string; name: string; blurb: string }[];
  private readonly tracks = new Map<string, Track>();
  private track: Track | null = null;
  private art: TrackArt | null = null;
  private placed: Placed[] = [];
  private colliders: PropCollider[] = [];
  private knocked = new Uint8Array(0);
  private session: RaceSession | null = null;
  /** NPC world traffic (courses with `traffic`); its cars follow the racers in car index order. */
  private traffic: TrafficBrain | null = null;
  /** Seconds a traffic car has been dead (respawned out of sight after `TRAFFIC_RESPAWN`). */
  private readonly deadFor = new Float64Array(MAX_CARS);
  private brain: RaceBrain | null = null;
  private campaign: Campaign | null = null;
  /** Index = car id. */
  private entrants: Entrant[] = [];
  /** Car ids in grid order for the current race. */
  private grid: number[] = [];
  /** Car id → row in `session.cars`. */
  private readonly rowOf = new Int16Array(MAX_CARS);
  private spectating = false;
  private overFor = -1;
  private readonly seg = new Int32Array(MAX_CARS).fill(-1);
  private readonly flipFor = new Float64Array(MAX_CARS);
  private readonly stillFor = new Float64Array(MAX_CARS);
  private readonly snaps: AiCar[] = [];
  private readonly poses: CarPose[] = [];
  private readonly scratch: DriveInput = idleDrive();
  /** Per car id: last input received for a remote slot. */
  private readonly remote: DriveInput[] = Array.from({ length: MAX_CARS }, () => idleDrive());
  private readonly cruise: DriveInput = idleDrive();
  private readonly hold: DriveInput = { ...idleDrive(), brake: 1 };
  private readonly proj = blankProjection();
  private saved: { background: THREE.Color | THREE.Texture | null; fog: THREE.Fog | THREE.FogExp2 | null; far: number } | null = null;

  constructor(host: RaceHost) {
    this.host = host;
    this.courses = TRACKS.map((json) => {
      const t = parseTrack(json);
      return { id: t.id, name: t.name, blurb: t.blurb };
    });
  }

  /** The camera chases the followed car (player or spectated) instead of orbiting. */
  get chase(): boolean {
    return this.active && this.session != null;
  }

  /** The engine ignores keys and pad buttons while a menu is open; the HUD owns them. */
  get menuOpen(): boolean {
    return this.active && this.menu != null;
  }

  enter(): void {
    if (this.active) return;
    this.active = true;
    const scene = this.host.scene;
    this.saved = { background: scene.background as THREE.Color | null, fog: scene.fog, far: this.host.camera.far };
    this.host.seat.drivable = (i) => this.entrants[i]?.kind === "player" && this.session != null && !this.spectating;
    this.toSetup();
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.menu = null;
    this.session = null;
    this.brain = null;
    this.traffic = null;
    this.campaign = null;
    this.spectating = false;
    this.unload();
    const s = this.saved;
    if (s) {
      this.host.scene.background = s.background;
      this.host.scene.fog = s.fog;
      this.host.camera.far = s.far;
      this.host.camera.updateProjectionMatrix();
    }
    this.saved = null;
    const sun = this.host.sun;
    sun.position.copy(SUN_OFFSET);
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld();
    this.host.seat.drivable = null;
    this.host.seat.clear();
    this.host.setPaused(false);
  }

  dispose(): void {
    this.unload();
  }

  /** Engine reset (R in the sandbox, loop): restart the current race, or re-park the grid in setup. */
  reset(): void {
    if (this.session && this.track) this.start(this.track.id, this.grid);
    else this.park();
  }

  command(cmd: RaceCommand): void {
    if (!this.active) return;
    switch (cmd.type) {
      case "options": {
        const o = { ...this.options, ...cmd.options };
        o.laps = clamp(Math.round(o.laps), 3, 5);
        o.aiCount = clamp(Math.round(o.aiCount), 1, MAX_CARS - 1);
        o.aggression = clamp(o.aggression, 0, 1);
        if (!this.courses.some((c) => c.id === o.trackId)) o.trackId = this.options.trackId;
        const moved = o.trackId !== this.options.trackId || o.aiCount !== this.options.aiCount;
        this.options = o;
        if (this.menu === "setup" && moved) this.park();
        return;
      }
      case "start":
        this.campaign = null;
        this.entrants = this.field();
        this.start(this.options.trackId, this.defaultGrid());
        return;
      case "campaign":
        this.entrants = this.field();
        this.campaign = new Campaign(CAMPAIGN, this.defaultGrid().map((id) => this.entrants[id]!));
        this.start(this.campaign.trackId!, this.campaign.grid());
        return;
      case "retry":
        if (this.track && this.session) this.start(this.track.id, this.grid);
        return;
      case "next":
        this.next();
        return;
      case "pause":
        if (this.session && this.menu == null && this.session.phase !== "finished") {
          this.menu = "pause";
          this.host.setPaused(true);
        }
        return;
      case "resume":
        if (this.menu === "pause") {
          this.menu = null;
          this.host.setPaused(false);
        }
        return;
      case "end":
        if (!this.session) return;
        this.session.end();
        this.drain();
        this.host.setPaused(false);
        this.menu = "results";
        return;
      case "spectate":
        if (this.menu !== "dead") return;
        this.menu = null;
        this.spectating = true;
        this.watchLeader();
        return;
      case "cycle":
        this.cycle(cmd.dir);
        return;
      case "watch":
        this.watch(cmd.id);
        return;
      case "quit":
        if (this.menu === "setup") this.host.leave();
        else this.toSetup();
        return;
    }
  }

  /** Standings click / engine `watchCar`: follow another car only when the player is not racing. */
  watch(id: number): void {
    if (!this.session || id < 0 || id >= this.entrants.length) return;
    if (!this.mayWatch()) return;
    if (id === PLAYER && this.entrants[PLAYER]!.kind === "player") {
      this.spectating = false;
      this.host.seat.focus(PLAYER);
      return;
    }
    this.spectating = true;
    this.host.seat.focus(id);
  }

  /** Q/E, LB/RB: next / previous car still on track, when watching is allowed. */
  cycle(dir: 1 | -1): void {
    const s = this.session;
    if (!s || !this.mayWatch()) return;
    const n = this.entrants.length;
    let i = this.host.seat.carIndex;
    for (let k = 0; k < n; k++) {
      i = (((i + dir) % n) + n) % n;
      const st = s.cars[this.rowOf[i]!]!.status;
      if (i !== PLAYER && (st === "racing" || st === "respawning" || st === "finished")) {
        this.spectating = true;
        this.host.seat.focus(i);
        return;
      }
    }
  }

  /** A network peer's latest input for car `carId` (slot kind "remote"); held until the next one arrives. */
  setRemoteInput(carId: number, input: DriveInput): void {
    const r = this.remote[carId];
    if (!r) return;
    r.throttle = input.throttle;
    r.steer = input.steer;
    r.brake = input.brake;
    r.ebrake = input.ebrake;
    r.boost = input.boost;
  }

  /** Host: the whole rules state as plain JSON (null outside a race). */
  snapshot(): RaceSnapshot | null {
    return this.session ? this.session.snapshot() : null;
  }

  /** Client: adopt the host's rules state; a client renders it and never steps its own session. */
  applySnapshot(snap: RaceSnapshot): void {
    const tr = this.load(snap.trackId);
    this.session = RaceSession.restore(tr, snap);
    snap.cars.forEach((c, k) => (this.rowOf[c.id] = k));
  }

  /** R / D-pad down: the player asks to be put back on the track. */
  requestRespawn(): void {
    if (this.session && this.menu == null && !this.spectating) this.session.requestRespawn(PLAYER);
  }

  /** Start of a physics slice: every car's input from its controller slot. */
  drive(dt: number): void {
    const cars = this.host.live();
    const s = this.session;
    const brain = this.brain;
    const ground = this.track?.ground();
    if (!s || !brain || !ground) {
      for (const car of cars) applyDrive(car, this.hold, dt);
      return;
    }
    const racing = s.phase === "racing";
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i]!;
      snapshotAiCar(this.snaps[i]!, i, c.group.position.x, c.group.position.z, c.yaw, c.velocity.x, c.velocity.z, c.deform.drivetrainAlive, c.deform.masses);
    }
    const snaps = this.snaps;
    const racers = this.entrants.length;
    const traffic = this.traffic;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      const surf = SURFACES[ground.surfaceAt(car.group.position.x, car.group.position.z)];
      if (i >= racers) {
        applyDrive(car, onSurface(traffic ? traffic.think(snaps[i]!, snaps, dt) : this.hold, surf, this.scratch), dt);
        continue;
      }
      const rec = s.cars[this.rowOf[i]!]!;
      let input: DriveInput = this.hold;
      if (racing && rec.status === "racing") {
        const kind = this.entrants[i]!.kind;
        if (kind === "remote") input = this.remote[i]!;
        else if (kind === "player" && !this.spectating && this.host.seat.mode === "drive" && this.host.seat.carIndex === i) input = this.host.seat.input(car, dt);
        else input = brain.think(snaps[i]!, snaps, rec, dt);
      } else if (rec.status === "finished") {
        // Cool-down lap on the racing line.
        const ai = brain.think(snaps[i]!, snaps, rec, dt);
        this.cruise.throttle = Math.min(ai.throttle, 0.55);
        this.cruise.steer = ai.steer;
        this.cruise.brake = ai.brake;
        input = this.cruise;
      }
      applyDrive(car, onSurface(input, surf, this.scratch), dt);
    }
  }

  /** End of a physics slice, per car: walls and props. */
  collide(car: DeformableCar, i: number): void {
    const tr = this.track;
    if (!tr) return;
    const p = car.group.position;
    const proj = tr.project(p.x, p.z, this.seg[i]!, this.proj);
    this.seg[i] = proj.k;
    this.wall(car, proj.k, proj.lateral);
    if (this.colliders.length > 0) this.props(car);
  }

  /** End of a physics slice: rules step, deaths, respawns. */
  step(dt: number): void {
    const s = this.session;
    if (!s || s.phase === "finished") return;
    const cars = this.host.live();
    const racing = s.phase === "racing";
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      const alive = this.judge(i, car, dt, racing);
      if (i >= this.entrants.length) {
        this.trafficRespawn(i, car, alive, dt);
        continue;
      }
      const pose = this.poses[this.rowOf[i]!]!;
      pose.x = car.group.position.x;
      pose.z = car.group.position.z;
      pose.yaw = car.yaw;
      pose.vx = car.velocity.x;
      pose.vz = car.velocity.z;
      pose.alive = alive;
    }
    s.step(dt, this.poses);
    this.drain();
  }

  /** Once per rendered frame. */
  frame(wallDt: number): void {
    if (!this.active) return;
    const s = this.session;
    if (this.art) {
      this.art.setLights(s ? s.lights : 0);
      this.art.update(wallDt);
    }
    if (s && s.phase === "finished" && (this.menu == null || this.menu === "dead")) {
      this.overFor += wallDt;
      if (this.overFor >= RESULTS_DELAY) {
        this.menu = "results";
        this.spectating = false;
      }
    }
    this.followSun();
  }

  hud(): RaceHud {
    const s = this.session;
    const tr = this.track;
    const cars = this.host.live();
    const seat = this.host.seat;
    const standings: RaceHudRow[] = [];
    let you: RaceHud["you"] = null;
    if (s) {
      for (const id of s.order()) {
        const c = s.cars[this.rowOf[id]!]!;
        const win = s.winnerId == null ? null : s.cars[this.rowOf[s.winnerId]!]!;
        const gap =
          c.place === 1
            ? null
            : c.status === "finished" && c.finishTime != null && win?.finishTime != null
              ? c.finishTime - win.finishTime
              : c.split;
        standings.push({
          id,
          name: c.name,
          place: c.place,
          lap: c.lap,
          status: c.status,
          gap,
          bestLap: c.bestLap,
          you: c.kind === "player",
          watched: seat.mode !== "global" && seat.carIndex === id,
        });
      }
      const me = this.entrants[PLAYER]?.kind === "player" ? s.cars[this.rowOf[PLAYER]!] : undefined;
      if (me) {
        const car = cars[PLAYER];
        you = {
          id: PLAYER,
          place: me.place,
          lap: Math.min(s.laps, me.lap + 1),
          lapTime: s.phase === "racing" && me.status !== "finished" ? Math.max(0, s.time - me.lapStart) : 0,
          lastLap: me.lapTimes.length > 0 ? me.lapTimes[me.lapTimes.length - 1]! : null,
          bestLap: me.bestLap,
          status: me.status,
          wrongWay: me.wrongWay,
          respawnIn: me.respawnAt == null ? null : Math.max(0, me.respawnAt - s.time),
          finishTime: me.finishTime,
          split: me.split,
          speedKph: car ? car.velocity.length() * 3.6 : 0,
        };
      }
    }
    const winner = s && s.winnerId != null ? s.cars[this.rowOf[s.winnerId]!]!.name : null;
    const watched = this.spectating && seat.carIndex >= 0 ? (this.entrants[seat.carIndex]?.name ?? null) : null;
    return {
      menu: this.menu,
      mode: this.campaign ? "campaign" : "single",
      options: { ...this.options },
      courses: this.courses,
      phase: s ? s.phase : null,
      trackName: tr ? tr.name : "",
      laps: s ? s.laps : this.options.laps,
      noReset: s ? s.noReset : this.options.noReset,
      time: s ? s.time : 0,
      lights: s ? s.lights : 0,
      you,
      field: s ? s.cars.length : this.options.aiCount + 1,
      standings,
      spectating: watched,
      winnerName: winner,
      winBy: s ? s.winBy : null,
      results: s && s.phase === "finished" ? s.results() : null,
      campaign: this.campaign ? this.campaign.snapshot() : null,
      nextCourse: this.nextCourseName(),
    };
  }

  private mayWatch(): boolean {
    const s = this.session;
    if (!s) return false;
    if (this.entrants[PLAYER]?.kind !== "player") return true;
    const st = s.cars[this.rowOf[PLAYER]!]!.status;
    return this.spectating || st === "out" || st === "finished" || st === "dnf" || s.phase === "finished";
  }

  private watchLeader(): void {
    const s = this.session;
    if (!s) return;
    for (const id of s.order()) {
      const st = s.cars[this.rowOf[id]!]!.status;
      if (id !== PLAYER && (st === "racing" || st === "respawning" || st === "finished")) {
        this.host.seat.focus(id);
        return;
      }
    }
  }

  private next(): void {
    if (this.menu === "results") {
      if (this.campaign) {
        if (this.session) this.campaign.record(this.session.results());
        this.menu = "standings";
        return;
      }
      const id = this.nextTrackId();
      if (id) this.start(id, this.defaultGrid());
      return;
    }
    if (this.menu === "standings" && this.campaign) {
      if (this.campaign.done) {
        this.campaign = null;
        this.toSetup();
        return;
      }
      this.start(this.campaign.trackId!, this.campaign.grid());
    }
  }

  private nextTrackId(): string | null {
    if (!this.track || this.courses.length < 2) return null;
    const i = this.courses.findIndex((c) => c.id === this.track!.id);
    return this.courses[(i + 1) % this.courses.length]!.id;
  }

  private nextCourseName(): string | null {
    if (this.campaign) {
      if (this.menu === "results") return "Standings";
      const id = this.campaign.trackId;
      return id ? (this.courses.find((c) => c.id === id)?.name ?? null) : null;
    }
    const id = this.nextTrackId();
    return id ? (this.courses.find((c) => c.id === id)?.name ?? null) : null;
  }

  /** Player plus `aiCount` AI cars; ids are car indices, the player is car 0. */
  private field(): Entrant[] {
    const n = this.options.aiCount + 1;
    this.host.setCarCount(n);
    const cars = this.host.live();
    return cars.map((car, i) =>
      i === PLAYER
        ? { id: i, name: "You", kind: "player", aggression: 0 }
        : { id: i, name: car.paint.name, kind: "ai", aggression: clamp(this.options.aggression + (hash01(i, 3) - 0.5) * 0.3, 0, 1) },
    );
  }

  /** Single race: the AI field in car order, the player at the back. */
  private defaultGrid(): number[] {
    const ids = this.entrants.map((e) => e.id).filter((id) => id !== PLAYER);
    ids.push(PLAYER);
    return ids;
  }

  private start(trackId: string, grid: readonly number[]): void {
    const tr = this.load(trackId);
    // Quitting to the menu comes back to the course just raced.
    this.options.trackId = tr.id;
    const racers = this.entrants.length;
    const tcount = Math.min(tr.json.traffic?.count ?? 0, MAX_CARS - racers);
    this.host.setCarCount(racers + tcount);
    this.grid = [...grid];
    const ordered = this.grid.map((id) => this.entrants[id]!);
    this.session = new RaceSession(tr, ordered, { laps: this.options.laps, noReset: this.options.noReset });
    this.brain = new RaceBrain(tr, racers);
    this.traffic = tcount > 0 ? new TrafficBrain(tr, racers) : null;
    const n = racers + tcount;
    while (this.snaps.length < n) this.snaps.push(blankAiCar(this.snaps.length));
    while (this.poses.length < racers) this.poses.push({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true });
    this.snaps.length = n;
    this.poses.length = racers;
    const cars = this.host.live();
    if (this.traffic) {
      this.traffic.spawns(tcount).forEach((spot, k) => {
        const car = cars[racers + k]!;
        car.spawnFacing(spot.x, spot.z, spot.yaw, 0);
        this.host.dress(car);
      });
    }
    this.deadFor.fill(0);
    this.grid.forEach((id, k) => {
      this.rowOf[id] = k;
      const slot = tr.gridSlot(k);
      const car = cars[id]!;
      car.spawnFacing(slot.x, slot.z, slot.yaw, 0);
      this.host.dress(car);
      this.brain!.setAggression(id, this.entrants[id]!.aggression);
    });
    this.seg.fill(-1);
    this.flipFor.fill(0);
    this.stillFor.fill(0);
    this.knocked.fill(0);
    this.art?.reset();
    this.overFor = 0;
    this.spectating = false;
    this.menu = null;
    const seat = this.host.seat;
    seat.focus(PLAYER);
    seat.mode = "drive";
    seat.boost = 1;
    this.host.setPaused(false);
  }

  /** Setup menu: the chosen course with the field parked on its grid, no race running. */
  private toSetup(): void {
    this.session = null;
    this.brain = null;
    this.traffic = null;
    this.spectating = false;
    this.menu = "setup";
    this.host.setPaused(false);
    this.host.seat.clear();
    this.park();
  }

  private park(): void {
    const tr = this.load(this.options.trackId);
    this.entrants = this.field();
    this.grid = this.defaultGrid();
    const cars = this.host.live();
    this.grid.forEach((id, k) => {
      this.rowOf[id] = k;
      const slot = tr.gridSlot(k);
      cars[id]!.spawnFacing(slot.x, slot.z, slot.yaw, 0);
      this.host.dress(cars[id]!);
    });
  }

  /** Build (or reuse) the course: art, colliders, sky, fog, far plane, ground. */
  private load(trackId: string): Track {
    if (this.track?.id === trackId && this.art) return this.track;
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
    this.art = new TrackArt(tr, this.placed);
    this.host.scene.add(this.art.group);
    const env = tr.json.environment;
    const sky = new THREE.Color(env.sky);
    this.host.scene.background = sky;
    this.host.scene.fog = new THREE.FogExp2(sky.getHex(), env.fog);
    this.host.camera.far = 900;
    this.host.camera.updateProjectionMatrix();
    setGround(tr.ground());
    this.seg.fill(-1);
    return tr;
  }

  private unload(): void {
    if (this.art) {
      this.host.scene.remove(this.art.group);
      this.art.dispose();
    }
    this.art = null;
    this.track = null;
    this.placed = [];
    this.colliders = [];
    setGround(null);
  }

  /** Handle the rules' events: respawn teleports, the dead menu, the end. */
  private drain(): void {
    const s = this.session;
    if (!s) return;
    const cars = this.host.live();
    for (const e of s.events()) {
      if (e.type === "respawn") {
        const car = cars[e.id];
        if (!car) continue;
        car.spawnFacing(e.x, e.z, e.yaw, 0);
        this.host.dress(car);
        this.brain?.respawned(e.id);
        this.seg[e.id] = -1;
        this.flipFor[e.id] = 0;
        this.stillFor[e.id] = 0;
      } else if (e.type === "out" && e.id === PLAYER && this.entrants[PLAYER]?.kind === "player") {
        if (s.phase !== "finished") this.menu = "dead";
      } else if (e.type === "over") {
        this.overFor = 0;
      }
    }
  }

  /** A traffic car dead for a while is quietly put back in its lane far from everyone. */
  private trafficRespawn(i: number, car: DeformableCar, alive: boolean, dt: number): void {
    const traffic = this.traffic;
    if (!traffic) return;
    this.deadFor[i] = alive ? 0 : this.deadFor[i]! + dt;
    if (this.deadFor[i]! < TRAFFIC_RESPAWN) return;
    const cars = this.host.live();
    for (let k = 0; k < cars.length; k++) {
      const c = cars[k]!;
      const sn = this.snaps[k]!;
      sn.x = c.group.position.x;
      sn.z = c.group.position.z;
    }
    const spot = traffic.respawn(i, this.snaps, TRAFFIC_CLEAR);
    car.spawnFacing(spot.x, spot.z, spot.yaw, 0);
    this.host.dress(car);
    traffic.respawned(i);
    this.seg[i] = -1;
    this.deadFor[i] = 0;
    this.flipFor[i] = 0;
    this.stillFor[i] = 0;
  }

  /** Alive for the rules: running engine, not upside down for long, AI not parked for long. */
  private judge(i: number, car: DeformableCar, dt: number, racing: boolean): boolean {
    if (!car.deform.drivetrainAlive) return false;
    const upY = car.group.matrixWorld.elements[5]!;
    this.flipFor[i] = upY < 0.35 ? this.flipFor[i]! + dt : 0;
    if (this.flipFor[i]! > FLIP_DEAD) return false;
    const ai = this.entrants[i]?.kind !== "player";
    const still = racing && ai && car.velocity.lengthSq() < 0.36;
    this.stillFor[i] = still ? this.stillFor[i]! + dt : 0;
    return this.stillFor[i]! <= STILL_DEAD;
  }

  /** Probe the footprint against the wall line on each side; push out, bounce, crumple on a hard hit. */
  private wall(car: DeformableCar, k: number, lateral: number): void {
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
    const dvx = closing > 0 ? nx * closing * (1 + WALL_E) : 0;
    const dvz = closing > 0 ? nz * closing * (1 + WALL_E) : 0;
    if (car.deform.massActive) car.deform.translateMasses(nx * pen, nz * pen, dvx, dvz);
    pos.x += nx * pen;
    pos.z += nz * pen;
    v.x += dvx;
    v.z += dvz;
    if (closing < 1.5) return;
    _c.set(cx, 0.5, cz);
    _n.set(nx, 0, nz);
    if (closing > WALL_CRUSH) {
      if (!car.deform.massActive) car.applyImpact(_c, _n, closing, closing);
      else car.deform.kickNearest(_c, nx, 0.1, nz, closing * 8);
    }
    this.host.hitFx(_c, _n, closing);
  }

  /** Solid props push the car out (and crumple it on a hard hit); knockable props fly off. */
  private props(car: DeformableCar): void {
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
      if (closing > 1.5) this.host.hitFx(_c, _n, closing);
    }
  }

  /** Keep the sun's shadow box on the followed car (or the grid). */
  private followSun(): void {
    const seat = this.host.seat;
    const cars = this.host.live();
    const car = seat.carIndex >= 0 && seat.carIndex < cars.length ? cars[seat.carIndex]! : cars[0];
    if (!car) return;
    const p = car.group.position;
    const sun = this.host.sun;
    sun.target.position.set(p.x, 0, p.z);
    sun.position.set(p.x + SUN_OFFSET.x, SUN_OFFSET.y, p.z + SUN_OFFSET.z);
    sun.target.updateMatrixWorld();
  }
}
