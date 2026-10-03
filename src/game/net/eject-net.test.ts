import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DeformableCar } from "../vehicle/car.ts";
import { makeCar } from "../contact/crash-scenarios.test-util.ts";
import { blankEjection, type Ejection } from "../vehicle/ejection.ts";
import { assertSameDigest } from "../vehicle/test-support.ts";
import { ensureFrames, makeSnapshot, readEject, readSnapshot, Reader, writeEject, writeSnapshot, Writer, type NetLayout, type Snapshot } from "./codec.ts";
import { EjectQueue } from "./eject-queue.ts";
import { carLayout, readCarPose } from "./car-pose.ts";
import { drawSnapshots } from "./net-view.ts";

/** A thrown driver as `EjectionWatch` makes one: f32-exact numbers. */
function sample(car = 1): Ejection {
  const e = blankEjection();
  e.car = car;
  e.exit = "doorR";
  e.cop = true;
  e.pos.set(1.5, 1.25, -2);
  e.local.set(0.75, 1.125, 0.5);
  e.dir.set(1, 0, 0);
  e.quat.set(0.25, 0.5, 0.25, 0.75);
  e.rel.set(3, 3.5, -1);
  e.carVel.set(10, 0, 4);
  e.spin.set(0, 0, -3);
  return e;
}

const arrays = (e: Ejection): unknown => ({ ...e, pos: e.pos.toArray(), local: e.local.toArray(), dir: e.dir.toArray(), quat: e.quat.toArray(), rel: e.rel.toArray(), carVel: e.carVel.toArray(), spin: e.spin.toArray() });

describe("driverOut on the wire: the snapshot's flags byte", () => {
  const L: NetLayout = carLayout(makeCar());

  it("bad: every pane code survives writeSnapshot -> readSnapshot beside the other flags, and a car at the wheel stays 0", () => {
    const s = makeSnapshot();
    ensureFrames(s, 4, L);
    s.count = 4;
    [0, 1, 2, 3].forEach((code, i) => {
      s.cars[i]!.driverOut = code;
      s.cars[i]!.crashed = i % 2 === 1;
      s.cars[i]!.sirens = i === 3;
    });
    const w = new Writer();
    writeSnapshot(w, s, L);
    const got = makeSnapshot();
    readSnapshot(new Reader().reset(w.done()), got, L);
    assert.deepEqual(got.cars.slice(0, 4).map((c) => c.driverOut), [0, 1, 2, 3]);
    assert.deepEqual(got.cars.slice(0, 4).map((c) => c.crashed), [false, true, false, true], "the neighbouring flag bits are untouched");
    assert.deepEqual(got.cars.slice(0, 4).map((c) => c.sirens), [false, false, false, true]);
  });

  it("bad: a host car's flag reaches the frame (readCarPose) and a client car takes it from the drawn snapshot, then loses it at the reset", () => {
    const host = makeCar();
    host.driverOut = "doorL";
    const s: Snapshot = makeSnapshot();
    ensureFrames(s, 1, L);
    s.count = 1;
    readCarPose(host, s.cars[0]!);
    assert.equal(s.cars[0]!.driverOut, 2, "doorL is code 2");
    const client = makeCar();
    const ring = [s];
    s.time = 5;
    drawSnapshots(ring, [1], [], [client], 5, 1 / 60, { setVaporized: () => {}, clearScene: () => {} }, -1);
    assert.equal(client.driverOut, "doorL");
    host.spawnFacing(0, 0, 0, 0);
    readCarPose(host, s.cars[0]!);
    drawSnapshots(ring, [1], [], [client], 5, 1 / 60, { setVaporized: () => {}, clearScene: () => {} }, -1);
    assert.equal(client.driverOut, null, "the host put him back");
  });
});

describe("MSG.eject", () => {
  it("bad: an event round-trips with its host clock, every number exact", () => {
    const w = new Writer(256);
    writeEject(w, sample(), 12.625);
    const got = blankEjection();
    const time = readEject(new Reader().reset(w.done()), got);
    assert.equal(time, 12.625);
    assertSameDigest(arrays(got), arrays(sample()), "the event on the wire");
    assert.equal(got.cop, true);
  });

  it("bad: a car no field has, no pane and a non-finite number are refused as RangeErrors (a host never sends them)", () => {
    const bad = (mutate: (w: Writer) => void): void => {
      const w = new Writer(256);
      writeEject(w, sample(), 1);
      mutate(w);
      assert.throws(() => readEject(new Reader().reset(w.done()), blankEjection()), RangeError);
    };
    // Layout: type, f64 clock (8), car, pane/cop bits, then f32s.
    bad((w) => w.bytes.set([200], 9));
    bad((w) => w.bytes.set([4], 10));
    bad((w) => w.bytes.set([0, 0, 0xc0, 0x7f], 11));
  });
});

describe("EjectQueue: a client launches the host's dummy when its draw time reaches the host clock he left at", () => {
  const msg = (e: Ejection, time: number): Reader => {
    const w = new Writer(256);
    writeEject(w, e, time);
    return new Reader().reset(w.done().slice());
  };
  const cars: DeformableCar[] = [makeCar(), makeCar(), makeCar()];

  it("bad: nothing before its time, once at it, never again", () => {
    const launched: Ejection[] = [];
    const game = { cars: () => cars, reelPlaying: () => false, launchEjection: (e: Ejection) => launched.push(e) };
    const q = new EjectQueue();
    q.take(msg(sample(2), 10));
    q.due(9.99, game);
    assert.equal(launched.length, 0, "the car he left has not been drawn leaving yet");
    q.due(10, game);
    assert.equal(launched.length, 1);
    assert.equal(launched[0]!.car, 2);
    q.due(11, game);
    assert.equal(launched.length, 1, "launched once");
  });

  it("bad: a reel that plays owns the cars: the dummy is dropped, not launched late; so is a car this client lacks, and clear() forgets the queue", () => {
    const launched: Ejection[] = [];
    let reel = true;
    const game = { cars: () => cars, reelPlaying: () => reel, launchEjection: (e: Ejection) => launched.push(e) };
    const q = new EjectQueue();
    q.take(msg(sample(1), 1));
    q.due(2, game);
    reel = false;
    q.due(3, game);
    assert.equal(launched.length, 0, "dropped while the reel played");
    q.take(msg(sample(9), 1));
    q.due(5, game);
    assert.equal(launched.length, 0, "no car 9 here");
    q.take(msg(sample(0), 100));
    q.clear();
    q.due(200, game);
    assert.equal(launched.length, 0, "cleared");
  });

  it("bad: events come out in clock order whatever the frame gap, and a flood is capped", () => {
    const launched: number[] = [];
    const game = { cars: () => cars, reelPlaying: () => false, launchEjection: (e: Ejection) => launched.push(e.car) };
    const q = new EjectQueue();
    q.take(msg(sample(0), 1));
    q.take(msg(sample(1), 2));
    q.take(msg(sample(2), 3));
    q.due(2.5, game);
    assert.deepEqual(launched, [0, 1]);
    for (let k = 0; k < 100; k++) q.take(msg(sample(0), 50));
    q.due(60, game);
    assert.ok(launched.length - 2 <= 33, `${launched.length - 2} launched from a flood of 100`);
  });
});
