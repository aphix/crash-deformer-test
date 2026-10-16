/** Quantities several deform files share. */

/** A wreck whose spin inertia about its centroid (Σ m·r², kg·m²) is below this has no turn to hold or resist. */
export const MIN_INERTIA = 1e-9;
/** A mass whose impact weight (crumple face × corner) is below this is outside the hit. */
export const MIN_IMPACT_ZONE = 0.04;
/** A sum of weights below this weights nothing: the weighted mean falls back. */
export const MIN_WEIGHT_SUM = 1e-6;
/** A sum of masses (kg) below this is no body to average a momentum over. */
export const MIN_MASS_SUM = 1e-8;
/** Two bodies' inverse masses (1/kg) summed below this: neither can take a share of a correction. */
export const MIN_INV_MASS = 1e-8;
/** A sliding speed (m/s) below this is no slide: friction has no direction to oppose. */
export const MIN_SLIDE = 1e-6;
/** A point whose rest position projects on the hit's inward direction beyond this (m) lies on the far side of a one-ended hit. */
export const FAR_SIDE_DOT = 0.18;
/** The crush reach (m) a hit's stroke gains per unit of the squash setting (on top of its 0.5 m base). */
export const SQUASH_REACH = 1.15;
/** Physics slice (s) the per-call contact shares (feedOverlap nibble and inbound-speed kill) were tuned at: a calibration reference, kept when the sim's own fine floor moves. */
export const CONTACT_REF_SLICE = 1 / 240;
/** The squash and buckle settings a fresh rig starts at, and the HUD starts its sliders at. */
export const DEFAULT_SQUASH = 0.32;
export const DEFAULT_BUCKLE = 0.45;
/** The contact window (s): how long after its last contact a crashed car's shape matching and mass step stay live (`DeformSolve.live`), and the time over which its tyres' grip comes back after a hit (`DeformSolve.settledShare`). */
export const CONTACT_WINDOW = 0.35;
