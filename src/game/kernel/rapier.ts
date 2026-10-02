import type RAPIER from "@dimforge/rapier3d";
import { once } from "./scalar.ts";

/** The Rapier namespace (`@dimforge/rapier3d`, Apache-2.0). */
export type Rapier = typeof RAPIER;

/**
 * The game's one Rapier (0.19.3: flat step allocation, RapierEval), loaded once on first call; every caller shares
 * the promise. Its own chunk (173 kB, 29 kB gz) plus the separate `.wasm` (1.57 MB, 0.59 MB gz) that the browser
 * compiles as it streams in: 618 kB over the wire and no frame over 33 ms at 4× CPU, where the base64-inlined
 * compat build is 832 kB and stalls one frame 183–217 ms. The engine starts it after boot. Use this, never a
 * second import path or version.
 */
export const loadRapier = once(async (): Promise<Rapier> => {
  // Dynamic on purpose: a static import would put Rapier in the boot bundle.
  return (await import("@dimforge/rapier3d")).default;
});
