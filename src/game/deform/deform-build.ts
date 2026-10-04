import * as THREE from "three";
import { regionSoftness, regionCrushBands } from "./physics-util.ts";
import { makeCluster, type ShapeCluster, type ShapeParticle } from "./shape-match.ts";
import {
  BEAM_SPECS,
  CAGES,
  MASS_SPECS,
  SENSORS,
  SHAPE_CLUSTERS,
  type BodyPartName,
  type MassName,
} from "../kernel/rig-spec.ts";
import type { Beam, Cage, MassNode, RigOverrides, Sensor } from "./deform-rig.ts";

// The rig as built: wrinkle seeds, cages, sensors, masses and beams at rest, and the lattice skin's cage influences.

function hash01(i: number, salt = 1): number {
  const s = Math.sin(i * 127.1 * salt + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Most cage influences a skin vertex keeps (lattice skin / cluster-less fallback). */
export const INF_K = 4;

interface Influence {
  part: number;
  u: number;
  v: number;
  w: number;
  weight: number;
}

/** Wrinkle noise per vertex, keyed on the lowest vertex index sharing its rest position so split seams stay shut. */
export function wrinkleSeeds(restPos: Float32Array, vertexCount: number): Float64Array {
  const wrinkleSeed = new Float64Array(vertexCount);
  const firstAt = new Map<string, number>();
  for (let i = 0; i < vertexCount; i++) {
    const key = `${restPos[i * 3]},${restPos[i * 3 + 1]},${restPos[i * 3 + 2]}`;
    const first = firstAt.get(key);
    if (first === undefined) firstAt.set(key, i);
    wrinkleSeed[i] = hash01(first ?? i, 3) - 0.5;
  }
  return wrinkleSeed;
}

/** The rig's cages at rest (`rig.cages` boxes over the spec's). */
function makeCages(rig: RigOverrides): Cage[] {
  return CAGES.map((base) => {
    const box = rig.cages?.[base.name];
    const spec = box ? { ...base, ...box } : base;
    const min = new THREE.Vector3(...spec.min);
    const max = new THREE.Vector3(...spec.max);
    const restCorners: THREE.Vector3[] = [];
    const corners: THREE.Vector3[] = [];
    for (let iz = 0; iz < 2; iz++) {
      for (let iy = 0; iy < 2; iy++) {
        for (let ix = 0; ix < 2; ix++) {
          const p = new THREE.Vector3(ix ? max.x : min.x, iy ? max.y : min.y, iz ? max.z : min.z);
          restCorners.push(p);
          corners.push(p.clone());
        }
      }
    }
    return {
      spec,
      min,
      max,
      center: min.clone().add(max).multiplyScalar(0.5),
      restCorners,
      corners,
      size: max.clone().sub(min),
      glass: spec.name.startsWith("glass"),
    };
  });
}

/** The rig's crush sensors at rest (`rig.sensors` rests over the spec's), each on its cage's index. */
function makeSensors(rig: RigOverrides, partIndex: Map<BodyPartName, number>): Sensor[] {
  return SENSORS.map((base, i) => {
    const rest = rig.sensors?.[i];
    const spec = rest ? { ...base, rest } : base;
    return {
      spec,
      rest: new THREE.Vector3(...spec.rest),
      pos: new THREE.Vector3(...spec.rest),
      partIndex: partIndex.get(spec.part) ?? 12,
      compression: -0,
      target: 0,
      delay: 0,
      fired: false,
    };
  });
}

/** The mass nodes at rest, in `MASS_SPECS` order; fills `nameIndex` (name → index). */
function makeMasses(nameIndex: Map<MassName, number>): MassNode[] {
  return MASS_SPECS.map((spec, i) => {
    nameIndex.set(spec.name, i);
    const rest = new THREE.Vector3(...spec.rest);
    return {
      name: spec.name,
      rest,
      local: rest.clone(),
      world: rest.clone(),
      vel: new THREE.Vector3(),
      mass: spec.mass,
      radius: spec.radius,
      dynamic: false,
      clipping: false,
      popped: false,
      shoveX: -0,
      shoveZ: -0,
      crushSet: -0,
      baseX: -0,
      baseZ: -0,
      bands: regionCrushBands(spec.name),
      hub: spec.name.startsWith("hub"),
      bumper: spec.name.startsWith("bumper"),
      rail: spec.name.startsWith("rail"),
      crumple: spec.name.startsWith("bumper") || spec.name.startsWith("wing"),
      softness: regionSoftness(spec.name),
      index: i,
    };
  });
}

/** The structure's beams at their rest lengths. */
function makeBeams(masses: readonly MassNode[], nameIndex: Map<MassName, number>): Beam[] {
  return BEAM_SPECS.map(([na, nb, kTen, yieldK, maxShorten]) => {
    const a = nameIndex.get(na)!;
    const b = nameIndex.get(nb)!;
    const rest = masses[a]!.rest.distanceTo(masses[b]!.rest);
    const restDir = masses[b]!.rest.clone().sub(masses[a]!.rest);
    if (rest > 1e-6) restDir.multiplyScalar(1 / rest);
    return {
      a,
      b,
      rest,
      plastic: rest,
      minLen: Math.max(0.1, rest * (1 - maxShorten)),
      kTen,
      yieldK,
      damp: Math.sqrt(yieldK * 8),
      alive: true,
      restDir,
    };
  });
}

/**
 * Lattice skin (and the cluster-less fallback): up to INF_K cage influences per vertex, packed as the cage's
 * coefficient offset in `infCo` + (u, v, w, weight) in `infUvw`, the count in `infN`.
 */
export function bindLattice(
  restPos: Float32Array,
  vertexCount: number,
  cages: readonly Cage[],
  infN: Uint8Array,
  infCo: Int32Array,
  infUvw: Float64Array,
): void {
  const skinsCage = cages.map((c) => !["doorLeft", "doorRight", "glassFront", "glassRear"].includes(c.spec.name));
  for (let i = 0; i < vertexCount; i++) {
    const x = restPos[i * 3]!;
    const y = restPos[i * 3 + 1]!;
    const z = restPos[i * 3 + 2]!;
    const list: Influence[] = [];
    for (let p = 0; p < cages.length; p++) {
      if (!skinsCage[p]) continue;
      const cage = cages[p]!;
      const u = (x - cage.min.x) / cage.size.x;
      const v = (y - cage.min.y) / cage.size.y;
      const w = (z - cage.min.z) / cage.size.z;
      const weight = axisWeight(u) * axisWeight(v) * axisWeight(w);
      if (weight > 0.02) list.push({ part: p, u, v, w, weight });
    }
    if (list.length === 0) {
      // Beyond every cage's reach (the tail skin past the boot cage): extrapolate the nearest cage
      // unclamped, exact at rest. Clamping into the cell box snapped it 1.6 m forward on the first skin.
      let best = 0;
      let bestD = Infinity;
      for (let p = 0; p < cages.length; p++) {
        if (!skinsCage[p]) continue;
        const c = cages[p]!;
        const d = Math.hypot(Math.max(c.min.x - x, 0, x - c.max.x), Math.max(c.min.y - y, 0, y - c.max.y), Math.max(c.min.z - z, 0, z - c.max.z));
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      const cage = cages[best]!;
      list.push({ part: best, u: (x - cage.min.x) / cage.size.x, v: (y - cage.min.y) / cage.size.y, w: (z - cage.min.z) / cage.size.z, weight: 1 });
    } else {
      list.sort((a, b) => b.weight - a.weight);
      if (list.length > INF_K) list.length = INF_K;
      let sum = 0;
      for (const inf of list) sum += inf.weight;
      for (const inf of list) inf.weight /= sum;
    }
    infN[i] = list.length;
    for (let k = 0; k < list.length; k++) {
      const inf = list[k]!;
      const s = i * INF_K + k;
      infCo[s] = inf.part * 24;
      infUvw[s * 4] = inf.u;
      infUvw[s * 4 + 1] = inf.v;
      infUvw[s * 4 + 2] = inf.w;
      infUvw[s * 4 + 3] = inf.weight;
    }
  }
}

function axisWeight(t: number): number {
  if (t < -0.18 || t > 1.18) return 0;
  if (t < 0) return 1 + t / 0.18;
  if (t > 1) return 1 - (t - 1) / 0.18;
  return 1;
}

/** The per-run structures: sensors, cages, masses, beams, shape particles and clusters. */
type RunStructures = {
  cages: Cage[];
  sensors: Sensor[];
  masses: MassNode[];
  beams: Beam[];
  shapeParticles: ShapeParticle[];
  clusters: ShapeCluster[];
};

/** The per-run structures as built for `rig` (the constructor's). Fills `nameIndex` (mass name → index). */
export function buildRunStructures(rig: RigOverrides, nameIndex = new Map<MassName, number>()): RunStructures {
  const cages = makeCages(rig);
  const partIndex = new Map<BodyPartName, number>();
  cages.forEach((c, i) => partIndex.set(c.spec.name, i));
  const masses = makeMasses(nameIndex);
  const shapeParticles = masses.map((m) => ({ x: m.rest.x, y: m.rest.y, z: m.rest.z, vx: 0, vy: 0, vz: 0, mass: m.mass }));
  return {
    cages,
    sensors: makeSensors(rig, partIndex),
    masses,
    beams: makeBeams(masses, nameIndex),
    shapeParticles,
    clusters: SHAPE_CLUSTERS.map((spec) => makeCluster(shapeParticles, spec.masses.map((n) => nameIndex.get(n)!))),
  };
}

/**
 * `reset`'s read-only template per distinct rig (by value; a handful of body styles): built once, shared by every car
 * of that rig. A copy kept per car cost 160 KB each; building one per reset cost 0.1 ms per car.
 */
const templates = new Map<string, RunStructures>();
export function runTemplate(rig: RigOverrides): RunStructures {
  const key = JSON.stringify(rig);
  let t = templates.get(key);
  if (!t) templates.set(key, (t = buildRunStructures(rig)));
  return t;
}

/**
 * Copies `src` (`target`'s structures as built) into `target` in place: numbers, flags and strings by key (only where
 * they differ, `Object.is`), typed arrays by `set`, nested objects and arrays recursively, so every reference into the
 * state (the skin's views of the masses' rest and local vectors, helpers) stays valid. An object both share (a rig-spec
 * entry) is left alone: it is never written.
 */
export function restoreInto(target: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const k of Object.keys(src)) {
    const v = src[k];
    const t = target[k];
    if (v !== null && typeof v === "object") {
      if (t === v) continue;
      if (ArrayBuffer.isView(v)) (t as Float64Array).set(v as Float64Array);
      else restoreInto(t as Record<string, unknown>, v as Record<string, unknown>);
    } else if (!Object.is(t, v)) target[k] = v;
  }
}

