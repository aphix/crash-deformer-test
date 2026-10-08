import { Button } from "@/components/ui/button";
import { startBenchLoop } from "@/components/bench-run";

/**
 * The scene list's Benchmark entry: it runs the strip, the city and the biggest course in turn, each on its own page load, posting each
 * card with a receipt before the next starts. It keeps benching and reloads onto new builds; the loop's options are the bench pages' addresses.
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

