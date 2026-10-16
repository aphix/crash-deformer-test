import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { hypot2 } from "../kernel/physics-core.js";
import { LANDING_HEIGHT, MINIGAME_MODE, STATION_HALF_WIDTH } from "../scenes/minigame-constants.ts";
import { climbFootX, floorHeightAt, stationFrontX } from "../scenes/minigame-profile.ts";
import { BOARD_FINE_STEP, CAPTURE_HALF_WIDTH, FRAME_BOARD_THICKNESS, POST_HALF_SPAN, POST_THICKNESS, type HeightBoard, type HighJumpLayout } from "../scenes/minigame-high-jump.ts";
import { makeGlassMaterial } from "../vehicle/car-materials.ts";
import { CANVAS_WHITE, canvasTexture } from "./lab-art.ts";
import { SIGN_BOARD_PAINT } from "./range-art.ts";

const HIGH_JUMP = MINIGAME_MODE.highJump;

/**
 * Half the width (m) of the run-up's lane the barrels and the stop block flank. Must match the strip the station's surface helper
 * paints (`makeStationSurface`); until that lands this is the one place the art knows it.
 */
const LANE_HALF_WIDTH = 4;

const TIMBER_COLOR = "#8a6a43";
const TIMBER_STREAK_DARK = "rgba(52,34,16,0.35)";
const TIMBER_STREAK_LIGHT = "rgba(190,150,98,0.3)";
const STEEL_COLOR = 0x4a5058;
const BRASS_COLOR = 0xc9a23a;
const BARREL_RUST_COLOR = 0x8a4a22;
const BARREL_BAND_COLOR = 0xd8a820;
const CHEVRON_COLOR = 0xe8c21c;
const STOP_RED_COLOR = 0xb8302a;
const STOP_WHITE_COLOR = 0xe8e4da;
const DASH_COLOR = 0xfff6c8;

/**
 * A frame's timbers grow with its height so a 200 m post does not read as a needle: a structure of `height` m is at least this many
 * metres thick per metre of height, and never thinner than the layout's `POST_THICKNESS`. Everything slender (post, board depth, plates,
 * rails, caps, poles, cables, the net's mesh) scales by the same ratio.
 */
export const POST_THICKNESS_PER_METRE = 0.008;

/** How many times thicker than the layout's base sizes a structure of `height` m is built. */
function thicknessScale(height: number): number {
  return Math.max(1, (height * POST_THICKNESS_PER_METRE) / POST_THICKNESS);
}

/** The thickness (m) of the posts of a frame `frameTop` m above the lip. */
function postThickness(frameTop: number): number {
  return POST_THICKNESS * thicknessScale(frameTop);
}

/**
 * The posts' wood grain: a streaked tile that repeats once per `TIMBER_TILE_METRES` along every face (each box's uvs are written in
 * metres), so a 200 m post carries grain at the size of a pole, not one texture stretched over its height.
 */
const TIMBER_TEXTURE_PX = 128;
const TIMBER_STREAK_COUNT = 40;
const TIMBER_STREAK_STRIDE = 37;
const TIMBER_TILE_METRES = 2;

function paintTimber(context: CanvasRenderingContext2D): void {
  context.fillStyle = TIMBER_COLOR;
  context.fillRect(0, 0, TIMBER_TEXTURE_PX, TIMBER_TEXTURE_PX);
  for (let streak = 0; streak < TIMBER_STREAK_COUNT; streak++) {
    context.fillStyle = streak % 2 === 0 ? TIMBER_STREAK_DARK : TIMBER_STREAK_LIGHT;
    context.fillRect((streak * TIMBER_STREAK_STRIDE) % TIMBER_TEXTURE_PX, 0, 1 + (streak % 3), TIMBER_TEXTURE_PX);
  }
}

/** A post's cap: a slab a little wider than the post, above its top. */
const POST_CAP_HEIGHT = 0.25;
const POST_CAP_OVERHANG = 1.3;

/**
 * Height boards: a bar between the posts at every board's height (the major ones, every 50 m, a bright thick bar), and above every
 * major bar a big labelled sign standing on it, so the sign is never below the line it names (the lip's sign cannot sink behind the
 * kicker's end) and it reads from about 100 m. The sign fills the room between a major bar and the next minor bar of the fine band.
 */
const BAR_HEIGHT = { major: 1.2, minor: 0.8 } as const;
const SIGN_CLEARANCE = 0.2;
const SIGN_HEIGHT = BOARD_FINE_STEP - BAR_HEIGHT.major / 2 - BAR_HEIGHT.minor / 2 - SIGN_CLEARANCE;
/** The brass plate bolted to each post at every board: its depth along the throw, its share of the post's width, and its height (m), the major ones big. */
const PLATE = { depth: 0.04, widthShare: 0.8, height: { major: 1.2, minor: 0.3 } } as const;

/**
 * The atlas the signs' labels share: `columns` cells across, each `cellWidth` x `cellHeight` px: one labelled cell per major board,
 * then a plain timber cell, then a bright bar cell.
 */
const BOARD_ATLAS = { columns: 2, cellWidth: 1024, cellHeight: 512 } as const;
const BOARD_LABEL_FONT_PX = 340;
const BOARD_LABEL_MARGIN_PX = 40;
const BOARD_PAINT = { ...SIGN_BOARD_PAINT, plain: "#b08a58" } as const;
const BOARD_EDGE_PX = 16;
/** `BoxGeometry` builds six 4-vertex faces: +x, -x, ...: the -x face is the one the approaching car sees. */
const BOX_VERTICES_PER_FACE = 4;
const BOX_FRONT_FACE = 1;
const BOX_FACE_COUNT = 6;

/** The lip's dashed height line: dash and gap lengths along the throw, and the line's thickness (m): thick enough to read against the red strip and the dark ground. */
const DASH = { length: 1.5, gap: 1, thickness: 0.25 } as const;

/**
 * The back-board: a tinted glass pane in the gap between the posts from the lip's height to the frame's top, edged by steel rails. The
 * glass is a light blue with a faint glow so it reads against a dark sky, and it does not write depth (drawn after the net behind it,
 * it never hides the net; the boards in front of it are opaque and draw before it).
 */
const BACKBOARD = { tint: 0x9cc4d8, glow: 0x35677d, glowIntensity: 0.7, opacity: 0.4, railThickness: 0.12 } as const;
/** The back-board hangs this far (m) behind the posts' back face. */
const BACKBOARD_GAP = 0.05;
/** The net draws first and the back-board after it: the pane stands between the viewer and the net. */
const NET_RENDER_ORDER = 1;
const BACKBOARD_RENDER_ORDER = 2;

/** The net: it reaches this far (m) either side beyond the capture band; each end pole stands this far above the net. */
const NET_SIDE_MARGIN = 3;
/** Half the net's width (m): the drawn net and the ground's net prism share it. */
export const NET_HALF_WIDTH = CAPTURE_HALF_WIDTH + NET_SIDE_MARGIN;
/** The net's poles and top cable are stout (a 78 m net on 0.3 m sticks reads as a grid hanging in the void) and scale with its height. */
const NET_POLE_THICKNESS = 0.5;
const NET_POLE_EXTRA_HEIGHT = 1;
const NET_CABLE_THICKNESS = 0.25;
/** A pole stands at both ends and at least every this many metres between; a back row stands this far behind each, tied by a stay at the net's top. */
const NET_POLE_SPACING = 15;
const NET_BACK_ROW_SETBACK = 4;
/** A steel cable crosses the net at every multiple of this many metres of height, below the top one. */
const NET_CABLE_SPACING = 20;

/**
 * The kicker's cosmetic supports on each flank of the station's band (whose side walls are the dark slate): ribs every `pitch` m
 * (about; the run is split evenly) from the climb's foot to the lip, each `outset` wide outside the wall and `depth` along the run,
 * a beam `beam` thick laid on the floor's edge in steps of `beamStep` m of run (a chord of the arc each, so it hugs the floor even at the lip's
 * 60 degrees), ribs shorter than `minHeight` skipped.
 */
const KICKER_RIB = { pitch: 3, depth: 0.3, outset: 0.4, beam: 0.5, beamStep: 0.5, minHeight: 0.3 } as const;
/** The fascia over the lip's back face: its thickness and how far it stands off the face (m), against z-fighting. */
const LIP_FASCIA = { thickness: 0.2, lift: 0.02 } as const;

/**
 * One mesh of the weave (m) and its line width (px of the cell's `NET_TEXTURE_PX`): a line is `NET_MESH_SIZE * NET_LINE_PX / NET_TEXTURE_PX`
 * = 10 cm, about 2 px at 40 m. The texture takes no mipmaps: a mip of a thin line averages under the alpha cut and the far net would
 * vanish, where an unfiltered sample keeps the lines (they shimmer, as a net does).
 */
const NET_MESH_SIZE = 0.8;
const NET_TEXTURE_PX = 64;
const NET_LINE_PX = 8;
const NET_ALPHA_CUTOFF = 0.5;
const NET_COLOR = 0xffffff;

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

/** A timber box whose uvs count metres of `TIMBER_TILE_METRES` tiles along each face, so the grain keeps its size at any length. */
function timberBox(sizeX: number, sizeY: number, sizeZ: number, x: number, y: number, z: number, rotationZ = 0): THREE.BufferGeometry {
  const geometry = new THREE.BoxGeometry(sizeX, sizeY, sizeZ);
  const faceSizes = [
    [sizeZ, sizeY],
    [sizeZ, sizeY],
    [sizeX, sizeZ],
    [sizeX, sizeZ],
    [sizeX, sizeY],
    [sizeX, sizeY],
  ] as const;
  const uv = geometry.getAttribute("uv");
  for (let face = 0; face < BOX_FACE_COUNT; face++) {
    const [width, height] = faceSizes[face]!;
    for (let corner = 0; corner < BOX_VERTICES_PER_FACE; corner++) {
      const vertexIndex = face * BOX_VERTICES_PER_FACE + corner;
      uv.setXY(vertexIndex, (uv.getX(vertexIndex) * width) / TIMBER_TILE_METRES, (uv.getY(vertexIndex) * height) / TIMBER_TILE_METRES);
    }
  }
  return geometry.rotateZ(rotationZ).translate(x, y, z);
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

/** Where the back-board hangs: x just behind the posts, its bottom and top heights (the lip's and the frame's), and its half width: the gap between the posts' centres. */
function backboardExtent(layout: HighJumpLayout, lipY: number) {
  return {
    x: layout.postsX + postThickness(layout.frameTop) / 2 + BACKBOARD_GAP,
    bottom: lipY,
    top: lipY + layout.frameTop,
    halfWidth: POST_HALF_SPAN,
  };
}

/** The posts and their caps. */
function timberGeometry(layout: HighJumpLayout, lipY: number): THREE.BufferGeometry[] {
  const scale = thicknessScale(layout.frameTop);
  const thickness = postThickness(layout.frameTop);
  const shaftTop = lipY + layout.frameTop;
  const shaftHeight = shaftTop - LANDING_HEIGHT;
  const capSide = thickness * POST_CAP_OVERHANG;
  const capHeight = POST_CAP_HEIGHT * scale;
  return [-1, 1].flatMap((side) => [
    timberBox(thickness, shaftHeight, thickness, layout.postsX, LANDING_HEIGHT + shaftHeight / 2, side * POST_HALF_SPAN),
    timberBox(capSide, capHeight, capSide, layout.postsX, shaftTop + capHeight / 2, side * POST_HALF_SPAN),
  ]);
}

/**
 * The net's frame: a tall pole at both ends and at every `NET_POLE_SPACING` m or less between them (the same z for every one), each
 * with a pole standing `NET_BACK_ROW_SETBACK` m behind it and a stay beam tying their tops: a driving range's net stands on a frame, it does not float.
 */
function netFrameGeometry(layout: HighJumpLayout): THREE.BufferGeometry[] {
  const net = netExtent(layout);
  const poleThickness = NET_POLE_THICKNESS * net.scale;
  const poleHeight = net.top + NET_POLE_EXTRA_HEIGHT * net.scale - LANDING_HEIGHT;
  const stayThickness = NET_CABLE_THICKNESS * net.scale;
  const intervalCount = Math.ceil((2 * net.halfWidth) / NET_POLE_SPACING);
  return Array.from({ length: intervalCount + 1 }, (_, poleIndex) => -net.halfWidth + (poleIndex * 2 * net.halfWidth) / intervalCount).flatMap((poleZ) => [
    timberBox(poleThickness, poleHeight, poleThickness, layout.netX, LANDING_HEIGHT + poleHeight / 2, poleZ),
    timberBox(poleThickness, poleHeight, poleThickness, layout.netX + NET_BACK_ROW_SETBACK, LANDING_HEIGHT + poleHeight / 2, poleZ),
    timberBox(NET_BACK_ROW_SETBACK, stayThickness, stayThickness, layout.netX + NET_BACK_ROW_SETBACK / 2, net.top, poleZ),
  ]);
}

/** The kicker's cosmetic support: timber ribs on both flanks at every floor-profile step, from the climb's foot to the lip, tied by a beam along each flank's edge. */
function kickerSupportGeometry(): THREE.BufferGeometry[] {
  const footX = climbFootX(HIGH_JUMP);
  const ribCount = Math.max(1, Math.round(-footX / KICKER_RIB.pitch));
  const ribXs = Array.from({ length: ribCount + 1 }, (_, ribIndex) => footX + (ribIndex * -footX) / ribCount);
  const flankZ = (side: number) => side * (STATION_HALF_WIDTH + KICKER_RIB.outset / 2);
  const ribs = [-1, 1].flatMap((side) =>
    ribXs.flatMap((ribX) => {
      const floorY = floorHeightAt(HIGH_JUMP, ribX, 0);
      const low = Math.min(floorY, LANDING_HEIGHT);
      const high = Math.max(floorY, LANDING_HEIGHT);
      return high - low < KICKER_RIB.minHeight ? [] : [timberBox(KICKER_RIB.depth, high - low, KICKER_RIB.outset, ribX, (low + high) / 2, flankZ(side))];
    }),
  );
  const beamCount = Math.ceil(-footX / KICKER_RIB.beamStep);
  const beamXs = Array.from({ length: beamCount + 1 }, (_, beamIndex) => footX + (beamIndex * -footX) / beamCount);
  const beams = [-1, 1].flatMap((side) =>
    beamXs.slice(1).map((beamX, index) => {
      const fromX = beamXs[index]!;
      const fromY = floorHeightAt(HIGH_JUMP, fromX, 0);
      const toY = floorHeightAt(HIGH_JUMP, beamX, 0);
      return timberBox(hypot2(beamX - fromX, toY - fromY) + KICKER_RIB.depth, KICKER_RIB.beam, KICKER_RIB.outset, (fromX + beamX) / 2, (fromY + toY) / 2, flankZ(side), Math.atan2(toY - fromY, beamX - fromX));
    }),
  );
  return [...ribs, ...beams];
}

/** A timber plate laid over the back face behind the lip, from the lip down to the landing, across the whole band: the kicker's front fascia. */
function lipFasciaGeometry(): THREE.BufferGeometry {
  const frontX = stationFrontX(HIGH_JUMP);
  const lipFloorY = floorHeightAt(HIGH_JUMP, 0, 0);
  const dropY = LANDING_HEIGHT - lipFloorY;
  const length = hypot2(frontX, dropY);
  const outwardX = -dropY / length;
  const outwardY = frontX / length;
  const offset = LIP_FASCIA.thickness / 2 + LIP_FASCIA.lift;
  return timberBox(length, LIP_FASCIA.thickness, 2 * STATION_HALF_WIDTH, frontX / 2 + outwardX * offset, (lipFloorY + LANDING_HEIGHT) / 2 + outwardY * offset, 0, Math.atan2(dropY, frontX));
}

function timberMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ map: canvasTexture(TIMBER_TEXTURE_PX, TIMBER_TEXTURE_PX, paintTimber), roughness: 0.9 });
}

/** Cell `cellIndex` of the board atlas as a rectangle of the texture (`u0`, `u1` left to right, `v0`, `v1` bottom to top). */
function atlasCell(cellIndex: number, cellCount: number) {
  const rows = Math.ceil(cellCount / BOARD_ATLAS.columns);
  const column = cellIndex % BOARD_ATLAS.columns;
  const row = Math.floor(cellIndex / BOARD_ATLAS.columns);
  return { u0: column / BOARD_ATLAS.columns, u1: (column + 1) / BOARD_ATLAS.columns, v0: 1 - (row + 1) / rows, v1: 1 - row / rows };
}

/** The face of a sign (m): between the posts, so its aspect is what the label is stretched back over. */
function signFaceAspect(frameTop: number): number {
  return (2 * POST_HALF_SPAN - postThickness(frameTop)) / SIGN_HEIGHT;
}

/** A cell's fill and edge (the label, if any, is drawn over it by the caller). */
function paintBoardCell(context: CanvasRenderingContext2D, originX: number, originY: number, fill: string, edge: string | null): void {
  context.fillStyle = fill;
  context.fillRect(originX, originY, BOARD_ATLAS.cellWidth, BOARD_ATLAS.cellHeight);
  if (edge === null) return;
  context.strokeStyle = edge;
  context.lineWidth = BOARD_EDGE_PX;
  context.strokeRect(originX + BOARD_EDGE_PX / 2, originY + BOARD_EDGE_PX / 2, BOARD_ATLAS.cellWidth - BOARD_EDGE_PX, BOARD_ATLAS.cellHeight - BOARD_EDGE_PX);
}

/** One labelled cell per major board (in board order), then the plain timber cell, then the bright bar cell; each label is stretched back to square over the cell-to-sign squeeze. */
function paintBoardAtlas(context: CanvasRenderingContext2D, majorBoards: readonly HeightBoard[], faceAspect: number): void {
  const horizontalStretch = BOARD_ATLAS.cellWidth / BOARD_ATLAS.cellHeight / faceAspect;
  for (let cellIndex = 0; cellIndex < majorBoards.length + 2; cellIndex++) {
    const originX = (cellIndex % BOARD_ATLAS.columns) * BOARD_ATLAS.cellWidth;
    const originY = Math.floor(cellIndex / BOARD_ATLAS.columns) * BOARD_ATLAS.cellHeight;
    const board = majorBoards[cellIndex];
    if (!board) {
      const isBarCell = cellIndex === majorBoards.length + 1;
      paintBoardCell(context, originX, originY, isBarCell ? BOARD_PAINT.fill : BOARD_PAINT.plain, isBarCell ? BOARD_PAINT.edge : null);
      continue;
    }
    paintBoardCell(context, originX, originY, BOARD_PAINT.fill, BOARD_PAINT.edge);
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

/**
 * A box between the posts centred at height `y`. Every face reads the centre of atlas cell `solidCellIndex`; when `labelCellIndex` is
 * given the -x face (the one the car sees) reads that whole cell instead.
 */
function boardBox(height: number, y: number, solidCellIndex: number, labelCellIndex: number | null, cellCount: number, layout: HighJumpLayout): THREE.BufferGeometry {
  const depth = FRAME_BOARD_THICKNESS;
  const span = 2 * POST_HALF_SPAN - postThickness(layout.frameTop);
  const geometry = new THREE.BoxGeometry(depth, height, span).translate(layout.postsX, y, 0);
  const solid = atlasCell(solidCellIndex, cellCount);
  const label = labelCellIndex === null ? null : atlasCell(labelCellIndex, cellCount);
  const uv = geometry.getAttribute("uv");
  for (let face = 0; face < BOX_FACE_COUNT; face++) {
    for (let corner = 0; corner < BOX_VERTICES_PER_FACE; corner++) {
      const vertexIndex = face * BOX_VERTICES_PER_FACE + corner;
      if (face === BOX_FRONT_FACE && label) {
        uv.setXY(vertexIndex, label.u0 + uv.getX(vertexIndex) * (label.u1 - label.u0), label.v0 + uv.getY(vertexIndex) * (label.v1 - label.v0));
      } else {
        uv.setXY(vertexIndex, (solid.u0 + solid.u1) / 2, (solid.v0 + solid.v1) / 2);
      }
    }
  }
  return geometry;
}

/** One bar per layout board (merged first, in board order), then one sign above every major bar (in board order). */
function boardsMesh(layout: HighJumpLayout): THREE.Mesh {
  const majorBoards = layout.boards.filter((board) => board.major);
  const cellCount = majorBoards.length + 2;
  const plainCellIndex = majorBoards.length;
  const barCellIndex = majorBoards.length + 1;
  const atlas = canvasTexture(BOARD_ATLAS.columns * BOARD_ATLAS.cellWidth, Math.ceil(cellCount / BOARD_ATLAS.columns) * BOARD_ATLAS.cellHeight, (context) =>
    paintBoardAtlas(context, majorBoards, signFaceAspect(layout.frameTop)),
  );
  const bars = layout.boards.map((board) =>
    boardBox(board.major ? BAR_HEIGHT.major : BAR_HEIGHT.minor, board.y, board.major ? barCellIndex : plainCellIndex, null, cellCount, layout),
  );
  const signs = majorBoards.map((board, signIndex) =>
    boardBox(SIGN_HEIGHT, board.y + BAR_HEIGHT.major / 2 + SIGN_HEIGHT / 2, plainCellIndex, signIndex, cellCount, layout),
  );
  return mergedMesh("boards", [...bars, ...signs], new THREE.MeshStandardMaterial({ map: atlas, roughness: 0.85 }));
}

/** The translucent back-board behind the posts: a tinted glass pane, as wide as the gap between the posts and as tall as the frame above the lip. */
function backboardMesh(layout: HighJumpLayout, lipY: number): THREE.Mesh {
  const { x, bottom, top, halfWidth } = backboardExtent(layout, lipY);
  const glass = makeGlassMaterial();
  glass.color.setHex(BACKBOARD.tint);
  glass.emissive.setHex(BACKBOARD.glow);
  glass.emissiveIntensity = BACKBOARD.glowIntensity;
  glass.opacity = BACKBOARD.opacity;
  glass.depthWrite = false;
  const pane = new THREE.PlaneGeometry(2 * halfWidth, top - bottom).rotateY(-Math.PI / 2).translate(x, (bottom + top) / 2, 0);
  const mesh = new THREE.Mesh(pane, glass);
  mesh.name = "high-jump:backboard";
  mesh.renderOrder = BACKBOARD_RENDER_ORDER;
  return mesh;
}

/** The back-board's four rails (inside the posts, on the pane's visible edges), the net's top cable (steel), and the brass height plates on the posts. */
function frameTrim(layout: HighJumpLayout, lipY: number): THREE.BufferGeometry[] {
  const scale = thicknessScale(layout.frameTop);
  const thickness = postThickness(layout.frameTop);
  const { x, bottom, top } = backboardExtent(layout, lipY);
  const rail = BACKBOARD.railThickness * scale;
  const railX = x + rail / 2;
  const railZ = POST_HALF_SPAN - thickness / 2 - rail / 2;
  const net = netExtent(layout);
  const cable = NET_CABLE_THICKNESS * net.scale;
  const plateX = layout.postsX - thickness / 2 - (PLATE.depth * scale) / 2;
  const rails = [
    boxAt(rail, rail, 2 * railZ, railX, bottom + rail / 2, 0),
    boxAt(rail, rail, 2 * railZ, railX, top - rail / 2, 0),
    ...[-1, 1].map((side) => boxAt(rail, top - bottom, rail, railX, (bottom + top) / 2, side * railZ)),
    boxAt(cable, cable, 2 * net.halfWidth, layout.netX, net.top, 0),
    ...Array.from({ length: Math.ceil(layout.netHeight / NET_CABLE_SPACING) - 1 }, (_, cableIndex) =>
      boxAt(cable, cable, 2 * net.halfWidth, layout.netX, LANDING_HEIGHT + (cableIndex + 1) * NET_CABLE_SPACING, 0),
    ),
  ].map((part) => painted(part, STEEL_COLOR));
  const plates = layout.boards.flatMap((board) =>
    [-1, 1].map((side) =>
      painted(boxAt(PLATE.depth * scale, PLATE.height[board.major ? "major" : "minor"] * scale, thickness * PLATE.widthShare, plateX, board.y, side * POST_HALF_SPAN), BRASS_COLOR),
    ),
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
  weave.generateMipmaps = false;
  weave.minFilter = THREE.LinearFilter;
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
  mesh.renderOrder = NET_RENDER_ORDER;
  return mesh;
}

/**
 * The High jump's static art in station-local coordinates (+x the throw, x = 0 the lip, z = 0 the lane's middle, y from the pad): two
 * posts (thicker the taller the frame, `postThickness`) with a bar and brass plate per `layout.boards` entry and a big labelled sign
 * standing on every major bar, a dashed lip-height line, a translucent tinted back-board between the posts, the net at `layout.netX`
 * and `layout.netHeight` tall, and the run-up's barrels, chevrons and stop block. Five draws, every material shared.
 */
export function makeHighJumpArt(layout: HighJumpLayout, lipY: number): THREE.Group {
  const group = new THREE.Group();
  group.name = "high-jump";
  const woodMaterial = timberMaterial();
  const timber = mergedMesh("timber", timberGeometry(layout, lipY), woodMaterial);
  timber.castShadow = true;
  const netFrame = mergedMesh("net-frame", netFrameGeometry(layout), woodMaterial);
  netFrame.castShadow = true;
  const kicker = mergedMesh("kicker", kickerSupportGeometry(), woodMaterial);
  kicker.castShadow = true;
  const fascia = mergedMesh("fascia", [lipFasciaGeometry()], woodMaterial);
  fascia.castShadow = true;
  const trim = mergedMesh(
    "trim",
    [...frameTrim(layout, lipY), ...lipLine(layout, lipY), ...barrels(), ...chevrons(), ...stopBlock(lipY)],
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.15 }),
  );
  trim.castShadow = true;
  const boards = boardsMesh(layout);
  boards.castShadow = true;
  group.add(timber, netFrame, kicker, fascia, boards, trim, netMesh(layout), backboardMesh(layout, lipY));
  return group;
}
