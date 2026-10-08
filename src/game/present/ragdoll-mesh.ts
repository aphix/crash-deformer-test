import * as THREE from "three";
import { JEANS, type DriverLook } from "./driver-look.ts";
import { PARTS } from "./ragdoll-body.ts";
import { applySpray, PERSON_SPRAY, sprayUniforms, type SprayBitmap } from "./spray.ts";

/** Colour roles a piece takes from its dummy's look. */
const SHIRT = 0;
const SKIN = 1;
const LEGS = 2;
const HAIR = 3;
const SHOE = 4;
const BRIM = 5;
const BADGE = 6;
const EYES = 7;
/** Hair that shows under a cop's cap and, on a woman, her long hair (a cop's HAIR is the cap). */
const LOCKS = 8;
/** A moustache in the hair's colour, drawn only on a driver who wears one. */
const MUSTACHE = 9;
/** FlatOut's thrown driver (sRGB, by role): skin, dark shoes and eyes are fixed; the tee, trousers and hair roles take the driver's `DriverLook`. */
const CIVILIAN = [0, 0xd8a27f, 0, 0, 0x1c1c1e, 0, 0, 0x1a1410, 0, 0];
/** A police driver: dark navy shirt and trousers, navy cap with a black peak, a gold badge, dark glasses; only the hair under the cap is the driver's. */
const COP = [0x1b2a4a, 0xd8a27f, 0x121a2e, 0x16213b, 0x0e0e10, 0x0b0b0d, 0xd4a52a, 0x0a0a0a, 0, 0];
/** A civilian's cap peak against its crown. */
const PEAK_SHADE = 0.6;
const _c = new THREE.Color();

/** `sex`: drawn on every dummy (BOTH), on a woman only (WOMAN) or on a man only (MAN). */
const BOTH = 0;
const WOMAN = 1;
const MAN = 2;
/** A drawn piece riding body part `part`: centre and size (m) in the part's frame (+y its near end, +z the front). */
type Piece = { part: number; at: THREE.Vector3; size: THREE.Vector3; role: number; sex: number };
const piece = (part: number, at: readonly number[], size: readonly number[], role: number, sex = BOTH): Piece => ({
  part,
  at: new THREE.Vector3().fromArray(at),
  size: new THREE.Vector3().fromArray(size),
  role,
  sex,
});

/**
 * The low-poly person, sized to `engine-ragdoll.ts`'s `PARTS` (torso, head, L upper/lower arm, R upper/lower arm,
 * L thigh/shin, R thigh/shin): chest wider at the shoulders over a belly and the hips, deltoids, neck; a cranium over
 * a jaw with a flat face, the eyes, hair (a cop's cap) and a fringe (its peak); short sleeves, elbows, hands; thighs,
 * knees, shins and shoes. Every piece narrows toward its far end (`block`), the limbs toward the wrists and ankles.
 */
const PIECES: readonly Piece[] = [
  piece(0, [0, 0.07, 0], [0.4, 0.4, 0.24], SHIRT, MAN),
  piece(0, [0, 0.07, 0], [0.3, 0.4, 0.21], SHIRT, WOMAN),
  piece(0, [0, -0.15, 0], [0.33, 0.16, 0.21], SHIRT, MAN),
  piece(0, [0, -0.15, 0], [0.25, 0.16, 0.18], SHIRT, WOMAN),
  piece(0, [0, -0.26, 0], [0.34, 0.15, 0.22], LEGS, MAN),
  piece(0, [0, -0.26, 0], [0.4, 0.15, 0.23], LEGS, WOMAN),
  piece(0, [-0.215, 0.215, 0], [0.12, 0.13, 0.13], SHIRT, MAN),
  piece(0, [0.215, 0.215, 0], [0.12, 0.13, 0.13], SHIRT, MAN),
  piece(0, [-0.175, 0.215, 0], [0.09, 0.12, 0.12], SHIRT, WOMAN),
  piece(0, [0.175, 0.215, 0], [0.09, 0.12, 0.12], SHIRT, WOMAN),
  // Her hair falls over the back of her shoulders.
  piece(0, [0, 0.15, -0.14], [0.22, 0.3, 0.05], LOCKS, WOMAN),
  piece(0, [0, 0.31, -0.005], [0.09, 0.09, 0.09], SKIN),
  piece(0, [0.095, 0.15, 0.118], [0.055, 0.065, 0.02], BADGE),
  piece(1, [0, 0.03, -0.01], [0.19, 0.18, 0.21], SKIN),
  piece(1, [0, -0.07, 0.015], [0.14, 0.08, 0.16], SKIN),
  piece(1, [0, -0.005, 0.088], [0.15, 0.14, 0.04], SKIN),
  piece(1, [0, 0.025, 0.106], [0.12, 0.028, 0.012], EYES),
  piece(1, [0, 0.095, -0.02], [0.2, 0.075, 0.215], HAIR),
  piece(1, [0, 0.075, 0.1], [0.18, 0.025, 0.09], BRIM),
  piece(1, [0, -0.04, 0.11], [0.085, 0.022, 0.016], MUSTACHE),
  // A man's hair at the nape and over the ears (under a cap); a woman's: the sides, the back and a ponytail.
  piece(1, [0, -0.045, -0.11], [0.18, 0.07, 0.04], LOCKS, MAN),
  piece(1, [-0.108, -0.06, -0.02], [0.05, 0.3, 0.2], LOCKS, WOMAN),
  piece(1, [0.108, -0.06, -0.02], [0.05, 0.3, 0.2], LOCKS, WOMAN),
  piece(1, [0, -0.07, -0.12], [0.22, 0.3, 0.06], LOCKS, WOMAN),
  piece(1, [0, -0.2, -0.17], [0.07, 0.3, 0.08], LOCKS, WOMAN),
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
export function block(): THREE.BufferGeometry {
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
  /** Slots whose dummy is a woman, a bit each. */
  private women = 0;
  /** Slots whose dummy wears a moustache, a bit each. */
  private whiskers = 0;
  /** Every slot's spray (`PERSON_SPRAY`), one bitmap's rows per slot, slot 0 lowest. */
  private readonly sprayRgba: Uint8Array;
  private readonly sprayAtlas: THREE.DataTexture;

  constructor(slots: number) {
    const geo = block();
    // Each piece's middle and size standing (`PARTS` at rest): the spray's rest frame (`PERSON_SPRAY`), the same in every slot.
    const at = new Float32Array(slots * PIECES.length * 3);
    const size = new Float32Array(slots * PIECES.length * 3);
    for (let i = 0; i < slots * PIECES.length; i++) {
      const t = PIECES[i % PIECES.length]!;
      const c = PARTS[t.part]!.c;
      at.set([c[0] + t.at.x, c[1] + t.at.y, c[2] + t.at.z], i * 3);
      t.size.toArray(size, i * 3);
    }
    geo.setAttribute("sprayAt", new THREE.InstancedBufferAttribute(at, 3));
    geo.setAttribute("spraySize", new THREE.InstancedBufferAttribute(size, 3));
    super(geo, new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 }), slots * PIECES.length);
    this.sprayRgba = new Uint8Array(PERSON_SPRAY.w * PERSON_SPRAY.h * 4 * slots);
    this.sprayAtlas = new THREE.DataTexture(this.sprayRgba, PERSON_SPRAY.w, PERSON_SPRAY.h * slots);
    this.sprayAtlas.colorSpace = THREE.SRGBColorSpace;
    this.sprayAtlas.magFilter = THREE.LinearFilter;
    this.sprayAtlas.minFilter = THREE.LinearFilter;
    this.sprayAtlas.needsUpdate = true;
    applySpray(
      this.material,
      sprayUniforms(PERSON_SPRAY, this.sprayAtlas, slots),
      "attribute vec3 sprayAt;\nattribute vec3 spraySize;",
      `vSprayP = sprayAt + position * spraySize;\nvSprayN = normal / spraySize;\nvSprayRow = floor(float(gl_InstanceID) / ${PIECES.length}.0);`,
      "dummy",
    );
    this.material.addEventListener("dispose", () => this.sprayAtlas.dispose());
    for (let i = 0; i < this.count; i++) this.setMatrixAt(i, HIDDEN);
    for (let s = 0; s < slots; s++) this.dress(s, false, { woman: false, shirt: 0x2b2d32, pants: JEANS, hair: 0x2a1d15, hat: null, mustache: false });
    this.count = 0;
  }

  /**
   * Slot `s`'s clothes: a civilian's tee, trousers, hair, cap and moustache from `look`, or (`cop`) a police uniform with the
   * driver's hair under the cap; her build when `look.woman`.
   */
  dress(s: number, cop: boolean, look: DriverLook): void {
    if (look.woman) this.women |= 1 << s;
    else this.women &= ~(1 << s);
    if (look.mustache) this.whiskers |= 1 << s;
    else this.whiskers &= ~(1 << s);
    const base = cop ? COP : CIVILIAN;
    for (let i = 0; i < PIECES.length; i++) {
      const role = PIECES[i]!.role;
      if (!cop && look.hat !== null && role === HAIR) _c.setHex(look.hat);
      else if (!cop && look.hat !== null && role === BRIM) _c.setHex(look.hat).multiplyScalar(PEAK_SHADE);
      else if (role === LOCKS || role === MUSTACHE || (!cop && (role === HAIR || role === BRIM))) _c.setHex(look.hair);
      else if (!cop && role === SHIRT) _c.setHex(look.shirt);
      else if (!cop && role === LEGS) _c.setHex(look.pants);
      else if (!cop && role === BADGE) _c.setHex(look.shirt).multiplyScalar(0.7);
      else _c.setHex(base[role]!);
      this.setColorAt(s * PIECES.length + i, _c);
    }
    this.instanceColor!.needsUpdate = true;
  }

  /** Slot `s` wears `spray`'s paint (a `PERSON_SPRAY` bitmap), or none. */
  spray(s: number, spray: SprayBitmap | null): void {
    const at = s * PERSON_SPRAY.w * PERSON_SPRAY.h * 4;
    if (spray) this.sprayRgba.set(spray.rgba, at);
    else this.sprayRgba.fill(0, at, at + PERSON_SPRAY.w * PERSON_SPRAY.h * 4);
    this.sprayAtlas.needsUpdate = true;
  }

  /** Slot `s`'s body part `k` at pose `p`, `q`: the pieces it carries (those of the other sex, and a moustache it does not wear, stay hidden). */
  pose(s: number, k: number, p: THREE.Vector3, q: THREE.Quaternion): void {
    this.shown |= 1 << s;
    this.count = (32 - Math.clz32(this.shown)) * PIECES.length;
    const woman = (this.women >> s) & 1;
    const whiskers = (this.whiskers >> s) & 1;
    for (let i = 0; i < PIECES.length; i++) {
      const t = PIECES[i]!;
      if (t.part !== k) continue;
      if ((t.sex !== BOTH && (t.sex === WOMAN) !== (woman === 1)) || (t.role === MUSTACHE && whiskers === 0)) {
        this.setMatrixAt(s * PIECES.length + i, HIDDEN);
        continue;
      }
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
