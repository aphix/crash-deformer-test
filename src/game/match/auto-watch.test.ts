import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutoWatch, WATCH, type Cand, type Wreck } from "./auto-watch.ts";

/** A car parked far from every other (no contact, no battle: nothing happens to it), place id + 1. */
function car(id: number, over: Partial<Cand> = {}): Cand {
  return { id, x: id * 500, z: 0, vx: 0, vz: 0, place: id + 1, split: null, stopped: 0, air: false, racing: true, ...over };
}

/** Cars `a` and `b` head on, `gap` m apart on a line at z = 1000, each doing `v` m/s toward the other: contact in gap / 2v s at 2v closing. */
function headOn(a: number, b: number, gap: number, v: number): [Cand, Cand] {
  return [car(a, { x: 0, z: 1000 + a, vx: v }), car(b, { x: gap, z: 1000 + a, vx: -v })];
}

/** A car already held at `t`: Auto on car 0 from `t` with `cuts`. */
function watching(t = 0, cuts = -1): AutoWatch {
  const w = new AutoWatch();
  w.follow(0, t, cuts);
  return w;
}

const NONE: Wreck[] = [];

describe("auto watch: leaving an idle car", () => {
  it("bad: an idle car is left for a predicted contact once held 4 s, why `contact`; at 3.9 s it is not", () => {
    // 14 m apart at 7 m/s each: contact in 1 s (not under crashTtc), closing 14 m/s.
    const field = [car(0), ...headOn(1, 2, 14, 7)];
    const early = watching(0.1);
    assert.equal(early.step(4, field, NONE, -1, true), 0, "3.9 s on the car: stays");
    assert.equal(early.log.length, 0);
    const w = watching(0);
    for (let t = 0; t < WATCH.floor; t += 0.25) assert.equal(w.step(t, field, NONE, -1, true), 0, `stays at ${t}`);
    assert.equal(w.step(4, field, NONE, -1, true), 1, "held 4 s: switches");
    assert.deepEqual(w.log, [{ t: 4, from: 0, to: 1, why: "contact" }]);
  });

  it("bad: no cut, no switch: between cuts of a camera that cuts, an idle car is kept (the crash exception aside)", () => {
    const field = [car(0), ...headOn(1, 2, 14, 7)];
    const w = watching(0, 0);
    assert.equal(w.step(10, field, NONE, 0, false), 0);
    assert.equal(w.step(10.25, field, NONE, 1, true), 1, "the next cut takes it");
  });

  it("each signal names itself: wreck, bust, battle, jolt", () => {
    const why = (field: Cand[], wrecks: Wreck[] = NONE): string => {
      const w = watching(0);
      w.step(0, field, wrecks, -1, true);
      w.step(5, field, wrecks, -1, true);
      return w.log[0]?.why ?? "none";
    };
    assert.equal(why([car(0), car(1)], [{ cars: 1 << 1, age: 0.5, score: 6 }]), "wreck");
    assert.equal(why([car(0), car(1, { stopped: 3 })]), "bust");
    // Places 2 and 3, 20 m apart, 0.3 s apart at the last gate.
    assert.equal(why([car(0, { split: 0 }), car(1, { split: 5 }), car(2, { split: 5.3, x: 520 })]), "battle");
    // A car that was doing 20 m/s and is now at 8: a hit or a hard brake.
    const w = watching(0);
    for (let t = 0; t < 2; t += 0.25) w.step(t, [car(0), car(1, { vx: 20 })], NONE, -1, true);
    for (let t = 2; t < 4; t += 0.25) w.step(t, [car(0), car(1, { vx: 20 })], NONE, -1, true);
    assert.equal(w.step(4, [car(0), car(1, { vx: 8 })], NONE, -1, true), 1);
    assert.equal(w.log[0]!.why, "jolt");
  });

  it("bad: a wreck that went quiet, a lone tap and a jump are not worth leaving a car for", () => {
    const w = watching(0);
    const field = [car(0), car(1, { air: true }), car(2)];
    assert.equal(w.step(5, field, [{ cars: 1 << 2, age: 1.6, score: 20 }], -1, true), 0, "ledger cluster past QUIET_GAP");
    assert.equal(w.step(6, field, [{ cars: 1 << 2, age: 0.1, score: 2.3 }], -1, true), 0, "a 20 km/h tap (score 2.3)");
    assert.equal(w.step(7, field, NONE, -1, true), 0, "air alone");
  });

  it("good: a car in a contact, or that just overtook, is not left; once the overtake is 3 s old it is", () => {
    const hot = car(3, { stopped: 3 });
    // Car 0 itself in a head-on with car 4, closing 12, 1.2 s out: interest well over idle.
    const [a, b] = headOn(0, 4, 14.4, 6);
    const w = watching(0);
    assert.equal(w.step(5, [a, car(1), car(2), hot, b], NONE, -1, true), 0, "in a contact");
    // Steps are 0.25 s apart: a car unseen for half a second starts its history over.
    const p = watching(0);
    const bust = car(1, { stopped: 3 });
    for (let t = 0; t < 5; t += 0.25) {
      const place = t < 2 ? 3 : 2;
      const got = p.step(t, [car(0, { place }), bust], NONE, -1, true);
      if (t < 4.75) assert.equal(got, 0, `overtook at 2 s, still watched at ${t}`);
    }
    assert.equal(p.step(5, [car(0, { place: 2 }), bust], NONE, -1, true), 1, "3 s on: idle again, leaves");
    assert.equal(p.log[0]!.why, "bust");
  });
});

describe("auto watch: the floor", () => {
  it("bad: a stream of interesting cars never moves the view more than once per 4 s", () => {
    // Every car but the watched one is held beside a police car (bust interest); the watched one never is.
    const w = watching(0);
    for (let t = 0; t < 60; t += 0.25) {
      const field = [0, 1, 2, 3].map((i) => car(i, { stopped: i === w.current ? 0 : 3 }));
      w.step(t, field, NONE, -1, true);
    }
    assert.ok(w.log.length >= 10, `${w.log.length} switches in 60 s`);
    for (let k = 1; k < w.log.length; k++) assert.ok(w.log[k]!.t - w.log[k - 1]!.t >= WATCH.floor, `switch ${k} came ${w.log[k]!.t - w.log[k - 1]!.t} s after the one before`);
  });

  it("the log keeps the last 32 switches", () => {
    const w = watching(0);
    for (let t = 0; t < 400; t += 0.25) {
      const field = [0, 1].map((i) => car(i, { stopped: i === w.current ? 0 : 3 }));
      w.step(t, field, NONE, -1, true);
    }
    assert.equal(w.log.length, 32);
    assert.ok(w.log[31]!.t > 380);
  });
});

describe("auto watch: validity", () => {
  it("bad: a car that is not racing (finished, out, dnf, respawning, police) is never switched to, however interesting", () => {
    const w = watching(0);
    const field = [car(0), car(1, { racing: false, stopped: 4, air: true }), car(2, { racing: false, x: 14, z: 0, vx: -7 }), car(3, { racing: false, x: 0, z: 0, vx: 7 })];
    for (let t = 0; t < 60; t += 0.25) w.step(t, field, [{ cars: 1 << 1, age: 0, score: 20 }], 3 * t, true);
    assert.equal(w.current, 0);
    assert.equal(w.log.length, 0);
    // Rotation skips them too: the next car by place is the racing one after.
    const r = watching(0, 0);
    const f2 = [car(0), car(1, { racing: false }), car(2)];
    r.step(1, f2, NONE, 3, true);
    assert.equal(r.step(5, f2, NONE, 3, true), 2);
  });

  it("bad: a watched car that finishes is left for the best racing car after 1 s, not 4, and not on a cut", () => {
    const w = watching(0);
    const field = [car(0, { racing: false }), car(1), car(2, { stopped: 3 })];
    assert.equal(w.step(0.75, field, NONE, 0, false), 0, "under the 1 s floor");
    assert.equal(w.step(1, field, NONE, 0, false), 2);
    assert.deepEqual(w.log, [{ t: 1, from: 0, to: 2, why: "invalid" }]);
  });

  it("bad: with nothing racing the view stays", () => {
    const w = watching(0);
    assert.equal(w.step(10, [car(0, { racing: false }), car(1, { racing: false })], NONE, 0, true), 0);
  });

  it("starts on the leader when it has no car yet", () => {
    const w = new AutoWatch();
    assert.equal(w.step(0, [car(0, { place: 3 }), car(1, { place: 1 }), car(2, { place: 2 })], NONE, -1, true), 1);
  });
});

describe("auto watch: rotation", () => {
  const field = [car(0), car(1), car(2), car(3)];

  it("bad: after 3 camera shots on a car the view moves to the next by place, wrapping; not before, not between cuts, not before 4 s", () => {
    const w = watching(0, 10);
    assert.equal(w.step(6, field, NONE, 12, true), 0, "2 shots");
    assert.equal(w.step(6, field, NONE, 13, false), 0, "3 shots but no cut now");
    assert.equal(w.step(3.75, field, NONE, 13, true), 0, "held under 4 s");
    assert.equal(w.step(6, field, NONE, 13, true), 1);
    assert.deepEqual(w.log[0], { t: 6, from: 0, to: 1, why: "rotate" });
    // Shots count from the switch: the counter at the switch was 13.
    assert.equal(w.step(12, field, NONE, 15, true), 1);
    assert.equal(w.step(12.25, field, NONE, 16, true), 2);
    // Last place wraps to the leader.
    const last = new AutoWatch();
    last.follow(3, 0, 0);
    assert.equal(last.step(9, field, NONE, 3, true), 0);
  });

  it("bad: a camera that makes no cuts (-1) rotates on the clock, 3 shots of 7 s", () => {
    const w = watching(0);
    assert.equal(w.step(20.75, field, NONE, -1, true), 0);
    assert.equal(w.step(21, field, NONE, -1, true), 1);
    assert.equal(w.log[0]!.why, "rotate");
  });

  it("the best-interest car beats the next by place when something is going on", () => {
    const w = watching(0, 0);
    const f = [car(0), car(1), car(2, { stopped: 1.2 }), car(3)];
    assert.equal(w.step(6, f, NONE, 3, true), 2);
  });

  it("bad: a hot car (mid-crash) is not rotated away from, a car in a plain contact is", () => {
    const wreck = [{ cars: 1 << 0, age: 0.2, score: 8 }];
    const w = watching(0, 0);
    for (let t = 0; t < 60; t += 0.25) assert.equal(w.step(t, field, wreck, Math.floor(t), true), 0, `at ${t}`);
    // A contact scores ~0.6: under `hot`.
    const [a, b] = headOn(0, 1, 14, 7);
    const c = watching(0, 0);
    // The best car to go to is the other half of the same contact.
    assert.equal(c.step(6, [a, b, car(2), car(3)], NONE, 3, true), 1);
    assert.equal(c.log[0]!.why, "rotate");
  });
});

describe("auto watch: the imminent big crash", () => {
  // 16 m apart at 10 m/s each: contact in 0.8 s, closing 20 m/s (72 km/h).
  const crash = [car(0), ...headOn(1, 2, 16, 10)];

  it("bad: switches to it at 2 s on a car, even between cuts, and not before", () => {
    const w = watching(0, 0);
    assert.equal(w.step(1.75, crash, NONE, 0, false), 0, "under the 2 s anti ping-pong floor");
    assert.equal(w.step(2, crash, NONE, 0, false), 1);
    assert.deepEqual(w.log[0]!.why, "crash");
    // Now in the crash itself: no further switch off it.
    assert.equal(w.step(10, crash, NONE, 0, false), 1);
  });

  it("bad: a slow tap (closing 10 m/s) or a miss does not, between cuts", () => {
    const tap = [car(0), ...headOn(1, 2, 8, 5)];
    const miss = [car(0), car(1, { x: 0, z: 1000, vx: 10 }), car(2, { x: 16, z: 1010, vx: -10 })];
    for (const field of [tap, miss]) {
      const w = watching(0, 0);
      for (let t = 0; t < 8; t += 0.25) assert.equal(w.step(t, field, NONE, 0, false), 0);
    }
  });

  it("bad: a crash the watched car is in is not left", () => {
    const w = new AutoWatch();
    w.follow(1, 0, 0);
    assert.equal(w.step(5, crash, NONE, 0, false), 1);
    assert.equal(w.log.length, 0);
  });
});

describe("auto watch: deterministic", () => {
  it("the same inputs give the same switches", () => {
    const run = (): string => {
      const w = watching(0, 0);
      let s = 12345;
      const rnd = (): number => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296);
      let cuts = 0;
      for (let t = 0; t < 120; t += 0.25) {
        const field = Array.from({ length: 8 }, (_, i) => car(i, { x: rnd() * 150, z: rnd() * 150, vx: (rnd() - 0.5) * 40, vz: (rnd() - 0.5) * 40, place: 1 + ((i + Math.floor(t / 20)) % 8), stopped: rnd() < 0.03 ? 3 : 0, racing: rnd() < 0.95 }));
        if (rnd() < 0.1) cuts++;
        w.step(t, field, rnd() < 0.05 ? [{ cars: 1 << Math.floor(rnd() * 8), age: rnd(), score: rnd() * 10 }] : NONE, cuts, rnd() < 0.3);
      }
      return JSON.stringify(w.log);
    };
    const a = run();
    assert.ok(JSON.parse(a).length > 3, "the scenario switches");
    assert.equal(run(), a);
  });
});
