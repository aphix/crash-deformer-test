import * as THREE from "three";

/**
 * Spray paint (the garage's can): a small paletted bitmap per car and per driver, wrapped round the thing as a box. A
 * point on its rest shape (the car's frame before any dent, the driver standing) and its normal pick one of five faces
 * (left, right, top, front, back; the underside takes none) and the point's place across that face picks the texel. The
 * same mapping runs here (`sprayFace`, for the stamp) and in the shader (`SPRAY_FRAGMENT`), so paint lands where it was
 * sprayed. 4 bits a texel on the wire (`packSpray`).
 */

/** The can's colours (sRGB); index 0 is bare (no paint). */
export const SPRAY_PALETTE: readonly number[] = [
  0, 0xf4f4f0, 0x141414, 0x808080, 0xd62828, 0xf77f00, 0xf5d300, 0x8ac926, 0x2a9d3f, 0x2ec4d6, 0x1d6fe0, 0x1b2a6b, 0x7b2cbf, 0xff5fa2, 0x7a4a24,
  0xd9b98c,
];

/** Face order in a layout's `faces` and in the shader's `sprayFaces`. */
const LEFT = 0;
const RIGHT = 1;
const TOP = 2;
const FRONT = 3;
const BACK = 4;

/** A face's texels: x, y (from the bitmap's first row), width, height. */
type Face = readonly [number, number, number, number];
/** A bitmap's size, the rest-frame box it wraps (m) and its five faces (`LEFT` … `BACK`). */
export type SprayLayout = { readonly w: number; readonly h: number; readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number]; readonly faces: readonly Face[] };

/** Bitmap side (texels): the wire's budget is 128 x 128 at 4 bits. */
const SIDE = 128;

/** A car in its own frame (+z forward, y up from the tyre plane): sides 128 x 30, roof 128 x 40, nose and tail 64 x 28. */
export const CAR_SPRAY: SprayLayout = {
  w: SIDE,
  h: SIDE,
  min: [-0.95, 0, -2.35],
  max: [0.95, 1.6, 2.35],
  faces: [
    [0, 0, 128, 30],
    [0, 30, 128, 30],
    [0, 60, 128, 40],
    [0, 100, 64, 28],
    [64, 100, 64, 28],
  ],
};

/** A driver standing (`PARTS` at rest, feet at y 0, facing +z): front and back 40 x 92, sides 24 x 92, the head's top 25 x 36. */
export const PERSON_SPRAY: SprayLayout = {
  w: SIDE,
  h: SIDE,
  min: [-0.4, 0, -0.25],
  max: [0.4, 1.85, 0.25],
  faces: [
    [80, 0, 24, 92],
    [104, 0, 24, 92],
    [0, 92, 25, 36],
    [0, 0, 40, 92],
    [40, 0, 40, 92],
  ],
};

/**
 * The face (`LEFT` … `BACK`) rest point (px, py, pz) with normal (nx, ny, nz) is painted on, and its place across that face
 * (0..1 each) into `uv`; -1 for the underside, which takes no paint. The shader's `sprayTexel` is this, line for line.
 */
export function sprayFace(layout: SprayLayout, px: number, py: number, pz: number, nx: number, ny: number, nz: number, uv: Float64Array): number {
  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);
  const tx = across(px, layout.min[0], layout.max[0]);
  const ty = across(py, layout.min[1], layout.max[1]);
  const tz = across(pz, layout.min[2], layout.max[2]);
  if (ax >= ay && ax >= az) {
    uv[0] = tz;
    uv[1] = ty;
    return nx < 0 ? LEFT : RIGHT;
  }
  if (ay >= az) {
    if (ny < 0) return -1;
    uv[0] = tz;
    uv[1] = tx;
    return TOP;
  }
  uv[0] = tx;
  uv[1] = ty;
  return nz > 0 ? FRONT : BACK;
}

function across(v: number, min: number, max: number): number {
  return Math.min(1, Math.max(0, (v - min) / (max - min)));
}

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
    const spanU = face === FRONT || face === BACK ? max[0] - min[0] : max[2] - min[2];
    const spanV = face === TOP ? max[0] - min[0] : max[1] - min[1];
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

/** `packSpray`'s first byte: the texels as nibbles, two to a byte, or as runs (length 1-255, then the index). */
const PACKED = 0;
const RUNS = 1;
const MAX_RUN = 255;

/** A bitmap's texels for the wire and for storage: runs when they come out shorter than the nibbles (a mostly bare bitmap). */
export function packSpray(texels: Uint8Array): Uint8Array {
  let runs = 0;
  for (let i = 0; i < texels.length; runs++) i += runLength(texels, i);
  if (runs * 2 < texels.length / 2) {
    const out = new Uint8Array(1 + runs * 2);
    out[0] = RUNS;
    let o = 1;
    for (let i = 0; i < texels.length; ) {
      const n = runLength(texels, i);
      out[o++] = n;
      out[o++] = texels[i]!;
      i += n;
    }
    return out;
  }
  const out = new Uint8Array(1 + Math.ceil(texels.length / 2));
  out[0] = PACKED;
  for (let i = 0; i < texels.length; i++) out[1 + (i >> 1)]! |= (texels[i]! & 0xf) << ((i & 1) * 4);
  return out;
}

function runLength(texels: Uint8Array, at: number): number {
  let n = 1;
  while (n < MAX_RUN && at + n < texels.length && texels[at + n] === texels[at]) n++;
  return n;
}

/** `packSpray`'s bytes back into `count` texels; null when they are not a packed bitmap of that size (untrusted: a peer's or storage's). */
export function unpackSpray(bytes: Uint8Array, count: number): Uint8Array | null {
  const out = new Uint8Array(count);
  if (bytes[0] === PACKED) {
    if (bytes.length !== 1 + Math.ceil(count / 2)) return null;
    for (let i = 0; i < count; i++) out[i] = (bytes[1 + (i >> 1)]! >> ((i & 1) * 4)) & 0xf;
    return out;
  }
  if (bytes[0] !== RUNS || bytes.length % 2 !== 1) return null;
  let at = 0;
  for (let o = 1; o < bytes.length; o += 2) {
    const n = bytes[o]!;
    const colour = bytes[o + 1]!;
    if (n === 0 || colour >= SPRAY_PALETTE.length || at + n > count) return null;
    out.fill(colour, at, at + n);
    at += n;
  }
  return at === count ? out : null;
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
