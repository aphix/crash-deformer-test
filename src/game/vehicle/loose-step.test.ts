import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Ground, setGround } from "../world/ground.ts";
import { stepLoose } from "./loose-step.ts";

/** A flat road at height `raise`, under everything. */
class RaisedRoad extends Ground {
  constructor(raise: number) {
    super();
    this.addPlane(raise, -1e7, 1e7, -1e7, 1e7, Infinity);
  }
}

/** A torn part thrown along the road at the speed a racer drops it, stepped for `seconds` on ground raised by `raise` m. */
function slide(raise: number, seconds: number): THREE.Vector3 {
  setGround(new RaisedRoad(raise));
  try {
    const p = { object: new THREE.Object3D(), velocity: new THREE.Vector3(30, 0, 0), angular: new THREE.Vector3(), radius: 0.4 };
    p.object.position.set(0, raise + 0.12, 0);
    const dt = 1 / 120;
    for (let t = 0; t < seconds; t += dt) stepLoose(p, dt, 0.12);
    return p.object.position.clone().sub(new THREE.Vector3(0, raise, 0));
  } finally {
    setGround(null);
  }
}

describe("given a torn part sliding along a road", () => {
  it("when the road is raised (a dam, a bridge, a crest), then the part slides, slows and stops exactly as it does on a road at ground level", () => {
    const low = slide(0, 6);
    const high = slide(18, 6);
    assert.ok(Math.abs(high.x - low.x) < 1e-9 && Math.abs(high.y - low.y) < 1e-9, `raised road: ${high.x.toFixed(2)} m along, level road: ${low.x.toFixed(2)} m`);
  });
});
