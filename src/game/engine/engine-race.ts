import * as THREE from "three";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import { carGear } from "../vehicle/vehicle-classes.ts";
import { snapshotAiCar } from "../match/derby.ts";
import { clamp } from "../kernel/scalar.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { Campaign } from "../match/campaign.ts";
import { SURFACES } from "../world/catalog.ts";
import type { PoliceBrain } from "../ai/police.ts";
import type { AiCar } from "../ai/derby-ai.ts";
import { onSurface } from "../ai/race-ai.ts";
import { DRAFT, RaceSession } from "../match/session.ts";
import { CAMPAIGN } from "../world/tracks/index.ts";
import {
  cleanName,
  type Entrant,
  type RaceCommand,
  type RaceHud,
  type RaceHudRow, type RacePhase,
  type RaceSnapshot,
  type RaceView
} from "../match/types.ts";
import { RaceField } from "./engine-race-field.ts";

/** Seconds between traffic-bubble passes. */
const BUBBLE_EVERY = 0.25;
/** Seconds the finish card shows before the results menu (and the results reel), and the BUSTED banner before the camera moves on. */
export const RESULTS_DELAY = 2.5;
const SUN_OFFSET = new THREE.Vector3(-10, 22, 9);

/**
 * Race scene glue: owns the course (track, art, ground), the field's controller slots, the rules
 * session, the AI, the campaign and the menus, and turns them into car inputs, wall / prop contacts,
 * respawns and the HUD read model. `CrashEngine` calls `drive` at the start and `collide` / `step`
 * at the end of every physics slice, `frame` once per rendered frame.
 */
export class RaceDirector extends RaceField {
  /** Per car id: the drafting bonuses (`CarRecord.drafts`) already put on a meter. */
  private readonly drafted = new Int32Array(MAX_CARS);
  /** The chasing police units handed to the rules each step (`BUST`; `PoliceBrain.chasers` fills it). */
  private readonly cops: AiCar[] = [];

  /** The camera chases the followed car (player or spectated) instead of orbiting. */
  get chase(): boolean {
    return this.active && this.session != null;
  }

  /** `World.pairHit` while racing: car–car hits feed the highlight recorder. */
  readonly pairHit = (a: number, b: number, hit: ContactHit, first: boolean): void => this.recorder.pairHit(a, b, hit, first);

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
    this.police = null;
    // Police cruisers go back to fleet cars before the sandbox shows them.
    this.host.setPolice(MAX_CARS, 0);
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
        // The menu offers 1–5; the rules (and a host or test) take any count the track format allows.
        o.laps = clamp(Math.round(o.laps), 1, 9);
        o.aiCount = clamp(Math.round(o.aiCount), 1, MAX_CARS - 1);
        o.aggression = clamp(o.aggression, 0, 1);
        if (!this.courses.some((c) => c.id === o.trackId)) o.trackId = this.options.trackId;
        const moved = o.trackId !== this.options.trackId || o.aiCount !== this.options.aiCount || o.spectate !== this.options.spectate;
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
      case "fullUi":
        this.fullUi = cmd.on;
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
    if (this.mine(id)) {
      this.spectating = false;
      this.host.seat.focus(this.self);
      return;
    }
    this.spectating = true;
    this.host.seat.focus(id);
  }

  /** Q/E, LB/RB: next / previous car still on track (never our own racing car), then the police cars out on the course, when watching is allowed. */
  cycle(dir: 1 | -1): void {
    const s = this.session;
    if (!s || !this.mayWatch()) return;
    const racers = this.entrants.length;
    const n = this.police ? this.policeFrom + this.police.count : racers;
    let i = this.host.seat.carIndex;
    for (let k = 0; k < n; k++) {
      i = (((i + dir) % n) + n) % n;
      const st = i < racers ? s.cars[this.rowOf[i]!]!.status : null;
      const ok = st === null ? i >= this.policeFrom && !this.dormant[i] : !this.mine(i) && (st === "racing" || st === "respawning" || st === "finished");
      if (ok) {
        this.spectating = true;
        this.host.seat.focus(i);
        return;
      }
    }
  }

  /** The next field (start, campaign, or the setup grid) rolls its random picks with `seed`. */
  reseed(seed: number): void {
    this.seed = seed - 1;
  }

  /** The current field: who is in it, slot kinds and rolled aggression (read-only). */
  get racers(): readonly Entrant[] {
    return this.entrants;
  }

  /** This race's police chase stats (null with police off). */
  get policeStats(): Readonly<PoliceBrain["stats"]> | null {
    return this.police?.stats ?? null;
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

  /** Netplay host: the cars network peers drive, with their names. The next field (start, setup) seats them as `remote`. */
  setSeats(seats: ReadonlyMap<number, string>): void {
    this.seats = seats;
  }

  /** The rules phase (null outside a race), without a snapshot. */
  get phase(): RacePhase | null {
    return this.session ? this.session.phase : null;
  }

  /**
   * Netplay client: adopt the host's rules state; a client renders it and never steps its own
   * session. `self` is this peer's car: it races only if the host seated it (`remote` in the host's
   * field); a peer who joined mid-race spectates until the next race. Every car keeps the host's name
   * for it (the host's and each peer's pick), cleaned here as untrusted. A new race (or the first one
   * seen) puts this peer in its seat or on the leader.
   */
  applySnapshot(snap: RaceSnapshot, self: number): void {
    const prev = this.session;
    const fresh = !prev || prev.track.id !== snap.trackId || snap.time < prev.time;
    const tr = this.load(snap.trackId);
    const entrants: Entrant[] = [];
    let seated = false;
    for (const c of snap.cars) {
      if (c.id === self && c.kind === "remote") {
        c.kind = "player";
        seated = true;
      } else if (c.kind === "player") c.kind = "remote";
      c.name = cleanName(c.name) || `Player ${c.id}`;
      entrants[c.id] = { id: c.id, name: c.name, kind: c.kind, aggression: 0 };
    }
    this.session = RaceSession.restore(tr, snap);
    this.entrants = entrants;
    this.self = self;
    snap.cars.forEach((c, k) => (this.rowOf[c.id] = k));
    this.credit(this.session);
    if (!fresh) return;
    this.menu = null;
    this.overFor = 0;
    this.spectating = !seated;
    const seat = this.host.seat;
    if (seated) {
      seat.focus(self);
      seat.mode = "drive";
      seat.boost = 1;
    } else this.watchLeader();
  }

  /**
   * Netplay lobby, no menu: a public host waits for players on the course with its field parked (it
   * starts the race itself when the lobby ends); a client shows the host's course until the race starts.
   */
  showLobby(trackId: string): void {
    this.load(trackId);
    this.session = null;
    this.menu = null;
  }

  /** R / D-pad down (this browser), or a netplay peer's request for its car `id` (host). */
  requestRespawn(id = this.self): void {
    if (!this.session) return;
    if (id === this.self && (this.menu != null || this.spectating)) return;
    this.session.requestRespawn(id);
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
    this.recorder.startStep(cars);
    const racing = s.phase === "racing";
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i]!;
      snapshotAiCar(this.snaps[i]!, i, c.group.position.x, c.group.position.z, c.yaw, c.velocity.x, c.velocity.z, c.deform.drivetrainAlive, c.deform.masses);
    }
    const snaps = this.snaps;
    const racers = this.entrants.length;
    const traffic = this.traffic;
    const police = s.phase === "finished" ? null : this.police;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      const p = car.group.position;
      const surf = SURFACES[ground.surfaceAt(p.x, p.z, p.y)];
      if (i >= racers) {
        const input = this.dormant[i]
          ? this.hold
          : i >= this.policeFrom
            ? (police?.think(snaps[i]!, snaps, dt) ?? this.hold)
            : traffic
              ? traffic.think(snaps[i]!, snaps, dt)
              : this.hold;
        applyDrive(car, onSurface(input, surf, this.scratch), dt);
        continue;
      }
      const rec = s.cars[this.rowOf[i]!]!;
      let input: DriveInput = this.hold;
      if (racing && rec.status === "racing") {
        const kind = this.entrants[i]!.kind;
        if (kind === "remote") input = this.remote[i]!;
        else if (this.seatDrives(i)) input = this.host.seat.input(car, dt);
        else input = brain.think(snaps[i]!, snaps, rec, dt);
      } else if (rec.status === "finished") {
        // Cool-down lap on the racing line.
        const ai = brain.think(snaps[i]!, snaps, rec, dt);
        this.cruise.throttle = Math.min(ai.throttle, 0.55);
        this.cruise.steer = ai.steer;
        this.cruise.brake = ai.brake;
        input = this.cruise;
      }
      const top = rec.draft > 0 ? DRAFT.top : 1;
      applyDrive(car, onSurface(input, surf, this.scratch), dt, top);
      if (top !== 1) this.recorder.drafting(i);
    }
  }

  /** End of a physics slice, per car: walls and props. */
  collide(car: DeformableCar, i: number): void {
    if (!this.track || this.dormant[i]) return;
    this.courseHit(car, i);
  }

  /** Car `i` against the course's walls and props (a highlight replay runs it for put-away traffic too). */
  courseHit(car: DeformableCar, i: number): void {
    const tr = this.track;
    if (!tr) return;
    const p = car.group.position;
    const proj = tr.project(p.x, p.z, this.seg[i]!, this.proj);
    this.seg[i] = proj.k;
    this.wall(car, i, proj.k, proj.lateral);
    if (this.colliders.length > 0) this.props(car, i);
  }

  /** End of a physics slice: rules step, deaths, respawns. */
  step(dt: number): void {
    const s = this.session;
    if (!s || s.phase === "finished") return;
    const cars = this.host.live();
    const racing = s.phase === "racing";
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      if (this.dormant[i]) continue;
      // Police are never "still" dead: a parked unit waits; only a dead drivetrain or a roll knocks it out.
      const alive = this.judge(i, car, dt, racing && i < this.policeFrom);
      if (i >= this.entrants.length) {
        this.deadFor[i] = alive ? 0 : this.deadFor[i]! + dt;
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
    // The units chasing (this slice's start positions; a parked or knocked-out unit never busts anyone).
    s.step(dt, this.poses, this.police?.chasers(this.snaps, this.cops));
    this.credit(s);
    this.recorder.endStep(cars, dt);
    if (racing) this.stalls(s);
    this.drain();
    this.bubbleAcc += dt;
    if (this.bubbleAcc >= BUBBLE_EVERY) {
      this.bubbleAcc = 0;
      this.bubble();
      this.patrol(BUBBLE_EVERY);
      // A watched police car was put away: watch the next car.
      if (this.spectating && this.dormant[this.host.seat.carIndex]) this.cycle(1);
    }
  }

  /** Drafting bonuses the rules awarded since the last look: onto our seat's meter, or the race AI's (a peer's own client credits its seat). */
  private credit(s: RaceSession): void {
    for (const c of s.cars) {
      const n = c.drafts - this.drafted[c.id]!;
      this.drafted[c.id] = c.drafts;
      // Not `n <= 0`: an older host's snapshot has no `drafts` (NaN).
      if (!(n > 0)) continue;
      if (this.seatDrives(c.id)) this.host.seat.addBoost(n * DRAFT.bonus);
      else if (c.kind !== "remote") this.brain?.addBoost(c.id, n * DRAFT.bonus);
    }
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
    // Busted: the banner shows, then the camera follows the field the way it does after a DNF.
    const me = s && this.entrants[this.self]?.kind === "player" ? s.cars[this.rowOf[this.self]!]! : null;
    if (s && me?.bustedAt != null && this.menu == null && !this.spectating && s.time - me.bustedAt >= RESULTS_DELAY) {
      this.spectating = true;
      this.watchLeader();
    }
    this.followSun();
  }

  /** The race's part of the HUD read model; the engine adds the reel's (`reel`, `solo`, `saved`). */
  hud(): Omit<RaceHud, "reel" | "solo" | "saved"> {
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
        // A finisher a lap or more down has no time gap; the HUD shows its laps behind.
        const gap =
          c.place === 1
            ? null
            : c.status === "finished" && c.finishTime != null && win?.finishTime != null
              ? c.lap < s.laps
                ? null
                : c.finishTime - win.finishTime
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
      const me = this.entrants[this.self]?.kind === "player" ? s.cars[this.rowOf[this.self]!] : undefined;
      if (me) {
        you = {
          id: this.self,
          place: me.place,
          lap: Math.min(s.laps, me.lap + 1),
          status: me.status,
          wrongWay: me.wrongWay,
          missed: me.missed && me.status === "racing",
          respawnIn: me.respawnAt == null ? null : Math.max(0, me.respawnAt - s.time),
          finishTime: me.finishTime,
          busted: me.bustedAt != null,
        };
      }
    }
    const id = seat.mode === "global" ? -1 : seat.carIndex;
    const car = s && id >= 0 ? cars[id] : undefined;
    let view: RaceView | null = null;
    if (s && car) {
      const c = id < this.entrants.length ? s.cars[this.rowOf[id]!] : undefined;
      view = {
        id,
        racer: c
          ? {
              place: c.place,
              lap: Math.min(s.laps, c.lap + 1),
              lapTime: s.phase === "racing" && c.status !== "finished" ? Math.max(0, s.time - c.lapStart) : 0,
              lastLap: c.lapTimes.length > 0 ? c.lapTimes[c.lapTimes.length - 1]! : null,
              bestLap: c.bestLap,
              split: c.split,
              drafting: c.draft > 0,
            }
          : null,
        speedKph: car.velocity.length() * 3.6,
        gear: carGear(car),
        // ponytail: an AI meter shows only where this browser runs the AI (host / offline); a peer's car and police have none here.
        boost: this.seatDrives(id) ? seat.boost : this.entrants[id]?.kind === "ai" && this.brain ? this.brain.meter[id]! : null,
        boosting: car.drive.boost,
      };
    }
    const winner = s && s.winnerId != null ? s.cars[this.rowOf[s.winnerId]!]!.name : null;
    const watched =
      this.spectating && seat.carIndex >= 0 ? (this.entrants[seat.carIndex]?.name ?? (seat.carIndex >= this.policeFrom ? "Police" : null)) : null;
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
      you,
      view,
      field: s ? s.cars.length : this.options.aiCount + 1,
      standings,
      spectating: watched,
      winnerName: winner,
      winBy: s ? s.winBy : null,
      results: s && s.phase === "finished" ? s.results() : null,
      campaign: this.campaign ? this.campaign.snapshot() : null,
      nextCourse: this.nextCourseName(),
      fullUi: this.fullUi,
    };
  }

  private mayWatch(): boolean {
    const s = this.session;
    if (!s) return false;
    if (this.entrants[this.self]?.kind !== "player") return true;
    const st = s.cars[this.rowOf[this.self]!]!.status;
    return this.spectating || st === "out" || st === "finished" || st === "dnf" || s.phase === "finished";
  }

  private watchLeader(): void {
    const s = this.session;
    if (!s) return;
    for (const id of s.order()) {
      const st = s.cars[this.rowOf[id]!]!.status;
      if (!this.mine(id) && (st === "racing" || st === "respawning" || st === "finished")) {
        this.host.seat.focus(id);
        return;
      }
    }
  }

  /** Car `i` is this browser's player car (a spectator race has none). */
  private mine(i: number): boolean {
    return i === this.self && this.entrants[i]?.kind === "player";
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
        this.toSetup();
        return;
      }
      this.pegCampaign();
      this.start(this.campaign.trackId!, this.campaign.grid());
    }
  }

  /** Each rival keeps the aggression it rolled when the campaign began. */
  private pegCampaign(): void {
    if (!this.campaign) return;
    for (const r of this.campaign.standings()) {
      const e = this.entrants[r.id];
      if (e?.kind === "ai") e.aggression = r.aggression;
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
  /** Setup menu: the chosen course with the field parked on its grid, no race running. */
  private toSetup(): void {
    this.campaign = null;
    this.session = null;
    this.brain = null;
    this.traffic = null;
    this.police = null;
    this.spectating = false;
    this.menu = "setup";
    this.host.setPaused(false);
    this.host.seat.clear();
    this.park();
  }
  /** Keep the sun's shadow box on `car`: the followed car (or the grid), a highlight's subject while the reel plays. */
  followSun(car: DeformableCar | undefined = this.followed()): void {
    if (!car) return;
    const p = car.group.position;
    const sun = this.host.sun;
    sun.target.position.set(p.x, 0, p.z);
    sun.position.set(p.x + SUN_OFFSET.x, SUN_OFFSET.y, p.z + SUN_OFFSET.z);
    sun.target.updateMatrixWorld();
  }

  private followed(): DeformableCar | undefined {
    const seat = this.host.seat;
    const cars = this.host.live();
    return seat.carIndex >= 0 && seat.carIndex < cars.length ? cars[seat.carIndex]! : cars[0];
  }
}
