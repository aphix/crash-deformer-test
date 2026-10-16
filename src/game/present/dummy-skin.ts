import * as THREE from "three";
import { JOINTS, PARTS } from "./ragdoll-body.ts";

/**
 * The dummy's one continuous body and the skinning that poses it: `dummyGeometry` lofts the whole person (jacket, jeans,
 * shoes, hands, head, hair) from rings in the standing pose (feet at y = 0, facing +z) and gives every vertex two of the
 * ten `PARTS` as bones with a blend between them; `DummyMesh` (`ragdoll-mesh.ts`) poses it in the vertex shader, and
 * `skinPoint` is that skinning in TS (the picks and the tests pose with it).
 */

/** Colour roles: each vertex takes its colour from its slot's palette (`DummyMesh.dress`). */
export const ROLE = { SHIRT: 0, SKIN: 1, LEGS: 2, HAIR: 3, SHOE: 4, BRIM: 5, BADGE: 6, EYES: 7, LOCKS: 8, MUSTACHE: 9, TIE: 10, COLLAR: 11 } as const;
export const ROLES = 12;

/**
 * A slot's flags: its build (one of `BUILD`) and the optional bits it wears. A vertex is drawn when its kinds share the slot's
 * build bit and every optional bit its kinds hold is in the slot's flags: whiskers, a cap (a civilian's or a cop's), a uniform's
 * glasses, bare hair (no cap).
 */
export const BUILD = { MAN: 1, WOMAN: 2, PORTLY: 4 } as const;
export const WHISKERS = 8;
export const CAPPED = 16;
export const UNIFORM = 32;
export const BARE = 64;
export const OPTIONAL = WHISKERS | CAPPED | UNIFORM | BARE;
const CIVIL = BUILD.MAN | BUILD.WOMAN;
const EVERY_BUILD = CIVIL | BUILD.PORTLY;

/** Whether a vertex of `kinds` is drawn on a slot with `flags`: `dollShown` in the shader, line for line. */
export function isDrawn(kinds: number, flags: number): boolean {
  return (kinds & flags & EVERY_BUILD) !== 0 && (kinds & OPTIONAL & ~flags) === 0;
}

/** The geometry's attributes beside `position` and `normal`; the shader declares them by these names. */
export const BONES_ATTRIBUTE = "bones";
export const KINDS_ATTRIBUTE = "roleKind";

/** A slot's row in the pose texture: two texels per bone (translation, rotation), a texel per role colour, then the flags. */
const BONES = PARTS.length;
export const PALETTE_AT = BONES * 2;
export const FLAGS_AT = PALETTE_AT + ROLES;
export const ROW_TEXELS = FLAGS_AT + 1;

/** Half the width (m) of a joint's blend band: three rings a band (its two ends and its middle), so a 90 degree bend spreads over two ring pitches. */
const BAND = 0.04;
/** The neck's blend band sits over the neck, above the shoulders' top ring (1.40 m). */
const NECK_BAND_AT = 1.46;
const HIP_Y = JOINTS[5][3];
const KNEE_Y = JOINTS[6][3];
const ELBOW_Y = JOINTS[2][3];
const SHOULDER_Y = JOINTS[1][3];
const TORSO = 0;
const HEAD = 1;
const [LEFT_ARM, RIGHT_ARM] = [2, 4];
const [LEFT_LEG, RIGHT_LEG] = [6, 8];
const ARM_X = PARTS[LEFT_ARM].c[0];
const LEG_X = PARTS[LEFT_LEG].c[0];

/** From `parent` to `child` over `centre` ± `BAND`; `up` when the child is the higher bone. */
type Joint = { parent: number; child: number; centre: number; up: boolean };
/** The bone a vertex rides, and the joints it blends across by its height (the later joint wins where bands meet). */
type Chain = { bone: number; joints: readonly Joint[] };
const rigid = (bone: number): Chain => ({ bone, joints: [] });
const SPINE: Chain = { bone: TORSO, joints: [{ parent: TORSO, child: HEAD, centre: NECK_BAND_AT, up: true }] };
const armChain = (upper: number): Chain => ({
  bone: TORSO,
  joints: [
    { parent: TORSO, child: upper, centre: SHOULDER_Y, up: false },
    { parent: upper, child: upper + 1, centre: ELBOW_Y, up: false },
  ],
});
const legChain = (thigh: number): Chain => ({
  bone: TORSO,
  joints: [
    { parent: TORSO, child: thigh, centre: HIP_Y, up: false },
    { parent: thigh, child: thigh + 1, centre: KNEE_Y, up: false },
  ],
});

/** Bones (a, b) and the weight of b at height `y`, into `out` at 0..2. */
function weigh(chain: Chain, y: number, out: number[]): void {
  out[0] = chain.bone;
  out[1] = chain.bone;
  out[2] = 0;
  for (const j of chain.joints) {
    const t = (j.up ? y - (j.centre - BAND) : j.centre + BAND - y) / (2 * BAND);
    if (t <= 0) continue;
    out[0] = j.parent;
    out[1] = j.child;
    out[2] = Math.min(1, t);
  }
}

/** One cross-section: height, half widths in x and z (to the polygon's corners), the z of its middle, its role, and the share of its z half width its face half (z above the middle) keeps (default 1). */
type Ring = readonly [y: number, rx: number, rz: number, cz: number, role: number, front?: number];
/** A lofted shell: rings top to bottom around the vertical axis at `x`, closed at an end by a pole `top` above the first ring or `bottom` below the last (open when absent). */
type Shell = { x: number; sides: number; kinds: number; chain: Chain; rings: readonly Ring[]; top?: number; bottom?: number };

const { SHIRT, SKIN, LEGS, HAIR, SHOE, BRIM, BADGE, EYES, LOCKS, MUSTACHE, TIE, COLLAR } = ROLE;
const TUBE_SIDES = 8;

const tube = (x: number, kinds: number, chain: Chain, rings: readonly Ring[], top?: number, bottom?: number): Shell => ({ x, sides: TUBE_SIDES, kinds, chain, rings, top, bottom });

/** A box (a lofted square, flat ends) centred (x, y, z) with sizes (sx, sy, sz): the small features. */
function box(x: number, y: number, z: number, sx: number, sy: number, sz: number, role: number, kinds: number, chain: Chain): Shell {
  const corner = 1 / Math.cos(Math.PI / 4);
  const ring = (at: number): Ring => [at, (sx / 2) * corner, (sz / 2) * corner, z, role];
  return { x, sides: 4, kinds, chain, rings: [ring(y + sy / 2), ring(y - sy / 2)], top: 0, bottom: 0 };
}

/** The jacket and the jeans' top of one build, hem at 0.97 m: rings (y, half widths, middle z) of the jacket, then the pelvis in jeans. */
function torsoShell(kinds: number, jacket: readonly (readonly [number, number, number, number])[], pelvis: readonly (readonly [number, number, number, number])[]): Shell {
  const rings: Ring[] = [];
  for (const [y, rx, rz, cz] of jacket) rings.push([y, rx, rz, cz, SHIRT]);
  const hem = jacket[jacket.length - 1]!;
  rings.push([hem[0], hem[1], hem[2], hem[3], LEGS]);
  for (const [y, rx, rz, cz] of pelvis) rings.push([y, rx, rz, cz, LEGS]);
  return tube(0, kinds, rigid(TORSO), rings, undefined, 0.03);
}

const MAN_JACKET = [[1.4, 0.062, 0.062, 0], [1.385, 0.14, 0.095, 0], [1.35, 0.205, 0.12, 0], [1.3, 0.225, 0.13, 0.005], [1.22, 0.225, 0.135, 0.005], [1.12, 0.21, 0.13, 0.005], [0.97, 0.2, 0.125, 0]] as const;
const MAN_PELVIS = [[0.9, 0.2, 0.13, 0], [0.84, 0.17, 0.12, 0], [0.79, 0.11, 0.09, 0]] as const;
const WOMAN_JACKET = [[1.4, 0.058, 0.058, 0], [1.385, 0.115, 0.09, 0], [1.35, 0.165, 0.11, 0], [1.3, 0.19, 0.125, 0.005], [1.22, 0.19, 0.13, 0.01], [1.12, 0.165, 0.115, 0.005], [0.97, 0.16, 0.11, 0]] as const;
const WOMAN_PELVIS = [[0.9, 0.21, 0.13, 0], [0.84, 0.18, 0.12, 0], [0.79, 0.11, 0.09, 0]] as const;
const PORTLY_JACKET = [[1.4, 0.065, 0.065, 0], [1.385, 0.145, 0.1, 0], [1.35, 0.23, 0.135, 0.005], [1.3, 0.25, 0.16, 0.015], [1.22, 0.255, 0.19, 0.035], [1.12, 0.255, 0.21, 0.045], [1.02, 0.245, 0.215, 0.05], [0.97, 0.235, 0.205, 0.045]] as const;
const PORTLY_PELVIS = [[0.9, 0.22, 0.18, 0.03], [0.84, 0.17, 0.13, 0], [0.79, 0.11, 0.09, 0]] as const;

/** Height `y` on the portly torso's front (m), between its two rings: the tie lies on it. */
function portlyFront(y: number): number {
  const front = (r: readonly number[]) => r[3]! + r[2]! * Math.cos(Math.PI / TUBE_SIDES);
  for (let i = 0; i + 1 < PORTLY_JACKET.length; i++) {
    const [a, b] = [PORTLY_JACKET[i]!, PORTLY_JACKET[i + 1]!];
    if (y <= a[0] && y >= b[0]) return front(a) + ((y - a[0]) / (b[0] - a[0])) * (front(b) - front(a));
  }
  throw new RangeError(`no portly torso at y = ${y}`);
}

/** One arm, `x` its middle: the sleeve to the wrist over a bare forearm and hand, a bone's bend each at shoulder and elbow. */
function arm(x: number, upper: number): Shell[] {
  const chain = armChain(upper);
  const sleeve: Ring[] = [
    [SHOULDER_Y + BAND, 0.045, 0.045, 0, SHIRT],
    [SHOULDER_Y, 0.068, 0.068, 0, SHIRT],
    [SHOULDER_Y - BAND, 0.066, 0.066, 0, SHIRT],
    [1.21, 0.06, 0.06, 0, SHIRT],
    [ELBOW_Y + BAND, 0.055, 0.055, 0, SHIRT],
    [ELBOW_Y, 0.054, 0.054, 0, SHIRT],
    [ELBOW_Y - BAND, 0.053, 0.053, 0, SHIRT],
    [0.92, 0.05, 0.05, 0, SHIRT],
    [0.82, 0.046, 0.046, 0, SHIRT],
  ];
  const hand: Ring[] = [[0.9, 0.04, 0.04, 0, SKIN], [0.82, 0.038, 0.038, 0, SKIN], [0.78, 0.036, 0.036, 0, SKIN], [0.755, 0.05, 0.03, 0, SKIN], [0.7, 0.052, 0.028, 0, SKIN], [0.65, 0.042, 0.025, 0, SKIN]];
  return [tube(x, EVERY_BUILD, chain, sleeve, 0.02), tube(x, EVERY_BUILD, chain, hand, undefined, 0.03)];
}

/** One leg, `x` its middle: jeans from inside the pelvis to the ankle, a bone's bend each at hip and knee, over a dark shoe. */
function leg(x: number, thigh: number): Shell[] {
  const chain = legChain(thigh);
  const jeans: Ring[] = [
    [HIP_Y + BAND, 0.105, 0.108, 0, LEGS],
    [HIP_Y, 0.108, 0.11, 0, LEGS],
    [HIP_Y - BAND, 0.105, 0.108, 0, LEGS],
    [0.62, 0.092, 0.098, 0, LEGS],
    [KNEE_Y + BAND, 0.075, 0.08, 0, LEGS],
    [KNEE_Y, 0.072, 0.077, 0, LEGS],
    [KNEE_Y - BAND, 0.07, 0.075, 0, LEGS],
    [0.22, 0.062, 0.066, 0, LEGS],
    [0.07, 0.06, 0.062, 0, LEGS],
  ];
  const shoe: Ring[] = [[0.11, 0.05, 0.054, 0, SHOE], [0.075, 0.058, 0.09, 0.035, SHOE], [0.03, 0.062, 0.13, 0.06, SHOE], [0, 0.05, 0.11, 0.06, SHOE]];
  return [tube(x, EVERY_BUILD, chain, jeans, 0.03), tube(x, EVERY_BUILD, chain, shoe, undefined, 0)];
}

/** The skull standing: rings (y, half widths in x and z, the z of its middle) from the chin up, the egg of a cranium over a narrower jaw; its top pole is `SKULL_TOP`. */
const SKULL = [[1.5, 0.035, 0.04, 0.045], [1.53, 0.06, 0.07, 0.035], [1.57, 0.082, 0.09, 0.02], [1.62, 0.098, 0.103, 0], [1.67, 0.1, 0.108, -0.004], [1.71, 0.093, 0.1, -0.006], [1.745, 0.07, 0.08, -0.006]] as const;
const SKULL_TOP = 1.765;
const HEAD_SIDES = 10;
/** The skull's half widths and middle at height `y`, between its rings. */
function skullAt(y: number): readonly [number, number, number] {
  for (let i = 0; i + 1 < SKULL.length; i++) {
    const [a, b] = [SKULL[i]!, SKULL[i + 1]!];
    if (y < a[0] || y > b[0]) continue;
    const t = (y - a[0]) / (b[0] - a[0]);
    return [a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2]), a[3] + t * (b[3] - a[3])];
  }
  throw new RangeError(`no skull at y = ${y}`);
}

/** The skull's face at height `y`: the z of its front vertex. */
function faceZ(y: number): number {
  const [, rz, cz] = skullAt(y);
  return cz + rz;
}

/** Rings over the skull at heights `ys` (top to bottom), `d` m out of it, the face half of each ring scaled by `front(y)` (below 1: under the skin, so the shell ends in a hairline). */
function overSkull(ys: readonly number[], d: number, role: number, front: (y: number) => number): Ring[] {
  return ys.map((y): Ring => {
    const [rx, rz, cz] = skullAt(y);
    return [y, rx + d, rz + d, cz, role, front(y)];
  });
}

/** A head shell: ten sides, riding the head bone, so nothing on it can come apart from the skull. */
const headShell = (kinds: number, rings: readonly Ring[], top?: number, bottom?: number): Shell => ({ ...tube(0, kinds, rigid(HEAD), rings, top, bottom), sides: HEAD_SIDES });

/**
 * Metres the cap's peak stands out of its crown; the crown's and the hair's thickness over the skull; the height above which the fringe shows,
 * and how far under the skin the face half of a hair ring below it is drawn: at 0.8 the shell still stood out of the cheeks between the ear and
 * the eye (a dark band across the face at eye level); at 0.5 it is under the skin everywhere but a sliver at the ear.
 */
const PEAK_REACH = 0.085;
const CROWN_OUT = 0.02;
const HAIR_OUT = 0.012;
const FRINGE_ON = 1.69;
const UNDER_SKIN = 0.5;
const fringe = (y: number) => (y < FRINGE_ON ? UNDER_SKIN : 1);

/** The face: the skull, a short neck under it, eyes with brows, a nose, glasses on a cop, a moustache where worn. */
function faceShells(): Shell[] {
  const head = rigid(HEAD);
  const eyeY = 1.635;
  const eye = (side: number): Shell => box(side * 0.036, eyeY, faceZ(eyeY), 0.022, 0.016, 0.012, EYES, EVERY_BUILD, head);
  const brow = (side: number): Shell => box(side * 0.036, eyeY + 0.024, faceZ(eyeY + 0.024), 0.04, 0.008, 0.012, LOCKS, EVERY_BUILD, head);
  const lens = (side: number): Shell => box(side * 0.038, eyeY, faceZ(eyeY) + 0.006, 0.052, 0.03, 0.012, EYES, EVERY_BUILD | UNIFORM, head);
  // `SKULL` runs chin up; a shell's rings run top to bottom (`loft`).
  const skull: Ring[] = SKULL.map(([y, rx, rz, cz]): Ring => [y, rx, rz, cz, SKIN]).reverse();
  return [
    tube(0, EVERY_BUILD, SPINE, [[1.56, 0.046, 0.05, 0.017, SKIN], [1.5, 0.046, 0.048, 0.012, SKIN], [1.46, 0.045, 0.047, 0.008, SKIN], [1.42, 0.045, 0.045, 0, SKIN], [1.34, 0.045, 0.045, -0.005, SKIN]]),
    headShell(EVERY_BUILD, skull, SKULL_TOP - 1.745, 0.01),
    eye(-1),
    eye(1),
    brow(-1),
    brow(1),
    lens(-1),
    lens(1),
    box(0, eyeY, faceZ(eyeY) + 0.006, 0.02, 0.008, 0.012, EYES, EVERY_BUILD | UNIFORM, head),
    box(0, 1.6, faceZ(1.6) + 0.006, 0.03, 0.05, 0.03, SKIN, EVERY_BUILD, head),
    box(0, 1.575, faceZ(1.575) + 0.004, 0.06, 0.014, 0.016, MUSTACHE, EVERY_BUILD | WHISKERS, head),
  ];
}

/** Hair, caps and the other head wear: each a shell over the skull's own rings, so it follows its surface. */
function hairShells(): Shell[] {
  const crown = overSkull([1.745, 1.71, 1.67], CROWN_OUT, HAIR, () => 1);
  const rim = crown[crown.length - 1]!;
  const reach = 1 + PEAK_REACH / rim[2];
  const peak: Ring[] = [[rim[0], rim[1], rim[2], rim[3], BRIM], [rim[0] - 0.006, rim[1], rim[2], rim[3], BRIM, reach], [rim[0] - 0.014, rim[1], rim[2], rim[3], BRIM, reach], [rim[0] - 0.014, rim[1], rim[2], rim[3], BRIM]];
  const napeY = 1.585;
  const [, napeZ, napeC] = skullAt(napeY);
  const longHair: Ring[] = [
    ...overSkull([1.745, 1.71, 1.67, 1.62], HAIR_OUT + 0.002, LOCKS, fringe),
    [1.57, 0.105, 0.085, -0.03, LOCKS, 0.5],
    [1.5, 0.105, 0.07, -0.05, LOCKS, 0.4],
    [1.42, 0.1, 0.06, -0.06, LOCKS, 0.4],
    [1.36, 0.085, 0.05, -0.06, LOCKS, 0.4],
  ];
  const jowls: Ring[] = [1.64, 1.59, 1.545, 1.51].map((y): Ring => {
    const [rx, rz, cz] = skullAt(y);
    return [y, rx * 1.15, rz * 1.08, cz, SKIN];
  });
  return [
    headShell(BUILD.MAN | BARE, overSkull([1.745, 1.71, 1.67, 1.62], HAIR_OUT, HAIR, fringe), SKULL_TOP + HAIR_OUT - 1.745),
    box(0, napeY, napeC - napeZ + 0.014, 0.15, 0.07, 0.04, LOCKS, BUILD.MAN, rigid(HEAD)),
    headShell(BUILD.WOMAN, longHair, SKULL_TOP + HAIR_OUT + 0.002 - 1.745, 0.04),
    headShell(BUILD.PORTLY, jowls, 0.01, 0.01),
    headShell(BUILD.PORTLY | BARE, overSkull([1.745, 1.71, 1.67, 1.62, 1.57], 0.03, HAIR, (y) => (y < 1.6 ? 0.5 : y < FRINGE_ON ? 0.75 : 1)), SKULL_TOP + 0.03 - 1.745),
    headShell(EVERY_BUILD | CAPPED, crown, SKULL_TOP + CROWN_OUT - 1.745),
    headShell(EVERY_BUILD | CAPPED, peak),
  ];
}

/** The collar and tie of the portly man, and the cop's badge. */
function clothesShells(): Shell[] {
  const tieRings = [1.37, 1.3, 1.22, 1.12, 1.02, 0.98].map((y): Ring => [y, 0.04, 0.02, portlyFront(y) + 0.006, TIE]);
  return [
    tube(0, BUILD.PORTLY, rigid(TORSO), [[1.45, 0.07, 0.068, 0, COLLAR], [1.425, 0.085, 0.078, 0, COLLAR], [1.39, 0.115, 0.095, 0, COLLAR]]),
    { ...tube(0, BUILD.PORTLY, rigid(TORSO), tieRings, undefined, 0), sides: 4 },
    box(0.095, 1.25, 0.14, 0.055, 0.065, 0.02, BADGE, EVERY_BUILD | UNIFORM, rigid(TORSO)),
  ];
}

function bodyShells(): Shell[] {
  const shells = [
    torsoShell(BUILD.MAN, MAN_JACKET, MAN_PELVIS),
    torsoShell(BUILD.WOMAN, WOMAN_JACKET, WOMAN_PELVIS),
    torsoShell(BUILD.PORTLY, PORTLY_JACKET, PORTLY_PELVIS),
    ...faceShells(),
    ...hairShells(),
    ...clothesShells(),
  ];
  for (const [sign, armBone, legBone] of [[1, LEFT_ARM, LEFT_LEG], [-1, RIGHT_ARM, RIGHT_LEG]] as const) shells.push(...arm(ARM_X * sign, armBone), ...leg(LEG_X * sign, legBone));
  return shells;
}

type Lofted = { position: number[]; bones: number[]; roleKind: number[]; index: number[] };
const _w = [0, 0, 0];

/** Shell `s` into `mesh`: its rings joined side to side, its ends closed by a fan to a pole. The winding faces out only for rings running top to bottom. */
function loft(s: Shell, mesh: Lofted): void {
  for (let r = 1; r < s.rings.length; r++) {
    if (s.rings[r]![0] > s.rings[r - 1]![0]) throw new RangeError(`a shell's ring at y = ${s.rings[r]![0]} is above the one before it (rings run top to bottom, else the shell is drawn inside out)`);
  }
  const n = s.sides;
  const phase = Math.PI / n;
  const vertex = (y: number, x: number, z: number, role: number): number => {
    weigh(s.chain, y, _w);
    mesh.bones.push(_w[0]!, _w[1]!, _w[2]!);
    mesh.roleKind.push(role, s.kinds);
    mesh.position.push(x, y, z);
    return mesh.position.length / 3 - 1;
  };
  const rings = s.rings.map(([y, rx, rz, cz, role, front = 1]) =>
    Array.from({ length: n }, (_, k) => {
      const sin = Math.sin(phase + (2 * Math.PI * k) / n);
      return vertex(y, s.x + rx * Math.cos(phase + (2 * Math.PI * k) / n), cz + rz * sin * (sin > 0 ? front : 1), role);
    }),
  );
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let k = 0; k < n; k++) {
      const [a, b, c, d] = [rings[r]![k]!, rings[r]![(k + 1) % n]!, rings[r + 1]![(k + 1) % n]!, rings[r + 1]![k]!];
      mesh.index.push(a, b, d, b, c, d);
    }
  }
  const cap = (ring: number[], at: Ring, dy: number, up: boolean): void => {
    const pole = vertex(at[0] + dy, s.x, at[3], at[4]);
    for (let k = 0; k < n; k++) mesh.index.push(pole, up ? ring[(k + 1) % n]! : ring[k]!, up ? ring[k]! : ring[(k + 1) % n]!);
  };
  if (s.top !== undefined) cap(rings[0]!, s.rings[0]!, s.top, true);
  if (s.bottom !== undefined) cap(rings[rings.length - 1]!, s.rings[s.rings.length - 1]!, -s.bottom, false);
}

/** The whole person in the standing pose: `position`, `normal` (smooth), `bones` (bone a, bone b, weight of b) and `roleKind` (colour role, the kinds `isDrawn` reads). */
export function dummyGeometry(): THREE.BufferGeometry {
  const mesh: Lofted = { position: [], bones: [], roleKind: [], index: [] };
  for (const shell of bodyShells()) loft(shell, mesh);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(mesh.position, 3));
  geo.setAttribute(BONES_ATTRIBUTE, new THREE.Float32BufferAttribute(mesh.bones, 3));
  geo.setAttribute(KINDS_ATTRIBUTE, new THREE.Float32BufferAttribute(mesh.roleKind, 2));
  geo.setIndex(mesh.index);
  geo.computeVertexNormals();
  return geo;
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();

/** Rest point `v` posed by `slot`'s bones `a` and `b` (weight `w` on b) in the pose rows `data`: each bone's rigid move, blended. */
export function skinPoint(data: Float32Array, slot: number, a: number, b: number, w: number, v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const ta = slot * ROW_TEXELS * 4 + a * 8;
  const tb = slot * ROW_TEXELS * 4 + b * 8;
  _pa.copy(v).applyQuaternion(_qa.fromArray(data, ta + 4));
  _pb.copy(v).applyQuaternion(_qb.fromArray(data, tb + 4));
  return out.set(
    (1 - w) * (data[ta]! + _pa.x) + w * (data[tb]! + _pb.x),
    (1 - w) * (data[ta + 1]! + _pa.y) + w * (data[tb + 1]! + _pb.y),
    (1 - w) * (data[ta + 2]! + _pa.z) + w * (data[tb + 2]! + _pb.z),
  );
}
