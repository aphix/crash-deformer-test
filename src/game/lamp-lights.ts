import * as THREE from "three";
import type { LampKind } from "./car-materials.ts";

/**
 * Lamp light pools, created once and only ever re-aimed or dimmed: adding, removing or hiding a light
 * changes three's lights hash and recompiles every lit material (32c53c1 dropped a 19-light shader
 * for a boot hang). Broken, off and unassigned lights sit at intensity 0.
 */
export const SPOT_POOL = 4;
const POINT_POOL = 4;

const HEAD = { color: 0xfff1d8, intensity: 40, distance: 22, angle: 0.5, penumbra: 0.55, decay: 2 };
const TAIL = { color: 0xff2414, intensity: 0.5, distance: 2.5, decay: 2 };
/** Headlamp aim: a point AIM m ahead dipped DIP m (≈5°), so the beam pools on the road. */
const AIM = 10;
const DIP = 0.9;
/** Offsets along the lamp axis from its seat on the skin (the lens face is at +0.045, `makeLampUnit`):
 *  the tail light washes the bumper and road rather than the boot floor; the glow sprite clears the lens. */
const TAIL_OUT = 0.5;
/** Glow sprite world size (m). */
const GLOW_SIZE = 0.7;
const GLOW_OUT = 0.1;
const GLOW_HEAD = [0.8, 0.7, 0.55] as const;
const GLOW_TAIL = [0.55, 0.03, 0.015] as const;

/** A lamp seated on one body-skin facet (see `anchorOnSkin`). */
export interface SkinAnchor {
  readonly verts: readonly [number, number, number];
  /** Barycentric weights of the lamp origin's projection onto the facet. */
  readonly w: readonly [number, number, number];
  /** Rest offset of the origin along the facet normal. */
  readonly h: number;
  /** Rest rotation of the lamp in the facet frame. */
  readonly rel: THREE.Quaternion;
}

/**
 * Anchor a lamp at `origin` / `rest` to the skin facet it sits on: the non-degenerate triangle of
 * the indexed `geo` nearest the origin, so its weights are in [0, 1] and the lamp rides that patch
 * of skin. Build-time only (one pass over the triangles).
 */
export function anchorOnSkin(geo: THREE.BufferGeometry, origin: THREE.Vector3, rest: THREE.Quaternion): SkinAnchor {
  const pos = geo.getAttribute("position").array;
  const index = geo.index?.array;
  if (!index) throw new Error("anchorOnSkin: the skin must be indexed");
  let best = -1;
  let bestD = Infinity;
  for (let t = 0; t < index.length; t += 3) {
    _tri.a.fromArray(pos, index[t]! * 3);
    _tri.b.fromArray(pos, index[t + 1]! * 3);
    _tri.c.fromArray(pos, index[t + 2]! * 3);
    if (_tri.getArea() < 1e-6) continue;
    const d = _tri.closestPointToPoint(origin, _e).distanceToSquared(origin);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  if (best < 0) throw new Error("anchorOnSkin: no skin facet");
  const verts = [index[best]!, index[best + 1]!, index[best + 2]!] as const;
  frameAt(pos, verts);
  THREE.Triangle.getBarycoord(origin, _a, _b, _c, _d);
  return {
    verts,
    w: [_d.x, _d.y, _d.z],
    h: _e.subVectors(origin, _a).dot(_n),
    rel: new THREE.Quaternion().setFromRotationMatrix(_m).invert().multiply(rest),
  };
}

/** Seat an anchored lamp on the current skin: origin = Σwᵢ·vᵢ + h·n, rotation = frame · rel. */
export function poseOnSkin(anchor: SkinAnchor, pos: ArrayLike<number>, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
  frameAt(pos, anchor.verts);
  const [wa, wb, wc] = anchor.w;
  outPos.copy(_a).multiplyScalar(wa).addScaledVector(_b, wb).addScaledVector(_c, wc).addScaledVector(_n, anchor.h);
  outQuat.setFromRotationMatrix(_m).multiply(anchor.rel);
}

/** Loads `_a/_b/_c` and the frame `_m` = (edge ab, n × ab, n) with unit normal `_n`. */
function frameAt(pos: ArrayLike<number>, [a, b, c]: readonly [number, number, number]): void {
  _a.fromArray(pos, a * 3);
  _b.fromArray(pos, b * 3);
  _c.fromArray(pos, c * 3);
  _t.subVectors(_b, _a).normalize();
  _n.crossVectors(_t, _d.subVectors(_c, _a)).normalize();
  _m.makeBasis(_t, _d.crossVectors(_n, _t), _n);
}

/** What the pool reads from a car; `DeformableCar` satisfies it. */
interface LampHost {
  readonly group: THREE.Object3D;
  readonly lampCount: number;
  /** Writes lamp `i`'s world seat on the skin and outward axis; returns its kind, or null once broken. */
  lampWorld(i: number, pos: THREE.Vector3, dir: THREE.Vector3): LampKind | null;
}

/** The best `size` candidates by ascending score, in place: no allocation per offer. */
class Ranking {
  readonly score: Float64Array;
  readonly pos: THREE.Vector3[];
  readonly dir: THREE.Vector3[];
  readonly size: number;
  count = 0;

  constructor(size: number) {
    this.size = size;
    this.score = new Float64Array(size);
    this.pos = Array.from({ length: size }, () => new THREE.Vector3());
    this.dir = Array.from({ length: size }, () => new THREE.Vector3());
  }

  offer(s: number, p: THREE.Vector3, d: THREE.Vector3): void {
    const k = this.size;
    if (this.count === k && (k === 0 || s >= this.score[k - 1]!)) return;
    let j = this.count < k ? this.count++ : k - 1;
    const sp = this.pos[j]!;
    const sd = this.dir[j]!;
    for (; j > 0 && this.score[j - 1]! > s; j--) {
      this.score[j] = this.score[j - 1]!;
      this.pos[j] = this.pos[j - 1]!;
      this.dir[j] = this.dir[j - 1]!;
    }
    this.score[j] = s;
    this.pos[j] = sp.copy(p);
    this.dir[j] = sd.copy(d);
  }
}

/**
 * Every intact lamp glows (one additive point sprite each, one draw for all cars); the fixed light
 * pools go to the highest-priority intact lamps each frame: the followed car first, then the nearest
 * on-screen lamps. White spots for headlamps, short red points for tail lamps.
 */
export class LampLights {
  readonly spots: THREE.SpotLight[] = [];
  readonly points: THREE.PointLight[] = [];
  readonly glow: THREE.Points;
  private readonly glowPos: THREE.BufferAttribute;
  private readonly glowCol: THREE.BufferAttribute;
  private readonly heads = new Ranking(SPOT_POOL);
  private readonly tails = new Ranking(POINT_POOL);
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();

  constructor(scene: THREE.Scene, maxLamps: number) {
    for (let i = 0; i < SPOT_POOL; i++) {
      const s = new THREE.SpotLight(HEAD.color, 0, HEAD.distance, HEAD.angle, HEAD.penumbra, HEAD.decay);
      scene.add(s, s.target);
      this.spots.push(s);
    }
    for (let i = 0; i < POINT_POOL; i++) {
      const p = new THREE.PointLight(TAIL.color, 0, TAIL.distance, TAIL.decay);
      scene.add(p);
      this.points.push(p);
    }
    const geo = new THREE.BufferGeometry();
    this.glowPos = new THREE.BufferAttribute(new Float32Array(maxLamps * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.glowCol = new THREE.BufferAttribute(new Float32Array(maxLamps * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.glowPos);
    geo.setAttribute("color", this.glowCol);
    geo.setDrawRange(0, 0);
    this.glow = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: GLOW_SIZE,
        map: glowSprite(),
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.glow.frustumCulled = false;
    scene.add(this.glow);
  }

  /** After the cars' skin and the camera are final for the frame, before render. */
  update(cars: readonly LampHost[], camera: THREE.Camera, followed: LampHost | null): void {
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    _cam.setFromMatrixPosition(camera.matrixWorld);
    this.heads.count = 0;
    this.tails.count = 0;
    const gp = this.glowPos.array as Float32Array;
    const gc = this.glowCol.array as Float32Array;
    let n = 0;
    for (const car of cars) {
      if (!car.group.visible) continue;
      for (let i = 0; i < car.lampCount; i++) {
        const kind = car.lampWorld(i, _pos, _dir);
        if (!kind || n * 3 >= gp.length) continue;
        _e.copy(_pos).addScaledVector(_dir, GLOW_OUT).toArray(gp, n * 3);
        const c = kind === "head" ? GLOW_HEAD : GLOW_TAIL;
        gc[n * 3] = c[0];
        gc[n * 3 + 1] = c[1];
        gc[n * 3 + 2] = c[2];
        n++;
        let score = _pos.distanceToSquared(_cam);
        if (car === followed) score -= 1e9;
        else if (!this.frustum.containsPoint(_pos)) score += 1e9;
        (kind === "head" ? this.heads : this.tails).offer(score, _pos, _dir);
      }
    }
    this.glow.geometry.setDrawRange(0, n);
    this.glowPos.needsUpdate = true;
    this.glowCol.needsUpdate = true;

    for (let k = 0; k < this.spots.length; k++) {
      const s = this.spots[k]!;
      if (k >= this.heads.count) {
        s.intensity = 0;
        continue;
      }
      const p = this.heads.pos[k]!;
      const d = this.heads.dir[k]!;
      s.position.copy(p);
      s.target.position.copy(p).addScaledVector(d, AIM);
      s.target.position.y -= DIP;
      s.intensity = HEAD.intensity;
    }
    for (let k = 0; k < this.points.length; k++) {
      const l = this.points[k]!;
      if (k >= this.tails.count) {
        l.intensity = 0;
        continue;
      }
      l.position.copy(this.tails.pos[k]!).addScaledVector(this.tails.dir[k]!, TAIL_OUT);
      l.intensity = TAIL.intensity;
    }
  }

  dispose(): void {
    for (const l of [...this.spots, ...this.points]) l.dispose();
    const mat = this.glow.material as THREE.PointsMaterial;
    mat.map?.dispose();
    mat.dispose();
    this.glow.geometry.dispose();
  }
}

/** Soft round falloff, white with alpha (1 − r)²; built in code so it needs no DOM. */
function glowSprite(): THREE.DataTexture {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.min(1, Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2));
      const o = (y * n + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = 255;
      data[o + 3] = Math.round(255 * (1 - r) ** 2);
    }
  }
  const t = new THREE.DataTexture(data, n, n);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _tri = new THREE.Triangle();
const _cam = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
