import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fleetProp, SCENE_IDS, type SceneId } from "./scene-id.ts";

/** What the user's three choices put on screen in `scene`. */
const up = (scene: SceneId, user: boolean) => ({ barrier: fleetProp(scene, "barrier", user), balls: fleetProp(scene, "balls", user), ramps: fleetProp(scene, "ramps", user) });

describe("the user's fleet props and the scenes' own", () => {
  it("good: the range puts its wall up whatever the user chose, and the fleet after it shows the user's choice", () => {
    for (const user of [false, true]) {
      assert.equal(up("range", user).barrier, true);
      assert.equal(up("fleet", user).barrier, user, `fleet wall after a range visit, user ${user}`);
    }
  });

  it("good: the range puts the balls and ramps away, and the fleet after it shows the user's", () => {
    assert.deepEqual(up("range", true), { barrier: true, balls: false, ramps: false });
    assert.deepEqual(up("fleet", true), { barrier: true, balls: true, ramps: true });
    assert.deepEqual(up("fleet", false), { barrier: false, balls: false, ramps: false });
  });

  it("good: the derby, the race, Survival and the rigs show none of the fleet's props, and the fleet gets the user's back", () => {
    for (const scene of ["derby", "race", "survival", "press", "pistons", "doors", "corkscrew", "stack"] as const) {
      assert.deepEqual(up(scene, true), { barrier: false, balls: false, ramps: false }, scene);
    }
  });

  it("good: the fleet is the only scene that shows the user's props as chosen", () => {
    for (const scene of SCENE_IDS) {
      const followsUser = JSON.stringify(up(scene, true)) !== JSON.stringify(up(scene, false));
      assert.equal(followsUser, scene === "fleet", scene);
    }
  });
});
