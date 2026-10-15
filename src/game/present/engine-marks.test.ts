import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as THREE from "three";
import { SkidMarks, type MarkRenderer } from "./engine-marks.ts";

/** Wall seconds a frame adds to the fade's clock: far under the 0.6 s fade period over a test's few frames. */
const WALL_DT = 0.001;
const FADE_DUE_DT = 1;
const MAP_SIZE = 64;

/** A renderer that counts the `render()` calls into the mark map and the stamp quads each one draws. */
function countingRenderer(marks: SkidMarks) {
  const stamp = marks.scene.children[0];
  if (!(stamp instanceof THREE.Mesh)) throw new Error("the mark scene's first child is the stamp mesh");
  const drawn = { renders: 0, quads: 0 };
  const renderer: MarkRenderer = {
    autoClear: true,
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    getClearColor: (target) => target,
    getClearAlpha: () => 1,
    setClearColor: () => {},
    clear: () => {},
    render: () => {
      drawn.renders++;
      if (stamp.visible) drawn.quads += stamp.geometry.drawRange.count / 6;
    },
  };
  return { renderer, drawn };
}

/** A map with its first (wipe) flush done, so what follows is steady-state frames. */
function settledMarks() {
  const marks = new SkidMarks(4);
  marks.setResolution(MAP_SIZE);
  const { renderer, drawn } = countingRenderer(marks);
  marks.flush(renderer, WALL_DT);
  return { marks, renderer, drawn };
}

function layStamp(marks: SkidMarks): void {
  marks["queue"](0, 0, 1, 0, 0.24, 0, 1);
}

describe("given the mark map with a wheel laying one stamp every frame", () => {
  it("when 60 frames queue and flush, then the map is drawn once per two frames and every stamp is in a draw", () => {
    const { marks, renderer, drawn } = settledMarks();
    for (let frame = 0; frame < 60; frame++) {
      layStamp(marks);
      marks.flush(renderer, WALL_DT);
    }
    assert.equal(drawn.renders, 30, "render() calls into the mark map");
    assert.equal(drawn.quads, 60, "stamp quads drawn: none dropped, none drawn twice");
  });

  it("when the first stamp is queued, then it is drawn by the next frame's flush", () => {
    const { marks, renderer, drawn } = settledMarks();
    layStamp(marks);
    marks.flush(renderer, WALL_DT);
    assert.equal(drawn.renders, 0, "the first frame's stamp waits for the second");
    marks.flush(renderer, WALL_DT);
    assert.equal(drawn.quads, 1, "the second flush draws it");
  });
});

describe("given a stamp waiting for the next frame's draw", () => {
  it("when the fade comes due that frame, then the stamp goes in with the fade, not a frame later", () => {
    const { marks, renderer, drawn } = settledMarks();
    layStamp(marks);
    marks.flush(renderer, FADE_DUE_DT);
    assert.deepEqual(drawn, { renders: 1, quads: 1 });
  });

  it("when the map is cleared, then the waiting stamp is dropped with the old marks", () => {
    const { marks, renderer, drawn } = settledMarks();
    layStamp(marks);
    marks.flush(renderer, WALL_DT);
    marks.clear();
    marks.flush(renderer, WALL_DT);
    marks.flush(renderer, WALL_DT);
    assert.deepEqual(drawn, { renders: 0, quads: 0 });
  });
});
