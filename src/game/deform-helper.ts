import * as THREE from "three";
import { m3FrobeniusI, type ShapeCluster } from "./shape-match.ts";
import type { DeformMode } from "./streamed-deform.ts";

/** What the rig view reads from a StreamedDeformation. Never written through. */
export interface DeformRigView {
  readonly cages: readonly { readonly corners: readonly THREE.Vector3[] }[];
  readonly sensors: readonly { readonly rest: THREE.Vector3; readonly pos: THREE.Vector3; readonly compression: number }[];
  readonly masses: readonly {
    readonly rest: THREE.Vector3;
    readonly local: THREE.Vector3;
    readonly mass: number;
    readonly clipping: boolean;
  }[];
  readonly beams: readonly { readonly a: number; readonly b: number; readonly rest: number; readonly restDir: THREE.Vector3 }[];
  readonly clusters: readonly Pick<ShapeCluster, "idx" | "Sp">[];
  mode(): DeformMode;
}

/** One toggleable slice of the rig view; owns its scene object and GPU resources. */
interface RigLayer {
  readonly object: THREE.Object3D;
  /** Only shown in this solver mode; null = always. */
  readonly onlyIn: DeformMode | null;
  update(): void;
  dispose(): void;
}

const _n = new THREE.Vector3();

const CAGE_EDGES: readonly (readonly [number, number])[] = [
  [0, 1],
  [2, 3],
  [4, 5],
  [6, 7],
  [0, 2],
  [1, 3],
  [4, 6],
  [5, 7],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/**
 * Debug view of the deformation rig (sensors, control masses, FFD cages, lattice
 * beams, shape-match clusters), parented under the car. Detached from the scene
 * while hidden so it costs no per-frame matrix updates.
 */
export class DeformRigHelper {
  readonly group = new THREE.Group();
  private readonly layers: RigLayer[];
  private readonly parent: THREE.Object3D;
  private readonly view: DeformRigView;

  constructor(parent: THREE.Object3D, view: DeformRigView) {
    this.parent = parent;
    this.view = view;
    this.group.name = "deform-rig";
    this.group.visible = false;
    this.layers = [
      new SensorLayer(view),
      new MassLayer(view),
      new CageLayer(view),
      new BeamLayer(view),
      new ClusterLayer(view),
    ];
    for (const layer of this.layers) {
      this.group.add(layer.object);
      layer.update();
    }
    this.syncMode();
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
    if (v) {
      this.parent.add(this.group);
      this.update();
    } else this.group.removeFromParent();
  }

  update(): void {
    if (!this.group.visible) return;
    for (const layer of this.layers) layer.update();
    this.syncMode();
  }

  syncMode(): void {
    const mode = this.view.mode();
    for (const layer of this.layers) if (layer.onlyIn) layer.object.visible = layer.onlyIn === mode;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const layer of this.layers) layer.dispose();
  }
}

function lineSegments(vertexPairs: number, renderOrder: number, color: THREE.ColorRepresentation | null, opacity: number): THREE.LineSegments {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertexPairs * 2 * 3), 3));
  if (color === null) geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertexPairs * 2 * 3), 3));
  const mat = new THREE.LineBasicMaterial({
    ...(color === null ? { vertexColors: true } : { color }),
    transparent: true,
    opacity,
    depthTest: false,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = renderOrder;
  return lines;
}

function attr(lines: THREE.LineSegments, name: "position" | "color"): THREE.BufferAttribute {
  return lines.geometry.getAttribute(name) as THREE.BufferAttribute;
}

function disposeLines(lines: THREE.LineSegments): void {
  lines.geometry.dispose();
  (lines.material as THREE.Material).dispose();
}

function sphereGroup(count: number, radius: number, color: number, opacity: number, renderOrder: number): { object: THREE.Group; meshes: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] } {
  const object = new THREE.Group();
  const geo = new THREE.SphereGeometry(radius, 10, 8);
  const meshes: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[] = [];
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = renderOrder;
    object.add(mesh);
    meshes.push(mesh);
  }
  return { object, meshes };
}

function disposeSpheres(meshes: readonly THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[]): void {
  for (const mesh of meshes) mesh.material.dispose();
  meshes[0]?.geometry.dispose();
}

/** Crush sensors: grow and redden with compression. */
class SensorLayer implements RigLayer {
  readonly object: THREE.Group;
  readonly onlyIn = null;
  private readonly meshes: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[];
  private readonly view: DeformRigView;

  constructor(view: DeformRigView) {
    this.view = view;
    ({ object: this.object, meshes: this.meshes } = sphereGroup(view.sensors.length, 0.045, 0xb9c4d4, 0.7, 3));
  }

  update(): void {
    const sensors = this.view.sensors;
    for (let i = 0; i < sensors.length; i++) {
      const s = sensors[i]!;
      const mesh = this.meshes[i]!;
      mesh.position.copy(s.pos);
      const c = s.compression;
      mesh.scale.setScalar(1 + c * 0.85);
      mesh.material.color.setRGB(0.72 + c * 0.28, 0.75 - c * 0.45, 0.8 - c * 0.65);
    }
  }

  dispose(): void {
    disposeSpheres(this.meshes);
  }
}

/** Control masses: purple while clipping, red once displaced, mode tint at rest. */
class MassLayer implements RigLayer {
  readonly object: THREE.Group;
  readonly onlyIn = null;
  private readonly meshes: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[];
  private readonly view: DeformRigView;

  constructor(view: DeformRigView) {
    this.view = view;
    ({ object: this.object, meshes: this.meshes } = sphereGroup(view.masses.length, 0.055, 0xd4894a, 0.85, 4));
  }

  update(): void {
    const masses = this.view.masses;
    const shape = this.view.mode() === "shape";
    for (let i = 0; i < masses.length; i++) {
      const m = masses[i]!;
      const mesh = this.meshes[i]!;
      mesh.position.copy(m.local);
      const travel = m.local.distanceTo(m.rest);
      mesh.scale.setScalar(shape ? 1.55 : 1);
      const color = mesh.material.color;
      if (m.clipping) color.setRGB(0.72, 0.22, 0.95);
      else if (travel > 0.08) color.setRGB(0.95, 0.18 + travel * 0.2, 0.14);
      else if (shape) color.setRGB(0.45, 0.85, 1);
      else color.setRGB(0.83, 0.54, 0.29);
    }
  }

  dispose(): void {
    disposeSpheres(this.meshes);
  }
}

/** FFD cage wireframes. */
class CageLayer implements RigLayer {
  readonly object: THREE.LineSegments;
  readonly onlyIn = null;
  private readonly view: DeformRigView;

  constructor(view: DeformRigView) {
    this.view = view;
    this.object = lineSegments(view.cages.length * CAGE_EDGES.length, 2, 0xd8d4cc, 0.35);
  }

  update(): void {
    const posAttr = attr(this.object, "position");
    const pos = posAttr.array as Float32Array;
    let o = 0;
    for (const cage of this.view.cages) {
      for (const [a, b] of CAGE_EDGES) {
        const pa = cage.corners[a]!;
        const pb = cage.corners[b]!;
        pos[o++] = pa.x;
        pos[o++] = pa.y;
        pos[o++] = pa.z;
        pos[o++] = pb.x;
        pos[o++] = pb.y;
        pos[o++] = pb.z;
      }
    }
    posAttr.needsUpdate = true;
  }

  dispose(): void {
    disposeLines(this.object);
  }
}

/** Lattice beams coloured by state: compression red, shear orange, tension blue. */
class BeamLayer implements RigLayer {
  readonly object: THREE.LineSegments;
  readonly onlyIn = "lattice";
  private readonly view: DeformRigView;

  constructor(view: DeformRigView) {
    this.view = view;
    this.object = lineSegments(view.beams.length, 3, null, 0.92);
  }

  update(): void {
    const posAttr = attr(this.object, "position");
    const colAttr = attr(this.object, "color");
    const pos = posAttr.array as Float32Array;
    const col = colAttr.array as Float32Array;
    const masses = this.view.masses;
    let o = 0;
    let c = 0;
    for (const beam of this.view.beams) {
      const a = masses[beam.a]!;
      const b = masses[beam.b]!;
      pos[o++] = a.local.x;
      pos[o++] = a.local.y;
      pos[o++] = a.local.z;
      pos[o++] = b.local.x;
      pos[o++] = b.local.y;
      pos[o++] = b.local.z;
      _n.copy(b.local).sub(a.local);
      const along = _n.x * beam.restDir.x + _n.y * beam.restDir.y + _n.z * beam.restDir.z;
      const strain = (along - beam.rest) / Math.max(beam.rest, 1e-4);
      const shear = Math.hypot(_n.x - beam.restDir.x * along, _n.y - beam.restDir.y * along, _n.z - beam.restDir.z * along) / Math.max(beam.rest, 1e-4);
      let r = 0.9,
        g = 0.9,
        bl = 0.88;
      if (a.clipping || b.clipping) {
        r = 0.72;
        g = 0.2;
        bl = 0.95;
      } else if (strain < -0.04) {
        const t = THREE.MathUtils.clamp(-strain / 0.35, 0, 1);
        r = 0.95;
        g = 0.12 + (1 - t) * 0.35;
        bl = 0.1;
      } else if (shear > 0.08) {
        const t = THREE.MathUtils.clamp(shear / 0.4, 0, 1);
        r = 0.98;
        g = 0.42 + (1 - t) * 0.2;
        bl = 0.08;
      } else if (strain > 0.06) {
        r = 0.45;
        g = 0.75;
        bl = 0.95;
      }
      col[c++] = r;
      col[c++] = g;
      col[c++] = bl;
      col[c++] = r;
      col[c++] = g;
      col[c++] = bl;
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  dispose(): void {
    disposeLines(this.object);
  }
}

/** Shape-match clusters as stars from each member to the cluster COM; tint = plastic strain. */
class ClusterLayer implements RigLayer {
  readonly object: THREE.LineSegments;
  readonly onlyIn = "shape";
  private readonly view: DeformRigView;

  constructor(view: DeformRigView) {
    this.view = view;
    let star = 0;
    for (const cl of view.clusters) star += cl.idx.length;
    this.object = lineSegments(Math.max(star, 1), 4, null, 0.85);
  }

  update(): void {
    const posAttr = attr(this.object, "position");
    const colAttr = attr(this.object, "color");
    const pos = posAttr.array as Float32Array;
    const col = colAttr.array as Float32Array;
    const masses = this.view.masses;
    let o = 0;
    let c = 0;
    for (const cl of this.view.clusters) {
      const pe = m3FrobeniusI(cl.Sp);
      const r = 0.35 + Math.min(1, pe) * 0.6;
      const g = 0.75 - Math.min(1, pe) * 0.45;
      const b = 0.95;
      let cx = 0,
        cy = 0,
        cz = 0,
        w = 0;
      for (const pi of cl.idx) {
        const m = masses[pi]!;
        cx += m.local.x * m.mass;
        cy += m.local.y * m.mass;
        cz += m.local.z * m.mass;
        w += m.mass;
      }
      w = Math.max(w, 1e-6);
      cx /= w;
      cy /= w;
      cz /= w;
      for (const pi of cl.idx) {
        const m = masses[pi]!;
        pos[o++] = m.local.x;
        pos[o++] = m.local.y;
        pos[o++] = m.local.z;
        pos[o++] = cx;
        pos[o++] = cy;
        pos[o++] = cz;
        col[c++] = r;
        col[c++] = g;
        col[c++] = b;
        col[c++] = r;
        col[c++] = g;
        col[c++] = b;
      }
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
  }

  dispose(): void {
    disposeLines(this.object);
  }
}

/** What the particle view reads. Generic over the particle set; never written through. */
export interface ParticleView {
  /**
   * Control particles, car-local. `sleeping` and `lod` are optional so an adaptive
   * solver can report them; the view renders them when present.
   */
  readonly particles: readonly {
    readonly rest: THREE.Vector3;
    readonly local: THREE.Vector3;
    readonly mass: number;
    readonly clipping: boolean;
    readonly sleeping?: boolean;
    readonly lod?: number;
  }[];
  /** Shape-match goal per particle as world xyz triples; NaN where the solver applied no pull last step. */
  readonly goals: Float64Array;
}

/** Travel (m) from rest at which a particle reads fully red. */
const TRAVEL_FULL = 0.3;
/** Travel below this is elastic jitter, drawn in the at-rest colour. */
const TRAVEL_ELASTIC = 0.02;
/**
 * The solver's per-step pull is mostly centimetres (inside the sphere), so short goal
 * lines are drawn up to PULL_GAIN× longer, but never stretched past PULL_DRAW_MAX;
 * a pull already longer than that is drawn at its true length.
 */
const PULL_GAIN = 4;
const PULL_DRAW_MAX = 0.5;
/** sRGB, as authored; converted once below for instance/vertex colours. */
const SLEEP_RGB = [0.42, 0.46, 0.55] as const;
const CLIP_RGB = [1, 0.15, 0.85] as const;
const GOAL_END_RGB = [1, 1, 0.3] as const;
const REST_LINE_RGB = [0.55, 0.65, 1] as const;
const RAMP_STEPS = 64;
const BAR_W = 0.9;
const BAR_H = 0.06;
const MARKER_W = 0.025;
/** Bar layout as fractions of its width: travel ramp, then a clip swatch, then a sleep swatch. */
const BAR_RAMP_END = 0.74;
const BAR_CLIP: readonly [number, number] = [0.78, 0.87];
const BAR_SLEEP: readonly [number, number] = [0.91, 1];

const _toCar = new THREE.Matrix4();
const _rgb: [number, number, number] = [0, 0, 0];
const SLEEP_LIN = new THREE.Color().setRGB(...SLEEP_RGB, THREE.SRGBColorSpace);
const CLIP_LIN = new THREE.Color().setRGB(...CLIP_RGB, THREE.SRGBColorSpace);
const GOAL_END_LIN = new THREE.Color().setRGB(...GOAL_END_RGB, THREE.SRGBColorSpace);
const REST_LINE_LIN = new THREE.Color().setRGB(...REST_LINE_RGB, THREE.SRGBColorSpace);

/** Elastic lime → amber → red, t in [0, 1]. Same red end as the rig's displaced masses; no cyan, so it never reads as a rig mass. */
function travelColor(t: number, out: [number, number, number]): void {
  if (t < 0.5) {
    const s = t * 2;
    out[0] = 0.6 + s * 0.4;
    out[1] = 1 - s * 0.3;
    out[2] = 0.2 - s * 0.1;
  } else {
    const s = (t - 0.5) * 2;
    out[0] = 1 - s * 0.05;
    out[1] = 0.7 - s * 0.58;
    out[2] = 0.1;
  }
}

function travelT(travel: number): number {
  return THREE.MathUtils.clamp((travel - TRAVEL_ELASTIC) / (TRAVEL_FULL - TRAVEL_ELASTIC), 0, 1);
}

/** travelColor sampled at RAMP_STEPS points, in linear working space, so the hot loop is a lookup. */
const RAMP_LIN = (() => {
  const out = new Float32Array(RAMP_STEPS * 3);
  const c = new THREE.Color();
  for (let i = 0; i < RAMP_STEPS; i++) {
    travelColor(i / (RAMP_STEPS - 1), _rgb);
    c.setRGB(_rgb[0], _rgb[1], _rgb[2], THREE.SRGBColorSpace);
    out[i * 3] = c.r;
    out[i * 3 + 1] = c.g;
    out[i * 3 + 2] = c.b;
  }
  return out;
})();

let scaleTexture: THREE.DataTexture | null = null;

/** The colour scale strip, shared by every car. */
function colourScaleTexture(): THREE.DataTexture {
  if (scaleTexture) return scaleTexture;
  const w = 128;
  const data = new Uint8Array(w * 4);
  for (let x = 0; x < w; x++) {
    const f = (x + 0.5) / w;
    let a = 255;
    if (f < BAR_RAMP_END) travelColor(f / BAR_RAMP_END, _rgb);
    else if (f >= BAR_CLIP[0] && f < BAR_CLIP[1]) [_rgb[0], _rgb[1], _rgb[2]] = CLIP_RGB;
    else if (f >= BAR_SLEEP[0] && f < BAR_SLEEP[1]) [_rgb[0], _rgb[1], _rgb[2]] = SLEEP_RGB;
    else a = 0;
    data[x * 4] = Math.round(_rgb[0] * 255);
    data[x * 4 + 1] = Math.round(_rgb[1] * 255);
    data[x * 4 + 2] = Math.round(_rgb[2] * 255);
    data[x * 4 + 3] = a;
  }
  scaleTexture = new THREE.DataTexture(data, w, 1);
  scaleTexture.colorSpace = THREE.SRGBColorSpace;
  scaleTexture.magFilter = THREE.NearestFilter;
  scaleTexture.needsUpdate = true;
  return scaleTexture;
}

/**
 * Control-particle view: one instanced sphere per particle (size ∝ ∛mass, colour =
 * plastic travel / contact / sleep), a line to its shape-match goal, a faint
 * rest→current line, and a camera-facing colour scale above the car whose tick marks
 * this car's worst travel. Detached from the car while hidden; buffers sized once.
 */
export class DeformParticleHelper {
  readonly group = new THREE.Group();
  private readonly parent: THREE.Object3D;
  private readonly view: ParticleView;
  private readonly spheres: THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly bar: THREE.Sprite;
  private readonly marker: THREE.Sprite;
  private readonly radius: Float32Array;

  constructor(parent: THREE.Object3D, view: ParticleView) {
    this.parent = parent;
    this.view = view;
    this.group.name = "deform-particles";
    this.group.visible = false;
    const n = view.particles.length;

    let meanMass = 0;
    for (const p of view.particles) meanMass += p.mass;
    meanMass = Math.max(meanMass / Math.max(n, 1), 1e-6);
    this.radius = new Float32Array(n);
    for (let i = 0; i < n; i++) this.radius[i] = THREE.MathUtils.clamp(0.038 * Math.cbrt(view.particles[i]!.mass / meanMass), 0.024, 0.065);

    this.spheres = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 10, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, toneMapped: false }),
      n,
    );
    this.spheres.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.spheres.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.spheres.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const m = this.spheres.instanceMatrix.array;
    for (let i = 0; i < n; i++) m[i * 16 + 15] = 1;
    this.spheres.renderOrder = 6;
    this.spheres.frustumCulled = false;

    // Two segments per particle: [particle → goal], [rest → particle]; RGBA so the rest line stays faint.
    // Only the particle end of the goal line changes colour per frame; the rest are written here once.
    const geo = new THREE.BufferGeometry();
    const lineCol = new Float32Array(n * 4 * 4);
    for (let i = 0; i < n; i++) {
      const c = i * 16;
      lineCol[c + 3] = 0.95;
      lineCol.set([GOAL_END_LIN.r, GOAL_END_LIN.g, GOAL_END_LIN.b, 0.95], c + 4);
      lineCol.set([REST_LINE_LIN.r, REST_LINE_LIN.g, REST_LINE_LIN.b, 0.45], c + 8);
      lineCol.set([REST_LINE_LIN.r, REST_LINE_LIN.g, REST_LINE_LIN.b, 0.45], c + 12);
    }
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("color", new THREE.BufferAttribute(lineCol, 4).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.lines.renderOrder = 5;
    this.lines.frustumCulled = false;

    const spriteOpts = { transparent: true, depthTest: false, depthWrite: false, toneMapped: false } as const;
    this.bar = new THREE.Sprite(new THREE.SpriteMaterial({ ...spriteOpts, map: colourScaleTexture() }));
    this.bar.scale.set(BAR_W, BAR_H, 1);
    this.marker = new THREE.Sprite(new THREE.SpriteMaterial(spriteOpts));
    this.marker.scale.set(MARKER_W, BAR_H * 2.2, 1);
    let top = 0;
    for (const p of view.particles) top = Math.max(top, p.rest.y);
    this.bar.position.set(0, top + 0.45, 0);
    this.marker.position.copy(this.bar.position);
    this.bar.renderOrder = 7;
    this.marker.renderOrder = 8;

    this.group.add(this.lines, this.spheres, this.bar, this.marker);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
    if (v) {
      this.parent.add(this.group);
      this.update();
    } else this.group.removeFromParent();
  }

  update(): void {
    if (!this.group.visible) return;
    const particles = this.view.particles;
    const goals = this.view.goals;
    const mat = this.spheres.instanceMatrix.array;
    const col = this.spheres.instanceColor!.array;
    const posAttr = this.lines.geometry.getAttribute("position") as THREE.BufferAttribute;
    const colAttr = this.lines.geometry.getAttribute("color") as THREE.BufferAttribute;
    const lp = posAttr.array as Float32Array;
    const lc = colAttr.array as Float32Array;
    const e = _toCar.copy(this.parent.matrixWorld).invert().elements;
    let worst = 0;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!;
      const x = p.local.x,
        y = p.local.y,
        z = p.local.z;
      const travel = Math.hypot(x - p.rest.x, y - p.rest.y, z - p.rest.z);
      const sleeping = p.sleeping === true;
      if (!sleeping && travel > worst) worst = travel;
      let r: number, g: number, b: number;
      if (p.clipping) ({ r, g, b } = CLIP_LIN);
      else {
        const k = Math.round(travelT(travel) * (RAMP_STEPS - 1)) * 3;
        r = RAMP_LIN[k]!;
        g = RAMP_LIN[k + 1]!;
        b = RAMP_LIN[k + 2]!;
      }
      if (sleeping) {
        r = r * 0.35 + SLEEP_LIN.r * 0.65;
        g = g * 0.35 + SLEEP_LIN.g * 0.65;
        b = b * 0.35 + SLEEP_LIN.b * 0.65;
      }
      col[i * 3] = r;
      col[i * 3 + 1] = g;
      col[i * 3 + 2] = b;

      const s = this.radius[i]! * (p.lod ? Math.pow(0.75, p.lod) : 1) * (sleeping ? 0.7 : 1);
      const o = i * 16;
      mat[o] = s;
      mat[o + 5] = s;
      mat[o + 10] = s;
      mat[o + 12] = x;
      mat[o + 13] = y;
      mat[o + 14] = z;

      let dx = 0,
        dy = 0,
        dz = 0;
      const gx = goals[i * 3]!,
        gy = goals[i * 3 + 1]!,
        gz = goals[i * 3 + 2]!;
      if (Number.isFinite(gx + gy + gz)) {
        dx = e[0]! * gx + e[4]! * gy + e[8]! * gz + e[12]! - x;
        dy = e[1]! * gx + e[5]! * gy + e[9]! * gz + e[13]! - y;
        dz = e[2]! * gx + e[6]! * gy + e[10]! * gz + e[14]! - z;
        const k = THREE.MathUtils.clamp(PULL_DRAW_MAX / Math.max(Math.hypot(dx, dy, dz), 1e-6), 1, PULL_GAIN);
        dx *= k;
        dy *= k;
        dz *= k;
      }
      const v = i * 12;
      lp[v] = x;
      lp[v + 1] = y;
      lp[v + 2] = z;
      lp[v + 3] = x + dx;
      lp[v + 4] = y + dy;
      lp[v + 5] = z + dz;
      lp[v + 6] = p.rest.x;
      lp[v + 7] = p.rest.y;
      lp[v + 8] = p.rest.z;
      lp[v + 9] = x;
      lp[v + 10] = y;
      lp[v + 11] = z;

      const c = i * 16;
      lc[c] = r;
      lc[c + 1] = g;
      lc[c + 2] = b;
    }

    this.spheres.instanceMatrix.needsUpdate = true;
    this.spheres.instanceColor!.needsUpdate = true;
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    const fx = travelT(worst) * BAR_RAMP_END;
    this.marker.center.set(0.5 - ((fx - 0.5) * BAR_W) / MARKER_W, 0.5);
  }

  dispose(): void {
    this.group.removeFromParent();
    this.spheres.geometry.dispose();
    this.spheres.material.dispose();
    this.spheres.dispose();
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    this.bar.material.dispose();
    this.marker.material.dispose();
  }
}
