import { FX_TIER_ULTRA } from "../present/constants.ts";
import { FX_TIERS } from "../present/engine-post.ts";
import { TRACK_ID } from "../world/constants.ts";
import { BENCH_KIND, BENCH_QUERY, COURSE_QUERY, STRIP_QUERY, ULTRA_QUERY } from "./constants.ts";

/**
 * The benchmark loop: one cycle of benches, each its own page load (`?bench=…&loop=<session>&cycle=<n>&step=<i>`, so every bench
 * starts on a clean engine), posting its card before the page moves on. The address is the loop's whole state. This file is the
 * loop's rules; `components/bench-run.ts` holds its navigation.
 */

/** One bench of a cycle: the page query that runs it (`benchPlan`). */
interface BenchStep {
  id: string;
  query: string;
}

/**
 * The biggest of the eight race courses: `bench-loop.test.ts` measures every course's road (dam-spine 4531 m, then four-count
 * 4079 m; the city is 683 m), so a longer course added later fails there until this follows.
 */
export const BIGGEST_COURSE = TRACK_ID.damSpine;

const benchQuery = (kind: string): string => `${BENCH_QUERY}=${kind}`;

const CYCLE: readonly BenchStep[] = [
  { id: BENCH_KIND.strip, query: benchQuery(BENCH_KIND.strip) },
  { id: BENCH_KIND.city, query: benchQuery(BENCH_KIND.city) },
  { id: BIGGEST_COURSE, query: `${benchQuery(BENCH_KIND.city)}&${COURSE_QUERY}=${BIGGEST_COURSE}` },
];

/** The Ultra tier exists in this build (`FX_TIERS`): the loop's Ultra pass (`loopultra=1`) exists only then. */
const FX_TIER_IDS: readonly string[] = FX_TIERS;
export const ULTRA_AVAILABLE: boolean = FX_TIER_IDS.includes(FX_TIER_ULTRA);

/** The query names that carry a loop through the bench pages' addresses (`?bench=…` is the step's own query, `ultra=1` the Ultra twin's). */
const LOOP_QUERY = { session: "loop", cycle: "cycle", step: "step", keep: "keep", auto: "auto", ultraNext: "loopultra", ultraCycle: "cycleultra" } as const;

/**
 * The loop's whole state, read from the address of the bench page it is on: its session (every submission of the loop carries
 * it), the cycle count from 1, the step in the cycle, and the options. The options are read at the end of every step, so an edit
 * to the address takes effect from the next step.
 */
export interface BenchRun {
  session: string;
  loop: number;
  step: number;
  /** This cycle runs each bench's Ultra twin: fixed when the cycle starts, so a `loopultra` edited mid-cycle neither skips nor repeats a bench. */
  ultra: boolean;
  /** Run the cycle again when it ends. */
  keep: boolean;
  /** Reload onto a newly deployed build between benches. */
  auto: boolean;
  /** The next cycle runs each bench's Ultra twin (this cycle's own choice is `ultra`). */
  ultraNext: boolean;
}

/** The benches of one cycle: each with, when asked for and the build has Ultra, its Ultra twin straight after it (same device state, so the pair compares). */
export function cycleOf(ultra: boolean): BenchStep[] {
  const twin = ultra && ULTRA_AVAILABLE;
  return CYCLE.flatMap((s) => (twin ? [s, { id: `${s.id}+ultra`, query: `${s.query}&${ULTRA_QUERY}=1` }] : [s]));
}

/** The first step of a new loop (the Benchmark entry): it keeps benching and reloads onto new builds, with Ultra where the build has it. */
export function startRun(session: string): BenchRun {
  return { session, loop: 1, step: 0, ultra: ULTRA_AVAILABLE, keep: true, auto: true, ultraNext: ULTRA_AVAILABLE };
}

/**
 * A bench page opened by its address alone (typed, shared, bookmarked): a new loop at the step that runs this page's own bench, with
 * the options its address sets (`keep`, `auto`, `loopultra`, `cycleultra`; `=0` is off) and every option it leaves out on, as the
 * Benchmark entry starts one; null for a bench no step of the cycle runs (the lab, another course), which runs once as asked.
 */
export function runFromPage(search: string, session: string): BenchRun | null {
  const q = new URLSearchParams(search);
  const fresh = startRun(session);
  const option = (name: string, absent: boolean): boolean => (q.has(name) ? q.get(name) !== "0" : absent);
  const run: BenchRun = {
    ...fresh,
    ultra: option(LOOP_QUERY.ultraCycle, fresh.ultra) && ULTRA_AVAILABLE,
    keep: option(LOOP_QUERY.keep, fresh.keep),
    auto: option(LOOP_QUERY.auto, fresh.auto),
    ultraNext: option(LOOP_QUERY.ultraNext, fresh.ultraNext) && ULTRA_AVAILABLE,
  };
  const steps = cycleOf(run.ultra);
  for (let i = 0; i < steps.length; i++) {
    const s = new URLSearchParams(steps[i]!.query);
    if (s.get(BENCH_QUERY) === q.get(BENCH_QUERY) && s.get(COURSE_QUERY) === q.get(COURSE_QUERY) && s.get(ULTRA_QUERY) === q.get(ULTRA_QUERY)) return { ...run, step: i };
  }
  return null;
}

/** The step a run is at. */
export function stepOf(run: BenchRun): BenchStep {
  const cycle = cycleOf(run.ultra);
  return cycle[run.step % cycle.length]!;
}

/** The run after its current step is done: the next step, the next cycle (taking `ultraNext` as it is now) when `keep` is set, or null when the loop is over. */
export function advance(run: BenchRun): BenchRun | null {
  if (run.step + 1 < cycleOf(run.ultra).length) return { ...run, step: run.step + 1 };
  return run.keep ? { ...run, loop: run.loop + 1, step: 0, ultra: run.ultraNext } : null;
}

/** The address that runs `run`'s step: this page's path, the bench's query, the strip-shaping params this page carries (`len`, `cars`, …: the cycle's strip step reads them, whichever step this is) and the loop's state; no fragment, no leftover `v`. */
export function stepHref(href: string, run: BenchRun): string {
  const url = new URL(href);
  const flags = [
    [LOOP_QUERY.keep, run.keep],
    [LOOP_QUERY.auto, run.auto],
    [LOOP_QUERY.ultraNext, run.ultraNext],
    [LOOP_QUERY.ultraCycle, run.ultra],
  ] as const;
  const query = [stepOf(run).query, `${LOOP_QUERY.session}=${run.session}`, `${LOOP_QUERY.cycle}=${run.loop}`, `${LOOP_QUERY.step}=${run.step}`];
  for (const name of Object.values(STRIP_QUERY)) {
    const value = url.searchParams.get(name);
    if (value !== null) query.push(`${name}=${encodeURIComponent(value)}`);
  }
  for (const [name, on] of flags) query.push(`${name}=${on ? 1 : 0}`);
  url.search = `?${query.join("&")}`;
  url.hash = "";
  return url.toString();
}

/** This page asks for a bench (`?bench=…`), whether a loop sent it there or someone opened it by hand. */
export function isBenchPage(search: string): boolean {
  return new URLSearchParams(search).has(BENCH_QUERY);
}

/**
 * The share `#` (`hud/share-url.ts`) this page follows: none on a bench page, whose bench plan owns the scene and every setting, so a
 * `#` left in the address (a stale one, or one pasted with the bench's query) neither switches its scene at boot nor on an edit.
 */
export function shareHashOf(search: string, hash: string): string | null {
  return isBenchPage(search) ? null : hash;
}

/**
 * A new loop's session id: eight base-36 characters from `crypto.getRandomValues`, which every page has (`crypto.randomUUID` exists
 * only in a secure context, so a build opened over plain http on the LAN could start no loop).
 */
export function newSession(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => (byte % 36).toString(36)).join("");
}

/** This page asks for reloading onto a newly deployed build (`?auto=1`), on a bench page between benches and on a plain page when idle. */
export function autoReloadAsked(search: string): boolean {
  return new URLSearchParams(search).get(LOOP_QUERY.auto) === "1";
}

/** What every submission of a loop carries, so data across builds lines up: the session, the cycle count and the step. */
export function loopSettings(run: BenchRun, step: BenchStep): { session: string; loop: number; step: string } {
  return { session: run.session, loop: run.loop, step: step.id };
}

/** The loop's place on the bench card: its cycle count and the step in the cycle, e.g. `loop 2, step 1/3`. */
export function loopProgress(run: BenchRun): string {
  const stepCount = cycleOf(run.ultra).length;
  return `loop ${run.loop}, step ${(run.step % stepCount) + 1}/${stepCount}`;
}

/** A whole number from `q`, `fallback` when it is absent, null when it is present but not one. */
function countOf(q: URLSearchParams, name: string, fallback: number): number | null {
  const text = q.get(name);
  if (text === null) return fallback;
  return /^\d{1,6}$/.test(text) ? Number(text) : null;
}

/**
 * The loop a bench page's address names (`loop=<session>`, a bench page only), or null when it names none or a broken one. The
 * cycle count (from 1) and the step default to the first, so a bench opened by hand with just a session becomes a loop from there.
 * An option the address leaves out is on (`=0` turns it off), as for a loop the Benchmark entry starts; the cycle's own Ultra shape
 * (`cycleultra`) is the exception, off when absent, since the step count it numbers must stay what it was.
 */
export function parseRun(search: string): BenchRun | null {
  const q = new URLSearchParams(search);
  const session = q.get(LOOP_QUERY.session);
  if (!isBenchPage(search) || session === null || !/^[a-z0-9]{4,24}$/.test(session)) return null;
  const loop = countOf(q, LOOP_QUERY.cycle, 1);
  const step = countOf(q, LOOP_QUERY.step, 0);
  if (loop === null || loop < 1 || step === null) return null;
  const on = (name: string): boolean => q.get(name) !== "0";
  return { session, loop, step, ultra: q.get(LOOP_QUERY.ultraCycle) === "1", keep: on(LOOP_QUERY.keep), auto: on(LOOP_QUERY.auto), ultraNext: on(LOOP_QUERY.ultraNext) && ULTRA_AVAILABLE };
}
