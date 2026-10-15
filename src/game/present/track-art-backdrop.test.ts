import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { element, stubBrowser } from "../engine/engine-headless.test-util.ts";
import { TRACK_ID } from "../world/constants.ts";
import { placeProps } from "../world/placements.ts";
import { parseTrack } from "../world/track-schema.ts";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { TrackArt } from "./track-art.ts";

/** The mushroom cloud's canvas (px): the one canvas of this size the art paints. */
const CLOUD_CANVAS = { w: 1024, h: 640 };

/** A document that remembers each canvas made, and answers a flash's glare. */
function recordingDocument(t: { mock: { timers: { enable(options: { apis: ["setTimeout"] }): void } }; after(fn: () => void): void }) {
  stubBrowser();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const canvases: HTMLCanvasElement[] = [];
  const glare = { style: { cssText: "" }, remove() {}, animate: () => ({ cancel() {}, onfinish: null }) };
  const document = {
    createElement: (tag: string) => {
      if (tag === "div") return glare;
      const canvas = element();
      canvases.push(canvas);
      return canvas;
    },
  };
  Object.defineProperty(globalThis, "document", { value: document, configurable: true, writable: true });
  t.after(() => void Reflect.deleteProperty(globalThis, "document"));
  return { clouds: () => canvases.filter((c) => c.width === CLOUD_CANVAS.w && c.height === CLOUD_CANVAS.h).length };
}

const mallArt = (): TrackArt => {
  const track = new Track(TRACKS.find((json) => parseTrack(json).id === TRACK_ID.nationalMall)!);
  return new TrackArt(track, placeProps(track), { look() {} });
};
const cloudMeshes = (art: TrackArt): THREE.Object3D[] => art.group.children.filter((o) => o.name === "backdrop:mushroom-cloud");

describe("given the National Mall's secret mushroom cloud (a backdrop hidden until the Konami code)", () => {
  it("when the course's art is built, then no cloud canvas is painted and no cloud mesh is in the art", (t) => {
    const doc = recordingDocument(t);
    const art = mallArt();
    assert.equal(doc.clouds(), 0, "cloud canvases painted at load");
    assert.equal(cloudMeshes(art).length, 0, "cloud meshes in the art");
    art.dispose();
  });

  it("when the code is entered, then nothing is painted until the flash's peak, where the cloud is painted once and stands, and the flash painted nothing more", (t) => {
    const doc = recordingDocument(t);
    const art = mallArt();
    art.reveal({ appendChild: (node) => node });
    assert.equal(doc.clouds(), 0, "painted before the peak");
    t.mock.timers.tick(10_000);
    assert.equal(doc.clouds(), 1, "painted at the peak");
    const [cloud] = cloudMeshes(art) as THREE.Mesh[];
    assert.ok(cloud?.visible, "the cloud stands");
    const material = cloud!.material as THREE.MeshBasicMaterial;
    assert.ok(material.transparent && material.side === THREE.DoubleSide && material.forceSinglePass, "a see-through double-sided panel takes one pass, not three's two");
    art.dispose();
  });

  it("when the race restarts after the code, then the cloud is gone from the art and the next code paints it again; a flash stopped before its peak paints nothing", (t) => {
    const doc = recordingDocument(t);
    const art = mallArt();
    art.reveal({ appendChild: (node) => node });
    art.resetSecret();
    t.mock.timers.tick(10_000);
    assert.equal(doc.clouds(), 0, "a stopped flash never reaches its peak");
    art.reveal({ appendChild: (node) => node });
    t.mock.timers.tick(10_000);
    assert.equal(cloudMeshes(art).length, 1, "stands after the second code");
    art.resetSecret();
    assert.equal(cloudMeshes(art).length, 0, "gone again after the restart");
    art.reveal({ appendChild: (node) => node });
    t.mock.timers.tick(10_000);
    assert.equal(doc.clouds(), 2, "painted again for the third code");
    art.dispose();
  });
});
