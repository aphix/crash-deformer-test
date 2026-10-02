import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { DriverSeat, type DriveInput } from "../car-drive.ts";
import type { DeformableCar } from "../car.ts";
import { makeCar } from "../crash-scenarios.test-util.ts";
import { DEFAULT_RACE_OPTIONS, type RaceSnapshot } from "../race/types.ts";
import * as codec from "./codec.ts";
import { NetPlay, type NetTx } from "./net-play.ts";
import type { NetPeer, NetTransport } from "./transport.ts";

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

  readonly connect = (_tx: NetTx, _room: string, id: string, role: "host" | "client"): NetTransport => {
    const end = new Link(this, id, role);
    this.ends.set(id, end);
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
function fakeGame(raceApplied?: number[]) {
  const cars: DeformableCar[] = [makeCar(), makeCar()];
  const seat = new DriverSeat();
  const seats: number[][] = [];
  const matched: unknown[][] = [];
  const race = raceApplied
    ? {
        options: { ...DEFAULT_RACE_OPTIONS },
        phase: null,
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
    race: () => race,
    enterRace(): void {},
    exitRace(): void {},
    startRace(): void {},
    setSeats(c: readonly number[]): void {
      seats.push([...c]);
    },
    remoteDrivable: () => true,
    derbyPhase: () => null,
    derbyState: () => null,
    applyDerby(): void {},
    derbyLobby(): void {},
    startDerby(): void {},
    setVaporized(): void {},
  };
}

const open: NetPlay[] = [];
afterEach(() => {
  for (const n of open.splice(0)) n.leave();
});

/** A host and one guest in room R, linked through a `Hub`, on one fake clock. */
function session(opts: { raceApplied?: number[] } = {}) {
  const hub = new Hub();
  let now = 1000;
  const clock = () => now;
  const hg = fakeGame();
  const cg = fakeGame(opts.raceApplied);
  const host = new NetPlay(hg, { connect: hub.connect, now: clock });
  const client = new NetPlay(cg, { connect: hub.connect, now: clock });
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
    assert.deepEqual(s.hg.seats.at(-1), [1]);
    s.host.leave();
    assert.deepEqual(s.hg.seats.at(-1), []);
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

describe("netplay session: public matches", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("hosts a fresh public room when the host of the one it joined leaves", async () => {
    const hub = new Hub();
    let now = 1000;
    const hg = fakeGame();
    const host = new NetPlay(hg, { connect: hub.connect, now: () => now });
    const client = new NetPlay(fakeGame(), { connect: hub.connect, now: () => now });
    open.push(host, client);
    host.host("pub-race-AAAA", "rtc");
    globalThis.fetch = async () => new Response(JSON.stringify({ rooms: [{ room: "pub-race-AAAA", players: 1 }] }));
    await client.publicMatch("race");
    for (let k = 0; k < 20; k++) {
      now += FRAME_MS;
      host.frame(FRAME_MS / 1000);
      client.frame(FRAME_MS / 1000);
      hub.flush();
    }
    assert.equal(client.status().role, "client");
    assert.equal(client.status().car, 1);
    host.leave();
    for (let k = 0; k < 7000 / FRAME_MS; k++) {
      now += FRAME_MS;
      client.frame(FRAME_MS / 1000);
      hub.flush();
    }
    const st = client.status();
    assert.equal(st.role, "host", "the stranded guest hosts instead");
    assert.equal(st.public, "race");
    assert.notEqual(st.room, "pub-race-AAAA");
  });

  it("keeps a public guest in the open room through its own long frame stalls", async () => {
    const hub = new Hub();
    let now = 1000;
    const host = new NetPlay(fakeGame(), { connect: hub.connect, now: () => now });
    const client = new NetPlay(fakeGame(), { connect: hub.connect, now: () => now });
    open.push(host, client);
    host.host("pub-race-AAAA", "rtc");
    globalThis.fetch = async () => new Response(JSON.stringify({ rooms: [{ room: "pub-race-AAAA", players: 1 }] }));
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
    assert.deepEqual([client.status().role, client.status().room, client.status().car], ["client", "pub-race-AAAA", 1]);
    // A 9 s stall mid-session (a course loading): the host's messages wait in the queue behind the client's next frame.
    now += 9000;
    client.frame(0.1);
    run(1000);
    assert.deepEqual([client.status().role, client.status().room, client.status().car], ["client", "pub-race-AAAA", 1]);
  });
});
