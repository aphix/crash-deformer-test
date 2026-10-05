import breakerYard from "./breaker-yard.json" with { type: "json" };
import city from "./city.json" with { type: "json" };
import damSpine from "./dam-spine.json" with { type: "json" };
import fourCount from "./four-count.json" with { type: "json" };
import oval from "./oval.json" with { type: "json" };
import rally from "./rally.json" with { type: "json" };
import razorShelf from "./razor-shelf.json" with { type: "json" };
import stunt from "./stunt.json" with { type: "json" };
import { HAVANA } from "./havana.ts";

/** Every course, in menu order. Raw JSON: `new Track(json)` validates and compiles it. */
export const TRACKS: readonly unknown[] = [oval, rally, city, stunt, fourCount, damSpine, razorShelf, breakerYard];

/** Courses the race menu, the campaign and the per-course test sweeps do not list: loadable by id (`RaceField.load`) for the mode that plays them. */
export const OFF_MENU: readonly unknown[] = [HAVANA];

/** Campaign playlist (track ids, raced in order). */
export const CAMPAIGN: readonly string[] = ["oval", "rally", "city", "stunt"];
