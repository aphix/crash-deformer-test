/**
 * The benchmark loop's browser side (rules: `game/engine/bench-loop.ts`): the bench page itself (`?bench=…`, fetched only when asked
 * for) and the move from one step to the next. The loop's state lives in the page's address, nothing is stored.
 */
import type { CrashEngine } from "@/game/engine/engine";
import type { runBench } from "@/game/engine/engine-bench";
import { advance, loopProgress, loopSettings, newSession, parseRun, runFromPage, startRun, stepHref, stepOf, type BenchRun } from "@/game/engine/bench-loop";
import { BENCH_QUERY } from "@/game/engine/constants";
import { fetchDeployedSha, newerBuild, reloadTarget } from "@/lib/deploy/update-check";
import { KIND } from "@/lib/submissions/kinds";
import { sendSubmission } from "@/lib/submissions/status";

/** A bench's card and receipt stay on screen this long before the next bench's page loads. */
const PAUSE_MS = 4_000;

/** The Benchmark entry: a new loop from its first step. */
export function startBenchLoop(): void {
  location.assign(stepHref(location.href, startRun(newSession())));
}

/**
 * This bench's step is done and posted: on to the next after a short pause (the receipt shows), or to the end. With `auto` set
 * and a newer build deployed, the next page is a reload onto it (`?v=`, held back by the backoff if earlier reloads did not land).
 */
async function finishStep(run: BenchRun): Promise<void> {
  const next = advance(run);
  if (next === null) return;
  const href = stepHref(location.href, next);
  const deployed = run.auto ? newerBuild(__BUILD_SHA__, await fetchDeployedSha()) : null;
  const to = (deployed !== null ? reloadTarget(href, deployed) : null) ?? href;
  await new Promise<void>((resolve) => window.setTimeout(resolve, PAUSE_MS));
  location.assign(to);
}

/**
 * A `?bench=` page: run the bench, post its card, and move the loop on. A page opened by its address alone is a loop from there with
 * every option on (`runFromPage`), exactly as the Benchmark entry starts one, and its address is rewritten to say so; a bench the
 * cycle doesn't run (the lab, another course) runs once and posts.
 */
export async function runBenchPage(engine: CrashEngine, hud: () => object): Promise<void> {
  const search = location.search;
  const run = parseRun(search) ?? runFromPage(search, newSession());
  if (run !== null) history.replaceState(history.state, "", stepHref(location.href, run));
  // Dynamic on purpose: the bench's code is its own chunk, fetched only by a page that asks for a bench (as before the loop).
  const bench: { runBench: typeof runBench } = await import("@/game/engine/engine-bench");
  const result = await bench.runBench(engine, hud, search, {
    auto: true,
    loopProgress: run === null ? null : loopProgress(run),
    submit: (payload) =>
      sendSubmission(KIND.bench, async () => {
        const { scene, settings } = engine.submitContext();
        const loop = run === null ? {} : loopSettings(run, stepOf(run));
        return { context: { scene, settings: { ...settings, bench: new URLSearchParams(search).get(BENCH_QUERY), ...loop } }, payload };
      }),
  });
  // A page that asks for no bench the game knows is a broken loop: it ends there rather than cycle on forever.
  if (run !== null && result !== null) await finishStep(run);
}
