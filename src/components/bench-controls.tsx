import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PREF_KEYS, readReceipts, readRun, startBenchLoop, stopBenchLoop } from "@/components/bench-run";
import { useStoredString } from "@/components/use-stored-string";
import { cycleOf, isStepPage, ULTRA_AVAILABLE, type BenchReceiptEntry, type BenchRun } from "@/game/engine/bench-loop";

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
 * The scene list's Benchmark entry: it runs the strip, the city and the biggest course in turn, each on its own page load, posting each
 * card with a receipt before the next starts. The loop's options live on its bench pages (`BenchLoopBar`), not in the menu.
 */
export function BenchEntry() {
  return (
    <Button
      variant="ghost"
      className="idle:hidden h-10 px-1 text-xs font-normal text-muted sm:h-7 sm:px-2.5"
      aria-label="Benchmark: run the benches in turn and submit each result"
      title="Run the strip, city and biggest-course benches one after another and send each result to the developer"
      onClick={startBenchLoop}
    >
      Benchmark
    </Button>
  );
}

/**
 * On a loop's bench page: where the loop is, its options, the receipts its earlier benches got (newest first, kept across the
 * reloads) and a way out. Keep benching runs the cycle again; auto-reload takes the loop onto a newly deployed build between
 * benches (both read when this bench ends); include Ultra adds each bench's Ultra pass from the next cycle on (offered only where
 * the build has Ultra).
 */
export function BenchLoopBar() {
  const [loop, setLoop] = useState<{ run: BenchRun; steps: number; receipts: BenchReceiptEntry[] } | null>(null);
  // After mount: the server renders no bar, and hydration must find the same.
  useEffect(() => {
    const run = readRun();
    if (run !== null && isStepPage(window.location.search, run)) setLoop({ run, steps: cycleOf(run.ultra).length, receipts: readReceipts().reverse() });
  }, []);
  if (loop === null) return null;
  return (
    <div className="pointer-events-auto fixed bottom-2 left-2 z-[60] flex max-w-[calc(100vw-1rem)] flex-col gap-1 rounded-lg bg-surface px-2 py-1 text-[11px] text-muted shadow-[var(--shadow-border)]">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          Benchmark loop {loop.run.loop} · step {(loop.run.step % loop.steps) + 1}/{loop.steps}
        </span>
        <Tick storageKey={PREF_KEYS.keep} label="keep benching" title="Run the cycle again when it ends" />
        <Tick storageKey={PREF_KEYS.auto} label="auto-reload" title="Reload onto a newly deployed build between benches, and carry on" />
        {ULTRA_AVAILABLE ? <Tick storageKey={PREF_KEYS.ultra} label="include Ultra" title="From the next cycle on, run each bench's Ultra pass after it" /> : null}
        <Button variant="secondary" className="h-7 px-2 text-[11px]" onClick={stopBenchLoop}>
          Stop
        </Button>
      </div>
      {loop.receipts.length > 0 ? (
        <ol className="max-h-24 select-text overflow-y-auto" aria-label="Receipts of this loop's benches, newest first">
          {loop.receipts.map((r) => (
            <li key={r.id}>
              {r.id} · loop {r.loop} {r.step}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
