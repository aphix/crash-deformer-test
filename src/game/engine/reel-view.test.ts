import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setGround } from "../world/ground.ts";
import type { World } from "../world/race-world.test-util.ts";
import { hold, survivalWorld } from "../world/survival-run.test-util.ts";
import { parseTrack } from "../world/track-schema.ts";
import { Track } from "../world/track.ts";
import city from "../world/tracks/city.json" with { type: "json" };
import stunt from "../world/tracks/stunt.json" with { type: "json" };
import { HAVANA } from "../world/tracks/havana.ts";
import type { HighlightClip } from "../match/highlights.ts";
import { raceOn, recordRace, reelViews, secondsToFirstImpact, STAGED_MEETING_S, VIEW, type Crash, type MomentKind, type MomentView, type Screen } from "./reel-view.test-util.ts";

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

/**
 * The Survival player's crashes on havana start `shift` of the lap on from their usual spot. The wall hit at 0.41 of the lap
 * meets its block 10° off the face, scraping it at 5 m/s into it and slowing the car, so that one starts at 0.38 (a wall hit's 43° to a face along the road).
 */
const HAVANA_SHIFTS = [0, 0, 0.07, 0.1, 0.13, 0.16];

/** Fields of the ramming city race to try (its dice from each seed): a field that rams keeps a clip within a few of them. */
const FIELD_SEEDS = [5, 6, 7, 8, 9, 10];

/** The city's straightest 60 m (arc length, m, `Track.pointAt`): a staged chain's three cars stand in line on it. */
const STRAIGHT = 592;

/** A chain on the city's straight: a car (slot 1) runs into an empty one, which it shoves into a third standing `gap` m behind it; `shift` of 60 m on. */
function chain(shift: number, gap: number): Crash[] {
  return [{ kind: "chain", at: STRAIGHT + shift * 60, speed: 34, gap, cars: [1, 2, 3] }];
}

/** The stunt course's CRUSH crest (arc length, m), where the road drops down the kicker (`crush-crest.test.ts`). */
const CREST = 899;

/**
 * Owner, 2026-10-07: the reel plays behind the results sheet, and the impact or launch must be visible beside it; 10-08:
 * and beside the standings list (top left) that stays open over it. Both as the browser lays them out (CSS px, read off
 * the page's DOM rects at 92f0bd1): the desktop side sheet at its tallest with the list's eight rows, a phone in landscape
 * (side sheet, the list's Auto, leader and watched rows) and in portrait (bottom sheet, the list's five rows).
 */
const LAYOUTS: { name: string; screen: Screen }[] = [
  {
    name: "desktop side sheet and standings",
    screen: { view: { left: 0, top: 0, right: 1280, bottom: 720 }, covers: [{ left: 816, top: 16, right: 1264, bottom: 704 }, { left: 16, top: 90, right: 208, bottom: 314 }] },
  },
  {
    name: "phone landscape side sheet and standings",
    screen: { view: { left: 0, top: 0, right: 844, bottom: 390 }, covers: [{ left: 380, top: 16, right: 828, bottom: 374 }, { left: 16, top: 90, right: 208, bottom: 225 }] },
  },
  {
    name: "phone portrait bottom sheet and standings",
    screen: { view: { left: 0, top: 0, right: 390, bottom: 844 }, covers: [{ left: 8, top: 456, right: 382, bottom: 836 }, { left: 8, top: 82, right: 184, bottom: 307 }] },
  },
];

const views: MomentView[] = [];
const covered: MomentView[][] = LAYOUTS.map(() => []);
let world: World | null = null;
after(() => {
  world?.race.exit();
  setGround(null);
});

async function playClips(name: string, w: World, clips: readonly HighlightClip[]): Promise<void> {
  world = w;
  for (const v of await reelViews(w, clips, name)) views.push(v);
  for (const [i, { screen }] of LAYOUTS.entries()) for (const v of await reelViews(w, clips, name, screen)) covered[i]!.push(v);
  w.race.exit();
  setGround(null);
  world = null;
}

async function scene(name: string, w: World, track: Track, staged: readonly Crash[], seconds: number): Promise<void> {
  world = w;
  const recording = recordRace(w, track, staged, seconds);
  assert.ok(recording.clips.length >= 1, `${name}: no clip`);
  const lone = staged.length === 1 ? staged[0] : undefined;
  if (lone && lone.kind !== "jump" && lone.kind !== "ramp") {
    const opensAfter = secondsToFirstImpact(recording);
    assert.ok(opensAfter <= STAGED_MEETING_S, `${name}: the first clip opens ${opensAfter.toFixed(2)} s after the ${lone.kind} was staged: its cars missed each other`);
  }
  await playClips(name, w, recording.clips);
}

async function cityField(name: string, track: Track, seconds: number): Promise<void> {
  for (const seed of FIELD_SEEDS) {
    const w = raceOn("city", seed, 11);
    world = w;
    const { clips } = recordRace(w, track, [], seconds);
    if (clips.length >= 1) return playClips(name, w, clips);
    w.race.exit();
    setGround(null);
    world = null;
  }
  assert.fail(`${name}: none of ${FIELD_SEEDS.length} ramming fields kept a clip`);
}

describe("given highlight reels from a ramming city race; staged head-ons, wall hits and T-bones among the city's buildings and on the stunt course's tight walls; the Survival player's own crashes among havana's blocks; jumps over the stunt crest onto a car on the landing; and launches up havana's plaza face into the monument", () => {
  before(async () => {
    const cityTrack = new Track(parseTrack(city));
    await cityField("city field", cityTrack, 70);
    const stuntTrack = new Track(parseTrack(stunt));
    const havana = new Track(parseTrack(HAVANA));
    for (const [i, shift] of [0, 0.03, 0.07, 0.1, 0.13, 0.16].entries()) {
      await scene(`city staged +${shift}`, raceOn("city", 8, 7), cityTrack, crashes(cityTrack.length, shift), 20);
      await scene(`stunt staged +${shift}`, raceOn("stunt", 3, 7), stuntTrack, crashes(stuntTrack.length, shift), 20);
      await scene(`havana survival ${i} +${HAVANA_SHIFTS[i]}`, survivalOn(2), havana, [{ ...crashes(havana.length, HAVANA_SHIFTS[i]!)[i % 5]!, cars: [0, 1] }], 16);
    }
    for (const [gap, seed] of [[7, 5], [16, 6], [24, 7]] as const) {
      for (const shift of [0, 0.05, 0.1]) await scene(`city chain gap ${gap} m +${shift}`, raceOn("city", seed, 7), cityTrack, chain(shift, gap), 16);
    }
    for (const land of [28, 32]) await scene(`stunt jump +${land} m`, raceOn("stunt", 3, 7), stuntTrack, [{ kind: "jump", at: CREST, speed: 30, land }], 14);
    for (const [x, z, speed] of [[4, 26, 32], [-1, 30, 36]] as const) {
      await scene(`havana launch (${x}, ${z})`, survivalOn(2), havana, [{ kind: "ramp", x, z, yaw: Math.PI, speed, cars: [0, 1] }], 16);
    }
  });

  it("when each clip plays through the reel's cameras, then at every first impact, later hit of its scope, thrown driver and take-off the moment's point is inside the frame with a margin, no wall or building stands on the line to it, and the subject is not tiny", (t) => {
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
    assert.ok(count("impact") >= 10 && count("hit") >= 6 && count("throw") >= 4 && count("takeoff") >= 4, `too few moments to test: ${[...kinds].map(([k, [, n]]) => `${k} ${n}`).join(", ")}`);
    assert.equal(missed.length, 0, `${missed.length} of ${views.length} moments not visible (margin ${VIEW.margin}, share ${VIEW.share.toFixed(3)})`);
  });

  it("when each clip plays behind the results sheet and the standings list (a desktop side panel, a phone's side panel in landscape, its bottom sheet in portrait), then at every first impact, later hit, thrown driver and take-off the moment's point is in the frame with the margin and clear of both panels by it, unblocked, and not tiny", (t) => {
    const missed: string[] = [];
    for (const [i, { name }] of LAYOUTS.entries()) {
      const seen = covered[i]!.filter((v) => v.seen).length;
      t.diagnostic(`${name}: seen ${seen}/${covered[i]!.length}, under a panel ${covered[i]!.filter((v) => v.covered).length}`);
      for (const v of covered[i]!) {
        if (!v.seen) missed.push(`${name}: ${v.scene} "${v.title}" ${v.kind} at ${v.at.toFixed(2)} s by ${v.rig}: ndc ${v.ndcX.toFixed(2)},${v.ndcY.toFixed(2)}${v.front ? "" : " behind"}${v.covered ? " UNDER A PANEL" : ""}, ${v.clear ? "clear" : "BLOCKED"}, share ${v.share.toFixed(3)}`);
      }
    }
    for (const m of missed) t.diagnostic(m);
    assert.ok(covered.every((c) => c.length === views.length), "every layout plays the same moments");
    assert.equal(missed.length, 0, `${missed.length} moments not visible beside the panels`);
  });

  it("when a hit of a clip's scope comes after its camera changed, then the earlier impact's point is still in the frame at that hit, so the viewer keeps the place", (t) => {
    const later = views.filter((v) => v.kind === "hit");
    const cuts = later.filter((v) => v.back?.cut);
    const lost = cuts.filter((v) => !v.back!.inFrame);
    t.diagnostic(`${later.length} later hits, ${cuts.length} after a camera change, the earlier point lost at ${lost.length}`);
    for (const v of lost) t.diagnostic(`${v.scene} "${v.title}" hit at ${v.at.toFixed(2)} s by ${v.cam}: the earlier point at ndc ${v.back!.ndcX.toFixed(2)},${v.back!.ndcY.toFixed(2)} (${v.note})`);
    assert.ok(later.length >= 6 && cuts.length >= 1, `too few later hits to test: ${later.length} hits, ${cuts.length} after a camera change`);
    assert.deepEqual(lost.map((v) => `${v.scene} ${v.at.toFixed(2)}`), []);
  });

  it("when each clip plays, then its slow-mo holds 6.3 s of wall clock past the cars meeting and 7.3 s past each driver thrown while it runs, every hold plays out in full before the clip ends, it hands back to 1× when the last of those is up, and a driver thrown after that plays at 1×", (t) => {
    const held = views.filter((v) => v.kind !== "takeoff" && v.kind !== "hit" && v.at >= v.hitAt);
    const key = (v: MomentView): string => `${v.scene}|${v.title}|${v.hitAt}`;
    // The hand-back each clip owes, from its moments in order (wall s into the clip).
    const handBack = new Map<string, number>();
    for (const v of held) {
      const h = handBack.get(key(v)) ?? -Infinity;
      if (v.kind === "impact") handBack.set(key(v), v.wall + HOLD.impact);
      else if (v.wall < h) handBack.set(key(v), Math.max(h, v.wall + HOLD.throw));
    }
    const bad: string[] = [];
    const sums: Record<MomentKind, [number, number]> = { impact: [0, 0], hit: [0, 0], throw: [0, 0], takeoff: [0, 0] };
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
