import assert from "node:assert/strict";
import type * as THREE from "three";

/** The texel bytes of a texture built in memory (red, green, blue, alpha per texel); fails the test if it carries none. */
export function pixelsOf(texture: THREE.DataTexture) {
  const { data } = texture.image;
  assert.ok(data, "texture carries pixel data");
  return data;
}
