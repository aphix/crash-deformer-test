/**
 * Whether the player's car pick `car` is applied to slot 0 now (`CrashEngine.setDriver`). The stored pick reaches the
 * engine once after boot, AFTER the page's `#` was applied, so at that first call a `#` that named a car (`linkNamedCar`)
 * wins. After that a pick the player changed applies; an unchanged one (a name edit) never re-applies, so it cannot undo a car
 * picked in the HUD since. `prev` is the last pick seen, null before the first.
 */
export function driverCarApplies(prev: string | null, car: string, linkNamedCar: boolean): boolean {
  return car !== prev && !(prev === null && linkNamedCar);
}
