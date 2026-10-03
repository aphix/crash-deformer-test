import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DriverSeat, type DriveInput } from "../vehicle/car-drive.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { makeCar } from "../contact/crash-scenarios.test-util.ts";
import { DEFAULT_RACE_OPTIONS, type RaceCommand, type RacePhase, type RaceSnapshot } from "../match/types.ts";
import type { Reel } from "../match/highlights.ts";
import * as codec from "./codec.ts";
import { NetPlay } from "./net-play.ts";
import type { NetTx } from "./net-ports.ts";
import { publicRoomName } from "./matchmaking.ts";
import type { NetPeer, NetTransport } from "./transport.ts";
import { packReel } from "./reel-codec.ts";
import { HOST_WAIT_MS } from "./net-constants.ts";

/** Frame time (ms) of the session loop: one host snapshot and one guest input per step. */
const FRAME_MS = 1000 / 30;

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

class Link implements NetTransport {
  onMessage: ((from: string, data: Uint8Array) => void) | null = null;
  closed = false;
  readonly selfId: string;
  private readonly hub: Hub;
  private readonly role: "host" | "client";

  constructor(hub: Hub, id: string, role: "host" | "client") {
    this.hub = hub;
    this.selfId = id;
    this.role = role;
  }

  send(data: Uint8Array, to?: string): void {
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
        phase: null as RacePhase | null,
        /** Every `command` the session sent; an `options` one also applies, as the director does. */
        commands: [] as RaceCommand[],
        command(cmd: RaceCommand): void {
          this.commands.push(cmd);
          if (cmd.type === "options") Object.assign(this.options, cmd.options);
        },
        setRemoteInput(_car: number, _input: DriveInput): void {},
        requestRespawn(_id?: number): void {},
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
    reelPlaying(): boolean {
      return this.playing;
    },
  };
}

const open: NetPlay[] = [];
afterEach(() => {
  for (const n of open.splice(0)) n.leave();
});

/** A host and one guest in room R, linked through a `Hub`, on one fake clock (the guest's read `skewMs` ahead). */
function session(opts: { raceApplied?: number[]; name?: string; skewMs?: number } = {}) {
  const hub = new Hub();
  let now = 1000;
  const clock = () => now;
  const hg = fakeGame();
  const cg = fakeGame(opts.raceApplied, opts.name);
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

describe("netplay session: a link to a room nobody hosts", () => {
  it("tells the guest `no-host` after HOST_WAIT_MS of frames, and a host opening the room clears it", () => {
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

describe("netplay session: a guest's seat survives the network", () => {
  it("keeps a guest's car through a connection blip, and its input drives on", () => {
    const s = session();
    s.holdThrottle();
    s.hub.setCut(s.hostId(), s.clientId(), true);
    s.step(10);
    s.hub.setCut(s.hostId(), s.clientId(), false);
    s.step(30);
    assert.equal(s.client.status().car, 1);
    assert.ok(s.hostSpeed() > 3, `the guest drives again after the blip (${s.hostSpeed().toFixed(2)} m/s)`);
  });

  it("re-seats a guest whose car lapsed during a long outage once the link is back, its held pedal still driving", () => {
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

  it("re-seats a guest whose car lapsed while it still heard the host, as soon as its input arrives", () => {
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

  it("re-seats the guest and follows the new host when the host restarts in the same room", () => {
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

  it("frees every seat when the host leaves, so a solo race or derby has no ghost players", () => {
    const s = session();
    assert.deepEqual(s.hg.seats.at(-1), [[1, "Player 1"]]);
    s.host.leave();
    assert.deepEqual(s.hg.seats.at(-1), []);
  });

  it("seats the guest under the name its hello carried, cleaned (whitespace folded, control and bidi characters dropped) and capped at 16", () => {
    const s = session({ name: "  Zed\u202E\u0000 the\tquick brown fox jumps  " });
    assert.deepEqual(s.hg.seats.at(-1), [[1, "Zed the quick br"]]);
  });

  it("seats a hello without a name (the field's older layout) as Player N", () => {
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

describe("netplay session: a client listens to its host only", () => {
  it("ignores assign and snapshots from another peer in the room", () => {
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

  it("keeps taking the host's snapshots after one it cannot decode", () => {
    const s = session();
    s.hub.sendAs(s.hostId(), s.clientId(), new Uint8Array([codec.MSG.snapshot, 0, 0xe8, 0x03]));
    s.hub.flush();
    s.hg.cars()[0]!.group.position.x = 5;
    s.step(20);
    assert.ok(Math.abs(s.cg.cars()[0]!.group.position.x - 5) < 0.01, "a truncated snapshot does not block the next ones");
  });

  it("refuses a snapshot with an unknown body or a non-finite pose", () => {
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

  it("does not apply a race state with an out-of-range lap count", () => {
    const applied: number[] = [];
    const s = session({ raceApplied: applied });
    const snap = { trackId: "oval", laps: 1e9, noReset: false, phase: "racing", time: 1, lights: 3, winnerId: null, winBy: null, cars: [], order: [], firstAt: [] };
    const body = new TextEncoder().encode(JSON.stringify({ lobby: null, trackId: "oval", snap }));
    s.hub.sendAs(s.hostId(), s.clientId(), new Uint8Array([codec.MSG.race, ...body]));
    s.hub.flush();
    assert.deepEqual(applied, []);
  });

  it("is not seated by a host on another build, and the host does not seat a peer on another build", () => {
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

describe("netplay session: stale input and hidden tabs", () => {
  it("idles a guest's car on the host once its input stops arriving", () => {
    const s = session();
    s.holdThrottle();
    s.step(30);
    const moving = s.hostSpeed();
    assert.ok(moving > 3);
    s.step(30, { client: false });
    assert.ok(s.hostSpeed() < moving, `the car coasts down (${moving.toFixed(2)} → ${s.hostSpeed().toFixed(2)} m/s)`);
  });

  it("idles a hidden guest's car at once", () => {
    const s = session();
    s.holdThrottle();
    s.step(30);
    const moving = s.hostSpeed();
    s.client.setHidden(true);
    s.hub.flush();
    s.step(3, { client: false });
    assert.ok(s.hostSpeed() < moving, `no full-throttle zombie (${moving.toFixed(2)} → ${s.hostSpeed().toFixed(2)} m/s)`);
  });

  it("keeps guests waiting for a host whose tab is hidden, and reports the host gone once it really is", () => {
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

describe("netplay session: the highlight reel", () => {
  it("plays the host's reel at its start time moved onto the guest's clock, and draws no snapshots while one plays", { timeout: 5000 }, async () => {
    const s = session({ skewMs: 5000 });
    // Executor form: the tsconfig lib predates `Promise.withResolvers`.
    const played = new Promise<[Reel, number]>((resolve) => {
      s.cg.playReel = (reel, startAt) => resolve([reel, startAt]);
    });
    const hostStart = s.clock() / 1000 + 3;
    s.host.sendReel((await packReel({ seed: 7, clips: [] }, hostStart)).msg);
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
});

describe("netplay session: public matches", () => {
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

  it("hosts a fresh public room when the host of the one it joined leaves", async () => {
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

  it("keeps a public guest in the open room through its own long frame stalls", async () => {
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

  it("a weak device with nothing to join hosts a field of 4 after looking, and gives its AI count back on leaving", async () => {
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
    assert.equal(g.race()!.options.aiCount, 3, "a weak host's field is the player plus 3");
    np.leave();
    assert.equal(g.race()!.options.aiCount, DEFAULT_RACE_OPTIONS.aiCount, "a solo race is back to its own field");
  });

  it("a capable device with nothing to join hosts a full field at once", async () => {
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

  it("leaving cancels a search: no room is joined or hosted afterwards", async () => {
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

  it("a public host's relay tag follows its match: lobby, running, over, with the course; a guest sends none", () => {
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

  it("a guest never goes back to a room it gave up on: two dead rooms, then it hosts", async () => {
    const [x, y] = ["AAAA", "BBBB"].map((c) => publicRoomName("race", c));
    const g = await guestOf([x!, y!]);
    for (let k = 0; k < 3; k++) await g.dwell();
    assert.equal(g.linked.length, 3, g.linked.join(" | "));
    assert.equal(g.linked.slice(0, 2).join(" | "), `client ${x} | client ${y}`);
    assert.match(g.linked[2]!, /^host pub-race-/);
  });

  it("after 3 dead rooms in a row it hosts instead of trying a fourth", async () => {
    const names = ["AAAA", "BBBB", "CCCC", "DDDD"].map((c) => publicRoomName("race", c));
    const g = await guestOf(names);
    for (let k = 0; k < 4; k++) await g.dwell();
    assert.equal(g.linked.length, 4, g.linked.join(" | "));
    assert.equal(g.linked.slice(0, 3).join(" | "), names.slice(0, 3).map((n) => `client ${n}`).join(" | "));
    assert.match(g.linked[3]!, /^host pub-race-/);
  });

  it("a room that answered and then lost its host does not count toward the dead rooms", async () => {
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

  it("a player's own Play online forgets the rooms the last search gave up on", async () => {
    const [x, y] = ["AAAA", "BBBB"].map((c) => publicRoomName("race", c));
    const g = await guestOf([x!, y!]);
    await g.dwell();
    await g.dwell();
    g.client.leave();
    await g.client.publicMatch("race");
    assert.equal(g.linked.at(-1), `client ${x}`, "first in the list again");
  });

  it("a weak host gives its solo AI count back even when race mode closed before it left", async () => {
    const v = virtual();
    const g = fakeGame([]);
    g.fit = false;
    const np = new NetPlay(g, { connect: new Hub().connect, ...v.opts });
    open.push(np);
    globalThis.fetch = listing([]);
    await np.publicMatch("race");
    assert.equal(g.race()!.options.aiCount, 3);
    g.raceOn = false;
    np.leave();
    g.raceOn = true;
    assert.equal(g.race()!.options.aiCount, DEFAULT_RACE_OPTIONS.aiCount);
  });

  it("a public host's first relay poll already carries its match tag", async () => {
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
