import type { RacePhase } from "../match/types.ts";

/** What the lead's card shows (in place of a race clock second) while the grid waits. */
const GRID_SECOND = -Infinity;

/** What the grid and the warm-up read: the race's phase and clock, the Lab's sim clock, and how long the plan warms (`lab`: set for the Lab bench, which warms on its own sim clock). */
interface WarmRun {
  race: { readonly phase: RacePhase | null; readonly time: number };
  simS(): number;
  plan: { readonly lab: unknown; readonly warmS: number };
  ui: { set(text: string): void };
}

/**
 * The grid and the warm-up: frames (`nextFrame` runs one) with no samples until `plan.warmS` has run, of race clock from the green or of
 * the Lab's sim. A race that is already over ends it too: its clock has stopped for good, and the bench's own run (the window, the A/Bs, the card,
 * the loop's next step) goes on whatever state the race is in.
 */
export async function warmUp(nextFrame: () => Promise<void>, run: WarmRun): Promise<void> {
  const { race, plan, ui } = run;
  let shownSecond = NaN;
  for (;;) {
    await nextFrame();
    if (race.phase === "finished") return;
    const going = plan.lab !== null || race.phase === "racing";
    const clock = plan.lab ? run.simS() : race.time;
    if (going && clock >= plan.warmS) return;
    const second = going ? Math.round(clock) : GRID_SECOND;
    if (second === shownSecond) continue;
    shownSecond = second;
    ui.set(`CRUSH BENCH: ${going ? `warming ${second} / ${plan.warmS} s` : "grid"}`);
  }
}
