/**
 * The benchmark loop's browser side (rules: `game/engine/bench-loop.ts`): the choices and the run kept in local storage so they
 * outlive every page load, the bench page itself (`?bench=…`, fetched only when asked for), and the move from one step to the next.
 */
import type { CrashEngine } from "@/game/engine/engine";
import type { runBench } from "@/game/engine/engine-bench";
import { advance, isStepPage, loopSettings, parseRun, startRun, stepHref, stepOf, type BenchPrefs, type BenchRun } from "@/game/engine/bench-loop";
import { BENCH_QUERY } from "@/game/engine/constants";
import { fetchDeployedSha, newerBuild, reloadTarget } from "@/lib/deploy/update-check";
import { KIND } from "@/lib/submissions/kinds";
import { sendSubmission } from "@/lib/submissions/status";

const RUN_KEY = "crush.bench.run";
/** The three tick boxes' storage keys (`useStoredString`: "1" ticked, "0" not). */
export const PREF_KEYS = { keep: "crush.bench.keep", auto: "crush.bench.auto", ultra: "crush.bench.ultra" } as const;

/** A bench's card and receipt stay on screen this long before the next bench's page loads. */
const PAUSE_MS = 4_000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage is closed: the loop cannot continue across pages, and says nothing here (the page just does not move on).
  }
}

export function readPrefs(): BenchPrefs {
  return { keep: read(PREF_KEYS.keep) === "1", auto: read(PREF_KEYS.auto) === "1", ultra: read(PREF_KEYS.ultra) === "1" };
}

export function readRun(): BenchRun | null {
  return parseRun(read(RUN_KEY));
}

/** The Benchmark entry: a new loop from its first step. */
export function startBenchLoop(): void {
  const run = startRun(crypto.randomUUID().replaceAll("-", "").slice(0, 8));
  write(RUN_KEY, JSON.stringify(run));
  location.assign(stepHref(location.href, stepOf(run, readPrefs()), run));
}

/** Stop the loop and leave the bench page for the plain game. */
export function stopBenchLoop(): void {
  write(RUN_KEY, null);
  location.assign(location.pathname);
}

/**
 * This bench's step is done and posted: on to the next after a short pause (the receipt shows), or to the end. With auto-reload ticked
 * and a newer build deployed, the next page is a reload onto it (`?v=`, held back by the backoff if earlier reloads did not land).
 */
async function finishStep(run: BenchRun, prefs: BenchPrefs): Promise<void> {
  const next = advance(run, prefs);
  write(RUN_KEY, next === null ? null : JSON.stringify(next));
  if (next === null) return;
  const href = stepHref(location.href, stepOf(next, prefs), next);
  const deployed = prefs.auto ? newerBuild(__BUILD_SHA__, await fetchDeployedSha()) : null;
  const to = (deployed !== null ? reloadTarget(href, deployed) : null) ?? href;
  await new Promise<void>((resolve) => window.setTimeout(resolve, PAUSE_MS));
  location.assign(to);
}

/**
 * A `?bench=` page: run the bench and post its card (the card has a Submit button too). When the page is a step of the stored loop
 * (it names the run's session), its post carries the loop's session, cycle count and step, and the loop moves on afterwards.
 */
export async function runBenchPage(engine: CrashEngine, hud: () => object): Promise<void> {
  const prefs = readPrefs();
  const stored = readRun();
  const run = isStepPage(location.search, stored) ? stored : null;
  // Dynamic on purpose: the bench's code is its own chunk, fetched only by a page that asks for a bench (as before the loop).
  const bench: { runBench: typeof runBench } = await import("@/game/engine/engine-bench");
  const result = await bench.runBench(engine, hud, location.search, {
    auto: run !== null,
    submit: (payload) =>
      sendSubmission(KIND.bench, async () => {
        const { scene, settings } = engine.submitContext();
        const loop = run === null ? {} : loopSettings(run, stepOf(run, prefs));
        return { context: { scene, settings: { ...settings, bench: new URLSearchParams(location.search).get(BENCH_QUERY), ...loop } }, payload };
      }),
  });
  if (run === null) return;
  // A page that asks for no bench the game knows is a broken loop: stop it rather than cycle on it forever.
  if (result === null) write(RUN_KEY, null);
  else await finishStep(run, readPrefs());
}
