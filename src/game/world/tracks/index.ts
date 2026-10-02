import city from "./city.json" with { type: "json" };
import oval from "./oval.json" with { type: "json" };
import rally from "./rally.json" with { type: "json" };
import stunt from "./stunt.json" with { type: "json" };

/** Every course, in menu order. Raw JSON: `new Track(json)` validates and compiles it. */
export const TRACKS: readonly unknown[] = [oval, rally, city, stunt];

/** Campaign playlist (track ids, raced in order). */
export const CAMPAIGN: readonly string[] = ["oval", "rally", "city", "stunt"];
