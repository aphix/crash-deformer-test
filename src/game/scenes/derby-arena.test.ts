import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { PR_BASE, PR_HX, PR_HZ, PR_TOP, PR_X, PR_YAW, PR_Z } from "../world/prism.ts";
import { P_STRIDE, PRISM, Q_KIND, Q_STRIDE } from "../world/surfaces.ts";
import { DERBY_ARENA } from "./constants.ts";
import { makeDerbyArena } from "./derby-arena.ts";
import { DERBY_BOXES, DERBY_PROP, DERBY_RAMPS, DERBY_TABLE_TOP, DerbyGround } from "./derby-ground.ts";

/** Metres (and radians) two drawn numbers may differ by and still be one: the instance matrices are Float32. */
const TOLERANCE = 1e-4;
/** The wall's inner face may sit this far (m) off `DERBY_ARENA.radius`. */
const WALL_FACE_TOLERANCE = 0.01;
/** A wall box's long axis is tangent: its dot with the radial direction stays under this. */
const TANGENT_LIMIT = 0.25;
/** Draw calls the arena may make: the old arena's ten plus 20 % (the glass wall and the ramp decks). */
const DRAW_CALL_LIMIT = 12;
/** Side (texels) of the floor's dirt texture: one square map over the whole arena. */
const DIRT_TEXTURE_SIZE = 1024;
/** A floor vertex this close (m) to a box's edge counts as under the box. */
const EDGE_REACH = 1e-6;
/** At least this share of the floor's vertices must be compared: a test that skipped them all would prove nothing. */
const LEAST_COMPARED_SHARE = 0.9;

type Placement = { x: number; z: number; base: number; yaw: number; hx: number; hz: number; height: number };

const ground = new DerbyGround();
const arena = makeDerbyArena(ground);

function sameYawModuloHalfTurn(first: number, second: number): boolean {
  return Math.abs(Math.sin(first - second)) < TOLERANCE;
}

function isSameSolid(first: Placement, second: Placement): boolean {
  return (
    Math.abs(first.x - second.x) < TOLERANCE &&
    Math.abs(first.z - second.z) < TOLERANCE &&
    Math.abs(first.base - second.base) < TOLERANCE &&
    sameYawModuloHalfTurn(first.yaw, second.yaw) &&
    Math.abs(first.hx - second.hx) < TOLERANCE &&
    Math.abs(first.hz - second.hz) < TOLERANCE &&
    Math.abs(first.height - second.height) < TOLERANCE
  );
}

const listedBoxes: readonly (Placement & { kind: string })[] = DERBY_BOXES.map(({ kind, x, z, yaw, hx, hz, height }) => ({ kind, x, z, base: 0, yaw, hx, hz, height }));

/** What is drawn of a listed box: the wall's concrete foot (the glass above it is its own draw), every other box whole. */
const drawnBoxes = listedBoxes.map((box) => (box.kind === DERBY_PROP.wall ? { ...box, height: DERBY_ARENA.concreteHeight } : box));

/** Every instance of a drawn box mesh, read back from its matrix and its box geometry. */
function placementsOf(mesh: THREE.InstancedMesh): Placement[] {
  assert.ok(mesh.geometry instanceof THREE.BoxGeometry, `${mesh.name} is drawn from a box`);
  const { width, height, depth } = mesh.geometry.parameters;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  return Array.from({ length: mesh.count }, (_unused, index) => {
    mesh.getMatrixAt(index, matrix);
    matrix.decompose(position, quaternion, scale);
    const instanceHeight = height * scale.y;
    return {
      x: position.x,
      z: position.z,
      base: position.y - instanceHeight / 2,
      yaw: 2 * Math.atan2(quaternion.y, quaternion.w),
      hx: (width * scale.x) / 2,
      hz: (depth * scale.z) / 2,
      height: instanceHeight,
    };
  });
}

function boxMesh(kind: string): THREE.InstancedMesh {
  const found = arena.children.find((child) => child instanceof THREE.InstancedMesh && child.name === kind);
  assert.ok(found instanceof THREE.InstancedMesh, `the arena draws ${kind} boxes`);
  return found;
}

/** The prisms of the ground, as placements (the grid patch is not a prism). */
function prismPlacements(): Placement[] {
  const placements: Placement[] = [];
  for (let patch = 0; patch < ground.count; patch++) {
    if (ground.q[patch * Q_STRIDE + Q_KIND] !== PRISM) continue;
    const offset = patch * P_STRIDE;
    placements.push({
      x: ground.p[offset + PR_X]!,
      z: ground.p[offset + PR_Z]!,
      base: ground.p[offset + PR_BASE]!,
      yaw: ground.p[offset + PR_YAW]!,
      hx: ground.p[offset + PR_HX]!,
      hz: ground.p[offset + PR_HZ]!,
      height: ground.p[offset + PR_TOP]!,
    });
  }
  return placements;
}

/** Pairs each of `found` with one of `expected`, each used once; the ones left over on either side are the mismatch. */
function leftOvers(expected: readonly Placement[], found: readonly Placement[]): { missing: Placement[]; extra: Placement[] } {
  const missing = [...expected];
  const extra: Placement[] = [];
  for (const placement of found) {
    const at = missing.findIndex((candidate) => isSameSolid(candidate, placement));
    if (at < 0) extra.push(placement);
    else missing.splice(at, 1);
  }
  return { missing, extra };
}

function isUnderBox(x: number, z: number, box: Placement): boolean {
  const offsetX = x - box.x;
  const offsetZ = z - box.z;
  const across = offsetX * Math.cos(box.yaw) - offsetZ * Math.sin(box.yaw);
  const along = offsetX * Math.sin(box.yaw) + offsetZ * Math.cos(box.yaw);
  return Math.abs(across) <= box.hx + EDGE_REACH && Math.abs(along) <= box.hz + EDGE_REACH;
}

describe("derby arena", () => {
  for (const kind of Object.values(DERBY_PROP)) {
    it(`given the drawn arena, when every ${kind} instance is read back, then each is exactly one box of the list and each box is drawn once`, () => {
      const expected = drawnBoxes.filter((box) => box.kind === kind);
      const mesh = boxMesh(kind);
      assert.equal(mesh.count, expected.length, `${kind} instance count`);
      const { missing, extra } = leftOvers(expected, placementsOf(mesh));
      assert.deepEqual(extra, [], `${kind} instances that are no listed box`);
      assert.deepEqual(missing, [], `${kind} boxes that are not drawn`);
    });
  }

  it("given the ground built from the list, when its prism patches are read, then each is a listed box and each box is a prism", () => {
    const { missing, extra } = leftOvers(listedBoxes, prismPlacements());
    assert.deepEqual(extra, [], "prisms that are no listed box");
    assert.deepEqual(missing, [], "boxes that are no prism");
  });

  it("given the drawn floor, when each vertex is compared with the ground's height query, then it is the surface a car meets", () => {
    const floor = arena.getObjectByName("derby-floor");
    assert.ok(floor instanceof THREE.Mesh, "the arena draws a floor");
    const positions = floor.geometry.getAttribute("position");
    let compared = 0;
    for (let vertex = 0; vertex < positions.count; vertex++) {
      const x = positions.getX(vertex);
      const z = positions.getZ(vertex);
      if (listedBoxes.some((box) => isUnderBox(x, z, box))) continue;
      compared++;
      assert.ok(Math.abs(positions.getY(vertex) - ground.heightAt(x, z)) < TOLERANCE, `floor vertex (${x}, ${z}) is at the ground's height`);
    }
    assert.ok(compared > positions.count * LEAST_COMPARED_SHARE, `${compared} of ${positions.count} vertices compared`);
  });

  it("given the drawn arena, when its draw calls are counted, then there are at most twelve and it is hidden until the engine shows it", () => {
    let drawCalls = 0;
    arena.traverse((object) => {
      if (object instanceof THREE.Mesh) drawCalls++;
    });
    assert.ok(drawCalls <= DRAW_CALL_LIMIT, `${drawCalls} draw calls`);
    assert.equal(arena.name, "derby-arena");
    assert.equal(arena.visible, false);
  });

  it("given the wall boxes as drawn, when each is read back, then its long axis runs along the wall and its inner face stands on the arena radius", () => {
    const pieces = placementsOf(boxMesh(DERBY_PROP.wall));
    assert.equal(pieces.length, DERBY_ARENA.wallPieces);
    for (const piece of pieces) {
      const centreRadius = Math.hypot(piece.x, piece.z);
      const radialAlongLongAxis = (piece.x * Math.sin(piece.yaw) + piece.z * Math.cos(piece.yaw)) / centreRadius;
      assert.ok(Math.abs(radialAlongLongAxis) < TANGENT_LIMIT, `wall piece at (${piece.x}, ${piece.z}) lies along the wall`);
      assert.ok(Math.abs(centreRadius - piece.hx - DERBY_ARENA.radius) < WALL_FACE_TOLERANCE, `wall piece at (${piece.x}, ${piece.z}) has its inner face on the radius`);
    }
  });
});

/** Indices of one grid cell's two triangles. */
const INDICES_PER_CELL = 6;

function meshNamed(name: string): THREE.Mesh {
  const found = arena.getObjectByName(name);
  assert.ok(found instanceof THREE.Mesh, `the arena draws ${name}`);
  return found;
}

function standardMaterialOf(mesh: THREE.Mesh): THREE.MeshStandardMaterial {
  assert.ok(mesh.material instanceof THREE.MeshStandardMaterial, `${mesh.name} has a standard material`);
  return mesh.material;
}

/** A ramp's deck as the design reads: as wide as the ramp's top, from the foot of its long run to the far edge of its crest. */
function isOnDeck(ramp: (typeof DERBY_RAMPS)[number], x: number, z: number): boolean {
  const { plateau, toward } = ramp;
  const risesAlongX = toward.x !== 0;
  const along = toward.x * x + toward.z * z;
  const lateral = risesAlongX ? z - plateau.z : x - plateau.x;
  const crestCentre = toward.x * plateau.x + toward.z * plateau.z;
  const halfCrest = risesAlongX ? plateau.halfX : plateau.halfZ;
  const halfWidth = risesAlongX ? plateau.halfZ : plateau.halfX;
  return Math.abs(lateral) <= halfWidth && along >= crestCentre - halfCrest - ramp.length && along <= crestCentre + halfCrest;
}

/** Each grid cell a mesh draws: its lower corner as `x,z` and the plan corners of its six indexed vertices in order. */
function cellsOf(mesh: THREE.Mesh): Map<string, string> {
  const positions = mesh.geometry.getAttribute("position");
  const indices = mesh.geometry.getIndex();
  assert.ok(indices, `${mesh.name} is indexed`);
  const cells = new Map<string, string>();
  for (let start = 0; start < indices.count; start += INDICES_PER_CELL) {
    const corners = Array.from({ length: INDICES_PER_CELL }, (_unused, offset) => {
      const vertex = indices.getX(start + offset);
      return [positions.getX(vertex), positions.getZ(vertex)] as const;
    });
    const lowX = Math.min(...corners.map(([x]) => x));
    const lowZ = Math.min(...corners.map(([, z]) => z));
    cells.set(`${lowX},${lowZ}`, corners.map(([x, z]) => `${x},${z}`).join(" "));
  }
  return cells;
}

/** The least a floor vertex's colour may be, of the floor's mean in each channel (linear light): the scrap hump is damp earth, not a black blob. */
const LEAST_FLOOR_SHARE = 0.25;

describe("derby arena floor colour", () => {
  const colours = meshNamed("derby-floor").geometry.getAttribute("color");
  const channels = [0, 1, 2].map((channel) => ({ channel, read: (vertex: number) => colours.getComponent(vertex, channel) }));

  for (const { channel, read } of channels) {
    it(`given the drawn floor, when each vertex's colour channel ${channel} is read, then none is under ${LEAST_FLOOR_SHARE} of the floor's mean`, () => {
      let total = 0;
      for (let vertex = 0; vertex < colours.count; vertex++) total += read(vertex);
      const mean = total / colours.count;
      let darkest = Infinity;
      for (let vertex = 0; vertex < colours.count; vertex++) darkest = Math.min(darkest, read(vertex));
      assert.ok(darkest >= mean * LEAST_FLOOR_SHARE, `darkest ${darkest} of mean ${mean}`);
    });
  }
});

/** The level floor compared with: vertices at height 0 this near (m) the middle, clear of every rise and prop. */
const LEVEL_FLOOR_REACH = 8;
/** The table-top's mid slope: this far (m, from to) past the flat top's far edge, across the top's width (it falls 2.2 m over 8.5 m, so it is about half height here). */
const SLOPE_FROM = 2;
const SLOPE_TO = 7;

describe("derby arena plateau colour", () => {
  const floor = meshNamed("derby-floor");
  const positions = floor.geometry.getAttribute("position");
  const colours = floor.geometry.getAttribute("color");
  const meanRed = (select: (vertex: number) => boolean): number => {
    let total = 0;
    let count = 0;
    for (let vertex = 0; vertex < positions.count; vertex++) {
      if (!select(vertex)) continue;
      total += colours.getX(vertex);
      count++;
    }
    assert.ok(count > 0, "some vertices were compared");
    return total / count;
  };
  const withinHalfWidth = (vertex: number) => Math.abs(positions.getX(vertex) - DERBY_TABLE_TOP.x) <= DERBY_TABLE_TOP.halfX;
  const beyondTop = (vertex: number) => positions.getZ(vertex) - DERBY_TABLE_TOP.z - DERBY_TABLE_TOP.halfZ;
  const level = (vertex: number) => positions.getY(vertex) === 0 && Math.hypot(positions.getX(vertex), positions.getZ(vertex)) <= LEVEL_FLOOR_REACH;
  const plateauCases = [
    { name: "flat top", select: (vertex: number) => withinHalfWidth(vertex) && beyondTop(vertex) <= 0 && beyondTop(vertex) >= -2 * DERBY_TABLE_TOP.halfZ, least: 1.2, most: Infinity },
    { name: "mid slope", select: (vertex: number) => withinHalfWidth(vertex) && beyondTop(vertex) >= SLOPE_FROM && beyondTop(vertex) <= SLOPE_TO, least: 0, most: 0.9 },
  ];

  for (const { name, select, least, most } of plateauCases) {
    it(`given the drawn floor, when the table-top's ${name} is compared with the level floor, then its mean red is ${least} to ${most} times the floor's`, () => {
      const ratio = meanRed(select) / meanRed(level);
      assert.ok(ratio >= least, `${name} ratio ${ratio} under ${least}`);
      assert.ok(ratio <= most, `${name} ratio ${ratio} over ${most}`);
    });
  }
});

describe("derby arena ramp decks", () => {
  const decks = meshNamed("derby-ramp-decks");
  const deckCells = cellsOf(decks);

  it("given the drawn decks, when each vertex is compared with the ground's height query, then it lies on the surface a car meets", () => {
    const positions = decks.geometry.getAttribute("position");
    assert.ok(positions.count > 0, "the decks have vertices");
    for (let vertex = 0; vertex < positions.count; vertex++) {
      const x = positions.getX(vertex);
      const z = positions.getZ(vertex);
      assert.ok(Math.abs(positions.getY(vertex) - ground.heightAt(x, z)) < TOLERANCE, `deck vertex (${x}, ${z}) is at the ground's height`);
    }
  });

  it("given the ramps' decks as designed, when the drawn cells are compared with the cells whose centre is on one, then none is missing and none is extra", () => {
    const expected = new Set<string>();
    for (let z = -DERBY_ARENA.gridHalf; z < DERBY_ARENA.gridHalf; z++) {
      for (let x = -DERBY_ARENA.gridHalf; x < DERBY_ARENA.gridHalf; x++) {
        if (DERBY_RAMPS.some((ramp) => isOnDeck(ramp, x + 0.5, z + 0.5))) expected.add(`${x},${z}`);
      }
    }
    const missing = [...expected].filter((key) => !deckCells.has(key));
    const extra = [...deckCells.keys()].filter((key) => !expected.has(key));
    assert.equal(missing.length, 0, `deck cells not drawn: ${missing.slice(0, 5).join(" | ")}`);
    assert.equal(extra.length, 0, `drawn cells on no deck: ${extra.slice(0, 5).join(" | ")}`);
    assert.ok(expected.size > 0, "the ramps have deck cells");
  });

  it("given the floor's cells and the deck's, when a cell is in both, then both split it into the same two triangles", () => {
    const floorCells = cellsOf(meshNamed("derby-floor"));
    for (const [key, split] of deckCells) assert.equal(split, floorCells.get(key), `cell ${key} is split like the floor's`);
  });
});

describe("derby arena glass", () => {
  const glass = boxMesh("glass");
  const panes = placementsOf(glass);
  const wallPieces = listedBoxes.filter((box) => box.kind === DERBY_PROP.wall);

  it("given the drawn glass, when its instances are counted, then there is one pane per wall piece", () => {
    assert.equal(glass.count, DERBY_ARENA.wallPieces);
  });

  it("given each glass pane, when its base and top are read back, then it spans the concrete's top to the wall's top", () => {
    for (const pane of panes) {
      assert.ok(Math.abs(pane.base - DERBY_ARENA.concreteHeight) < TOLERANCE, `pane at (${pane.x}, ${pane.z}) starts at the concrete's top`);
      assert.ok(Math.abs(pane.base + pane.height - DERBY_ARENA.wallHeight) < TOLERANCE, `pane at (${pane.x}, ${pane.z}) ends at the wall's top`);
    }
  });

  it("given each glass pane, when its place is read back, then it stands over a wall piece with its inner face on the arena radius", () => {
    for (const pane of panes) {
      assert.ok(
        wallPieces.some((piece) => isUnderBox(pane.x, pane.z, piece)),
        `pane at (${pane.x}, ${pane.z}) is over a wall piece`,
      );
      assert.ok(Math.abs(Math.hypot(pane.x, pane.z) - pane.hx - DERBY_ARENA.radius) < WALL_FACE_TOLERANCE, `pane at (${pane.x}, ${pane.z}) has its inner face on the radius`);
    }
  });

  const glassCases = [
    { field: "transparent", read: () => standardMaterialOf(glass).transparent, expected: true, then: "it blends over the scene" },
    { field: "depthWrite", read: () => standardMaterialOf(glass).depthWrite, expected: false, then: "it writes no depth" },
    { field: "side", read: () => standardMaterialOf(glass).side, expected: THREE.FrontSide, then: "only its front faces draw" },
    { field: "castShadow", read: () => glass.castShadow, expected: false, then: "it casts no shadow" },
    { field: "receiveShadow", read: () => glass.receiveShadow, expected: false, then: "it receives no shadow" },
  ];
  for (const { field, read, expected, then } of glassCases) {
    it(`given the glass draw, when its ${field} is read, then ${then}`, () => {
      assert.equal(read(), expected);
    });
  }
});

describe("derby arena materials", () => {
  const floorMap = standardMaterialOf(meshNamed("derby-floor")).map;
  const deckMaterial = standardMaterialOf(meshNamed("derby-ramp-decks"));
  const mapCases = [
    { name: "floor map width", read: () => floorMap?.image.width, expected: DIRT_TEXTURE_SIZE, then: "it is one 1024 texel square" },
    { name: "floor map height", read: () => floorMap?.image.height, expected: DIRT_TEXTURE_SIZE, then: "it is one 1024 texel square" },
    { name: "floor map horizontal wrap", read: () => floorMap?.wrapS, expected: THREE.ClampToEdgeWrapping, then: "it clamps: one map covers the arena, no tiling" },
    { name: "ramp deck map horizontal wrap", read: () => deckMaterial.map?.wrapS, expected: THREE.RepeatWrapping, then: "the planks repeat" },
    { name: "ramp deck map vertical wrap", read: () => deckMaterial.map?.wrapT, expected: THREE.RepeatWrapping, then: "the planks repeat" },
    { name: "ramp deck depth write", read: () => deckMaterial.depthWrite, expected: false, then: "it writes no depth (a decal over the floor)" },
  ];
  for (const { name, read, expected, then } of mapCases) {
    it(`given the drawn arena, when the ${name} is read, then ${then}`, () => {
      assert.equal(read(), expected);
    });
  }
});

/** Metres one tile of each texture covers across and up its box faces (the textures' own scale: 1 m tiles, a 3 m panel, a 1.83 x 1.8 m K-rail panel, 1.3 m of two tyres), and the glass tile is its whole height. */
const tileCases = [
  { name: DERBY_PROP.wall, across: 3, up: 3.5 },
  { name: "glass", across: 3, up: DERBY_ARENA.wallHeight - DERBY_ARENA.concreteHeight },
  { name: DERBY_PROP.container, across: 1, up: 1 },
  { name: DERBY_PROP.rail, across: 1.83, up: 1.8 },
  { name: DERBY_PROP.pad, across: 1, up: 1 },
  { name: DERBY_PROP.tyres, across: 1.3, up: 1.3 },
];

describe("derby arena metric uv", () => {
  for (const { name, across, up } of tileCases) {
    it(`given the ${name} box, when its side face's uv is read, then it spans that face's metres over the texture's tile`, () => {
      const { geometry } = boxMesh(name);
      assert.ok(geometry instanceof THREE.BoxGeometry, `${name} is drawn from a box`);
      const uv = geometry.getAttribute("uv");
      const sideFaceVertices = [0, 1, 2, 3];
      const reachU = Math.max(...sideFaceVertices.map((vertex) => uv.getX(vertex)));
      const reachV = Math.max(...sideFaceVertices.map((vertex) => uv.getY(vertex)));
      assert.ok(Math.abs(reachU - geometry.parameters.depth / across) < TOLERANCE, `${name} u reach`);
      assert.ok(Math.abs(reachV - geometry.parameters.height / up) < TOLERANCE, `${name} v reach`);
    });
  }
});
