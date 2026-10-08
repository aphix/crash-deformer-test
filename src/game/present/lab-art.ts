import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { BENCH, BOARD, BOARD_T, BRACKET_T, FLOOR, LAB_BACK, LAB_LAYOUTS, LAB_SCALE, labPlaced, labSurfaces, PEG, ROOM_H, ROOM_HALF_W, type LabPresetId } from "../scenes/lab.ts";
import { makePrefabMaterials, makeRaceTextures, type RaceTextures } from "./prefabs.ts";
import { PropTumble } from "./prop-tumble.ts";
import { DEPTH_INSTANCED, DEPTH_INSTANCED_COLOR } from "./track-mesh.ts";

/** The bench top's thickness (m): a 1¾ in butcher block. */
const TOP_T = 0.0445 * LAB_SCALE;
/** A bench leg's side (m): 3½ in timber. */
const LEG = 0.089 * LAB_SCALE;
/** Real metres to the set's (the workshop is 24 times its real size). */
const S = LAB_SCALE;

/** The workshop's light: cool overhead tubes, warm fill, the far corners falling off to a dim brown (`WorldStage.look`). */
export const LAB_LIGHT = { sun: "#eef2f8", sunIntensity: 2.3, hemi: "#cfc6b8", fill: "#ffd3a1", sky: "#1f1b17" };

const CHROME = 0xc9cdd3;
const DARK_STEEL = 0x3d4147;

/** One preset's own things: its brackets and shelves, and its props (drawn and knocked by `props`). */
type LabSet = { group: THREE.Group; props: PropTumble };

/** A repeating sRGB canvas texture of `w` × `h` px drawn by `draw`. */
function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d")!);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

/** One pegboard cell: tan hardboard with a ¼ in hole in its middle (the hole pitch is `PEG`). */
function pegCell(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#b8895a";
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "#a57a4e";
  for (let i = 0; i < 6; i++) ctx.fillRect(0, i * 11 + 3, 64, 1);
  ctx.fillStyle = "#d3a676";
  ctx.beginPath();
  ctx.arc(32, 33, 9.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1c130b";
  ctx.beginPath();
  ctx.arc(32, 32, 8, 0, Math.PI * 2);
  ctx.fill();
}

/** Butcher block: strips of maple and beech of a few shades, with grain lines. */
function butcherBlock(ctx: CanvasRenderingContext2D): void {
  const shades = ["#c99a62", "#b9874f", "#d4a872", "#a97a46", "#c28f58", "#d9b17d", "#b07f4a", "#c79b66"];
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = shades[(i * 5) % shades.length]!;
    ctx.fillRect(0, i * 32, 512, 32);
    ctx.fillStyle = "rgba(60,36,14,0.18)";
    for (let g = 0; g < 5; g++) ctx.fillRect(0, i * 32 + 4 + g * 6 + ((i * 7 + g * 3) % 4), 512, 1);
    ctx.fillStyle = "rgba(40,24,8,0.5)";
    ctx.fillRect(0, i * 32, 512, 1);
  }
}

/** Painted cinder block, running bond: a 0.8 m tile of two blocks by four courses, mortar showing between. */
function cinderBlock(ctx: CanvasRenderingContext2D): void {
  const shades = ["#b9b4a9", "#b3aea2", "#bdb8ad", "#b6b1a6", "#c0bbb0"];
  ctx.fillStyle = "#8d887e";
  ctx.fillRect(0, 0, 256, 256);
  for (let r = 0; r < 4; r++) {
    for (let b = -1; b < 2; b++) {
      ctx.fillStyle = shades[(r * 3 + b + 1) % shades.length]!;
      ctx.fillRect(b * 128 + (r % 2) * 64 + 2, r * 64 + 2, 124, 60);
    }
  }
}

/** Trowelled concrete, mottled, with a control joint along two edges: one 3 m slab per tile. */
function concrete(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#86837c";
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 900; i++) {
    // A fixed scatter (no Math.random): the floor looks the same every visit.
    const h = Math.imul(i + 1, 2654435761) >>> 0;
    ctx.fillStyle = h & 1 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)";
    ctx.fillRect(h % 512, (h >>> 9) % 512, 6 + (h >>> 20) % 26, 4 + (h >>> 25) % 18);
  }
  ctx.fillStyle = "rgba(30,28,24,0.7)";
  ctx.fillRect(0, 0, 512, 3);
  ctx.fillRect(0, 0, 3, 512);
}

/** A 1 m steel rule: millimetre ticks, longer every 5 and 10, the centimetres numbered. */
function steelRule(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#c6ccd2";
  ctx.fillRect(0, 0, 2048, 64);
  ctx.fillStyle = "#1d2024";
  ctx.font = "bold 13px sans-serif";
  for (let mm = 1; mm < 1000; mm++) {
    const x = Math.round((mm * 2048) / 1000);
    const len = mm % 10 === 0 ? 26 : mm % 5 === 0 ? 18 : 11;
    ctx.fillRect(x, 0, 1, len);
    if (mm % 10 === 0) ctx.fillText(String(mm / 10), x - (mm < 100 ? 4 : 8), 44);
  }
}

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _one = new THREE.Vector3(1, 1, 1);
const _c = new THREE.Color();

/** `geo` turned by (rx, ry, rz), moved to (x, y, z) and painted `hex` (sRGB): one part of a merged, vertex-coloured mesh. */
function part(geo: THREE.BufferGeometry, hex: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
  geo.applyMatrix4(_m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _one));
  _c.setHex(hex);
  const n = geo.getAttribute("position").count;
  const rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    rgb[i * 3] = _c.r;
    rgb[i * 3 + 1] = _c.g;
    rgb[i * 3 + 2] = _c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
  return geo;
}

/** One mesh of `parts` (disposed once merged) in `mat`, casting and taking shadows. */
function merged(parts: THREE.BufferGeometry[], mat: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(mergeGeometries(parts)!, mat);
  for (const g of parts) g.dispose();
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** The board's face (m) a thing `depth` real m thick hangs against, centred in its depth. */
const onBoard = (depth: number): number => BOARD.z + (depth / 2) * S;

/** A pegboard hook at board point (u, v) (real m from the board's bottom middle), snapped to the nearest hole. */
function hook(u: number, v: number): THREE.BufferGeometry {
  const x = Math.round((u * S) / PEG) * PEG;
  const y = Math.round((v * S) / PEG) * PEG;
  return part(new THREE.CylinderGeometry(0.0028 * S, 0.0028 * S, 0.05 * S, 6), CHROME, x, y, onBoard(0.05), Math.PI / 2);
}

/** A combination wrench `len` real m long hung ring up on a hook, its ring's middle at board point (u, v). */
function wrench(len: number, u: number, v: number): THREE.BufferGeometry[] {
  const L = len * S;
  const x = u * S;
  const top = v * S;
  const z = onBoard(0.006);
  const ring = L * 0.075;
  const tube = L * 0.022;
  const jaw = top - L * 0.85;
  return [
    part(new THREE.TorusGeometry(ring, tube, 6, 18), CHROME, x, top, z),
    part(new THREE.BoxGeometry(L * 0.07, L * 0.85 - 2 * ring, tube * 1.2), CHROME, x, (top + jaw) / 2, z),
    // The open end: a C whose gap faces down.
    part(new THREE.TorusGeometry(ring, tube, 6, 14, Math.PI * 1.3), CHROME, x, jaw, z, 0, 0, -Math.PI * 0.15),
    hook(u, v + 0.004),
  ];
}

/** A claw hammer hung head up on two hooks, the head's middle at board point (u, v). */
function hammer(u: number, v: number): { steel: THREE.BufferGeometry[]; paint: THREE.BufferGeometry[] } {
  const x = u * S;
  const y = v * S;
  const z = onBoard(0.034);
  return {
    steel: [
      part(new THREE.BoxGeometry(0.1 * S, 0.034 * S, 0.03 * S), DARK_STEEL, x, y, z),
      part(new THREE.CylinderGeometry(0.017 * S, 0.017 * S, 0.03 * S, 12), DARK_STEEL, x - 0.06 * S, y, z, 0, 0, Math.PI / 2),
      part(new THREE.BoxGeometry(0.06 * S, 0.016 * S, 0.024 * S), DARK_STEEL, x + 0.075 * S, y - 0.012 * S, z, 0, 0, -0.45),
      hook(u - 0.03, v - 0.03),
      hook(u + 0.03, v - 0.03),
    ],
    paint: [
      part(new THREE.CylinderGeometry(0.014 * S, 0.016 * S, 0.3 * S, 10), 0xcf9e5f, x, y - 0.16 * S, z),
      part(new THREE.CylinderGeometry(0.019 * S, 0.019 * S, 0.11 * S, 10), 0x26282b, x, y - 0.26 * S, z),
    ],
  };
}

/** A rack of three screwdrivers, handles up, the rack's middle at board point (u, v). */
function screwdrivers(u: number, v: number): { steel: THREE.BufferGeometry[]; paint: THREE.BufferGeometry[] } {
  const handles = [0xc0392b, 0xe8a317, 0x2c6db5];
  const y = v * S;
  const z = onBoard(0.05);
  return {
    steel: [
      part(new THREE.BoxGeometry(0.17 * S, 0.012 * S, 0.05 * S), DARK_STEEL, u * S, y, z),
      ...handles.map((_, i) => part(new THREE.CylinderGeometry(0.0035 * S, 0.0035 * S, 0.13 * S, 6), CHROME, (u - 0.05 + i * 0.05) * S, y - 0.065 * S, z)),
    ],
    paint: handles.map((c, i) => part(new THREE.CylinderGeometry(0.015 * S, 0.012 * S, 0.1 * S, 8), c, (u - 0.05 + i * 0.05) * S, y + 0.056 * S, z)),
  };
}

/** A hand saw hung level, teeth down, its blade's middle at board point (u, v) and its handle to the right. */
function saw(u: number, v: number): { steel: THREE.BufferGeometry[]; paint: THREE.BufferGeometry[] } {
  const z = onBoard(0.025);
  return {
    steel: [part(new THREE.BoxGeometry(0.46 * S, 0.1 * S, 0.0015 * S), 0xd9dde1, u * S, v * S, onBoard(0.0015)), hook(u + 0.12, v + 0.06), hook(u - 0.12, v + 0.06)],
    paint: [part(new THREE.BoxGeometry(0.12 * S, 0.12 * S, 0.025 * S), 0x8f5428, (u + 0.29) * S, (v + 0.005) * S, z)],
  };
}

/** A spirit level hung level on two hooks, its middle at board point (u, v). */
function level(u: number, v: number): { steel: THREE.BufferGeometry[]; paint: THREE.BufferGeometry[] } {
  const z = onBoard(0.028);
  return {
    steel: [hook(u - 0.2, v - 0.03), hook(u + 0.2, v - 0.03)],
    paint: [
      part(new THREE.BoxGeometry(0.6 * S, 0.06 * S, 0.028 * S), 0xe5b628, u * S, v * S, z),
      part(new THREE.BoxGeometry(0.05 * S, 0.02 * S, 0.006 * S), 0x86d46e, u * S, v * S, z + 0.016 * S),
      part(new THREE.BoxGeometry(0.05 * S, 0.02 * S, 0.006 * S), 0x86d46e, (u - 0.2) * S, v * S, z + 0.016 * S),
    ],
  };
}

/** Slip-joint pliers hung jaws up, the pivot at board point (u, v). */
function pliers(u: number, v: number): { steel: THREE.BufferGeometry[]; paint: THREE.BufferGeometry[] } {
  const x = u * S;
  const y = v * S;
  const z = onBoard(0.014);
  return {
    steel: [
      part(new THREE.BoxGeometry(0.016 * S, 0.05 * S, 0.012 * S), DARK_STEEL, x - 0.003 * S, y + 0.027 * S, z, 0, 0, 0.06),
      part(new THREE.BoxGeometry(0.016 * S, 0.05 * S, 0.012 * S), DARK_STEEL, x + 0.003 * S, y + 0.027 * S, z, 0, 0, -0.06),
      part(new THREE.CylinderGeometry(0.009 * S, 0.009 * S, 0.018 * S, 10), CHROME, x, y, z, Math.PI / 2),
      hook(u, v + 0.06),
    ],
    paint: [
      part(new THREE.BoxGeometry(0.018 * S, 0.13 * S, 0.013 * S), 0xb8322a, x - 0.012 * S, y - 0.07 * S, z, 0, 0, -0.13),
      part(new THREE.BoxGeometry(0.018 * S, 0.13 * S, 0.013 * S), 0xb8322a, x + 0.012 * S, y - 0.07 * S, z, 0, 0, 0.13),
    ],
  };
}

/** A coffee mug standing on the bench at (x, z) (m). */
function mug(x: number, z: number): THREE.BufferGeometry[] {
  const wall = [new THREE.Vector2(0.0001, 0), new THREE.Vector2(0.04, 0), new THREE.Vector2(0.042, 0.095), new THREE.Vector2(0.037, 0.095), new THREE.Vector2(0.035, 0.012), new THREE.Vector2(0.0001, 0.012)];
  for (const p of wall) p.multiplyScalar(S);
  return [
    part(new THREE.LatheGeometry(wall, 28), 0xa8322b, x, 0, z),
    part(new THREE.CylinderGeometry(0.036 * S, 0.036 * S, 0.002 * S, 24), 0x2b1a10, x, 0.075 * S, z),
    part(new THREE.TorusGeometry(0.026 * S, 0.0075 * S, 8, 16, Math.PI), 0xa8322b, x + 0.041 * S, 0.05 * S, z, 0, 0, -Math.PI / 2),
  ];
}

/** A tape measure lying on the bench at (x, z) (m), its tape run out 15 cm along +x. */
function tape(x: number, z: number): { steel: THREE.BufferGeometry[]; paint: THREE.BufferGeometry[] } {
  return {
    steel: [part(new THREE.BoxGeometry(0.002 * S, 0.012 * S, 0.019 * S), CHROME, x + 0.19 * S, 0.006 * S, z)],
    paint: [
      part(new THREE.BoxGeometry(0.075 * S, 0.075 * S, 0.04 * S), 0xf2c230, x, 0.0375 * S, z),
      part(new THREE.CylinderGeometry(0.03 * S, 0.03 * S, 0.042 * S, 20), 0x1f2124, x, 0.0375 * S, z, Math.PI / 2),
      part(new THREE.BoxGeometry(0.15 * S, 0.0015 * S, 0.019 * S), 0xf2c230, x + 0.115 * S, 0.00075 * S, z),
    ],
  };
}

/** A pencil lying on the bench along x, its tip at (x, z) (m). */
function pencil(x: number, z: number): THREE.BufferGeometry[] {
  const r = 0.0035 * S;
  return [
    part(new THREE.CylinderGeometry(r, r, 0.15 * S, 6), 0xf0c419, x - 0.095 * S, r, z, 0, 0, Math.PI / 2),
    part(new THREE.ConeGeometry(r, 0.02 * S, 6), 0xe3bf8f, x - 0.01 * S, r, z, 0, 0, -Math.PI / 2),
    part(new THREE.CylinderGeometry(r * 1.05, r * 1.05, 0.012 * S, 8), 0xb9bec4, x - 0.176 * S, r, z, 0, 0, Math.PI / 2),
    part(new THREE.CylinderGeometry(r, r, 0.01 * S, 8), 0xe58a96, x - 0.187 * S, r, z, 0, 0, Math.PI / 2),
  ];
}

/** Three hex nuts and a bolt on the bench around (x, z) (m). */
function hardware(x: number, z: number): THREE.BufferGeometry[] {
  return [
    part(new THREE.CylinderGeometry(0.012 * S, 0.012 * S, 0.01 * S, 6), CHROME, x, 0.005 * S, z),
    part(new THREE.CylinderGeometry(0.012 * S, 0.012 * S, 0.01 * S, 6), CHROME, x + 0.05 * S, 0.005 * S, z + 0.02 * S, 0, 0.4),
    part(new THREE.CylinderGeometry(0.009 * S, 0.009 * S, 0.008 * S, 6), CHROME, x + 0.02 * S, 0.004 * S, z - 0.035 * S, 0, 0.9),
    part(new THREE.CylinderGeometry(0.006 * S, 0.006 * S, 0.07 * S, 10), CHROME, x - 0.06 * S, 0.006 * S, z + 0.01 * S, 0, 0.5, Math.PI / 2),
    part(new THREE.CylinderGeometry(0.011 * S, 0.011 * S, 0.007 * S, 6), CHROME, x - 0.098 * S, 0.011 * S, z + 0.032 * S, 0, 0.5, Math.PI / 2),
  ];
}

/** A 16 ft sectional garage door in the far side wall (x = `ROOM_HALF_W`), facing the bench, its middle at z (m). */
function garageDoor(z: number): THREE.BufferGeometry[] {
  const w = 4.88 * S;
  const h = 2.13 * S;
  const x = ROOM_HALF_W - 0.02 * S;
  const panel = h / 4;
  const out: THREE.BufferGeometry[] = new Array<THREE.BufferGeometry>(4 + 3 + 8 + 2);
  for (let i = 0; i < 4; i++) out[i] = part(new THREE.BoxGeometry(0.04 * S, panel - 0.01 * S, w), 0xe9e7e2, x, FLOOR + panel * (i + 0.5), z);
  for (let i = 0; i < 3; i++) out[4 + i] = part(new THREE.BoxGeometry(0.045 * S, 0.012 * S, w), 0x8f9296, x, FLOOR + panel * (i + 1), z);
  for (let i = 0; i < 8; i++) out[7 + i] = part(new THREE.BoxGeometry(0.05 * S, panel * 0.45, w / 10), 0x2b3440, x, FLOOR + panel * 3.5, z - w / 2 + (w / 8) * (i + 0.5));
  for (let i = 0; i < 2; i++) out[15 + i] = part(new THREE.BoxGeometry(0.1 * S, h + 0.1 * S, 0.06 * S), 0x9ea3a8, x - 0.03 * S, FLOOR + h / 2, z + (i ? 1 : -1) * (w / 2 + 0.03 * S));
  return out;
}

/** A 4 ft twin-tube shop light hung over the bench on two chains, its middle at (x, z) (m), and its two tubes (`tubes`). */
function shopLight(x: number, z: number): { paint: THREE.BufferGeometry[]; tubes: THREE.BufferGeometry[] } {
  const y = 1.0 * S;
  const chain = FLOOR + 2.75 * S - y;
  return {
    paint: [
      part(new THREE.BoxGeometry(1.22 * S, 0.05 * S, 0.16 * S), 0xdfe2e5, x, y, z),
      part(new THREE.CylinderGeometry(0.003 * S, 0.003 * S, chain, 4), 0x7a7e83, x - 0.5 * S, y + chain / 2, z),
      part(new THREE.CylinderGeometry(0.003 * S, 0.003 * S, chain, 4), 0x7a7e83, x + 0.5 * S, y + chain / 2, z),
    ],
    tubes: [
      part(new THREE.CylinderGeometry(0.013 * S, 0.013 * S, 1.18 * S, 8), 0xffffff, x, y - 0.035 * S, z - 0.04 * S, 0, 0, Math.PI / 2),
      part(new THREE.CylinderGeometry(0.013 * S, 0.013 * S, 1.18 * S, 8), 0xffffff, x, y - 0.035 * S, z + 0.04 * S, 0, 0, Math.PI / 2),
    ],
  };
}

/**
 * The Lab's workshop (docs: `scenes/lab.ts`): a butcher-block bench whose top is the ground, a pegboard on its back edge with a
 * hole every `PEG`, the wall behind it and the floor a bench's height below; per preset its brackets, shelves and props. Built
 * once on first entering the Lab, shown in that scene only; `show` picks the preset's set and hands back its props.
 */
export class LabArt {
  readonly group = new THREE.Group();
  private readonly sets: Record<LabPresetId, LabSet>;
  private active: LabSet;
  private readonly textures: RaceTextures;
  private readonly own: THREE.Texture[];

  constructor() {
    this.group.name = "lab";
    this.group.visible = false;
    const benchW = BENCH.halfW * 2;
    const benchD = BENCH.front - BOARD.z;

    const block = canvasTexture(512, 512, butcherBlock);
    block.repeat.set(benchW / 12, benchD / 12);
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(benchW, TOP_T, benchD).translate(0, -TOP_T / 2, (BOARD.z + BENCH.front) / 2),
      new THREE.MeshStandardMaterial({ map: block, roughness: 0.62, metalness: 0 }),
    );
    top.receiveShadow = true;
    top.castShadow = true;

    const legs: THREE.BufferGeometry[] = [];
    const legH = -TOP_T - FLOOR;
    for (const x of [-BENCH.halfW + LEG, BENCH.halfW - LEG]) {
      for (const z of [BOARD.z + LEG, BENCH.front - LEG]) legs.push(new THREE.BoxGeometry(LEG, legH, LEG).translate(x, FLOOR + legH / 2, z));
    }
    // A stretcher rail a foot off the floor along each side.
    for (const z of [BOARD.z + LEG, BENCH.front - LEG]) legs.push(new THREE.BoxGeometry(benchW - LEG * 2, LEG * 0.7, LEG * 0.5).translate(0, FLOOR + 0.3 * LAB_SCALE, z));
    const frame = new THREE.Mesh(mergeGeometries(legs)!, new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.8 }));
    frame.castShadow = true;
    frame.receiveShadow = true;
    for (const g of legs) g.dispose();

    const peg = canvasTexture(64, 64, pegCell);
    peg.repeat.set((BOARD.halfW * 2) / PEG, BOARD.h / PEG);
    // Shift the grid so a hole sits on every whole multiple of `PEG` (the snap points) in x and y.
    peg.offset.set(0.5 - ((BOARD.halfW / PEG) % 1), 0.5);
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD.halfW * 2, BOARD.h, BOARD_T).translate(0, BOARD.h / 2, BOARD.z - BOARD_T / 2),
      new THREE.MeshStandardMaterial({ map: peg, roughness: 0.85, metalness: 0 }),
    );
    board.receiveShadow = true;

    // The garage: painted block on the back wall and both side walls, a concrete floor a bench's height down.
    const blocks = canvasTexture(256, 256, cinderBlock);
    blocks.repeat.set((ROOM_HALF_W * 2) / (0.8 * S), ROOM_H / (0.8 * S));
    const sides = [
      new THREE.PlaneGeometry(ROOM_HALF_W * 2, ROOM_H).translate(0, FLOOR + ROOM_H / 2, LAB_BACK),
      new THREE.PlaneGeometry(ROOM_HALF_W * 2, ROOM_H).rotateY(-Math.PI / 2).translate(ROOM_HALF_W, FLOOR + ROOM_H / 2, LAB_BACK + ROOM_HALF_W),
      new THREE.PlaneGeometry(ROOM_HALF_W * 2, ROOM_H).rotateY(Math.PI / 2).translate(-ROOM_HALF_W, FLOOR + ROOM_H / 2, LAB_BACK + ROOM_HALF_W),
    ];
    const walls = new THREE.Mesh(mergeGeometries(sides)!, new THREE.MeshStandardMaterial({ map: blocks, roughness: 0.95, metalness: 0 }));
    for (const g of sides) g.dispose();
    walls.receiveShadow = true;
    const slab = canvasTexture(512, 512, concrete);
    slab.repeat.set(400 / (3 * S), 400 / (3 * S));
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400).rotateX(-Math.PI / 2).translate(0, FLOOR, 60),
      new THREE.MeshStandardMaterial({ map: slab, roughness: 0.9, metalness: 0 }),
    );
    floor.receiveShadow = true;
    const rule = canvasTexture(2048, 64, steelRule);
    rule.wrapS = rule.wrapT = THREE.ClampToEdgeWrapping;
    const ruler = new THREE.Mesh(new THREE.BoxGeometry(1 * S, 0.0012 * S, 0.03 * S), new THREE.MeshStandardMaterial({ map: rule, roughness: 0.4, metalness: 0.7 }));
    ruler.position.set(-14, 0.0006 * S, BENCH.front - 0.05 * S);
    ruler.receiveShadow = true;
    this.group.add(top, frame, board, walls, floor, ruler);
    this.own = [block, peg, blocks, slab, rule];

    // Oversized tools on the board and on the bench, the shop lights over it, the garage door across the room: the set's
    // scale, read off things everyone knows the size of. Drawn only: nothing here is in the physics.
    const tools = [hammer(-0.45, 0.58), screwdrivers(0.02, 0.46), saw(-0.95, 0.5), level(-0.85, 0.3), pliers(0.85, 0.45), tape(17, 8.5)];
    const lights = [shopLight(-16, 0.1 * S), shopLight(16, 0.1 * S)];
    const steelParts = [
      ...tools.flatMap((t) => t.steel),
      ...wrench(0.26, -0.3, 0.56),
      ...wrench(0.23, -0.24, 0.56),
      ...wrench(0.2, -0.18, 0.56),
      ...wrench(0.17, -0.12, 0.56),
      ...hardware(7, -6.2),
    ];
    const paintParts = [...tools.flatMap((t) => t.paint), ...lights.flatMap((l) => l.paint), ...mug(-4, -5.5), ...pencil(9, BENCH.front - 0.075 * S), ...garageDoor(62)];
    const tubes = merged(
      lights.flatMap((l) => l.tubes),
      // Brighter than white, so the bloom catches the tubes.
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 2.4, 2.25) }),
    );
    tubes.castShadow = false;
    this.group.add(
      merged(steelParts, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.85 })),
      merged(paintParts, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0 })),
      tubes,
    );

    this.textures = makeRaceTextures();
    const mats = makePrefabMaterials(this.textures);
    const steel = new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.45, metalness: 0.6 });
    const set = (id: LabPresetId): LabSet => {
      const layout = LAB_LAYOUTS[id];
      const group = new THREE.Group();
      group.name = `lab:${id}`;
      group.visible = false;
      // Each bracket or shelf: its plate under the surface, and a back plate up the board when it hangs there.
      const plates: THREE.BufferGeometry[] = [];
      for (const s of labSurfaces(layout)) {
        plates.push(new THREE.BoxGeometry(s.x1 - s.x0, BRACKET_T, s.z1 - s.z0).translate((s.x0 + s.x1) / 2, s.top - BRACKET_T / 2, (s.z0 + s.z1) / 2));
        if (s.z0 - BOARD.z < 0.5) plates.push(new THREE.BoxGeometry(s.x1 - s.x0, PEG * 2, BRACKET_T).translate((s.x0 + s.x1) / 2, s.top - PEG, BOARD.z + BRACKET_T / 2));
      }
      if (plates.length > 0) {
        const brackets = new THREE.Mesh(mergeGeometries(plates)!, steel);
        brackets.castShadow = true;
        brackets.receiveShadow = true;
        group.add(brackets);
        for (const g of plates) g.dispose();
      }
      const props = new PropTumble(labPlaced(layout).placed, mats, (mesh) => {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.customDepthMaterial = mesh.instanceColor ? DEPTH_INSTANCED_COLOR : DEPTH_INSTANCED;
        group.add(mesh);
      });
      this.group.add(group);
      return { group, props };
    };
    this.sets = { pad: set("pad"), wall: set("wall"), cards: set("cards"), glass: set("glass") };
    this.active = this.sets.cards;
  }

  /** Show preset `id`'s brackets, shelves and props; its props are the ones a car knocks (`Lab.tumble`). */
  show(id: LabPresetId): PropTumble {
    this.active.group.visible = false;
    this.active = this.sets[id];
    this.active.group.visible = true;
    return this.active.props;
  }

  dispose(): void {
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      geos.add(o.geometry as THREE.BufferGeometry);
      mats.add(o.material as THREE.Material);
      if (o instanceof THREE.InstancedMesh) o.dispose();
    });
    for (const g of geos) g.dispose();
    for (const m of mats) m.dispose();
    const t = this.textures;
    for (const x of [t.asphalt, t.concrete, t.detail, t.windows, t.billboard, ...this.own]) x.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
