/** Names several present files and their consumers share. */

/** The FX tier id of the Ultra look (`FxTier` in engine-post.ts lists every tier). */
export const FX_TIER_ULTRA = "ultra";
/** The director's standard lens (deg): the chase shot's, and the widest the reel's context shot opens to. */
export const SHOT_FOV = 55;
/** Slow windows in a row that step the FX tier or the detail rung down: one hitch, however long, ends only one window, so it never steps. */
export const SLOW_WINDOWS = 2;
/** The name of a lamp's night light pool decal (`Object3D.name`): `makeLamp` names it, the prefab builder shares it with the scene and `syncPools` hides it with a knocked pole. */
export const LAMP_POOL = "pool";
/** A frame whose sim time (s) is no more than this advanced nothing: no hit to read, no mark to stamp. */
export const MIN_SIM_DT = 1e-5;

/** `ImageBitmapLoader` options for a picture drawn as authored: upright for GL (three's `flipY` is off for a bitmap), no premultiplying, no colour conversion. */
export const BITMAP_UPRIGHT = { imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" } as const;
