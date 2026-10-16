import * as THREE from "three";
import { BITMAP_UPRIGHT } from "./constants.ts";

/** Made at the first picture asked for: three's loader warns on construction where `createImageBitmap` is missing (node). */
let loader: THREE.ImageBitmapLoader | null = null;

/** A picture decoded upright and unconverted (`BITMAP_UPRIGHT`), as the sky and Ultra's textures are drawn. */
export function loadUprightBitmap(url: string): Promise<ImageBitmap> {
  loader ??= new THREE.ImageBitmapLoader().setOptions(BITMAP_UPRIGHT);
  return loader.loadAsync(url);
}
