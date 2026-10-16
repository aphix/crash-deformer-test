import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { stubBrowser } from "../engine/engine-headless.test-util.ts";
import { LANDING_HEIGHT } from "../scenes/minigame-constants.ts";
import { CAPTURE_HALF_WIDTH, highJumpLayout, POST_HALF_SPAN, POST_THICKNESS } from "../scenes/minigame-high-jump.ts";
import { climbFootX, floorHeightAt } from "../scenes/minigame-profile.ts";
import { HIGH_JUMP_DRAW_BUDGET, makeHighJumpArt } from "./high-jump-art.ts";

/** Made-up measurements (m): the layout's own functions turn them into posts, boards, net and boxes. */
const MEASURED = { apexHeight: 18, apexDistance: 14, landingDistance: 22 };
const LIP_Y = 7;
const layout = highJumpLayout(MEASURED, LIP_Y);
/** Geometry is built from f32 buffers: positions equal to within a micrometre. */
const POSITION_TOLERANCE = 1e-6;
const VERTICES_PER_BOX = new THREE.BoxGeometry().getAttribute("position").count;

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

describe("given the High jump's art built from a layout", () => {
  before(stubBrowser);

  it("when it is built, then each post stands at postsX and one side of the lane, from the pad up to the frame's top (lip + frameTop)", () => {
    const timber = vertices(meshNamed(makeHighJumpArt(layout, LIP_Y), "timber"));
    for (const side of [-1, 1]) {
      const shaft = boundsOf(timber.filter((point) => Math.abs(point.x - layout.postsX) <= POST_THICKNESS / 2 + POSITION_TOLERANCE && Math.sign(point.z) === side && Math.abs(point.z) < 2 * POST_HALF_SPAN));
      assert.ok(Math.abs((shaft.min.x + shaft.max.x) / 2 - layout.postsX) < POSITION_TOLERANCE, `post x centre ${(shaft.min.x + shaft.max.x) / 2}`);
      assert.ok(Math.abs((shaft.min.z + shaft.max.z) / 2 - side * POST_HALF_SPAN) < POSITION_TOLERANCE, `post z centre ${(shaft.min.z + shaft.max.z) / 2}`);
      assert.ok(Math.abs(shaft.min.y - LANDING_HEIGHT) < POSITION_TOLERANCE, `post foot ${shaft.min.y}`);
      assert.ok(Math.abs(shaft.max.y - (LIP_Y + layout.frameTop)) < POSITION_TOLERANCE, `post top ${shaft.max.y}, frame top ${LIP_Y + layout.frameTop}`);
    }
  });

  it("when it is built, then there is one board per layout board, centred between the posts at that board's y, each labelled from its own cell of the atlas", () => {
    const boards = meshNamed(makeHighJumpArt(layout, LIP_Y), "boards");
    const points = vertices(boards);
    assert.equal(points.length, layout.boards.length * VERTICES_PER_BOX, "boards merged from one box each");
    const uv = boards.geometry.getAttribute("uv");
    const labelCells = new Set<string>();
    for (let boardIndex = 0; boardIndex < layout.boards.length; boardIndex++) {
      const first = boardIndex * VERTICES_PER_BOX;
      const board = layout.boards[boardIndex]!;
      const box = boundsOf(points.slice(first, first + VERTICES_PER_BOX));
      assert.ok(Math.abs((box.min.y + box.max.y) / 2 - board.y) < POSITION_TOLERANCE, `board ${boardIndex} centre y ${(box.min.y + box.max.y) / 2}, expected ${board.y}`);
      assert.ok(Math.abs((box.min.x + box.max.x) / 2 - layout.postsX) < POSITION_TOLERANCE, `board ${boardIndex} sits at the posts' x`);
      assert.ok(Math.abs(box.min.z + box.max.z) < POSITION_TOLERANCE, `board ${boardIndex} is centred on the lane`);
      assert.ok(box.max.z - box.min.z <= 2 * POST_HALF_SPAN, `board ${boardIndex} fits between the posts`);
      const front = Array.from({ length: VERTICES_PER_BOX }, (_, offset) => first + offset).filter((vertexIndex) => Math.abs(points[vertexIndex]!.x - box.min.x) < POSITION_TOLERANCE);
      labelCells.add(`${uv.getX(front[0]!).toFixed(4)},${uv.getY(front[0]!).toFixed(4)}`);
    }
    assert.equal(labelCells.size, layout.boards.length, "every board's front face reads a different cell");
    const majorHeights = layout.boards.flatMap((board, boardIndex) => (board.major ? [boundsOf(points.slice(boardIndex * VERTICES_PER_BOX, (boardIndex + 1) * VERTICES_PER_BOX)).getSize(new THREE.Vector3()).y] : []));
    const minorHeights = layout.boards.flatMap((board, boardIndex) => (board.major ? [] : [boundsOf(points.slice(boardIndex * VERTICES_PER_BOX, (boardIndex + 1) * VERTICES_PER_BOX)).getSize(new THREE.Vector3()).y]));
    assert.ok(Math.min(...majorHeights) > Math.max(...minorHeights), "the major boards are the bigger ones");
  });

  it("when it is built, then the net is an alpha-tested single-pass weave at netX across the capture band and above the frame, between two end poles at netX", () => {
    const art = makeHighJumpArt(layout, LIP_Y);
    const net = meshNamed(art, "net");
    const box = boundsOf(vertices(net));
    assert.ok(Math.abs(box.min.x - layout.netX) < POSITION_TOLERANCE && Math.abs(box.max.x - layout.netX) < POSITION_TOLERANCE, `net x ${box.min.x}..${box.max.x}, expected ${layout.netX}`);
    assert.ok(box.max.z >= CAPTURE_HALF_WIDTH && box.min.z <= -CAPTURE_HALF_WIDTH, "the net spans the capture band");
    assert.ok(Math.abs(box.min.y - LANDING_HEIGHT) < POSITION_TOLERANCE, "the net hangs from the pad up");
    assert.ok(box.max.y >= LIP_Y + layout.frameTop, "the net reaches above the frame");
    const material = net.material as THREE.MeshStandardMaterial;
    assert.ok(material.transparent && material.alphaTest > 0 && material.side === THREE.DoubleSide && material.forceSinglePass, "alpha weave, one pass");
    assert.ok(material.map, "the weave texture");
    const poles = boundsOf(vertices(meshNamed(art, "timber")).filter((point) => point.x > layout.postsX + POST_THICKNESS));
    assert.ok(Math.abs((poles.min.x + poles.max.x) / 2 - layout.netX) < POSITION_TOLERANCE, `net poles at x ${(poles.min.x + poles.max.x) / 2}`);
    assert.ok(poles.max.z > box.max.z - POSITION_TOLERANCE && poles.min.z < box.min.z + POSITION_TOLERANCE, "the poles stand at the net's ends");
  });

  it("when it is built, then it costs no more draws than the budget", () => {
    const calls = drawCalls(makeHighJumpArt(layout, LIP_Y));
    assert.ok(calls <= HIGH_JUMP_DRAW_BUDGET, `${calls} draws, budget ${HIGH_JUMP_DRAW_BUDGET}`);
  });

  it("when it is built, then the back-board is a see-through pane just behind the posts, wider than the frame and reaching above it", () => {
    const backboard = meshNamed(makeHighJumpArt(layout, LIP_Y), "backboard");
    const material = backboard.material as THREE.MeshStandardMaterial;
    assert.ok(material.transparent && material.opacity < 1 && material.forceSinglePass, "translucent glass, one pass");
    const box = boundsOf(vertices(backboard));
    assert.ok(box.min.x >= layout.postsX + POST_THICKNESS / 2, `back-board x ${box.min.x} is behind the posts`);
    assert.ok(box.max.z > POST_HALF_SPAN + POST_THICKNESS / 2 && box.min.z < -(POST_HALF_SPAN + POST_THICKNESS / 2), "wider than the frame");
    assert.ok(box.max.y > LIP_Y + layout.frameTop, "taller than the frame");
  });

  it("when it is built, then a dashed line at the lip's height runs from the lip toward the posts, a stop block stands at the lip, and barrels flank the kicker's foot", () => {
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
});
