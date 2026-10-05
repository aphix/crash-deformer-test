import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { PREFABS, type PrefabId } from "../world/catalog.ts";
import { setGround } from "../world/ground.ts";
import { placeProps, propColliders, type PropCollider } from "../world/placements.ts";
import { makeWorld } from "../world/race-world.test-util.ts";
import { Track } from "../world/track.ts";
import { parseTrack } from "../world/track-schema.ts";
import { OFF_MENU, TRACKS } from "../world/tracks/index.ts";
import { WALL_PROBES } from "../contact/pair-contact.ts";
import { lowestY } from "./engine-race-field.ts";
import { frame, makeCar, worldOf } from "../vehicle/ground-probe.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";

/**
 * A prop touches a car only while the car's lowest point is under the prop's top (`RaceField.props`): the same rule for a
 * race and for Survival, for solid props (walls, palms, a dumpster) and knockable ones (cones, crates). Before it, props
 * ignored height, so a car flying over the Havana alley wall met it in mid-air.
 */

const COURSE_JSON = [...TRACKS, ...OFF_MENU];

/** The race stack headless with `id` loaded (Havana is off the race menu, so the lobby loads it), and every prop contact counted. */
function course(id: string) {
  const w = makeWorld();
  w.race.showLobby(id);
  const track = new Track(COURSE_JSON.find((j) => parseTrack(j).id === id)!);
  const placed = placeProps(track);
  const colliders = propColliders(placed);
  const hits: number[] = [];
  w.race.onWallHit = (i) => hits.push(i);
  const props = (car: DeformableCar): void => w.race["props"](car, 0, 1 / 120);
  return { w, colliders, placed, hits, props, top: (c: PropCollider) => placed[c.index]!.y + PREFABS[c.prefab].size[1] * placed[c.index]!.sy };
}

/** The collider of `prefab` whose nearest neighbour prop is farthest (a neighbour's own contact would answer for it). */
const pick = (colliders: readonly PropCollider[], prefab: PrefabId): PropCollider => {
  const gap = (c: PropCollider): number => Math.min(...colliders.filter((o) => o !== c).map((o) => Math.hypot(o.x - c.x, o.z - c.z) - o.r - c.r));
  return colliders.filter((c) => c.prefab === prefab).reduce((a, b) => (gap(b) > gap(a) ? b : a));
};

/** A car facing +z with its front-right wall probe 0.1 m off the middle of `c` (a circle has no normal at its middle), its lowest point at height `low` and `pitch` (rad, + nose down). */
function carOn(c: PropCollider, low: number, pitch = 0): DeformableCar {
  const car = makeCar("sedan");
  const [ox, oz] = WALL_PROBES[1]!;
  car.spawnFacing(c.x + 0.1 - ox, c.z - oz, 0, 8);
  car.group.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch);
  car.refreshBasis();
  car.group.position.y += low - lowestY(car);
  return car;
}

afterEach(() => setGround(null));

describe("props are height-aware", () => {
  const SOLIDS: [string, PrefabId][] = [["havana", "palm"], ["havana", "wall"], ["havana", "dumpster"]];
  const KNOCKS: [string, PrefabId][] = [["city", "crate"], ["city", "cone"]];

  for (const [id, prefab] of [...SOLIDS, ...KNOCKS]) {
    describe(`${id} ${prefab} (${PREFABS[prefab].body})`, () => {
      const hit = (low: number, pitch = 0) => {
        const k = course(id);
        const c = pick(k.colliders, prefab);
        const car = carOn(c, k.top(c) + low, pitch);
        const v = car.velocity.clone();
        k.props(car);
        return { k, c, car, v, touched: k.hits.length > 0 || k.w.race.propKnocked(c.index) };
      };

      it("a car 0.5 m above the top passes over it untouched", () => {
        const { car, v, touched } = hit(0.5);
        assert.equal(touched, false, "no contact");
        assertSameNumbers(car.velocity.toArray(), v.toArray(), "no push, no lost speed");
      });

      it("a car whose lowest point is 0.2 m under the top still hits it", () => {
        assert.equal(hit(-0.2).touched, true);
      });

      it("a car on the ground (its lowest point at the prop's foot) hits it, as it always did", () => {
        assert.equal(hit(-PREFABS[prefab].size[1]).touched, true);
      });

      it("the rotated hull counts, not the group origin: nose down, the origin 0.4 m over the top and the front underside corner 0.14 m under hits; level at that origin height it passes", () => {
        const tilted = hit(-0.14, 15 * (Math.PI / 180));
        const origin = tilted.car.group.position.y - tilted.k.top(tilted.c);
        assert.ok(origin > 0.4, `the origin is ${origin.toFixed(2)} m over the prop's top`);
        assert.equal(tilted.touched, true, "the corner is in it");
        assert.equal(hit(origin).touched, false, "level, the same origin height clears");
      });
    });
  }

  it("the lowest point of a level car is its ground point, of a nose-down car its front underside corner", () => {
    const car = makeCar("sedan");
    car.spawnFacing(0, 0, 0, 0);
    car.group.position.y = 3;
    car.refreshBasis();
    assert.ok(Math.abs(lowestY(car) - 3) < 1e-9);
    car.group.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3);
    assert.ok(Math.abs(lowestY(car) - (3 + 0.68 * Math.cos(0.3) - (0.68 * Math.cos(0.3) + 2.22 * Math.sin(0.3)))) < 1e-9);
  });
});

describe("a car flying over a prop on the Havana course", () => {
  const SPEED = 12;
  const TC = 0.6;
  /** The lowest point's planned height over the prop's top (m) at its middle, before the nose follows the path (up to 1 m of it is lost to the tail). */
  const fly = (prefab: PrefabId, clear: number) => {
    const k = course("havana");
    const c = pick(k.colliders, prefab);
    const top = k.top(c);
    const car = makeCar("sedan");
    // Along the prop's local x, 7.2 m out, a ballistic arc whose apex is over it; the right probe runs through its middle.
    const yaw = c.yaw + Math.PI / 2;
    const d = SPEED * TC;
    const lat = -WALL_PROBES[1]![0];
    car.spawnFacing(c.x - Math.sin(yaw) * d + Math.cos(yaw) * lat, c.z - Math.cos(yaw) * d - Math.sin(yaw) * lat, yaw, 0);
    const vy = 9.6 * TC;
    car.group.position.y = top + clear - (vy * TC - 4.8 * TC * TC);
    car.airborne = true;
    car.velocity.set(Math.sin(yaw) * SPEED, vy, Math.cos(yaw) * SPEED);
    const world = worldOf(car, (cc) => k.props(cc));
    const st = { acc: 0 };
    let clearest = Infinity;
    for (let n = 0; n < 72; n++) {
      frame(world, null, st);
      if (Math.hypot(car.group.position.x - c.x, car.group.position.z - c.z) < 2.5) clearest = Math.min(clearest, lowestY(car) - top);
    }
    const along = (car.group.position.x - c.x) * Math.sin(yaw) + (car.group.position.z - c.z) * Math.cos(yaw);
    return { hits: k.hits.length, clearest, along };
  };

  for (const prefab of ["wall", "palm"] as const) {
    it(`${prefab}: a car whose lowest point crosses over it takes no hit and flies on; one 3.5 m lower does hit`, () => {
      const over = fly(prefab, 2.5);
      assert.ok(over.clearest > 0.3, `the arc crosses ${over.clearest.toFixed(2)} m over the top, so the scenario is a clear pass`);
      assert.equal(over.hits, 0, "no contact in mid-air");
      assert.ok(over.along > 2, `flew on past it (${over.along.toFixed(1)} m beyond its middle)`);
      assert.ok(fly(prefab, -1).hits > 0, "the same launch, 3.5 m lower, is stopped by it: the count sees hits");
    });
  }
});
