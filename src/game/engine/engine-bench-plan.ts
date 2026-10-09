import type { RaceCommand } from "../match/types.ts";
import type { LabPresetId } from "../scenes/lab.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import type { CarStyleId } from "../vehicle/car-variants.ts";
import { PREFABS, type PrefabId } from "../world/catalog.ts";
import { stripCourse, type StripProp, type StripSpec } from "../world/bench-strip.ts";
import { CAMPAIGN } from "../world/tracks/index.ts";
import { BENCH_STRIP_ID, TRACK_ID } from "../world/constants.ts";
import { BENCH_KIND, BENCH_QUERY, COURSE_QUERY, STRIP_QUERY, ULTRA_QUERY } from "./constants.ts";

/** The city bench's race on course `trackId`: its own field and rules as a program over the player's options, which it never touches. */
function benchRace(trackId: string): RaceCommand {
  return { type: "program", options: { trackId, laps: 9, aiCount: 15, police: true, aggression: 1, spectate: false, noReset: false } };
}
export const BENCH_RACE: RaceCommand = benchRace(TRACK_ID.city);

/** One throw of the Lab bench: the set it loads, then the thrower (item 0) let go at `along` m/s along the bench and `up` m/s up (what a flick's swipe gives it, stored so every run hits alike). */
type LabThrow = { preset: LabPresetId; along: number; up: number };

/**
 * `?bench=lab`: the throws in turn, one each `segmentS` sim seconds: at the house of cards' top car, then at the wall of props,
 * about 30 m/s each. A set loads at its segment's start (the HUD's set picker, or Reset for the set already up)
 * and stands `settleS` before its throw, which lands about 0.8 s later, inside an A/B block's 3 s.
 */
const LAB_BENCH: { throws: readonly LabThrow[]; segmentS: number; settleS: number } = {
  throws: [
    { preset: "cards", along: 30, up: 5.4 },
    { preset: "wall", along: 30, up: 3.6 },
  ],
  segmentS: 4,
  settleS: 0.5,
};

/** Which bench a page asks for, and everything it sets up. */
export interface BenchPlan {
  id: string;
  /** The race to program (`engine.raceCommand`; null: the Lab, no race), and the course it runs when it is not one of the game's (the strip). */
  race: RaceCommand | null;
  course: unknown;
  /** Clock (s) to run before the window opens: race clock from the green, or the Lab's sim seconds (its first set settling). */
  warmS: number;
  /** Racers in the race (the player's car included). */
  racers: number;
  /** The one body every non-police car wears; null: the fleet's mix. */
  body: CarStyleId | null;
  strip: StripSpec | null;
  lab: typeof LAB_BENCH | null;
  /** `&ultra=1`: the card also runs the Ultra look as an FX arm, against the other tiers (`runBench`). */
  ultra: boolean;
}

/** The strip's defaults: a bare `?bench=strip` is the repeatable baseline. */
const STRIP_DEFAULTS = { length: 6000, props: "building:20,tree:40,rock:20", traffic: "2x12", cars: 16, same: "sedan" } as const;
const BODIES: Readonly<Record<string, true>> = { sedan: true, hatchback: true, wagon: true, coupe: true, pickup: true };

/** `building:20,tree:40` -> the prop rows; `off` (or nothing valid) -> none. */
function parseProps(v: string): StripProp[] {
  if (v === "off") return [];
  const rows: StripProp[] = [];
  for (const part of v.split(",")) {
    const [name, n] = part.split(":");
    const count = Math.round(Number(n));
    if (name && Object.hasOwn(PREFABS, name) && Number.isFinite(count) && count > 0) rows.push({ prefab: name as PrefabId, count: Math.min(count, 400) });
  }
  return rows;
}

/** `2x12` -> two lanes, twelve cars; `off` -> none. Lanes 1 or 2, cars 1-16. */
function parseTraffic(v: string): StripSpec["traffic"] {
  const m = /^([12])x(\d+)$/.exec(v);
  if (!m) return null;
  return { lanes: Number(m[1]) === 2 ? 2 : 1, count: Math.min(16, Math.max(1, Number(m[2]))) };
}

/**
 * The bench a page's query asks for: `?bench=city` (with `course=<campaign course id>` for the same field on another course), `?bench=lab` (`LAB_BENCH`), or `?bench=strip` with optional `props=building:20,tree:40,rock:20|off`,
 * `traffic=2x12|1x8|off`, `cars=16` (racers, 2-16), `same=sedan|hatchback|wagon|coupe|pickup|off` (one body for every car, or
 * the fleet's mix) and `len=6000` (the straight, m: 1500-12000). A value that does not parse falls back to its default; the card
 * prints what ran. Any bench takes `ultra=1` (the Ultra arm). Null for any other `bench=`.
 */
export function benchPlan(search: string): BenchPlan | null {
  const q = new URLSearchParams(search);
  const kind = q.get(BENCH_QUERY);
  const ultra = q.get(ULTRA_QUERY) === "1";
  if (kind === BENCH_KIND.city) {
    const course = q.get(COURSE_QUERY);
    const id = course !== null && CAMPAIGN.includes(course) ? course : TRACK_ID.city;
    return { id, race: id === TRACK_ID.city ? BENCH_RACE : benchRace(id), course: null, warmS: 20, racers: 16, body: null, strip: null, lab: null, ultra };
  }
  if (kind === BENCH_KIND.lab) return { id: "lab", race: null, course: null, warmS: LAB_BENCH.settleS, racers: 0, body: null, strip: null, lab: LAB_BENCH, ultra };
  if (kind !== BENCH_KIND.strip) return null;
  const racers = Math.min(16, Math.max(2, Math.round(Number(q.get(STRIP_QUERY.cars) ?? STRIP_DEFAULTS.cars)) || STRIP_DEFAULTS.cars));
  const same = q.get(STRIP_QUERY.same) ?? STRIP_DEFAULTS.same;
  const body = same === "off" ? null : Object.hasOwn(BODIES, same) ? (same as CarStyleId) : (STRIP_DEFAULTS.same as CarStyleId);
  const length = Math.min(12000, Math.max(1500, Math.round(Number(q.get(STRIP_QUERY.len) ?? STRIP_DEFAULTS.length)) || STRIP_DEFAULTS.length));
  const strip: StripSpec = { length, props: parseProps(q.get(STRIP_QUERY.props) ?? STRIP_DEFAULTS.props), traffic: parseTraffic(q.get(STRIP_QUERY.traffic) ?? STRIP_DEFAULTS.traffic) };
  return {
    id: BENCH_STRIP_ID,
    race: { type: "program", options: { trackId: BENCH_STRIP_ID, laps: 1, aiCount: racers - 1, police: false, aggression: 0.5, spectate: false, noReset: false } },
    course: stripCourse(strip),
    warmS: 8,
    racers,
    body,
    strip,
    lab: null,
    ultra,
  };
}

/** The strip bench's settings and how far up the straight the lead racer got, at the window's end and at the end of the run. */
export interface StripResult {
  spec: StripSpec;
  body: CarStyleId | null;
  racers: number;
  leaderWindowM: number;
  leaderEndM: number;
}

/** The card's strip lines: what ran, and whether the window stayed on the straight. */
export function stripLines(s: StripResult): string[] {
  const props = s.spec.props.length ? s.spec.props.map((p) => `${p.prefab} ${p.count}`).join(", ") : "off";
  const traffic = s.spec.traffic ? `${s.spec.traffic.lanes} lane${s.spec.traffic.lanes === 2 ? "s" : ""} x ${s.spec.traffic.count} cars` : "off";
  // The path leaves the straight a node (400 m) before its end.
  const onStraight = s.leaderEndM < s.spec.length - 400;
  return [
    `strip ${s.spec.length} m: props ${props}; traffic ${traffic}; ${s.racers} racers, ${s.body ? `all ${s.body}` : "mixed bodies"}`,
    `lead racer ${Math.round(s.leaderWindowM)} m up the strip when the window ended, ${Math.round(s.leaderEndM)} m at the end of the run: ${onStraight ? "on the straight throughout" : "REACHED THE TURN, the late blocks include it"}`,
  ];
}

/** The card's Lab line: the throws in turn, and how many of them the window saw. */
export function labLine(thrown: number): string {
  const throws = LAB_BENCH.throws.map((t) => `${t.preset} at ${t.along} m/s along the bench, ${t.up} m/s up`).join(", then ");
  return `lab: ${throws}; one each ${LAB_BENCH.segmentS} sim-s, ${LAB_BENCH.settleS} s after its set loads, time held at 1x; ${thrown} thrown in the window`;
}

/** How far the lead racer is up the strip (m); 0 on the city course, which has no straight to stay on. */
export function leaderAhead(parts: { live(): readonly DeformableCar[] }, plan: BenchPlan): number {
  if (!plan.strip) return 0;
  let best = 0;
  const cars = parts.live();
  for (let i = 0; i < plan.racers && i < cars.length; i++) best = Math.max(best, cars[i]!.group.position.z);
  return best;
}
