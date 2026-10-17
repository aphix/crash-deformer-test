import { hypot3 } from "../kernel/physics-core.js";
import { SPRAY_PALETTE, CAR_SPRAY } from "../match/look-data.ts";
import { mulberry32 } from "../world/placements.ts";
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
 * against green is about 240), yet leaves most of the palette to pick from for every car paint. Black and white always clear
 * at least 194 from any colour (half the black-white span), so a candidate always exists below that.
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
 * One ink (a palette index from 1) that clears `RIVAL_INK_CONTRAST` from the paint `body` and from the colour `first` when one
 * is given, and is not `first`; else the palette colour farthest from the paint that is not `first`. The roll is always drawn,
 * so a stream's later picks never move.
 */
function inkOf(rand: () => number, body: number, first?: number): number {
  const roll = rand();
  const palette = SPRAY_PALETTE.map((_, index) => index).slice(1).filter((index) => index !== first);
  const clear = palette.filter((index) => colourDistance(SPRAY_PALETTE[index]!, body) >= RIVAL_INK_CONTRAST && (first === undefined || colourDistance(SPRAY_PALETTE[index]!, SPRAY_PALETTE[first]!) >= RIVAL_INK_CONTRAST));
  if (clear.length > 0) return clear[Math.floor(roll * clear.length)]!;
  return palette.reduce((far, index) => (colourDistance(SPRAY_PALETTE[index]!, body) > colourDistance(SPRAY_PALETTE[far]!, body) ? index : far));
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

/** What a slot's bitmap was drawn for. */
type Drawn = { readonly bitmap: SprayBitmap; seed: number; body: number };

/**
 * The rivals' bitmaps, one `CAR_SPRAY` per slot, drawn on first ask and redrawn in place (the same bitmap, so its texture
 * stays the one the car's paint samples) only when the slot's seed or paint changes. Memory: at most 32 slots (the engine's
 * car cap) of 16 KiB texels + 64 KiB rgba on the CPU and 64 KiB on the GPU, about 4.6 MiB for a full field.
 */
export class RivalLooks {
  private readonly drawn = new Map<number, Drawn>();

  /** The bitmap wearing the look of car `slot` for `seed` and `bodyColour`. */
  of(seed: number, slot: number, bodyColour: number): SprayBitmap {
    let entry = this.drawn.get(slot);
    if (entry === undefined) {
      entry = { bitmap: new SprayBitmap(CAR_SPRAY), seed, body: bodyColour };
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
