import * as THREE from "three";

/** Colour roles a piece takes from its dummy's look. */
const SHIRT = 0;
const SKIN = 1;
const LEGS = 2;
const HAIR = 3;
const SHOE = 4;
const BRIM = 5;
const BADGE = 6;
const EYES = 7;
/** FlatOut's thrown driver (sRGB, by role): dark tee with a grey print, skin, jeans, short dark hair and fringe, dark shoes. */
const CIVILIAN = [0x2b2d32, 0xd8a27f, 0x3a4d6d, 0x2a1d15, 0x1c1c1e, 0x2a1d15, 0x7d828c, 0x1a1410].map((h) => new THREE.Color(h));
/** A police driver: dark navy shirt and trousers, navy cap with a black peak, a gold badge, dark glasses. */
const COP = [0x1b2a4a, 0xd8a27f, 0x121a2e, 0x16213b, 0x0e0e10, 0x0b0b0d, 0xd4a52a, 0x0a0a0a].map((h) => new THREE.Color(h));

/** A drawn piece riding body part `part`: centre and size (m) in the part's frame (+y its near end, +z the front). */
type Piece = { part: number; at: THREE.Vector3; size: THREE.Vector3; role: number };
const piece = (part: number, at: readonly number[], size: readonly number[], role: number): Piece => ({
  part,
  at: new THREE.Vector3().fromArray(at),
  size: new THREE.Vector3().fromArray(size),
  role,
});

/**
 * The low-poly person, sized to `engine-ragdoll.ts`'s `PARTS` (torso, head, L upper/lower arm, R upper/lower arm,
 * L thigh/shin, R thigh/shin): chest wider at the shoulders over a belly and the hips, deltoids, neck; a cranium over
 * a jaw with a flat face, the eyes, hair (a cop's cap) and a fringe (its peak); short sleeves, elbows, hands; thighs,
 * knees, shins and shoes. Every piece narrows toward its far end (`block`), the limbs toward the wrists and ankles.
 */
const PIECES: readonly Piece[] = [
  piece(0, [0, 0.07, 0], [0.4, 0.4, 0.24], SHIRT),
  piece(0, [0, -0.15, 0], [0.33, 0.16, 0.21], SHIRT),
  piece(0, [0, -0.26, 0], [0.34, 0.15, 0.22], LEGS),
  piece(0, [-0.215, 0.215, 0], [0.12, 0.13, 0.13], SHIRT),
  piece(0, [0.215, 0.215, 0], [0.12, 0.13, 0.13], SHIRT),
  piece(0, [0, 0.31, -0.005], [0.09, 0.09, 0.09], SKIN),
  piece(0, [0.095, 0.15, 0.118], [0.055, 0.065, 0.02], BADGE),
  piece(1, [0, 0.03, -0.01], [0.19, 0.18, 0.21], SKIN),
  piece(1, [0, -0.07, 0.015], [0.14, 0.08, 0.16], SKIN),
  piece(1, [0, -0.005, 0.088], [0.15, 0.14, 0.04], SKIN),
  piece(1, [0, 0.025, 0.106], [0.12, 0.028, 0.012], EYES),
  piece(1, [0, 0.095, -0.02], [0.2, 0.075, 0.215], HAIR),
  piece(1, [0, 0.075, 0.1], [0.18, 0.025, 0.09], BRIM),
  ...[2, 4].flatMap((k) => [piece(k, [0, 0.07, 0], [0.12, 0.17, 0.12], SHIRT), piece(k, [0, -0.03, 0], [0.09, 0.27, 0.09], SKIN)]),
  ...[3, 5].flatMap((k) => [
    piece(k, [0, 0.13, 0], [0.085, 0.07, 0.085], SKIN),
    piece(k, [0, -0.005, 0], [0.085, 0.28, 0.085], SKIN),
    piece(k, [0, -0.185, 0.005], [0.05, 0.11, 0.09], SKIN),
  ]),
  ...[6, 8].map((k) => piece(k, [0, 0, 0], [0.16, 0.45, 0.165], LEGS)),
  ...[7, 9].flatMap((k) => [
    piece(k, [0, 0.2, 0.012], [0.125, 0.08, 0.13], LEGS),
    piece(k, [0, 0.01, 0], [0.12, 0.42, 0.125], LEGS),
    piece(k, [0, -0.185, 0.045], [0.12, 0.085, 0.27], SHOE),
  ]),
];

/** A block's foot across, against its top. */
const TAPER = 0.78;
/** The block's cross-section: a 1 m square with its corners cut, so it reads blocky, not round. */
const RING = [0.5, 0.32, 0.32, 0.5, -0.32, 0.5, -0.5, 0.32, -0.5, -0.32, -0.32, -0.5, 0.32, -0.5, 0.5, -0.32];

/**
 * The one shape every piece scales: an octagonal block 1 m wide and tall, its foot `TAPER` of its top, smooth-shaded
 * round its sides and flat on its ends (28 triangles).
 */
function block(): THREE.BufferGeometry {
  const pos: number[] = [];
  // Side rings (0–7 top, 8–15 foot), then the same again for the end caps (16–23, 24–31), so the caps shade flat.
  for (let r = 0; r < 4; r++) {
    const s = r % 2 ? TAPER : 1;
    for (let k = 0; k < 8; k++) pos.push(RING[2 * k]! * s, r % 2 ? -0.5 : 0.5, RING[2 * k + 1]! * s);
  }
  const index: number[] = [];
  for (let k = 0; k < 8; k++) {
    const n = (k + 1) % 8;
    index.push(k, n, 8 + n, k, 8 + n, 8 + k);
  }
  for (let k = 1; k < 7; k++) index.push(16, 17 + k, 16 + k, 24, 24 + k, 25 + k);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

const _m = new THREE.Matrix4();
const _o = new THREE.Vector3();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Every dummy in one instanced draw: `PIECES` per slot, each a `block` posed off its body part, coloured by the
 * slot's look (`dress`). The draw ends after the highest slot with a dummy out.
 */
export class DummyMesh extends THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  /** Slots with a dummy out, a bit each. */
  private shown = 0;

  constructor(slots: number) {
    super(block(), new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 }), slots * PIECES.length);
    for (let i = 0; i < this.count; i++) this.setMatrixAt(i, HIDDEN);
    for (let s = 0; s < slots; s++) this.dress(s, false);
    this.count = 0;
  }

  /** Slot `s`'s clothes: a civilian's, or (`cop`) a police uniform. */
  dress(s: number, cop: boolean): void {
    const colors = cop ? COP : CIVILIAN;
    for (let i = 0; i < PIECES.length; i++) this.setColorAt(s * PIECES.length + i, colors[PIECES[i]!.role]!);
    this.instanceColor!.needsUpdate = true;
  }

  /** Slot `s`'s body part `k` at pose `p`, `q`: the pieces it carries. */
  pose(s: number, k: number, p: THREE.Vector3, q: THREE.Quaternion): void {
    this.shown |= 1 << s;
    this.count = (32 - Math.clz32(this.shown)) * PIECES.length;
    for (let i = 0; i < PIECES.length; i++) {
      const t = PIECES[i]!;
      if (t.part !== k) continue;
      _o.copy(t.at).applyQuaternion(q).add(p);
      this.setMatrixAt(s * PIECES.length + i, _m.compose(_o, q, t.size));
    }
    this.instanceMatrix.needsUpdate = true;
  }

  hide(s: number): void {
    this.shown &= ~(1 << s);
    this.count = (32 - Math.clz32(this.shown)) * PIECES.length;
    for (let i = 0; i < PIECES.length; i++) this.setMatrixAt(s * PIECES.length + i, HIDDEN);
    this.instanceMatrix.needsUpdate = true;
  }
}
