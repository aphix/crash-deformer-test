import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { RANGE } from "../scenes/range.ts";
import { groundMesh } from "../scenes/ground-stack.ts";

/** Distance signs: board size (m), board centre height, and how far outside the field's left edge (−z) they stand. */
const BOARD_W = 2.6;
const BOARD_H = 1.3;
const BOARD_Y = 2;
const BOARD_OUT = 1.5;

/**
 * The ejection range's art (`RANGE`): a sand field from the wall at the origin down +x, a low kerb round it, and a
 * numbered sign on two posts every `RANGE.signStep` m along its left edge, facing back up the range. Four draws,
 * shown only in the range scene.
 */
export function makeRangeArt(): THREE.Group {
  const g = new THREE.Group();
  g.name = "range";
  const { length: L, halfWidth: W } = RANGE;
  const sand = groundMesh(
    new THREE.PlaneGeometry(L, W * 2).rotateX(-Math.PI / 2).translate(L / 2, 0.012, 0),
    new THREE.MeshStandardMaterial({ color: 0xc8a466, roughness: 1, metalness: 0 }),
    "runoff",
  );
  sand.receiveShadow = true;
  const kerbs = [
    new THREE.BoxGeometry(L, 0.12, 0.4).translate(L / 2, 0.06, -W - 0.2),
    new THREE.BoxGeometry(L, 0.12, 0.4).translate(L / 2, 0.06, W + 0.2),
    new THREE.BoxGeometry(0.4, 0.12, W * 2 + 0.8).translate(L + 0.2, 0.06, 0),
  ];
  const kerb = new THREE.Mesh(mergeGeometries(kerbs)!, new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.85 }));
  kerb.receiveShadow = true;

  // One atlas, 5 × 2 cells of 256 × 128 px: "10" … "100", black on scuffed yellow.
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const boards: THREE.BufferGeometry[] = [];
  const posts: THREE.BufferGeometry[] = [];
  const z = -W - BOARD_OUT;
  for (let k = 0; k < RANGE.signs; k++) {
    const col = k % 5;
    const row = Math.floor(k / 5);
    const x0 = col * 256;
    const y0 = row * 128;
    ctx.fillStyle = "#e3b93f";
    ctx.fillRect(x0 + 4, y0 + 4, 248, 120);
    ctx.strokeStyle = "#6b5419";
    ctx.lineWidth = 6;
    ctx.strokeRect(x0 + 7, y0 + 7, 242, 114);
    ctx.fillStyle = "#16130c";
    ctx.font = "bold 92px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String((k + 1) * RANGE.signStep), x0 + 128, y0 + 68);
    const d = (k + 1) * RANGE.signStep;
    // Facing −x (back toward the wall): a +z plane turned −90° about y.
    const board = new THREE.PlaneGeometry(BOARD_W, BOARD_H).rotateY(-Math.PI / 2).translate(d, BOARD_Y, z);
    const uv = board.getAttribute("uv");
    for (let i = 0; i < uv.count; i++) uv.setXY(i, (col + uv.getX(i)) / 5, 1 - (row + 1 - uv.getY(i)) / 2);
    boards.push(board);
    const postH = BOARD_Y - BOARD_H / 2;
    for (const dz of [-BOARD_W * 0.35, BOARD_W * 0.35]) posts.push(new THREE.BoxGeometry(0.1, postH, 0.1).translate(d + 0.06, postH / 2, z + dz));
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const signs = new THREE.Mesh(mergeGeometries(boards)!, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8, side: THREE.DoubleSide }));
  signs.castShadow = true;
  const stakes = new THREE.Mesh(mergeGeometries(posts)!, new THREE.MeshStandardMaterial({ color: 0x5a4a32, roughness: 0.9 }));
  stakes.castShadow = true;
  for (const geo of [...kerbs, ...boards, ...posts]) geo.dispose();
  g.add(sand, kerb, signs, stakes);
  g.visible = false;
  return g;
}
