import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DriverSeat, type DriveInput } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { makeCar } from "../contact/crash-scenarios.test-util.ts";
import { DEFAULT_RACE_OPTIONS, type RaceCommand, type RaceOptions, type RacePhase, type RaceSnapshot } from "../match/types.ts";
import { INPUT_BYTES, type Reel } from "../match/highlights.ts";
import * as codec from "./codec.ts";
import { NetPlay } from "./net-play.ts";
import type { NetTx } from "./net-ports.ts";
import { publicRoomName } from "./matchmaking.ts";
import { NetTransport, type NetPeer } from "./transport.ts";
import { packReel } from "./reel-codec.ts";
import { reelParts } from "./reel-wire.ts";
import { makeClip, sameClip } from "./reel-clip.test-util.ts";
import { HOST_WAIT_MS } from "./net-constants.ts";
import type { LookData } from "./look-codec.ts";
import { NO_CAR_PICK, NO_PERSON_PICK, carPickText, personPickText } from "../present/look-pick.ts";
import { CAR_SPRAY, PERSON_SPRAY } from "../present/spray.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";

/** A player who picked nothing and sprayed nothing. */
const bareLook = (): LookData => ({
  car: { ...NO_CAR_PICK },
  person: { ...NO_PERSON_PICK },
  carSpray: new Uint8Array(CAR_SPRAY.w * CAR_SPRAY.h),
  personSpray: new Uint8Array(PERSON_SPRAY.w * PERSON_SPRAY.h),
});

/** Frame time (ms) of the session loop: one host snapshot and one guest input per step. */
const FRAME_MS = 1000 / 30;
/** The relay's message cap (bytes): a longer message never arrives. */
const RELAY_MSG_MAX = 240 * 1024;

/**
 * An in-memory room: every end reaches every other end unless their pair is cut (a connection blip).
 * An `unlisted` end is off every roster while its messages still flow (a link the host's transport
 * no longer reports, yet traffic gets through).
 */
class Hub {
  readonly ends = new Map<string, Link>();
  readonly unlisted = new Set<string>();
  private readonly cut = new Set<string>();
  private queue: (() => void)[] = [];

  /** Each end's `meta` getter (a public host's relay tag), by peer id. */
  readonly metas = new Map<string, () => string>();

  readonly connect = (_tx: NetTx, _room: string, id: string, role: "host" | "client", meta: () => string = () => ""): NetTransport => {
    const end = new Link(this, id, role);
    this.ends.set(id, end);
    this.metas.set(id, meta);
    return end;
  };

  linked(a: string, b: string): boolean {
    return !this.cut.has(`${a}|${b}`);
  }

  /** Drop (or restore) the link between two peers, both ways. */
  setCut(a: string, b: string, on: boolean): void {
    for (const k of [`${a}|${b}`, `${b}|${a}`]) {
      if (on) this.cut.add(k);
      else this.cut.delete(k);
    }
  }

  post(fn: () => void): void {
    this.queue.push(fn);
  }

  /** Deliver everything sent so far (and whatever that sends in turn). */
  flush(): void {
    while (this.queue.length) {
      const q = this.queue;
      this.queue = [];
      for (const fn of q) fn();
    }
  }

  /** A raw message from `from` to `to`, as if `from` had sent it. */
  sendAs(from: string, to: string, data: Uint8Array): void {
    const end = this.ends.get(to);
    if (end) this.post(() => end.onMessage?.(from, data.slice()));
  }
}

class Link extends NetTransport {
  closed = false;
  private readonly hub: Hub;
  private readonly role: "host" | "client";

  constructor(hub: Hub, id: string, role: "host" | "client") {
    super(id);
    this.hub = hub;
    this.role = role;
  }

  send(data: Uint8Array, to?: string): void {
    if (data.length > RELAY_MSG_MAX) return;
    for (const [id, end] of this.hub.ends) {
      if (id === this.selfId || end.closed || (to !== undefined && to !== id) || !this.hub.linked(this.selfId, id)) continue;
      const copy = data.slice();
      this.hub.post(() => end.onMessage?.(this.selfId, copy));
    }
  }

  peers(): readonly NetPeer[] {
    const out: NetPeer[] = [];
    for (const [id, end] of this.hub.ends) {
      if (id === this.selfId || end.closed || !this.hub.linked(this.selfId, id) || this.hub.unlisted.has(id)) continue;
      out.push({ id, rttMs: 1, host: end.role === "host" });
    }
    return out;
  }

  close(): void {
    this.closed = true;
  }
}

/** The engine as NetPlay sees it, with real cars and a real seat; records what the session asked of it. */
function fakeGame(raceApplied?: number[], playerName = "") {
  const cars: DeformableCar[] = [makeCar(), makeCar()];
  const seat = new DriverSeat();
  /** Every `setSeats` call, as [car, name] pairs. */
  const seats: [number, string][][] = [];
  const matched: unknown[][] = [];
  const race = raceApplied
    ? {
        options: { ...DEFAULT_RACE_OPTIONS },
        look: 0,
        phase: null as RacePhase | null,
        /** Every `command` the session sent; an `options` one also applies, as the director does. */
        commands: [] as RaceCommand[],
        program: null as Partial<RaceOptions> | null,
        command(cmd: RaceCommand): void {
          this.commands.push(cmd);
          if (cmd.type === "options") Object.assign(this.options, cmd.options);
          if (cmd.type === "program") this.program = cmd.options;
        },
        setRemoteInput(_car: number, _input: DriveInput): void {},
        requestRespawn(_id?: number): void {},
        holdReset(_id?: number): void {},
        snapshot: (): RaceSnapshot | null => null,
        applySnapshot(snap: RaceSnapshot, _self: number): void {
          raceApplied.push(snap.laps);
        },
        showLobby(_trackId: string): void {},
      }
    : null;
  return {
    seats,
    matched,
    /** What `reelPlaying` answers. */
    playing: false,
    /** What `hostFit` answers. */
    fit: true,
    /** Whether race mode is on: `race()` answers null while it is off, the director (and its options) living on. */
    raceOn: true,
    seat,
    cars: () => cars,
    setCarCount(n: number): void {
      while (cars.length < n) cars.push(makeCar());
      cars.length = Math.max(1, n);
    },
    matchCar(i: number, style: unknown, cls: unknown): void {
      matched.push([i, style, cls]);
    },
    setRealism(): void {},
    phase: () => "approach" as const,
    timeScale: () => 1,
    mirrorClock(): void {},
    race(): typeof race {
      return this.raceOn ? race : null;
    },
    enterRace(): void {},
    exitRace(): void {},
    startRace(): void {},
    setSeats(m: ReadonlyMap<number, string>): void {
      seats.push([...m]);
    },
    playerName: () => playerName,
    hostFit(): boolean {
      return this.fit;
    },
    remoteDrivable: () => true,
    derbyPhase: () => null,
    derbyState: () => null,
    applyDerby(): void {},
    derbyLobby(): void {},
    startDerby(): void {},
    setVaporized(): void {},
    playReel(_reel: Reel, _startAt: number): void {},
    launchEjection(): void {},
    reelPlaying(): boolean {
      return this.playing;
    },
    /** The host's clear count (`clearGen`), bumped by a test the way a scene change, loop or reset bumps it. */
    gen: 0,
    /** How many times the session asked this engine to clear its scene (`clearScene`), which repairs every car like the engine's. */
    clears: 0,
    clearGen(): number {
      return this.gen;
    },
    clearScene(): void {
      this.clears++;
      for (const c of cars) c.resetVisual();
    },
    meterOf: () => null,
    /** What `playerLook` answers. */
    look: bareLook(),
    /** Every `wearLook` call, as [car, look]. */
    worn: [] as [number, LookData | null][],
    playerLook(): LookData {
      return this.look;
    },
    wearLook(i: number, look: LookData | null): void {
      this.worn.push([i, look]);
    },
    dropLooks(): void {},
  };
}

const open: NetPlay[] = [];
afterEach(() => {
  for (const n of open.splice(0)) n.leave();
});

/** A host and one guest in room R, linked through a `Hub`, on one fake clock (the guest's read `skewMs` ahead). */
function session(opts: { raceApplied?: number[]; name?: string; skewMs?: number; hostLook?: LookData; guestLook?: LookData } = {}) {
  const hub = new Hub();
  let now = 1000;
  const clock = () => now;
  const hg = fakeGame();
  const cg = fakeGame(opts.raceApplied, opts.name);
  if (opts.hostLook) hg.look = opts.hostLook;
  if (opts.guestLook) cg.look = opts.guestLook;
  const host = new NetPlay(hg, { connect: hub.connect, now: clock });
  const client = new NetPlay(cg, { connect: hub.connect, now: () => now + (opts.skewMs ?? 0) });
  open.push(host, client);
  host.host("R", "bc");
  client.join("R", "bc");
  let sent = 0;
  const s = {
    clock,
    hub,
    hg,
    cg,
    host,
    client,
    hostId: () => host.status().selfId,
    clientId: () => client.status().selfId,
    /** Host snapshots sent so far (one per host frame): the next one's seq is `sent + 1`. */
    sent: () => sent,
    advance(ms: number): void {
      now += ms;
    },
    /** `n` frames: the host drives its peers' cars and sends; the guest (unless hidden) renders and sends. */
    step(n = 1, who: { host?: boolean; client?: boolean } = {}): void {
      for (let k = 0; k < n; k++) {
        now += FRAME_MS;
        if (who.host !== false) {
          host.drive(hg.cars(), FRAME_MS / 1000, -1);
          host.frame(FRAME_MS / 1000);
          sent++;
        }
        if (who.client !== false) client.frame(FRAME_MS / 1000);
        hub.flush();
      }
    },
    /** The guest's seat drives its car with W held. */
    holdThrottle(): void {
      cg.seat.focus(client.status().car);
      cg.seat.mode = "drive";
      cg.seat.sample(new Set(["KeyW"]), null);
    },
    /** Speed (m/s) of the guest's car on the host. */
    hostSpeed(car = 1): number {
      return hg.cars()[car]!.velocity.length();
    },
  };
  s.step(20);
  assert.equal(client.status().car, 1, "the guest got car 1");
  return s;
}

/** A snapshot of `cars` as the host would send it, with `edit` applied to its frames. */
function forgedSnapshot(cars: DeformableCar[], seq: number, edit: (s: codec.Snapshot) => void): Uint8Array {
  const p = cars[0]!.partNetSizes();
  const L = { ...cars[0]!.deform.netSizes(), parts: p.parts, wheels: p.wheels };
  const s = codec.makeSnapshot();
  codec.ensureFrames(s, cars.length, L);
  s.seq = seq;
  s.time = 1;
  s.count = cars.length;
  edit(s);
  const w = new codec.Writer();
  codec.writeSnapshot(w, s, L);
  return w.done();
}

describe("given a guest that joined a room nobody hosts", () => {
  it("when its frames run for 4.5 s, then it shows no problem yet; at 5.5 s it reports the room has no host; and once a host opens the room the problem clears and the guest is seated in car 1", () => {
    const hub = new Hub();
    let now = 1000;
    const guestGame = fakeGame();
    const guest = new NetPlay(guestGame, { connect: hub.connect, now: () => now });
    open.push(guest);
    guest.join("R", "rtc");
    const frames = (ms: number, host?: NetPlay): void => {
      for (let t = 0; t < ms; t += FRAME_MS) {
        now += FRAME_MS;
        host?.drive(hostGame.cars(), FRAME_MS / 1000, -1);
        host?.frame(FRAME_MS / 1000);
        guest.frame(FRAME_MS / 1000);
        hub.flush();
      }
    };
    const hostGame = fakeGame();
    frames(HOST_WAIT_MS - 500);
    assert.equal(guest.status().problem, null, "not yet: the host may still be on its way");
    frames(1000);
    assert.equal(guest.status().problem, "no-host");
    const host = new NetPlay(hostGame, { connect: hub.connect, now: () => now });
    open.push(host);
    host.host("R", "rtc");
    frames(2000, host);
    assert.equal(guest.status().problem, null, "a host answered");
    assert.equal(guest.status().car, 1);
  });
});

describe("given a host and one guest seated in car 1", () => {
  it("when the link drops for a moment and returns, then the guest keeps car 1 and its held throttle drives the car again", () => {
    const s = session();
    s.holdThrottle();
    s.hub.setCut(s.hostId(), s.clientId(), true);
    s.step(10);
    s.hub.setCut(s.hostId(), s.clientId(), false);
    s.step(30);
    assert.equal(s.client.status().car, 1);
    assert.ok(s.hostSpeed() > 3, `the guest drives again after the blip (${s.hostSpeed().toFixed(2)} m/s)`);
  });

  it("when the link stays down for a minute and then returns, then the host frees the car and the guest reports the host lost, and on the return the guest is seated again in its car with its held throttle driving, never dropping to spectating", () => {
    const s = session();
    s.holdThrottle();
    s.hub.setCut(s.hostId(), s.clientId(), true);
    s.step(5);
    s.advance(60_000);
    s.step(5);
    assert.equal(s.host.remoteCar(1), false, "the host freed the car after the grace period");
    assert.equal(s.client.status().problem, "host-lost");
    s.hub.setCut(s.hostId(), s.clientId(), false);
    s.step(40);
    assert.equal(s.client.status().problem, null);
    assert.ok(s.host.remoteCar(1), "the guest is seated again in its car");
    assert.equal(s.cg.seat.mode, "drive", "the seat never dropped back to follow");
    assert.ok(s.hostSpeed() > 3, `and the throttle held through the outage drives it (${s.hostSpeed().toFixed(2)} m/s)`);
  });

  it("when the host stops hearing the guest for a minute while the guest still hears the host, then the host frees the car but the guest keeps car 1, and its next input seats it again and drives", () => {
    const s = session();
    s.hub.unlisted.add(s.clientId());
    s.step(5, { client: false });
    s.advance(60_000);
    s.step(5, { client: false });
    assert.equal(s.host.remoteCar(1), false, "the host freed the car after the grace period");
    assert.equal(s.client.status().car, 1, "the guest, still hearing the host, keeps driving car 1");
    s.hub.unlisted.delete(s.clientId());
    s.holdThrottle();
    s.step(30);
    assert.ok(s.host.remoteCar(1), "its next input seats it again");
    assert.ok(s.hostSpeed() > 3, `and drives (${s.hostSpeed().toFixed(2)} m/s)`);
  });

  it("when the host leaves and restarts in the same room, then the new host seats the guest in a car and the guest renders the new host's world", () => {
    const s = session();
    s.host.leave();
    const host2 = new NetPlay(s.hg, { connect: s.hub.connect, now: s.clock });
    open.push(host2);
    // The new host shares the session clock; the old one is gone, so step the pair by hand.
    host2.host("R", "bc");
    for (let k = 0; k < 6000 / FRAME_MS + 60; k++) {
      s.advance(FRAME_MS);
      host2.frame(FRAME_MS / 1000);
      s.client.frame(FRAME_MS / 1000);
      s.hub.flush();
    }
    assert.ok(host2.remoteCar(s.client.status().car), "the restarted host seated the guest");
    s.hg.cars()[0]!.group.position.x = 7;
    for (let k = 0; k < 20; k++) {
      s.advance(FRAME_MS);
      host2.frame(FRAME_MS / 1000);
      s.client.frame(FRAME_MS / 1000);
      s.hub.flush();
    }
    assert.ok(Math.abs(s.cg.cars()[0]!.group.position.x - 7) < 0.01, "the guest renders the new host's world");
  });

  it("when the host leaves, then every seat is freed, so a solo race or derby has no ghost players", () => {
    const s = session();
    assert.deepEqual(s.hg.seats.at(-1), [[1, "Player 1"]]);
    s.host.leave();
    assert.deepEqual(s.hg.seats.at(-1), []);
  });
});

describe("given a host and a guest who each picked colours and sprayed paint in the garage", () => {
  it("when the guest is seated, then the host's car 1 wears the guest's picks and spray texel for texel, the guest's car 0 wears the host's, and the guest's own car 1 wears the guest's own look", () => {
    const hostLook = bareLook();
    hostLook.car.body = 0x11aa33;
    hostLook.person.hat = 0xff0000;
    hostLook.carSpray.fill(4, 0, 900);
    const guestLook = bareLook();
    guestLook.car.rims = 0xffd700;
    guestLook.person.woman = true;
    for (let i = 0; i < guestLook.personSpray.length; i += 7) guestLook.personSpray[i] = (i % 15) + 1;
    const s = session({ hostLook, guestLook });
    const onHost = s.hg.worn.filter(([car]) => car === 1).at(-1)?.[1];
    const onGuest = s.cg.worn.filter(([car]) => car === 0).at(-1)?.[1];
    assert.ok(onHost && onGuest, "each side wore the other's look");
    assert.equal(carPickText(onHost.car), carPickText(guestLook.car), "the guest's car picks on the host");
    assert.equal(personPickText(onHost.person), personPickText(guestLook.person), "the guest's driver picks on the host");
    assertSameNumbers(onHost.personSpray, guestLook.personSpray, "the guest's driver spray on the host");
    assertSameNumbers(onHost.carSpray, guestLook.carSpray, "the guest's bare car spray on the host");
    assert.equal(carPickText(onGuest.car), carPickText(hostLook.car), "the host's car picks on the guest");
    assert.equal(personPickText(onGuest.person), personPickText(hostLook.person), "the host's driver picks on the guest");
    assertSameNumbers(onGuest.carSpray, hostLook.carSpray, "the host's car spray on the guest");
    assert.equal(s.cg.worn.some(([car, look]) => car === 1 && look !== null), false, "the guest's own seat never wears a look from the relay");
    assert.ok(s.cg.worn.some(([car, look]) => car === 1 && look === null), "the guest's own seat put on the guest's own look when seated");
  });
});

describe("given a host receiving a guest's hello", () => {
  it("when the hello's name has extra whitespace, control or text-direction characters and is over 16 characters, then the guest is seated under that name cleaned of them and cut to 16 characters", () => {
    const s = session({ name: "  Zed\u202E\u0000 the\tquick brown fox jumps  " });
    assert.deepEqual(s.hg.seats.at(-1), [[1, "Zed the quick br"]]);
  });

  it("when the hello carries no name (the field's older layout), then the guest is seated as Player 1", () => {
    const hub = new Hub();
    const hg = fakeGame();
    const host = new NetPlay(hg, { connect: hub.connect, now: () => 0 });
    open.push(host);
    host.host("R", "bc");
    hub.connect("bc", "R", "bare", "client").send(new Uint8Array([codec.MSG.hello, codec.NET_VERSION]));
    hub.flush();
    assert.deepEqual(hg.seats.at(-1), [[1, "Player 1"]]);
  });
});

describe("given a guest connected to its host, with other peers in the room", () => {
  it("when another peer in the room sends assignments and snapshots, then the guest ignores them, stays in car 1 and still applies the host's snapshots", () => {
    const s = session();
    const rogue = s.hub.connect("bc", "R", "rogue", "client");
    rogue.send(new Uint8Array([codec.MSG.assign, 5, codec.NET_VERSION ?? 0]), s.clientId());
    rogue.send(new Uint8Array([codec.MSG.snapshot, 0, 0xfe, 0x7f]), s.clientId());
    s.hub.flush();
    assert.equal(s.client.status().car, 1, "a peer other than the host cannot move the guest to another car");
    s.hg.cars()[0]!.group.position.x = 5;
    s.step(20);
    assert.ok(Math.abs(s.cg.cars()[0]!.group.position.x - 5) < 0.01, "the host's snapshots still apply");
  });

  it("when the host sends a snapshot the guest cannot decode, then the guest keeps applying the host's following snapshots", () => {
    const s = session();
    s.hub.sendAs(s.hostId(), s.clientId(), new Uint8Array([codec.MSG.snapshot, 0, 0xe8, 0x03]));
    s.hub.flush();
    s.hg.cars()[0]!.group.position.x = 5;
    s.step(20);
    assert.ok(Math.abs(s.cg.cars()[0]!.group.position.x - 5) < 0.01, "a truncated snapshot does not block the next ones");
  });

  it("when a snapshot with an unknown body or a non-finite pose arrives, then the guest refuses it: no car is rebuilt on an unknown body and no NaN pose reaches a car", () => {
    const s = session();
    const bad = forgedSnapshot(s.hg.cars(), s.sent() + 1, (snap) => {
      snap.cars[0]!.style = 15;
      snap.cars[0]!.cls = 15;
      snap.cars[1]!.x = Number.NaN;
    });
    s.cg.matched.length = 0;
    s.hub.sendAs(s.hostId(), s.clientId(), bad);
    s.hub.flush();
    for (let k = 0; k < 10; k++) {
      s.step();
      for (const car of s.cg.cars()) assert.ok(Number.isFinite(car.group.position.x), "no NaN pose reaches a car");
    }
    assert.ok(
      s.cg.matched.every(([, style, cls]) => typeof style === "string" && typeof cls === "string"),
      "no car is rebuilt on an unknown body",
    );
  });

  it("when a race state with an out-of-range lap count arrives, then it is not applied, while the same message with a sane lap count is", () => {
    const applied: number[] = [];
    const s = session({ raceApplied: applied });
    const snap = { trackId: "oval", laps: 1e9, noReset: false, phase: "racing", time: 1, lights: 3, winnerId: null, winBy: null, cars: [], order: [], firstAt: [] };
    const body = new TextEncoder().encode(JSON.stringify({ lobby: null, trackId: "oval", look: 0, snap }));
    s.hub.sendAs(s.hostId(), s.clientId(), new Uint8Array([codec.MSG.race, ...body]));
    s.hub.flush();
    assert.deepEqual(applied, []);
    // Control: the same message with a sane lap count is applied, so the empty list above is the lap check's.
    const ok = new TextEncoder().encode(JSON.stringify({ lobby: null, trackId: "oval", look: 0, snap: { ...snap, laps: 3 } }));
    s.hub.sendAs(s.hostId(), s.clientId(), new Uint8Array([codec.MSG.race, ...ok]));
    s.hub.flush();
    assert.deepEqual(applied, [3]);
  });
});

describe("given a host and a peer running another build", () => {
  it("when the peer says hello, then the host seats it in no car and tells it that it cannot join", () => {
    const hub = new Hub();
    const host = new NetPlay(fakeGame(), { connect: hub.connect, now: () => 0 });
    open.push(host);
    host.host("R", "bc");
    const old = hub.connect("bc", "R", "old", "client");
    const got: number[][] = [];
    old.onMessage = (_from, data) => got.push([...data]);
    old.send(new Uint8Array([codec.MSG.hello]));
    hub.flush();
    host.frame(FRAME_MS / 1000);
    hub.flush();
    assert.equal(host.remoteCar(1), false, "a hello without this build's version takes no car");
    const assign = got.find((m) => m[0] === codec.MSG.assign);
    assert.ok(assign && assign[1] === 255, "it is told it cannot join");
  });
});

describe("given a host with one guest driving at full throttle", () => {
  it("when the guest's input stops arriving, then its car on the host idles and coasts down", () => {
    const s = session();
    s.holdThrottle();
    s.step(30);
    const moving = s.hostSpeed();
    assert.ok(moving > 3);
    s.step(30, { client: false });
    assert.ok(s.hostSpeed() < moving, `the car coasts down (${moving.toFixed(2)} → ${s.hostSpeed().toFixed(2)} m/s)`);
  });

  it("when the guest's tab is hidden, then its car on the host idles at once", () => {
    const s = session();
    s.holdThrottle();
    s.step(30);
    const moving = s.hostSpeed();
    s.client.setHidden(true);
    s.hub.flush();
    s.step(3, { client: false });
    assert.ok(s.hostSpeed() < moving, `no full-throttle zombie (${moving.toFixed(2)} → ${s.hostSpeed().toFixed(2)} m/s)`);
  });
});

describe("given a guest connected to a host whose tab is hidden", () => {
  it("when the host stays hidden and then really leaves, then the guest reports the host paused while it waits, and host lost once it is gone, keeping its car, camera and held pedal to seat again", () => {
    const s = session();
    s.step(30, { host: false });
    s.advance(4000);
    s.host.setHidden(true);
    s.hub.flush();
    s.advance(4000);
    s.step(1, { host: false });
    assert.equal(s.client.status().car, 1, "a paused host keeps its guests");
    assert.equal(s.client.status().problem, "host-paused");
    s.host.leave();
    s.advance(6000);
    s.step(1, { host: false });
    assert.equal(s.client.status().problem, "host-lost");
    assert.equal(s.client.status().car, 1, "it keeps its car (camera, held pedal) while it asks for a seat again");
  });
});

describe("given a client whose scene is cleared when the host's clear count changes (a scene change, loop or reset)", () => {
  const torn = (car: DeformableCar): number => car["parts"].filter((p) => p.detached).length;
  const tear = (car: DeformableCar): void => car["detachPart"](car["parts"].find((p) => p.region)!, 12);

  it("when the host's clear count changes, then the client's scene is emptied once, and a steady count never empties it", () => {
    const s = session();
    s.step(10);
    assert.equal(s.cg.clears, 0, "joining a running scene clears nothing");
    tear(s.cg.cars()[1]!);
    s.step(10);
    assert.equal(s.cg.clears, 0, "a steady count leaves the client's scene alone");
    assert.equal(torn(s.cg.cars()[1]!), 1, "the torn part is still there before the host clears");
    s.hg.gen = 1;
    s.step(10);
    assert.equal(s.cg.clears, 1, "one clear for one change");
    assert.equal(torn(s.cg.cars()[1]!), 0, "the client's torn part is gone");
    s.step(30);
    assert.equal(s.cg.clears, 1, "the new count is not cleared again");
  });

  it("when the host clears just before the new scene's own wreck, then a crash right after the host's clear survives on the client", () => {
    const s = session();
    s.step(10);
    s.hg.gen = 1;
    const host = s.hg.cars()[0]!;
    host.crashed = true;
    tear(host);
    s.step(10);
    assert.equal(s.cg.clears, 1);
    assert.equal(s.cg.cars()[0]!.crashed, true, "the client shows the new scene's crash");
    assert.equal(torn(s.cg.cars()[0]!), 1, "the new scene's torn part is drawn, not wiped by the clear");
  });

  it("when the results reel is playing, then the client does not clear, and does so once the reel ends if the host cleared meanwhile", () => {
    const s = session();
    s.step(10);
    s.cg.playing = true;
    s.hg.gen = 3;
    s.step(10);
    assert.equal(s.cg.clears, 0, "the reel owns the cars");
    s.cg.playing = false;
    s.step(10);
    assert.equal(s.cg.clears, 1, "back to the host's scene: its clear lands");
  });
});

describe("given a guest whose host sends the highlight reel", () => {
  it("when the host's reel arrives, then it plays at its start time moved onto the guest's clock, and no snapshots are drawn while it plays", { timeout: 5000 }, async () => {
    const s = session({ skewMs: 5000 });
    // Executor form: the tsconfig lib predates `Promise.withResolvers`.
    const played = new Promise<[Reel, number]>((resolve) => {
      s.cg.playReel = (reel, startAt) => resolve([reel, startAt]);
    });
    const hostStart = s.clock() / 1000 + 3;
    for (const part of reelParts(await packReel({ seed: 7, clips: [] }, hostStart))) s.host.sendReliable(part);
    s.hub.flush();
    const [reel, startAt] = await played;
    assert.equal(reel.seed, 7);
    assert.ok(Math.abs(startAt - (hostStart + 5)) < 1e-6, `starts at host ${hostStart} + 5 s skew (${startAt})`);

    s.cg.playing = true;
    s.hg.cars()[0]!.group.position.x = 5;
    s.step(20);
    assert.ok(Math.abs(s.cg.cars()[0]!.group.position.x - 5) > 1, "the reel keeps the cars while it plays");
    s.cg.playing = false;
    s.step(20);
    assert.ok(Math.abs(s.cg.cars()[0]!.group.position.x - 5) < 0.01, "snapshots draw again once it ends");
  });

  it("when a reel larger than the relay's message cap is sent, then it reaches the guest with every clip", { timeout: 20000 }, async () => {
    const s = session();
    const played = new Promise<Reel>((resolve) => {
      s.cg.playReel = (reel) => resolve(reel);
    });
    const { clip } = makeClip();
    // Incompressible inputs and schedules: five clips that deflate to over the cap together.
    let seed = 1;
    const next = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    const noise = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => next() >>> 24);
    const steps = 8000;
    const shape = Uint32Array.from({ length: steps }, () => next() >>> 13);
    const big = { ...clip, h: new Float32Array(steps).fill(1 / 240), shape, inputs: noise(steps * 2 * INPUT_BYTES) };
    const clips = [big, { ...big, score: 9 }, { ...big, score: 8 }, { ...big, score: 7 }, { ...big, score: 6 }];
    const msg = await packReel({ seed: 5, clips }, s.clock() / 1000 + 3);
    assert.ok(msg.length > RELAY_MSG_MAX, `precondition: the reel is ${msg.length} bytes, over the cap`);
    const parts = reelParts(msg);
    assert.ok(parts.length > 1 && parts.every((p) => p.length <= RELAY_MSG_MAX), "no frame over the cap");
    for (const part of parts) s.host.sendReliable(part);
    s.hub.flush();
    const reel = await played;
    assert.equal(reel.clips.length, 5, "every clip arrives");
    sameClip(reel.clips[0]!, big);
    sameClip(reel.clips[4]!, clips[4]!);
  });
});

describe("given public matches played over a stubbed relay on a virtual clock", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  const dead = publicRoomName("race", "AAAA");
  /** What the relay lists; `addrs` (distinct addresses) is the room's `players` unless a test says otherwise. */
  const listing = (rooms: { room: string; players: number; addrs?: number; meta?: string }[]) => async () =>
    new Response(JSON.stringify({ rooms: rooms.map((r) => ({ addrs: r.players, ...r })) }));
  /** A virtual clock: a search's pauses advance it and nothing else waits. */
  const virtual = (start = 1000) => {
    const t = { now: start };
    return { t, opts: { now: () => t.now, sleep: async (ms: number) => void (t.now += ms), random: () => 0 } };
  };
  /** Lets a search a frame loop started (not awaited) run to its end. */
  const settle = async (np: NetPlay) => {
    for (let k = 0; k < 50 && np.status().finding; k++) await new Promise((resolve) => setImmediate(resolve));
  };
  /** `ms` of the guests' frame time, the hub moving messages between steps. */
  const run = (hub: Hub, t: { now: number }, ms: number, who: NetPlay[]) => {
    for (let k = 0; k < ms / FRAME_MS; k++) {
      t.now += FRAME_MS;
      for (const n of who) n.frame(FRAME_MS / 1000);
      hub.flush();
    }
  };
  /** A guest that pressed Play online against `names` (all open, none with a live host): the rooms it linked to, in order. */
  const guestOf = async (names: string[]) => {
    const hub = new Hub();
    const v = virtual();
    const linked: string[] = [];
    const client = new NetPlay(fakeGame(), {
      connect: (tx, room, id, role, meta) => {
        linked.push(`${role} ${room}`);
        return hub.connect(tx, room, id, role, meta);
      },
      ...v.opts,
    });
    open.push(client);
    globalThis.fetch = listing(names.map((room) => ({ room, players: 1, meta: "lobby.oval" })));
    await client.publicMatch("race");
    /** Waits out the silence that makes the guest give up on its room, and the search that follows. */
    const dwell = async () => {
      run(hub, v.t, 7000, [client]);
      await settle(client);
    };
    return { hub, v, client, linked, dwell };
  };

  it("given a guest in a public room, when the host of that room leaves, then the stranded guest hosts a fresh public room of its own", async () => {
    const hub = new Hub();
    const v = virtual();
    const host = new NetPlay(fakeGame(), { connect: hub.connect, now: v.opts.now });
    const client = new NetPlay(fakeGame(), { connect: hub.connect, ...v.opts });
    open.push(host, client);
    host.host(dead, "rtc");
    globalThis.fetch = listing([{ room: dead, players: 1, meta: "lobby.oval" }]);
    await client.publicMatch("race");
    const step = (frames: number, who: NetPlay[]) => {
      for (let k = 0; k < frames; k++) {
        v.t.now += FRAME_MS;
        for (const n of who) n.frame(FRAME_MS / 1000);
        hub.flush();
      }
    };
    step(20, [host, client]);
    assert.equal(client.status().role, "client");
    assert.equal(client.status().car, 1);
    host.leave();
    step(7000 / FRAME_MS, [client]);
    await settle(client);
    const st = client.status();
    assert.equal(st.role, "host", "the stranded guest hosts instead");
    assert.equal(st.public, "race");
    assert.notEqual(st.room, dead);
    assert.equal(st.finding, false);
  });

  it("given a public guest in an open room, when its page loads with its engine running no frames for 9 s and again when it stalls 9 s mid-session, then it stays in the room as car 1 both times", async () => {
    const hub = new Hub();
    let now = 1000;
    const host = new NetPlay(fakeGame(), { connect: hub.connect, now: () => now });
    const client = new NetPlay(fakeGame(), { connect: hub.connect, now: () => now });
    open.push(host, client);
    host.host(dead, "rtc");
    globalThis.fetch = listing([{ room: dead, players: 1 }]);
    const run = (ms: number, client_ = true) => {
      for (let k = 0; k < ms / FRAME_MS; k++) {
        now += FRAME_MS;
        host.frame(FRAME_MS / 1000);
        if (client_) client.frame(FRAME_MS / 1000);
        hub.flush();
      }
    };
    // A page that just loaded (or reloaded) joins, then its engine's boot warm-up runs no frames for 9 s.
    await client.publicMatch("race");
    run(9000, false);
    run(1000);
    assert.deepEqual([client.status().role, client.status().room === dead, client.status().car], ["client", true, 1]);
    // A 9 s stall mid-session (a course loading): the host's messages wait in the queue behind the client's next frame.
    now += 9000;
    client.frame(0.1);
    run(1000);
    assert.deepEqual([client.status().role, client.status().room === dead, client.status().car], ["client", true, 1]);
  });

  it("given a weak device with nothing to join, when it presses Play online, then it looks, hosts a field of 4 (the player plus 3 AI cars) without changing the player's own AI count, and drops that field on leaving", async () => {
    const v = virtual();
    const g = fakeGame([]);
    g.fit = false;
    const np = new NetPlay(g, { connect: new Hub().connect, ...v.opts });
    open.push(np);
    globalThis.fetch = listing([]);
    const searching = np.publicMatch("race");
    assert.equal(np.status().finding, true);
    await searching;
    assert.deepEqual([np.status().role, np.status().public, np.status().finding], ["host", "race", false]);
    assert.equal(g.race()!.program?.aiCount, 3, "a weak host's field is the player plus 3");
    assert.equal(g.race()!.options.aiCount, DEFAULT_RACE_OPTIONS.aiCount, "the player's own field size stays");
    np.leave();
    assert.equal(g.race()!.program, null, "a solo race is back to its own field");
    assert.equal(g.race()!.options.aiCount, DEFAULT_RACE_OPTIONS.aiCount);
  });

  it("given a device able to host with nothing to join, when it presses Play online, then it hosts a full field at once, within 5 s of the start", async () => {
    const v = virtual();
    const g = fakeGame([]);
    const np = new NetPlay(g, { connect: new Hub().connect, ...v.opts });
    open.push(np);
    globalThis.fetch = listing([]);
    await np.publicMatch("race");
    assert.equal(np.status().role, "host");
    assert.equal(g.race()!.options.aiCount, DEFAULT_RACE_OPTIONS.aiCount);
    assert.ok(v.t.now - 1000 < 5000, "no long search before hosting");
  });

  it("given a Play online search in progress, when the player leaves, then no room is joined or hosted afterwards", async () => {
    const v = virtual();
    const np = new NetPlay(fakeGame(), { connect: new Hub().connect, ...v.opts });
    open.push(np);
    let release = (): void => {};
    globalThis.fetch = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return new Response(JSON.stringify({ rooms: [{ room: dead, players: 1 }] }));
    };
    const searching = np.publicMatch("race");
    np.leave();
    release();
    await searching;
    assert.deepEqual([np.status().role, np.status().finding], ["off", false]);
  });

  it("given a public host, when its match goes through lobby, grid, countdown, racing and finished, then its relay tag reads lobby, running, running, running, over with the course, and a guest sends none", () => {
    const hub = new Hub();
    const g = fakeGame([]);
    const host = new NetPlay(g, { connect: hub.connect });
    const guest = new NetPlay(fakeGame([]), { connect: hub.connect });
    open.push(host, guest);
    host.publicHost("race", false);
    const tag = hub.metas.get(host.status().selfId)!;
    const seen: string[] = [];
    for (const phase of [null, "grid", "countdown", "racing", "finished"] as const) {
      g.race()!.phase = phase;
      seen.push(tag());
    }
    assert.deepEqual(seen, ["lobby.oval", "running.oval", "running.oval", "running.oval", "over.oval"]);
    guest.publicJoin(dead, "race");
    assert.equal(hub.metas.get(guest.status().selfId)!(), "");
  });

  it("given two public rooms whose hosts never answer, when a guest presses Play online, then it tries each once, never goes back to either, and then hosts", async () => {
    const [x, y] = ["AAAA", "BBBB"].map((c) => publicRoomName("race", c));
    const g = await guestOf([x!, y!]);
    for (let k = 0; k < 3; k++) await g.dwell();
    assert.equal(g.linked.length, 3, g.linked.join(" | "));
    assert.equal(g.linked.slice(0, 2).join(" | "), `client ${x} | client ${y}`);
    assert.match(g.linked[2]!, /^host pub-race-/);
  });

  it("given four public rooms whose hosts never answer, when a guest presses Play online, then after 3 dead rooms in a row it hosts instead of trying a fourth", async () => {
    const names = ["AAAA", "BBBB", "CCCC", "DDDD"].map((c) => publicRoomName("race", c));
    const g = await guestOf(names);
    for (let k = 0; k < 4; k++) await g.dwell();
    assert.equal(g.linked.length, 4, g.linked.join(" | "));
    assert.equal(g.linked.slice(0, 3).join(" | "), names.slice(0, 3).map((n) => `client ${n}`).join(" | "));
    assert.match(g.linked[3]!, /^host pub-race-/);
  });

  it("given four public rooms where the second host answers and then leaves, when a guest presses Play online, then that room does not count toward the dead rooms, so the guest tries all four before hosting", async () => {
    const names = ["AAAA", "BBBB", "CCCC", "DDDD"].map((c) => publicRoomName("race", c));
    const g = await guestOf(names);
    await g.dwell();
    const host = new NetPlay(fakeGame(), { connect: g.hub.connect, now: g.v.opts.now });
    open.push(host);
    host.host(names[1]!, "rtc");
    run(g.hub, g.v.t, 700, [host, g.client]);
    assert.equal(g.client.status().car, 1, "the second room's host answered");
    host.leave();
    await g.dwell();
    await g.dwell();
    await g.dwell();
    assert.equal(g.linked.slice(0, 4).join(" | "), names.map((n) => `client ${n}`).join(" | "), "dead, answered, dead, dead: the answering room broke the streak");
  });

  it("given a guest whose last search gave up on two dead rooms, when the player leaves and presses Play online again, then the search starts over with the first room in the list", async () => {
    const [x, y] = ["AAAA", "BBBB"].map((c) => publicRoomName("race", c));
    const g = await guestOf([x!, y!]);
    await g.dwell();
    await g.dwell();
    g.client.leave();
    await g.client.publicMatch("race");
    assert.equal(g.linked.at(-1), `client ${x}`, "first in the list again");
  });

  it("given a weak host, when race mode closes before it leaves, then the player's own AI count was never changed and is the default once race mode is on again", async () => {
    const v = virtual();
    const g = fakeGame([]);
    g.fit = false;
    const np = new NetPlay(g, { connect: new Hub().connect, ...v.opts });
    open.push(np);
    globalThis.fetch = listing([]);
    await np.publicMatch("race");
    assert.equal(g.race()!.options.aiCount, DEFAULT_RACE_OPTIONS.aiCount);
    g.raceOn = false;
    np.leave();
    g.raceOn = true;
    assert.equal(g.race()!.options.aiCount, DEFAULT_RACE_OPTIONS.aiCount);
  });

  it("given a public host on the real WebRTC transport against a stubbed relay, when it makes its first relay poll, then that poll already carries the lobby tag", async () => {
    const polls: string[] = [];
    globalThis.fetch = async (input, init) => {
      if (init?.method !== "POST") polls.push(String(input));
      return new Response(JSON.stringify({ token: "t", peers: [], signals: [] }));
    };
    // The default link: the real `RtcTransport`, whose room polls the stubbed relay.
    const np = new NetPlay(fakeGame([]), virtual().opts);
    open.push(np);
    np.publicHost("race", false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(polls.length, 1);
    assert.equal(new URL(polls[0]!, "http://relay.test").searchParams.get("meta"), "lobby.oval");
  });
});
