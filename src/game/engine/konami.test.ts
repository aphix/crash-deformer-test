import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KONAMI, KonamiCode } from "./konami.ts";

const typed = (k: KonamiCode, codes: readonly string[]): boolean[] => codes.map((c) => k.press(c));

describe("given the Konami code watcher (up up down down left right left right B A B A)", () => {
  it("when the code is typed, then only its last key reports it", () => {
    const hits = typed(new KonamiCode(), KONAMI);
    assert.equal(hits.indexOf(true), KONAMI.length - 1);
    assert.equal(hits.filter(Boolean).length, 1);
  });

  it("when stray keys and an extra up come first, then the code still counts; a wrong key inside it spoils that run", () => {
    assert.equal(typed(new KonamiCode(), ["KeyW", "ArrowUp", ...KONAMI]).at(-1), true);
    assert.equal(typed(new KonamiCode(), [...KONAMI.slice(0, 6), "KeyX", ...KONAMI.slice(6)]).includes(true), false);
  });

  it("when the classic code (one B A) is typed, then it is not this one", () => {
    assert.equal(typed(new KonamiCode(), KONAMI.slice(0, 10)).includes(true), false);
  });

  it("when the code is typed twice, then each completes it once", () => {
    const hits = typed(new KonamiCode(), [...KONAMI, ...KONAMI]);
    assert.equal(hits.filter(Boolean).length, 2);
  });
});
