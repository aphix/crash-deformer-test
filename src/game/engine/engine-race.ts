import * as THREE from "three";
import { applyDrive, type DriveInput } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { ContactHit } from "../scenes/engine-props.ts";
import { propContact } from "../contact/prop-contact.ts";
import { snapshotAiCar } from "../match/derby.ts";
import { clamp } from "../kernel/scalar.ts";
import { MAX_CARS } from "../scenes/fleet.ts";
import { Campaign } from "../match/campaign.ts";
import { SURFACES } from "../world/catalog.ts";
import { PoliceBrain } from "../ai/police.ts";
import { HunterBrain } from "../ai/hunter.ts";
import type { AiCar } from "../ai/derby-ai.ts";
import { copyDrive, onSurface } from "../ai/race-ai.ts";
import { AI_DIFFICULTIES } from "../ai/constants.ts";
import { DRAFT, RaceSession } from "../match/session.ts";
import { cleanName, RACE_MODES, TIMES_OF_DAY, type Entrant, type RaceCommand, type RacePhase, type RaceSnapshot } from "../match/types.ts";
import type { Cand, Wreck } from "../match/auto-watch.ts";
import { RaceHudLayer } from "./engine-race-hud.ts";
import { LawnGuard } from "../scenes/lawn-guard.ts";
import type { GroundsHost } from "../present/grounds-art.ts";
import type { Track } from "../world/track.ts";

/** Seconds between traffic-bubble passes. */
const BUBBLE_EVERY = 0.25;
/** Seconds the finish card shows before the results menu (and the results reel), and the BUSTED banner before the camera moves on. */
export const RESULTS_DELAY = 2.5;
/** The sun's shadow-camera basis (unit; three's lookAt with world up), from the time of day's offset: right = up x (eye - target), up = (eye - target) x right. */
const SUN_RIGHT = new THREE.Vector3();
const SUN_UP = new THREE.Vector3();

/**
 * Race scene glue: owns the course (track, art, ground), the field's controller slots, the rules
 * session, the AI, the campaign and the menus, and turns them into car inputs, wall / prop contacts,
 * respawns and the HUD read model. `CrashEngine` calls `drive` at the start and `collide` / `step`
 * at the end of every physics slice, `frame` once per rendered frame.
 */
export class RaceDirector extends RaceHudLayer {
  /** A netplay client's race is its host's: `applySnapshot` has fed it (cleared on `enter` and `exit`). A run this browser started itself is not mirrored. */
  mirrored = false;
  /** Per car id: the drafting bonuses (`CarRecord.drafts`) already put on a meter. */
  private readonly drafted = new Int32Array(MAX_CARS);
  /** The chasing police units handed to the rules each step (`BUST`; `PoliceBrain.chasers` fills it). */
  private readonly cops: AiCar[] = [];
  private readonly autoCands: Cand[] = [];
  /** The open ledger clusters as `AutoWatch` reads them: the pool, and the ones in use this frame. */
  private readonly wreckPool: Wreck[] = [];
  private readonly autoWrecks: Wreck[] = [];
  /** The course's guarded grounds (`TrackJson.guards`): its squad's sim, made once per course (`armGuard`); none on a course without. */
  private guard: LawnGuard | null = null;
  private guardOn: Track | null = null;
  /** What the grounds' people draw with: sparks at a hit, the VIP's throw. */
  private readonly grounds: GroundsHost = {
    sparks: (at, normal, impulse) => this.host.hitFx(at, normal, impulse),
    throwPassenger: (car, look) => this.host.throwPassenger(car, look),
  };

  protected override start(trackId: string, grid: readonly number[]): void {
    this.auto = false;
    this.free = false;
    this.lobbySeatedFor = -1;
    super.start(trackId, grid);
    this.armGuard();
    // A Watch race opens on Auto driver + Auto camera (any manual pick still overrides).
    if (this.spectating) {
      this.goAuto();
      this.host.watchCam();
    }
  }

  /** A run starts: the course's guards (made once per course) back inside on a fresh seed, standing down while its secret is out. */
  private armGuard(): void {
    const tr = this.track;
    if (tr !== this.guardOn) {
      this.guardOn = tr;
      this.guard = tr?.json.guards ? new LawnGuard(tr.json.guards, MAX_CARS) : null;
    }
    this.guard?.reset(this.seed);
    if (this.guard) this.guard.standDown = this.art?.secretOut ?? false;
    this.art?.grounds?.reset();
  }

  /** The course's secret comes out (`RaceField.revealSecret`): its guards stand down, its VIP comes out for the player instead. */
  override revealSecret(over: HTMLElement): boolean {
    if (!super.revealSecret(over)) return false;
    if (this.guard) this.guard.standDown = true;
    return true;
  }

  /** The camera chases the followed car (player or spectated) instead of orbiting. */
  get chase(): boolean {
    return this.active && this.session != null;
  }

  /** `World.pairHit` while racing: car–car hits feed the highlight recorder. */
  readonly pairHit = (a: number, b: number, hit: ContactHit): void => this.recorder.pairHit(a, b, hit);
  /** `World.partTouch` while racing: a door or mirror sideswipe keeps both its cars in a highlight clip. */
  readonly partTouch = (a: number, b: number): void => this.recorder.touch(a, b);

  /** The engine ignores keys and pad buttons while a menu is open; the HUD owns them. */
  get menuOpen(): boolean {
    return this.active && this.menu != null;
  }

  /**
   * Race mode on. `survival`: a Survival run on its own course instead of the setup menu. `lobby`: the Havana free-drive
   * lobby of a hosted room (no menu, no rules, no hunters; `showLobby`) with a car for the host and each seated peer.
   */
  enter(survival = false, lobby = false): void {
    if (this.active) return;
    this.active = true;
    this.survival = survival;
    this.mirrored = false;
    const scene = this.host.scene;
    this.saved = { background: scene.background as THREE.Color | null, fog: scene.fog, far: this.host.camera.far };
    this.host.seat.drivable = (i) => (this.free ? i === this.self : this.entrants[i]?.kind === "player" && this.session != null && !this.spectating);
    if (survival) {
      this.entrants = this.field();
      this.start(this.survivalId, this.defaultGrid());
    } else if (lobby) this.toLobby();
    else this.toSetup();
  }

  /** Lobby on: no menu, no police or traffic, a car for the host and every seat, all placed on the Havana start. */
  private toLobby(): void {
    this.campaign = null;
    this.setProgram(null);
    this.brain = null;
    this.traffic = null;
    this.police = null;
    this.spectating = false;
    this.auto = false;
    this.host.setPaused(false);
    this.host.seat.clear();
    this.host.setPolice(MAX_CARS, 0);
    this.policeFrom = MAX_CARS;
    this.dormant.fill(0);
    let n = 1;
    for (const id of this.seats.keys()) n = Math.max(n, id + 1);
    this.host.setCarCount(n);
    this.showLobby(this.survivalId);
    this.seatLobby(this.self);
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.survival = false;
    this.free = false;
    this.lobbySeatedFor = -1;
    this.mirrored = false;
    this.menu = null;
    this.session = null;
    this.brain = null;
    this.traffic = null;
    this.police = null;
    // Police cruisers go back to fleet cars before the sandbox shows them.
    this.host.setPolice(MAX_CARS, 0);
    this.campaign = null;
    this.setProgram(null);
    this.spectating = false;
    this.auto = false;
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
    sun.position.copy(this.host.sunOffset);
    sun.target.position.set(0, 0, 0);
    sun.target.updateMatrixWorld();
    this.host.seat.drivable = null;
    this.host.seat.clear();
    this.host.setPaused(false);
  }

  dispose(): void {
    this.unload();
  }

  /** Engine reset (R in the sandbox, loop): restart the current race, re-park the grid in setup, or in the lobby put every car and prop back. */
  reset(): void {
    if (this.free) this.lobbyScene();
    else if (this.session && this.track) this.start(this.track.id, this.grid);
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
        if (!AI_DIFFICULTIES.includes(o.aiDifficulty)) o.aiDifficulty = this.options.aiDifficulty;
        if (!RACE_MODES.includes(o.mode)) o.mode = this.options.mode;
        if (!TIMES_OF_DAY.includes(o.timeOfDay)) o.timeOfDay = this.options.timeOfDay;
        if (!this.courses.some((c) => c.id === o.trackId)) o.trackId = this.options.trackId;
        // The campaign's pick keeps the caller's order; unknown and repeated ids drop. Empty stays: the menu has nothing ticked yet.
        if (cmd.options.campaign) o.campaign = cmd.options.campaign.filter((id, i, all) => this.courses.some((c) => c.id === id) && all.indexOf(id) === i);
        const moved = o.trackId !== this.options.trackId || o.aiCount !== this.options.aiCount || o.spectate !== this.options.spectate;
        const relit = o.timeOfDay !== this.options.timeOfDay;
        this.options = o;
        this.syncRules();
        if (this.menu === "setup" && moved) this.park();
        // The setup menu shows the pick at once, on the course behind it.
        if (relit && this.track) this.host.setTimeOfDay(this.rules.timeOfDay);
        return;
      }
      case "program":
        this.setProgram(cmd.options);
        return;
      case "start":
        this.campaign = null;
        this.entrants = this.field();
        this.start(this.rules.trackId, this.defaultGrid());
        return;
      case "campaign":
        if (this.rules.campaign.length === 0) return;
        this.entrants = this.field();
        this.campaign = new Campaign(this.rules.campaign, this.defaultGrid().map((id) => this.entrants[id]!));
        this.start(this.campaign.trackId!, this.campaign.grid());
        return;
      case "retry":
        if (!this.track || !this.session) return;
        // A hosted Survival run takes in the peers who joined (or lets go of those who left) since the last one: between runs, never in one.
        if (this.survival && this.seatsChanged()) {
          this.entrants = this.field();
          this.start(this.track.id, this.defaultGrid());
        } else this.start(this.track.id, this.grid);
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
        if (this.menu === "setup" || this.survival) this.host.leave();
        else this.toSetup();
        return;
    }
  }

  /**
   * Auto spectating, once per rendered frame while it is on (else nothing): scores every racing car off the live poses,
   * the rules records and the highlight ledger, and moves the camera's subject when `AutoWatch` says so. `cuts` is the
   * camera director's cut counter (-1: the camera makes no cuts), `atCut` whether it cuts right now (or never cuts).
   * Local to this viewer: nothing goes on the net, a client scores from its interpolated cars and the host's records.
   */
  autoStep(cuts: number, atCut: boolean): void {
    const s = this.session;
    if (!this.auto || !this.spectating || !s || !this.mayWatch()) return;
    const cars = this.host.live();
    const n = this.entrants.length;
    const cands = this.autoCands;
    while (cands.length < n) cands.push({ id: cands.length, x: 0, z: 0, vx: 0, vz: 0, place: 0, split: null, stopped: 0, air: false, racing: false });
    cands.length = n;
    for (let i = 0; i < n; i++) {
      const c = cands[i]!;
      const rec = s.cars[this.rowOf[i]!]!;
      const car = cars[i]!;
      c.id = i;
      c.x = car.group.position.x;
      c.z = car.group.position.z;
      c.vx = car.velocity.x;
      c.vz = car.velocity.z;
      c.place = rec.place;
      c.split = rec.split;
      c.stopped = rec.stopped;
      c.air = car.airborne;
      c.racing = rec.status === "racing" && !this.dormant[i] && !this.mine(i);
    }
    const ledger = this.recorder.ledger.open;
    const now = this.recorder.now;
    const wrecks = this.autoWrecks;
    wrecks.length = 0;
    for (let k = 0; k < ledger.length; k++) {
      const cl = ledger[k]!;
      const w = (this.wreckPool[k] ??= { cars: 0, age: 0, score: 0 });
      w.cars = cl.cars;
      w.age = now - cl.last;
      w.score = cl.score;
      wrecks.push(w);
    }
    const seat = this.host.seat;
    // The camera is on a car Auto did not pick (Auto just came on, a police car was put away): its time on screen starts now.
    if (this.autoWatch.current !== seat.carIndex) this.autoWatch.follow(seat.carIndex, s.time, cuts);
    const id = this.autoWatch.step(s.time, cands, wrecks, cuts, atCut);
    if (id !== seat.carIndex) seat.focus(id);
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
    return this.police instanceof PoliceBrain ? this.police.stats : null;
  }

  /** This Survival run's pack stats (null outside Survival). */
  get hunterStats(): Readonly<HunterBrain["stats"]> | null {
    return this.police instanceof HunterBrain ? this.police.stats : null;
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
    const s = this.session;
    if (!s) return null;
    const snap = s.snapshot();
    if (this.police instanceof HunterBrain) snap.pack = { cops: this.police.hunting, wrecked: this.police.stats.disabled, cause: this.run?.cause ?? null };
    if (this.campaign) {
      snap.campaign = this.campaign.snapshot();
      snap.standings = this.menu === "standings";
    }
    return snap;
  }

  /** Netplay host: the cars network peers drive, with their names. The next field (start, setup) seats them as `remote`. */
  setSeats(seats: ReadonlyMap<number, string>): void {
    this.seats = seats;
  }

  /** Peers are seated, or gone, since the field was made (`field` seats the network peers it finds). */
  private seatsChanged(): boolean {
    for (const id of this.seats.keys()) if (this.entrants[id]?.kind !== "remote") return true;
    return this.entrants.some((e) => e.kind === "remote" && !this.seats.has(e.id));
  }

  /** The rules phase (null outside a race), without a snapshot. */
  get phase(): RacePhase | null {
    return this.session ? this.session.phase : null;
  }

  /** Seconds on the race clock (negative before green, 0 at green); 0 outside a race. */
  get time(): number {
    return this.session ? this.session.time : 0;
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
    // A session of this browser's own (a guest that entered Survival on the host's say, or the lobby) has not been mirrored yet: the host's first snapshot seats it.
    const own = !this.mirrored || this.free;
    this.free = false;
    this.lobbySeatedFor = -1;
    this.mirrored = true;
    const fresh = !prev || own || prev.track.id !== snap.trackId || snap.time < prev.time;
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
    for (const [k, c] of snap.cars.entries()) this.rowOf[c.id] = k;
    this.credit(this.session);
    this.pack = snap.pack;
    // The table's rows as this browser sees them: its own car the player, the host's a remote one, every name cleaned as untrusted.
    this.campaign = snap.campaign
      ? Campaign.restore({
          ...snap.campaign,
          standings: snap.campaign.standings.map((r) => ({
            ...r,
            kind: r.id === self && r.kind === "remote" ? "player" : r.kind === "player" ? "remote" : r.kind,
            name: cleanName(r.name) || `Player ${r.id}`,
          })),
        })
      : null;
    // The host's standings screen is up: this one follows, once its own results are.
    if (snap.standings && this.menu === "results") this.menu = "standings";
    // A Survival run the host has just ended: the same result card the host reads.
    if (this.survival && snap.phase === "finished" && prev?.phase !== "finished") this.settle(this.session);
    if (!fresh) return;
    this.menu = null;
    this.overFor = 0;
    this.spectating = !seated;
    this.auto = false;
    const seat = this.host.seat;
    if (seated) {
      seat.focus(self);
      seat.mode = "drive";
      seat.boost = 1;
    } else this.watchLeader();
  }

  /**
   * Netplay lobby, no menu, no rules: the course is up and every car free-drives from its spawn (a public host's race or derby waits here
   * for its players; a client shows the host's course until the game starts). Cars are placed once, when the lobby opens.
   */
  showLobby(trackId: string): void {
    const fresh = !this.free || this.track?.id !== trackId;
    this.load(trackId);
    this.session = null;
    this.menu = null;
    this.free = true;
    if (fresh) for (let i = 0; i < this.host.live().length; i++) this.placeLobby(i);
  }

  /** The course the director shows: the lobby's, the race's, or (nothing loaded) the options' pick. */
  get courseId(): string {
    return this.track?.id ?? this.rules.trackId;
  }

  private lobbySeatedFor = -1;

  /** Lobby: this browser drives car `self` (once per seat: Esc leaves it). */
  seatLobby(self: number): void {
    if (!this.free || this.lobbySeatedFor === self) return;
    this.lobbySeatedFor = self;
    this.self = self;
    const seat = this.host.seat;
    seat.focus(self);
    seat.mode = "drive";
    seat.boost = 1;
  }

  /** Lobby: car `id` (a peer's request, or this browser's R) back at its Havana spawn, repaired. */
  resetLobbyCar(id: number): void {
    if (this.free) this.placeLobby(id);
  }

  /** R / D-pad down (this browser), or a netplay peer's request for its car `id` (host). */
  requestRespawn(id = this.self): void {
    if (this.free) this.placeLobby(id);
    else if (this.mayAsk(id)) this.session!.requestRespawn(id);
  }

  /** There is a race, and this browser's own ask meets no menu and no spectating seat (a netplay peer's is the rules' to refuse). */
  private mayAsk(id: number): boolean {
    return this.session !== null && !(id === this.self && (this.menu != null || this.spectating));
  }

  /**
   * The reset control held (this browser), or a netplay peer's hold for its car `id` (host): back on the road at once, damage kept (`RaceSession.holdReset`).
   * It works in a no-reset race and refuses where a tap does (a menu is up, spectating) and in Survival. In the lobby it is a tap: there is no damage worth keeping.
   */
  holdReset(id = this.self): void {
    if (this.free) this.placeLobby(id);
    else if (this.mayAsk(id)) this.session!.holdReset(id);
  }

  /** Start of a physics slice: every car's input from its controller slot. */
  drive(dt: number): void {
    const cars = this.host.live();
    const s = this.session;
    const brain = this.brain;
    const ground = this.track?.ground();
    if (this.free && ground) {
      for (let i = 0; i < cars.length; i++) {
        const car = cars[i]!;
        const p = car.group.position;
        const surf = SURFACES[ground.surfaceAt(p.x, p.z, p.y)];
        const own = i === this.self && this.host.seat.mode === "drive" && this.host.seat.carIndex === i;
        const input = car.driverOut !== null ? this.coast : own ? this.host.seat.input(car, dt) : this.seats.has(i) ? this.remote[i]! : this.hold;
        applyDrive(car, onSurface(input, surf, this.scratch), dt);
      }
      return;
    }
    if (!s || !brain || !ground) {
      for (let i = 0; i < cars.length; i++) applyDrive(cars[i]!, this.hold, dt);
      return;
    }
    this.recorder.startStep(cars);
    const racing = s.phase === "racing";
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i]!;
      snapshotAiCar(this.snaps[i]!, i, c, c.deform.drivetrainAlive);
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
        // A thrown-out driver is nobody's input: the car coasts (`coast`), police and traffic units too.
        const input =
          car.driverOut !== null
            ? this.coast
            : this.dormant[i]
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
      // No driver, no pedals: not the player's seat, a peer's input or the AI (`coast`); the rules reset or retire the car (`judge`).
      let input: DriveInput = this.hold;
      if (car.driverOut !== null) input = this.coast;
      else if (racing && rec.status === "racing") {
        const kind = this.entrants[i]!.kind;
        if (kind === "remote") input = this.remote[i]!;
        else if (this.seatDrives(i)) input = this.host.seat.input(car, dt);
        else {
          if (brain.due(i, dt)) copyDrive(brain.think(snaps[i]!, snaps, rec, brain.elapsed(i)), this.held[i]!);
          input = brain.guard(snaps[i]!, snaps, this.held[i]!);
        }
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

  /** End of a physics slice of `h` s, per car: walls and props. */
  collide(car: DeformableCar, i: number, h: number): void {
    if (!this.track || this.dormant[i]) return;
    this.courseHit(car, i, h);
  }

  /**
   * Car `i` against the course's walls and props over a slice of `h` s (a highlight replay runs it for put-away traffic too):
   * every wall piece and prop near it is a solid it meets from any side (`propContact`). The road projection hint follows it.
   */
  courseHit(car: DeformableCar, i: number, h: number): void {
    const tr = this.track;
    if (!tr) return;
    const p = car.group.position;
    this.seg[i] = tr.project(p.x, p.z, this.seg[i]!, this.proj).k;
    propContact(car, i, this.solids, this.knocked, this.propHits, h);
  }

  /** End of a physics step of `dt` s, which the world ran on the schedule `shape` (`World.shape`): rules step, deaths, respawns. */
  step(dt: number, shape: number): void {
    const s = this.session;
    if (!s) return;
    const cars = this.host.live();
    if (s.phase === "finished") {
      // Over: the recorder runs on for the last thrown driver's hold (`CrashRecorder.over`), and the reel goes out when it ends.
      if (!this.recorder.on) return;
      this.recorder.endStep(cars, dt, shape);
      this.reelIfRecorded();
      return;
    }
    const racing = s.phase === "racing";
    if (!this.mirrored) this.guard?.step(cars, dt);
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
    this.recorder.endStep(cars, dt, shape);
    if (racing) this.stalls(s);
    this.drain();
    this.bubbleAcc += dt;
    if (this.bubbleAcc >= BUBBLE_EVERY) {
      this.bubbleAcc = 0;
      this.bubble();
      this.patrol(BUBBLE_EVERY);
      // A watched police car was put away: watch the next car.
      if (this.spectating && !this.auto && this.dormant[this.host.seat.carIndex]) this.cycle(1);
    }
  }

  /** Drafting bonuses the rules awarded since the last look: onto our seat's meter, or the race AI's (a peer's own client credits its seat). */
  private credit(s: RaceSession): void {
    for (let k = 0; k < s.cars.length; k++) {
      const c = s.cars[k]!;
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
    if (this.art) this.art.setLights(s ? s.lights : 0);
    if (this.art?.grounds) {
      const player = s && this.entrants[this.self]?.kind === "player" ? this.self : -1;
      this.art.grounds.frame(wallDt, this.mirrored ? null : this.guard, this.art.secretOut, this.host.live(), player, this.grounds);
    }
    if (s && s.phase === "finished" && (this.menu == null || this.menu === "dead")) {
      this.overFor += wallDt;
      if (this.overFor >= RESULTS_DELAY) {
        this.menu = "results";
        this.spectating = false;
        this.auto = false;
      }
    }
    const me = s && this.entrants[this.self]?.kind === "player" ? s.cars[this.rowOf[this.self]!]! : null;
    // Busted or wrecked out of the race: the banner shows, then the camera follows the field (a host's wreck has its dead menu instead).
    const fell = me?.bustedAt ?? (me?.status === "out" ? me.outTime : null);
    if (s && fell != null && this.menu == null && !this.spectating && s.time - fell >= RESULTS_DELAY) {
      this.spectating = true;
      this.watchLeader();
    }
    this.followSun();
  }

  /** Keep the sun's shadow box on `car`: the followed car (or the grid), a highlight's subject while the reel plays. */
  followSun(car: DeformableCar | undefined = this.followed()): void {
    if (!car) return;
    const p = car.group.position;
    const sun = this.host.sun;
    const cam = sun.shadow.camera;
    const texX = (cam.right - cam.left) / sun.shadow.mapSize.x;
    const texY = (cam.top - cam.bottom) / sun.shadow.mapSize.y;
    const off = this.host.sunOffset;
    SUN_RIGHT.set(0, 1, 0).cross(off).normalize();
    SUN_UP.copy(off).cross(SUN_RIGHT).normalize();
    // Snap the box centre to whole shadow-map texels in the light's right/up basis, so static casters' edges never crawl.
    const a = SUN_RIGHT.x * p.x + SUN_RIGHT.z * p.z;
    const b = SUN_UP.x * p.x + SUN_UP.z * p.z;
    const da = Math.round(a / texX) * texX - a;
    const db = Math.round(b / texY) * texY - b;
    const tx = p.x + SUN_RIGHT.x * da + SUN_UP.x * db;
    const ty = SUN_RIGHT.y * da + SUN_UP.y * db;
    const tz = p.z + SUN_RIGHT.z * da + SUN_UP.z * db;
    sun.target.position.set(tx, ty, tz);
    sun.position.set(tx + off.x, ty + off.y, tz + off.z);
    sun.target.updateMatrixWorld();
  }

  private followed(): DeformableCar | undefined {
    const seat = this.host.seat;
    const cars = this.host.live();
    return seat.carIndex >= 0 && seat.carIndex < cars.length ? cars[seat.carIndex]! : cars[0];
  }
}
