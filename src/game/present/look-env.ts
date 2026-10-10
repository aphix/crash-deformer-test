import * as THREE from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

/** The studio environment every FX tier lights the cars with (`scripts/bake-env.mjs` bakes it from three's RoomEnvironment). */
export const STUDIO_ENV_URL = `${import.meta.env?.BASE_URL ?? "/"}env-studio.hdr`;

/**
 * One Radiance RGBE equirect (linear radiance, so highlights above 1 survive) downloaded, decoded to half float and
 * prefiltered to a PMREM texture for `scene.environment`. The caller owns the result and disposes it. Null when the
 * download fails or `stillWanted()` says so after it (the renderer was disposed meanwhile).
 */
export async function loadHdrEnv(renderer: THREE.WebGLRenderer, url: string = STUDIO_ENV_URL, stillWanted: () => boolean = () => true): Promise<THREE.Texture | null> {
  const equirect = await new HDRLoader().loadAsync(url).catch(() => null);
  if (!equirect) return null;
  if (!stillWanted()) {
    equirect.dispose();
    return null;
  }
  equirect.mapping = THREE.EquirectangularReflectionMapping;
  const gen = new THREE.PMREMGenerator(renderer);
  const env = gen.fromEquirectangular(equirect).texture;
  equirect.dispose();
  gen.dispose();
  return env;
}
