import { SPRINGS } from "./car-suspension.ts";
import { VEHICLE_CLASS_IDS } from "./vehicle-classes.ts";

/**
 * Springs for a test whose behaviour is not the springs' (a ramp crossing's plane and shove, a landing's snap, a settled pose against
 * its ground): so stiff and short that the body's sprung offset cannot hide or fake what the test judges. Spring behaviour has its own
 * tests, with the springs as the variable. The class table's own entries are set (`SPRINGS`, the one place the physics reads them) and
 * given back by the returned function; a test file is one process, so no other file sees them.
 */
export const STIFF_HZ = 24;
export const STIFF_TRAVEL = 0.01;
/** The explicit damper's stability limit is ω·dt of about 1.3 at the slowest slice a driven car takes (1/114 s at 8 m/s): 24 Hz is the stiffest ride that holds, and a damping ratio past the classes' own 0.25-0.35 launches a landing. */

export function useStiffSprings(): () => void {
  const saved = VEHICLE_CLASS_IDS.map((cls) => ({ ...SPRINGS[cls] }));
  for (const cls of VEHICLE_CLASS_IDS) {
    SPRINGS[cls].hz = STIFF_HZ;
    SPRINGS[cls].travel = STIFF_TRAVEL;
  }
  return () => {
    for (const [i, cls] of VEHICLE_CLASS_IDS.entries()) Object.assign(SPRINGS[cls], saved[i]);
  };
}
