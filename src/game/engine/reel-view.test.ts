import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import { makeWorld, type World } from "../world/race-world.test-util.ts";
import { hold, survivalWorld } from "../world/survival-run.test-util.ts";
import { parseTrack } from "../world/track-schema.ts";
import { Track } from "../world/track.ts";
import city from "../world/tracks/city.json" with { type: "json" };
import stunt from "../world/tracks/stunt.json" with { type: "json" };
import { HAVANA } from "../world/tracks/havana.ts";
import { recordRace, reelViews, VIEW, type Crash, type MomentKind, type MomentView } from "./reel-view.test-util.ts";

/**
 * Owner, 2026-10-06: "the impact point (car-car hit) or the launch (driver ejection, car taking off) must actually be visible
 * from the chosen camera at the moment it happens". Visible is `VIEW`: the point inside the frame with a margin, no wall,
 * building or hill of the course on the line to it, and the subject not tiny.
 *
 * Owner, 2026-10-07: "hold car collisions a little longer and human ejections about twice as long, in real world time". On
 * main the browser timed 4.50 s of wall clock from the cars meeting to the slow-mo's hand-back to 1×, and 3.65 s from a
 * driver thrown: `HOLD` is +40 % and 2× of those.
 */
const HOLD = { impact: 6.3, throw: 7.3 };
/** Three steps of the reel's 120 Hz timeline. */
const STEP = 1 / 40;

/** A race entered on `trackId` with a ramming field of `aiCount` and its dice from `seed`. */
function raceOn(trackId: string, seed: number, aiCount: number): World {
  const w = makeWorld();
  w.race.enter();
  w.race.command({ type: "quit" });
  w.race.command({ type: "options", options: { trackId, laps: 1, aiCount, noReset: false, aggression: 1 } });
  w.race.reseed(seed);
  w.race.command({ type: "start" });
  w.seat.mode = "follow";
  return w;
}

/** A Survival run on havana (the Survival course, off the race menu), its player sitting still until a staged crash floors it. */
function survivalOn(seed: number): World {
  const w = survivalWorld(undefined, seed);
  hold(w);
  return w;
}

/** Head-ons, wall hits both sides and a T-bone at these shares of the lap, all moved on by `shift` of it. */
function crashes(len: number, shift: number): Crash[] {
  return [
    { kind: "headOn", at: len * (0.22 + shift), speed: 20 },
    { kind: "wall", at: len * (0.38 + shift), speed: 24, side: 1 },
    { kind: "tBone", at: len * (0.55 + shift), speed: 22 },
    { kind: "headOn", at: len * (0.7 + shift), speed: 22 },
    { kind: "wall", at: len * (0.86 + shift), speed: 24, side: -1 },
  ];
}

/** The stunt course's CRUSH crest (arc length, m), where the road drops down the kicker (`crush-crest.test.ts`). */
const CREST = 899;

const views: MomentView[] = [];
let world: World | null = null;
after(() => {
  world?.race.exit();
  setGround(null);
});

async function scene(name: string, w: World, track: Track, staged: readonly Crash[], seconds: number): Promise<void> {
  world = w;
  const clips = recordRace(w, track, staged, seconds);
  assert.ok(clips.length >= 1, `${name}: no clip`);
  for (const v of await reelViews(w, clips, name)) views.push(v);
  w.race.exit();
  setGround(null);
  world = null;
}

describe("given highlight reels from a ramming city race; staged head-ons, wall hits and T-bones among the city's buildings and on the stunt course's tight walls; the Survival player's own crashes among havana's blocks; jumps over the stunt crest onto a car on the landing; and launches up havana's plaza face into the monument", () => {
  before(async () => {
    const cityTrack = new Track(parseTrack(city));
    await scene("city field", raceOn("city", 5, 11), cityTrack, [], 70);
    const stuntTrack = new Track(parseTrack(stunt));
    const havana = new Track(parseTrack(HAVANA));
    for (const [i, shift] of [0, 0.03, 0.07, 0.1, 0.13, 0.16].entries()) {
      await scene(`city staged +${shift}`, raceOn("city", 8, 7), cityTrack, crashes(cityTrack.length, shift), 20);
      await scene(`stunt staged +${shift}`, raceOn("stunt", 3, 7), stuntTrack, crashes(stuntTrack.length, shift), 20);
      await scene(`havana survival +${shift}`, survivalOn(2), havana, [{ ...crashes(havana.length, shift)[i % 5]!, cars: [0, 1] }], 16);
    }
    for (const land of [28, 32]) await scene(`stunt jump +${land} m`, raceOn("stunt", 3, 7), stuntTrack, [{ kind: "jump", at: CREST, speed: 30, land }], 14);
    for (const [x, z, speed] of [[4, 26, 32], [-1, 30, 36]] as const) {
      await scene(`havana launch (${x}, ${z})`, survivalOn(2), havana, [{ kind: "ramp", x, z, yaw: Math.PI, speed, cars: [0, 1] }], 16);
    }
  });

  it("when each clip plays through the reel's cameras, then at every first impact, thrown driver and take-off the moment's point is inside the frame with a margin, no wall or building stands on the line to it, and the subject is not tiny", (t) => {
    const kinds = new Map<string, [number, number]>();
    for (const v of views) {
      const k = kinds.get(v.kind) ?? [0, 0];
      k[0] += v.seen ? 1 : 0;
      k[1]++;
      kinds.set(v.kind, k);
    }
    const missed = views.filter((v) => !v.seen);
    t.diagnostic(`seen ${views.length - missed.length}/${views.length}: ${[...kinds].map(([k, [a, n]]) => `${k} ${a}/${n}`).join(", ")}`);
    for (const v of missed) {
      t.diagnostic(`${v.scene} "${v.title}" ${v.kind} at ${v.at.toFixed(2)} s by ${v.rig}: ndc ${v.ndcX.toFixed(2)},${v.ndcY.toFixed(2)}${v.front ? "" : " behind"}, ${v.clear ? "clear" : "BLOCKED"}, share ${v.share.toFixed(3)} (${v.note})`);
    }
    const count = (kind: string): number => kinds.get(kind)?.[1] ?? 0;
    assert.ok(count("impact") >= 10 && count("throw") >= 4 && count("takeoff") >= 4, `too few moments to test: ${[...kinds].map(([k, [, n]]) => `${k} ${n}`).join(", ")}`);
    assert.equal(missed.length, 0, `${missed.length} of ${views.length} moments not visible (margin ${VIEW.margin}, share ${VIEW.share.toFixed(3)})`);
  });

  it("when each clip plays, then its slow-mo holds 6.3 s of wall clock past the cars meeting and 7.3 s past each driver thrown while it runs, every hold plays out in full before the clip ends, it hands back to 1× when the last of those is up, and a driver thrown after that plays at 1×", (t) => {
    const held = views.filter((v) => v.kind !== "takeoff" && v.at >= v.hitAt);
    const key = (v: MomentView): string => `${v.scene}|${v.title}|${v.hitAt}`;
    // The hand-back each clip owes, from its moments in order (wall s into the clip).
    const handBack = new Map<string, number>();
    for (const v of held) {
      const h = handBack.get(key(v)) ?? -Infinity;
      if (v.kind === "impact") handBack.set(key(v), v.wall + HOLD.impact);
      else if (v.wall < h) handBack.set(key(v), Math.max(h, v.wall + HOLD.throw));
    }
    const bad: string[] = [];
    const sums: Record<MomentKind, [number, number]> = { impact: [0, 0], throw: [0, 0], takeoff: [0, 0] };
    let late = 0;
    for (const v of held) {
      const h = handBack.get(key(v))!;
      const want = v.wall < h ? h - v.wall : 0;
      if (Math.abs(v.hold - want) > STEP) bad.push(`${v.scene} "${v.title}" ${v.kind} at ${v.at.toFixed(2)} s: held ${v.hold.toFixed(2)} s, owed ${want.toFixed(2)}${h > v.end ? `, clip ends ${(v.end - v.wall).toFixed(2)} s after it` : ""}`);
      if (want === 0) late++;
      else {
        sums[v.kind][0] += v.hold;
        sums[v.kind][1]++;
      }
    }
    t.diagnostic(`mean hold (wall s): impact ${(sums.impact[0]! / sums.impact[1]!).toFixed(2)} over ${sums.impact[1]}, throw ${(sums.throw[0]! / sums.throw[1]!).toFixed(2)} over ${sums.throw[1]}; ${late} throws after the hand-back`);
    assert.ok(sums.impact[1]! >= 10 && sums.throw[1]! >= 4, `too few holds to test: ${sums.impact[1]} impacts, ${sums.throw[1]} throws`);
    assert.deepEqual(bad, []);
  });
});
