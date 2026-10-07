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

describe("given a network snapshot whose per-car flags byte records whether the driver is out and by which door or pane", () => {
  const L: NetLayout = carLayout(makeCar());

  it("when four cars with every pane code and mixed crashed and siren flags go through a snapshot write and read, then each pane code survives beside the other flags and a car at the wheel stays 0", () => {
    const s = makeSnapshot();
    ensureFrames(s, 4, L);
    s.count = 4;
    for (const [i, code] of [0, 1, 2, 3].entries()) {
      s.cars[i]!.driverOut = code;
      s.cars[i]!.crashed = i % 2 === 1;
      s.cars[i]!.sirens = i === 3;
    }
    const w = new Writer();
    writeSnapshot(w, s, L);
    const got = makeSnapshot();
    readSnapshot(new Reader().reset(w.done()), got, L);
    assert.deepEqual(got.cars.slice(0, 4).map((c) => c.driverOut), [0, 1, 2, 3]);
    assert.deepEqual(got.cars.slice(0, 4).map((c) => c.crashed), [false, true, false, true], "the neighbouring flag bits are untouched");
    assert.deepEqual(got.cars.slice(0, 4).map((c) => c.sirens), [false, false, false, true]);
  });

  it("when a host car's driver leaves, then the host's frame carries it, a client car takes it from the drawn snapshot, and loses it again when the host puts him back", () => {
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

describe("given an eject message (the host telling clients a driver was thrown out)", () => {
  it("when an event is written and read back with the host clock, then every number comes back exact", () => {
    const w = new Writer(256);
    writeEject(w, sample(), 12.625);
    const got = blankEjection();
    const time = readEject(new Reader().reset(w.done()), got);
    assert.equal(time, 12.625);
    assertSameDigest(arrays(got), arrays(sample()), "the event on the wire");
    assert.equal(got.cop, true);
  });

  it("when the car index is out of range, the pane code is invalid, or a number is not finite, then the read refuses each as a RangeError (a host never sends them)", () => {
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

describe("given a client's eject queue, which launches the host's thrown dummy when its draw time reaches the host clock the driver left at", () => {
  const msg = (e: Ejection, time: number): Reader => {
    const w = new Writer(256);
    writeEject(w, e, time);
    return new Reader().reset(w.done().slice());
  };
  const cars: DeformableCar[] = [makeCar(), makeCar(), makeCar()];

  it("when events arrive and draw time passes, then nothing launches before its time, one launch at it, and none again after", () => {
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

  it("when a reel is playing, the car is missing here, or the queue is cleared, then the dummy is dropped rather than launched late", () => {
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

  it("when events arrive out of step with the frames and then a flood of 100 arrives, then they launch in clock order whatever the frame gap and the flood is capped", () => {
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
