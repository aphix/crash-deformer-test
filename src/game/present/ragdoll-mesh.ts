import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";

type V3 = readonly [number, number, number];

/** FlatOut's thrown driver, in instance colours (sRGB): dark tee, skin, jeans, short dark hair, dark shoes. */
const TEE = new THREE.Color(0x2b2d32);
const SKIN = new THREE.Color(0xd8a27f);
const JEANS = new THREE.Color(0x3a4d6d);
const HAIR = new THREE.Color(0x2a1d15);
const SHOE = new THREE.Color(0x1c1c1e);
/** Body parts in `PARTS` order: torso, head, L upper/lower arm, R upper/lower arm, L thigh/shin, R thigh/shin. */
const PART_COLOR = [TEE, SKIN, TEE, SKIN, TEE, SKIN, JEANS, JEANS, JEANS, JEANS];
/** Parts drawn past their colliders (x, y, z): the rounding shaves the box, and limb ends overlap at the joints. */
const GROW = [1.04, 1.1, 1.04] as const;

/** A render-only piece riding body part `part`: centre and size (m) in the part's body frame (−y a limb's far end, +z the front). */
type Trim = { part: number; at: THREE.Vector3; size: THREE.Vector3; color: THREE.Color };

/** Hips (jeans up to the waist), shoulders, neck, a short hair cap, hands and shoes, sized off the parts' drawn half extents `h`. */
function trims(h: readonly V3[]): Trim[] {
  const trim = (part: number, at: V3, size: V3, color: THREE.Color): Trim => ({ part, at: new THREE.Vector3(...at), size: new THREE.Vector3(...size), color });
  const [torso, head] = [h[0]!, h[1]!];
  const out = [
    trim(0, [0, 0.08 - torso[1], 0], [torso[0] * 2.04, 0.18, torso[2] * 2.08], JEANS),
    trim(0, [0, torso[1] - 0.07, 0], [torso[0] * 2.5, 0.15, torso[2] * 1.9], TEE),
    trim(0, [0, torso[1], 0], [0.09, 0.1, 0.09], SKIN),
    trim(1, [0, head[1] * 0.3, -0.025], [head[0] * 2.12, head[1] * 1.6, head[2] * 2.05], HAIR),
  ];
  // Hands past the lower arms' far ends (flat across x, the palm), shoes over the shins' ends with the toe forward.
  for (const k of [3, 5]) out.push(trim(k, [0, -h[k]![1] - 0.035, 0], [0.045, 0.1, 0.085], SKIN));
  for (const k of [7, 9]) out.push(trim(k, [0, -h[k]![1] + 0.04, 0.05], [h[k]![0] * 2 + 0.012, 0.09, 0.26], SHOE));
  return out;
}

const _m = new THREE.Matrix4();
const _o = new THREE.Vector3();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Every dummy in one instanced draw: each body part a rounded box a little over its collider (rounded on every
 * axis in proportion, so limbs read as capsules), then its trims posed off their parts. The draw ends after the
 * highest slot with a dummy out.
 */
export class DummyMesh extends THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  /** Instances per dummy: its parts, then its trims. */
  private readonly per: number;
  /** Each part's drawn size (m). */
  private readonly sizes: THREE.Vector3[];
  private readonly trims: Trim[];
  /** Slots with a dummy out, a bit each. */
  private shown = 0;

  /** `half`: the parts' collider half extents (m). */
  constructor(slots: number, half: readonly V3[]) {
    const drawn = half.map((h): V3 => [h[0] * GROW[0], h[1] * GROW[1], h[2] * GROW[2]]);
    const t = trims(drawn);
    const per = half.length + t.length;
    super(mergeVertices(new RoundedBoxGeometry(1, 1, 1, 2, 0.42)), new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0 }), slots * per);
    this.per = per;
    this.sizes = drawn.map((h) => new THREE.Vector3(h[0] * 2, h[1] * 2, h[2] * 2));
    this.trims = t;
    for (let i = 0; i < this.count; i++) {
      const j = i % per;
      this.setMatrixAt(i, HIDDEN);
      this.setColorAt(i, j < half.length ? PART_COLOR[j]! : t[j - half.length]!.color);
    }
    this.count = 0;
  }

  /** Slot `s`'s part `k` at body pose `p`, `q`, with the trims it carries. */
  pose(s: number, k: number, p: THREE.Vector3, q: THREE.Quaternion): void {
    this.shown |= 1 << s;
    this.count = (32 - Math.clz32(this.shown)) * this.per;
    this.setMatrixAt(s * this.per + k, _m.compose(p, q, this.sizes[k]!));
    for (let i = 0; i < this.trims.length; i++) {
      const t = this.trims[i]!;
      if (t.part !== k) continue;
      _o.copy(t.at).applyQuaternion(q).add(p);
      this.setMatrixAt(s * this.per + this.sizes.length + i, _m.compose(_o, q, t.size));
    }
    this.instanceMatrix.needsUpdate = true;
  }

  hide(s: number): void {
    this.shown &= ~(1 << s);
    this.count = (32 - Math.clz32(this.shown)) * this.per;
    for (let i = 0; i < this.per; i++) this.setMatrixAt(s * this.per + i, HIDDEN);
    this.instanceMatrix.needsUpdate = true;
  }
}
