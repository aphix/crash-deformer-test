import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { stubBrowser } from "../engine/engine-headless.test-util.ts";
import { LANDING_HEIGHT } from "../scenes/minigame-constants.ts";
import { CAPTURE_HALF_WIDTH, highJumpLayout, POST_HALF_SPAN, POST_THICKNESS } from "../scenes/minigame-high-jump.ts";
import { climbFootX, floorHeightAt } from "../scenes/minigame-profile.ts";
import { HIGH_JUMP_DRAW_BUDGET, makeHighJumpArt, NET_HALF_WIDTH, POST_THICKNESS_PER_METRE } from "./high-jump-art.ts";

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
/** `BoxGeometry`'s second face is -x: the one the approaching car sees. */
const FRONT_FACE_FIRST_VERTEX = VERTICES_PER_BOX / 6;

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
  before(stubBrowser);

  for (const { name, measured } of CASES) {
    const layout = highJumpLayout(measured, LIP_Y);
    const thickness = expectedPostThickness(layout.frameTop);

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

    it(`when it is built for ${name}, then there is one board per layout board centred between the posts at that board's y, the major ones bigger and each labelled from its own atlas cell, the minor ones plain`, () => {
      const boards = meshNamed(makeHighJumpArt(layout, LIP_Y), "boards");
      const points = vertices(boards);
      assert.equal(points.length, layout.boards.length * VERTICES_PER_BOX, "boards merged from one box each");
      const uv = boards.geometry.getAttribute("uv");
      const majorCells = new Set<string>();
      const minorCells = new Set<string>();
      const majorHeights: number[] = [];
      const minorHeights: number[] = [];
      for (let boardIndex = 0; boardIndex < layout.boards.length; boardIndex++) {
        const first = boardIndex * VERTICES_PER_BOX;
        const board = layout.boards[boardIndex]!;
        const box = boundsOf(points.slice(first, first + VERTICES_PER_BOX));
        assert.ok(Math.abs((box.min.y + box.max.y) / 2 - board.y) < POSITION_TOLERANCE, `board ${boardIndex} centre y ${(box.min.y + box.max.y) / 2}, expected ${board.y}`);
        assert.ok(Math.abs((box.min.x + box.max.x) / 2 - layout.postsX) < POSITION_TOLERANCE, `board ${boardIndex} sits at the posts' x`);
        assert.ok(Math.abs(box.min.z + box.max.z) < POSITION_TOLERANCE, `board ${boardIndex} is centred on the lane`);
        assert.ok(box.max.z - box.min.z <= 2 * POST_HALF_SPAN - thickness + POSITION_TOLERANCE, `board ${boardIndex} fits between the posts`);
        assert.ok(box.max.x - box.min.x <= thickness, `board ${boardIndex} is no deeper than the posts`);
        const frontVertex = first + FRONT_FACE_FIRST_VERTEX;
        const cell = `${uv.getX(frontVertex).toFixed(4)},${uv.getY(frontVertex).toFixed(4)}`;
        (board.major ? majorCells : minorCells).add(cell);
        (board.major ? majorHeights : minorHeights).push(box.max.y - box.min.y);
      }
      assert.equal(majorCells.size, layout.boards.filter((board) => board.major).length, "every major board's front face reads a different cell");
      assert.equal(minorCells.size, 1, "every minor board reads the one plain cell");
      assert.ok(!majorCells.has([...minorCells][0]!), "the plain cell is not a label");
      assert.ok(Math.min(...majorHeights) >= 4 * Math.max(...minorHeights), "the major boards are much bigger than the minor ones");
    });

    it(`when it is built for ${name}, then the net is netHeight tall at netX, an alpha-tested single-pass weave across the capture band, between two end poles that reach its top`, () => {
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
      assert.ok(material.map, "the weave texture");
      const poles = boundsOf(vertices(meshNamed(art, "timber")).filter((point) => Math.abs(point.x - layout.netX) < 1));
      assert.ok(Math.abs((poles.min.x + poles.max.x) / 2 - layout.netX) < POSITION_TOLERANCE, `net poles at x ${(poles.min.x + poles.max.x) / 2}`);
      assert.ok(poles.max.z > box.max.z - POSITION_TOLERANCE && poles.min.z < box.min.z + POSITION_TOLERANCE, "the poles stand at the net's ends");
      assert.ok(poles.max.y >= box.max.y, `the poles reach ${poles.max.y}, the net's top ${box.max.y}`);
    });

    it(`when it is built for ${name}, then it costs no more draws than the budget`, () => {
      const calls = drawCalls(makeHighJumpArt(layout, LIP_Y));
      assert.ok(calls <= HIGH_JUMP_DRAW_BUDGET, `${calls} draws, budget ${HIGH_JUMP_DRAW_BUDGET}`);
    });

    it(`when it is built for ${name}, then the back-board is a see-through pane just behind the posts, wider than the frame and reaching above it`, () => {
      const backboard = meshNamed(makeHighJumpArt(layout, LIP_Y), "backboard");
      const material = backboard.material as THREE.MeshStandardMaterial;
      assert.ok(material.transparent && material.opacity < 1 && material.forceSinglePass, "translucent glass, one pass");
      const box = boundsOf(vertices(backboard));
      assert.ok(box.min.x >= layout.postsX + thickness / 2, `back-board x ${box.min.x} is behind the posts`);
      assert.ok(box.max.z > POST_HALF_SPAN + thickness / 2 && box.min.z < -(POST_HALF_SPAN + thickness / 2), "wider than the frame");
      assert.ok(box.max.y > LIP_Y + layout.frameTop, "taller than the frame");
    });

    it(`when it is built for ${name}, then a dashed line at the lip's height runs from the lip toward the posts, a stop block stands at the lip, and barrels flank the kicker's foot`, () => {
      const trim = vertices(meshNamed(makeHighJumpArt(layout, LIP_Y), "trim"));
      const dashes = trim.filter((point) => point.x > 1 && Math.abs(point.y - LIP_Y) < 0.1 && Math.abs(Math.abs(point.z) - POST_HALF_SPAN) < 0.1);
      assert.ok(dashes.length > 0, "dashes at the lip's height over the post lanes");
      const reach = boundsOf(dashes);
      assert.ok(reach.max.x <= layout.postsX && reach.max.x > layout.postsX / 2, `dashes run to x ${reach.max.x}`);
      assert.ok(trim.some((point) => Math.abs(point.x) < POSITION_TOLERANCE && Math.abs(point.y - LIP_Y) < 0.1 && Math.abs(Math.abs(point.z) - POST_HALF_SPAN) < 0.1), "the line starts at the lip");
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
