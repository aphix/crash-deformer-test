import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HighlightLedger, impactEnergy, MAX_SPAN, MIN_SCORE, QUIET_GAP, TOP, type CrashCluster } from "./highlights.ts";

const SEDAN = 1400;
const kph = (v: number): number => v / 3.6;

/** One impact between `a` and `b` (−1: a wall) closing at `v` m/s, sedans, at (x, 0). */
function hit(l: HighlightLedger<{ score: number }>, t: number, a: number, b: number, v: number, x = 0): CrashCluster {
  return l.impact(t, a, b, v, impactEnergy(v, SEDAN, b < 0 ? Infinity : SEDAN), x, 0);
}

describe("highlight scoring", () => {
  it("bad: a 4-car pile-up must outrank a single tap, and the tap must not make the reel", () => {
    const pile = new HighlightLedger();
    hit(pile, 10, 0, 1, kph(60));
    hit(pile, 10.3, 1, 2, kph(45));
    hit(pile, 10.6, 2, 3, kph(40));
    hit(pile, 10.8, 0, 3, kph(30));
    const tap = new HighlightLedger();
    const t = hit(tap, 10, 0, 1, kph(20));
    const p = pile.open[0]!;
    assert.equal(pile.open.length, 1, "the pile-up is one cluster");
    assert.ok(p.score > t.score * 3, `pile-up ${p.score.toFixed(1)} vs tap ${t.score.toFixed(1)}`);
    assert.ok(!tap.ranks(t.score), `a 20 km/h tap (${t.score.toFixed(2)}) must stay under MIN_SCORE ${MIN_SCORE}`);
  });

  it("bad: an engine-destroying hit must outrank a wall scrape at the same speed", () => {
    const kill = new HighlightLedger();
    hit(kill, 5, 0, 1, kph(50));
    kill.kill(5.05, 1, 0, 0);
    const scrape = new HighlightLedger();
    hit(scrape, 5, 0, -1, kph(50));
    assert.ok(kill.open[0]!.score > scrape.open[0]!.score + 3, `kill ${kill.open[0]!.score.toFixed(1)} vs scrape ${scrape.open[0]!.score.toFixed(1)}`);
  });

  it("bad: impacts inside the quiet gap must merge into one cluster; a later one, or one far away with other cars, must not", () => {
    const l = new HighlightLedger();
    const a = hit(l, 1, 0, 1, 10);
    assert.equal(hit(l, 1 + QUIET_GAP * 0.9, 1, 2, 10), a, "a shared car inside the gap joins");
    assert.equal(hit(l, 1 + QUIET_GAP * 1.6, 4, 5, 10, 5), a, "nearby (5 m) inside the gap from the last impact joins");
    assert.notEqual(hit(l, 1 + QUIET_GAP * 1.8, 6, 7, 10, 200), a, "200 m away with other cars opens its own");
    assert.notEqual(hit(l, 1 + QUIET_GAP * 4, 0, 1, 10), a, "after the gap the same cars open a new cluster");
    assert.equal(a.impacts, 3);
    assert.equal(a.cars, 0b110111, "cars 0–2, 4 and 5 are in it");
    const long = new HighlightLedger();
    const first = hit(long, 0, 0, 1, 10);
    for (let t = 1; t <= MAX_SPAN; t++) hit(long, t, 0, 1, 10);
    assert.notEqual(hit(long, MAX_SPAN + 1, 0, 1, 10), first, "past MAX_SPAN a cluster stops growing (the recorder's ring holds it)");
  });

  it("bad: the ledger must keep only the TOP best clips, best first", () => {
    const l = new HighlightLedger<{ score: number }>();
    for (const score of [4, 9, 5, 12, 3.5, 7, 20, 6]) if (l.ranks(score)) l.keep({ score });
    assert.deepEqual(
      l.kept.map((c) => c.score),
      [20, 12, 9, 7, 6],
    );
    assert.equal(l.kept.length, TOP);
    assert.ok(!l.ranks(5), "a clip below the fifth no longer ranks");
  });

  it("bad: a cluster must be due only once its post-roll has passed, or at once when the race ends", () => {
    const l = new HighlightLedger();
    hit(l, 10, 0, 1, 10);
    assert.equal(l.due(11), null);
    assert.equal(l.due(11, true)?.first, 10, "race over: cut now");
    hit(l, 20, 0, 1, 10);
    assert.notEqual(l.due(23.1), null);
  });
});
