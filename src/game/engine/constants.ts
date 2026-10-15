import { BENCH_STRIP_ID, TRACK_ID } from "../world/constants.ts";

/** Names and quantities several engine files share: the benches' page and the pages that start them, the spark threshold. */

/** The page query that asks for a bench (`?bench=city`): `benchPlan` reads it, the loop and the lab page look for it. The strip course's id is the same word, so a run's result id and the query read alike. */
export const BENCH_QUERY = BENCH_STRIP_ID;
/** The values of `?bench=`: the benches a page can run. The city bench races the campaign's `city` course. */
export const BENCH_KIND = { city: TRACK_ID.city, lab: "lab", strip: "strip" } as const;
/** The page query that adds a bench's Ultra arm (`?ultra=1`). */
export const ULTRA_QUERY = "ultra";
/** The page query that picks the city bench's course (`?course=dam-spine`). */
export const COURSE_QUERY = "course";
/** The page queries that shape the strip bench (`benchPlan`): a loop carries them onto every step. */
export const STRIP_QUERY = { cars: "cars", same: "same", len: "len", props: "props", traffic: "traffic" } as const;
/** The settings the bench reads off the HUD and the HUD's reset command names (`night`, `wet`, `sky`, `realism`, `fx`), the HUD's `celLook`, and the page query `?fx=` that pins the tier: one spelling for all. */
export const SETTING_KEY = { night: "night", wet: "wet", sky: "sky", realism: "realism", fx: "fx", celLook: "celLook" } as const;
/** A hit whose impulse is no more than this throws no sparks: a brush, not a crash. */
export const SPARK_MIN_IMPULSE = 1.2;
