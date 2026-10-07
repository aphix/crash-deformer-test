import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clipScore, countsAsImpact, HighlightLedger, IMPACT_MIN, impactEnergy, MAX_SPAN, MIN_SCORE, QUIET_GAP, REHIT_S, TOP, type CrashCluster } from "./highlights.ts";

const SEDAN = 1400;
const kph = (v: number): number => v / 3.6;

/** One impact between `a` and `b` (−1: a wall) closing at `v` m/s, sedans, at (x, 0); `a` drives at `va` m/s and `b` at `vb`. */
function hit(l: HighlightLedger<{ score: number }>, t: number, a: number, b: number, v: number, x = 0, va = v, vb = 0): CrashCluster {
  return l.impact(t, a, b, v, impactEnergy(v, SEDAN, b < 0 ? Infinity : SEDAN), x, 0, 0, va, vb);
}

describe("given a highlight ledger (the list of crash clusters scored for the highlight reel)", () => {
  it("when a 4-car pile-up and a lone 20 km/h tap are scored, then the pile-up is one cluster that outranks the tap by more than 3 times and the tap does not make the reel", () => {
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

  it("when an engine-destroying hit and a wall scrape happen at the same 50 km/h, then the engine-destroying hit scores more than 3 points above the scrape", () => {
    const kill = new HighlightLedger();
    hit(kill, 5, 0, 1, kph(50));
    kill.kill(5.05, 1, 0, 0);
    const scrape = new HighlightLedger();
    hit(scrape, 5, 0, -1, kph(50));
    assert.ok(kill.open[0]!.score > scrape.open[0]!.score + 3, `kill ${kill.open[0]!.score.toFixed(1)} vs scrape ${scrape.open[0]!.score.toFixed(1)}`);
  });

  it("when a driver is thrown out in a 20 km/h wall tap, then the tap alone stays off the reel but the ejection scores far above a 100 km/h head-on, names the thrown car as the subject and makes the reel", () => {
    const head = new HighlightLedger();
    hit(head, 5, 0, 1, kph(100));
    const wall = new HighlightLedger();
    hit(wall, 5, 0, -1, kph(20));
    assert.ok(!wall.ranks(wall.open[0]!.score), `a 20 km/h wall tap alone scores ${wall.open[0]!.score.toFixed(2)}, under MIN_SCORE ${MIN_SCORE}`);
    wall.eject(5.03, 0, 0, 0);
    const thrown = wall.open[0]!;
    assert.equal(thrown.ejects, 1);
    assert.equal(thrown.focus, 0, "the ejected car is the subject");
    assert.ok(thrown.score > head.open[0]!.score + 5, `ejection ${thrown.score.toFixed(1)} vs head-on ${head.open[0]!.score.toFixed(1)}`);
    assert.ok(wall.ranks(thrown.score));
  });

  it("when contacts come after different quiet spells and at different speeds, then a contact counts as an impact only after the quiet spell and from the minimum impact speed, whether car, wall or prop (one rule for the recorder and the replay)", () => {
    assert.equal(countsAsImpact(REHIT_S + 0.01, IMPACT_MIN), true);
    assert.equal(countsAsImpact(REHIT_S - 0.01, 30), false, "a contact 0.34 s after the last is grinding");
    assert.equal(countsAsImpact(5, IMPACT_MIN - 0.1), false, "a soft touch");
    assert.equal(countsAsImpact(5, 5), false, "the old 5 m/s floor: a slow bump is no impact");
    assert.equal(countsAsImpact(Infinity, IMPACT_MIN), true, "the first ever contact");
  });

  it("when impacts land inside, outside and far from an open cluster, then those inside the quiet gap merge into one cluster while a later one, or a far one with other cars, opens its own, and a cluster stops growing past its maximum span", () => {
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

  it("when more clips are offered than the reel holds, then the ledger keeps only the best five, best first, and a clip below the fifth no longer ranks", () => {
    const l = new HighlightLedger<{ score: number }>();
    for (const score of [4, 9, 5, 12, 3.5, 7, 20, 6]) if (l.ranks(score)) l.keep({ score });
    assert.deepEqual(
      l.kept.map((c) => c.score),
      [20, 12, 9, 7, 6],
    );
    assert.equal(l.kept.length, TOP);
    assert.ok(!l.ranks(5), "a clip below the fifth no longer ranks");
  });

  it("when a cluster's last impact is 1 s old, 3.1 s old, or the race has ended, then it is due only once its post-roll has passed, or at once when the race ends", () => {
    const l = new HighlightLedger();
    hit(l, 10, 0, 1, 10);
    assert.equal(l.due(11), null);
    assert.equal(l.due(11, true)?.first, 10, "race over: cut now");
    hit(l, 20, 0, 1, 10);
    assert.notEqual(l.due(23.1), null);
  });
});

describe("given cars A (0) and B (1) colliding, and another crash that starts near them", () => {
  it("when an unrelated pair 25 m away crashes and throws a driver out, then the far crash opens a cluster of its own: the A-B cluster counts two cars, no ejection and the score of A-B alone, and the far one holds the ejection", () => {
    const alone = new HighlightLedger();
    hit(alone, 10, 0, 1, kph(80));
    const l = new HighlightLedger();
    hit(l, 10, 0, 1, kph(80));
    hit(l, 10.1, 2, 3, kph(80), 25);
    l.eject(10.15, 2, 25, 0);
    assert.equal(l.open.length, 2, "the far crash is not in the A-B scope");
    const [ab, far] = l.open as [CrashCluster, CrashCluster];
    assert.deepEqual({ hit: ab.hit, ejects: ab.ejects, kills: ab.kills }, { hit: 2, ejects: 0, kills: 0 });
    assert.equal(ab.score, alone.open[0]!.score, "the far crash adds nothing to the clip about A and B");
    assert.deepEqual({ hit: far.hit, ejects: far.ejects, focus: far.focus, mask: far.hitCars }, { hit: 2, ejects: 1, focus: 2, mask: 0b1100 }, "the far pair, its thrown driver the subject");
  });

  const reach = [
    { m: 8, ejects: [1], it: "8 m from the A-B hit" },
    { m: 12, ejects: [0, 1], it: "12 m from the A-B hit (the old 30 m rule claimed it)" },
    { m: 25, ejects: [0, 1], it: "25 m from the A-B hit (the old 30 m rule claimed it)" },
  ];
  for (const r of reach) {
    it(`when an unrelated driver is thrown out ${r.it}, then the clusters' ejections are ${JSON.stringify(r.ejects)}`, () => {
      const l = new HighlightLedger();
      hit(l, 10, 0, 1, kph(80));
      l.eject(10.2, 2, r.m, 0);
      assert.equal(l.open.map((c) => c.ejects).join(), r.ejects.join());
    });
  }

  it("when B then hits a car C that stands 6 m on, and later a car D is hit 20 m from A's hit, then C is in the pile-up and D's crash is a cluster of its own", () => {
    const l = new HighlightLedger();
    hit(l, 10, 0, 1, kph(80));
    hit(l, 10.4, 1, 2, kph(60), 6);
    assert.equal(l.open[0]!.hit, 3, "A, B and C");
    hit(l, 10.6, 3, 4, kph(60), 20);
    assert.deepEqual(
      l.open.map((c) => c.hit),
      [3, 2],
    );
  });

  it("when B then hits a car C 18 m from A's hit, throwing C's driver, and a car D is hit 8 m past that, then B's hit on C is in scope too: the pile-up counts A, B, C and D's crash, and C's throw counts (10 m round each in-scope impact)", () => {
    const l = new HighlightLedger();
    hit(l, 10, 0, 1, kph(80));
    hit(l, 10.4, 1, 2, kph(60), 18);
    l.eject(10.45, 2, 18, 0);
    hit(l, 10.6, 3, 4, kph(60), 26);
    const c = l.open[0]!;
    assert.deepEqual({ clusters: l.open.length, hit: c.hit, ejects: c.ejects, impacts: c.impacts, hits: c.hits().map((p) => p.x) }, { clusters: 1, hit: 5, ejects: 1, impacts: 3, hits: [0, 18, 26] });
  });

  it("when a bystander pair is hit 8 m from the A-B hit and an unrelated driver is then thrown out 8 m beyond it, 16 m from A-B, then the bystander hit is in the scope but starts no circle of its own: the throw stays out", () => {
    const l = new HighlightLedger();
    hit(l, 10, 0, 1, kph(80));
    hit(l, 10.2, 2, 3, kph(60), 8);
    l.eject(10.3, 4, 16, 0);
    assert.deepEqual(
      l.open.map((c) => ({ hit: c.hit, ejects: c.ejects })),
      [
        { hit: 4, ejects: 0 },
        { hit: 1, ejects: 1 },
      ],
    );
  });

  it("when a stronger hit that B takes far off makes its other car the main car, then the crash of A and a car X, no longer in that scope, is the cluster's rest and a clip of its own", () => {
    const l = new HighlightLedger();
    hit(l, 10, 0, 3, kph(60), -20);
    hit(l, 10.2, 0, 1, kph(70));
    hit(l, 10.4, 1, 4, kph(120), 25, 0, kph(120));
    assert.equal(l.open.length, 1);
    const c = l.open[0]!;
    assert.deepEqual({ main: c.main, hitCars: c.hitCars }, { main: 4, hitCars: 0b10011 }, "the scope is B's crash with A and with the main car G");
    const rest = c.rest();
    assert.ok(rest, "A's crash with X is left over");
    assert.deepEqual({ main: rest.main, hitCars: rest.hitCars, again: rest.rest() }, { main: 0, hitCars: 0b1001, again: null });
    assert.equal(c.hitCars, 0b10011, "the cluster itself is as it was");
  });
});

describe("given the owner's example, a 2 m total crush at 30 km/h against a 1 m crush at 60 km/h", () => {
  it("when each is a lone sedan hit scored with its crush, then the 2 m crush at 30 km/h outranks the 1 m crush at 60 km/h", () => {
    const slow = hit(new HighlightLedger(), 10, 0, 1, kph(30)).score;
    const fast = hit(new HighlightLedger(), 10, 0, 1, kph(60)).score;
    assert.ok(clipScore(slow, 2) > clipScore(fast, 1), `30 km/h ${slow.toFixed(2)} + 2 m = ${clipScore(slow, 2).toFixed(2)} vs 60 km/h ${fast.toFixed(2)} + 1 m = ${clipScore(fast, 1).toFixed(2)}: a metre must be worth more than ${(fast - slow).toFixed(2)}`);
  });
});

describe("given a head-on between a car driving at 50 km/h and one at 20 km/h (closing 70 km/h), or one car into a parked one", () => {
  const rows = [
    { it: "the faster car is the lower-numbered one (50 and 20 km/h)", a: 50, b: 20, kph: 50 },
    { it: "the faster car is the higher-numbered one (20 and 50 km/h)", a: 20, b: 50, kph: 50 },
    { it: "one car at 70 km/h hits a parked one", a: 70, b: 0, kph: 70 },
  ];
  for (const r of rows) {
    it(`when ${r.it}, then the cluster's hit speed is the main car's own ${r.kph} km/h, not the 70 km/h closing`, () => {
      const l = new HighlightLedger();
      const c = hit(l, 10, 0, 1, kph(70), 0, kph(r.a), kph(r.b));
      assert.ok(Math.abs(c.hitMps * 3.6 - r.kph) < 1e-9, `${(c.hitMps * 3.6).toFixed(2)} km/h`);
      assert.ok(Math.abs(c.peak * 3.6 - 70) < 1e-9, "the closing speed stays the peak the impact's flash uses");
    });
  }
  it("when a car hits the wall, then its hit speed is its speed into the wall", () => {
    const l = new HighlightLedger();
    const c = hit(l, 10, 0, -1, kph(80), 0, kph(95), 0);
    assert.ok(Math.abs(c.hitMps * 3.6 - 80) < 1e-9);
  });
});
