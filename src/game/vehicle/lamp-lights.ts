import * as THREE from "three";
import { lampEmissiveMap, makeLampUnit, type LampKind } from "./car-materials.ts";

/**
 * Lamp light pools, created once and only ever re-aimed or dimmed: adding, removing or hiding a light
 * changes three's lights hash and recompiles every lit material (32c53c1 dropped a 19-light shader
 * for a boot hang). Broken, off and unassigned lights sit at intensity 0. The pool size is chosen once at boot, before the
 * programs link (`CrashEngine`), never per FX tier or mid-race.
 */
export interface LampPool {
  readonly spots: number;
  readonly points: number;
}
export const FULL_POOL: LampPool = { spots: 4, points: 4 };
/** The lean pool a phone can opt into (`?lamps=lean`): every lit fragment loops over every light, and these are 4 of the 8 pooled ones. */
export const PHONE_POOL: LampPool = { spots: 2, points: 2 };

const HEAD = { color: 0xfff1d8, intensity: 40, distance: 22, angle: 0.5, penumbra: 0.55, decay: 2 };
const TAIL = { color: 0xff2414, intensity: 0.5, distance: 2.5, decay: 2 };
/** A lit siren washes the car and the road round it; it outranks every tail lamp but the followed car's. It sits
 *  `out` m over the lens: closer, it blew the lens itself out to orange under ACES (first cut: 6 at 0.3 m). */
const SIREN = { red: 0xff1810, blue: 0x2848ff, intensity: 3, distance: 8, out: 0.8, rank: 1e8 };
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
const GLOW_RED = [1, 0.06, 0.04] as const;
const GLOW_BLUE = [0.08, 0.2, 1] as const;

/** What a lamp slot shows: a body lamp, or a police light bar's red or blue siren. */
export type GlowKind = LampKind | "red" | "blue";

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
  /** Writes lamp `i`'s world seat on the skin and outward axis; returns its kind, or null once broken or dark. */
  lampWorld(i: number, pos: THREE.Vector3, dir: THREE.Vector3): GlowKind | null;
  /** Advance the siren flash to `now` (s); no-op without sirens on. */
  flashSirens(now: number): void;
}

/** The best `size` candidates by ascending score, in place: no allocation per offer. */
class Ranking {
  readonly score: Float64Array;
  readonly pos: THREE.Vector3[];
  readonly dir: THREE.Vector3[];
  readonly kind: GlowKind[];
  readonly size: number;
  count = 0;

  constructor(size: number) {
    this.size = size;
    this.score = new Float64Array(size);
    this.pos = Array.from({ length: size }, () => new THREE.Vector3());
    this.dir = Array.from({ length: size }, () => new THREE.Vector3());
    this.kind = Array.from({ length: size }, (): GlowKind => "tail");
  }

  offer(s: number, p: THREE.Vector3, d: THREE.Vector3, kind: GlowKind): void {
    const k = this.size;
    if (this.count === k && (k === 0 || s >= this.score[k - 1]!)) return;
    let j = this.count < k ? this.count++ : k - 1;
    const sp = this.pos[j]!;
    const sd = this.dir[j]!;
    for (; j > 0 && this.score[j - 1]! > s; j--) {
      this.score[j] = this.score[j - 1]!;
      this.pos[j] = this.pos[j - 1]!;
      this.dir[j] = this.dir[j - 1]!;
      this.kind[j] = this.kind[j - 1]!;
    }
    this.score[j] = s;
    this.pos[j] = sp.copy(p);
    this.dir[j] = sd.copy(d);
    this.kind[j] = kind;
  }
}

/**
 * Every intact lamp glows (one additive point sprite each, one draw for all cars); the fixed light
 * pools go to the highest-priority intact lamps each frame: the followed car first, then the nearest
 * on-screen lamps. White spots for headlamps, short red points for tail lamps; a lit police siren takes
 * a point too, recoloured red or blue (colour and range are uniforms: the lights hash never changes).
 */
export class LampLights {
  readonly spots: THREE.SpotLight[] = [];
  readonly points: THREE.PointLight[] = [];
  readonly glow: THREE.Points;
  private readonly glowPos: THREE.BufferAttribute;
  private readonly glowCol: THREE.BufferAttribute;
  private readonly heads: Ranking;
  private readonly tails: Ranking;
  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();

  constructor(scene: THREE.Scene, maxLamps: number, pool: LampPool = FULL_POOL) {
    this.heads = new Ranking(pool.spots);
    this.tails = new Ranking(pool.points);
    for (let i = 0; i < pool.spots; i++) {
      const s = new THREE.SpotLight(HEAD.color, 0, HEAD.distance, HEAD.angle, HEAD.penumbra, HEAD.decay);
      scene.add(s, s.target);
      this.spots.push(s);
    }
    for (let i = 0; i < pool.points; i++) {
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

  /** After the cars' skin and the camera are final for the frame, before render. `now` (s) clocks the sirens. */
  update(cars: readonly LampHost[], camera: THREE.Camera, followed: LampHost | null, now = performance.now() / 1000): void {
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.viewProj);
    _cam.setFromMatrixPosition(camera.matrixWorld);
    this.heads.count = 0;
    this.tails.count = 0;
    const gp = this.glowPos.array as Float32Array;
    const gc = this.glowCol.array as Float32Array;
    let n = 0;
    for (let ci = 0; ci < cars.length; ci++) {
      const car = cars[ci]!;
      if (!car.group.visible) continue;
      car.flashSirens(now);
      for (let i = 0; i < car.lampCount; i++) {
        const kind = car.lampWorld(i, _pos, _dir);
        if (!kind || n * 3 >= gp.length) continue;
        _e.copy(_pos).addScaledVector(_dir, GLOW_OUT).toArray(gp, n * 3);
        const c = kind === "head" ? GLOW_HEAD : kind === "tail" ? GLOW_TAIL : kind === "red" ? GLOW_RED : GLOW_BLUE;
        gc[n * 3] = c[0];
        gc[n * 3 + 1] = c[1];
        gc[n * 3 + 2] = c[2];
        n++;
        let score = _pos.distanceToSquared(_cam);
        if (car === followed) score -= 1e9;
        else if (!this.frustum.containsPoint(_pos)) score += 1e9;
        if (kind === "head") this.heads.offer(score, _pos, _dir, kind);
        else this.tails.offer(kind === "tail" ? score : score - SIREN.rank, _pos, _dir, kind);
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
      const kind = this.tails.kind[k]!;
      const tail = kind === "tail";
      l.position.copy(this.tails.pos[k]!).addScaledVector(this.tails.dir[k]!, tail ? TAIL_OUT : SIREN.out);
      l.color.setHex(tail ? TAIL.color : kind === "red" ? SIREN.red : SIREN.blue);
      l.distance = tail ? TAIL.distance : SIREN.distance;
      l.intensity = tail ? TAIL.intensity : SIREN.intensity;
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

/** A lamp unit's look: lit head and tail (the tail stays below ACES's bright-red-to-yellow knee so its lens reads red
 *  under its own glow) and broken (either kind). The lens alone emits: `lampEmissiveMap` masks the housing. */
const LAMP_LOOK = {
  head: { color: 0xffffff, emissive: 0xf4f1e8, emissiveIntensity: 1.15 },
  tail: { color: 0xffffff, emissive: 0xe01018, emissiveIntensity: 1.1 },
  broken: { color: 0x5a5c60, emissive: 0x1a1b1c, emissiveIntensity: 0.12 },
} as const;

/**
 * Every car's lamp units as four instanced draws (head / tail × lit / broken) instead of four meshes per car. A car
 * keeps a bare Object3D per lamp that it seats on the skin; `sync` copies the shown ones' world matrices into the
 * batch for the lamp's kind and state once the scene's matrices are current for the frame.
 */
export class LampBatch {
  /** Head lit, head broken, tail lit, tail broken. */
  readonly meshes: readonly THREE.InstancedMesh[];
  private readonly n = [0, 0, 0, 0];

  constructor(capacity: number) {
    const mat = (look: (typeof LAMP_LOOK)[keyof typeof LAMP_LOOK]) =>
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.25, emissiveMap: lampEmissiveMap(), ...look });
    const broken = mat(LAMP_LOOK.broken);
    this.meshes = (["head", "tail"] as const).flatMap((kind) => {
      const geo = makeLampUnit(kind);
      return [mat(LAMP_LOOK[kind]), broken].map((m) => {
        const mesh = new THREE.InstancedMesh(geo, m, capacity);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Instances span the pad and move every frame; a stale bound would cull live lamps.
        mesh.frustumCulled = false;
        mesh.count = 0;
        return mesh;
      });
    });
  }

  /** Pack the shown lamps of `cars` (world matrices must be current). A seat off layer 0 (distance detail) is hidden. */
  sync(cars: readonly { readonly lamps: readonly { readonly seat: THREE.Object3D; readonly intact: boolean; readonly kind: LampKind }[] }[]): void {
    const n = this.n;
    n.fill(0);
    for (const car of cars) {
      for (const l of car.lamps) {
        let shown = l.seat.layers.isEnabled(0);
        for (let p: THREE.Object3D | null = l.seat; p && shown; p = p.parent) shown = p.visible;
        if (!shown) continue;
        const b = (l.kind === "head" ? 0 : 2) + (l.intact ? 0 : 1);
        const mesh = this.meshes[b]!;
        if (n[b]! < mesh.instanceMatrix.count) mesh.setMatrixAt(n[b]!++, l.seat.matrixWorld);
      }
    }
    for (let b = 0; b < 4; b++) {
      const mesh = this.meshes[b]!;
      mesh.count = n[b]!;
      const attr = mesh.instanceMatrix;
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n[b]! * 16);
      attr.needsUpdate = true;
    }
  }

  dispose(): void {
    const mats = new Set<THREE.Material>();
    for (const m of this.meshes) {
      m.geometry.dispose();
      mats.add(m.material as THREE.Material);
      m.dispose();
    }
    for (const m of mats) m.dispose();
  }
}
