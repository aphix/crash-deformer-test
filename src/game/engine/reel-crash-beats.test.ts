import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { parseTrack } from "../world/track-schema.ts";
import { Track } from "../world/track.ts";
import city from "../world/tracks/city.json" with { type: "json" };
import stunt from "../world/tracks/stunt.json" with { type: "json" };
import { clipTitle, type HighlightClip } from "../match/highlights.ts";
import { crashCamEnd, CUTS } from "../present/engine-cine.ts";
import { raceOn, recordRace, reelViews, type Crash, type RigSample } from "./reel-view.test-util.ts";
import * as THREE from "three";
import { blankPoint } from "../world/track.ts";
import { contextEye } from "../present/highlight-cam.ts";
import { FRAME_HZ } from "../kernel/constants.ts";

/** A replayed frame is one 1/60 s step of the reel's wall clock. */
const FRAME = 1 / FRAME_HZ;
/** The city's straightest 60 m (arc length, m): a staged chain's three cars stand in line on it. */
const STRAIGHT = 592;
const LAP = new Track(parseTrack(city)).length;

/**
 * Owner, 2026-10-10: "the slomo highlights crashes used to stick on the crashes a bit longer before going to a flying ragdoll,
 * where it only goes to following the ragdolls after the 2nd/3rd crash gets its camera focus highlight showing the live
 * deformation". A clip's crash shots are the crash cam's window (its first cut to `crashCamEnd` of the clip's slow-mo hold)
 * and a hit beat for each impact of the clip's scope.
 */
type Played = { clip: HighlightClip; frames: RigSample[] };

/** The clips of a race with `staged` crashes on the city, each with the rig that held every frame of it. */
async function play(name: string, staged: Crash[]): Promise<Played[]> {
  const track = new Track(parseTrack(city));
  const w = raceOn("city", 7, 3);
  const rec = recordRace(w, track, staged, 16);
  const trace: RigSample[] = [];
  await reelViews(w, rec.clips, name, undefined, trace);
  w.race.exit();
  setGround(null);
  return rec.clips.map((clip, i) => ({ clip, frames: trace.filter((s) => s.clip === i) }));
}

/** Wall s into the clip's timeline at which the replay shows clip time `t` (the first frame that reaches it). */
function wallOf(frames: readonly RigSample[], t: number): number {
  return frames.find((f) => f.at >= t - 1e-9)!.wall;
}

/** The crash cam's window on the clip's timeline: from its first cut to its hand-back (`crashCamEnd` of the hold the frame carried). */
function crashWindow(frames: readonly RigSample[]): { from: number; until: number } | null {
  const first = frames.find((f) => f.rig === "crash");
  return first ? { from: first.wall, until: first.wall + crashCamEnd(first.hold) - CUTS[0] } : null;
}

describe("given highlight clips of a head-on that throws both drivers, and of a car at 40 and at 70 m/s into a chain of two stopped cars, replayed through the reel's cameras", () => {
  const played = Promise.all([
    play("headOn", [{ kind: "headOn", at: 0.22 * LAP, speed: 20 }]),
    play("chain6", [{ kind: "chain", at: STRAIGHT, speed: 40, gap: 6, cars: [1, 2, 3] }]),
    play("chain5", [{ kind: "chain", at: STRAIGHT, speed: 70, gap: 5, cars: [1, 2, 3] }]),
  ]).then((all) => all.flat());

  it("when a driver is thrown inside the crash shots, then the ride-along follows him only from the crash cam's hand-back, and never before the clip's last impact", async () => {
    const rides = (await played).filter((p) => p.frames.some((f) => f.rig === "ride"));
    assert.ok(rides.length >= 1, "a clip with a thrown driver to follow");
    for (const { clip, frames } of rides) {
      const win = crashWindow(frames)!;
      const start = frames.find((f) => f.rig === "ride")!.wall;
      assert.ok(start >= win.until - FRAME, `${clipTitle(clip)}: the ride began at ${start.toFixed(2)} s, the crash cam holds until ${win.until.toFixed(2)} s`);
      const last = wallOf(frames, clip.hits[clip.hits.length - 1]!.t);
      assert.ok(start >= last, `${clipTitle(clip)}: the ride began at ${start.toFixed(2)} s, before the last impact at ${last.toFixed(2)} s`);
      assert.ok(
        frames.every((f) => f.rig !== "crash" || f.wall < start),
        `${clipTitle(clip)}: a crash shot after the ride began`,
      );
    }
  });

  it("when a later impact of the clip's scope lands inside the crash cam's window, then the crash cam, not the chase shot or the ride, is on the camera at that impact", async () => {
    let inside = 0;
    for (const { clip, frames } of await played) {
      const win = crashWindow(frames);
      if (!win) continue;
      for (const h of clip.hits.slice(1)) {
        const at = wallOf(frames, h.t);
        if (at < win.from || at >= win.until) continue;
        inside++;
        const f = frames.find((x) => x.wall >= at)!;
        assert.equal(f.rig, "crash", `${clipTitle(clip)}: the impact at ${at.toFixed(2)} s (crash window ${win.from.toFixed(2)} to ${win.until.toFixed(2)} s) was on ${f.rig}`);
      }
    }
    assert.ok(inside >= 1, "a clip with a later impact inside the crash cam's window");
  });

  it("when the crash cam's window is open, then no frame of it falls to the chase shot while a cut has an eye on the hit", async () => {
    for (const { clip, frames } of await played) {
      const win = crashWindow(frames);
      if (!win) continue;
      const gaps = frames.filter((f) => f.wall >= win.from && f.wall < win.until && f.rig !== "crash");
      assert.deepEqual(
        gaps.map((f) => f.wall.toFixed(2)),
        [],
        `${clipTitle(clip)}: frames of the crash cam's window ${win.from.toFixed(2)} to ${win.until.toFixed(2)} s on another camera`,
      );
    }
  });
});

/**
 * The stunt course's road climbs and drops. The crash cam begins a second or more before the car reaches its hit (on the way
 * up the kicker), so it is aimed at the recorded point (`ClipHit.y`), not where the car is then; and a context shot for a far
 * hit has an eye level with the two points when the high ones cannot fit both (`CONTEXT.eyes`).
 */
describe("given a car that hits the wall on the stunt course's kicker 9 m above where its clip starts, replayed through the reel's cameras", () => {
  /** The kicker's deck, where `Track.pointAt` has the road 6.8 m up (arc length, m). */
  const KICKER = 0.38;
  it("when its clip plays, then the crash cam's first cut and every other moment of the clip are in the frame", async () => {
    const track = new Track(parseTrack(stunt));
    const w = raceOn("stunt", 3, 1);
    try {
      const rec = recordRace(w, track, [{ kind: "wall", at: KICKER * track.length, speed: 32, side: -1, cars: [1] }], 12);
      assert.equal(rec.clips.length, 1, "the wall hit makes a clip");
      const hit = rec.clips[0]!.hits[0]!;
      assert.ok(hit.y > 8, `the hit is ${hit.y.toFixed(1)} m up, not on the kicker's deck`);
      const views = await reelViews(w, rec.clips, "stunt kicker wall");
      const out = views.filter((v) => !v.seen).map((v) => `${v.title} ${v.kind} at ${v.at.toFixed(2)} s by ${v.rig}: ndc ${v.ndcX.toFixed(2)},${v.ndcY.toFixed(2)}${v.clear ? "" : " blocked"}, share ${v.share.toFixed(3)}`);
      assert.ok(views.length >= 1, "no moment to see");
      assert.deepEqual(out, [], "moments out of the frame");
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});

describe("given two points 40 m apart on the stunt course, the first on the lip of its drop and the second at the foot of it", () => {
  /** Where the road leaves the deck (arc length, m): its height falls from 7.8 m to 5.0 m within 40 m, then to 2 m. */
  const LIP = 900;
  it("when a context shot is looked for, then there is an eye that keeps both points in one frame (the high eyes cannot fit them: the nearer sits too far below the lens axis)", () => {
    const track = new Track(parseTrack(stunt));
    const w = raceOn("stunt", 3, 1);
    try {
      const a = blankPoint();
      const b = blankPoint();
      track.pointAt(LIP, a);
      track.pointAt(LIP + 40, b);
      const eye = new THREE.Vector3();
      const fov = contextEye(w.race.courseSight()!, { x: a.x, y: a.y + 0.55, z: a.z }, { x: b.x, y: b.y + 0.55, z: b.z }, 0.3, eye, new THREE.Vector3());
      assert.ok(fov > 0, "no eye for the pair");
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});
