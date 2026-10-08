import { LID } from "../vehicle/constants.ts";

/**
 * A player's look as data, the same on every peer and in storage: the colours picked in the garage (`CarPick`,
 * `PersonPick`, as their URL text) and the spray paint, a small paletted bitmap per car and per driver wrapped round the
 * thing as a box. A point on its rest shape (the car's frame before any dent, the driver standing) and its normal pick one
 * of five faces (left, right, top, front, back; the underside takes none) and the point's place across that face picks the
 * texel (`sprayFace`; the shader in `present/spray.ts` runs the same formula). 4 bits a texel on the wire (`packSpray`).
 */

/** The can's colours (sRGB); index 0 is bare (no paint). */
export const SPRAY_PALETTE: readonly number[] = [
  0, 0xf4f4f0, 0x141414, 0x808080, 0xd62828, 0xf77f00, 0xf5d300, 0x8ac926, 0x2a9d3f, 0x2ec4d6, 0x1d6fe0, 0x1b2a6b, 0x7b2cbf, 0xff5fa2, 0x7a4a24,
  0xd9b98c,
];

/** Face order in a layout's `faces` and in the shader's `sprayFaces`. */
export const SPRAY_FACE = { left: 0, right: 1, top: 2, front: 3, back: 4 } as const;

/** A face's texels: x, y (from the bitmap's first row), width, height. */
type Face = readonly [number, number, number, number];
/** A bitmap's size, the rest-frame box it wraps (m) and its five faces (in `SPRAY_FACE` order). */
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
 * The face (`SPRAY_FACE`) rest point (px, py, pz) with normal (nx, ny, nz) is painted on, and its place across that face
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
    return nx < 0 ? SPRAY_FACE.left : SPRAY_FACE.right;
  }
  if (ay >= az) {
    if (ny < 0) return -1;
    uv[0] = tz;
    uv[1] = tx;
    return SPRAY_FACE.top;
  }
  uv[0] = tx;
  uv[1] = ty;
  return nz > 0 ? SPRAY_FACE.front : SPRAY_FACE.back;
}

function across(v: number, min: number, max: number): number {
  return Math.min(1, Math.max(0, (v - min) / (max - min)));
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

/** The car's parts a colour can be picked for, in text order. */
export const CAR_PARTS = ["body", "doors", LID.hood, LID.trunk, "bumpers", "rims", "glass"] as const;
export type CarPart = (typeof CAR_PARTS)[number];
export type CarPick = Record<CarPart, number | null>;

/** The driver's colours in text order, after the build slot; `hat` null is no cap. */
const PERSON_COLOURS = ["shirt", "pants", "hair", "hat"] as const;
export type PersonPick = { woman: boolean | null; shirt: number | null; pants: number | null; hair: number | null; hat: number | null; mustache: boolean };

export const NO_CAR_PICK: CarPick = { body: null, doors: null, hood: null, trunk: null, bumpers: null, rims: null, glass: null };
export const NO_PERSON_PICK: PersonPick = { woman: null, shirt: null, pants: null, hair: null, hat: null, mustache: false };

/** Colour `c` (sRGB) as 6 hex digits: a pick's slot, and after a "#" a colour input's value. */
export const hexOf = (c: number): string => c.toString(16).padStart(6, "0");

/** One slot's colour, null when empty; undefined when it is not 6 hex digits. */
function colourOf(slot: string): number | null | undefined {
  if (slot === "") return null;
  return /^[0-9a-f]{6}$/i.test(slot) ? parseInt(slot, 16) : undefined;
}

export function carPickText(pick: CarPick): string {
  return CAR_PARTS.map((part) => (pick[part] === null ? "" : hexOf(pick[part]))).join(".");
}

/** The pick `text` names; null when it is not one (untrusted: a link's or a peer's). */
export function parseCarPick(text: string): CarPick | null {
  const slots = text.split(".");
  if (slots.length !== CAR_PARTS.length) return null;
  const pick = { ...NO_CAR_PICK };
  for (const [i, part] of CAR_PARTS.entries()) {
    const colour = colourOf(slots[i]!);
    if (colour === undefined) return null;
    pick[part] = colour;
  }
  return pick;
}

export function personPickText(pick: PersonPick): string {
  const build = pick.woman === null ? "" : pick.woman ? "w" : "m";
  return [build, ...PERSON_COLOURS.map((key) => (pick[key] === null ? "" : hexOf(pick[key]))), pick.mustache ? "1" : ""].join(".");
}

/** The pick `text` names; null when it is not one (untrusted: a link's or a peer's). */
export function parsePersonPick(text: string): PersonPick | null {
  const slots = text.split(".");
  if (slots.length !== PERSON_COLOURS.length + 2) return null;
  const build = slots[0];
  const mustache = slots.at(-1);
  if ((build !== "" && build !== "w" && build !== "m") || (mustache !== "" && mustache !== "1")) return null;
  const pick: PersonPick = { ...NO_PERSON_PICK, woman: build === "" ? null : build === "w", mustache: mustache === "1" };
  for (const [i, key] of PERSON_COLOURS.entries()) {
    const colour = colourOf(slots[i + 1]!);
    if (colour === undefined) return null;
    pick[key] = colour;
  }
  return pick;
}
