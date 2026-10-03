import havana from "./havana.json" with { type: "json" };

/**
 * The Survival course (Havana's Plaza de la Revolución). Raw JSON like the `TRACKS` entries: `new Track(HAVANA)` validates and
 * compiles it. It is not in `TRACKS`: the race menu, the campaign and the per-course test sweeps do not list it.
 */
export const HAVANA: unknown = havana;
