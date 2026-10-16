import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { LANDING_HEIGHT, type MinigameMode } from "../scenes/minigame-constants.ts";
import { climbFootX, floorHeightAt } from "../scenes/minigame-profile.ts";
import { CAPTURE_HALF_WIDTH, FRAME_BOARD_THICKNESS, POST_HALF_SPAN, POST_THICKNESS, type HeightBoard, type HighJumpLayout } from "../scenes/minigame-high-jump.ts";
import { makeGlassMaterial } from "../vehicle/car-materials.ts";
import { canvasTexture } from "./lab-art.ts";

/** Most draw calls the High jump's whole art may cost: timber, boards, trim, back-board, net, with room for the composer's own. */
export const HIGH_JUMP_DRAW_BUDGET = 12;

const HIGH_JUMP: MinigameMode = "highJump";

/**
 * Half the width (m) of the run-up's lane the barrels and the stop block flank. Must match the strip the station's surface helper
 * paints (`makeStationSurface`); until that lands this is the one place the art knows it.
 */
const LANE_HALF_WIDTH = 4;

const TIMBER_COLOR = 0x8a6a43;
const STEEL_COLOR = 0x4a5058;
const BRASS_COLOR = 0xc9a23a;
const BARREL_RUST_COLOR = 0x8a4a22;
const BARREL_BAND_COLOR = 0xd8a820;
const CHEVRON_COLOR = 0xe8c21c;
const STOP_RED_COLOR = 0xb8302a;
const STOP_WHITE_COLOR = 0xe8e4da;
const DASH_COLOR = 0xf2efe6;

/** A post's cap: a slab a little wider than the post, above its top. */
const POST_CAP_HEIGHT = 0.25;
const POST_CAP_OVERHANG = 1.3;

/** Height boards (m), their face between the posts: the major ones are taller and brighter. */
const BOARD_HEIGHT = { major: 1, minor: 0.5 } as const;
const BOARD_INNER_SPAN = 2 * POST_HALF_SPAN - POST_THICKNESS;
/** The brass plate bolted to each post at every board: its depth along the throw and its side (m). */
const PLATE_DEPTH = 0.04;
const PLATE_SIDE = 0.3;

/** The atlas the boards' labels share: `columns` cells across, each `cellWidth` x `cellHeight` px; the cell after the last board's is plain wood. */
const BOARD_ATLAS = { columns: 2, cellWidth: 1024, cellHeight: 128 } as const;
const BOARD_LABEL_FONT_PX = { major: 104, minor: 64 } as const;
const BOARD_PAINT = {
  major: { fill: "#e3b93f", edge: "#6b5419", ink: "#16130c" },
  minor: { fill: "#c9a77a", edge: "#6d5636", ink: "#2a1f12" },
  plain: "#b08a58",
} as const;
const BOARD_EDGE_PX = 8;
/** `BoxGeometry` builds six 4-vertex faces: +x, -x, ...: the -x face is the one the approaching car sees. */
const BOX_VERTICES_PER_FACE = 4;
const BOX_FRONT_FACE = 1;
const BOX_FACE_COUNT = 6;

/** The lip's dashed height line: dash and gap lengths along the throw, and the line's thickness (m). */
const DASH = { length: 0.8, gap: 0.6, thickness: 0.06 } as const;

/** The back-board: how far (m) it overreaches the frame on each side and above, how see-through it is, the thickness of its rails. */
const BACKBOARD_MARGIN = 1.2;
const BACKBOARD_OPACITY = 0.28;
const BACKBOARD_RAIL = 0.08;
/** The back-board hangs this far (m) behind the posts' back face. */
const BACKBOARD_GAP = 0.05;

/** The net: it reaches this far (m) either side beyond the capture band and this far above the frame; each end pole stands this far above the net. */
const NET_SIDE_MARGIN = 3;
const NET_EXTRA_HEIGHT = 3;
const NET_POLE_THICKNESS = 0.3;
const NET_POLE_EXTRA_HEIGHT = 1;
const NET_CABLE_THICKNESS = 0.1;
/** One mesh of the weave (m), and the weave's cell and line width (px). */
const NET_MESH_SIZE = 0.35;
const NET_TEXTURE_PX = 64;
const NET_LINE_PX = 4;
const NET_ALPHA_CUTOFF = 0.5;
const NET_COLOR = 0xe6e2d6;

/** Run-up dressing: barrels flank the kicker's foot, chevron strips lie before it, a striped stop block sits at the lip. */
const BARREL = { radius: 0.45, height: 1.1, bandRadiusExtra: 0.02, bandHeight: 0.3, sides: 14, mouthSetback: 1 } as const;
const CHEVRON = { count: 3, pitch: 3, firstSetback: 4, armLength: 3.2, armWidth: 0.55, halfAngle: (35 * Math.PI) / 180, lift: 0.03 } as const;
const STOP_BLOCK = { depth: 0.3, height: 0.5, stripes: 8 } as const;

/** `geometry` with every vertex coloured `hex` (the trim's material reads vertex colours, so one draw carries every colour). */
function painted(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const color = new THREE.Color(hex);
  const vertexCount = geometry.getAttribute("position").count;
  const colors = new Float32Array(vertexCount * 3);
  for (let vertexIndex = 0; vertexIndex < vertexCount; vertexIndex++) colors.set([color.r, color.g, color.b], vertexIndex * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** A box of `sizeX` x `sizeY` x `sizeZ` centred at (x, y, z). */
function boxAt(sizeX: number, sizeY: number, sizeZ: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(sizeX, sizeY, sizeZ).translate(x, y, z);
}

function mergedMesh(name: string, parts: THREE.BufferGeometry[], material: THREE.Material): THREE.Mesh {
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error(`could not merge the High jump's ${name}`);
  for (const part of parts) part.dispose();
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = `high-jump:${name}`;
  return mesh;
}

/** Where the net stands: its half width (m) and its top's height above the pad. */
function netExtent(layout: HighJumpLayout, lipY: number) {
  return { halfWidth: CAPTURE_HALF_WIDTH + NET_SIDE_MARGIN, top: lipY + layout.frameTop + NET_EXTRA_HEIGHT };
}

/** Where the back-board hangs: x just behind the posts, its bottom and top heights, and its half width. */
function backboardExtent(layout: HighJumpLayout, lipY: number) {
  return {
    x: layout.postsX + POST_THICKNESS / 2 + BACKBOARD_GAP,
    bottom: lipY - BACKBOARD_MARGIN,
    top: lipY + layout.frameTop + BACKBOARD_MARGIN,
    halfWidth: POST_HALF_SPAN + BACKBOARD_MARGIN,
  };
}

/** The posts, their caps, and the net's two end poles. */
function timberGeometry(layout: HighJumpLayout, lipY: number): THREE.BufferGeometry[] {
  const shaftTop = lipY + layout.frameTop;
  const shaftHeight = shaftTop - LANDING_HEIGHT;
  const capSide = POST_THICKNESS * POST_CAP_OVERHANG;
  const net = netExtent(layout, lipY);
  const poleHeight = net.top + NET_POLE_EXTRA_HEIGHT - LANDING_HEIGHT;
  const netHalfWidth = net.halfWidth;
  return [-1, 1].flatMap((side) => [
    boxAt(POST_THICKNESS, shaftHeight, POST_THICKNESS, layout.postsX, LANDING_HEIGHT + shaftHeight / 2, side * POST_HALF_SPAN),
    boxAt(capSide, POST_CAP_HEIGHT, capSide, layout.postsX, shaftTop + POST_CAP_HEIGHT / 2, side * POST_HALF_SPAN),
    boxAt(NET_POLE_THICKNESS, poleHeight, NET_POLE_THICKNESS, layout.netX, LANDING_HEIGHT + poleHeight / 2, side * netHalfWidth),
  ]);
}

/** Cell `cellIndex` of the board atlas as a rectangle of the texture (`u0`, `u1` left to right, `v0`, `v1` bottom to top). */
function atlasCell(cellIndex: number, cellCount: number) {
  const rows = Math.ceil(cellCount / BOARD_ATLAS.columns);
  const column = cellIndex % BOARD_ATLAS.columns;
  const row = Math.floor(cellIndex / BOARD_ATLAS.columns);
  return { u0: column / BOARD_ATLAS.columns, u1: (column + 1) / BOARD_ATLAS.columns, v0: 1 - (row + 1) / rows, v1: 1 - row / rows };
}

/** Every board's labelled cell, then the plain one; the label is stretched back to square over the cell-to-board squeeze. */
function paintBoardAtlas(context: CanvasRenderingContext2D, boards: readonly HeightBoard[]): void {
  const cellCount = boards.length + 1;
  const cellAspect = BOARD_ATLAS.cellWidth / BOARD_ATLAS.cellHeight;
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const originX = (cellIndex % BOARD_ATLAS.columns) * BOARD_ATLAS.cellWidth;
    const originY = Math.floor(cellIndex / BOARD_ATLAS.columns) * BOARD_ATLAS.cellHeight;
    const board = boards[cellIndex];
    if (!board) {
      context.fillStyle = BOARD_PAINT.plain;
      context.fillRect(originX, originY, BOARD_ATLAS.cellWidth, BOARD_ATLAS.cellHeight);
      continue;
    }
    const kind = board.major ? "major" : "minor";
    const faceAspect = BOARD_INNER_SPAN / BOARD_HEIGHT[kind];
    context.fillStyle = BOARD_PAINT[kind].fill;
    context.fillRect(originX, originY, BOARD_ATLAS.cellWidth, BOARD_ATLAS.cellHeight);
    context.strokeStyle = BOARD_PAINT[kind].edge;
    context.lineWidth = BOARD_EDGE_PX;
    context.strokeRect(originX + BOARD_EDGE_PX / 2, originY + BOARD_EDGE_PX / 2, BOARD_ATLAS.cellWidth - BOARD_EDGE_PX, BOARD_ATLAS.cellHeight - BOARD_EDGE_PX);
    context.save();
    context.translate(originX + BOARD_ATLAS.cellWidth / 2, originY + BOARD_ATLAS.cellHeight / 2);
    context.scale(cellAspect / faceAspect, 1);
    context.fillStyle = BOARD_PAINT[kind].ink;
    context.font = `bold ${BOARD_LABEL_FONT_PX[kind]}px sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(board.heightAboveLip === 0 ? "LIP = 0" : `${board.heightAboveLip} m`, 0, 0);
    context.restore();
  }
}

/** One board: a box between the posts whose -x face reads its label and whose other faces are plain wood. */
function boardGeometry(board: HeightBoard, boardIndex: number, cellCount: number, postsX: number): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(FRAME_BOARD_THICKNESS, BOARD_HEIGHT[board.major ? "major" : "minor"], BOARD_INNER_SPAN).translate(postsX, board.y, 0);
  const label = atlasCell(boardIndex, cellCount);
  const plain = atlasCell(cellCount - 1, cellCount);
  const uv = geometry.getAttribute("uv");
  for (let face = 0; face < BOX_FACE_COUNT; face++) {
    for (let corner = 0; corner < BOX_VERTICES_PER_FACE; corner++) {
      const vertexIndex = face * BOX_VERTICES_PER_FACE + corner;
      if (face === BOX_FRONT_FACE) {
        uv.setXY(vertexIndex, label.u0 + uv.getX(vertexIndex) * (label.u1 - label.u0), label.v0 + uv.getY(vertexIndex) * (label.v1 - label.v0));
      } else {
        uv.setXY(vertexIndex, (plain.u0 + plain.u1) / 2, (plain.v0 + plain.v1) / 2);
      }
    }
  }
  return geometry;
}

function boardsMesh(layout: HighJumpLayout): THREE.Mesh {
  const cellCount = layout.boards.length + 1;
  const atlas = canvasTexture(BOARD_ATLAS.columns * BOARD_ATLAS.cellWidth, Math.ceil(cellCount / BOARD_ATLAS.columns) * BOARD_ATLAS.cellHeight, (context) =>
    paintBoardAtlas(context, layout.boards),
  );
  const parts = layout.boards.map((board, boardIndex) => boardGeometry(board, boardIndex, cellCount, layout.postsX));
  return mergedMesh("boards", parts, new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.85 }));
}

/** The translucent back-board behind the posts: a glass pane from a little below the lip to above the frame, wider than the posts. */
function backboardMesh(layout: HighJumpLayout, lipY: number): THREE.Mesh {
  const { x, bottom, top, halfWidth } = backboardExtent(layout, lipY);
  const glass = makeGlassMaterial();
  glass.opacity = BACKBOARD_OPACITY;
  const pane = new THREE.PlaneGeometry(2 * halfWidth, top - bottom).rotateY(-Math.PI / 2).translate(x, (bottom + top) / 2, 0);
  const mesh = new THREE.Mesh(pane, glass);
  mesh.name = "high-jump:backboard";
  return mesh;
}

/** The back-board's rails and the net's top cable, steel; the brass height plates on the posts. */
function frameTrim(layout: HighJumpLayout, lipY: number): THREE.BufferGeometry[] {
  const { x, bottom, top, halfWidth } = backboardExtent(layout, lipY);
  const railX = x + BACKBOARD_RAIL / 2;
  const net = netExtent(layout, lipY);
  const rails = [
    boxAt(BACKBOARD_RAIL, BACKBOARD_RAIL, 2 * halfWidth, railX, top, 0),
    ...[-1, 1].map((side) => boxAt(BACKBOARD_RAIL, top - bottom, BACKBOARD_RAIL, railX, (bottom + top) / 2, side * halfWidth)),
    boxAt(NET_CABLE_THICKNESS, NET_CABLE_THICKNESS, 2 * net.halfWidth, layout.netX, net.top, 0),
  ].map((part) => painted(part, STEEL_COLOR));
  const plates = layout.boards.flatMap((board) =>
    [-1, 1].map((side) => painted(boxAt(PLATE_DEPTH, PLATE_SIDE, PLATE_SIDE, layout.postsX - POST_THICKNESS / 2 - PLATE_DEPTH / 2, board.y, side * POST_HALF_SPAN), BRASS_COLOR)),
  );
  return [...rails, ...plates];
}

/** The dashed 'LIP = 0' line: from the lip toward the posts at the lip's height, one over each post's lane. */
function lipLine(layout: HighJumpLayout, lipY: number): THREE.BufferGeometry[] {
  const dashCount = Math.floor(layout.postsX / (DASH.length + DASH.gap));
  return [-1, 1].flatMap((side) =>
    Array.from({ length: dashCount }, (_, dashIndex) =>
      painted(boxAt(DASH.length, DASH.thickness, DASH.thickness, dashIndex * (DASH.length + DASH.gap) + DASH.length / 2, lipY, side * POST_HALF_SPAN), DASH_COLOR),
    ),
  );
}

/** Two rusty barrels with a yellow band, one each side of the lane at the kicker's mouth. */
function barrels(): THREE.BufferGeometry[] {
  const x = climbFootX(HIGH_JUMP) - BARREL.mouthSetback;
  const floorY = floorHeightAt(HIGH_JUMP, x, 0);
  const z = LANE_HALF_WIDTH + BARREL.radius * 2;
  return [-1, 1].flatMap((side) => [
    painted(new THREE.CylinderGeometry(BARREL.radius, BARREL.radius, BARREL.height, BARREL.sides).translate(x, floorY + BARREL.height / 2, side * z), BARREL_RUST_COLOR),
    painted(
      new THREE.CylinderGeometry(BARREL.radius + BARREL.bandRadiusExtra, BARREL.radius + BARREL.bandRadiusExtra, BARREL.bandHeight, BARREL.sides).translate(
        x,
        floorY + BARREL.height / 2,
        side * z,
      ),
      BARREL_BAND_COLOR,
    ),
  ]);
}

/** Yellow chevrons (two flat arms meeting at a tip that points down the run) before the kicker's foot. */
function chevrons(): THREE.BufferGeometry[] {
  const halfLengthAlong = (CHEVRON.armLength / 2) * Math.cos(CHEVRON.halfAngle);
  const halfLengthAcross = (CHEVRON.armLength / 2) * Math.sin(CHEVRON.halfAngle);
  return Array.from({ length: CHEVRON.count }, (_, chevronIndex) => {
    const tipX = climbFootX(HIGH_JUMP) - CHEVRON.firstSetback - chevronIndex * CHEVRON.pitch;
    const floorY = floorHeightAt(HIGH_JUMP, tipX, 0) + CHEVRON.lift;
    return [-1, 1].map((side) =>
      painted(
        new THREE.PlaneGeometry(CHEVRON.armLength, CHEVRON.armWidth)
          .rotateX(-Math.PI / 2)
          .rotateY(side * CHEVRON.halfAngle)
          .translate(tipX - halfLengthAlong, floorY, side * halfLengthAcross),
        CHEVRON_COLOR,
      ),
    );
  }).flat();
}

/** The art-only stop block: red and white stripes across the lane at the lip (no physics). */
function stopBlock(lipY: number): THREE.BufferGeometry[] {
  const stripeWidth = (2 * LANE_HALF_WIDTH) / STOP_BLOCK.stripes;
  return Array.from({ length: STOP_BLOCK.stripes }, (_, stripeIndex) =>
    painted(
      boxAt(STOP_BLOCK.depth, STOP_BLOCK.height, stripeWidth, 0, lipY + STOP_BLOCK.height / 2, -LANE_HALF_WIDTH + (stripeIndex + 0.5) * stripeWidth),
      stripeIndex % 2 === 0 ? STOP_RED_COLOR : STOP_WHITE_COLOR,
    ),
  );
}

/** A driving-range net: a tall alpha-tested weave plane at `layout.netX`, the same single-pass flags as the glass. */
function netMesh(layout: HighJumpLayout, lipY: number): THREE.Mesh {
  const { halfWidth, top } = netExtent(layout, lipY);
  const width = 2 * halfWidth;
  const height = top - LANDING_HEIGHT;
  const weave = canvasTexture(NET_TEXTURE_PX, NET_TEXTURE_PX, (context) => {
    context.clearRect(0, 0, NET_TEXTURE_PX, NET_TEXTURE_PX);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, NET_TEXTURE_PX, NET_LINE_PX);
    context.fillRect(0, 0, NET_LINE_PX, NET_TEXTURE_PX);
  });
  weave.repeat.set(width / NET_MESH_SIZE, height / NET_MESH_SIZE);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height).rotateY(-Math.PI / 2).translate(layout.netX, LANDING_HEIGHT + height / 2, 0),
    new THREE.MeshStandardMaterial({
      map: weave,
      color: NET_COLOR,
      roughness: 1,
      transparent: true,
      alphaTest: NET_ALPHA_CUTOFF,
      side: THREE.DoubleSide,
      forceSinglePass: true,
    }),
  );
  mesh.name = "high-jump:net";
  return mesh;
}

/**
 * The High jump's static art in station-local coordinates (+x the throw, x = 0 the lip, z = 0 the lane's middle, y from the pad): two
 * posts with a labelled height board and brass plate per `layout.boards` entry, a dashed lip-height line, a translucent back-board,
 * the net at `layout.netX`, and the run-up's barrels, chevrons and stop block. Five draws, every material shared (`HIGH_JUMP_DRAW_BUDGET`).
 */
export function makeHighJumpArt(layout: HighJumpLayout, lipY: number): THREE.Group {
  const group = new THREE.Group();
  group.name = "high-jump";
  const timber = mergedMesh("timber", timberGeometry(layout, lipY), new THREE.MeshStandardMaterial({ color: TIMBER_COLOR, roughness: 0.9 }));
  timber.castShadow = true;
  const trim = mergedMesh(
    "trim",
    [...frameTrim(layout, lipY), ...lipLine(layout, lipY), ...barrels(), ...chevrons(), ...stopBlock(lipY)],
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.15 }),
  );
  trim.castShadow = true;
  const boards = boardsMesh(layout);
  boards.castShadow = true;
  group.add(timber, boards, trim, backboardMesh(layout, lipY), netMesh(layout, lipY));
  return group;
}
