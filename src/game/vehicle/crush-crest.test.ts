import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { parseTrack } from "../world/track-schema.ts";
import { VEHICLE_CLASS_IDS, type VehicleClassId } from "./vehicle-classes.ts";
import { drive, type Sample } from "./ground-probe.test-util.ts";
import { BOUNDS } from "./ground-judge.test-util.ts";

/**
 * The stunt course's CRUSH crest (owner's report: a car on the hill under the CRUSH billboards, wheels flat and the
 * rear bumper in the road). The road peaks at s ≈ 899 (y 9.36 m, the billboards flank it), then drops down the kicker
 * face (−21.5° at s 908, a dip at s ≈ 908–916) to a −9° … −4° descent toward the tunnel mouth.
 */
const track = new Track(TRACKS.find((t) => parseTrack(t).id === "stunt"));
const FRAME = 1 / 60;

/** Most the drawn body's pitch may stray (deg) from the road's slope under its axles, where the springs lag the dip at s ≈ 908. */
const PITCH_LAG: Record<VehicleClassId, number> = { sedan: 2, muscle: 2, police: 2, truck: 3.6, monster: 5.5 };
/** The drop matrix's bounds (ground-fit): a tyre sunk past `gap`, an underside past `pen`, a body off its ground's slope past `pose`. */
const PLAIN = BOUNDS.plain;
/** Most the body may turn in one frame (deg): fleet-ramps' snap bar for a jump. */
const SNAP = 6;
/** Seconds after touchdown by which the body is on the road's slope: the rotation from first contact onto all four tyres. */
const SETTLE_S = 0.1;

function worst(run: Sample[], from: number, to: number) {
  let gap = 0;
  let pen = 0;
  let pitch = 0;
  let framePitch = 0;
  let airFrames = 0;
  for (const r of run) {
    if (r.s < from || r.s > to) continue;
    if (r.airborne) {
      airFrames++;
      continue;
    }
    gap = Math.max(gap, ...r.gaps.map(Math.abs));
    pen = Math.max(pen, r.pen);
    pitch = Math.max(pitch, Math.abs(r.pitch - r.groundPitch));
    framePitch = Math.max(framePitch, Math.abs(r.framePitch - r.groundPitch));
  }
  return { gap, pen, pitch, framePitch, airFrames };
}

describe("given the stunt course's CRUSH crest (the hill under the CRUSH billboards) and the kicker and descent beyond it", () => {
  afterEach(() => setGround(null));

  for (const cls of VEHICLE_CLASS_IDS) {
    it(`when a ${cls} rolls over the crest and down the kicker and the descent at 4 and at 8 m/s, then the body takes the road's slope, the hull stays out of the road and all four tyres stay within 2 cm of it`, (t) => {
      const failures: string[] = [];
      for (const v of [4, 8]) {
        const w = worst(drive(track, cls, 890, 945, () => v, { lead: 40 }), 890, 945);
        t.diagnostic(`${cls} ${v} m/s: tyre gap ${(w.gap * 100).toFixed(1)} cm, hull under the road ${(w.pen * 100).toFixed(1)} cm, drawn pitch ${w.pitch.toFixed(2)}°, frame pitch ${w.framePitch.toFixed(2)}° off the slope, ${w.airFrames} airborne frames`);
        if (w.airFrames > 0) failures.push(`${v} m/s: flew (${w.airFrames} frames)`);
        if (w.gap > 0.02) failures.push(`${v} m/s: a tyre ${(w.gap * 100).toFixed(1)} cm off the road`);
        if (w.pen > 0.01) failures.push(`${v} m/s: hull ${(w.pen * 100).toFixed(1)} cm into the road`);
        if (w.framePitch > 1.5) failures.push(`${v} m/s: frame pitch ${w.framePitch.toFixed(2)}° off the slope`);
        if (w.pitch > PITCH_LAG[cls]) failures.push(`${v} m/s: drawn pitch ${w.pitch.toFixed(2)}° off the slope (${PITCH_LAG[cls]}°)`);
      }
      assert.deepEqual(failures, []);
    });
  }

  for (const cls of VEHICLE_CLASS_IDS) {
    it(`when a ${cls} drives over the crest at 30 m/s, then it leaves the road for about a second and lands on its wheels, with the hull clear of the road all the way`, (t) => {
      const run = drive(track, cls, 885, 1010, () => 30, { lead: 40 });
      let air = 0;
      let landed = -1;
      let was = false;
      for (const [i, r] of run.entries()) {
        if (r.airborne) air++;
        else if (was) landed = i;
        was = r.airborne;
      }
      const after = worst(run.slice(Math.max(0, landed) + 60), 0, Infinity);
      const whole = worst(run, 0, Infinity);
      t.diagnostic(`${cls}: ${(air * FRAME).toFixed(2)} s in the air, landed at s ${landed >= 0 ? run[landed]!.s.toFixed(0) : "-"}; a second later gap ${(after.gap * 100).toFixed(1)} cm, pitch ${after.pitch.toFixed(2)}°; hull under the road all run ${(whole.pen * 100).toFixed(1)} cm`);
      assert.ok(air * FRAME >= 0.6 && air * FRAME <= 2, `${(air * FRAME).toFixed(2)} s in the air`);
      assert.ok(landed > 0, "never landed");
      assert.ok(after.gap <= 0.02, `a second after landing a tyre is ${(after.gap * 100).toFixed(1)} cm off the road`);
      assert.ok(after.pitch <= PITCH_LAG[cls], `a second after landing the body is ${after.pitch.toFixed(2)}° off the slope`);
      assert.ok(whole.pen <= 0.01, `hull ${(whole.pen * 100).toFixed(1)} cm into the road`);
    });
  }

  // From the first frame a tyre reaches the road after the flight (the touchdown the body is seen to make; a stored flight flag used to
  // hide the frames it rotates onto the road in): no snap, nothing sunk past the drop matrix's slop, and on the road's slope by 0.1 s.
  // A snap is looked for from half a second before that frame too: a touch the body bounces off ends its frame in the air.
  for (const cls of VEHICLE_CLASS_IDS) {
    it(`when a ${cls} drives over the crest at 38 m/s, then around its first tyre touching down its body never turns more than ${SNAP}° in a frame, from that touch no tyre sinks more than ${PLAIN.gap * 100} cm and no underside more than ${PLAIN.pen * 100} cm into the road, and by ${SETTLE_S} s after it the body is on the road's slope within ${PLAIN.pose}° with the tyres within ${PLAIN.gap * 100} cm`, (t) => {
      const run = drive(track, cls, 880, 1010, () => 38, { lead: 40 });
      const first = run.findIndex((r, i) => i > 0 && run[i - 1]!.airborne && !r.airborne);
      assert.ok(first > 0, "never landed");
      let turn = 0;
      let sunk = 0;
      let pen = 0;
      for (let i = Math.max(1, first - 30); i < first + 30 && i < run.length; i++) {
        const r = run[i]!;
        turn = Math.max(turn, Math.abs(r.framePitch - run[i - 1]!.framePitch), Math.abs(r.frameRoll - run[i - 1]!.frameRoll));
        if (i < first) continue;
        sunk = Math.max(sunk, ...r.gaps.map((g) => -g));
        pen = Math.max(pen, r.pen);
      }
      const settle = Math.round(SETTLE_S / FRAME);
      const w = worst(run.slice(first + settle, first + 30), 0, Infinity);
      t.diagnostic(`${cls}: touched down at s ${run[first]!.s.toFixed(0)}; the next 0.5 s: most turn in a frame ${turn.toFixed(2)}°, deepest tyre ${(sunk * 100).toFixed(1)} cm, underside ${(pen * 100).toFixed(1)} cm; from ${SETTLE_S} s: tyre gap ${(w.gap * 100).toFixed(1)} cm, frame ${w.framePitch.toFixed(2)}° off the slope`);
      assert.ok(turn <= SNAP, `the body turned ${turn.toFixed(2)}° in one frame after touchdown`);
      assert.ok(sunk <= PLAIN.gap, `a tyre ${(sunk * 100).toFixed(1)} cm into the road after touchdown`);
      assert.ok(pen <= PLAIN.pen, `underside ${(pen * 100).toFixed(1)} cm into the road after touchdown`);
      assert.ok(w.airFrames === 0 && w.gap <= PLAIN.gap && w.framePitch <= PLAIN.pose, `${SETTLE_S} s after touchdown: ${w.airFrames} frames off the road, a tyre ${(w.gap * 100).toFixed(1)} cm off it, the frame ${w.framePitch.toFixed(2)}° off the slope`);
    });
  }

  it("when every class drives over the crest at 6 m/s and at 16 m/s, then none leaves the road at 6 m/s and all do at 16 m/s: the crest gives airtime from a moderate pace", () => {
    const flies = (cls: VehicleClassId, v: number) => drive(track, cls, 885, 975, () => v, { lead: 45 }).some((r) => r.airborne);
    for (const cls of VEHICLE_CLASS_IDS) {
      assert.ok(!flies(cls, 6), `${cls} flew at 6 m/s`);
      assert.ok(flies(cls, 16), `${cls} stayed down at 16 m/s`);
    }
  });
});
