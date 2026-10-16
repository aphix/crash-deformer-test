import * as THREE from "three";
import { BITMAP_UPRIGHT } from "./constants.ts";
import { once } from "../kernel/scalar.ts";

/** Made at the first picture asked for: three's loader warns on construction where `createImageBitmap` is missing (node). */
const loader = once(() => new THREE.ImageBitmapLoader().setOptions(BITMAP_UPRIGHT));

/** A picture decoded upright and unconverted (`BITMAP_UPRIGHT`), as the sky and Ultra's textures are drawn. */
export function loadUprightBitmap(url: string): Promise<ImageBitmap> {
  return loader().loadAsync(url);
}
