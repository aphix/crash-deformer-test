import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSameDigest } from "../vehicle/test-support.ts";
import { driverLook, HAIRS, SHIRTS, WOMAN_RATE } from "./driver-look.ts";

describe("given the generated look of each driver (shirt, hair and whether a woman) for a race seed and grid slot", () => {
  it("when the same seed and slot are asked twice, then it is the same driver, and a different race seed changes the field", () => {
    for (let slot = 0; slot < 8; slot++) assertSameDigest(driverLook(77, slot), driverLook(77, slot), `slot ${slot}`);
    let differ = 0;
    for (let slot = 0; slot < 32; slot++) {
      const a = driverLook(1, slot);
      const b = driverLook(2, slot);
      if (a.shirt !== b.shirt || a.hair !== b.hair || a.woman !== b.woman) differ++;
    }
    assert.ok(differ >= 28, `${differ} of 32 slots look different in the next race`);
  });

  it("when 200 seeds each make a field of 8, then at the median seed the field has at least 5 distinct tees and 4 distinct hairs", () => {
    const shirts: number[] = [];
    const hairs: number[] = [];
    for (let seed = 0; seed < 200; seed++) {
      const field = Array.from({ length: 8 }, (_, s) => driverLook(seed * 7919, s));
      shirts.push(new Set(field.map((l) => l.shirt)).size);
      hairs.push(new Set(field.map((l) => l.hair)).size);
    }
    shirts.sort((a, b) => a - b);
    hairs.sort((a, b) => a - b);
    assert.ok(shirts[100]! >= 5, `median distinct tees ${shirts[100]}`);
    assert.ok(hairs[100]! >= 4, `median distinct hairs ${hairs[100]}`);
  });

  it("when 10 000 seed and slot pairs are generated, then 10% ± 1 are women and every tee and hair of the palettes turns up", () => {
    let women = 0;
    const tees = new Set<number>();
    const manes = new Set<number>();
    for (let i = 0; i < 10000; i++) {
      const l = driverLook(Math.floor(i / 10) * 40503 + 12345, i % 10);
      if (l.woman) women++;
      tees.add(l.shirt);
      manes.add(l.hair);
    }
    assert.ok(Math.abs(women / 10000 - WOMAN_RATE) <= 0.01, `${women / 100}% women`);
    assert.equal(tees.size, new Set(SHIRTS).size);
    assert.equal(manes.size, new Set(HAIRS).size);
  });

  it("when women are picked out of 2000 seeds, then a woman's tee and hair are drawn from the same palettes as a man's", () => {
    let women = 0;
    for (let i = 0; i < 2000; i++) {
      const l = driverLook(i, 3);
      if (!l.woman) continue;
      women++;
      assert.ok(SHIRTS.includes(l.shirt) && HAIRS.includes(l.hair));
    }
    assert.ok(women > 100);
  });
});
