import type * as THREE from "three";
import type { WorldStage } from "../engine-world.ts";
import type { Ultra } from "./ultra.ts";

/** What Ultra reads from the engine. */
export type UltraHost = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  stage: Pick<WorldStage, "sun" | "envGain" | "envIntensity">;
  /** Compile what the scene draws (the engine's `queueWarm`): Ultra asks for it after it changes lighting or materials. */
  queueWarm(): void;
  /** False once the engine is disposed. */
  alive(): boolean;
};

/**
 * Fetch the Ultra code (its own chunk: nothing else imports it) and its assets, about 3.5 MB. Null, logged, when either fails.
 * This file is the only one the engine imports as a value (`Ultra` above is a type, erased from the build).
 */
export async function loadUltra(host: UltraHost): Promise<Ultra | null> {
  try {
    // Dynamic on purpose: Ultra is its own chunk, fetched only when it is picked; a static import would put it in the main chunk.
    const { Ultra: UltraClass } = await import("./ultra.ts");
    return await UltraClass.create(host);
  } catch (err) {
    console.error("Crush Stream Ultra failed to load", err);
    return null;
  }
}
