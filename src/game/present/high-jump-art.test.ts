import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { element, stubBrowser } from "../engine/engine-headless.test-util.ts";
import { LANDING_HEIGHT } from "../scenes/minigame-constants.ts";
import { CAPTURE_HALF_WIDTH, highJumpLayout, POST_HALF_SPAN, POST_THICKNESS } from "../scenes/minigame-high-jump.ts";
import { climbFootX, floorHeightAt } from "../scenes/minigame-profile.ts";
import { makeHighJumpArt, NET_HALF_WIDTH, POST_THICKNESS_PER_METRE } from "./high-jump-art.ts";

/** Most draw calls the High jump's whole art may cost: timber, boards, trim, back-board, net, with room for the composer's own. */
const HIGH_JUMP_DRAW_BUDGET = 12;
const LIP_Y = 7;
/**
 * Made-up measurements (m), the layout's own functions turn them into posts, boards, net and boxes: a short frame whose posts keep the
 * base thickness, the owner's best run (about 155 m) and a frame taller than any run (230 m).
 */
const CASES = [
  { name: "a 18 m crossing", measured: { crossingHeight: 18, landingDistance: 22 } },
  { name: "a 155 m crossing", measured: { crossingHeight: 155, landingDistance: 30 } },
  { name: "a 230 m crossing", measured: { crossingHeight: 230, landingDistance: 34 } },
] as const;
/** Geometry is built from f32 buffers: a position of up to a few hundred metres is good to about 30 micrometres. */
const POSITION_TOLERANCE = 1e-4;
const VERTICES_PER_BOX = new THREE.BoxGeometry().getAttribute("position").count;
const VERTICES_PER_FACE = 4;
/** `BoxGeometry`'s second face is -x: the one the approaching car sees. */
const FRONT_FACE_FIRST_VERTEX = VERTICES_PER_BOX / 6;

/**
 * What a viewer needs to see each part. A pane under this opacity vanishes against a dark sky (the QA shots showed 0.28 as a sliver);
 * a net line under 10 cm is under 2 px at 40 m (60 degrees over 720 px is 6.4 cm per px there); a dash under 20 cm is lost against the
 * strip; a wood grain tile over 10 m is one texture stretched down a pole.
 */
const MIN_BACKBOARD_OPACITY = 0.3;
const MIN_NET_LINE_METRES = 0.1;
const MIN_DASH_THICKNESS = 0.2;
const MAX_TIMBER_TILE_METRES = 10;

type RecordedFill = { x: number; y: number; width: number; height: number };
const recordedCanvases: { width: number; height: number; fills: RecordedFill[] }[] = [];

/** A document whose canvases remember every `fillRect` (other 2d calls are inert), so the weave's painted line width can be read back. */
function recordCanvases(): void {
  Object.assign(document, {
    createElement: () => {
      const fills: RecordedFill[] = [];
      const context: object = new Proxy(
        { fillRect: (x: number, y: number, width: number, height: number) => fills.push({ x, y, width, height }) } as Record<string | symbol, unknown>,
        { get: (target, key) => target[key] ?? (() => context), set: () => true },
      );
      const canvas = Object.assign(element(), { getContext: () => context, fills });
      recordedCanvases.push(canvas);
      return canvas;
    },
  });
}

function meshNamed(group: THREE.Group, name: string): THREE.Mesh {
  const mesh = group.getObjectByName(`high-jump:${name}`);
  assert.ok(mesh instanceof THREE.Mesh, `the art has a "${name}" mesh`);
  return mesh;
}

function vertices(mesh: THREE.Mesh): THREE.Vector3[] {
  const position = mesh.geometry.getAttribute("position");
  return Array.from({ length: position.count }, (_, vertexIndex) => new THREE.Vector3().fromBufferAttribute(position, vertexIndex));
}

const boundsOf = (points: THREE.Vector3[]): THREE.Box3 => new THREE.Box3().setFromPoints(points);

function drawCalls(group: THREE.Group): number {
  let calls = 0;
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) calls += Array.isArray(object.material) ? object.material.length : 1;
  });
  return calls;
}

/** The thickness the frame's posts must have by the rule written in the constants: a slender-ratio of the height, never under the base. */
const expectedPostThickness = (frameTop: number): number => Math.max(POST_THICKNESS, frameTop * POST_THICKNESS_PER_METRE);

describe("given the High jump's art built from a layout", () => {
  before(() => {
    stubBrowser();
    recordCanvases();
  });

  for (const { name, measured } of CASES) {
    const layout = highJumpLayout(measured, LIP_Y);
    const thickness = expectedPostThickness(layout.frameTop);
    const majorBoards = layout.boards.filter((board) => board.major);

    it(`when it is built for ${name}, then each post stands at postsX and one side of the lane, from the pad up to the frame's top (lip + frameTop), as thick as the height rule says`, () => {
      const timber = vertices(meshNamed(makeHighJumpArt(layout, LIP_Y), "timber"));
      for (const side of [-1, 1]) {
        const shaft = boundsOf(
          timber.filter((point) => Math.abs(point.x - layout.postsX) <= thickness / 2 + POSITION_TOLERANCE && Math.sign(point.z) === side && Math.abs(point.z) < 2 * POST_HALF_SPAN),
        );
        assert.ok(Math.abs((shaft.min.x + shaft.max.x) / 2 - layout.postsX) < POSITION_TOLERANCE, `post x centre ${(shaft.min.x + shaft.max.x) / 2}`);
        assert.ok(Math.abs((shaft.min.z + shaft.max.z) / 2 - side * POST_HALF_SPAN) < POSITION_TOLERANCE, `post z centre ${(shaft.min.z + shaft.max.z) / 2}`);
        assert.ok(Math.abs(shaft.min.y - LANDING_HEIGHT) < POSITION_TOLERANCE, `post foot ${shaft.min.y}`);
        assert.ok(Math.abs(shaft.max.y - (LIP_Y + layout.frameTop)) < POSITION_TOLERANCE, `post top ${shaft.max.y}, frame top ${LIP_Y + layout.frameTop}`);
        assert.ok(Math.abs(shaft.max.x - shaft.min.x - thickness) < POSITION_TOLERANCE, `post thickness ${shaft.max.x - shaft.min.x}, rule ${thickness}`);
      }
    });

    it(`when it is built for ${name}, then the posts' grain is in metres, not one texture stretched down the pole`, () => {
      const timber = meshNamed(makeHighJumpArt(layout, LIP_Y), "timber");
      const uv = timber.geometry.getAttribute("uv");
      const frontFace = Array.from({ length: VERTICES_PER_FACE }, (_, corner) => uv.getY(FRONT_FACE_FIRST_VERTEX + corner));
      const postHeight = LIP_Y + layout.frameTop - LANDING_HEIGHT;
      assert.ok((Math.max(...frontFace) - Math.min(...frontFace)) * MAX_TIMBER_TILE_METRES >= postHeight, `the post's front face spans ${Math.max(...frontFace) - Math.min(...frontFace)} tiles over ${postHeight} m`);
    });

    it(`when it is built for ${name}, then each layout board has a bar centred between the posts at its y, and a labelled sign stands above every major bar and never reaches below its line`, () => {
      const boards = meshNamed(makeHighJumpArt(layout, LIP_Y), "boards");
      const points = vertices(boards);
      assert.equal(points.length, (layout.boards.length + majorBoards.length) * VERTICES_PER_BOX, "one bar per board, then one sign per major board");
      const uv = boards.geometry.getAttribute("uv");
      const boxAt = (boxIndex: number) => boundsOf(points.slice(boxIndex * VERTICES_PER_BOX, (boxIndex + 1) * VERTICES_PER_BOX));
      const frontCell = (boxIndex: number) => `${uv.getX(boxIndex * VERTICES_PER_BOX + FRONT_FACE_FIRST_VERTEX).toFixed(4)},${uv.getY(boxIndex * VERTICES_PER_BOX + FRONT_FACE_FIRST_VERTEX).toFixed(4)}`;
      const majorBarHeights: number[] = [];
      const minorBarHeights: number[] = [];
      for (let boardIndex = 0; boardIndex < layout.boards.length; boardIndex++) {
        const board = layout.boards[boardIndex]!;
        const bar = boxAt(boardIndex);
        assert.ok(Math.abs((bar.min.y + bar.max.y) / 2 - board.y) < POSITION_TOLERANCE, `bar ${boardIndex} centre y ${(bar.min.y + bar.max.y) / 2}, expected ${board.y}`);
        assert.ok(Math.abs((bar.min.x + bar.max.x) / 2 - layout.postsX) < POSITION_TOLERANCE, `bar ${boardIndex} sits at the posts' x`);
        assert.ok(Math.abs(bar.min.z + bar.max.z) < POSITION_TOLERANCE, `bar ${boardIndex} is centred on the lane`);
        assert.ok(bar.max.z - bar.min.z <= 2 * POST_HALF_SPAN - thickness + POSITION_TOLERANCE, `bar ${boardIndex} fits between the posts`);
        assert.ok(bar.max.x - bar.min.x <= thickness, `bar ${boardIndex} is no deeper than the posts`);
        (board.major ? majorBarHeights : minorBarHeights).push(bar.max.y - bar.min.y);
      }
      assert.ok(Math.min(...majorBarHeights) > Math.max(...minorBarHeights), "the major bars are thicker than the minor ones");
      const signCells = new Set<string>();
      for (const [signIndex, board] of majorBoards.entries()) {
        const sign = boxAt(layout.boards.length + signIndex);
        assert.ok(sign.min.y >= board.y - POSITION_TOLERANCE, `the sign of the ${board.heightAboveLip} m board reaches down to ${sign.min.y}, below its line ${board.y}`);
        assert.ok(Math.abs((sign.min.x + sign.max.x) / 2 - layout.postsX) < POSITION_TOLERANCE && Math.abs(sign.min.z + sign.max.z) < POSITION_TOLERANCE, `sign ${signIndex} is between the posts`);
        assert.ok(sign.max.y - sign.min.y > 2 * Math.max(...majorBarHeights), `sign ${signIndex} is much bigger than its bar`);
        signCells.add(frontCell(layout.boards.length + signIndex));
      }
      assert.equal(signCells.size, majorBoards.length, "every sign's front face reads a different atlas cell");
      const barCells = new Set(layout.boards.map((board, boardIndex) => `${board.major}:${frontCell(boardIndex)}`));
      assert.equal(barCells.size, 2, "major bars share one cell, minor bars another");
      assert.ok(![...signCells].some((cell) => barCells.has(`true:${cell}`) || barCells.has(`false:${cell}`)), "a sign's label is not a bar's cell");
    });

    it(`when it is built for ${name}, then a bar's brass plates are bigger at the major boards than the minor ones`, () => {
      const trim = vertices(meshNamed(makeHighJumpArt(layout, LIP_Y), "trim"));
      /** The room (m) in front of a post's front face that holds a plate's depth (0.24 m at 6 times the base) but not the lip line's last dash. */
      const PLATE_WINDOW = 0.5;
      /** A plate is a box on the +z post: a box's vertices, which sorted by height make one board's plate each (plates of neighbouring boards do not overlap in height). */
      const plateHeights = trim
        .filter((point) => point.x > layout.postsX - thickness / 2 - PLATE_WINDOW && point.x < layout.postsX - thickness / 2 + POSITION_TOLERANCE && point.z > 0)
        .map((point) => point.y)
        .sort((lower, higher) => lower - higher)
        .reduce<number[][]>((plates, y, vertexIndex) => {
          if (vertexIndex % VERTICES_PER_BOX === 0) plates.push([]);
          plates.at(-1)!.push(y);
          return plates;
        }, [])
        .map((plate) => plate.at(-1)! - plate[0]!);
      assert.equal(plateHeights.length, layout.boards.length, "one plate per board on the post");
      const majorPlates = layout.boards.flatMap((board, boardIndex) => (board.major ? [plateHeights[boardIndex]!] : []));
      const minorPlates = layout.boards.flatMap((board, boardIndex) => (board.major ? [] : [plateHeights[boardIndex]!]));
      assert.ok(Math.min(...majorPlates) > 2 * Math.max(...minorPlates), `major plates ${majorPlates}, minor plates ${minorPlates}`);
    });

    it(`when it is built for ${name}, then the net is netHeight tall at netX, a light alpha-tested single-pass weave with lines wide enough to read, between two end poles that reach its top`, () => {
      const art = makeHighJumpArt(layout, LIP_Y);
      const net = meshNamed(art, "net");
      const box = boundsOf(vertices(net));
      assert.ok(Math.abs(box.min.x - layout.netX) < POSITION_TOLERANCE && Math.abs(box.max.x - layout.netX) < POSITION_TOLERANCE, `net x ${box.min.x}..${box.max.x}, expected ${layout.netX}`);
      assert.ok(box.max.z >= CAPTURE_HALF_WIDTH && box.min.z <= -CAPTURE_HALF_WIDTH, "the net spans the capture band");
      assert.ok(Math.abs(box.max.z - NET_HALF_WIDTH) < POSITION_TOLERANCE && Math.abs(box.min.z + NET_HALF_WIDTH) < POSITION_TOLERANCE, `net z ${box.min.z}..${box.max.z}, NET_HALF_WIDTH ${NET_HALF_WIDTH}`);
      assert.ok(Math.abs(box.min.y - LANDING_HEIGHT) < POSITION_TOLERANCE, "the net hangs from the pad up");
      assert.ok(Math.abs(box.max.y - (LANDING_HEIGHT + layout.netHeight)) < POSITION_TOLERANCE, `net top ${box.max.y}, netHeight ${layout.netHeight}`);
      const material = net.material as THREE.MeshStandardMaterial;
      assert.ok(material.transparent && material.alphaTest > 0 && material.side === THREE.DoubleSide && material.forceSinglePass, "alpha weave, one pass");
      const weave = material.map!;
      assert.ok(weave, "the weave texture");
      assert.equal(weave.generateMipmaps, false, "no mipmaps: a mipped thin line falls under the alpha cut and the far net vanishes");
      assert.equal(weave.minFilter, THREE.LinearFilter);
      assert.ok(material.color.r >= 0.9 && material.color.g >= 0.9 && material.color.b >= 0.9, "a light net, readable against the dark");
      const weaveCanvas = recordedCanvases.filter((canvas) => canvas.width === canvas.height && canvas.fills.length === 2).at(-1)!;
      const linePixels = Math.min(...weaveCanvas.fills.map((fill) => Math.min(fill.width, fill.height)));
      const meshMetres = box.getSize(new THREE.Vector3()).y / weave.repeat.y;
      assert.ok((meshMetres * linePixels) / weaveCanvas.width >= MIN_NET_LINE_METRES - POSITION_TOLERANCE, `net line ${(meshMetres * linePixels) / weaveCanvas.width} m`);
      const poles = boundsOf(vertices(meshNamed(art, "timber")).filter((point) => Math.abs(point.x - layout.netX) < 1));
      assert.ok(Math.abs((poles.min.x + poles.max.x) / 2 - layout.netX) < POSITION_TOLERANCE, `net poles at x ${(poles.min.x + poles.max.x) / 2}`);
      assert.ok(poles.max.z > box.max.z - POSITION_TOLERANCE && poles.min.z < box.min.z + POSITION_TOLERANCE, "the poles stand at the net's ends");
      assert.ok(poles.max.y >= box.max.y, `the poles reach ${poles.max.y}, the net's top ${box.max.y}`);
    });

    it(`when it is built for ${name}, then it costs no more draws than the budget`, () => {
      const calls = drawCalls(makeHighJumpArt(layout, LIP_Y));
      assert.ok(calls <= HIGH_JUMP_DRAW_BUDGET, `${calls} draws, budget ${HIGH_JUMP_DRAW_BUDGET}`);
    });

    it(`when it is built for ${name}, then the back-board is a visibly tinted translucent pane exactly as wide as the gap between the posts' centres, from the lip's height to the frame's top, drawn after the net and not hiding it`, () => {
      const art = makeHighJumpArt(layout, LIP_Y);
      const backboard = meshNamed(art, "backboard");
      const material = backboard.material as THREE.MeshStandardMaterial;
      assert.ok(material.transparent && material.forceSinglePass, "translucent glass, one pass");
      assert.ok(material.opacity >= MIN_BACKBOARD_OPACITY && material.opacity < 1, `pane opacity ${material.opacity}`);
      assert.ok(material.color.getHex() !== 0x1a2832 && material.emissiveIntensity > 0 && material.emissive.getHex() !== 0, "tinted and lit, not the car glass's near-black");
      assert.equal(material.depthWrite, false, "a translucent pane does not write depth over the net behind it");
      assert.ok(backboard.renderOrder > meshNamed(art, "net").renderOrder, "the net draws first, the pane over it");
      const box = boundsOf(vertices(backboard));
      assert.ok(box.min.x >= layout.postsX + thickness / 2, `back-board x ${box.min.x} is behind the posts`);
      assert.ok(box.min.x < layout.postsX + thickness / 2 + 1, "and just behind them");
      assert.ok(Math.abs(box.max.z - POST_HALF_SPAN) < POSITION_TOLERANCE && Math.abs(box.min.z + POST_HALF_SPAN) < POSITION_TOLERANCE, `back-board z ${box.min.z}..${box.max.z}`);
      assert.ok(Math.abs(box.min.y - LIP_Y) < POSITION_TOLERANCE && Math.abs(box.max.y - (LIP_Y + layout.frameTop)) < POSITION_TOLERANCE, `back-board y ${box.min.y}..${box.max.y}`);
    });

    it(`when it is built for ${name}, then steel edge rails frame the pane inside the posts, the boards stand in front of it, and the net behind it`, () => {
      const art = makeHighJumpArt(layout, LIP_Y);
      const pane = boundsOf(vertices(meshNamed(art, "backboard")));
      const trim = vertices(meshNamed(art, "trim"));
      const rails = trim.filter((point) => point.x > pane.min.x - POSITION_TOLERANCE && point.x < pane.min.x + thickness && point.y >= LIP_Y - POSITION_TOLERANCE && point.y <= LIP_Y + layout.frameTop + POSITION_TOLERANCE);
      for (const side of [-1, 1]) {
        const railsBeside = rails.filter((point) => Math.sign(point.z) === side);
        assert.ok(railsBeside.length > 0, `a rail on side ${side}`);
        assert.ok(boundsOf(railsBeside).max.z * side <= POST_HALF_SPAN - thickness / 2 + POSITION_TOLERANCE, "inside the post's inner face");
        assert.ok(Math.abs(boundsOf(railsBeside).max.y - (LIP_Y + layout.frameTop)) < POSITION_TOLERANCE && Math.abs(boundsOf(railsBeside).min.y - LIP_Y) < POSITION_TOLERANCE, "the rail spans the pane's height");
      }
      const boards = boundsOf(vertices(meshNamed(art, "boards")));
      assert.ok(boards.max.x <= pane.min.x + POSITION_TOLERANCE, "the boards are in front of the pane");
      assert.ok(boundsOf(vertices(meshNamed(art, "net"))).min.x > pane.max.x, "the net is behind the pane");
    });

    it(`when it is built for ${name}, then a thick dashed line at the lip's height runs from the lip toward the posts, a stop block stands at the lip, and barrels flank the kicker's foot`, () => {
      const trim = vertices(meshNamed(makeHighJumpArt(layout, LIP_Y), "trim"));
      const lipLine = trim.filter((point) => Math.abs(point.y - LIP_Y) <= MIN_DASH_THICKNESS && Math.abs(Math.abs(point.z) - POST_HALF_SPAN) <= MIN_DASH_THICKNESS && point.x >= 0 && point.x < layout.postsX - thickness);
      const firstDash = boundsOf(lipLine.filter((point) => point.x < POSITION_TOLERANCE + 1));
      assert.ok(firstDash.max.y - firstDash.min.y >= MIN_DASH_THICKNESS && firstDash.max.z - firstDash.min.z >= MIN_DASH_THICKNESS, `dash cross-section ${firstDash.getSize(new THREE.Vector3()).toArray()}`);
      assert.ok(Math.abs(firstDash.min.x) < POSITION_TOLERANCE, "the line starts at the lip");
      const reach = boundsOf(lipLine);
      assert.ok(reach.max.x <= layout.postsX && reach.max.x > layout.postsX / 2, `dashes run to x ${reach.max.x}`);
      assert.ok(trim.some((point) => Math.abs(point.x) <= 0.2 && point.y > LIP_Y + 0.3), "a stop block rises at the lip");
      const foot = climbFootX("highJump");
      const floorY = floorHeightAt("highJump", foot, 0);
      for (const side of [-1, 1]) {
        assert.ok(
          trim.some((point) => Math.abs(point.x - foot) <= 2 && Math.sign(point.z) === side && point.y > floorY + 0.8 && point.y < floorY + 1.5),
          `a barrel on side ${side}`,
        );
      }
    });
  }
});
