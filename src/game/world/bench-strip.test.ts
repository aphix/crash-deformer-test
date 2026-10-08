import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { benchPlan, type BenchPlan } from "../engine/engine-bench-plan.ts";
import { placeProps } from "./placements.ts";
import { stripCourse, type StripSpec } from "./bench-strip.ts";
import { parseTrack } from "./track-schema.ts";
import { setGround } from "./ground.ts";
import { frame, makeWorld } from "./race-world.test-util.ts";
import { DEFAULT_RACE_OPTIONS, type RaceOptions } from "../match/types.ts";
import { Track } from "./track.ts";
import { OFF_MENU, TRACKS } from "./tracks/index.ts";

const SPEC: StripSpec = { length: 6000, props: [{ prefab: "building", count: 20 }, { prefab: "tree", count: 40 }, { prefab: "rock", count: 20 }], traffic: { lanes: 2, count: 12 } };

describe("given the bench strip course", () => {
  test("when it is parsed and built, then it is an ordinary course whose first 5 km is a straight up +z from the start line", () => {
    const track = new Track(stripCourse(SPEC));
    assert.equal(parseTrack(stripCourse(SPEC)).id, "bench");
    assert.ok(track.length > 2 * 6000, `length ${track.length}`);
    const p = track.pointAt(0, { x: 0, y: 0, z: 0, tx: 0, tz: 0, half: 0 });
    const q = track.pointAt(5000, { x: 0, y: 0, z: 0, tx: 0, tz: 0, half: 0 });
    assert.ok(Math.abs(p.x) < 1e-6 && Math.abs(q.x) < 1e-6 && q.z > 4990 && q.tz > 0.999999, `at 5000 m: x ${q.x}, z ${q.z}, heading z ${q.tz}`);
  });

  test("when it is asked for 20 buildings, 40 trees and 20 rocks, then exactly that many props are placed, each kind in its own row on the lane's left (+x)", () => {
    const placed = placeProps(new Track(stripCourse(SPEC)));
    const by: Record<string, number[]> = {};
    for (const q of placed) (by[q.prefab] ??= []).push(q.x);
    assert.deepEqual(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])), { building: 20, tree: 40, rock: 20 });
    for (const [kind, xs] of Object.entries(by)) assert.ok(xs.every((x) => x > 11), `${kind} props stand outside the wall on the left`);
    const rows = new Set(Object.values(by).map((xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)));
    assert.equal(rows.size, 3, "three different rows");
  });

  const trafficCases: { spec: StripSpec["traffic"]; lanes: number; cars: number }[] = [
    { spec: { lanes: 2, count: 12 }, lanes: 2, cars: 12 },
    { spec: { lanes: 1, count: 8 }, lanes: 1, cars: 8 },
    { spec: { lanes: 2, count: 99 }, lanes: 2, cars: 16 },
  ];
  for (const c of trafficCases) {
    test(`when the traffic is ${c.spec!.lanes} lane(s) x ${c.spec!.count}, then its road has ${c.lanes} lane(s) and ${c.cars} cars, on the right of the race lane (-x)`, () => {
      const track = new Track(stripCourse({ ...SPEC, traffic: c.spec }));
      assert.equal(track.routes.length, 1);
      assert.equal(track.routes[0]!.lanes.length, c.lanes);
      assert.equal(track.routes[0]!.count, c.cars);
      assert.ok(track.routes[0]!.path.x.every((x) => x < -20), "the road is well right of the race lane");
    });
  }

  test("when props and traffic are off, then the course has neither", () => {
    const track = new Track(stripCourse({ ...SPEC, props: [], traffic: null }));
    assert.equal(placeProps(track).length, 0);
    assert.equal(track.routes.length, 0);
  });

  test("when the game lists its courses, then the strip is in neither the race menu nor the off-menu list", () => {
    const ids = [...TRACKS, ...OFF_MENU].map((j) => parseTrack(j).id);
    assert.ok(!ids.includes("bench"));
  });
});

describe("given a page's bench query", () => {
  test("when it is a bare ?bench=strip, then it is the baseline: 16 racers, one sedan body, 2 traffic lanes x 12, 20 buildings + 40 trees + 20 rocks, a 6 km straight", () => {
    const plan = benchPlan("?bench=strip")!;
    assert.equal(plan.racers, 16);
    assert.equal(plan.body, "sedan");
    const strip = plan.strip!;
    assert.equal(strip.length, SPEC.length);
    assert.equal(strip.props.length, SPEC.props.length);
    for (let i = 0; i < SPEC.props.length; i++) {
      assert.equal(strip.props[i]!.prefab, SPEC.props[i]!.prefab, `prop row ${i}`);
      assert.equal(strip.props[i]!.count, SPEC.props[i]!.count, `prop row ${i}`);
    }
    assert.equal(strip.traffic!.lanes, SPEC.traffic!.lanes);
    assert.equal(strip.traffic!.count, SPEC.traffic!.count);
    assert.deepEqual(plan.race, { type: "program", options: { trackId: "bench", laps: 1, aiCount: 15, police: false, aggression: 0.5, spectate: false, noReset: false } });
  });

  const queries: { q: string; check: (p: BenchPlan) => void; what: string }[] = [
    { q: "?bench=strip&props=off", what: "props off", check: (p) => assert.deepEqual(p.strip!.props, []) },
    { q: "?bench=strip&traffic=off", what: "traffic off", check: (p) => assert.equal(p.strip!.traffic, null) },
    { q: "?bench=strip&traffic=1x6", what: "one traffic lane, 6 cars", check: (p) => assert.deepEqual(p.strip!.traffic, { lanes: 1, count: 6 }) },
    { q: "?bench=strip&props=tree:100", what: "100 trees only", check: (p) => assert.deepEqual(p.strip!.props, [{ prefab: "tree", count: 100 }]) },
    { q: "?bench=strip&cars=4&same=off", what: "4 racers on the fleet's mix", check: (p) => assert.deepEqual([p.racers, p.body], [4, null]) },
    { q: "?bench=strip&cars=99", what: "racers capped at 16", check: (p) => assert.equal(p.racers, 16) },
    { q: "?bench=strip&len=100", what: "the straight is at least 1.5 km", check: (p) => assert.equal(p.strip!.length, 1500) },
    { q: "?bench=strip&same=hatchback&traffic=banana&props=nonsense:5", what: "junk values fall back: a hatchback body, no traffic, no props", check: (p) => assert.deepEqual([p.body, p.strip!.traffic, p.strip!.props], ["hatchback", null, []]) },
  ];
  for (const c of queries) test(`when the query is ${c.q}, then ${c.what}`, () => c.check(benchPlan(c.q)!));

  test("when the query names no known bench, then there is no plan; and ?bench=city is the city race with police", () => {
    assert.equal(benchPlan("?bench=nope"), null);
    assert.equal(benchPlan(""), null);
    const city = benchPlan("?bench=city")!;
    assert.deepEqual([city.id, city.racers, city.strip], ["city", 16, null]);
  });
});

describe("given a race field handed the strip as its bench course", () => {
  test("when the strip bench's program races it for 25 s, then 16 racers run up the straight and the traffic in play drives its own road (a car the race has put away is parked off the course), the menu lists no strip and the player's options hold no bench value", () => {
    const w = makeWorld();
    w.race.enter();
    try {
      const plan = benchPlan("?bench=strip")!;
      w.race.loadBenchCourse(plan.course);
      w.race.command(plan.race!);
      w.race.reseed(1);
      w.race.command({ type: "start" });
      const state = { acc: 0 };
      for (let n = 0; n < 25 * 60; n++) frame(w, state);
      const hud = w.race.hud();
      assert.equal(hud.trackName, "Bench strip");
      assert.equal(hud.field, 16);
      assert.ok(!hud.courses.some((c) => c.id === "bench"), "the race menu does not list it");
      for (const key of Object.keys(DEFAULT_RACE_OPTIONS) as (keyof RaceOptions)[]) assert.equal(hud.options[key], DEFAULT_RACE_OPTIONS[key], `the player's own options: ${key}`);
      const cars = w.live();
      assert.equal(cars.length, 16 + 12, "16 racers and 12 traffic cars");
      const lead = Math.max(...cars.slice(0, 16).map((c) => c.group.position.z));
      assert.ok(lead > 300, `the leader is ${lead.toFixed(0)} m up the strip`);
      assert.ok(cars.slice(0, 16).every((c) => Math.abs(c.group.position.x) < 40), "every racer is on the lane");
      assert.ok(cars.slice(16).every((c) => !c.group.visible || c.group.position.x < -20), "traffic in play is on its road to the right");
    } finally {
      w.race.exit();
      setGround(null);
    }
  });
});
