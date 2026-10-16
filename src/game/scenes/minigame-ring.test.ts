import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RING_BOARD_BOUNDS,
  RING_BOARD_START_X,
  RING_CUPS,
  RING_CUP_PROFILE,
  RING_MESH_STEP,
  RING_POCKETS,
  RING_RAIL_PROFILE,
  ringBoardMesh,
  ringBoardPlaneHeight,
  ringHeightAt,
  ringScore,
  type RingZone,
} from "./minigame-ring.ts";

const ALL_ZONES: readonly RingZone[] = [...RING_CUPS, ...RING_POCKETS];
/** The narrowest window (m across) a 100 pocket's scoring circle may offer: wide enough that a precise line and speed can land him in one. */
const POCKET_AIM_WINDOW = 1.2;
const GRAVITY = 9.80665;

/** The lying dummy and his torso box (present/ragdoll-body.ts PARTS; scenes may not import present). */
const DUMMY_LYING_WIDTH = 0.58;
const DUMMY_LYING_LENGTH = 2.0;
const DUMMY_TORSO_WIDTH = 0.36;
const DUMMY_TORSO_LENGTH = 0.54;

/** The throw the board is designed for: 15-22 m/s up 35 degrees from the lip. */
const DESIGN_THROW_PITCH = (35 * Math.PI) / 180;
const DESIGN_THROW_SPEED_MIN = 15;
const DESIGN_THROW_SPEED_MAX = 22;

const EDGE_NUDGE = 1e-6;
const DIRECTIONS_AROUND_A_ZONE = [0, Math.PI / 3, Math.PI / 2, Math.PI, (4 * Math.PI) / 3] as const;
const FLOAT32_EPSILON = 2 ** -23;

/** Radial cross-section slope bounds: the steepest wall in the board (rise over its footprint). */
const STEEPEST_WALL_SLOPE = Math.max(
  RING_CUP_PROFILE.wallHeight / RING_CUP_PROFILE.wallFootWidth,
  RING_RAIL_PROFILE.height / RING_RAIL_PROFILE.slopeWidth,
);
const PLANE_SLOPE = ringBoardPlaneHeight(RING_BOARD_START_X + 1) - ringBoardPlaneHeight(RING_BOARD_START_X);
const STEEPEST_SURFACE_SLOPE = STEEPEST_WALL_SLOPE + PLANE_SLOPE;

function floorRadius(zone: RingZone, scale = 1): number {
  return (zone.radius - RING_CUP_PROFILE.wallFootWidth) * scale;
}

function halfDiagonal(width: number, length: number): number {
  return Math.sqrt(width * width + length * length) / 2;
}

/** A rectangle of width x length lies inside the flat floor circle at any heading iff its half diagonal fits the floor radius. */
function floorHoldsRectangle(zone: RingZone, width: number, length: number, scale = 1): boolean {
  return floorRadius(zone, scale) >= halfDiagonal(width, length);
}

function cupNamed(score: number): RingZone {
  const cup = RING_CUPS.find((candidate) => candidate.score === score);
  assert.ok(cup, `cup ${score} exists`);
  return cup;
}

describe("given the ring board's cups and pockets", () => {
  for (const zone of ALL_ZONES) {
    const label = `${zone.score} at z ${zone.centreZ.toFixed(2)}`;
    it(`when scoring the centre of the ${label} zone, then it scores ${zone.score}`, () => {
      assert.equal(ringScore(zone.centreX, zone.centreZ), zone.score, "score at the zone centre");
    });
    it(`when scoring just inside the ${label} zone's edge in several directions, then it scores ${zone.score}`, () => {
      for (const direction of DIRECTIONS_AROUND_A_ZONE) {
        const reach = zone.radius - EDGE_NUDGE;
        const score = ringScore(zone.centreX + reach * Math.cos(direction), zone.centreZ + reach * Math.sin(direction));
        assert.equal(score, zone.score, `score just inside at heading ${direction.toFixed(2)}`);
      }
    });
    it(`when scoring just outside the ${label} zone's edge in several directions, then it scores 0`, () => {
      for (const direction of DIRECTIONS_AROUND_A_ZONE) {
        const reach = zone.radius + EDGE_NUDGE;
        const score = ringScore(zone.centreX + reach * Math.cos(direction), zone.centreZ + reach * Math.sin(direction));
        assert.equal(score, 0, `score just outside at heading ${direction.toFixed(2)}`);
      }
    });
  }

  const offCupPoints = [
    { it: "when scoring the board's front apron, then it scores 0", localX: RING_BOARD_START_X + 1, localZ: 0 },
    { it: "when scoring the bare board beside the cups, then it scores 0", localX: RING_CUPS[2]!.centreX, localZ: RING_BOARD_BOUNDS.maxZ - 0.5 },
    { it: "when scoring a point behind the lip but short of the board, then it scores 0", localX: 0, localZ: 0 },
    { it: "when scoring a point past the board's back edge, then it scores 0", localX: RING_BOARD_BOUNDS.maxX + 1, localZ: 0 },
    { it: "when scoring a point left of the board, then it scores 0", localX: RING_CUPS[0]!.centreX, localZ: RING_BOARD_BOUNDS.minZ - 1 },
    { it: "when scoring a point right of the board, then it scores 0", localX: RING_CUPS[0]!.centreX, localZ: RING_BOARD_BOUNDS.maxZ + 1 },
    { it: "when scoring the strip of rim between two touching cups, then it scores 0", localX: (RING_CUPS[0]!.centreX + RING_CUPS[1]!.centreX) / 2 + (RING_CUPS[0]!.radius - RING_CUPS[1]!.radius) / 2, localZ: 0 },
  ];
  for (const point of offCupPoints) {
    it(point.it, () => {
      assert.equal(ringScore(point.localX, point.localZ), 0, "score off every cup");
    });
  }

  it("when the two 100 pockets are compared, then they score 100 and are mirror images across the lane centre", () => {
    assert.equal(RING_POCKETS.length, 2, "pocket count");
    const [left, right] = RING_POCKETS;
    assert.equal(left!.score, 100, "left pocket score");
    assert.equal(right!.score, 100, "right pocket score");
    assert.equal(left!.centreX, right!.centreX, "pockets at the same x");
    assert.equal(left!.centreZ, -right!.centreZ, "pockets on opposite sides of the centre");
    assert.notEqual(left!.centreZ, 0, "pockets are off the centreline");
    assert.equal(left!.radius, right!.radius, "pocket radius");
    assert.equal(left!.floorHeight, right!.floorHeight, "pocket floor height");
    assert.equal(left!.rimHeight, right!.rimHeight, "pocket rim height");
    assert.equal(ringScore(left!.centreX, left!.centreZ), 100, "score at the left pocket");
    assert.equal(ringScore(right!.centreX, right!.centreZ), 100, "score at the right pocket");
  });
});

describe("given the layout read off the skee-ball picture", () => {
  /** Radius over the 10 cup's, from each cup's width in the picture (50 px wide for the 10): 48, 42, 40, 34 px, read by eye to within 6 px, so +-0.12 with the picture's perspective. */
  const pictureRadiusRatios = [
    { it: "when the 20 cup is measured against the 10, then it is about 0.96 as wide", score: 20, ratioToTen: 0.96 },
    { it: "when the 30 cup is measured against the 10, then it is about 0.84 as wide", score: 30, ratioToTen: 0.84 },
    { it: "when the 40 cup is measured against the 10, then it is about 0.80 as wide", score: 40, ratioToTen: 0.8 },
    { it: "when the 50 cup is measured against the 10, then it is about 0.68 as wide", score: 50, ratioToTen: 0.68 },
  ];
  const PICTURE_RATIO_TOLERANCE = 0.12;
  for (const testCase of pictureRadiusRatios) {
    it(testCase.it, () => {
      const ratio = cupNamed(testCase.score).radius / cupNamed(10).radius;
      assert.ok(Math.abs(ratio - testCase.ratioToTen) <= PICTURE_RATIO_TOLERANCE, `radius ratio ${ratio.toFixed(3)} vs ${testCase.ratioToTen}`);
    });
  }

  it("when the 100 pocket is measured against the 50 cup, then it is about 0.9 as wide (the picture: 30 px against 34) and the smallest zone", () => {
    const ratio = RING_POCKETS[0]!.radius / cupNamed(50).radius;
    assert.ok(Math.abs(ratio - 0.9) <= 0.12, `pocket to 50 radius ratio ${ratio.toFixed(3)}`);
    for (const cup of RING_CUPS) assert.ok(RING_POCKETS[0]!.radius < cup.radius, `pocket smaller than the ${cup.score} cup`);
  });

  it("when the 10 cup is measured against the lane width, then it is about 0.30 of it (54 px of 178 px) within 0.1", () => {
    const laneWidth = RING_BOARD_BOUNDS.maxZ - RING_BOARD_BOUNDS.minZ;
    const ratio = (2 * cupNamed(10).radius) / laneWidth;
    assert.ok(Math.abs(ratio - 0.3) <= 0.1, `10 cup width over lane width ${ratio.toFixed(3)}`);
  });

  it("when the cups are listed by score, then size falls, height rises and each lies farther back, all on the centreline", () => {
    const scores = RING_CUPS.map((cup) => cup.score);
    assert.deepEqual(scores, [10, 20, 30, 40, 50], "score order");
    for (let index = 1; index < RING_CUPS.length; index++) {
      const lower = RING_CUPS[index - 1]!;
      const higher = RING_CUPS[index]!;
      assert.ok(higher.radius < lower.radius, `${higher.score} cup narrower than the ${lower.score}`);
      assert.ok(higher.floorHeight > lower.floorHeight, `${higher.score} floor above the ${lower.score}`);
      assert.ok(higher.rimHeight > lower.rimHeight, `${higher.score} rim above the ${lower.score}`);
      assert.ok(higher.centreX > lower.centreX, `${higher.score} farther back than the ${lower.score}`);
    }
    for (const cup of RING_CUPS) assert.equal(cup.centreZ, 0, `${cup.score} cup on the centreline`);
  });

  it("when the 100 pockets are placed, then they are the highest zones, behind the 50 cup, in the two back corners beside the cup column", () => {
    const fifty = cupNamed(50);
    const cupReach = RING_CUP_PROFILE.rimTopWidth + RING_CUP_PROFILE.skirtWidth;
    for (const pocket of RING_POCKETS) {
      assert.ok(pocket.floorHeight > fifty.floorHeight, "pocket floor above the 50's");
      assert.ok(pocket.rimHeight > fifty.rimHeight, "pocket rim above the 50's");
      assert.ok(pocket.centreX > fifty.centreX, "pocket behind the 50");
      assert.ok(Math.abs(pocket.centreZ) > cupNamed(10).radius, "pocket outside the widest cup's width");
      const reach = pocket.radius + cupReach;
      assert.ok(Math.abs(pocket.centreZ) + reach <= RING_BOARD_BOUNDS.maxZ, "pocket skirt inside the side rim line");
      assert.ok(pocket.centreX + reach <= RING_BOARD_BOUNDS.maxX, "pocket skirt inside the back edge");
      assert.ok(RING_BOARD_BOUNDS.maxX - (pocket.centreX + reach) < 2 * reach, "pocket is in the back corner, not the middle");
    }
  });

  it("when every pair of zones is compared, then their rims never overlap", () => {
    for (let first = 0; first < ALL_ZONES.length; first++) {
      for (let second = first + 1; second < ALL_ZONES.length; second++) {
        const a = ALL_ZONES[first]!;
        const b = ALL_ZONES[second]!;
        const distance = Math.hypot(a.centreX - b.centreX, a.centreZ - b.centreZ);
        const rimsTouchAt = a.radius + b.radius + 2 * RING_CUP_PROFILE.rimTopWidth;
        assert.ok(distance >= rimsTouchAt - 1e-9, `${a.score} and ${b.score} rims ${distance.toFixed(3)} apart, need ${rimsTouchAt.toFixed(3)}`);
      }
    }
  });
});

describe("given a lying dummy and the cups' size", () => {
  for (const cup of RING_CUPS) {
    it(`when a ${DUMMY_LYING_WIDTH} x ${DUMMY_LYING_LENGTH} m lying dummy is set on the ${cup.score} cup's floor, then he fits at any heading`, () => {
      assert.ok(floorHoldsRectangle(cup, DUMMY_LYING_WIDTH, DUMMY_LYING_LENGTH), `${cup.score} cup floor radius ${floorRadius(cup).toFixed(3)} holds him`);
    });
  }

  it("when the cups shrink by a quarter, then the 50 cup no longer holds him (the check can fail)", () => {
    const SHRINK = 0.75;
    assert.ok(floorHoldsRectangle(cupNamed(50), DUMMY_LYING_WIDTH, DUMMY_LYING_LENGTH), "full size holds him");
    assert.ok(!floorHoldsRectangle(cupNamed(50), DUMMY_LYING_WIDTH, DUMMY_LYING_LENGTH, SHRINK), "three quarters size cannot");
  });

  it("when a pocket is measured, then its scoring circle is at least the aim window wide and its floor holds his torso", () => {
    for (const pocket of RING_POCKETS) {
      assert.ok(2 * pocket.radius >= POCKET_AIM_WINDOW, `pocket window ${(2 * pocket.radius).toFixed(3)} m`);
      assert.ok(floorHoldsRectangle(pocket, DUMMY_TORSO_WIDTH, DUMMY_TORSO_LENGTH), "pocket floor holds a torso");
    }
  });
});

describe("given the board is the surface a thrown dummy lands on", () => {
  it("when a flight leaves the lip at the design pitch, then the speed that arrives on each cup's floor rises with its score and stays in the design speed range", () => {
    /** Flat flight from the lip (y = 0): y = x tan(p) - g x^2 / (2 v^2 cos^2(p)), solved for the speed v that is at `floor` over `distance`. */
    function speedToReach(distance: number, floorHeight: number): number {
      const climbed = distance * Math.tan(DESIGN_THROW_PITCH) - floorHeight;
      assert.ok(climbed > 0, "the flight must clear the floor height at that distance");
      return Math.sqrt((GRAVITY * distance * distance) / (2 * Math.cos(DESIGN_THROW_PITCH) ** 2 * climbed));
    }
    let previousSpeed = 0;
    for (const zone of [...RING_CUPS, RING_POCKETS[0]!]) {
      const speed = speedToReach(zone.centreX, zone.floorHeight);
      assert.ok(speed > previousSpeed, `${zone.score} needs more speed (${speed.toFixed(2)}) than the one before (${previousSpeed.toFixed(2)})`);
      assert.ok(speed >= DESIGN_THROW_SPEED_MIN && speed <= DESIGN_THROW_SPEED_MAX, `${zone.score} needs ${speed.toFixed(2)} m/s`);
      previousSpeed = speed;
    }
  });
});

describe("given the board's height function", () => {
  it("when it is sampled at the board's front edge on the centreline, then it is at pad height", () => {
    assert.equal(ringHeightAt(RING_BOARD_BOUNDS.minX, 0), 0, "height where the hump ends");
  });

  it("when it is sampled off the board, then it is the pad", () => {
    assert.equal(ringHeightAt(0, 0), 0, "short of the board");
    assert.equal(ringHeightAt(RING_BOARD_BOUNDS.maxX + 1, 0), 0, "past the back");
    assert.equal(ringHeightAt(RING_CUPS[0]!.centreX, RING_BOARD_BOUNDS.maxZ + 1), 0, "beside the board");
  });

  it("when it is sampled along the bare apron beside the cups, then it rises toward the back at the board's slope", () => {
    const apronZ = (cupNamed(10).radius + RING_BOARD_BOUNDS.maxZ) / 2;
    const samples = [RING_CUPS[0]!.centreX, RING_CUPS[1]!.centreX, RING_CUPS[2]!.centreX];
    let previous = ringHeightAt(RING_BOARD_BOUNDS.minX + 1, apronZ);
    for (const localX of samples) {
      const height = ringHeightAt(localX, apronZ);
      assert.ok(height > previous, `apron rises by ${localX.toFixed(1)} m`);
      assert.equal(height, ringBoardPlaneHeight(localX), `apron height at ${localX.toFixed(1)} equals the board plane`);
      previous = height;
    }
  });

  for (const zone of ALL_ZONES) {
    it(`when it is sampled inside the ${zone.score} zone at z ${zone.centreZ.toFixed(2)}, then the floor is flat at its height, its crest is at the rim height and it meets the board past its skirt`, () => {
      assert.equal(ringHeightAt(zone.centreX, zone.centreZ), zone.floorHeight, "floor at the centre");
      assert.equal(ringHeightAt(zone.centreX, zone.centreZ + floorRadius(zone) * 0.9), zone.floorHeight, "floor off the centre");
      const crest = zone.radius + RING_CUP_PROFILE.rimTopWidth / 2;
      assert.equal(ringHeightAt(zone.centreX, zone.centreZ + crest), zone.rimHeight, "rim crest");
      assert.ok(zone.floorHeight >= ringBoardPlaneHeight(zone.centreX + zone.radius), "floor is raised over the board under the cup");
      const pastSkirt = zone.radius + RING_CUP_PROFILE.rimTopWidth + RING_CUP_PROFILE.skirtWidth + 0.01;
      const isCup = zone.centreZ === 0;
      const probeX = isCup ? zone.centreX : zone.centreX - pastSkirt;
      const probeZ = isCup ? pastSkirt : zone.centreZ;
      assert.equal(ringHeightAt(probeX, probeZ), ringBoardPlaneHeight(probeX), "board past the skirt");
    });
  }

  it("when it is sampled across the side rim, then it rises to the rim height at the board's edge and falls back to the board inside its slope, mirrored left and right", () => {
    const localX = RING_CUPS[2]!.centreX;
    const board = ringBoardPlaneHeight(localX);
    for (const side of [-1, 1]) {
      assert.equal(ringHeightAt(localX, side * (RING_BOARD_BOUNDS.maxZ - RING_RAIL_PROFILE.topWidth / 2)), board + RING_RAIL_PROFILE.height, "rim top");
      const insideSlope = RING_BOARD_BOUNDS.maxZ - RING_RAIL_PROFILE.topWidth - RING_RAIL_PROFILE.slopeWidth - 0.01;
      assert.equal(ringHeightAt(localX, side * insideSlope), board, "board inside the rim");
    }
  });

  it("when it is sampled around the back and into a back corner, then the rim keeps its height all the way round", () => {
    const board = ringBoardPlaneHeight(RING_BOARD_BOUNDS.maxX - RING_RAIL_PROFILE.topWidth / 2);
    assert.equal(ringHeightAt(RING_BOARD_BOUNDS.maxX - RING_RAIL_PROFILE.topWidth / 2, 0), board + RING_RAIL_PROFILE.height, "back wall");
    const pocket = RING_POCKETS[1]!;
    const cornerRadius = RING_BOARD_BOUNDS.maxX - pocket.centreX;
    const alongCornerArc = (cornerRadius - RING_RAIL_PROFILE.topWidth / 2) / Math.SQRT2;
    const cornerX = pocket.centreX + alongCornerArc;
    assert.equal(ringHeightAt(cornerX, pocket.centreZ + alongCornerArc), ringBoardPlaneHeight(cornerX) + RING_RAIL_PROFILE.height, "back-right corner arc");
  });

  it("when it is sampled at mirrored points across the lane centre, then the heights are equal", () => {
    for (let localX = RING_BOARD_BOUNDS.minX; localX <= RING_BOARD_BOUNDS.maxX; localX += 0.37) {
      for (let localZ = 0.11; localZ <= RING_BOARD_BOUNDS.maxZ; localZ += 0.29) {
        assert.equal(ringHeightAt(localX, localZ), ringHeightAt(localX, -localZ), `height at ${localX.toFixed(2)}, ${localZ.toFixed(2)}`);
      }
    }
  });

  it("when it is walked across the whole board in 5 cm steps, then no step rises or falls faster than the steepest wall allows (no cliffs)", () => {
    const spacing = 0.05;
    const largestAllowedStep = STEEPEST_SURFACE_SLOPE * spacing;
    let largestStep = 0;
    for (let localZ = RING_BOARD_BOUNDS.minZ; localZ <= RING_BOARD_BOUNDS.maxZ; localZ += spacing) {
      let previous = ringHeightAt(RING_BOARD_BOUNDS.minX, localZ);
      for (let localX = RING_BOARD_BOUNDS.minX + spacing; localX <= RING_BOARD_BOUNDS.maxX; localX += spacing) {
        const height = ringHeightAt(localX, localZ);
        largestStep = Math.max(largestStep, Math.abs(height - previous));
        previous = height;
      }
    }
    assert.ok(largestStep <= largestAllowedStep, `largest step ${largestStep.toFixed(4)} m over ${spacing} m, allowed ${largestAllowedStep.toFixed(4)}`);
    assert.ok(largestStep > largestAllowedStep / 4, `the walk reached a wall (${largestStep.toFixed(4)} m): the bound is not vacuous`);
  });
});

describe("given the board sampled into a triangle mesh", () => {
  const mesh = ringBoardMesh(RING_MESH_STEP);
  const vertexCount = mesh.vertices.length / 3;
  const MESH_HEIGHT_TOLERANCE = STEEPEST_SURFACE_SLOPE * RING_BOARD_BOUNDS.maxX * FLOAT32_EPSILON;

  it("when a vertex is compared with the height function, then its height is the function's at the vertex's own x and z", () => {
    let largestError = 0;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const localX = mesh.vertices[vertex * 3]!;
      const height = mesh.vertices[vertex * 3 + 1]!;
      const localZ = mesh.vertices[vertex * 3 + 2]!;
      largestError = Math.max(largestError, Math.abs(height - ringHeightAt(localX, localZ)));
    }
    assert.ok(largestError <= MESH_HEIGHT_TOLERANCE, `largest vertex height error ${largestError} (tolerance ${MESH_HEIGHT_TOLERANCE})`);
    let highest = 0;
    for (let vertex = 0; vertex < vertexCount; vertex++) highest = Math.max(highest, mesh.vertices[vertex * 3 + 1]!);
    assert.ok(highest >= RING_POCKETS[0]!.rimHeight - MESH_HEIGHT_TOLERANCE, `mesh reaches the pocket rims (${highest} m vs ${RING_POCKETS[0]!.rimHeight})`);
  });

  it("when the triangles are laid out in plan, then they tile the board exactly and no edge is longer than the step allows", () => {
    let plannedArea = 0;
    let longestEdge = 0;
    for (let corner = 0; corner < mesh.indices.length; corner += 3) {
      const base = [mesh.indices[corner]! * 3, mesh.indices[corner + 1]! * 3, mesh.indices[corner + 2]! * 3] as const;
      const [ax, az] = [mesh.vertices[base[0]]!, mesh.vertices[base[0] + 2]!];
      const [bx, bz] = [mesh.vertices[base[1]]!, mesh.vertices[base[1] + 2]!];
      const [cx, cz] = [mesh.vertices[base[2]]!, mesh.vertices[base[2] + 2]!];
      plannedArea += Math.abs((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / 2;
      longestEdge = Math.max(longestEdge, Math.hypot(bx - ax, bz - az), Math.hypot(cx - bx, cz - bz), Math.hypot(ax - cx, az - cz));
    }
    const boardArea = (RING_BOARD_BOUNDS.maxX - RING_BOARD_BOUNDS.minX) * (RING_BOARD_BOUNDS.maxZ - RING_BOARD_BOUNDS.minZ);
    assert.ok(Math.abs(plannedArea - boardArea) <= boardArea * 1e-5, `triangle area ${plannedArea.toFixed(3)} m2 vs board ${boardArea.toFixed(3)} m2`);
    assert.ok(longestEdge <= RING_MESH_STEP * Math.SQRT2 * (1 + 1e-5), `longest edge ${longestEdge.toFixed(4)} m (diagonal of a ${RING_MESH_STEP} m cell)`);
  });

  it("when the mesh is sampled at a coarse step, then its vertices still span the board's bounds with no gap above that step", () => {
    const coarseStep = 1.5;
    const coarse = ringBoardMesh(coarseStep);
    const xs = new Set<number>();
    const zs = new Set<number>();
    for (let vertex = 0; vertex < coarse.vertices.length; vertex += 3) {
      xs.add(coarse.vertices[vertex]!);
      zs.add(coarse.vertices[vertex + 2]!);
    }
    const sortedXs = [...xs].sort((first, second) => first - second);
    const sortedZs = [...zs].sort((first, second) => first - second);
    assert.equal(sortedXs[0], Math.fround(RING_BOARD_BOUNDS.minX), "first column at the front edge");
    assert.equal(sortedXs.at(-1), Math.fround(RING_BOARD_BOUNDS.maxX), "last column at the back edge");
    assert.equal(sortedZs[0], Math.fround(RING_BOARD_BOUNDS.minZ), "first row at the left edge");
    assert.equal(sortedZs.at(-1), Math.fround(RING_BOARD_BOUNDS.maxZ), "last row at the right edge");
    for (const axis of [sortedXs, sortedZs]) {
      for (let index = 1; index < axis.length; index++) {
        assert.ok(axis[index]! - axis[index - 1]! <= coarseStep + 1e-5, `gap ${(axis[index]! - axis[index - 1]!).toFixed(4)} m`);
      }
    }
  });

  it("when every index is checked, then it names a vertex that exists", () => {
    for (let corner = 0; corner < mesh.indices.length; corner++) assert.ok(mesh.indices[corner]! < vertexCount, `index ${corner}`);
    assert.ok(vertexCount > 1000, `${vertexCount} vertices`);
  });
});
