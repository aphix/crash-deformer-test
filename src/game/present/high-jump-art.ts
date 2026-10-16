import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { LANDING_HEIGHT, MINIGAME_MODE } from "../scenes/minigame-constants.ts";
import { climbFootX, floorHeightAt } from "../scenes/minigame-profile.ts";
import { CAPTURE_HALF_WIDTH, FRAME_BOARD_THICKNESS, POST_HALF_SPAN, POST_THICKNESS, type HeightBoard, type HighJumpLayout } from "../scenes/minigame-high-jump.ts";
import { makeGlassMaterial } from "../vehicle/car-materials.ts";
import { CANVAS_WHITE, canvasTexture } from "./lab-art.ts";
import { SIGN_BOARD_PAINT } from "./range-art.ts";

const HIGH_JUMP = MINIGAME_MODE.highJump;

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

/**
 * A frame's timbers grow with its height so a 200 m post does not read as a needle: a structure of `height` m is at least this many
 * metres thick per metre of height, and never thinner than the layout's `POST_THICKNESS`. Everything slender (post, board depth, plates,
 * rails, caps, poles, cables, the net's mesh) scales by the same ratio.
 */
export const POST_THICKNESS_PER_METRE = 0.005;

/** How many times thicker than the layout's base sizes a structure of `height` m is built. */
function thicknessScale(height: number): number {
  return Math.max(1, (height * POST_THICKNESS_PER_METRE) / POST_THICKNESS);
}

/** The thickness (m) of the posts of a frame `frameTop` m above the lip. */
function postThickness(frameTop: number): number {
  return POST_THICKNESS * thicknessScale(frameTop);
}

/** A post's cap: a slab a little wider than the post, above its top. */
const POST_CAP_HEIGHT = 0.25;
const POST_CAP_OVERHANG = 1.3;

/**
 * Height boards (m), their face between the posts. Minor boards are slim, plain timber; the major ones (every 50 m) are big,
 * bright and labelled, large enough to read from about 100 m.
 */
const BOARD_HEIGHT = { major: 5, minor: 0.8 } as const;
/** The brass plate bolted to each post at every board: its depth along the throw and its side (m). */
const PLATE_DEPTH = 0.04;
const PLATE_SIDE = 0.3;

/** The atlas the major boards' labels share: `columns` cells across, each `cellWidth` x `cellHeight` px; the last cell is plain timber for every other face. */
const BOARD_ATLAS = { columns: 2, cellWidth: 1024, cellHeight: 512 } as const;
const BOARD_LABEL_FONT_PX = 340;
const BOARD_LABEL_MARGIN_PX = 40;
const BOARD_PAINT = { ...SIGN_BOARD_PAINT, plain: "#b08a58" } as const;
const BOARD_EDGE_PX = 16;
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

/** The net: it reaches this far (m) either side beyond the capture band; each end pole stands this far above the net. */
const NET_SIDE_MARGIN = 3;
/** Half the net's width (m): the drawn net and the ground's net prism share it. */
export const NET_HALF_WIDTH = CAPTURE_HALF_WIDTH + NET_SIDE_MARGIN;
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

/** Where the net stands: its half width (m), its top's height above the pad, and how much thicker than the base sizes its timbers are. */
function netExtent(layout: HighJumpLayout) {
  const top = LANDING_HEIGHT + layout.netHeight;
  return { halfWidth: NET_HALF_WIDTH, top, scale: thicknessScale(layout.netHeight) };
}

/** Where the back-board hangs: x just behind the posts, its bottom and top heights, and its half width. */
function backboardExtent(layout: HighJumpLayout, lipY: number) {
  return {
    x: layout.postsX + postThickness(layout.frameTop) / 2 + BACKBOARD_GAP,
    bottom: lipY - BACKBOARD_MARGIN,
    top: lipY + layout.frameTop + BACKBOARD_MARGIN,
    halfWidth: POST_HALF_SPAN + BACKBOARD_MARGIN,
  };
}

/** The posts, their caps, and the net's two end poles. */
function timberGeometry(layout: HighJumpLayout, lipY: number): THREE.BufferGeometry[] {
  const scale = thicknessScale(layout.frameTop);
  const thickness = postThickness(layout.frameTop);
  const shaftTop = lipY + layout.frameTop;
  const shaftHeight = shaftTop - LANDING_HEIGHT;
  const capSide = thickness * POST_CAP_OVERHANG;
  const capHeight = POST_CAP_HEIGHT * scale;
  const net = netExtent(layout);
  const poleThickness = NET_POLE_THICKNESS * net.scale;
  const poleHeight = net.top + NET_POLE_EXTRA_HEIGHT * net.scale - LANDING_HEIGHT;
  return [-1, 1].flatMap((side) => [
    boxAt(thickness, shaftHeight, thickness, layout.postsX, LANDING_HEIGHT + shaftHeight / 2, side * POST_HALF_SPAN),
    boxAt(capSide, capHeight, capSide, layout.postsX, shaftTop + capHeight / 2, side * POST_HALF_SPAN),
    boxAt(poleThickness, poleHeight, poleThickness, layout.netX, LANDING_HEIGHT + poleHeight / 2, side * net.halfWidth),
  ]);
}

/** Cell `cellIndex` of the board atlas as a rectangle of the texture (`u0`, `u1` left to right, `v0`, `v1` bottom to top). */
function atlasCell(cellIndex: number, cellCount: number) {
  const rows = Math.ceil(cellCount / BOARD_ATLAS.columns);
  const column = cellIndex % BOARD_ATLAS.columns;
  const row = Math.floor(cellIndex / BOARD_ATLAS.columns);
  return { u0: column / BOARD_ATLAS.columns, u1: (column + 1) / BOARD_ATLAS.columns, v0: 1 - (row + 1) / rows, v1: 1 - row / rows };
}

/** The face of a major board (m): between the posts, so its aspect is what the label is stretched back over. */
function majorFaceAspect(frameTop: number): number {
  return (2 * POST_HALF_SPAN - postThickness(frameTop)) / BOARD_HEIGHT.major;
}

/** One cell per major board (in board order), then the plain one; each label is stretched back to square over the cell-to-board squeeze. */
function paintBoardAtlas(context: CanvasRenderingContext2D, majorBoards: readonly HeightBoard[], faceAspect: number): void {
  const cellCount = majorBoards.length + 1;
  const horizontalStretch = BOARD_ATLAS.cellWidth / BOARD_ATLAS.cellHeight / faceAspect;
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex++) {
    const originX = (cellIndex % BOARD_ATLAS.columns) * BOARD_ATLAS.cellWidth;
    const originY = Math.floor(cellIndex / BOARD_ATLAS.columns) * BOARD_ATLAS.cellHeight;
    const board = majorBoards[cellIndex];
    if (!board) {
      context.fillStyle = BOARD_PAINT.plain;
      context.fillRect(originX, originY, BOARD_ATLAS.cellWidth, BOARD_ATLAS.cellHeight);
      continue;
    }
    context.fillStyle = BOARD_PAINT.fill;
    context.fillRect(originX, originY, BOARD_ATLAS.cellWidth, BOARD_ATLAS.cellHeight);
    context.strokeStyle = BOARD_PAINT.edge;
    context.lineWidth = BOARD_EDGE_PX;
    context.strokeRect(originX + BOARD_EDGE_PX / 2, originY + BOARD_EDGE_PX / 2, BOARD_ATLAS.cellWidth - BOARD_EDGE_PX, BOARD_ATLAS.cellHeight - BOARD_EDGE_PX);
    context.save();
    context.translate(originX + BOARD_ATLAS.cellWidth / 2, originY + BOARD_ATLAS.cellHeight / 2);
    context.scale(horizontalStretch, 1);
    context.fillStyle = BOARD_PAINT.ink;
    context.font = `bold ${BOARD_LABEL_FONT_PX}px sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(board.heightAboveLip === 0 ? "LIP = 0" : `${board.heightAboveLip} m`, 0, 0, (BOARD_ATLAS.cellWidth - 2 * BOARD_LABEL_MARGIN_PX) / horizontalStretch);
    context.restore();
  }
}

/** One board: a box between the posts. A major board's -x face reads its own atlas cell; every other face (and a minor board) the plain one. */
function boardGeometry(board: HeightBoard, labelCellIndex: number | null, cellCount: number, layout: HighJumpLayout): THREE.BufferGeometry {
  const depth = FRAME_BOARD_THICKNESS * thicknessScale(layout.frameTop);
  const span = 2 * POST_HALF_SPAN - postThickness(layout.frameTop);
  const geometry = new THREE.BoxGeometry(depth, BOARD_HEIGHT[board.major ? "major" : "minor"], span).translate(layout.postsX, board.y, 0);
  const plain = atlasCell(cellCount - 1, cellCount);
  const label = labelCellIndex === null ? null : atlasCell(labelCellIndex, cellCount);
  const uv = geometry.getAttribute("uv");
  for (let face = 0; face < BOX_FACE_COUNT; face++) {
    for (let corner = 0; corner < BOX_VERTICES_PER_FACE; corner++) {
      const vertexIndex = face * BOX_VERTICES_PER_FACE + corner;
      if (face === BOX_FRONT_FACE && label) {
        uv.setXY(vertexIndex, label.u0 + uv.getX(vertexIndex) * (label.u1 - label.u0), label.v0 + uv.getY(vertexIndex) * (label.v1 - label.v0));
      } else {
        uv.setXY(vertexIndex, (plain.u0 + plain.u1) / 2, (plain.v0 + plain.v1) / 2);
      }
    }
  }
  return geometry;
}

function boardsMesh(layout: HighJumpLayout): THREE.Mesh {
  const majorBoards = layout.boards.filter((board) => board.major);
  const cellCount = majorBoards.length + 1;
  const atlas = canvasTexture(BOARD_ATLAS.columns * BOARD_ATLAS.cellWidth, Math.ceil(cellCount / BOARD_ATLAS.columns) * BOARD_ATLAS.cellHeight, (context) =>
    paintBoardAtlas(context, majorBoards, majorFaceAspect(layout.frameTop)),
  );
  const parts = layout.boards.map((board) => boardGeometry(board, board.major ? majorBoards.indexOf(board) : null, cellCount, layout));
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
  const scale = thicknessScale(layout.frameTop);
  const { x, bottom, top, halfWidth } = backboardExtent(layout, lipY);
  const rail = BACKBOARD_RAIL * scale;
  const railX = x + rail / 2;
  const net = netExtent(layout);
  const cable = NET_CABLE_THICKNESS * net.scale;
  const plateX = layout.postsX - postThickness(layout.frameTop) / 2 - (PLATE_DEPTH * scale) / 2;
  const rails = [
    boxAt(rail, rail, 2 * halfWidth, railX, top, 0),
    ...[-1, 1].map((side) => boxAt(rail, top - bottom, rail, railX, (bottom + top) / 2, side * halfWidth)),
    boxAt(cable, cable, 2 * net.halfWidth, layout.netX, net.top, 0),
  ].map((part) => painted(part, STEEL_COLOR));
  const plates = layout.boards.flatMap((board) =>
    [-1, 1].map((side) => painted(boxAt(PLATE_DEPTH * scale, PLATE_SIDE * scale, PLATE_SIDE * scale, plateX, board.y, side * POST_HALF_SPAN), BRASS_COLOR)),
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

/** A driving-range net: a tall alpha-tested weave plane at `layout.netX`, `layout.netHeight` m tall, the same single-pass flags as the glass. */
function netMesh(layout: HighJumpLayout): THREE.Mesh {
  const { halfWidth, top, scale } = netExtent(layout);
  const width = 2 * halfWidth;
  const height = top - LANDING_HEIGHT;
  const weave = canvasTexture(NET_TEXTURE_PX, NET_TEXTURE_PX, (context) => {
    context.clearRect(0, 0, NET_TEXTURE_PX, NET_TEXTURE_PX);
    context.fillStyle = CANVAS_WHITE;
    context.fillRect(0, 0, NET_TEXTURE_PX, NET_LINE_PX);
    context.fillRect(0, 0, NET_LINE_PX, NET_TEXTURE_PX);
  });
  weave.repeat.set(width / (NET_MESH_SIZE * scale), height / (NET_MESH_SIZE * scale));
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
 * posts (thicker the taller the frame, `postThickness`) with a board and brass plate per `layout.boards` entry (the major ones big and
 * labelled), a dashed lip-height line, a translucent back-board, the net at `layout.netX` and `layout.netHeight` tall, and the run-up's
 * barrels, chevrons and stop block. Five draws, every material shared.
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
  group.add(timber, boards, trim, backboardMesh(layout, lipY), netMesh(layout));
  return group;
}
