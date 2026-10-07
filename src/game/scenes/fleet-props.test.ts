import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fleetProp, SCENE_IDS, type SceneId } from "./scene-id.ts";

/** What the user's three choices put on screen in `scene`. */
const up = (scene: SceneId, user: boolean) => ({ barrier: fleetProp(scene, "barrier", user), balls: fleetProp(scene, "balls", user), ramps: fleetProp(scene, "ramps", user) });

describe("given the user's choices of fleet props (wall, balls, ramps) and the props each scene shows", () => {
  it("when the range and then the fleet are shown, then the range puts its wall up whatever the user chose, and the fleet after it shows the user's choice", () => {
    for (const user of [false, true]) {
      assert.equal(up("range", user).barrier, true);
      assert.equal(up("fleet", user).barrier, user, `fleet wall after a range visit, user ${user}`);
    }
  });

  it("when the user has chosen all three props or none, then the range shows the wall only (balls and ramps away) and the fleet after it shows the user's choice", () => {
    assert.deepEqual(up("range", true), { barrier: true, balls: false, ramps: false });
    assert.deepEqual(up("fleet", true), { barrier: true, balls: true, ramps: true });
    assert.deepEqual(up("fleet", false), { barrier: false, balls: false, ramps: false });
  });

  it("when the user has chosen all three props, then the derby, the race, Survival, the Lab and the rigs show none of them", () => {
    for (const scene of ["derby", "race", "survival", "lab", "press", "pistons", "doors", "corkscrew", "stack"] as const) {
      assert.deepEqual(up(scene, true), { barrier: false, balls: false, ramps: false }, scene);
    }
  });

  it("when the user's choices are flipped in every scene, then the fleet is the only scene whose props follow the user's choice", () => {
    for (const scene of SCENE_IDS) {
      const followsUser = JSON.stringify(up(scene, true)) !== JSON.stringify(up(scene, false));
      assert.equal(followsUser, scene === "fleet", scene);
    }
  });
});
