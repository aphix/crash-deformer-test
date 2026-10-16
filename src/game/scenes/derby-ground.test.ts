import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CAR_HALF } from "../vehicle/car-mesh.ts";
import { plateauHeight } from "../world/terrain.ts";
import { MAX_CARS, layoutDerby } from "./fleet.ts";
import { DERBY_ARENA } from "./constants.ts";
import { DERBY_BOXES, DERBY_FREE_PROPS, DERBY_PLATEAUS, DERBY_PROP, DERBY_RAMPS, DERBY_TABLE_TOP, DerbyGround, SPAWN_CLEARANCE, type DerbyBox } from "./derby-ground.ts";
import { DERBY_RADIUS } from "./derby-arena.ts";

/**
 * The arena's ground is laid out so that a full field spawns on open level floor, and so that what is a prism stands on level ground clear
 * of every rise (a flat prism beside a heightfield ramp answers a false wall: measured, every car dies at the junction).
 */
const ground = new DerbyGround();
const props = DERBY_BOXES.filter((box) => box.kind !== DERBY_PROP.wall);
const { radius, gridHalf, spawnInset } = DERBY_ARENA;
/** How far around a prop's box the floor must be level too (m): a car's tyre reaches that far over the box's face. */
const LEVEL_MARGIN = 1;
const SAMPLE_STEP = 0.5;
/** The foot of a rise is a parabola that dies out over its last metres: under this (m) the floor counts as level. */
const LEVEL = 0.01;

/** The design (`local://pasted-image` and the plan's table): the four ramps' heights and long-run lengths, the table-top and the setbacks. */
const DESIGN_RAMPS = [
  { name: "north", height: 2.8, length: 14 },
  { name: "east", height: 2.5, length: 13 },
  { name: "south", height: 3, length: 15 },
  { name: "west", height: 2.5, length: 13 },
];
const DESIGN_TABLE = { height: 2.2, width: 12 };
const DESIGN_CREST_HALF_DEPTH = 1;
/** Design: every flat top stands at least this far (m) inside the wall. */
const DESIGN_SETBACK = 4;
/** Design: the bowl's middle, free of rises (m from the centre). */
const MIDDLE_RADIUS = 8;
/** Design: a rise is a feature over this height (m); features stand this far (m) apart. */
const FEATURE_HEIGHT = 0.3;
const FEATURE_GAP = 3;
/** Read a ramp's long run from heights this far (m) in from either end of it, where its plane is straight. */
const RUN_PROBE_INSET = 3;
/** How far (m) from a ramp's crest the wall-side and the middle-side heights are read. */
const RAMP_PROBE = 4;
/** A crest rounds over `round` m, so its peak may sit this far (m) under the design height. */
const PEAK_SLACK = 0.1;
/** Table-top edge: within this (m) of its design height at the edge line; further out than the rounding, it has fallen by at least this much. */
const EDGE_DROP_MAX = 0.15;
const OUTSIDE_DROP_MIN = 0.2;
const HEIGHT_TOLERANCE = 0.001;

function localOf(box: { x: number; z: number; yaw: number }, x: number, z: number): { across: number; along: number } {
  const dx = x - box.x;
  const dz = z - box.z;
  return { across: dx * Math.cos(box.yaw) - dz * Math.sin(box.yaw), along: dx * Math.sin(box.yaw) + dz * Math.cos(box.yaw) };
}

function isWithin(box: DerbyBox, x: number, z: number, margin: number): boolean {
  const local = localOf(box, x, z);
  return Math.abs(local.across) <= box.hx + margin && Math.abs(local.along) <= box.hz + margin;
}

function hullCorners(x: number, z: number, yaw: number): [number, number][] {
  const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
  const forward = { x: Math.sin(yaw), z: Math.cos(yaw) };
  return [-1, 1].flatMap((sideways) => [-1, 1].map((ahead): [number, number] => [x + right.x * sideways * CAR_HALF.x + forward.x * ahead * CAR_HALF.z, z + right.z * sideways * CAR_HALF.x + forward.z * ahead * CAR_HALF.z]));
}

function rampNamed(name: string) {
  const found = DERBY_RAMPS.find((entry) => entry.name === name);
  assert.ok(found, `no ramp named ${name}`);
  return found;
}

/** The point `along` m from a ramp's crest centre toward the wall (negative: toward the middle), past the crest's own depth. */
function onAxis(name: string, along: number): { x: number; z: number } {
  const { plateau, toward } = rampNamed(name);
  const reach = along + Math.sign(along) * DESIGN_CREST_HALF_DEPTH;
  return { x: plateau.x + toward.x * reach, z: plateau.z + toward.z * reach };
}

describe("given the arena's ground and the full field's spawn ring", () => {
  it("when fields of every size are laid out, then every hull corner is inside the wall, on level floor at height 0 and clear of every prop", () => {
    for (let count = 1; count <= MAX_CARS; count++) {
      for (const [slotIndex, slot] of layoutDerby(count, DERBY_RADIUS, () => 0.37, DERBY_FREE_PROPS).entries()) {
        for (const [x, z] of hullCorners(slot.x, slot.z, slot.yaw)) {
          const label = `${count} cars, slot ${slotIndex} corner (${x.toFixed(1)}, ${z.toFixed(1)})`;
          assert.ok(Math.hypot(x, z) < radius, `${label} is in the wall`);
          assert.ok(ground.heightAt(x, z) < LEVEL, `${label} is not on level floor`);
          for (const prop of props) assert.ok(!isWithin(prop, x, z, SPAWN_CLEARANCE), `${label} is within ${SPAWN_CLEARANCE} m of a ${prop.kind}`);
        }
      }
    }
  });

  it("when fields of every size are laid out at every start bearing, then no car's line to the centre comes within its half length of a free-standing prop, and 32 cars stand over 4 m apart", () => {
    for (let count = 1; count <= MAX_CARS; count++) {
      for (let spin = 0; spin < 1; spin += 0.05) {
        const slots = layoutDerby(count, DERBY_RADIUS, () => spin, DERBY_FREE_PROPS);
        for (const [slotIndex, slot] of slots.entries()) {
          for (let t = 0; t <= 1; t += 0.01) {
            const x = slot.x * t;
            const z = slot.z * t;
            for (const [propIndex, prop] of DERBY_FREE_PROPS.entries()) {
              const local = localOf(prop, x, z);
              const gap = Math.hypot(Math.max(0, Math.abs(local.across) - prop.hx), Math.max(0, Math.abs(local.along) - prop.hz));
              assert.ok(gap >= CAR_HALF.z, `${count} cars at spin ${spin.toFixed(2)}: slot ${slotIndex} heads at free prop ${propIndex} (${gap.toFixed(2)} m)`);
            }
          }
        }
        if (count === MAX_CARS) {
          for (const [i, a] of slots.entries()) for (const b of slots.slice(i + 1)) assert.ok(Math.hypot(a.x - b.x, a.z - b.z) > 4, "two of 32 cars stand within 4 m");
        }
      }
    }
  });

  it("when fields of every size are laid out at every start bearing, then no hull corner of any slot stands on a ramp", () => {
    for (let count = 1; count <= MAX_CARS; count++) {
      for (let spin = 0; spin < 1; spin += 0.05) {
        for (const [slotIndex, slot] of layoutDerby(count, DERBY_RADIUS, () => spin, DERBY_FREE_PROPS).entries()) {
          for (const [x, z] of hullCorners(slot.x, slot.z, slot.yaw)) {
            for (const entry of DERBY_RAMPS) {
              assert.ok(plateauHeight(entry.plateau, x, z) < LEVEL, `${count} cars at spin ${spin.toFixed(2)}: slot ${slotIndex} stands on the ${entry.name} ramp at (${x.toFixed(1)}, ${z.toFixed(1)})`);
            }
          }
        }
      }
    }
  });

  it("when the rises are read on the grid, then none but the ramps reaches the ring where cars spawn, a grid cell's reach included", () => {
    // The ground reads its nodes bilinearly: a rise node raises the floor up to a cell (√2 m) beyond it.
    const innerEdgeOfSpawns = radius - spawnInset - CAR_HALF.z - Math.SQRT2;
    const nodes = 2 * gridHalf + 1;
    for (let j = 0; j < nodes; j++) {
      for (let i = 0; i < nodes; i++) {
        const x = i - gridHalf;
        const z = j - gridHalf;
        const onRamp = DERBY_RAMPS.some((entry) => plateauHeight(entry.plateau, x, z) > 0);
        if (!onRamp && ground.heights[j * nodes + i]! > LEVEL) assert.ok(Math.hypot(x, z) <= innerEdgeOfSpawns, `a rise at (${x}, ${z}) is in the spawn ring`);
      }
    }
  });
});

describe("given the design's rises", () => {
  const tableHalf = DESIGN_TABLE.width / 2;
  const tableReach = tableHalf + DERBY_TABLE_TOP.round;
  const tableCases = [
    { label: "its centre", dx: 0, dz: 0, atLeast: DESIGN_TABLE.height - HEIGHT_TOLERANCE, atMost: DESIGN_TABLE.height + HEIGHT_TOLERANCE },
    { label: "its east edge", dx: tableHalf, dz: 0, atLeast: DESIGN_TABLE.height - EDGE_DROP_MAX, atMost: DESIGN_TABLE.height + HEIGHT_TOLERANCE },
    { label: "its west edge", dx: -tableHalf, dz: 0, atLeast: DESIGN_TABLE.height - EDGE_DROP_MAX, atMost: DESIGN_TABLE.height + HEIGHT_TOLERANCE },
    { label: "its north edge", dx: 0, dz: tableHalf, atLeast: DESIGN_TABLE.height - EDGE_DROP_MAX, atMost: DESIGN_TABLE.height + HEIGHT_TOLERANCE },
    { label: "its south edge", dx: 0, dz: -tableHalf, atLeast: DESIGN_TABLE.height - EDGE_DROP_MAX, atMost: DESIGN_TABLE.height + HEIGHT_TOLERANCE },
    { label: "a crest's rounding east of its top", dx: tableReach, dz: 0, atLeast: 0, atMost: DESIGN_TABLE.height - OUTSIDE_DROP_MIN },
    { label: "a crest's rounding west of its top", dx: -tableReach, dz: 0, atLeast: 0, atMost: DESIGN_TABLE.height - OUTSIDE_DROP_MIN },
    { label: "a crest's rounding north of its top", dx: 0, dz: tableReach, atLeast: 0, atMost: DESIGN_TABLE.height - OUTSIDE_DROP_MIN },
    { label: "a crest's rounding south of its top", dx: 0, dz: -tableReach, atLeast: 0, atMost: DESIGN_TABLE.height - OUTSIDE_DROP_MIN },
  ];
  for (const { label, dx, dz, atLeast, atMost } of tableCases) {
    it(`when the table-top is read from the ground at ${label}, then it is a 12 m wide top at 2.2 m`, () => {
      const height = ground.heightAt(DERBY_TABLE_TOP.x + dx, DERBY_TABLE_TOP.z + dz, 0);
      assert.ok(height >= atLeast, `${height} is under ${atLeast}`);
      assert.ok(height <= atMost, `${height} is over ${atMost}`);
    });
  }

  for (const design of DESIGN_RAMPS) {
    describe(`the ${design.name} ramp`, () => {
      it("when its crest is read from the ground, then its deck reaches the design height and no more", () => {
        const { plateau, toward } = rampNamed(design.name);
        let peak = 0;
        for (let along = -DESIGN_CREST_HALF_DEPTH; along <= DESIGN_CREST_HALF_DEPTH; along += SAMPLE_STEP / 2) {
          peak = Math.max(peak, ground.heightAt(plateau.x + toward.x * along, plateau.z + toward.z * along, 0));
        }
        assert.ok(peak >= design.height - PEAK_SLACK, `the deck peaks at ${peak}`);
        assert.ok(peak <= design.height + HEIGHT_TOLERANCE, `the deck peaks at ${peak}`);
      });

      it("when its long run is read from the ground by its slope, then it is the design length", () => {
        const nearPoint = onAxis(design.name, -RUN_PROBE_INSET);
        const farPoint = onAxis(design.name, -(design.length - RUN_PROBE_INSET));
        const near = ground.heightAt(nearPoint.x, nearPoint.z, 0);
        const far = ground.heightAt(farPoint.x, farPoint.z, 0);
        const run = (design.height * (design.length - 2 * RUN_PROBE_INSET)) / (near - far);
        assert.ok(Math.abs(run - design.length) < 0.1, `the long run is ${run.toFixed(2)} m`);
      });

      it("when the floor is read either side of its crest, then it rises toward the wall: level beyond the lip, climbing on the middle side, the deck farther out than the foot", () => {
        const { plateau, toward } = rampNamed(design.name);
        const wallSide = onAxis(design.name, RAMP_PROBE);
        const middleSide = onAxis(design.name, -RAMP_PROBE);
        const foot = { x: plateau.x - toward.x * (design.length + DESIGN_CREST_HALF_DEPTH), z: plateau.z - toward.z * (design.length + DESIGN_CREST_HALF_DEPTH) };
        assert.ok(ground.heightAt(wallSide.x, wallSide.z, 0) < LEVEL, "the wall side of the crest is not level");
        assert.ok(ground.heightAt(middleSide.x, middleSide.z, 0) > design.height / 2, "the middle side of the crest is not climbing");
        assert.ok(Math.hypot(plateau.x, plateau.z) > Math.hypot(foot.x, foot.z), "the foot is nearer the wall than the deck");
      });
    });
  }

  it("when every flat top is read, then each corner of it stands at least 4 m inside the wall", () => {
    for (const [index, p] of DERBY_PLATEAUS.entries()) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const reach = Math.hypot(p.x + sx * p.halfX, p.z + sz * p.halfZ);
          assert.ok(reach <= radius - DESIGN_SETBACK, `rise ${index}: a corner of its top is ${(radius - reach).toFixed(2)} m from the wall`);
        }
      }
    }
  });

  it("when the middle of the bowl is read, then no ramp, pit or scrap rise lifts it over a feature's height", () => {
    const rises = DERBY_PLATEAUS.filter((p) => p !== DERBY_TABLE_TOP);
    for (let z = -MIDDLE_RADIUS; z <= MIDDLE_RADIUS; z += SAMPLE_STEP) {
      for (let x = -MIDDLE_RADIUS; x <= MIDDLE_RADIUS; x += SAMPLE_STEP) {
        if (Math.hypot(x, z) >= MIDDLE_RADIUS) continue;
        for (const [index, p] of rises.entries()) assert.ok(plateauHeight(p, x, z) <= FEATURE_HEIGHT, `rise ${index} lifts the middle at (${x}, ${z})`);
      }
    }
  });

  it("when every pair of rises is read, then their parts over a feature's height stand 3 m apart", () => {
    const parts = DERBY_PLATEAUS.map((p) => {
      const cells: [number, number][] = [];
      for (let z = -gridHalf; z <= gridHalf; z += SAMPLE_STEP) for (let x = -gridHalf; x <= gridHalf; x += SAMPLE_STEP) if (plateauHeight(p, x, z) > FEATURE_HEIGHT) cells.push([x, z]);
      return cells;
    });
    for (const [i, a] of parts.entries()) {
      for (const [j, b] of parts.entries()) {
        if (j <= i) continue;
        let nearest = Infinity;
        for (const [ax, az] of a) for (const [bx, bz] of b) nearest = Math.min(nearest, Math.hypot(ax - bx, az - bz));
        assert.ok(nearest >= FEATURE_GAP, `rises ${i} and ${j} stand ${nearest.toFixed(2)} m apart`);
      }
    }
  });
});

describe("given each prop of the arena", () => {
  it("when the floor under and around its box is read, then it is level, so the prop stands on flat ground and never beside a ramp", () => {
    for (const prop of props) {
      const reach = Math.hypot(prop.hx, prop.hz) + LEVEL_MARGIN;
      const heights: number[] = [];
      for (let x = prop.x - reach; x <= prop.x + reach; x += SAMPLE_STEP) {
        for (let z = prop.z - reach; z <= prop.z + reach; z += SAMPLE_STEP) {
          if (isWithin(prop, x, z, LEVEL_MARGIN)) heights.push(ground.heightAt(x, z, 0));
        }
      }
      assert.ok(Math.max(...heights) - Math.min(...heights) < LEVEL, `the ${prop.kind} at (${prop.x}, ${prop.z}) has a rise within ${LEVEL_MARGIN} m of it`);
    }
  });

  const heightCases = [
    { kind: DERBY_PROP.tyres, height: 1.5 },
    { kind: DERBY_PROP.tyres, height: 2 },
    { kind: DERBY_PROP.container, height: 2.4 },
    { kind: DERBY_PROP.container, height: 1.8 },
  ];
  for (const { kind, height } of heightCases) {
    it(`when the ${kind} boxes are read, then one stands ${height} m high`, () => {
      assert.ok(DERBY_BOXES.some((box) => box.kind === kind && box.height === height));
    });
  }

  it("when the walls are read, then the ring is closed: every wall piece overlaps the next one's face", () => {
    const wall = DERBY_BOXES.filter((box) => box.kind === DERBY_PROP.wall);
    assert.equal(wall.length, DERBY_ARENA.wallPieces);
    for (const [index, piece] of wall.entries()) {
      const next = wall[(index + 1) % wall.length]!;
      const along = piece.hz + 0.01;
      const end = { x: piece.x + Math.sin(piece.yaw) * along, z: piece.z + Math.cos(piece.yaw) * along };
      assert.ok(isWithin(next, end.x, end.z, 0), `wall piece ${index} ends in a gap`);
    }
  });
});
