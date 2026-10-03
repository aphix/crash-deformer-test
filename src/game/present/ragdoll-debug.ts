import * as THREE from "three";

/** One dummy part: centre and half extents (m) standing, as `PARTS` in engine-ragdoll.ts. */
interface DebugPart {
  readonly c: readonly number[];
  readonly h: readonly number[];
}

/** One spherical joint: parent part, child part, and the joint point standing (m), as `JOINTS`. */
type DebugJoint = readonly [number, number, number, number, number];

/** Box corner index = x | y << 1 | z << 2 (each bit set = the + side). Its 12 edges join corners one bit apart: 24 end corners. */
const EDGE_ENDS = (() => {
  const e: number[] = [];
  for (let a = 0; a < 8; a++) for (let bit = 1; bit < 8; bit <<= 1) if (!(a & bit)) e.push(a, a | bit);
  return Uint8Array.from(e);
})();

/** The car rig view's box colour (`car-core`'s hull helper) and its joint-ish orange (`deform-helper`'s sphere ramp). */
const BOX_RGB = new THREE.Color(0x8aa0b4);
const JOINT_RGB = new THREE.Color(0xd48a4a);
/** Control-particle sphere (`DeformParticleHelper`): radius ∝ ∛mass over the mean, clamped, same constants. */
const RADIUS_BASE = 0.038;
const RADIUS_MIN = 0.024;
const RADIUS_MAX = 0.065;
/** Stand-in for a car particle's travel colour at rest: the cool end of its ramp. */
const POINT_RGB = new THREE.Color(0.72, 0.75, 0.8);

const DENSITY = 1000;

interface Slot {
  readonly group: THREE.Group;
  readonly lines: THREE.LineSegments;
  readonly points: THREE.InstancedMesh;
  readonly linePos: Float32Array;
  readonly sphereM: Float32Array;
  /** Each part's pose, xyz + xyzw, this frame: joints are drawn once both their parts are in. */
  readonly pose: Float32Array;
}

/**
 * Rig and Particles views of the thrown dummies (HUD toggles). Rig: every part's box at its drawn pose, and each
 * joint as part centre → joint point → joint point → part centre (the middle leg is the joint's gap, zero when
 * it holds). Particles: a sphere at every part's centre of mass (a uniform box: its centre). Fed by `pose`, from
 * the same call that poses the drawn dummy, so it lines up with it and a part costs nothing extra to read; built on
 * first use; nothing runs while both views are off.
 */
export class RagdollDebug {
  private rig = false;
  private particles = false;
  private slots: Slot[] | null = null;
  private readonly corners: Float32Array[];
  private readonly radius: Float32Array;
  /** Joint point in each end part's own frame: [parent xyz, child xyz] per joint. */
  private readonly anchors: Float32Array;
  /** Joints whose later part is part `k`: complete the frame its pose arrives. */
  private readonly at: number[][];
  private readonly boxVerts: number;
  private readonly lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false });
  private readonly pointMat = new THREE.MeshBasicMaterial({ color: POINT_RGB, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false });
  private readonly sphere = new THREE.SphereGeometry(1, 10, 8);

  private readonly scene: THREE.Scene;
  private readonly parts: readonly DebugPart[];
  private readonly joints: readonly DebugJoint[];
  private readonly count: number;

  constructor(scene: THREE.Scene, parts: readonly DebugPart[], joints: readonly DebugJoint[], count: number) {
    this.scene = scene;
    this.parts = parts;
    this.joints = joints;
    this.count = count;
    this.corners = parts.map((p) => {
      const out = new Float32Array(24);
      for (let i = 0; i < 8; i++) for (let a = 0; a < 3; a++) out[i * 3 + a] = (i >> a) & 1 ? p.h[a]! : -p.h[a]!;
      return out;
    });
    const mass = parts.map((p) => DENSITY * 8 * p.h[0]! * p.h[1]! * p.h[2]!);
    const mean = mass.reduce((s, m) => s + m, 0) / parts.length;
    this.radius = Float32Array.from(mass, (m) => THREE.MathUtils.clamp(RADIUS_BASE * Math.cbrt(m / mean), RADIUS_MIN, RADIUS_MAX));
    this.anchors = new Float32Array(joints.length * 6);
    this.at = parts.map(() => []);
    joints.forEach(([a, b, x, y, z], j) => {
      for (let i = 0; i < 3; i++) {
        const w = [x, y, z][i]!;
        this.anchors[j * 6 + i] = w - parts[a]!.c[i]!;
        this.anchors[j * 6 + 3 + i] = w - parts[b]!.c[i]!;
      }
      this.at[Math.max(a, b)]!.push(j);
    });
    this.boxVerts = parts.length * EDGE_ENDS.length;
  }

  /** A view is on: the one-line guard for callers' `pose` hook. */
  on = false;

  /** The HUD toggles' state: what to draw on every dummy now and on any thrown after. */
  set(rig: boolean, particles: boolean): void {
    this.rig = rig;
    this.particles = particles;
    this.on = rig || particles;
    if (this.on && !this.slots) this.slots = Array.from({ length: this.count }, () => this.build());
    for (const s of this.slots ?? []) {
      s.lines.visible = rig;
      s.points.visible = particles;
      if (!this.on) s.group.visible = false;
    }
  }

  /** Part `k` of dummy `s` is drawn at `p`, `q` (call in part order, after `set` turned a view on). */
  pose(s: number, k: number, p: THREE.Vector3, q: THREE.Quaternion): void {
    const slot = this.slots![s]!;
    slot.group.visible = true;
    const pose = slot.pose;
    pose[k * 7] = p.x;
    pose[k * 7 + 1] = p.y;
    pose[k * 7 + 2] = p.z;
    pose[k * 7 + 3] = q.x;
    pose[k * 7 + 4] = q.y;
    pose[k * 7 + 5] = q.z;
    pose[k * 7 + 6] = q.w;
    if (this.rig) {
      this.writeBox(slot.linePos, k * EDGE_ENDS.length * 3, k, pose);
      for (const j of this.at[k]!) this.writeJoint(slot.linePos, this.boxVerts * 3 + j * 18, j, pose);
      (slot.lines.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    }
    if (this.particles) {
      const m = slot.sphereM;
      const r = this.radius[k]!;
      m[k * 16] = r;
      m[k * 16 + 5] = r;
      m[k * 16 + 10] = r;
      m[k * 16 + 12] = p.x;
      m[k * 16 + 13] = p.y;
      m[k * 16 + 14] = p.z;
      slot.points.instanceMatrix.needsUpdate = true;
    }
  }

  /** Dummy `s` is gone (or recycled): drop its objects from the draw. */
  hide(s: number): void {
    if (this.slots) this.slots[s]!.group.visible = false;
  }

  dispose(): void {
    for (const s of this.slots ?? []) {
      this.scene.remove(s.group);
      s.lines.geometry.dispose();
      s.points.dispose();
    }
    this.slots = null;
    this.lineMat.dispose();
    this.pointMat.dispose();
    this.sphere.dispose();
  }

  private build(): Slot {
    const n = this.parts.length;
    const verts = this.boxVerts + this.joints.length * 6;
    const linePos = new Float32Array(verts * 3);
    const colour = new Float32Array(verts * 3);
    for (let v = 0; v < verts; v++) (v < this.boxVerts ? BOX_RGB : JOINT_RGB).toArray(colour, v * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("color", new THREE.BufferAttribute(colour, 3));
    const lines = new THREE.LineSegments(geo, this.lineMat);
    lines.renderOrder = 4;
    lines.frustumCulled = false;
    lines.visible = this.rig;
    const points = new THREE.InstancedMesh(this.sphere, this.pointMat, n);
    points.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const sphereM = points.instanceMatrix.array as Float32Array;
    for (let i = 0; i < n; i++) sphereM[i * 16 + 15] = 1;
    points.renderOrder = 6;
    points.frustumCulled = false;
    points.visible = this.particles;
    const group = new THREE.Group();
    group.name = "ragdoll-debug";
    group.visible = false;
    group.add(lines, points);
    this.scene.add(group);
    return { group, lines, points, linePos, sphereM, pose: new Float32Array(n * 7) };
  }

  /** Part `k`'s box edges at `o` (EDGE_ENDS.length × 3 floats). */
  private writeBox(out: Float32Array, o: number, k: number, pose: Float32Array): void {
    const c = this.corners[k]!;
    const b = k * 7;
    const x = pose[b + 3]!;
    const y = pose[b + 4]!;
    const z = pose[b + 5]!;
    const w = pose[b + 6]!;
    const r00 = 1 - 2 * (y * y + z * z);
    const r01 = 2 * (x * y - z * w);
    const r02 = 2 * (x * z + y * w);
    const r10 = 2 * (x * y + z * w);
    const r11 = 1 - 2 * (x * x + z * z);
    const r12 = 2 * (y * z - x * w);
    const r20 = 2 * (x * z - y * w);
    const r21 = 2 * (y * z + x * w);
    const r22 = 1 - 2 * (x * x + y * y);
    for (let v = 0; v < EDGE_ENDS.length; v++) {
      const i = EDGE_ENDS[v]!;
      const lx = c[i * 3]!;
      const ly = c[i * 3 + 1]!;
      const lz = c[i * 3 + 2]!;
      out[o++] = pose[b]! + r00 * lx + r01 * ly + r02 * lz;
      out[o++] = pose[b + 1]! + r10 * lx + r11 * ly + r12 * lz;
      out[o++] = pose[b + 2]! + r20 * lx + r21 * ly + r22 * lz;
    }
  }

  /** Joint `j` at `o` (18 floats): parent centre → its joint point → child's joint point → child centre. */
  private writeJoint(out: Float32Array, o: number, j: number, pose: Float32Array): void {
    const joint = this.joints[j]!;
    const pa = joint[0] * 7;
    const pb = joint[1] * 7;
    // Anchors in world: the part's own position + its rotation applied to the local joint point.
    const wa = o + 3;
    const wb = o + 6;
    this.anchorWorld(out, wa, pose, pa, j * 6);
    this.anchorWorld(out, wb, pose, pb, j * 6 + 3);
    out[o] = pose[pa]!;
    out[o + 1] = pose[pa + 1]!;
    out[o + 2] = pose[pa + 2]!;
    out[o + 9] = out[wa]!;
    out[o + 10] = out[wa + 1]!;
    out[o + 11] = out[wa + 2]!;
    out[o + 12] = out[wb]!;
    out[o + 13] = out[wb + 1]!;
    out[o + 14] = out[wb + 2]!;
    out[o + 15] = pose[pb]!;
    out[o + 16] = pose[pb + 1]!;
    out[o + 17] = pose[pb + 2]!;
  }

  private anchorWorld(out: Float32Array, o: number, pose: Float32Array, b: number, ai: number): void {
    const x = pose[b + 3]!;
    const y = pose[b + 4]!;
    const z = pose[b + 5]!;
    const w = pose[b + 6]!;
    const lx = this.anchors[ai]!;
    const ly = this.anchors[ai + 1]!;
    const lz = this.anchors[ai + 2]!;
    out[o] = pose[b]! + (1 - 2 * (y * y + z * z)) * lx + 2 * (x * y - z * w) * ly + 2 * (x * z + y * w) * lz;
    out[o + 1] = pose[b + 1]! + 2 * (x * y + z * w) * lx + (1 - 2 * (x * x + z * z)) * ly + 2 * (y * z - x * w) * lz;
    out[o + 2] = pose[b + 2]! + 2 * (x * z - y * w) * lx + 2 * (y * z + x * w) * ly + (1 - 2 * (x * x + y * y)) * lz;
  }
}
