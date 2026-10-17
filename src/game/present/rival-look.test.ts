import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAR_SPRAY, SPRAY_PALETTE } from "../match/look-data.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import { RIVAL_INK_CONTRAST, RIVAL_PATTERNS, RivalLooks, rivalLook } from "./rival-look.ts";
import type { SprayBitmap } from "./spray.ts";

/** Palette colours `a` and `b` (sRGB) this far apart: the metric `RIVAL_INK_CONTRAST` is in. */
const distance = (a: number, b: number): number => Math.hypot((a >> 16) - (b >> 16), ((a >> 8) & 0xff) - ((b >> 8) & 0xff), (a & 0xff) - (b & 0xff));

/** Car paints: black, white, mid grey, every palette colour, then `count` spread over the colour cube. */
function bodiesOf(count: number): number[] {
  const bodies = [0x000000, 0xffffff, 0x808080, ...SPRAY_PALETTE];
  for (let i = 0; i < count; i++) bodies.push(Math.imul(i + 1, 0x9e3779b1) & 0xffffff);
  return bodies;
}

/**
 * The paints the ink-existence row tries: every 16th level of each channel and 255, so no paint is farther than this half-diagonal from one of them
 * (a colour moves at most that far in distance, so a margin over the contrast plus it holds for every paint between the lattice points).
 */
const LATTICE_STEP = 16;
const LATTICE_HALF_DIAGONAL = Math.hypot(LATTICE_STEP / 2, LATTICE_STEP / 2, LATTICE_STEP / 2);

/** The least distance that still reads as a different colour at a glance (a red on a darker red is about 90 and washes out): the bar the shipped contrast must not drop under. */
const READABLE_CONTRAST = 100;

/** The painted texels of the pattern in `slot` of `seed` as a string of their positions. */
function maskOf(looks: RivalLooks, seed: number, slot: number, body: number): string {
  return looks
    .of(seed, slot, body)
    .texels.reduce((mask, texel, at) => (texel === 0 ? mask : `${mask}${at},`), "");
}

describe("given the rivals' pattern collection and its seeded order", () => {
  it("when the same seed, slot and paint are asked twice, then it is the same pattern in the same inks and the same texels", () => {
    for (let slot = 0; slot < 8; slot++) {
      const a = rivalLook(77, slot, 0x3366aa);
      const b = rivalLook(77, slot, 0x3366aa);
      assert.equal(a.pattern.name, b.pattern.name, `slot ${slot} pattern`);
      assertSameNumbers(a.inks, b.inks, `slot ${slot} inks`);
      const first = new RivalLooks();
      const second = new RivalLooks();
      assertSameNumbers(first.of(77, slot, 0x3366aa).texels, second.of(77, slot, 0x3366aa).texels, `slot ${slot} texels`);
      first.dispose();
      second.dispose();
    }
  });

  it("when the collection is counted, then it holds 20 differently named patterns", () => {
    assert.equal(RIVAL_PATTERNS.length, 20);
    assert.equal(new Set(RIVAL_PATTERNS.map((pattern) => pattern.name)).size, 20);
  });

  it("when one field's first 20 slots are asked, then they wear 20 distinct patterns and slots 20 to 31 reuse them", () => {
    for (const seed of [1, 99, 123456]) {
      const names = Array.from({ length: 32 }, (_, slot) => rivalLook(seed, slot, 0x336699).pattern.name);
      assert.equal(new Set(names.slice(0, 20)).size, 20, `seed ${seed}: distinct patterns over slots 0..19`);
      for (let slot = 20; slot < 32; slot++) assert.equal(names[slot], names[slot - 20], `seed ${seed}: slot ${slot} reuses slot ${slot - 20}`);
    }
  });

  it("when the seed changes, then the field is ordered differently", () => {
    let reordered = 0;
    const pairs = 50;
    for (let pair = 0; pair < pairs; pair++) {
      const a = Math.imul(pair + 1, 7919);
      const b = a + 1;
      const differs = Array.from({ length: 20 }, (_, slot) => rivalLook(a, slot, 0x336699).pattern.name !== rivalLook(b, slot, 0x336699).pattern.name);
      if (differs.some(Boolean)) reordered++;
    }
    assert.ok(reordered >= 48, `${reordered} of ${pairs} neighbouring seeds reorder the field`);
  });
});

describe("given the inks a rival is sprayed in", () => {
  it("when 2000 seed, slot and paint cases are drawn, then every ink is a palette colour that clears the paint and the first ink", () => {
    assert.ok(RIVAL_INK_CONTRAST >= READABLE_CONTRAST, `contrast ${RIVAL_INK_CONTRAST} is under the readable floor ${READABLE_CONTRAST}`);
    const bodies = bodiesOf(2000 - 3 - SPRAY_PALETTE.length);
    assert.equal(bodies.length, 2000);
    for (const [at, body] of bodies.entries()) {
      const { pattern, inks } = rivalLook(Math.imul(at, 40503) + 12345, at % 32, body);
      assert.equal(inks.length, pattern.inks, `case ${at}: ink count of ${pattern.name}`);
      for (const ink of inks) {
        assert.ok(Number.isInteger(ink) && ink >= 1 && ink < SPRAY_PALETTE.length, `case ${at}: ink ${ink} is a palette index from 1`);
        assert.ok(distance(SPRAY_PALETTE[ink]!, body) >= RIVAL_INK_CONTRAST, `case ${at}: ink ${ink} against paint ${body.toString(16)}`);
      }
      if (inks.length === 2) {
        assert.notEqual(inks[1], inks[0], `case ${at}: two different inks`);
        assert.ok(distance(SPRAY_PALETTE[inks[1]!]!, SPRAY_PALETTE[inks[0]!]!) >= RIVAL_INK_CONTRAST, `case ${at}: ink 1 against ink 0`);
      }
    }
  });

  it("when every first ink and a lattice of paints is tried, then a second ink always clears both with room to spare, so a pick never comes up empty", () => {
    const lattice = [...Array.from({ length: 16 }, (_, step) => step * LATTICE_STEP), 255];
    const colours = SPRAY_PALETTE.slice(1);
    for (const red of lattice) {
      for (const green of lattice) {
        for (const blue of lattice) {
          const body = (red << 16) | (green << 8) | blue;
          assert.ok(Math.max(...colours.map((colour) => distance(colour, body))) >= RIVAL_INK_CONTRAST + LATTICE_HALF_DIAGONAL, `first ink for paint ${body.toString(16)}`);
          for (const first of colours) {
            const best = Math.max(...colours.filter((colour) => colour !== first).map((colour) => Math.min(distance(colour, body), distance(colour, first))));
            assert.ok(best >= RIVAL_INK_CONTRAST + LATTICE_HALF_DIAGONAL, `second ink for paint ${body.toString(16)} after ${first.toString(16)}: best margin ${best.toFixed(1)}`);
          }
        }
      }
    }
  });
});

describe("given the rivals' bitmaps", () => {
  it("when each of the 20 patterns is drawn, then it paints at least 40 texels, in its own inks only, and no two paint the same texels", () => {
    const looks = new RivalLooks();
    const body = 0x336699;
    const masks = new Set<string>();
    for (let slot = 0; slot < RIVAL_PATTERNS.length; slot++) {
      const { pattern, inks } = rivalLook(31, slot, body);
      const texels = looks.of(31, slot, body).texels;
      const used = new Set(texels);
      used.delete(0);
      const painted = texels.filter((texel) => texel !== 0).length;
      assert.ok(painted >= 40, `${pattern.name} paints ${painted} texels`);
      for (const texel of used) assert.ok(inks.includes(texel), `${pattern.name} paints palette colour ${texel} outside its inks ${inks}`);
      masks.add(maskOf(looks, 31, slot, body));
    }
    assert.equal(masks.size, RIVAL_PATTERNS.length, "20 different texel sets");
    looks.dispose();
  });

  it("when the seed changes, then the same bitmap is redrawn with new texels, and with the same key it is left alone", () => {
    const looks = new RivalLooks();
    const bitmap = looks.of(1, 3, 0x336699);
    const before = bitmap.texels.slice();
    const version = bitmap.texture.version;
    assert.equal(looks.of(1, 3, 0x336699), bitmap, "same key, same bitmap");
    assert.equal(bitmap.texture.version, version, "same key leaves the texture alone");
    assertSameNumbers(bitmap.texels, before, "same key leaves the texels alone");
    assert.equal(looks.of(2, 3, 0x336699), bitmap, "new seed, same bitmap object");
    assert.ok(bitmap.texture.version > version, "new seed uploads the texture again");
    assert.notEqual(Buffer.compare(bitmap.texels, before), 0, "new seed paints new texels");
    const again = bitmap.texture.version;
    looks.of(2, 3, 0xcc3300);
    assert.ok(bitmap.texture.version > again, "new paint redraws too");
    looks.dispose();
  });
});

/** The painted share of every face of `bitmap`, in `SPRAY_FACE` order. */
function faceShares(bitmap: SprayBitmap): number[] {
  return bitmap.layout.faces.map(([x, y, width, height]) => {
    let painted = 0;
    for (let row = y; row < y + height; row++) for (let column = x; column < x + width; column++) if (bitmap.texels[row * bitmap.layout.w + column] !== 0) painted++;
    return painted / (width * height);
  });
}

/** How far a face's painted share may differ between the standard and a finer bitmap of one look: the can's rim speckle is drawn per texel, so the two are alike, not equal (the worst face of the 20 patterns, seed 31 on a 0x336699 car, measured 0.014 at High and 0.012 at Ultra). */
const SHARE_TOLERANCE = 0.02;

describe("given the rivals' bitmaps follow the FX tier", () => {
  it("when the tier is below High, High or Ultra, then the bitmap is the garage's CAR_SPRAY, twice or four times as many texels a side with a mip chain", () => {
    const expected = [
      { tier: "off", scale: 1 },
      { tier: "minimal", scale: 1 },
      { tier: "low", scale: 1 },
      { tier: "high", scale: 2 },
      { tier: "ultra", scale: 4 },
    ] as const;
    for (const { tier, scale } of expected) {
      const looks = new RivalLooks();
      looks.useTier(tier, "desktop");
      const bitmap = looks.of(3, 1, 0x336699);
      assert.equal(bitmap.layout.w, CAR_SPRAY.w * scale, `${tier}: width`);
      assert.equal(bitmap.layout.h, CAR_SPRAY.h * scale, `${tier}: height`);
      assert.equal(bitmap.texture.generateMipmaps, scale > 1, `${tier}: mip chain`);
      for (const [at, face] of CAR_SPRAY.faces.entries()) assertSameNumbers(bitmap.layout.faces[at]!, face.map((texels) => texels * scale), `${tier}: face ${at}`);
      assertSameNumbers(bitmap.layout.min, CAR_SPRAY.min, `${tier}: box minimum`);
      assertSameNumbers(bitmap.layout.max, CAR_SPRAY.max, `${tier}: box maximum`);
      looks.dispose();
    }
  });

  it("when the device is mobile and Ultra is picked by hand, then the rivals' bitmap stops at 2x (High's), a desktop's is 4x", () => {
    for (const [klass, scale] of [["mobile", 2], ["desktop", 4]] as const) {
      const looks = new RivalLooks();
      looks.useTier("ultra", klass);
      assert.equal(looks.of(3, 1, 0x336699).layout.w, CAR_SPRAY.w * scale, `${klass}: width at Ultra`);
      looks.dispose();
    }
    const looks = new RivalLooks();
    assert.equal(looks.useTier("high", "mobile"), false, "nothing was drawn");
    looks.of(3, 1, 0x336699);
    assert.equal(looks.useTier("ultra", "mobile"), false, "mobile High and mobile Ultra draw the same size: no redress");
    looks.dispose();
  });

  it("when the tier changes the bitmap's size, then the bitmaps drawn so far are freed and the next ask is a new one of that size; a tier of the same size changes nothing", () => {
    const looks = new RivalLooks();
    assert.equal(looks.useTier("minimal", "desktop"), false, "nothing was drawn and the size is the same");
    const standard = looks.of(3, 1, 0x336699);
    assert.equal(looks.useTier("low", "desktop"), false, "low draws the same size as minimal");
    assert.equal(looks.of(3, 1, 0x336699), standard, "so the bitmap stays");
    assert.equal(looks.useTier("high", "desktop"), true, "High changes the size with a bitmap worn");
    const fine = looks.of(3, 1, 0x336699);
    assert.notEqual(fine, standard, "a new bitmap");
    assert.equal(fine.layout.w, CAR_SPRAY.w * 2, "of the finer size");
    assert.equal(looks.useTier("ultra", "desktop"), true, "Ultra changes it again");
    looks.dispose();
    assert.equal(looks.useTier("off", "desktop"), false, "with nothing drawn there is nothing to dress again");
  });

  it("when one look is drawn at every size, then each face is painted to the same share and the finer bitmap is a bigger picture of the same paint", () => {
    const body = 0x336699;
    for (let slot = 0; slot < RIVAL_PATTERNS.length; slot++) {
      const shares: number[][] = [];
      for (const tier of ["low", "high", "ultra"] as const) {
        const looks = new RivalLooks();
        looks.useTier(tier, "desktop");
        shares.push(faceShares(looks.of(31, slot, body)));
        looks.dispose();
      }
      const name = rivalLook(31, slot, body).pattern.name;
      for (const [at, share] of shares[0]!.entries()) {
        for (const finer of [1, 2] as const) assert.ok(Math.abs(shares[finer]![at]! - share) <= SHARE_TOLERANCE, `${name}: face ${at} painted ${share.toFixed(3)} standard against ${shares[finer]![at]!.toFixed(3)} at size ${finer === 1 ? "High" : "Ultra"}`);
      }
    }
  });
});
