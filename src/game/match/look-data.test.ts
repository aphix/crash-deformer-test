import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { driverLook, pickedLook } from "../present/driver-look.ts";
import { carPickText, NO_CAR_PICK, NO_PERSON_PICK, parseCarPick, parsePersonPick, personPickText } from "./look-data.ts";

describe("given a player's look picks as the URL and the look message carry them", () => {
  it("when a car pick with some parts picked is written and read back, then it is the same pick, and the unpicked parts stay unpicked", () => {
    const pick = { ...NO_CAR_PICK, body: 0xff0000, rims: 0x00ff00, glass: 0x000001 };
    const text = carPickText(pick);
    assert.equal(text, "ff0000.....00ff00.000001");
    const back = parseCarPick(text)!;
    assert.equal(carPickText(back), text, "the same text");
    assert.equal(back.body, 0xff0000, "body");
    assert.equal(back.doors, null, "doors unpicked");
    assert.equal(back.glass, 0x000001, "glass");
  });

  it("when a driver pick (a woman with a cap and a moustache) is written and read back, then it is the same pick", () => {
    const pick = { ...NO_PERSON_PICK, woman: true, shirt: 0x123456, hat: 0xabcdef, mustache: true };
    const text = personPickText(pick);
    assert.equal(text, "w.123456...abcdef.1");
    const back = parsePersonPick(text)!;
    assert.equal(back.woman, true, "build");
    assert.equal(back.shirt, 0x123456, "shirt");
    assert.equal(back.pants, null, "trousers unpicked");
    assert.equal(back.hat, 0xabcdef, "cap");
    assert.equal(back.mustache, true, "moustache");
  });

  const refused = [
    { it: "when a car pick has one slot too few, then it is refused", car: "ff0000.....00ff00", person: null },
    { it: "when a car pick's colour is not 6 hex digits, then it is refused", car: "ff00.......", person: null },
    { it: "when a driver pick's build is neither w nor m, then it is refused", car: null, person: "x....." },
    { it: "when a driver pick's moustache slot is not 1, then it is refused", car: null, person: "m.....yes" },
  ] as const;
  for (const testCase of refused) {
    it(testCase.it, () => {
      if (testCase.car !== null) assert.equal(parseCarPick(testCase.car), null);
      if (testCase.person !== null) assert.equal(parsePersonPick(testCase.person), null);
    });
  }

  it("when a drawn driver wears a pick of a shirt alone, then he keeps his own build, trousers and hair and wears the picked shirt", () => {
    const base = driverLook(3, 1);
    const look = pickedLook(base, { ...NO_PERSON_PICK, shirt: 0x010203 });
    assert.equal(look.shirt, 0x010203, "shirt");
    assert.equal(look.woman, base.woman, "build");
    assert.equal(look.pants, base.pants, "trousers");
    assert.equal(look.hair, base.hair, "hair");
    assert.equal(look.hat, null, "no cap");
  });
});
