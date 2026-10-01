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
