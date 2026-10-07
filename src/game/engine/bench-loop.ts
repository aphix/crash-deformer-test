import { FX_TIER_ULTRA } from "../present/constants.ts";
import { FX_TIERS } from "../present/engine-post.ts";
import { TRACK_ID } from "../world/constants.ts";
import { BENCH_KIND, BENCH_QUERY, ULTRA_QUERY } from "./constants.ts";

/**
 * The benchmark loop: one cycle of benches, each its own page load (`?bench=…&loop=<session>`, so every bench starts on a clean
 * engine), posting its card before the page moves on. This file is the loop's rules; `components/bench-run.ts` holds its
 * storage and navigation.
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
  { id: BIGGEST_COURSE, query: `${benchQuery(BENCH_KIND.city)}&course=${BIGGEST_COURSE}` },
];

/** The Ultra tier exists in this build (`FX_TIERS`): the "include Ultra" choice is offered only then. */
const FX_TIER_IDS: readonly string[] = FX_TIERS;
export const ULTRA_AVAILABLE: boolean = FX_TIER_IDS.includes(FX_TIER_ULTRA);

/** What the player ticked, kept across reloads. */
export interface BenchPrefs {
  /** Run the cycle again when it ends. */
  keep: boolean;
  /** Reload onto a newly deployed build between benches (and when idle). */
  auto: boolean;
  /** Each bench is followed by its Ultra pass. */
  ultra: boolean;
}

/** Where a running loop is: its session (every submission of the loop carries it), the cycle count from 1, and the step in the cycle. */
export interface BenchRun {
  session: string;
  loop: number;
  step: number;
  /** This cycle runs each bench's Ultra twin: fixed when the cycle starts, so a box ticked mid-cycle neither skips nor repeats a bench. */
  ultra: boolean;
}

/** The benches of one cycle: each with, when asked for and the build has Ultra, its Ultra twin straight after it (same device state, so the pair compares). */
export function cycleOf(ultra: boolean): BenchStep[] {
  const twin = ultra && ULTRA_AVAILABLE;
  return CYCLE.flatMap((s) => (twin ? [s, { id: `${s.id}+ultra`, query: `${s.query}&${ULTRA_QUERY}=1` }] : [s]));
}

/** The first step of a new loop. */
export function startRun(session: string, ultra: boolean): BenchRun {
  return { session, loop: 1, step: 0, ultra };
}

/** The step a run is at. */
export function stepOf(run: BenchRun): BenchStep {
  const cycle = cycleOf(run.ultra);
  return cycle[run.step % cycle.length]!;
}

/** The run after its current step is done: the next step, the next cycle (taking the Ultra box as it is now) when `keep` is ticked, or null when the loop is over. */
export function advance(run: BenchRun, prefs: Pick<BenchPrefs, "keep" | "ultra">): BenchRun | null {
  if (run.step + 1 < cycleOf(run.ultra).length) return { ...run, step: run.step + 1 };
  return prefs.keep ? { ...run, loop: run.loop + 1, step: 0, ultra: prefs.ultra } : null;
}

/** The address that runs `step` of `run`: this page's path and the bench's query with the loop's session; no fragment, no leftover `v`. */
export function stepHref(href: string, step: BenchStep, run: BenchRun): string {
  const url = new URL(href);
  url.search = `?${step.query}&loop=${run.session}`;
  url.hash = "";
  return url.toString();
}

/** This page is a step of `run` (it asks for a bench and names the run's session), not a bench someone opened by hand. */
export function isStepPage(search: string, run: BenchRun | null): boolean {
  const q = new URLSearchParams(search);
  return run !== null && q.has(BENCH_QUERY) && q.get("loop") === run.session;
}

/** What every submission of a loop carries, so data across builds lines up: the session, the cycle count and the step. */
export function loopSettings(run: BenchRun, step: BenchStep): { session: string; loop: number; step: string } {
  return { session: run.session, loop: run.loop, step: step.id };
}

/** A stored run, or null when the text is not one. */
export function parseRun(text: string | null): BenchRun | null {
  try {
    const raw: unknown = JSON.parse(text ?? "null");
    if (typeof raw !== "object" || raw === null || !("session" in raw) || !("loop" in raw) || !("step" in raw)) return null;
    const { session, loop, step } = raw;
    // A run stored before the cycle carried its Ultra choice (a loop left running across this update) goes on without it.
    const ultra = "ultra" in raw && raw.ultra === true;
    const ok = typeof session === "string" && /^[a-z0-9]{4,24}$/.test(session) && Number.isInteger(loop) && Number.isInteger(step);
    return ok ? { session, loop: Number(loop), step: Number(step), ultra } : null;
  } catch {
    return null;
  }
}

/** One posted bench of a loop: its cycle, its step and the receipt id the server gave. */
export interface BenchReceiptEntry {
  loop: number;
  step: string;
  id: string;
}

/** The loop keeps its newest receipts, so a page reload or a new cycle never loses one the player has not read yet. */
const RECEIPTS_KEPT = 30;

/** The receipts kept so far with `entry` added at the end, the oldest dropped past `RECEIPTS_KEPT`. */
export function withReceipt(kept: readonly BenchReceiptEntry[], entry: BenchReceiptEntry): BenchReceiptEntry[] {
  return [...kept.slice(-(RECEIPTS_KEPT - 1)), entry];
}

/** Stored receipts, or none when the text is not a list of them (an entry that is not one is dropped). */
export function parseReceipts(text: string | null): BenchReceiptEntry[] {
  try {
    const raw: unknown = JSON.parse(text ?? "[]");
    if (!Array.isArray(raw)) return [];
    const out: BenchReceiptEntry[] = [];
    for (const e of raw) {
      if (typeof e !== "object" || e === null || !("loop" in e) || !("step" in e) || !("id" in e)) continue;
      const { loop, step, id } = e;
      if (Number.isInteger(loop) && typeof step === "string" && typeof id === "string") out.push({ loop: Number(loop), step, id });
    }
    return out;
  } catch {
    return [];
  }
}
