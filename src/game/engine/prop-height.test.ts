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
import { lowestY, propContact } from "../contact/prop-contact.ts";
import { frame, makeCar, worldOf } from "../vehicle/ground-probe.test-util.ts";
import type { DeformableCar } from "../vehicle/car.ts";
import { assertSameNumbers } from "../vehicle/test-support.ts";

/**
 * A prop touches a car only while the car's lowest point is under the prop's top (`propContact`): the same rule for a
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
  const props = (car: DeformableCar): void => propContact(car, 0, w.race["colliders"], w.race["knocked"], w.race["propHits"], 1 / 120);
  // A prop's top is its highest piece's (a palm's fronds), its foot where it stands.
  const top = (c: PropCollider): number => Math.max(...colliders.filter((o) => o.index === c.index).map((o) => o.top));
  return { w, colliders, placed, hits, props, top, foot: (c: PropCollider) => placed[c.index]!.y };
}

/** The ground piece (the lowest) of the prop of `prefab` whose nearest neighbour prop is farthest (a neighbour's own contact would answer for it). */
const pick = (colliders: readonly PropCollider[], prefab: PrefabId): PropCollider => {
  const gap = (c: PropCollider): number => Math.min(...colliders.filter((o) => o.index !== c.index).map((o) => Math.hypot(o.x - c.x, o.z - c.z) - o.r - c.r));
  const ground = (c: PropCollider): boolean => colliders.every((o) => o.index !== c.index || o.base >= c.base);
  return colliders.filter((c) => c.prefab === prefab && ground(c)).reduce((a, b) => (gap(b) > gap(a) ? b : a));
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

describe("given a prop on a course, solid (palm, wall, dumpster) or knockable (crate, cone), and a car reaching it", () => {
  const SOLIDS: [string, PrefabId][] = [["havana", "palm"], ["havana", "wall"], ["havana", "dumpster"]];
  const KNOCKS: [string, PrefabId][] = [["city", "crate"], ["city", "cone"]];

  for (const [id, prefab] of [...SOLIDS, ...KNOCKS]) {
    describe(`given a ${prefab} (${PREFABS[prefab].body}) on the ${id} course and a sedan at 8 m/s with its front-right corner aimed at the prop's middle`, () => {
      /** A sedan whose lowest point is `low` m over the prop's top (or over its foot, `fromFoot`). */
      const hit = (low: number, pitch = 0, fromFoot = false) => {
        const k = course(id);
        const c = pick(k.colliders, prefab);
        const car = carOn(c, (fromFoot ? k.foot(c) : k.top(c)) + low, pitch);
        const v = car.velocity.clone();
        k.props(car);
        return { k, c, car, v, touched: k.hits.length > 0 || k.w.race.propKnocked(c.index) };
      };

      it("when its lowest point is 0.5 m above the prop's top, then it passes over untouched, with no push and no lost speed", () => {
        const { car, v, touched } = hit(0.5);
        assert.equal(touched, false, "no contact");
        assertSameNumbers(car.velocity.toArray(), v.toArray(), "no push, no lost speed");
      });

      it("when its lowest point is 0.2 m under the prop's top, then it still hits the prop", () => {
        assert.equal(hit(-0.2).touched, true);
      });

      it("when it is on the ground (its lowest point at the prop's foot), then it hits the prop", () => {
        assert.equal(hit(0, 0, true).touched, true);
      });

      it("when it is nose down 15° with its centre more than 0.4 m over the top but its front underside corner 0.14 m under, then it hits the prop, while a level car at that centre height passes", () => {
        const tilted = hit(-0.14, 15 * (Math.PI / 180));
        const origin = tilted.car.group.position.y - tilted.k.top(tilted.c);
        assert.ok(origin > 0.4, `the origin is ${origin.toFixed(2)} m over the prop's top`);
        assert.equal(tilted.touched, true, "the corner is in it");
        assert.equal(hit(origin).touched, false, "level, the same origin height clears");
      });
    });
  }

  describe("given a sedan with its centre 3 m above flat ground", () => {
    it("when it is level, then its lowest point is its ground point, and when it is nose down 0.3 rad, then its lowest point is its front underside corner", () => {
      const car = makeCar("sedan");
      car.spawnFacing(0, 0, 0, 0);
      car.group.position.y = 3;
      car.refreshBasis();
      assert.ok(Math.abs(lowestY(car) - 3) < 1e-9);
      car.group.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.3);
      assert.ok(Math.abs(lowestY(car) - (3 + 0.68 * Math.cos(0.3) - (0.68 * Math.cos(0.3) + 2.22 * Math.sin(0.3)))) < 1e-9);
    });
  });
});

describe("given a sedan flying a ballistic arc at 12 m/s over a wall or palm on the Havana course", () => {
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
    it(`when its lowest point is planned to cross 2.5 m over the ${prefab}, then it takes no hit and flies on past it, while the same launch 3.5 m lower does hit`, () => {
      const over = fly(prefab, 2.5);
      assert.ok(over.clearest > 0.3, `the arc crosses ${over.clearest.toFixed(2)} m over the top, so the scenario is a clear pass`);
      assert.equal(over.hits, 0, "no contact in mid-air");
      assert.ok(over.along > 2, `flew on past it (${over.along.toFixed(1)} m beyond its middle)`);
      assert.ok(fly(prefab, -1).hits > 0, "the same launch, 3.5 m lower, is stopped by it: the count sees hits");
    });
  }
});
