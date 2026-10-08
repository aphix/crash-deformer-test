import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { assertSameNumbers } from "../vehicle/test-support.ts";
import { CAR_SPRAY, packSpray, PERSON_SPRAY, sprayFace, unpackSpray, type SprayLayout } from "../match/look-data.ts";
import { SprayBitmap } from "./spray.ts";

const LAYOUTS: Record<string, SprayLayout> = { car: CAR_SPRAY, person: PERSON_SPRAY };
/** Face order in a layout's `faces`. */
const FACE = { left: 0, right: 1, top: 2, front: 3, back: 4 } as const;

describe("given a spray bitmap on the wire", () => {
  it("when a mostly bare bitmap is packed and read back, then every texel is the same and it travels as runs far under the 4-bit size", () => {
    const texels = new Uint8Array(CAR_SPRAY.w * CAR_SPRAY.h);
    texels.fill(4, 1000, 1400);
    texels.fill(9, 5000, 5003);
    const packed = packSpray(texels);
    assert.ok(packed.length < texels.length / 2 / 10, `${packed.length} bytes against ${texels.length / 2} as nibbles`);
    assertSameNumbers(unpackSpray(packed, texels.length)!, texels, "texels read back");
  });

  it("when a speckled bitmap (no two texels alike in a row) is packed and read back, then every texel is the same and it travels as nibbles, 4 bits a texel", () => {
    const texels = new Uint8Array(PERSON_SPRAY.w * PERSON_SPRAY.h);
    for (let i = 0; i < texels.length; i++) texels[i] = (i % 15) + 1;
    const packed = packSpray(texels);
    assert.equal(packed.length, 1 + texels.length / 2, "one byte of header, then two texels a byte");
    assertSameNumbers(unpackSpray(packed, texels.length)!, texels, "texels read back");
  });

  const refused = [
    { it: "when its runs come up one texel short, then it is refused", bytes: [1, 255, 0], count: 256 },
    { it: "when a run names a colour past the palette, then it is refused", bytes: [1, 4, 16], count: 4 },
    { it: "when its nibbles are one byte short, then it is refused", bytes: [0, 0x21], count: 4 },
    { it: "when its header is neither nibbles nor runs, then it is refused", bytes: [7, 1, 1], count: 1 },
  ] as const;
  for (const testCase of refused) {
    it(testCase.it, () => {
      assert.equal(unpackSpray(new Uint8Array(testCase.bytes), testCase.count), null);
    });
  }
});

describe("given a spray bitmap wrapped round a car or a driver as a box", () => {
  const faces = [
    { it: "when the car is sprayed on its left flank, then the left face takes it", layout: "car", p: [-0.9, 0.7, 0.5], n: [-1, 0, 0], face: FACE.left },
    { it: "when the car is sprayed on its right flank, then the right face takes it", layout: "car", p: [0.9, 0.7, 0.5], n: [1, 0, 0], face: FACE.right },
    { it: "when the car is sprayed on its roof, then the top face takes it", layout: "car", p: [0, 1.4, 0], n: [0, 1, 0], face: FACE.top },
    { it: "when the car is sprayed on its nose, then the front face takes it", layout: "car", p: [0, 0.6, 2.2], n: [0, 0, 1], face: FACE.front },
    { it: "when the car is sprayed on its tail, then the back face takes it", layout: "car", p: [0, 0.6, -2.2], n: [0, 0, -1], face: FACE.back },
    { it: "when the driver is sprayed on his chest, then the front face takes it", layout: "person", p: [0, 1.2, 0.12], n: [0, 0, 1], face: FACE.front },
    { it: "when the driver is sprayed under a shoe, then no face takes it", layout: "person", p: [0.1, 0, 0], n: [0, -1, 0], face: -1 },
  ] as const;
  for (const testCase of faces) {
    it(testCase.it, () => {
      const uv = new Float64Array(2);
      const [px, py, pz] = testCase.p;
      const [nx, ny, nz] = testCase.n;
      assert.equal(sprayFace(LAYOUTS[testCase.layout]!, px, py, pz, nx, ny, nz, uv), testCase.face);
    });
  }

  it("when one puff of a can that never misses lands on the car's left flank, then the texels round its spot on the left face take the can's colour out to its radius, and no other face is touched", () => {
    const bitmap = new SprayBitmap(CAR_SPRAY);
    const radius = 0.15;
    assert.equal(bitmap.spray(new THREE.Vector3(-0.9, 0.8, 0), new THREE.Vector3(-1, 0, 0), radius, 6, () => 0), true);
    const [fx, fy, fw, fh] = CAR_SPRAY.faces[FACE.left]!;
    // The spot's middle: z 0 is half way along the 4.7 m face, y 0.8 half way up its 1.6 m.
    const cx = Math.floor(fx + fw / 2);
    const cy = Math.floor(fy + fh / 2);
    let inside = 0;
    let outside = 0;
    for (let y = 0; y < CAR_SPRAY.h; y++) {
      for (let x = 0; x < CAR_SPRAY.w; x++) {
        if (bitmap.texels[y * CAR_SPRAY.w + x] === 0) continue;
        assert.equal(bitmap.texels[y * CAR_SPRAY.w + x], 6, "the can's colour");
        if (x >= fx && x < fx + fw && y >= fy && y < fy + fh) inside++;
        else outside++;
      }
    }
    assert.equal(outside, 0, "no texel off the left face");
    assert.ok(inside > 0, "the puff painted the left face");
    assert.equal(bitmap.texels[cy * CAR_SPRAY.w + cx], 6, "the spot's middle is painted");
    // Its reach along the face: the radius in texels (`fw` over the box's 4.7 m length), never past it.
    const reach = (radius * fw) / (CAR_SPRAY.max[2] - CAR_SPRAY.min[2]);
    for (let x = fx; x < fx + fw; x++) if (bitmap.texels[cy * CAR_SPRAY.w + x] !== 0) assert.ok(Math.abs(x + 0.5 - (fx + fw / 2)) <= reach + 0.5, `texel ${x} within the radius`);
    assert.equal(bitmap.texels[cy * CAR_SPRAY.w + Math.floor(fx + fw / 2 + reach - 1)], 6, "painted out to a texel short of its radius");
    bitmap.dispose();
  });
});
