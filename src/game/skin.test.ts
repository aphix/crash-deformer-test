import * as THREE from "three";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeCar, runWall } from "./crash-scenarios.test-util.ts";
import { firePiston, pistonLocality, PISTON_IDS, type PistonLocality, type PistonShot } from "./piston-rig.ts";
import { transformSkinPointInto, type ShapeCluster } from "./shape-match.ts";
import type { DeformableCar } from "./car.ts";
import type { DeformMode, MassNode } from "./streamed-deform.ts";
import { forModes } from "./test-support.ts";

/** The deformer internals the reference skin reads (private in production). */
type Internals = {
  mode: DeformMode;
  vertexCount: number;
  restPos: Float32Array;
  impactLocal: THREE.Vector3;
  wrinkleAmp: number;
  elapsed: number;
  buckle: number;
  deepCrush: boolean;
  bidirectional: boolean;
  masses: MassNode[];
  clusters: ShapeCluster[];
  cages: { corners: THREE.Vector3[]; restCorners: THREE.Vector3[]; min: THREE.Vector3; size: THREE.Vector3 }[];
  cageByPart: Map<string, { corners: THREE.Vector3[]; min: THREE.Vector3; size: THREE.Vector3 }>;
  skinN: Uint8Array;
  skinXf: Int32Array;
  skinW: Float64Array;
  infN: Uint8Array;
  infCo: Int32Array;
  infUvw: Float64Array;
  resJ: Int32Array;
  resW: Float64Array;
  bakeLocalSkin(): void;
  solveCagesFromShape(): void;
  capCageCorners(): void;
  fitCagesToMasses(): void;
  skin(g: THREE.BufferGeometry): void;
};

// ---- Reference: the pre-typed-array skinner (per-influence objects, per-vertex centre subtraction,
// lerp trilinear, hub scan over every mass), with the arch-pin fix and the particle anchor (A5). Kept only here.

function hash01(i: number, salt = 1): number {
  const s = Math.sin(i * 127.1 * salt + salt * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function trilinear(corners: THREE.Vector3[], u: number, v: number, w: number, out: THREE.Vector3): THREE.Vector3 {
  const c00x = corners[0]!.x + (corners[1]!.x - corners[0]!.x) * u;
  const c00y = corners[0]!.y + (corners[1]!.y - corners[0]!.y) * u;
  const c00z = corners[0]!.z + (corners[1]!.z - corners[0]!.z) * u;
  const c10x = corners[2]!.x + (corners[3]!.x - corners[2]!.x) * u;
  const c10y = corners[2]!.y + (corners[3]!.y - corners[2]!.y) * u;
  const c10z = corners[2]!.z + (corners[3]!.z - corners[2]!.z) * u;
  const c01x = corners[4]!.x + (corners[5]!.x - corners[4]!.x) * u;
  const c01y = corners[4]!.y + (corners[5]!.y - corners[4]!.y) * u;
  const c01z = corners[4]!.z + (corners[5]!.z - corners[4]!.z) * u;
  const c11x = corners[6]!.x + (corners[7]!.x - corners[6]!.x) * u;
  const c11y = corners[6]!.y + (corners[7]!.y - corners[6]!.y) * u;
  const c11z = corners[6]!.z + (corners[7]!.z - corners[6]!.z) * u;
  const c0x = c00x + (c10x - c00x) * v;
  const c0y = c00y + (c10y - c00y) * v;
  const c0z = c00z + (c10z - c00z) * v;
  const c1x = c01x + (c11x - c01x) * v;
  const c1y = c01y + (c11y - c01y) * v;
  const c1z = c01z + (c11z - c01z) * v;
  return out.set(c0x + (c1x - c0x) * w, c0y + (c1y - c0y) * w, c0z + (c1z - c0z) * w);
}

/**
 * Skin point `i`'s parent masses (A5): their weighted live position (x, y, z) and rest centroid
 * (cx, cy, cz). The skin is that position plus each cluster map's change over rest − centroid.
 */
function anchor(d: Internals, i: number): { x: number; y: number; z: number; cx: number; cy: number; cz: number } {
  const out = { x: 0, y: 0, z: 0, cx: 0, cy: 0, cz: 0 };
  for (let k = i * 5; k < i * 5 + 5; k++) {
    const m = d.masses[d.resJ[k]! / 3]!;
    const w = d.resW[k]!;
    out.x += m.local.x * w;
    out.y += m.local.y * w;
    out.z += m.local.z * w;
    out.cx += m.rest.x * w;
    out.cy += m.rest.y * w;
    out.cz += m.rest.z * w;
  }
  return out;
}

function referenceSkin(d: Internals): Float32Array {
  const out = new Float32Array(d.vertexCount * 3);
  const weld = new Uint32Array(d.vertexCount);
  const firstAt = new Map<string, number>();
  for (let i = 0; i < d.vertexCount; i++) {
    const key = `${d.restPos[i * 3]},${d.restPos[i * 3 + 1]},${d.restPos[i * 3 + 2]}`;
    const first = firstAt.get(key);
    if (first === undefined) firstAt.set(key, i);
    weld[i] = first ?? i;
  }
  const _d = new THREE.Vector3();
  const impact = d.impactLocal;
  const wrinkle = d.wrinkleAmp * Math.min(1, d.elapsed * 6);
  const b = d.buckle;
  const shape = d.mode === "shape";
  for (let i = 0; i < d.vertexCount; i++) {
    const rx = d.restPos[i * 3]!;
    const ry = d.restPos[i * 3 + 1]!;
    const rz = d.restPos[i * 3 + 2]!;
    const ws = Array.from({ length: d.skinN[i]! }, (_, k) => ({ ci: d.skinXf[i * 5 + k]! / 9, w: d.skinW[i * 5 + k]! }));
    const infs = Array.from({ length: d.infN[i]! }, (_, k) => {
      const s = i * 4 + k;
      return { part: d.infCo[s]! / 24, u: d.infUvw[s * 4]!, v: d.infUvw[s * 4 + 1]!, w: d.infUvw[s * 4 + 2]!, weight: d.infUvw[s * 4 + 3]! };
    });
    let px = 0,
      py = 0,
      pz = 0;
    let wsum = 0;
    if (shape && ws.length > 0) {
      const a = anchor(d, i);
      px = a.x;
      py = a.y;
      pz = a.z;
      for (const inf of ws) {
        const p = transformSkinPointInto(d.clusters[inf.ci]!, rx, ry, rz);
        px += p.x * inf.w;
        py += p.y * inf.w;
        pz += p.z * inf.w;
        const q = transformSkinPointInto(d.clusters[inf.ci]!, a.cx, a.cy, a.cz);
        px -= q.x * inf.w;
        py -= q.y * inf.w;
        pz -= q.z * inf.w;
        wsum += inf.w;
      }
    }
    if (!shape || wsum < 1e-8) {
      for (const inf of infs) {
        trilinear(d.cages[inf.part]!.corners, inf.u, inf.v, inf.w, _d);
        px += _d.x * inf.weight;
        py += _d.y * inf.weight;
        pz += _d.z * inf.weight;
      }
    }
    const bx = px,
      by = py,
      bz = pz;
    const dist = Math.hypot(rx - impact.x, ry - impact.y, rz - impact.z);
    if (dist < 0.82 && wrinkle > 0.02 && ry > 0.34) {
      const fall = Math.exp(-dist * 3.4);
      const n0 = hash01(weld[i]!, 3) - 0.5;
      const wave = Math.sin(rz * 18 + n0 * 1.2);
      const amp = wrinkle * fall * 0.16 * (0.35 + b * 0.65);
      pz += wave * amp;
      py += Math.abs(wave) * amp * 0.28;
      px += Math.sign(rx || 1) * n0 * amp * 0.12;
    }
    const extra = Math.hypot(px - bx, py - by, pz - bz);
    const extraCap = 0.03 + b * 0.08;
    if (extra > extraCap) {
      const t = extraCap / extra;
      px = bx + (px - bx) * t;
      py = by + (py - by) * t;
      pz = bz + (pz - bz) * t;
    }
    const travel = Math.hypot(px - rx, py - ry, pz - rz);
    const cap = shape ? 1.35 : 2.2;
    if (travel > cap) {
      const t = cap / travel;
      px = rx + (px - rx) * t;
      py = ry + (py - ry) * t;
      pz = rz + (pz - rz) * t;
    }
    if (ry > 1.05 && !d.deepCrush) py = THREE.MathUtils.clamp(py, ry - 0.1, ry + 0.08);
    if (ry < 0.55) {
      for (const m of d.masses) {
        if (!m.hub) continue;
        if (Math.hypot(rx - m.rest.x, rz - m.rest.z) > 0.4) continue;
        const keep = m.popped ? 0.15 : 0.82;
        const hx = m.popped ? rx + m.local.x - m.rest.x : rx;
        const hz = m.popped ? rz + m.local.z - m.rest.z : rz;
        px = px * (1 - keep) + hx * keep;
        pz = pz * (1 - keep) + hz * keep;
        break;
      }
    }
    out[i * 3] = px;
    out[i * 3 + 1] = py;
    out[i * 3 + 2] = pz;
  }
  return out;
}

function referenceCageSolve(d: Internals): void {
  d.cages.forEach((cage, ci) => {
    for (let i = 0; i < 8; i++) {
      const rest = cage.restCorners[i]!;
      const a = anchor(d, d.vertexCount + ci * 8 + i);
      let px = 0,
        py = 0,
        pz = 0,
        wsum = 0;
      for (const c of d.clusters) {
        const dd = Math.hypot(rest.x - c.skinCm0x, rest.y - c.skinCm0y, rest.z - c.skinCm0z);
        if (dd > 1.4) continue;
        const w = Math.exp(-dd * 2.35);
        const p = transformSkinPointInto(c, rest.x, rest.y, rest.z);
        px += p.x * w;
        py += p.y * w;
        pz += p.z * w;
        const q = transformSkinPointInto(c, a.cx, a.cy, a.cz);
        px -= q.x * w;
        py -= q.y * w;
        pz -= q.z * w;
        wsum += w;
      }
      if (wsum > 1e-6) cage.corners[i]!.set(a.x + px / wsum, a.y + py / wsum, a.z + pz / wsum);
      else cage.corners[i]!.set(a.x + rest.x - a.cx, a.y + rest.y - a.cy, a.z + rest.z - a.cz);
    }
  });
  d.capCageCorners();
  if (d.bidirectional) d.fitCagesToMasses();
}

function referencePanel(d: Internals, rest: Float32Array, name: string, origin: THREE.Vector3): Float32Array {
  const cage = d.cageByPart.get(name)!;
  const out = new Float32Array(rest.length);
  const p = new THREE.Vector3();
  const sx = cage.size.x || 1;
  const sy = cage.size.y || 1;
  const sz = cage.size.z || 1;
  for (let i = 0; i < rest.length; i += 3) {
    const u = THREE.MathUtils.clamp((rest[i]! + origin.x - cage.min.x) / sx, -0.15, 1.15);
    const v = THREE.MathUtils.clamp((rest[i + 1]! + origin.y - cage.min.y) / sy, -0.15, 1.15);
    const w = THREE.MathUtils.clamp((rest[i + 2]! + origin.z - cage.min.z) / sz, -0.15, 1.15);
    trilinear(cage.corners, u, v, w, p);
    out[i] = p.x - origin.x;
    out[i + 1] = p.y - origin.y;
    out[i + 2] = p.z - origin.z;
  }
  return out;
}

function maxAbs(a: ArrayLike<number>, b: ArrayLike<number>): number {
  assert.equal(a.length, b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

/** A 64 km/h full-width wall hit, then a popped front-left hub so the arch pin's popped branch runs too. */
function crushedCar(mode: DeformMode): { car: DeformableCar; d: Internals } {
  const car = makeCar(mode);
  runWall(64, 1, "front", { mode, car });
  const d = car.deform as unknown as Internals;
  const hub = d.masses.find((m) => m.name === "hubFL")!;
  hub.popped = true;
  hub.local.x += 0.07;
  hub.local.z -= 0.05;
  return { car, d };
}

forModes("typed-array skinner matches the reference skinner on a crushed car", (mode) => {
  it("good: body skin, cage corners and panels within 1e-5 m", () => {
    const { car, d } = crushedCar(mode);
    assert.ok(d.wrinkleAmp * Math.min(1, d.elapsed * 6) > 0.02, "the wrinkle pass must run");
    if (mode === "shape") {
      d.bakeLocalSkin();
      d.solveCagesFromShape();
      const corners = d.cages.flatMap((c) => c.corners.flatMap((v) => [v.x, v.y, v.z]));
      referenceCageSolve(d);
      const want = d.cages.flatMap((c) => c.corners.flatMap((v) => [v.x, v.y, v.z]));
      assert.ok(maxAbs(corners, want) < 1e-9, `cage corners off by ${maxAbs(corners, want)} m`);
    }
    const geo = car.body.geometry;
    d.skin(geo);
    const want = referenceSkin(d);
    const crushed = maxAbs(want, d.restPos);
    assert.ok(crushed > 0.1, `the car is crushed (${crushed.toFixed(3)} m)`);
    const diff = maxAbs(geo.getAttribute("position").array as Float32Array, want);
    assert.ok(diff < 1e-5, `skin off the reference by ${diff} m`);

    const panels = car as unknown as { hood: THREE.Mesh; hoodRest: Float32Array; hoodOrigin: THREE.Vector3; trunk: THREE.Mesh; trunkRest: Float32Array; trunkOrigin: THREE.Vector3 };
    for (const [mesh, rest, name, origin] of [
      [panels.hood, panels.hoodRest, "bonnet", panels.hoodOrigin],
      [panels.trunk, panels.trunkRest, "boot", panels.trunkOrigin],
    ] as const) {
      car.deform.skinPanel(mesh.geometry, rest, name, origin);
      const pd = maxAbs(mesh.geometry.getAttribute("position").array as Float32Array, referencePanel(d, rest, name, origin));
      assert.ok(pd < 1e-5, `${name} panel off the reference by ${pd} m`);
    }
  });
});

const TAP: PistonShot = { speedKph: 3, massKg: 1500, hardness: 1, holdCar: false };

describe("a 3 km/h piston tap leaves the skin where the particles are", () => {
  for (const id of PISTON_IDS) {
    it(`bad: ${id} tap must not fold the wheel-arch skin onto the hub (plan travel ≤ 0.03 m)`, () => {
      const car = makeCar("shape");
      firePiston(car, id, TAP);
      const d = car.deform as unknown as Internals;
      const now = car.body.geometry.getAttribute("position").array as Float32Array;
      let worst = 0;
      for (let i = 0; i < d.vertexCount; i++) {
        const rx = d.restPos[i * 3]!;
        const rz = d.restPos[i * 3 + 2]!;
        if (d.restPos[i * 3 + 1]! >= 0.55 || !d.masses.some((m) => m.hub && Math.hypot(rx - m.rest.x, rz - m.rest.z) <= 0.4)) continue;
        worst = Math.max(worst, Math.hypot(now[i * 3]! - rx, now[i * 3 + 2]! - rz));
      }
      assert.ok(worst <= 0.03, `arch skin moved ${worst.toFixed(3)} m in plan`);
    });
  }
});

describe("a 40 km/h piston shot: the paint rides the particles it struck (A5)", () => {
  const shots = new Map<string, PistonLocality & { particle: number }>();
  const measure = (id: (typeof PISTON_IDS)[number]) => {
    if (!shots.has(id)) {
      const tap = firePiston(makeCar("shape"), id, TAP);
      const shot = firePiston(makeCar("shape"), id, { ...TAP, speedKph: 40 });
      const struck = shot.struck.map((s, k) => s.inward - tap.struck[k]!.inward);
      shots.set(id, { ...pistonLocality(shot, tap), particle: struck.reduce((a, b) => a + b, 0) / struck.length });
    }
    return shots.get(id)!;
  };
  for (const id of PISTON_IDS) {
    // Cluster-only skin: corners 37%, front 44% of the particles' dent; a strain-whole anchor put
    // the door paint 8% past the door.
    it(`bad: ${id} paint dent is within 25% of the struck particles' and not 5% deeper`, () => {
      const { dent, particle } = measure(id);
      assert.ok(dent >= 0.75 * particle && dent <= 1.05 * particle, `paint ${dent.toFixed(3)} m vs particles ${particle.toFixed(3)} m`);
    });
    // Cluster-only skin: a rear-corner shot moved far paint 0.228 m where the far particles moved 0.140 m.
    it(`bad: ${id} far paint moves no more than 4 cm past the far particles`, () => {
      const { farSkin, farParticle } = measure(id);
      assert.ok(farSkin <= farParticle + 0.04, `far paint ${farSkin.toFixed(3)} m vs far particles ${farParticle.toFixed(3)} m`);
    });
  }
});

forModes("an undeformed rig skins to the rest mesh", (mode) => {
  it("bad: no skin vertex may leave its rest position (≤ 1 mm) when nothing has deformed (wheel arch, tail past the last cage)", () => {
    const car = makeCar(mode);
    const d = car.deform as unknown as Internals;
    d.bakeLocalSkin();
    const geo = car.body.geometry;
    d.skin(geo);
    const now = geo.getAttribute("position").array as Float32Array;
    let worst = 0;
    let at = 0;
    for (let i = 0; i < d.vertexCount; i++) {
      const e = Math.hypot(now[i * 3]! - d.restPos[i * 3]!, now[i * 3 + 1]! - d.restPos[i * 3 + 1]!, now[i * 3 + 2]! - d.restPos[i * 3 + 2]!);
      if (e > worst) {
        worst = e;
        at = i;
      }
    }
    const rest = [...d.restPos.slice(at * 3, at * 3 + 3)].map((v) => v.toFixed(2)).join(", ");
    assert.ok(worst <= 1e-3, `vertex at rest (${rest}) moved ${worst.toFixed(4)} m`);
  });
});
