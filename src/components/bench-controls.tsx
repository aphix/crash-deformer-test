import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PREF_KEYS, readPrefs, readRun, startBenchLoop, stopBenchLoop } from "@/components/bench-run";
import { useStoredString } from "@/components/use-stored-string";
import { cycleOf, isStepPage, ULTRA_AVAILABLE, type BenchRun } from "@/game/engine/bench-loop";

/** One tick box of the loop, kept across reloads (`useStoredString`). */
function Tick({ storageKey, label, title }: { storageKey: string; label: string; title: string }) {
  const [value, set] = useStoredString(storageKey, "0", "0");
  return (
    <label className="idle:hidden flex h-10 cursor-pointer items-center justify-center gap-1 rounded-md px-1 text-[11px] leading-tight text-muted sm:h-7 sm:px-2" title={title}>
      <input type="checkbox" className="size-3.5 shrink-0 accent-[var(--color-accent)]" checked={value === "1"} onChange={(e) => set(e.target.checked ? "1" : "0")} />
      {label}
    </label>
  );
}

/**
 * The scene list's Benchmark entry and its three tick boxes. Pressing Benchmark runs the strip, the city and the biggest course in turn, each
 * on its own page load, posting each card with a receipt before the next starts. Keep benching runs the cycle again; auto-reload takes
 * the loop onto a newly deployed build between benches; include Ultra adds each bench's Ultra pass (offered only where the build has Ultra).
 * On a phone the dock has no room for the boxes (a fourth grid row pushes the panel above over the rig buttons): there keep benching and
 * auto-reload are ticked on the loop's own bar, and Ultra stays off.
 */
export function BenchEntry() {
  return (
    <>
      <Button
        variant="ghost"
        className="idle:hidden h-10 px-1 text-xs font-normal text-muted sm:h-7 sm:px-2.5"
        aria-label="Benchmark: run the benches in turn and submit each result"
        title="Run the strip, city and biggest-course benches one after another and send each result to the developer"
        onClick={startBenchLoop}
      >
        Benchmark
      </Button>
      <span className="hidden sm:contents">
        <Tick storageKey={PREF_KEYS.keep} label="keep benching" title="Run the cycle again when it ends" />
        <Tick storageKey={PREF_KEYS.auto} label="auto-reload" title="Reload onto a newly deployed build between benches, and carry on" />
        {ULTRA_AVAILABLE ? <Tick storageKey={PREF_KEYS.ultra} label="include Ultra" title="Run each bench's Ultra pass after it" /> : null}
      </span>
    </>
  );
}

/** On a loop's bench page: where the loop is, the keep/auto-reload boxes (read when this bench ends), and a way out. */
export function BenchLoopBar() {
  const [loop, setLoop] = useState<{ run: BenchRun; steps: number } | null>(null);
  // After mount: the server renders no bar, and hydration must find the same.
  useEffect(() => {
    const run = readRun();
    if (run !== null && isStepPage(window.location.search, run)) setLoop({ run, steps: cycleOf(readPrefs()).length });
  }, []);
  if (loop === null) return null;
  return (
    <div className="pointer-events-auto fixed bottom-2 left-2 z-[60] flex items-center gap-2 rounded-lg bg-surface px-2 py-1 text-[11px] text-muted shadow-[var(--shadow-border)]">
      <span>
        Benchmark loop {loop.run.loop} · step {(loop.run.step % loop.steps) + 1}/{loop.steps}
      </span>
      <Tick storageKey={PREF_KEYS.keep} label="keep benching" title="Run the cycle again when it ends" />
      <Tick storageKey={PREF_KEYS.auto} label="auto-reload" title="Reload onto a newly deployed build between benches, and carry on" />
      <Button variant="secondary" className="h-7 px-2 text-[11px]" onClick={stopBenchLoop}>
        Stop
      </Button>
    </div>
  );
}
