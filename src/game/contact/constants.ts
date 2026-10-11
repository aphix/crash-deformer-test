import { MU_BODY } from "../vehicle/car-air.ts";

/**
 * The contact every fixed solid gives a car (docs/UNIFIED_CONTACT.md, stage 4): the rebound of a light touch, and the Coulomb friction
 * of the body's skin on the face, the `ct` row `bodyContact` is called with for a wall, a prop, a ramp's flank and a rig's plate alike.
 */
export const SOLID_E = 0.15;
export const SOLID_MU = MU_BODY;
/** The Coulomb friction of one car's sheet metal on another's: the `ct` row's friction of a car-car contact (`deform-contact`'s `SHEET_MU` before the pair went through the kernel). */
export const PAIR_MU = 0.45;
/** The closing speed (m/s) above which two bodies' touch is a hit that arms the crush (below it the touch is a brush the response alone handles). */
export const ARM_CLOSING = 0.2;
