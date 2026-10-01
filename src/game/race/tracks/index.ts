import oval from "./oval.json" with { type: "json" };

/** Every course, in menu order. Raw JSON: `new Track(json)` validates and compiles it. */
export const TRACKS: readonly unknown[] = [oval];

/** Campaign playlist (track ids, raced in order). */
export const CAMPAIGN: readonly string[] = ["oval"];
