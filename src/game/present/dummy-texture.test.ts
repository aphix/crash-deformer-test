import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FACE_ROWS, faceMap } from "./dummy-texture.ts";

describe("given the dummy face atlas", () => {
  it("when a face row is read, then the eyes are darker than the skin and the mouth is not the same colour as the forehead", () => {
    const map = faceMap();
    const px = map.image.data as Uint8Array;
    const at = (x: number, y: number) => px[(y * 128 + x) * 4]!;
    assert.equal(map.image.height, 128 * FACE_ROWS);
    assert.ok(at(64, 120) > 200, "forehead is skin");
    assert.ok(at(45, 78) < 80, "an eye is dark");
    assert.ok(at(64, 28) < at(64, 120) - 20, "the mouth is not bare skin");
  });
});
