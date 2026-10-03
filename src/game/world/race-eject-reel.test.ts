import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { setGround } from "./ground.ts";
import { frame, FRAME, makeWorld, type World } from "./race-world.test-util.ts";
import { blankPoint, Track } from "./track.ts";
import oval from "./tracks/oval.json" with { type: "json" };
import { clipTitle, TOP, type HighlightClip } from "../match/highlights.ts";
import { ClipSim } from "../engine/engine-replay.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import type { Ejection } from "../vehicle/ejection.ts";

/**
 * Owner, 2026-10-03: a driver thrown from his car "should definitely count as a bunch of points into the highlights
 * reel", and "ensure dude ejects in the replay". A race with one head-on (2×20 m/s, both engines survive it) is the
 * whole scenario: the live dummies, the clip the recorder cuts, and that clip replayed through `ClipSim`.
 */
const track = new Track(oval);
const pt = blankPoint();
const w: World = makeWorld();
before(() => {
  w.race.enter();
});
after(() => {
  w.race.exit();
  setGround(null);
});

/** Frames the dummy of each car is followed for after its launch, and the comparison points (frames after launch). */
const TRAIL = 240;
type Trails = Map<number, number[]>;

/** Every live dummy's torso, appended to its car's trail (x, y, z per frame since its launch). */
function sampleTrails(ragdolls: RagdollSystem, trails: Trails): void {
  for (const d of ragdolls["dolls"]) {
    if (!d.live) continue;
    const t = d.bodies[0]!.translation();
    const trail = trails.get(d.car) ?? [];
    if (trail.length < TRAIL * 3) trail.push(t.x, t.y, t.z);
    trails.set(d.car, trail);
  }
}

/** The race, a head-on at 2×20 m/s a second in, its dummies flown live; the clips the recorder kept. */
async function live(): Promise<{ clips: HighlightClip[]; trails: Trails; events: readonly Ejection[] }> {
  const r = w.race;
  r.command({ type: "quit" });
  r.command({ type: "options", options: { trackId: "oval", laps: 3, aiCount: 3, noReset: false, aggression: 0.35 } });
  r.reseed(1);
  w.ejections.length = 0;
  r.command({ type: "start" });
  w.seat.mode = "follow";
  const state = { acc: 0 };
  for (let n = 0; r.time < 1 && n < 900; n++) frame(w, state);
  const yaw = (track.pointAt(40, pt), Math.atan2(pt.tx, pt.tz));
  w.cars[0]!.spawnFacing(pt.x, pt.z, yaw, 20);
  track.pointAt(48, pt);
  w.cars[1]!.spawnFacing(pt.x, pt.z, yaw + Math.PI, 20);
  const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await ragdolls.preload();
  const trails: Trails = new Map();
  let seen = 0;
  for (let n = 0; n < 60 * 9; n++) {
    frame(w, state);
    for (; seen < w.ejections.length; seen++) ragdolls.launch(w.ejections[seen]!, w.live());
    ragdolls.update(FRAME, w.live(), true, false, 0, null);
    sampleTrails(ragdolls, trails);
  }
  ragdolls.dispose();
  r.recorder.end();
  return { clips: [...r.recorder.ledger.kept], trails, events: [...w.ejections] };
}

/** `clip` replayed on the world's cars with the ragdolls launching what the replay throws: the dummies' trails. */
async function replay(clip: HighlightClip): Promise<Trails> {
  const cars = clip.cars.map((c) => w.cars[c.slot]!);
  const sim = new ClipSim(clip, cars, { dress: w.dress, collide: (car, slot) => w.race.courseHit(car, slot), bounce: undefined });
  const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await ragdolls.preload();
  const trails: Trails = new Map();
  w.race.resetProps();
  sim.restart();
  while (!sim.done) {
    sim.advanceTo(sim.time + FRAME);
    for (const e of sim.take()) ragdolls.launch(e, w.live());
    ragdolls.update(FRAME, w.live(), true, false, 0, null);
    sampleTrails(ragdolls, trails);
  }
  ragdolls.dispose();
  return trails;
}

describe("a driver thrown out is a highlight, and its replay throws him again", () => {
  it(`bad: a race with one head-on puts the ejection in the reel (top ${TOP}), as its best clip, scored well above a hard hit, titled for it`, async () => {
    const { clips, events } = await live();
    assert.ok(events.length >= 2, `${events.length} drivers thrown`);
    assert.ok(clips.length > 0 && clips.length <= TOP, `${clips.length} clips`);
    const best = clips[0]!;
    assert.ok(best.ejects >= 2, `the best clip holds ${best.ejects} ejections`);
    assert.ok(best.score >= 24, `score ${best.score.toFixed(1)}: 12 a driver`);
    assert.equal(clipTitle(best), "2 drivers thrown out");
    assert.ok(best.ejections.length >= 2 && best.ejections.every((x) => x.step >= 0 && x.step < best.h.length && x.e.car < best.cars.length), "the clip carries both throws, on its own car indices");
    assert.ok(best.ejections.every((x) => best.cars[x.e.car]!.slot <= 1), "and they are the head-on's cars");
  });

  it("bad: the same clip played twice throws the same dummies along the very same paths, from the very launch numbers of the live throw", async (t) => {
    const { clips, trails: liveTrails } = await live();
    const clip = clips.find((c) => c.ejections.length > 0)!;
    const first = await replay(clip);
    const again = await replay(clip);
    assert.ok(first.size >= 2, `${first.size} dummies thrown in the replay`);
    for (const [car, trail] of first) {
      assert.ok(trail.length >= 3 * 120, `car ${car}'s dummy flew ${trail.length / 3} frames`);
      assertSameNumbers(again.get(car)!, trail, `car ${car}'s dummy, replay 2 vs replay 1`);
    }
    // Live vs replay: the launch numbers are the record's, so the first sample is the same point; after that the dummy flies
    // against cars that are replayed (a few cm to dm off the live ones) and the launch falls on another frame boundary
    // (up to 1/60 s), so the paths part: a free flight stays within about a metre, one that bounces off the oncoming car does not.
    const report: string[] = [];
    for (const [car, trail] of first) {
      const lv = liveTrails.get(car)!;
      for (const frames of [0, 10, 30, 60, 120, TRAIL - 1]) {
        const k = Math.min(frames, trail.length / 3 - 1, lv.length / 3 - 1) * 3;
        const d = Math.hypot(trail[k]! - lv[k]!, trail[k + 1]! - lv[k + 1]!, trail[k + 2]! - lv[k + 2]!);
        report.push(`car ${car} +${frames} frames: ${d.toFixed(3)} m`);
        if (frames === 0) assert.ok(d < 1e-3, `car ${car}'s dummy starts ${d} m from the live one`);
        if (frames === 10) assert.ok(d < 0.5, `car ${car}'s dummy is ${d.toFixed(2)} m from the live one 10 frames on`);
      }
    }
    t.diagnostic(`live vs replay dummy: ${report.join("; ")}`);
  });
});
