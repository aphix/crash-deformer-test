/** The two lids' part names (`DetachPart.name`): what the breakage, the skinning and a player's colour picks call them. */
export const LID = { hood: "hood", trunk: "trunk" } as const;
/** The names a car's meshes carry in the scene graph (`Object3D.name`) and its parts carry in `DetachPart.name`: found by name from the cage, the ragdoll, the suspension and the class lift. */
export const LIGHT_BAR = "lightBar";
export const CLASS_LIFT = "classLift";
export const BUMPER_F = "bumperF";
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
