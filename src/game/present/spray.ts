import * as THREE from "three";
import { SPRAY_FACE, SPRAY_PALETTE, sprayFace, type SprayLayout } from "../match/look-data.ts";

/**
 * Spray paint drawn: a bitmap's texels as the premultiplied texture the paint shader samples (`SprayBitmap`), the can's
 * stamp, and the shader patch that lays the paint over a material (`applySpray`), with the face mapping of `sprayFace`
 * (`match/look-data.ts`) in GLSL.
 */

const _uv = new Float64Array(2);

/** One bitmap: a palette index per texel, and the premultiplied RGBA texture the shader samples (linear filtered: soft edges). */
export class SprayBitmap {
  readonly layout: SprayLayout;
  readonly texels: Uint8Array;
  readonly rgba: Uint8Array;
  readonly texture: THREE.DataTexture;

  constructor(layout: SprayLayout) {
    this.layout = layout;
    this.texels = new Uint8Array(layout.w * layout.h);
    this.rgba = new Uint8Array(layout.w * layout.h * 4);
    this.texture = new THREE.DataTexture(this.rgba, layout.w, layout.h);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  /** Whether any texel is painted. */
  painted(): boolean {
    for (let i = 0; i < this.texels.length; i++) if (this.texels[i] !== 0) return true;
    return false;
  }

  /**
   * A puff of the can at rest point `p` with normal `n`: texels within `radius` m of it on its face take palette colour
   * `colour`, each with a chance falling from 1 at the middle to 0 at the edge (`rand`), so the dot is dense in the middle and
   * speckled at its rim. False when the point's face takes no paint.
   */
  spray(p: THREE.Vector3, n: THREE.Vector3, radius: number, colour: number, rand: () => number): boolean {
    const face = sprayFace(this.layout, p.x, p.y, p.z, n.x, n.y, n.z, _uv);
    if (face < 0) return false;
    const [fx, fy, fw, fh] = this.layout.faces[face]!;
    const { min, max } = this.layout;
    // The face's axes in metres: u runs along z on the sides and the top, x on the ends; v along y, x on the top.
    const spanU = face === SPRAY_FACE.front || face === SPRAY_FACE.back ? max[0] - min[0] : max[2] - min[2];
    const spanV = face === SPRAY_FACE.top ? max[0] - min[0] : max[1] - min[1];
    const cu = fx + _uv[0]! * fw;
    const cv = fy + _uv[1]! * fh;
    const ru = (radius * fw) / spanU;
    const rv = (radius * fh) / spanV;
    for (let y = Math.max(fy, Math.floor(cv - rv)); y < Math.min(fy + fh, Math.ceil(cv + rv)); y++) {
      for (let x = Math.max(fx, Math.floor(cu - ru)); x < Math.min(fx + fw, Math.ceil(cu + ru)); x++) {
        const du = (x + 0.5 - cu) / ru;
        const dv = (y + 0.5 - cv) / rv;
        const d = Math.sqrt(du * du + dv * dv);
        if (d < 1 && rand() < 1 - d) this.set(y * this.layout.w + x, colour);
      }
    }
    this.texture.needsUpdate = true;
    return true;
  }

  /** Every texel from `texels` (a bitmap of this layout), or bare when null. */
  load(texels: Uint8Array | null): void {
    for (let i = 0; i < this.texels.length; i++) this.set(i, texels ? texels[i]! : 0);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.texture.dispose();
  }

  /** Texel `i` takes palette colour `colour`; bare (0) is all zeros, so its premultiplied RGB stays black. */
  private set(i: number, colour: number): void {
    this.texels[i] = colour;
    const hex = SPRAY_PALETTE[colour]!;
    this.rgba[i * 4] = hex >> 16;
    this.rgba[i * 4 + 1] = (hex >> 8) & 0xff;
    this.rgba[i * 4 + 2] = hex & 0xff;
    this.rgba[i * 4 + 3] = colour === 0 ? 0 : 255;
  }
}

/** The shader's spray uniforms for a bitmap of `layout` sampled from `map`, `rows` bitmaps stacked up it (one per dummy slot). */
export function sprayUniforms(layout: SprayLayout, map: THREE.Texture, rows: number): Record<string, THREE.IUniform> {
  return {
    sprayMap: { value: map },
    sprayMin: { value: new THREE.Vector3(...layout.min) },
    spraySpan: { value: new THREE.Vector3(layout.max[0] - layout.min[0], layout.max[1] - layout.min[1], layout.max[2] - layout.min[2]) },
    sprayFaces: { value: layout.faces.map(([x, y, w, h]) => new THREE.Vector4(x / layout.w, y / layout.h, w / layout.w, h / layout.h)) },
    sprayRows: { value: rows },
  };
}

/** `sprayFace` on the GPU: the premultiplied spray over this fragment (none off the box's painted faces, or with no rest normal). */
const SPRAY_FRAGMENT = /* glsl */ `
uniform sampler2D sprayMap;
uniform vec3 sprayMin;
uniform vec3 spraySpan;
uniform vec4 sprayFaces[5];
uniform float sprayRows;
varying vec3 vSprayP;
varying vec3 vSprayN;
varying float vSprayRow;
vec4 sprayTexel() {
  vec3 n = vSprayN;
  vec3 a = abs(n);
  if (a.x + a.y + a.z < 0.5) return vec4(0.0);
  vec3 t = clamp((vSprayP - sprayMin) / spraySpan, 0.0, 1.0);
  vec4 f;
  vec2 uv;
  if (a.x >= a.y && a.x >= a.z) { f = n.x < 0.0 ? sprayFaces[0] : sprayFaces[1]; uv = t.zy; }
  else if (a.y >= a.z) { if (n.y < 0.0) return vec4(0.0); f = sprayFaces[2]; uv = t.zx; }
  else { f = n.z > 0.0 ? sprayFaces[3] : sprayFaces[4]; uv = t.xy; }
  vec2 st = f.xy + uv * f.zw;
  return texture2D(sprayMap, vec2(st.x, (vSprayRow + st.y) / sprayRows));
}`;

/**
 * Patch `material` to lay its spray over the paint. `vertex` sets `vSprayP` / `vSprayN` (the rest point and normal) and
 * `vSprayRow` (which stacked bitmap) from attributes it declares in `attributes`. Chains any earlier compile hook, like
 * `applyMarkMap`.
 */
export function applySpray(material: THREE.Material, uniforms: Record<string, THREE.IUniform>, attributes: string, vertex: string, key: string): void {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${attributes}\nvarying vec3 vSprayP;\nvarying vec3 vSprayN;\nvarying float vSprayRow;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${vertex}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${SPRAY_FRAGMENT}`)
      .replace("#include <color_fragment>", "#include <color_fragment>\nvec4 sprayS = sprayTexel();\ndiffuseColor.rgb = diffuseColor.rgb * (1.0 - sprayS.a) + sprayS.rgb;");
  };
  material.customProgramCacheKey = () => `${prevKey.call(material)}|spray-${key}`;
  material.needsUpdate = true;
}

/** A bare 1 x 1 spray: what a car's patched paint samples once its player's look is gone. Shared, never disposed. */
export const BARE_SPRAY = new THREE.DataTexture(new Uint8Array(4), 1, 1);
BARE_SPRAY.needsUpdate = true;
