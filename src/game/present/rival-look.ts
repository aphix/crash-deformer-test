import { hypot3 } from "../kernel/physics-core.js";
import { SPRAY_PALETTE, CAR_SPRAY, type SprayLayout } from "../match/look-data.ts";
import { mulberry32 } from "../world/placements.ts";
import type { FxTier } from "./engine-post.ts";
import { BAND_PATTERNS } from "./rival-patterns-bands.ts";
import { ORGANIC_PATTERNS } from "./rival-patterns-organic.ts";
import { RivalPen, type RivalPattern } from "./rival-pen.ts";
import { SHAPE_PATTERNS } from "./rival-patterns-shapes.ts";
import { SprayBitmap } from "./spray.ts";

/**
 * The rivals' spray: which of the 20 patterns an AI car wears and in which inks (`rivalLook`, a pure function of the race's
 * look seed, the car's slot and its paint), and the bitmaps they are drawn into (`RivalLooks`). Cosmetic only: every random
 * choice comes from its own `mulberry32` streams (never `Math.random`, never the sim's RNG), so sim digests do not move and
 * every peer, replay and highlight clip that knows the seed draws the same car.
 */

/** The collection, in the order the pattern files list them: bands, shapes, organic. */
export const RIVAL_PATTERNS: readonly RivalPattern[] = [...BAND_PATTERNS, ...SHAPE_PATTERNS, ...ORGANIC_PATTERNS];

/**
 * The least sRGB distance (Euclidean over 0-255 channels, so 441 at most) between an ink and the paint it is drawn on, or on
 * the car's other ink. 120 reads as a different colour at a glance (a red against a darker red is about 90 and washes out; red
 * against green is about 240), yet leaves most of the palette to pick from for every car paint. A first ink always exists (one of
 * black and white is at least 220 from any paint) and so does a second (`inkOf`: the best candidate keeps 154 over every paint and
 * first ink), so at most 154 may stand here before a pick can come up empty.
 */
export const RIVAL_INK_CONTRAST = 120;

/** Salts that keep the order, ink and pen streams independent of each other and of `driverLook`'s (`0x9e3779b9`). */
const ORDER_SALT = 0x2f6b8c1d;
const INK_SALT = 0x51ed270b;
const PEN_SALT = 0x7a3c9d45;
const SLOT_MIX = 0xc2b2ae35;
const SEED_MIX = 0x85ebca6b;

/** A stream for `salt` and `seed`, and for the car in `slot` when one is named. */
function streamOf(salt: number, seed: number, slot = -1): () => number {
  return mulberry32(Math.imul(seed ^ salt, SEED_MIX) ^ Math.imul(slot + 1, SLOT_MIX));
}

/** Palette colours `a` and `b` (sRGB) this far apart. */
function colourDistance(a: number, b: number): number {
  return hypot3((a >> 16) - (b >> 16), ((a >> 8) & 0xff) - ((b >> 8) & 0xff), (a & 0xff) - (b & 0xff));
}

/** The pattern order of a field: a Fisher-Yates shuffle of the pattern indices, a function of the seed alone. */
function orderOf(seed: number): number[] {
  const rand = streamOf(ORDER_SALT, seed);
  const order = RIVAL_PATTERNS.map((_, index) => index);
  for (let at = order.length - 1; at > 0; at--) {
    const swap = Math.floor(rand() * (at + 1));
    [order[at], order[swap]] = [order[swap]!, order[at]!];
  }
  return order;
}

/**
 * One ink (a palette index from 1) that clears `RIVAL_INK_CONTRAST` from the paint `body` and, when given, from the colour `first`
 * (which it also differs from): the roll picks among those that do. One always exists, so there is no fallback to write: for the
 * first ink black and white lie 441 apart, so one of them is at least 220 from any paint; for the second, over every first ink and
 * a lattice of paints 4 apart per channel the best candidate keeps a margin of at least 154 (measured: worst case a paint of
 * 0x585870 after a first ink of 0xd9b98c), and a paint between lattice points moves that by at most the lattice's half-diagonal, 3.5
 * (`rival-look.test.ts` asserts it on a coarser lattice with its half-diagonal taken off).
 */
function inkOf(rand: () => number, body: number, first?: number): number {
  const roll = rand();
  const clear = SPRAY_PALETTE.map((_, index) => index).slice(1).filter((index) => index !== first && colourDistance(SPRAY_PALETTE[index]!, body) >= RIVAL_INK_CONTRAST && (first === undefined || colourDistance(SPRAY_PALETTE[index]!, SPRAY_PALETTE[first]!) >= RIVAL_INK_CONTRAST));
  return clear[Math.floor(roll * clear.length)]!;
}

/**
 * The look of the car in `slot` of the field with look seed `seed`, painted `bodyColour` (sRGB): the first 20 slots of one
 * field wear 20 distinct patterns (a seeded order of the collection), and its inks are random palette colours that read
 * against the paint.
 */
export function rivalLook(seed: number, slot: number, bodyColour: number): { readonly pattern: RivalPattern; readonly inks: readonly number[] } {
  const pattern = RIVAL_PATTERNS[orderOf(seed)[slot % RIVAL_PATTERNS.length]!]!;
  const rand = streamOf(INK_SALT, seed, slot);
  const first = inkOf(rand, bodyColour);
  return { pattern, inks: pattern.inks === 1 ? [first] : [first, inkOf(rand, bodyColour, first)] };
}

/**
 * Texels a metre of the rivals' bitmap has, as a multiple of the garage's `CAR_SPRAY`, per FX tier: the rivals are procedural
 * and never cross the wire or a clip, so the finer the tier the finer the paint (up close the garage's 3.7 cm texel along the car
 * is stair-stepped on a flame's edge): the garage's own bitmap below High, twice the texels a side at High, four times at Ultra.
 */
const RIVAL_SPRAY_SCALE: Record<FxTier, number> = { off: 1, minimal: 1, low: 1, high: 2, ultra: 4 };

/** `CAR_SPRAY` with every texel `scale` times finer each way: the same box and the same faces, so the paint shader (its face rectangles are fractions of the bitmap) reads it unchanged. */
function scaledLayout(scale: number): SprayLayout {
  return { ...CAR_SPRAY, w: CAR_SPRAY.w * scale, h: CAR_SPRAY.h * scale, faces: CAR_SPRAY.faces.map(([x, y, width, height]) => [x * scale, y * scale, width * scale, height * scale] as const) };
}

/** What a slot's bitmap was drawn for. */
type Drawn = { readonly bitmap: SprayBitmap; seed: number; body: number };

/**
 * The rivals' bitmaps, one per slot, drawn on first ask and redrawn in place (the same bitmap, so its texture stays the one the
 * car's paint samples) only when the slot's seed or paint changes. The bitmap's size follows the FX tier (`useTier`,
 * `RIVAL_SPRAY_SCALE`); the finer ones are mip-mapped, so a far car's paint does not shimmer. Memory for the engine's 32 slots
 * (texels + CPU rgba + GPU, the GPU copy a third bigger with its mips): below High 144 KiB a car, 4.5 MiB a field; High (256 x 256)
 * 661 KiB a car, 20.6 MiB a field; Ultra (512 x 512) 2.6 MiB a car, 82.7 MiB a field. Drawing all 31 rivals of a full field takes
 * about 55 ms at High and 170 ms at Ultra (node), once when a race starts and once more when the tier changes.
 */
export class RivalLooks {
  private readonly drawn = new Map<number, Drawn>();
  private scale = RIVAL_SPRAY_SCALE.off;
  private layout = CAR_SPRAY;

  /**
   * Draw for FX tier `tier` from now on. Every bitmap drawn so far is freed when that changes the size: true then, and the cars
   * wearing one must be dressed again (their paint samples a freed texture until they are).
   */
  useTier(tier: FxTier): boolean {
    const scale = RIVAL_SPRAY_SCALE[tier];
    if (scale === this.scale) return false;
    this.scale = scale;
    this.layout = scale === 1 ? CAR_SPRAY : scaledLayout(scale);
    const wasWorn = this.drawn.size > 0;
    this.dispose();
    return wasWorn;
  }

  /** The bitmap wearing the look of car `slot` for `seed` and `bodyColour`. */
  of(seed: number, slot: number, bodyColour: number): SprayBitmap {
    let entry = this.drawn.get(slot);
    if (entry === undefined) {
      entry = { bitmap: new SprayBitmap(this.layout, this.scale > 1), seed, body: bodyColour };
      this.drawn.set(slot, entry);
    } else if (entry.seed === seed && entry.body === bodyColour) {
      return entry.bitmap;
    }
    entry.seed = seed;
    entry.body = bodyColour;
    entry.bitmap.load(null);
    const look = rivalLook(seed, slot, bodyColour);
    look.pattern.draw(new RivalPen(entry.bitmap, look.inks, streamOf(PEN_SALT, seed, slot)));
    return entry.bitmap;
  }

  /** Free every bitmap's texture. */
  dispose(): void {
    for (const { bitmap } of this.drawn.values()) bitmap.dispose();
    this.drawn.clear();
  }
}
