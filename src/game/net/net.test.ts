import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { idleDrive } from "../vehicle/car-drive.ts";
import { DerbyMatch } from "../match/derby.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { makeCar, runWall } from "../contact/crash-scenarios.test-util.ts";
import { assertSameDigest, assertSameNumbers, forModes } from "../vehicle/test-support.ts";
import {
  ensureFrames,
  makeCarFrame,
  makeSnapshot,
  Q,
  readDerby,
  readInput,
  Reader,
  readSnapshot,
  writeDerby,
  writeInput,
  writeSnapshot,
  Writer,
  type CarFrame,
  type DerbyNetState,
  type NetLayout,
  type Snapshot,
} from "./codec.ts";

const L: NetLayout = { masses: 20, clusters: 16, sensors: 21, parts: 8, wheels: 4 };

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  assert.equal(a.length, b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

function layoutOf(car: DeformableCar): NetLayout {
  const p = car.partNetSizes();
  return { ...car.deform.netSizes(), parts: p.parts, wheels: p.wheels };
}

/** The host car's frame after a trip through the wire (`writeSnapshot` → `readSnapshot`). */
function wire(host: DeformableCar): CarFrame {
  const L = layoutOf(host);
  const out = makeSnapshot();
  ensureFrames(out, 1, L);
  out.count = 1;
  const f = out.cars[0]!;
  f.x = host.group.position.x;
  f.y = host.group.position.y;
  f.z = host.group.position.z;
  f.pitch = host.group.rotation.x;
  f.yaw = host.group.rotation.y;
  f.roll = host.group.rotation.z;
  f.crashed = host.crashed;
  f.wreck = true;
  host.deform.readNetState(f.deform);
  host.readPartNetState(f.parts);
  const w = new Writer();
  writeSnapshot(w, out, L);
  const got = makeSnapshot();
  readSnapshot(new Reader().reset(w.done()), got, L);
  return got.cars[0]!;
}

/** Applies a frame the way NetPlay does: pose first, then the wreck. */
function apply(client: DeformableCar, g: CarFrame): DeformableCar {
  client.group.position.set(g.x, g.y, g.z);
  client.group.rotation.set(g.pitch, g.yaw, g.roll, "YXZ");
  client.crashed = g.crashed;
  client.refreshBasis();
  client.writeNetState(g.deform, g.parts);
  return client;
}

function looseParts(car: DeformableCar): number {
  const f = makeCarFrame(layoutOf(car));
  car.readPartNetState(f.parts);
  return f.parts.flags.filter((x) => x & 1).length;
}

describe("netplay codec", () => {
  it("round-trips a snapshot within the quantization steps, and omits the wreck section when asked", () => {
    const s = makeSnapshot();
    ensureFrames(s, 2, L);
    s.seq = 70000;
    s.time = 12345.678;
    s.keyframe = true;
    s.count = 2;
    s.realism = 0.25;
    s.phase = 2;
    s.timeScale = 0.032;
    for (let c = 0; c < 2; c++) {
      const f = s.cars[c]!;
      // Car 0 a falling fake, car 1 vaporized with its sirens on: each flag must come back on its own car only.
      Object.assign(f, { x: 12.345 + c, y: 0.0123, z: -40.5, yaw: 3.1, pitch: -0.12, roll: 0.4, vx: 17.3, vy: -1.2, vz: -0.07, wy: 2.345, crashed: true, wreck: c === 0, falling: c === 0, vaporized: c === 1, sirens: c === 1, style: 4 + c, cls: 3 - c });
      const d = f.deform;
      for (let i = 0; i < d.local.length; i++) d.local[i] = Math.sin(i * 1.7) * 2.2;
      for (let i = 0; i < d.skinPos.length; i++) d.skinPos[i] = Math.cos(i * 0.9) * 2.1;
      for (let i = 0; i < d.skinXf.length; i++) d.skinXf[i] = Math.sin(i) * 1.3;
      for (let i = 0; i < d.sensor.length; i++) d.sensor[i] = (i % 5) * 0.11;
      d.impact.set([0.3, 0.36, 2.1, 0, 0, -1, 0.07, 0.45, 0.4]);
      d.popped = (1 << 16) | (1 << 19);
      d.skinPopped = 1 << 16;
      d.flags = 1 | 2 | 8;
      d.engineTravel = 0.123;
      d.killTravel = 0.5;
      const p = f.parts;
      p.flags.set([1, 0, 2, 3, 5, 4, 1, 0]);
      for (let i = 0; i < p.hinge.length; i++) p.hinge[i] = (i % 3) * 0.37;
      for (let i = 0; i < L.parts; i++) p.pose.set([3.5 + i, 0.12, -7.25, 0.5, -0.5, 0.5, 0.5], i * 7);
      p.lamps = 0b1010;
      p.glass = 0b10_01_00_10_01_00;
      p.wheelLoose = 0b0101;
      for (let i = 0; i < L.wheels; i++) p.wheels.set([-2.5 + i, 0.32, 9.75, 0, 0.7071068, 0, 0.7071068], i * 7);
    }
    const w = new Writer();
    writeSnapshot(w, s, L);
    const got = makeSnapshot();
    readSnapshot(new Reader().reset(w.done()), got, L);

    assert.equal(got.seq, 70000 & 0xffff);
    assert.equal(got.time, 12345.678);
    assert.equal(got.keyframe, true);
    assert.equal(got.count, 2);
    assert.ok(Math.abs(got.realism - 0.25) <= 0.5 / 255);
    assert.equal(got.phase, 2);
    assert.ok(Math.abs(got.timeScale - 0.032) <= 0.5e-4);
    for (let c = 0; c < 2; c++) {
      const a = s.cars[c]!;
      const b = got.cars[c]!;
      assert.equal(b.x, Math.fround(a.x));
      assert.equal(b.z, Math.fround(a.z));
      assert.ok(Math.abs(b.yaw - a.yaw) <= Q.fine / 2 + 1e-12);
      assert.ok(Math.abs(b.roll - a.roll) <= Q.fine / 2 + 1e-12);
      assert.ok(Math.abs(b.vx - a.vx) <= Q.vel / 2 + 1e-9);
      assert.ok(Math.abs(b.wy - a.wy) <= Q.rate / 2 + 1e-9);
      assert.equal(b.crashed, true);
      assert.equal(b.style, a.style);
      assert.equal(b.cls, a.cls);
      assert.equal(b.wreck, c === 0);
      assert.equal(b.falling, c === 0);
      assert.equal(b.vaporized, c === 1);
      assert.equal(b.sirens, c === 1);
    }
    const a = s.cars[0]!;
    const b = got.cars[0]!;
    assert.ok(maxDiff(a.deform.local, b.deform.local) <= Q.pos / 2 + 1e-6, "particles within 0.25 mm");
    assert.ok(maxDiff(a.deform.skinPos, b.deform.skinPos) <= Q.pos / 2 + 1e-6);
    assert.ok(maxDiff(a.deform.skinXf, b.deform.skinXf) <= Q.xf / 2 + 1e-6);
    assert.ok(maxDiff(a.deform.sensor, b.deform.sensor) <= Q.fine / 2 + 1e-6);
    assert.ok(maxDiff(a.deform.impact, b.deform.impact) <= Q.fine / 2 + 1e-6);
    assert.equal(b.deform.popped, a.deform.popped);
    assert.equal(b.deform.skinPopped, a.deform.skinPopped);
    assert.equal(b.deform.flags, a.deform.flags);
    assert.ok(Math.abs(b.deform.engineTravel - 0.123) <= Q.pos / 2 + 1e-6);
    assert.ok(Math.abs(b.deform.killTravel - 0.5) <= Q.pos / 2 + 1e-6);
    assertSameNumbers(b.parts.flags, a.parts.flags, "part flags");
    assert.ok(maxDiff(a.parts.hinge, b.parts.hinge) <= Q.fine / 2 + 1e-6);
    assert.equal(b.parts.lamps, a.parts.lamps);
    assert.equal(b.parts.glass, a.parts.glass);
    assert.equal(b.parts.wheelLoose, a.parts.wheelLoose);
    for (const i of [0, 2]) {
      for (let k = 0; k < 3; k++) assert.equal(b.parts.wheels[i * 7 + k], Math.fround(a.parts.wheels[i * 7 + k]!));
      for (let k = 3; k < 7; k++) assert.ok(Math.abs(b.parts.wheels[i * 7 + k]! - a.parts.wheels[i * 7 + k]!) <= Q.quat);
    }
    for (let i = 0; i < L.parts; i++) {
      if ((a.parts.flags[i]! & 1) === 0) continue;
      for (let k = 0; k < 3; k++) assert.equal(b.parts.pose[i * 7 + k], Math.fround(a.parts.pose[i * 7 + k]!));
      for (let k = 3; k < 7; k++) assert.ok(Math.abs(b.parts.pose[i * 7 + k]! - a.parts.pose[i * 7 + k]!) <= Q.quat);
    }
    // 17-byte header, 28-byte poses, a 661-byte wreck with 20 more per loose part (4) and per loose wheel (2).
    assert.equal(w.off, 17 + 28 + (661 + 20 * 4 + 20 * 2) + 28);
  });

  it("clamps out-of-range values to the i16 range instead of wrapping", () => {
    const w = new Writer();
    w.q16(1e9, 1);
    w.q16(-1e9, 1);
    const r = new Reader().reset(w.done());
    assert.equal(r.q16(1), 32767);
    assert.equal(r.q16(1), -32767);
  });

  it("round-trips a drive input", () => {
    const input = { throttle: -0.5, steer: 1, brake: 0.25, ebrake: true, boost: false };
    const w = new Writer();
    writeInput(w, input);
    assert.equal(w.off, 5);
    const out = idleDrive();
    readInput(new Reader().reset(w.done()), out);
    assert.ok(Math.abs(out.throttle - input.throttle) < 1 / 127);
    assert.equal(out.steer, 1);
    assert.ok(Math.abs(out.brake - 0.25) < 1 / 255);
    assert.equal(out.ebrake, true);
    assert.equal(out.boost, false);
  });
});

describe("netplay apply: a client car reproduces the host's final mesh and colliders", () => {
  forModes("offset wall crash", (mode) => {
    const host = makeCar(mode);
    // An arcade-end kill travel the client's default does not share: graded damage must come over the wire.
    host.deform.killTravel = 0.5;
    runWall(64, 0.4, "front", { car: host, after: 1.5 });
    assert.ok(host.crashed && host.deform.massActive);
    const client = apply(makeCar(mode), wire(host));

    const hv = host.body.geometry.getAttribute("position").array;
    const cv = client.body.geometry.getAttribute("position").array;
    const dent = maxDiff(hv, makeCar(mode).body.geometry.getAttribute("position").array);
    assert.ok(dent > 0.05, `the host car is dented (${dent.toFixed(3)} m)`);
    // The client re-skins from the host's baked inputs; only quantization (≤ 0.25 mm per particle) separates them.
    assert.ok(maxDiff(hv, cv) < 0.002, `skin vertices within 2 mm (${maxDiff(hv, cv).toFixed(4)})`);

    const flat = (hs: readonly { cx: number; cz: number; hx: number; hz: number }[]) => hs.flatMap((h) => [h.cx, h.cz, h.hx, h.hz]);
    assert.ok(maxDiff(flat(host.hulls()), flat(client.hulls())) < 0.001, "contact hulls within 1 mm");
    assert.ok(maxDiff(flat(host.crushHulls()), flat(client.crushHulls())) < 0.001, "crush hulls within 1 mm");

    const a = makeCarFrame(layoutOf(host));
    const b = makeCarFrame(layoutOf(host));
    host.readPartNetState(a.parts);
    client.readPartNetState(b.parts);
    assertSameNumbers(b.parts.flags, a.parts.flags, "part states identical");
    assert.equal(b.parts.lamps, a.parts.lamps);
    assert.equal(b.parts.glass, a.parts.glass);
    assert.equal(client.deform.drivetrainAlive, host.deform.drivetrainAlive);
    assert.ok(host.deform.drivetrainHealth < 1, "the hit cost the engine some health");
    assert.ok(Math.abs(client.deform.drivetrainHealth - host.deform.drivetrainHealth) < 0.01, "graded damage matches");
  });

  it("re-attaches a part torn off in an earlier crash when the host's next wreck has it on", () => {
    const host = makeCar();
    runWall(72, 1, "front", { car: host, after: 1.5 });
    const client = apply(makeCar(), wire(host));
    assert.ok(looseParts(client) > 0, "a 72 km/h wall hit tears a part off");
    assert.equal(looseParts(client), looseParts(host));

    host.resetVisual();
    host.crashed = false;
    runWall(24, 1, "front", { car: host, after: 1 });
    assert.ok(host.crashed && looseParts(host) === 0);
    apply(client, wire(host));
    assert.equal(looseParts(client), 0);
    const hv = host.body.geometry.getAttribute("position").array;
    assert.ok(maxDiff(hv, client.body.geometry.getAttribute("position").array) < 0.002);
  });

  it("puts a torn-off wheel where the host's lies, and the client never throws one itself", () => {
    const host = makeCar();
    runWall(40, 1, "front", { car: host, after: 0.5 });
    host.deform.popHub(host.deform.masses.find((m) => m.name === "hubFL")!);
    for (let i = 0; i < 90; i++) host.afterContacts(1 / 60);
    const hostWheel = host.wheels[0]!.getWorldPosition(host.wheels[0]!.position.clone());
    assert.ok(hostWheel.distanceTo(host.group.position) > 0.5, "the host's wheel left the car");

    const client = apply(makeCar(), wire(host));
    for (let i = 0; i < 30; i++) client.netFrame(1 / 60);
    const f = makeCarFrame(layoutOf(client));
    client.readPartNetState(f.parts);
    assert.equal(f.parts.wheelLoose, 1, "only wheel 0 is loose");
    const clientWheel = client.wheels[0]!.getWorldPosition(client.wheels[0]!.position.clone());
    assert.ok(clientWheel.distanceTo(hostWheel) < 0.001, `loose wheel within 1 mm (${clientWheel.distanceTo(hostWheel)})`);

    host.resetVisual();
    host.crashed = false;
    runWall(24, 1, "front", { car: host, after: 1 });
    apply(client, wire(host));
    client.readPartNetState(f.parts);
    assert.equal(f.parts.wheelLoose, 0, "the next wreck has all four wheels on");
  });
});

describe("netplay derby state", () => {
  /** A match on the host after `steps` 1 s steps: car 1 scored on car 2, car 2's engine died, car 3 never moves. */
  function playedMatch(steps: number): DerbyMatch {
    const m = new DerbyMatch();
    m.begin(
      [0, 1, 2, 3].map((id) => ({ id, name: id === 2 ? "Player 2" : `Car ${id}` })),
      { radius: 18.5, hitClock: 20 },
    );
    const moving = (id: number, t: number) => ({ id, name: "", alive: true, x: id === 3 ? 0 : 5 * Math.sin(t + id), z: 0 });
    for (let t = 1; t <= steps; t++) {
      if (t === 2) assert.ok(m.noteHit(1, 2, 6, 0.5, 6), "a hard hit is a contact");
      m.step(1, [0, 1, 2, 3].map((id) => ({ ...moving(id, t), alive: !(id === 2 && t >= 3) })));
    }
    return m;
  }

  function netState(m: DerbyMatch, round: number, lobby: number | null): DerbyNetState {
    return { round, active: m.active, time: m.time, hold: m.hold, radius: 18.5, winnerId: m.winnerId, winnerName: m.winnerName, decided: m.decided, lobby, seats: 1 << 2, board: m.board };
  }

  function wire(s: DerbyNetState): DerbyNetState {
    const w = new Writer();
    writeDerby(w, s);
    return readDerby(new Reader().reset(w.done()));
  }

  it("round-trips a running board: scores, hits, disables, alive, count-out clocks, seats", () => {
    const m = playedMatch(10);
    const s = netState(m, 70001, null);
    assert.equal(m.winnerId, null, "still running after 10 s");
    assert.ok(m.board.find((r) => r.id === 1)!.score > 0 && !m.board.find((r) => r.id === 2)!.alive, "the host's board moved");
    const got = wire(s);
    assert.equal(got.round, 70001 & 0xffff);
    assert.equal(got.active, true);
    assert.equal(got.lobby, null);
    assert.equal(got.seats, 1 << 2);
    assert.equal(got.winnerId, null);
    assert.equal(got.decided, null);
    assert.ok(Math.abs(got.time - s.time) < 1e-5 && Math.abs(got.radius - 18.5) < 1e-5);
    assert.equal(got.board.length, 4);
    for (let i = 0; i < 4; i++) {
      const [a, b] = [s.board[i]!, got.board[i]!];
      assertSameDigest({ ...b, clock: 0 }, { ...a, clock: 0 }, `row ${a.id}`);
      assert.ok(Math.abs(b.clock - a.clock) <= 0.05, `row ${a.id} clock ${a.clock} → ${b.clock}`);
    }
  });

  it("round-trips a decided match (winner and how) and a lobby (no match, countdown)", () => {
    // Car 3 never moves: hitClock 20 s counts every idle car out, the last standing wins.
    const m = playedMatch(25);
    assert.notEqual(m.winnerId, null, "decided within 25 s");
    const got = wire(netState(m, 3, null));
    assert.equal(got.winnerId, m.winnerId);
    assert.equal(got.winnerName, m.winnerName);
    assert.equal(got.decided, m.decided);
    assertSameDigest(
      got.board.map((r) => [r.id, r.score, r.alive, r.out]),
      m.board.map((r) => [r.id, r.score, r.alive, r.out]),
      "board",
    );

    const lobby = new DerbyMatch();
    const l = wire(netState(lobby, 4, 12.5));
    assert.equal(l.active, false);
    assert.equal(l.lobby, 12.5);
    assert.deepEqual(l.board, []);
  });
});

describe("netplay codec: values a host never sends are refused", () => {
  /** A 2-car snapshot written with `edit` applied, then read back. */
  function readBack(edit: (s: Snapshot) => void): () => void {
    const s = makeSnapshot();
    ensureFrames(s, 2, L);
    s.count = 2;
    s.time = 1;
    for (const f of s.cars) {
      f.crashed = true;
      f.wreck = true;
      f.parts.flags[0] = 1;
      f.parts.pose.set([1, 0.2, 3, 0, 0, 0, 1], 0);
    }
    edit(s);
    const w = new Writer(1 << 17);
    writeSnapshot(w, s, L);
    return () => readSnapshot(new Reader().reset(w.done()), makeSnapshot(), L);
  }

  it("accepts a well-formed snapshot", () => {
    readBack(() => {})();
  });

  it("refuses an empty or oversized field, a non-finite clock, pose or loose-part position", () => {
    assert.throws(readBack((s) => (s.count = 0)), RangeError);
    assert.throws(
      readBack((s) => {
        ensureFrames(s, 33, L);
        s.count = 33;
      }),
      RangeError,
    );
    assert.throws(readBack((s) => (s.time = Number.NaN)), RangeError);
    assert.throws(readBack((s) => (s.cars[1]!.z = Number.POSITIVE_INFINITY)), RangeError);
    assert.throws(readBack((s) => (s.cars[0]!.parts.pose[1] = Number.NaN)), RangeError);
  });

  it("refuses a derby board larger than any field, a winner outside it, or a non-finite clock or bowl", () => {
    const base: DerbyNetState = { round: 1, active: true, time: 3, hold: 0, radius: 18, winnerId: null, winnerName: null, decided: null, lobby: null, seats: 0, board: [] };
    const row = (id: number) => ({ id, name: `Car ${id}`, score: 0, hits: 0, disables: 0, alive: true, out: false, clock: 60 });
    const read = (s: DerbyNetState) => () => {
      const w = new Writer(1 << 15);
      writeDerby(w, s);
      return readDerby(new Reader().reset(w.done()));
    };
    read({ ...base, board: [row(0), row(1)] })();
    assert.throws(read({ ...base, board: Array.from({ length: 33 }, (_, i) => row(i)) }), RangeError);
    assert.throws(read({ ...base, board: [row(0)], winnerId: 40, winnerName: "x", decided: "wreck" }), RangeError);
    assert.throws(read({ ...base, radius: Number.NaN }), RangeError);
    assert.throws(read({ ...base, time: Number.POSITIVE_INFINITY }), RangeError);
  });
});
