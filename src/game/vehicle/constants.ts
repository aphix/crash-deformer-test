/** The two lids' part names (`DetachPart.name`): what the breakage, the skinning and a player's colour picks call them. */
export const LID = { hood: "hood", trunk: "trunk" } as const;
/** The names a car's meshes carry in the scene graph (`Object3D.name`) and its parts carry in `DetachPart.name`: found by name from the cage, the ragdoll, the suspension and the class lift. */
export const LIGHT_BAR = "lightBar";
export const CLASS_LIFT = "classLift";
export const CLASS_HUBS = "classHubs";
export const INTERIOR_MESH = "interior";
/** The body geometry's per-vertex paint attribute: 0 paint, 1 primer (a torn panel's vertices). */
export const PRIMER_ATTRIBUTE = "primer";
export const BUMPER_F = "bumperF";
/** The name of a car's head or tail lamp seat (`Object3D.name`): `addLamps` names it, the distance cut finds it. */
export const LAMP_SEAT = "lampSeat";
/** The paint of a throwaway car (warm-up, a layout read): mid grey body, dark grey accent. */
export const STOCK_PAINT = { body: 0x808080, accent: 0x404040 };

/**
 * A side hit whose average deceleration (the crush stroke's `ebs² / (2 · stroke)`) reaches this many g trips the crash sensor and the
 * fuel pump's inertia switch (docs/UNIFIED_CONTACT.md, T-bone fuel cut-off; `.extraResearch/perplexity/2026-10-07-fuel-cutoff-threshold.md`:
 * the mechanical switch trips at 10–12 g on a short pulse, an airbag at 13–23 km/h of delta-v), and how much of the hit's lateral part
 * (`|local x|` of the inward direction) makes it a side hit.
 */
export const FUEL_CUTOFF_G = 10;
export const SIDE_HIT_X = 0.7;
/** How long (s) the engine stays cut before it restarts (the switch is resettable; design pillar 2: a car that dies at once is lame). A short pick, no source: the stall is felt, not the end of the run. */
export const STALL_S = 3;
/** A car whose body's up·world-up (`upY`) is below this is on its roof or side; and the facing (the contact normal against the body's up) at which a tyre's drive fades to nothing (`standingBite`). */
export const FLIPPED_UP_Y = 0.35;
/** The facing (cos 65°) from which a tyre's drive is whole (`standingBite`). A pick, no source: a narrow band above the flip line (a car tipping over crosses it in a few frames). A tyre on a car's hood reads facings of 0.63 and over, and the corkscrew's floor, the steepest the game has, 0.955. */
export const BITE_FULL_FACING = 0.42;
/** The share of its lateral grip (grip / v, rad/s) the tyres hold a car's yaw rate to while it grips (`applyDrive`). */
export const GRIP_YAW_CAP = 1.05;
/** No slide starts below this forward speed (m/s): `applyDrive`'s slide and the input layer's brake-tap drift request. */
export const SLIDE_SPEED = 6;
