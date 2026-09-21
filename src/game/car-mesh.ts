import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

export const WHEEL_POS: [number, number, number][] = [
  [-0.74, 0.32, 1.34],
  [0.74, 0.32, 1.34],
  [-0.74, 0.32, -1.34],
  [0.74, 0.32, -1.34],
];

/** Tight cabin hulls, split L/R so a corner hit is not a full-width box. */
export type Hull = { cx: number; cz: number; hx: number; hz: number };
export const HULLS: Hull[] = [
  { cx: -0.38, cz: 1.22, hx: 0.34, hz: 0.34 },
  { cx: 0.38, cz: 1.22, hx: 0.34, hz: 0.34 },
  { cx: 0, cz: 0.12, hx: 0.86, hz: 0.92 },
  { cx: -0.38, cz: -1.22, hx: 0.34, hz: 0.34 },
  { cx: 0.38, cz: -1.22, hx: 0.34, hz: 0.34 },
];

/** Bumper-inclusive hulls, also L/R split so SAT contact sits on the hit corner. */
export const CRUSH_HULLS: Hull[] = [
  { cx: -0.42, cz: 1.72, hx: 0.36, hz: 0.5 },
  { cx: 0.42, cz: 1.72, hx: 0.36, hz: 0.5 },
  { cx: 0, cz: 0.12, hx: 0.86, hz: 0.92 },
  { cx: -0.42, cz: -1.6, hx: 0.36, hz: 0.58 },
  { cx: 0.42, cz: -1.6, hx: 0.36, hz: 0.58 },
];

export const CAR_HALF = { x: 0.88, y: 0.68, z: 2.22 };

/** Shrink collision hulls as those regions crush so mash can close without tunneling. */
export function crushedHulls(front: number, rear: number, left: number, right: number): Hull[] {
  const fi = THREE.MathUtils.clamp(front, 0, 1) * 0.5;
  const ri = THREE.MathUtils.clamp(rear, 0, 1) * 0.48;
  const ls = THREE.MathUtils.clamp(left, 0, 1) * 0.2;
  const rs = THREE.MathUtils.clamp(right, 0, 1) * 0.2;
  return [
    {
      cx: -0.4 + (rs - ls) * 0.08,
      cz: 1.58 - fi * 0.48,
      hx: Math.max(0.2, 0.34 - ls * 0.2 - fi * 0.04),
      hz: Math.max(0.14, 0.5 - fi * 0.4),
    },
    {
      cx: 0.4 + (rs - ls) * 0.08,
      cz: 1.58 - fi * 0.48,
      hx: Math.max(0.2, 0.34 - rs * 0.2 - fi * 0.04),
      hz: Math.max(0.14, 0.5 - fi * 0.4),
    },
    {
      cx: (rs - ls) * 0.18,
      cz: 0.12,
      hx: Math.max(0.5, 0.86 - ls - rs),
      hz: 0.92,
    },
    {
      cx: -0.4 + (rs - ls) * 0.08,
      cz: -1.46 + ri * 0.48,
      hx: Math.max(0.2, 0.34 - ls * 0.18 - ri * 0.04),
      hz: Math.max(0.14, 0.58 - ri * 0.4),
    },
    {
      cx: 0.4 + (rs - ls) * 0.08,
      cz: -1.46 + ri * 0.48,
      hx: Math.max(0.2, 0.34 - rs * 0.18 - ri * 0.04),
      hz: Math.max(0.14, 0.58 - ri * 0.4),
    },
  ];
}

const ARCH_R = 0.42;

type Slice = {
  z: number;
  hw: number;
  y0: number;
  yBelt: number;
  yRoof: number;
  cabinHw: number;
  cabin: number;
};

const PROFILE: Slice[] = [
  { z: -2.14, hw: 0.56, y0: 0.18, yBelt: 0.48, yRoof: 0.48, cabinHw: 0.38, cabin: 0 },
  { z: -1.92, hw: 0.76, y0: 0.16, yBelt: 0.58, yRoof: 0.58, cabinHw: 0.46, cabin: 0 },
  { z: -1.58, hw: 0.86, y0: 0.155, yBelt: 0.72, yRoof: 0.74, cabinHw: 0.52, cabin: 0 },
  { z: -1.18, hw: 0.88, y0: 0.155, yBelt: 0.78, yRoof: 0.88, cabinHw: 0.56, cabin: 0.2 },
  { z: -0.78, hw: 0.89, y0: 0.155, yBelt: 0.8, yRoof: 1.28, cabinHw: 0.58, cabin: 1 },
  { z: -0.18, hw: 0.89, y0: 0.155, yBelt: 0.82, yRoof: 1.34, cabinHw: 0.6, cabin: 1 },
  { z: 0.42, hw: 0.88, y0: 0.155, yBelt: 0.81, yRoof: 1.3, cabinHw: 0.58, cabin: 1 },
  { z: 0.82, hw: 0.86, y0: 0.155, yBelt: 0.76, yRoof: 1.05, cabinHw: 0.52, cabin: 0.4 },
  { z: 1.18, hw: 0.84, y0: 0.16, yBelt: 0.66, yRoof: 0.68, cabinHw: 0.48, cabin: 0 },
  { z: 1.58, hw: 0.78, y0: 0.17, yBelt: 0.56, yRoof: 0.56, cabinHw: 0.42, cabin: 0 },
  { z: 1.9, hw: 0.66, y0: 0.2, yBelt: 0.5, yRoof: 0.5, cabinHw: 0.36, cabin: 0 },
  { z: 2.14, hw: 0.46, y0: 0.22, yBelt: 0.46, yRoof: 0.46, cabinHw: 0.32, cabin: 0 },
];

const SLICES = 40;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sampleSlice(z: number): Slice {
  if (z <= PROFILE[0]!.z) return { ...PROFILE[0]!, z };
  for (let i = 1; i < PROFILE.length; i++) {
    const a = PROFILE[i - 1]!;
    const b = PROFILE[i]!;
    if (z <= b.z) {
      const t = (z - a.z) / (b.z - a.z);
      const s = t * t * (3 - 2 * t);
      return {
        z,
        hw: lerp(a.hw, b.hw, s),
        y0: lerp(a.y0, b.y0, s),
        yBelt: lerp(a.yBelt, b.yBelt, s),
        yRoof: lerp(a.yRoof, b.yRoof, s),
        cabinHw: lerp(a.cabinHw, b.cabinHw, s),
        cabin: lerp(a.cabin, b.cabin, s),
      };
    }
  }
  return { ...PROFILE[PROFILE.length - 1]!, z };
}

function wheelWell(z: number): number {
  let w = 0;
  for (const [, , wz] of WHEEL_POS) {
    const dz = z - wz;
    if (Math.abs(dz) < ARCH_R) w = Math.max(w, Math.sqrt(ARCH_R * ARCH_R - dz * dz));
  }
  return w;
}

/** Front door cut only (A-pillar to B-pillar). Rear quarter stays a solid panel. */
function doorAperture(z: number): number {
  const z0 = 0.0;
  const z1 = 0.54;
  const e = 0.04;
  if (z <= z0 || z >= z1) return 0;
  const a = THREE.MathUtils.smoothstep(z, z0, z0 + e);
  const b = 1 - THREE.MathUtils.smoothstep(z, z1 - e, z1);
  return a * b;
}

/**
 * Lower body only: rocker / fender / door sill / rear quarter.
 * Greenhouse (belt→roof) is pillars + roof + glass, never lofted metal.
 */
function sectionPoints(s: Slice): { x: number; y: number }[] {
  const well = wheelWell(s.z);
  const hw = s.hw;
  const yFloor = 0.145;
  const yBelt = s.yBelt;
  const hole = doorAperture(s.z);
  const archY = 0.32 + well;
  const lift = (x: number, y: number) => {
    if (well < 0.03 || Math.abs(x) < hw * 0.58 || y > archY + 0.02) return y;
    const t = THREE.MathUtils.clamp((Math.abs(x) - hw * 0.58) / (hw * 0.42), 0, 1);
    return Math.max(y, lerp(y, archY, t * t * (3 - 2 * t)));
  };
  const ySideTop = lerp(yBelt, 0.22, hole);
  const xTop = hw - hole * 0.03;

  const left = [
    { x: -xTop, y: ySideTop },
    { x: -xTop, y: lift(-xTop, lerp(0.34, ySideTop * 0.7, 0.4)) },
    { x: -hw, y: lift(-hw, 0.2) },
    { x: -hw * 0.86, y: lift(-hw * 0.86, yFloor + 0.02) },
    { x: -hw * 0.55, y: yFloor },
    { x: -hw * 0.18, y: yFloor },
  ];
  const mid = { x: 0, y: yFloor };
  const right = left.map((p) => ({ x: -p.x, y: p.y })).reverse();
  return [...left, mid, ...right];
}

/** Side-view rest profile — tests lock this so the body cannot become a van blob. */
export function restSideProfile(z: number): {
  hw: number;
  yBelt: number;
  ySideTop: number;
  yRoof: number;
  cabin: number;
  doorHole: number;
} {
  const s = sampleSlice(z);
  const doorHole = doorAperture(z);
  return {
    hw: s.hw,
    yBelt: s.yBelt,
    ySideTop: lerp(s.yBelt, 0.22, doorHole),
    yRoof: lerp(s.yBelt, s.yRoof, s.cabin),
    cabin: s.cabin,
    doorHole,
  };
}

function loftFromRings(
  rings: { x: number; y: number }[][],
  zs: number[],
  u0: number,
  u1: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const n = rings[0]!.length;
  for (let s = 0; s < rings.length; s++) {
    const u = u0 + ((u1 - u0) * s) / Math.max(1, rings.length - 1);
    const ring = rings[s]!;
    const z = zs[s]!;
    for (let i = 0; i < n; i++) {
      const p = ring[i]!;
      positions.push(p.x, p.y, z);
      uvs.push(u, i / n);
    }
  }
  const indices: number[] = [];
  for (let s = 0; s < rings.length - 1; s++) {
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      const a = s * n + i;
      const b = s * n + i1;
      const c = (s + 1) * n + i;
      const d = (s + 1) * n + i1;
      indices.push(a, b, c, b, d, c);
    }
  }
  const cap = (slice: number, inward: boolean) => {
    const ring = rings[slice]!;
    let cx = 0,
      cy = 0;
    for (const p of ring) {
      cx += p.x;
      cy += p.y;
    }
    cx /= n;
    cy /= n;
    const center = positions.length / 3;
    positions.push(cx, cy, zs[slice]!);
    uvs.push(inward ? 0 : 1, 0.5);
    const base = slice * n;
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      if (inward) indices.push(center, base + i1, base + i);
      else indices.push(center, base + i, base + i1);
    }
  };
  cap(0, true);
  cap(rings.length - 1, false);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

function ensureOutwardNormals(geo: THREE.BufferGeometry): void {
  geo.computeVertexNormals();
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const nrm = geo.getAttribute("normal") as THREE.BufferAttribute;
  let bestI = 0;
  let bestX = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    if (x > bestX) {
      bestX = x;
      bestI = i;
    }
  }
  if (nrm.getX(bestI) >= 0) return;
  const idx = geo.getIndex();
  if (!idx) return;
  const a = idx.array;
  for (let i = 0; i < a.length; i += 3) {
    const t = a[i + 1]!;
    a[i + 1] = a[i + 2]!;
    a[i + 2] = t;
  }
  idx.needsUpdate = true;
  geo.computeVertexNormals();
}

function makeWellLiner(wx: number, wy: number, wz: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(ARCH_R, ARCH_R, 0.24, 18, 1, true, 0, Math.PI);
  geo.rotateZ(Math.PI / 2);
  geo.rotateY(wx > 0 ? 0 : Math.PI);
  geo.translate(wx, wy, wz);
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  if (uv) {
    for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.12, i / uv.count);
  }
  return geo;
}

function makeRoofGeometry(): THREE.BufferGeometry {
  const z0 = -0.82;
  const z1 = 0.58;
  const segs = 16;
  const rings: { x: number; y: number }[][] = [];
  const zs: number[] = [];
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const z = lerp(z0, z1, t);
    const sl = sampleSlice(z);
    const c = Math.max(sl.cabin, 0.25);
    const yRoof = lerp(sl.yBelt, sl.yRoof, c);
    const xRoof = lerp(sl.hw * 0.55, sl.cabinHw, c);
    const tk = 0.045;
    rings.push([
      { x: -xRoof, y: yRoof - tk },
      { x: -xRoof, y: yRoof },
      { x: -xRoof * 0.4, y: yRoof + 0.016 },
      { x: 0, y: yRoof + 0.026 },
      { x: xRoof * 0.4, y: yRoof + 0.016 },
      { x: xRoof, y: yRoof },
      { x: xRoof, y: yRoof - tk },
      { x: 0, y: yRoof - tk - 0.008 },
    ]);
    zs.push(z);
  }
  const geo = loftFromRings(rings, zs, 0.28, 0.72);
  ensureOutwardNormals(geo);
  return geo;
}

function makePillarGeo(sign: number, z: number, x: number, y0: number, y1: number, depth: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(0.085, y1 - y0, depth, 1, 2, 1);
  geo.translate(sign * x, (y0 + y1) * 0.5, z);
  return geo;
}

function makeSlopedPillar(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  thick: number,
  depth: number,
): THREE.BufferGeometry {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dy, dz);
  const geo = new THREE.BoxGeometry(thick, len, depth, 1, 4, 1);
  const dir = new THREE.Vector3(dx, dy, dz).normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  geo.applyQuaternion(quat);
  geo.translate((x0 + x1) * 0.5, (y0 + y1) * 0.5, (z0 + z1) * 0.5);
  return geo;
}

function makeHeader(z: number, y: number, w: number, d: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, 0.07, d, 1, 1, 1);
  geo.translate(0, y, z);
  return geo;
}

function makeBulkhead(z: number, y0: number, y1: number, w: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, y1 - y0, 0.045, 1, 1, 1);
  geo.translate(0, (y0 + y1) * 0.5, z);
  return geo;
}

export function makeChassisGeometry(): THREE.BufferGeometry {
  const z0 = PROFILE[0]!.z;
  const z1 = PROFILE[PROFILE.length - 1]!.z;
  const rings: { x: number; y: number }[][] = [];
  const zs: number[] = [];
  for (let s = 0; s < SLICES; s++) {
    const z = z0 + ((z1 - z0) * s) / (SLICES - 1);
    rings.push(sectionPoints(sampleSlice(z)));
    zs.push(z);
  }
  const body = loftFromRings(rings, zs, 0, 1);
  ensureOutwardNormals(body);
  const roof = makeRoofGeometry();
  const parts: THREE.BufferGeometry[] = [body, roof];
  for (const [wx, wy, wz] of WHEEL_POS) parts.push(makeWellLiner(wx, wy, wz));
  for (const sign of [-1, 1]) {
    parts.push(makeSlopedPillar(sign * 0.82, 0.72, 0.92, sign * 0.56, 1.3, 0.5, 0.09, 0.14));
    parts.push(makePillarGeo(sign, -0.08, 0.82, 0.8, 1.32, 0.1));
    parts.push(makeSlopedPillar(sign * 0.84, 0.78, -0.92, sign * 0.56, 1.28, -0.78, 0.09, 0.14));
    const rail = new THREE.BoxGeometry(0.045, 0.05, 1.38);
    rail.translate(sign * 0.86, 0.82, -0.12);
    parts.push(rail);
  }
  parts.push(makeHeader(0.48, 1.3, 1.1, 0.09));
  parts.push(makeHeader(-0.78, 1.28, 1.08, 0.09));
  parts.push(makeBulkhead(0.72, 0.34, 0.86, 1.2));
  parts.push(makeBulkhead(-0.72, 0.34, 0.84, 1.16));
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!merged) throw new Error("Failed to merge chassis");
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function makePanelShell(
  z0: number,
  z1: number,
  w0: number,
  w1: number,
  drop: number,
  dome: number,
): THREE.BufferGeometry {
  const segs = 9;
  const rings: { x: number; y: number }[][] = [];
  const zs: number[] = [];
  const tk = 0.048;
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const z = lerp(z0, z1, t);
    const w = lerp(w0, w1, t * t * (3 - 2 * t));
    const yTop = dome * (1 - (2 * t - 1) * (2 * t - 1));
    rings.push([
      { x: -w, y: yTop },
      { x: -w * 0.45, y: yTop + dome * 0.35 },
      { x: 0, y: yTop + dome * 0.5 },
      { x: w * 0.45, y: yTop + dome * 0.35 },
      { x: w, y: yTop },
      { x: w, y: yTop - drop * 0.55 },
      { x: w, y: yTop - drop },
      { x: w - tk, y: yTop - drop },
      { x: w - tk, y: yTop - tk },
      { x: -w + tk, y: yTop - tk },
      { x: -w + tk, y: yTop - drop },
      { x: -w, y: yTop - drop },
      { x: -w, y: yTop - drop * 0.55 },
    ]);
    zs.push(z);
  }
  const geo = loftFromRings(rings, zs, 0, 1);
  ensureOutwardNormals(geo);
  geo.computeBoundingBox();
  return geo;
}

export function makeHoodGeometry(): THREE.BufferGeometry {
  return makePanelShell(0.02, 1.2, 0.79, 0.5, 0.34, 0.05);
}

export function makeTrunkGeometry(): THREE.BufferGeometry {
  return makePanelShell(0.08, -1.2, 0.78, 0.6, 0.28, 0.05);
}

export function makeBumperGeometry(front: boolean): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(1.54, 0.2, 0.16, 16, 3, 3);
  const s = front ? 1 : -1;
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    const wrap = Math.max(0, Math.abs(x) - 0.58);
    z += s * -wrap * 0.65;
    y += (1 - Math.abs(x) / 0.8) * 0.02;
    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Door skin in hinge-local space. Parent at the A-pillar (sign*0.86, 0.54, 0.55). */
export function makeDoorGeometry(sign: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(0.05, 0.62, 0.58, 2, 5, 6);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);
    x += sign * 0.012;
    if (z > 0.16) {
      y += (z - 0.16) * -0.06;
      x += sign * (z - 0.16) * 0.04;
    }
    if (z < -0.2) y += (-0.2 - z) * -0.04;
    const belt = THREE.MathUtils.clamp((y - 0.12) / 0.28, 0, 1);
    if (belt > 0.55 && Math.abs(z) < 0.18) x += sign * 0.01;
    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

export function makeWindshield(): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(1.08, 0.72, 10, 8);
  geo.rotateX(-0.84);
  geo.translate(0, 1.02, 0.76);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const top = THREE.MathUtils.clamp((y - 0.78) / 0.48, 0, 1);
    x *= lerp(1, 0.72, top);
    pos.setXYZ(i, x, y, z + (1 - Math.abs(x) / 0.7) * 0.02);
  }
  geo.computeVertexNormals();
  return geo;
}

export function makeRearGlass(): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(1.02, 0.58, 8, 6);
  geo.rotateX(0.76);
  geo.translate(0, 1.02, -0.96);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    const y = pos.getY(i);
    const top = THREE.MathUtils.clamp((y - 0.8) / 0.4, 0, 1);
    x *= lerp(1, 0.76, top);
    pos.setX(i, x);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Side glass in door-hinge local space. Parent with the door. */
export function makeSideGlass(sign: number, length = 0.52, height = 0.46): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(length, height, 8, 4);
  geo.rotateY(sign * Math.PI * 0.5);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    let y = pos.getY(i);
    if (z > length * 0.22) y += (z - length * 0.22) * -0.12;
    pos.setY(i, y);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Rear quarter / B-to-C glass on the body skin (car local). */
export function makeRearSideGlass(sign: number): THREE.BufferGeometry {
  const geo = makeSideGlass(sign, 0.76, 0.48);
  geo.translate(sign * 0.82, 1.06, -0.42);
  return geo;
}

export function makeMirror(sign: number): THREE.Group {
  const g = new THREE.Group();
  const arm = new THREE.Mesh(
    new THREE.BoxGeometry(0.12, 0.04, 0.05),
    new THREE.MeshStandardMaterial({ color: 0x2a2c32, roughness: 0.5, metalness: 0.4 }),
  );
  arm.position.set(sign * 0.08, 0, 0);
  const cap = new THREE.Mesh(
    new THREE.BoxGeometry(0.1, 0.08, 0.16),
    new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.35, metalness: 0.55 }),
  );
  cap.position.set(sign * 0.16, 0.01, 0);
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(0.08, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x9aa8b4, roughness: 0.08, metalness: 0.7 }),
  );
  glass.position.set(sign * 0.212, 0.01, 0);
  glass.rotation.y = sign * Math.PI * 0.5;
  g.add(arm, cap, glass);
  return g;
}

export function makeInterior(): THREE.Group {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.94, metalness: 0.04 });
  const vinyl = new THREE.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.9, metalness: 0.05 });
  const seat = new THREE.MeshStandardMaterial({ color: 0x1c2228, roughness: 0.88, metalness: 0.06 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.04, 1.28), dark);
  floor.position.set(0, 0.34, 0.02);
  const dash = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.2, 0.24), dark);
  dash.position.set(0, 0.6, 0.48);
  const liner = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.02, 1.05), vinyl);
  liner.position.set(0, 1.08, 0.02);
  const bulk = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.55, 0.04), vinyl);
  bulk.position.set(0, 0.62, -0.62);
  const wheel = new THREE.Mesh(
    new THREE.TorusGeometry(0.11, 0.016, 8, 16),
    new THREE.MeshStandardMaterial({ color: 0x2a2c32, roughness: 0.55, metalness: 0.2 }),
  );
  wheel.position.set(-0.22, 0.68, 0.36);
  wheel.rotation.x = 0.55;
  const mkSeat = (x: number, z: number) => {
    const s = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.08, 0.36), seat);
    base.position.set(0, 0.4, 0);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 0.07), seat);
    back.position.set(0, 0.58, -0.16);
    back.rotation.x = -0.12;
    s.add(base, back);
    s.position.set(x, 0, z);
    return s;
  };
  const mkWall = (sign: number) => {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 1.1), vinyl);
    w.position.set(sign * 0.4, 0.62, 0.02);
    return w;
  };
  g.add(floor, dash, liner, bulk, wheel, mkSeat(-0.2, 0.06), mkSeat(0.2, 0.06), mkWall(-1), mkWall(1));
  return g;
}

export function makeWheel(): THREE.Group {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(
    new THREE.CylinderGeometry(0.32, 0.32, 0.22, 28, 1),
    new THREE.MeshStandardMaterial({ color: 0x121214, roughness: 0.92, metalness: 0.05 }),
  );
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  const rim = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.22, 0.24, 18, 1),
    new THREE.MeshStandardMaterial({ color: 0xc9cdd4, roughness: 0.28, metalness: 0.92 }),
  );
  rim.rotation.z = Math.PI / 2;
  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 0.26, 12),
    new THREE.MeshStandardMaterial({ color: 0x8a909a, roughness: 0.35, metalness: 0.8 }),
  );
  hub.rotation.z = Math.PI / 2;
  g.add(tire, rim, hub);
  return g;
}

let _paintMap: THREE.CanvasTexture | null = null;
let _roughMap: THREE.CanvasTexture | null = null;
let _crackMap: THREE.Texture | null = null;

function makePaintMaps(): { map: THREE.CanvasTexture; roughness: THREE.CanvasTexture } {
  if (_paintMap && _roughMap) return { map: _paintMap, roughness: _roughMap };
  const w = 1024;
  const h = 512;
  const paint = document.createElement("canvas");
  paint.width = w;
  paint.height = h;
  const ctx = paint.getContext("2d")!;
  ctx.fillStyle = "#f2f2f0";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 14000; i++) {
    const n = Math.random();
    ctx.fillStyle = `rgba(20,20,22,${n * 0.045})`;
    ctx.fillRect(Math.random() * w, Math.random() * h, n > 0.85 ? 2 : 1, 1);
  }
  ctx.strokeStyle = "rgba(18,18,20,0.28)";
  ctx.lineWidth = 2;
  const seams = [0.18, 0.34, 0.5, 0.66, 0.82];
  for (const u of seams) {
    ctx.beginPath();
    ctx.moveTo(u * w, 0);
    ctx.lineTo(u * w, h);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(18,18,20,0.22)";
  ctx.beginPath();
  ctx.moveTo(0, h * 0.38);
  ctx.lineTo(w, h * 0.38);
  ctx.stroke();
  ctx.fillStyle = "rgba(12,12,14,0.12)";
  ctx.fillRect(0, h * 0.78, w, h * 0.22);

  const rough = document.createElement("canvas");
  rough.width = w;
  rough.height = h;
  const rctx = rough.getContext("2d")!;
  rctx.fillStyle = "#8a8a8a";
  rctx.fillRect(0, 0, w, h);
  rctx.strokeStyle = "#d0d0d0";
  rctx.lineWidth = 3;
  for (const u of seams) {
    rctx.beginPath();
    rctx.moveTo(u * w, 0);
    rctx.lineTo(u * w, h);
    rctx.stroke();
  }
  rctx.fillStyle = "#9a9a9a";
  rctx.fillRect(0, h * 0.78, w, h * 0.22);

  _paintMap = new THREE.CanvasTexture(paint);
  _paintMap.colorSpace = THREE.SRGBColorSpace;
  _paintMap.anisotropy = 8;
  _paintMap.wrapS = _paintMap.wrapT = THREE.RepeatWrapping;
  _roughMap = new THREE.CanvasTexture(rough);
  _roughMap.colorSpace = THREE.NoColorSpace;
  _roughMap.anisotropy = 4;
  _roughMap.wrapS = _roughMap.wrapT = THREE.RepeatWrapping;
  return { map: _paintMap, roughness: _roughMap };
}

export function makePaintMaterial(color: number): THREE.MeshPhysicalMaterial {
  const maps = typeof document === "undefined" ? { map: null, roughness: null } : makePaintMaps();
  return new THREE.MeshPhysicalMaterial({
    color,
    map: maps.map ?? undefined,
    roughnessMap: maps.roughness ?? undefined,
    metalness: 0.2,
    roughness: 0.42,
    clearcoat: 0.72,
    clearcoatRoughness: 0.24,
    envMapIntensity: 0.4,
    side: THREE.FrontSide,
  });
}

export function makeTrimMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0.55,
    roughness: 0.38,
  });
}

export function makeGlassMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0x1a2832,
    metalness: 0.12,
    roughness: 0.08,
    transparent: true,
    opacity: 0.78,
    transmission: 0.08,
    thickness: 0.03,
    envMapIntensity: 1.1,
    side: THREE.DoubleSide,
    depthWrite: true,
  });
}

export function getCrackMap(): THREE.Texture {
  if (_crackMap) return _crackMap;
  if (typeof document === "undefined") {
    const t = new THREE.DataTexture(new Uint8Array([180, 200, 210, 48]), 1, 1);
    t.needsUpdate = true;
    _crackMap = t;
    return t;
  }
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, 512, 512);
  ctx.fillStyle = "rgba(180,200,210,0.18)";
  ctx.fillRect(0, 0, 512, 512);
  ctx.strokeStyle = "rgba(12,14,18,0.82)";
  ctx.lineWidth = 1.4;
  const cx = 256;
  const cy = 256;
  for (let i = 0; i < 18; i++) {
    const ang = (i / 18) * Math.PI * 2 + Math.random() * 0.2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    let x = cx;
    let y = cy;
    const steps = 4 + Math.floor(Math.random() * 4);
    for (let s = 0; s < steps; s++) {
      x += Math.cos(ang + (Math.random() - 0.5) * 0.8) * (40 + Math.random() * 50);
      y += Math.sin(ang + (Math.random() - 0.5) * 0.8) * (40 + Math.random() * 50);
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 22; i++) {
    ctx.beginPath();
    ctx.moveTo(Math.random() * 512, Math.random() * 512);
    ctx.lineTo(Math.random() * 512, Math.random() * 512);
    ctx.stroke();
  }
  _crackMap = new THREE.CanvasTexture(c);
  _crackMap.colorSpace = THREE.SRGBColorSpace;
  return _crackMap;
}

export function makeGrille(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(0.72, 0.16, 0.06, 4, 2, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.55, metalness: 0.45 });
  return new THREE.Mesh(geo, mat);
}
