import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/bench` (and `/bench/`): the Benchmark loop from its first bench. A hand-opened `?bench=strip` page starts a loop with every
 * option on, exactly as the Benchmark entry does (`components/bench-run.ts` `runBenchPage`), so this address only points there.
 */
export const Route = createFileRoute("/bench")({
  beforeLoad: () => {
    throw redirect({ to: "/", search: { bench: "strip" } as never });
  },
});
