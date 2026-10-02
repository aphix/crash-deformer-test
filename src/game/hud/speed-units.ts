/**
 * Speed readouts in the viewer's units: mph when the browser's locale region is the US, km/h
 * everywhere else. Physics stays SI (m/s); only the readout converts.
 */
export type SpeedUnit = "mph" | "km/h";

/** Readout units per m/s (1 mi = 1609.344 m). */
const PER_MS: Readonly<Record<SpeedUnit, number>> = { mph: 3600 / 1609.344, "km/h": 3.6 };

/** mph when the first of `tags` (BCP 47, `navigator.languages` order) that names a region names the US; else km/h. */
export function speedUnitFor(tags: readonly string[]): SpeedUnit {
  for (const tag of tags) {
    const region = new Intl.Locale(tag).region;
    if (region) return region === "US" ? "mph" : "km/h";
  }
  return "km/h";
}

/** `ms` (m/s) as a whole-number readout in `unit`. */
export function formatSpeed(ms: number, unit: SpeedUnit): string {
  return (ms * PER_MS[unit]).toFixed(0);
}
