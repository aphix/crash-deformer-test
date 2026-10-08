/** Names the benches' page and the pages that start them share. */

/** The page query that asks for a bench (`?bench=city`): `benchPlan` reads it, the loop and the lab page look for it. */
export const BENCH_QUERY = "bench";
/** The values of `?bench=`: the benches a page can run. */
export const BENCH_KIND = { city: "city", lab: "lab", strip: "strip" } as const;
/** The page query that adds a bench's Ultra arm (`?ultra=1`). */
export const ULTRA_QUERY = "ultra";
