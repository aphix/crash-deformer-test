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

/** A slot's build is one of these bits in its flags; a vertex is drawn when its kinds share the slot's build bit (and, when its kinds hold `WHISKERS`, the slot wears whiskers). */
export const BUILD = { MAN: 1, WOMAN: 2, PORTLY: 4 } as const;
export const WHISKERS = 8;
const CIVIL = BUILD.MAN | BUILD.WOMAN;
const EVERY_BUILD = CIVIL | BUILD.PORTLY;

/** Whether a vertex of `kinds` is drawn on a slot with `flags`: `dollShown` in the shader, line for line. */
export function isDrawn(kinds: number, flags: number): boolean {
  return (kinds & flags & EVERY_BUILD) !== 0 && ((kinds & WHISKERS) === 0 || (flags & WHISKERS) !== 0);
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

/** One cross-section: height, half widths in x and z (to the polygon's corners), the z of its middle, its role. */
type Ring = readonly [y: number, rx: number, rz: number, cz: number, role: number];
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

/** The head, the neck and the hair of each build, the face's features, the collar and the tie. */
function headShells(): Shell[] {
  const head = rigid(HEAD);
  const tieRings = [1.37, 1.3, 1.22, 1.12, 1.02, 0.98].map((y): Ring => [y, 0.04, 0.02, portlyFront(y) + 0.006, TIE]);
  return [
    tube(0, EVERY_BUILD, SPINE, [[1.34, 0.055, 0.055, -0.005, SKIN], [1.42, 0.055, 0.055, 0, SKIN], [1.46, 0.055, 0.057, 0.008, SKIN], [1.5, 0.056, 0.058, 0.012, SKIN], [1.56, 0.056, 0.06, 0.017, SKIN]]),
    tube(0, EVERY_BUILD, head, [[1.5, 0.045, 0.055, 0.035, SKIN], [1.545, 0.09, 0.098, 0.025, SKIN], [1.61, 0.105, 0.115, 0, SKIN], [1.68, 0.108, 0.118, -0.003, SKIN], [1.735, 0.092, 0.1, -0.006, SKIN]], 0.035, 0.01),
    box(0, 1.655, 0.108, 0.14, 0.026, 0.016, EYES, EVERY_BUILD, head),
    box(0, 1.615, 0.115, 0.034, 0.055, 0.03, SKIN, EVERY_BUILD, head),
    box(0, 1.575, 0.112, 0.09, 0.02, 0.02, MUSTACHE, EVERY_BUILD | WHISKERS, head),
    box(0, 1.715, 0.14, 0.2, 0.024, 0.08, BRIM, EVERY_BUILD, head),
    tube(0, CIVIL, head, [[1.6, 0.112, 0.122, -0.02, HAIR], [1.65, 0.116, 0.126, -0.018, HAIR], [1.7, 0.116, 0.126, -0.016, HAIR], [1.745, 0.098, 0.108, -0.01, HAIR]], 0.04),
    box(0, 1.58, -0.115, 0.19, 0.075, 0.045, LOCKS, BUILD.MAN, head),
    tube(0, BUILD.WOMAN, SPINE, [[1.72, 0.118, 0.126, -0.02, LOCKS], [1.65, 0.122, 0.13, -0.025, LOCKS], [1.56, 0.118, 0.1, -0.055, LOCKS], [1.45, 0.105, 0.085, -0.08, LOCKS], [1.34, 0.085, 0.06, -0.095, LOCKS]], undefined, 0.04),
    tube(0, BUILD.PORTLY, head, [[1.5, 0.075, 0.08, 0.04, SKIN], [1.545, 0.12, 0.125, 0.025, SKIN], [1.6, 0.118, 0.12, 0.015, SKIN], [1.65, 0.105, 0.11, 0, SKIN]], 0.01, 0.01),
    tube(0, BUILD.PORTLY, head, [[1.58, 0.126, 0.136, -0.03, HAIR], [1.65, 0.13, 0.14, -0.02, HAIR], [1.71, 0.126, 0.136, -0.01, HAIR], [1.765, 0.105, 0.11, -0.005, HAIR]], 0.05),
    tube(0, BUILD.PORTLY, head, [[1.6, 0.126, 0.136, -0.03, LOCKS], [1.55, 0.118, 0.115, -0.04, LOCKS], [1.5, 0.09, 0.08, -0.04, LOCKS]], undefined, 0.01),
    tube(0, BUILD.PORTLY, rigid(TORSO), [[1.45, 0.07, 0.068, 0, COLLAR], [1.425, 0.085, 0.078, 0, COLLAR], [1.39, 0.115, 0.095, 0, COLLAR]]),
    { ...tube(0, BUILD.PORTLY, rigid(TORSO), tieRings, undefined, 0), sides: 4 },
    box(0.095, 1.25, 0.14, 0.055, 0.065, 0.02, BADGE, CIVIL, rigid(TORSO)),
  ];
}

function bodyShells(): Shell[] {
  const shells = [
    torsoShell(BUILD.MAN, MAN_JACKET, MAN_PELVIS),
    torsoShell(BUILD.WOMAN, WOMAN_JACKET, WOMAN_PELVIS),
    torsoShell(BUILD.PORTLY, PORTLY_JACKET, PORTLY_PELVIS),
    ...headShells(),
  ];
  for (const [sign, armBone, legBone] of [[1, LEFT_ARM, LEFT_LEG], [-1, RIGHT_ARM, RIGHT_LEG]] as const) shells.push(...arm(ARM_X * sign, armBone), ...leg(LEG_X * sign, legBone));
  return shells;
}

type Lofted = { position: number[]; bones: number[]; roleKind: number[]; index: number[] };
const _w = [0, 0, 0];

/** Shell `s` into `mesh`: its rings joined side to side, its ends closed by a fan to a pole. */
function loft(s: Shell, mesh: Lofted): void {
  const n = s.sides;
  const phase = Math.PI / n;
  const vertex = (y: number, x: number, z: number, role: number): number => {
    weigh(s.chain, y, _w);
    mesh.bones.push(_w[0]!, _w[1]!, _w[2]!);
    mesh.roleKind.push(role, s.kinds);
    mesh.position.push(x, y, z);
    return mesh.position.length / 3 - 1;
  };
  const rings = s.rings.map(([y, rx, rz, cz, role]) => Array.from({ length: n }, (_, k) => vertex(y, s.x + rx * Math.cos(phase + (2 * Math.PI * k) / n), cz + rz * Math.sin(phase + (2 * Math.PI * k) / n), role)));
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
