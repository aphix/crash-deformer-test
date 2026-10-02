import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CAR_STYLES, type BodyStyle, type GlassQuad, type ProfileStation, type YZ } from "./car-variants.ts";

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

/** Shared-platform hardpoints (8e2dc49, five styles on one platform): arch opening radius about the hub (m), floor pan height (m). */
const ARCH_R = 0.38;
const WHEEL_Y = WHEEL_POS[0]![1];
const Y_FLOOR = 0.145;
const SEDAN = CAR_STYLES.sedan;

/** Platform hardpoints every style shares. */
const WINDSHIELD_BASE: YZ = [0.78, 1.03];
const WINDSHIELD_W = { base: 1.3, top: 0.96 } as const;
const B_PILLAR_Z = { rear: -0.13, front: -0.03 } as const;
const GLASS_BELT_Y = 0.83;
const GLASS_BELT_X = 0.85;
/** Door glass pane origin in car space (door hinge + pane offset set in car.ts). */
const DOOR_GLASS_ORIGIN = { x: 0.84, y: 1.06, z: 0.27 } as const;

type Pt = { x: number; y: number };
type V3 = readonly [number, number, number];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function sampleSlice(z: number, profile: readonly ProfileStation[]): ProfileStation {
  if (z <= profile[0]!.z) return { ...profile[0]!, z };
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]!;
    const b = profile[i]!;
    if (z <= b.z) {
      const s = THREE.MathUtils.smoothstep((z - a.z) / (b.z - a.z), 0, 1);
      return {
        z,
        hw: lerp(a.hw, b.hw, s),
        yBelt: lerp(a.yBelt, b.yBelt, s),
        yRoof: lerp(a.yRoof, b.yRoof, s),
        cabinHw: lerp(a.cabinHw, b.cabinHw, s),
        cabin: lerp(a.cabin, b.cabin, s),
      };
    }
  }
  return { ...profile[profile.length - 1]!, z };
}

/** Roof surface height and half-width (roof panel, glass tops, pillar tops all agree). */
function roofAt(z: number, style: BodyStyle): { y: number; x: number } {
  const sl = sampleSlice(z, style.profile);
  const c = Math.max(sl.cabin, 0.25);
  return { y: lerp(sl.yBelt, sl.yRoof, c), x: lerp(sl.hw * 0.55, sl.cabinHw, c) };
}

/** Side glass top edge: tucked under the roof cant rail. */
function glassTopY(z: number, style: BodyStyle): number {
  return roofAt(z, style).y - 0.075;
}

function cantX(z: number, style: BodyStyle): number {
  return roofAt(z, style).x + 0.08;
}

/** Tumblehome: side glass leans in from the belt to the roof cant. */
function glassX(z: number, y: number, style: BodyStyle): number {
  const top = glassTopY(z, style);
  return lerp(GLASS_BELT_X, cantX(z, style), THREE.MathUtils.clamp((y - GLASS_BELT_Y) / (top - GLASS_BELT_Y), 0, 1));
}

function wheelWell(z: number): number {
  let w = 0;
  for (const [, , wz] of WHEEL_POS) {
    const dz = z - wz;
    if (Math.abs(dz) < ARCH_R) w = Math.max(w, Math.sqrt(ARCH_R * ARCH_R - dz * dz));
  }
  return w;
}

/** Fender flare band just outside the arch opening. */
function archFlare(z: number, y: number): number {
  let f = 0;
  for (const [, , wz] of WHEEL_POS) {
    const dz = z - wz;
    const r = y >= WHEEL_Y ? Math.hypot(dz, y - WHEEL_Y) : Math.abs(dz);
    const band =
      THREE.MathUtils.smoothstep(r, ARCH_R - 0.04, ARCH_R + 0.02) *
      (1 - THREE.MathUtils.smoothstep(r, ARCH_R + 0.06, ARCH_R + 0.17));
    f = Math.max(f, band);
  }
  return f;
}

/** Front door cut along z (m, car frame, + = forward), feathered over DOOR_EDGE at both ends; platform-wide (8e2dc49). */
const DOOR_Z0 = 0.0;
const DOOR_Z1 = 0.54;
const DOOR_EDGE = 0.04;

/** Front door cut only (A-pillar to B-pillar). Rear quarter stays a solid panel. */
function doorAperture(z: number): number {
  if (z <= DOOR_Z0 || z >= DOOR_Z1) return 0;
  const a = THREE.MathUtils.smoothstep(z, DOOR_Z0, DOOR_Z0 + DOOR_EDGE);
  const b = 1 - THREE.MathUtils.smoothstep(z, DOOR_Z1 - DOOR_EDGE, DOOR_Z1);
  return a * b;
}

/** Half-width (m) of the blend into and out of a style's tub floor along z (8e2dc49). */
const TUB_EDGE = 0.025;

function tubAt(z: number, style: BodyStyle): { t: number; floor: number } {
  let t = 0;
  let floor = Y_FLOOR;
  for (const [z0, z1, f] of style.tubs) {
    const w =
      THREE.MathUtils.smoothstep(z, z0 - TUB_EDGE, z0 + TUB_EDGE) *
      (1 - THREE.MathUtils.smoothstep(z, z1 - TUB_EDGE, z1 + TUB_EDGE));
    if (w > t) {
      t = w;
      floor = f;
    }
  }
  return { t, floor };
}

/** Half-width (m) of the rear-door shut-line groove; seamInset sets its 9 mm depth (8e2dc49). */
const SEAM_HALF = 0.012;

function seamInset(z: number, style: BodyStyle): number {
  if (style.rearDoorSeam === null) return 0;
  return 0.009 * Math.max(0, 1 - Math.abs(z - style.rearDoorSeam) / SEAM_HALF);
}

/**
 * Lower body ring (left half top→bottom, keel, right half bottom→top; the
 * wrap edge is the deck). Deck crown → shoulder → character crease → door
 * belly → rocker crease → sill. Tubs open the deck into a floor with walls;
 * the door cut drops the side to the sill. Greenhouse is never lofted metal.
 */
function sectionPoints(s: ProfileStation, style: BodyStyle): Pt[] {
  const { hw, yBelt: yb, z } = s;
  const hole = doorAperture(z);
  const tub = tubAt(z, style);
  const well = wheelWell(z);
  const archY = WHEEL_Y + well;
  const inset = seamInset(z, style);
  const half: [number, number][] = [
    [lerp(hw - 0.22, hw - 0.06, tub.t), lerp(yb + 0.012, tub.floor, tub.t)],
    [lerp(hw - 0.07, hw - 0.06, tub.t), lerp(yb + 0.004, yb - 0.006, tub.t)],
    [hw - 0.02, yb - 0.022],
    [hw + 0.004 - inset, yb - 0.1],
    [hw - 0.012 - inset, lerp(yb - 0.1, 0.2, 0.45)],
    [hw - 0.004 - inset, 0.2],
    [hw - 0.045, 0.165],
    [hw * 0.8, Y_FLOOR + 0.004],
  ];
  const sill: [number, number][] = [
    [hw - 0.1, 0.235],
    [hw - 0.06, 0.235],
    [hw - 0.035, 0.232],
    [hw - 0.028, 0.228],
    [hw - 0.02, 0.224],
  ];
  for (let i = 0; i < sill.length; i++) {
    const p = half[i]!;
    p[0] = lerp(p[0], sill[i]![0], hole);
    p[1] = lerp(p[1], sill[i]![1], hole);
  }
  for (let i = 3; i <= 5; i++) half[i]![0] += 0.022 * archFlare(z, half[i]![1]);
  for (const p of half) {
    if (well < 0.03 || p[0] < hw * 0.58 || p[1] > archY + 0.02) continue;
    const t = THREE.MathUtils.smoothstep((p[0] - hw * 0.58) / (hw * 0.42), 0, 1);
    p[1] = Math.max(p[1], lerp(p[1], archY, t));
  }
  const left = half.map(([x, y]) => ({ x: -x, y }));
  const right = half.map(([x, y]) => ({ x, y })).reverse();
  return [...left, { x: 0, y: Y_FLOOR }, ...right];
}

/** Side-view rest profile — tests lock this so the body cannot become a van blob. */
export function restSideProfile(
  z: number,
  style: BodyStyle = SEDAN,
): {
  hw: number;
  yBelt: number;
  ySideTop: number;
  yRoof: number;
  cabin: number;
  doorHole: number;
} {
  const s = sampleSlice(z, style.profile);
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

/** Base loft stations: with SLICE_WARP ≈7 cm apart at nose/tail, 13 cm mid-cabin (8e2dc49 commit notes). */
const BASE_SLICES = 40;
/** >1 spreads slices over the cabin and packs them into the crumple zones. */
const SLICE_WARP = 1.166;

/** Loft stations: warped base spacing (≈7 cm at nose/tail, 13 cm mid) plus feature edges. */
function sliceZs(style: BodyStyle): number[] {
  const p = style.profile;
  const z0 = p[0]!.z;
  const z1 = p[p.length - 1]!.z;
  const knots = [DOOR_Z0, DOOR_Z0 + DOOR_EDGE, DOOR_Z1 - DOOR_EDGE, DOOR_Z1];
  for (const [a, b] of style.tubs) knots.push(a - TUB_EDGE, a + TUB_EDGE, b - TUB_EDGE, b + TUB_EDGE);
  const seam = style.rearDoorSeam;
  if (seam !== null) knots.push(seam - SEAM_HALF, seam, seam + SEAM_HALF);
  const zs = knots.filter((k) => k > z0 && k < z1);
  const mid = (z0 + z1) * 0.5;
  const half = (z1 - z0) * 0.5;
  for (let i = 0; i < BASE_SLICES; i++) {
    const t = (i / (BASE_SLICES - 1)) * 2 - 1;
    const z = mid + half * t * (SLICE_WARP + (1 - SLICE_WARP) * t * t);
    const end = i === 0 || i === BASE_SLICES - 1;
    if (end || knots.every((k) => Math.abs(k - z) > 0.022)) zs.push(z);
  }
  return zs.sort((a, b) => a - b);
}

function loftFromRings(rings: Pt[][], zs: number[], u0: number, u1: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const n = rings[0]!.length;
  const zA = zs[0]!;
  const zSpan = zs[zs.length - 1]! - zA;
  for (let s = 0; s < rings.length; s++) {
    const z = zs[s]!;
    const u = u0 + ((u1 - u0) * (z - zA)) / zSpan;
    const ring = rings[s]!;
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
    const center = positions.length / 3;
    positions.push(cx / n, cy / n, zs[slice]!);
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

/** Flip winding if the area-weighted face normals point at the centroid on balance. */
function ensureOutwardNormals(geo: THREE.BufferGeometry): void {
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const idx = geo.getIndex();
  if (!idx) return;
  const a = idx.array;
  let cx = 0,
    cy = 0,
    cz = 0;
  for (let i = 0; i < pos.count; i++) {
    cx += pos.getX(i);
    cy += pos.getY(i);
    cz += pos.getZ(i);
  }
  const c = new THREE.Vector3(cx / pos.count, cy / pos.count, cz / pos.count);
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  const p2 = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  let flux = 0;
  for (let i = 0; i < a.length; i += 3) {
    p0.fromBufferAttribute(pos, a[i]!);
    p1.fromBufferAttribute(pos, a[i + 1]!);
    p2.fromBufferAttribute(pos, a[i + 2]!);
    e1.subVectors(p1, p0);
    e2.subVectors(p2, p0);
    e1.cross(e2);
    flux += e1.dot(p0.add(p1).add(p2).multiplyScalar(1 / 3).sub(c));
  }
  if (flux < 0) {
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1]!;
      a[i + 1] = a[i + 2]!;
      a[i + 2] = t;
    }
    idx.needsUpdate = true;
  }
  geo.computeVertexNormals();
}

function makeWellLiner(wx: number, wy: number, wz: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(ARCH_R, ARCH_R, 0.24, 14, 1, true, 0, Math.PI);
  geo.rotateZ(Math.PI / 2);
  geo.rotateY(wx > 0 ? 0 : Math.PI);
  geo.translate(wx, wy, wz);
  const uv = geo.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.12, i / uv.count);
  return geo;
}

function makeRoofGeometry(style: BodyStyle): THREE.BufferGeometry {
  const [z0, z1] = style.roofZ;
  const segs = 16;
  const rings: Pt[][] = [];
  const zs: number[] = [];
  for (let s = 0; s <= segs; s++) {
    const z = lerp(z0, z1, s / segs);
    const { y, x } = roofAt(z, style);
    rings.push([
      { x: -(x + 0.08), y: y - 0.075 },
      { x: -(x + 0.07), y: y - 0.03 },
      { x: -x, y },
      { x: -x * 0.45, y: y + 0.018 },
      { x: 0, y: y + 0.026 },
      { x: x * 0.45, y: y + 0.018 },
      { x, y },
      { x: x + 0.07, y: y - 0.03 },
      { x: x + 0.08, y: y - 0.075 },
      { x: 0, y: y - 0.085 },
    ]);
    zs.push(z);
  }
  const geo = loftFromRings(rings, zs, 0.28, 0.72);
  ensureOutwardNormals(geo);
  return geo;
}

/**
 * Box mapped onto four outer-face corners (+x side), thickness inward;
 * sign -1 mirrors to the left without flipping the winding.
 */
function boxFromCorners(
  sign: number,
  c: { fb: V3; rb: V3; rt: V3; ft: V3 },
  thick: number,
  hs = 1,
): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(1, 1, 1, 1, hs, 1);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const u = pos.getX(i) + 0.5;
    const v = pos.getY(i) + 0.5;
    const w = pos.getZ(i) + 0.5;
    const at = (k: number) => lerp(lerp(c.rb[k]!, c.fb[k]!, w), lerp(c.rt[k]!, c.ft[k]!, w), v);
    const outer = at(0);
    const x = sign > 0 ? outer - (1 - u) * thick : -(outer - u * thick);
    pos.setXYZ(i, x, at(1), at(2));
  }
  return geo;
}

function makeBox(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(x, y, z);
  return geo;
}

function makeGreenhouseFrame(style: BodyStyle): THREE.BufferGeometry[] {
  const parts: THREE.BufferGeometry[] = [];
  const [wsY, wsZ] = style.windshieldTop;
  const rg = style.rearGlass;
  const q = style.quarter;
  const aTopZ = wsZ - 0.05;
  for (const sign of [-1, 1]) {
    parts.push(
      boxFromCorners(
        sign,
        {
          fb: [WINDSHIELD_W.base / 2 + 0.02, WINDSHIELD_BASE[0] + 0.01, WINDSHIELD_BASE[1] - 0.03],
          rb: [GLASS_BELT_X, GLASS_BELT_Y, 0.76],
          rt: [cantX(aTopZ, style), glassTopY(aTopZ, style) + 0.03, aTopZ],
          ft: [WINDSHIELD_W.top / 2 + 0.02, wsY + 0.02, wsZ],
        },
        0.05,
        2,
      ),
    );
    const bz = (B_PILLAR_Z.rear + B_PILLAR_Z.front) * 0.5;
    const bTop = glassTopY(bz, style) + 0.05;
    const bX = cantX(bz, style) + 0.01;
    parts.push(
      boxFromCorners(
        sign,
        {
          fb: [GLASS_BELT_X + 0.01, GLASS_BELT_Y - 0.02, B_PILLAR_Z.front],
          rb: [GLASS_BELT_X + 0.01, GLASS_BELT_Y - 0.02, B_PILLAR_Z.rear],
          rt: [bX, bTop, B_PILLAR_Z.rear + 0.015],
          ft: [bX, bTop, B_PILLAR_Z.front - 0.015],
        },
        0.05,
      ),
    );
    parts.push(
      boxFromCorners(
        sign,
        {
          fb: [GLASS_BELT_X, GLASS_BELT_Y - 0.02, q.zRearBot],
          rb: [rg.wBase / 2 + 0.02, rg.base[0], rg.base[1] - 0.01],
          rt: [rg.wTop / 2 + 0.02, rg.top[0] + 0.01, rg.top[1] - 0.01],
          ft: [cantX(q.zRearTop, style), glassTopY(q.zRearTop, style) + 0.03, q.zRearTop],
        },
        0.05,
      ),
    );
    const m = style.midPillarZ;
    if (m !== null) {
      const mTop = glassTopY(m, style) + 0.03;
      const mX = cantX(m, style) + 0.012;
      parts.push(
        boxFromCorners(
          sign,
          {
            fb: [GLASS_BELT_X + 0.012, GLASS_BELT_Y - 0.02, m + 0.04],
            rb: [GLASS_BELT_X + 0.012, GLASS_BELT_Y - 0.02, m - 0.04],
            rt: [mX, mTop, m - 0.035],
            ft: [mX, mTop, m + 0.035],
          },
          0.04,
        ),
      );
    }
    const railLen = B_PILLAR_Z.front - q.zRearBot;
    parts.push(makeBox(0.03, 0.03, railLen, sign * (GLASS_BELT_X + 0.015), GLASS_BELT_Y + 0.005, q.zRearBot + railLen * 0.5));
  }
  parts.push(makeBox(WINDSHIELD_W.top + 0.1, 0.06, 0.08, 0, wsY + 0.03, wsZ - 0.02));
  parts.push(makeBox(rg.wTop + 0.12, 0.06, 0.08, 0, rg.top[0] + 0.04, rg.top[1] - 0.02));
  return parts;
}

export function makeChassisGeometry(style: BodyStyle = SEDAN): THREE.BufferGeometry {
  const zs = sliceZs(style);
  const rings = zs.map((z) => sectionPoints(sampleSlice(z, style.profile), style));
  const body = loftFromRings(rings, zs, 0, 1);
  ensureOutwardNormals(body);
  const parts: THREE.BufferGeometry[] = [body, makeRoofGeometry(style)];
  for (const [wx, wy, wz] of WHEEL_POS) parts.push(makeWellLiner(wx, wy, wz));
  parts.push(...makeGreenhouseFrame(style));
  parts.push(makeBox(1.2, 0.52, 0.045, 0, 0.6, 0.72));
  const rb = style.rearBulkhead;
  parts.push(makeBox(1.16, rb.yTop - 0.34, 0.045, 0, (rb.yTop + 0.34) * 0.5, rb.z));
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!merged) throw new Error("Failed to merge chassis");
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** Lid lofted on the deck line (hood / trunk), local to its hinge origin. */
function makeDeckPanel(style: BodyStyle, z0: number, z1: number, origin: YZ): THREE.BufferGeometry {
  const segs = 10;
  const tk = 0.04;
  const drop = 0.06;
  const dome = 0.012;
  const [oy, oz] = origin;
  const rings: Pt[][] = [];
  const zs: number[] = [];
  for (let s = 0; s <= segs; s++) {
    const z = lerp(z0, z1, s / segs);
    const sl = sampleSlice(z, style.profile);
    const w = sl.hw - 0.075;
    const y = sl.yBelt + 0.016 - oy;
    rings.push([
      { x: -w, y },
      { x: -w * 0.45, y: y + dome * 0.7 },
      { x: 0, y: y + dome },
      { x: w * 0.45, y: y + dome * 0.7 },
      { x: w, y },
      { x: w, y: y - drop * 0.55 },
      { x: w, y: y - drop },
      { x: w - tk, y: y - drop },
      { x: w - tk, y: y - tk },
      { x: -w + tk, y: y - tk },
      { x: -w + tk, y: y - drop },
      { x: -w, y: y - drop },
      { x: -w, y: y - drop * 0.55 },
    ]);
    zs.push(z - oz);
  }
  const geo = loftFromRings(rings, zs, 0, 1);
  ensureOutwardNormals(geo);
  geo.computeBoundingBox();
  return geo;
}

/** Hatch / tailgate: a slightly bowed vertical panel hinged at its top edge. */
function makeTailgate(style: BodyStyle, y0: number, origin: YZ): THREE.BufferGeometry {
  const [y1, oz] = origin;
  const w = sampleSlice(oz, style.profile).hw - 0.05;
  const tk = 0.03;
  const bow = 0.02;
  const segs = 5;
  const rings: Pt[][] = [];
  const hs: number[] = [];
  for (let s = 0; s <= segs; s++) {
    rings.push([
      { x: -w, y: 0 },
      { x: -w * 0.5, y: bow * 0.75 },
      { x: 0, y: bow },
      { x: w * 0.5, y: bow * 0.75 },
      { x: w, y: 0 },
      { x: w, y: -tk },
      { x: -w, y: -tk },
    ]);
    hs.push(lerp(y0, y1, s / segs) - y1);
  }
  const geo = loftFromRings(rings, hs, 0, 1);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i), pos.getZ(i), -pos.getY(i));
  ensureOutwardNormals(geo);
  geo.computeBoundingBox();
  return geo;
}

export function makeHoodGeometry(style: BodyStyle = SEDAN): THREE.BufferGeometry {
  return makeDeckPanel(style, 0.76, 1.98, [0.7, 0.74]);
}

/** Trunk lid, hatch or tailgate per style; local to `style.boot.origin` ([y, z]). */
export function makeTrunkGeometry(style: BodyStyle = SEDAN): THREE.BufferGeometry {
  const b = style.boot;
  return b.kind === "lid" ? makeDeckPanel(style, b.z0, b.z1, b.origin) : makeTailgate(style, b.y0, b.origin);
}

const FASCIA: readonly (readonly [number, number])[] = [
  [0.1, -0.07],
  [0.1, 0.02],
  [0.088, 0.062],
  [0.05, 0.08],
  [0.018, 0.074],
  [-0.012, 0.062],
  [-0.05, 0.064],
  [-0.07, 0.088],
  [-0.1, 0.075],
  [-0.1, -0.07],
];

/** Bumper fascia: rounded top, intake recess, splitter lip, wrapped corners. */
export function makeBumperGeometry(front: boolean): THREE.BufferGeometry {
  const s = front ? 1 : -1;
  const stations = 16;
  const rings: Pt[][] = [];
  const xs: number[] = [];
  const wraps: number[] = [];
  for (let i = 0; i <= stations; i++) {
    const x = lerp(-0.77, 0.77, i / stations);
    const wrap = Math.max(0, Math.abs(x) - 0.58);
    const crown = (1 - Math.abs(x) / 0.8) * 0.02;
    rings.push(FASCIA.map(([y, out]) => ({ x: y + crown, y: out * (1 - wrap * 1.2) })));
    xs.push(x);
    wraps.push(wrap);
  }
  const geo = loftFromRings(rings, xs, 0, 1);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const n = FASCIA.length;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getZ(i);
    const ring = Math.min(stations, Math.floor(i / n));
    const wrap = i < (stations + 1) * n ? wraps[ring]! : Math.max(0, Math.abs(x) - 0.58);
    pos.setXYZ(i, x, pos.getX(i), s * (pos.getY(i) - wrap * 0.65));
  }
  ensureOutwardNormals(geo);
  return geo;
}

/**
 * Door and mirror dimensions in car space. The door group's origin is the hinge axis at the
 * A-pillar, (±hingeX, hingeY, hingeZ); the skin box spans z −0.57…0.01 and y ±0.31 around it.
 */
export const DOOR = {
  hingeX: 0.86,
  hingeY: 0.54,
  hingeZ: 0.55,
  /** Hinge axis to trailing edge (m). */
  length: 0.57,
  halfHeight: 0.31,
  /** Mirror base in door space (±mirrorX, mirrorY, 0); the cap reaches `mirrorReach` out and is ±`mirrorHalfDepth` deep. */
  mirrorX: 0.06,
  mirrorY: 0.32,
  mirrorReach: 0.21,
  mirrorHalfDepth: 0.08,
} as const;

/** Door skin in hinge-local space. Parent at the A-pillar (sign*0.86, 0.54, 0.55). */
export function makeDoorGeometry(sign: number): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(0.05, 0.62, 0.58, 2, 5, 6);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    const z = pos.getZ(i);
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

/** Raked glass quad (windshield / rear glass), bowed by `bow` along z at the centre line. */
function makeGlassQuad(q: GlassQuad, segX: number, segY: number, bow: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= segY; j++) {
    const t = j / segY;
    const y = lerp(q.base[0], q.top[0], t);
    const z = lerp(q.base[1], q.top[1], t);
    const w = lerp(q.wBase, q.wTop, t);
    for (let i = 0; i <= segX; i++) {
      const xn = (i / segX) * 2 - 1;
      positions.push(xn * w * 0.5, y, z + bow * (1 - xn * xn));
      uvs.push(i / segX, t);
    }
  }
  const row = segX + 1;
  for (let j = 0; j < segY; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * row + i;
      indices.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export function makeWindshield(style: BodyStyle = SEDAN): THREE.BufferGeometry {
  return makeGlassQuad({ base: WINDSHIELD_BASE, top: style.windshieldTop, wBase: WINDSHIELD_W.base, wTop: WINDSHIELD_W.top }, 10, 8, 0.02);
}

export function makeRearGlass(style: BodyStyle = SEDAN): THREE.BufferGeometry {
  return makeGlassQuad(style.rearGlass, 8, 6, -0.015);
}

/**
 * Side glass from the belt to the roof cant, leaning in with the tumblehome.
 * Edges run rear (s=0) → front (s=1); `zBot`/`zTop` are the edge z at the
 * belt and at the top. Positions are relative to `origin`.
 */
function makeSideGlassPane(
  sign: number,
  style: BodyStyle,
  zBot: readonly [number, number],
  zTop: readonly [number, number],
  origin: V3,
): THREE.BufferGeometry {
  const segS = 6;
  const segT = 3;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let j = 0; j <= segT; j++) {
    const t = j / segT;
    for (let i = 0; i <= segS; i++) {
      const s = i / segS;
      const zt = lerp(zTop[0], zTop[1], s);
      const z = lerp(lerp(zBot[0], zBot[1], s), zt, t);
      const y = lerp(GLASS_BELT_Y, glassTopY(zt, style), t);
      positions.push(sign * glassX(z, y, style) - origin[0], y - origin[1], z - origin[2]);
      uvs.push(s, t);
    }
  }
  const row = segS + 1;
  for (let j = 0; j < segT; j++) {
    for (let i = 0; i < segS; i++) {
      const a = j * row + i;
      // Face outward (+x on the right) so the pane front-faces a viewer outside.
      if (sign > 0) indices.push(a, a + row, a + 1, a + 1, a + row, a + row + 1);
      else indices.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Door glass in pane-local space: car.ts parents it to the door at (∓0.02, 0.52, -0.28). */
export function makeSideGlass(sign: number, style: BodyStyle = SEDAN): THREE.BufferGeometry {
  const o = DOOR_GLASS_ORIGIN;
  const frontTop = style.windshieldTop[1] - 0.05;
  return makeSideGlassPane(sign, style, [0.01, 0.76], [0.03, frontTop], [sign * o.x, o.y, o.z]);
}

/** Quarter glass from the B-pillar back to the C-pillar, on the body (car local). */
export function makeRearSideGlass(sign: number, style: BodyStyle = SEDAN): THREE.BufferGeometry {
  const q = style.quarter;
  return makeSideGlassPane(sign, style, [q.zRearBot, B_PILLAR_Z.rear], [q.zRearTop, B_PILLAR_Z.rear], [0, 0, 0]);
}

export function makeMirror(sign: number): THREE.Mesh {
  const arm = toned(new THREE.BoxGeometry(0.12, 0.04, 0.05), 0x2a2c32, 0.5, 0.4);
  arm.translate(sign * 0.08, 0, 0);
  const cap = toned(new THREE.BoxGeometry(0.1, 0.08, 0.16), 0x1c1e22, 0.35, 0.55);
  cap.translate(sign * 0.16, 0.01, 0);
  const glass = toned(new THREE.PlaneGeometry(0.08, 0.06), 0x9aa8b4, 0.08, 0.7);
  glass.rotateY(sign * Math.PI * 0.5);
  glass.translate(sign * 0.212, 0.01, 0);
  return new THREE.Mesh(mergeToned([arm, cap, glass], "mirror"), partsMaterial());
}

/** Cabin tub, dash, headliner, bulkhead, seats, side walls and steering wheel: one draw. */
export function makeInterior(): THREE.Mesh {
  const dark = [0x14161c, 0.94, 0.04] as const;
  const vinyl = [0x1a1e24, 0.9, 0.05] as const;
  const seat = [0x1c2228, 0.88, 0.06] as const;
  const box = (w: number, h: number, d: number, tone: readonly [number, number, number], x: number, y: number, z: number) =>
    toned(new THREE.BoxGeometry(w, h, d), ...tone).translate(x, y, z);
  const parts = [
    box(0.84, 0.04, 1.28, dark, 0, 0.34, 0.02),
    box(0.82, 0.2, 0.24, dark, 0, 0.6, 0.48),
    box(0.78, 0.02, 1.05, vinyl, 0, 1.08, 0.02),
    box(0.8, 0.55, 0.04, vinyl, 0, 0.62, -0.62),
    toned(new THREE.TorusGeometry(0.11, 0.016, 8, 16), 0x2a2c32, 0.55, 0.2).rotateX(0.55).translate(-0.22, 0.68, 0.36),
  ];
  for (const x of [-0.2, 0.2]) {
    parts.push(box(0.3, 0.08, 0.36, seat, x, 0.4, 0.06));
    parts.push(toned(new THREE.BoxGeometry(0.3, 0.32, 0.07), ...seat).rotateX(-0.12).translate(x, 0.58, 0.06 - 0.16));
  }
  for (const sign of [-1, 1]) parts.push(box(0.03, 0.5, 1.1, vinyl, sign * 0.4, 0.62, 0.02));
  const mesh = new THREE.Mesh(mergeToned(parts, "interior"), partsMaterial());
  // The engine's distance detail keeps it on far cars: it shows through the glass.
  mesh.name = "interior";
  return mesh;
}

/** Inner door skin, in door-group space (hinge at the A-pillar). */
export function makeDoorLining(sign: number): THREE.Mesh {
  const geo = toned(new THREE.BoxGeometry(0.018, 0.5, 0.52), 0x1a1e24, 0.9, 0.04);
  geo.translate(-sign * 0.024, 0, -0.28);
  return new THREE.Mesh(geo, partsMaterial());
}

/**
 * Every car's wheels (tyre, rim, hub) as one instanced draw plus one shadow draw. Cars keep a
 * bare Group per wheel as the transform that spins, steers, rides the hub and pops; `sync` copies
 * those world matrices in once the scene's matrices are current for the frame.
 */
export class WheelBatch {
  readonly mesh: THREE.InstancedMesh;

  constructor(capacity: number) {
    const parts = [
      toned(new THREE.CylinderGeometry(0.32, 0.32, 0.22, 28, 1), 0x121214, 0.92, 0.05),
      toned(new THREE.CylinderGeometry(0.2, 0.22, 0.24, 18, 1), 0xc9cdd4, 0.28, 0.92),
      toned(new THREE.CylinderGeometry(0.07, 0.07, 0.26, 12), 0x8a909a, 0.35, 0.8),
    ];
    for (const p of parts) p.rotateZ(Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(mergeToned(parts, "wheel"), partsMaterial(), capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    // Instances span the pad and move every frame; a stale bound would cull live wheels.
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  /** Pack the shown wheels of `cars` (world matrices must be current). */
  sync(cars: readonly { readonly wheels: readonly THREE.Object3D[] }[]): void {
    const max = this.mesh.instanceMatrix.count;
    let n = 0;
    for (const car of cars) {
      for (const w of car.wheels) {
        let shown = n < max;
        for (let p: THREE.Object3D | null = w; p && shown; p = p.parent) shown = p.visible;
        if (shown) this.mesh.setMatrixAt(n++, w.matrixWorld);
      }
    }
    this.mesh.count = n;
    const attr = this.mesh.instanceMatrix;
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, n * 16);
    attr.needsUpdate = true;
  }
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

/**
 * Soft shoulder on a car material's final linear radiance: untouched up to 0.7, rolling off to at most 1.1.
 * A white body under the sun reached 14 (sun specular through roughness 0.42 + clearcoat), which bloomed
 * (post threshold 1.6) and pushed a fifth of the body to near-white after exposure 1.45. Capped, lit paint
 * stays below the bloom threshold and tone-maps to ≤ ~240/255 at every FX tier; only emissive FX bloom.
 */
const HIGHLIGHT_CAP = /* glsl */ `
float capM = max(outgoingLight.r, max(outgoingLight.g, outgoingLight.b));
if (capM > 0.7) outgoingLight *= (0.7 + 0.4 * (1.0 - exp((0.7 - capM) / 0.4))) / capM;
#include <opaque_fragment>`;

function capHighlights<T extends THREE.MeshStandardMaterial>(m: T): T {
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", HIGHLIGHT_CAP);
  };
  m.customProgramCacheKey = () => "car-highlight-cap";
  return m;
}

export function makePaintMaterial(color: number): THREE.MeshPhysicalMaterial {
  const maps = typeof document === "undefined" ? { map: null, roughness: null } : makePaintMaps();
  return capHighlights(
    new THREE.MeshPhysicalMaterial({
      color,
      map: maps.map ?? undefined,
      roughnessMap: maps.roughness ?? undefined,
      metalness: 0.2,
      roughness: 0.42,
      clearcoat: 0.72,
      clearcoatRoughness: 0.24,
      envMapIntensity: 0.9,
      side: THREE.FrontSide,
    }),
  );
}

export function makeTrimMaterial(color: number): THREE.MeshStandardMaterial {
  return capHighlights(
    new THREE.MeshStandardMaterial({
      color,
      metalness: 0.55,
      roughness: 0.38,
      envMapIntensity: 0.65,
    }),
  );
}

/** Roughness/metalness lookup in 0.01 steps: texel (i, j) = roughness i/100 (G), metalness j/100 (B). */
const TONE_STEPS = 100;
let _toneGrid: THREE.DataTexture | null = null;
let _partsMat: THREE.MeshStandardMaterial | null = null;

function toneGrid(): THREE.DataTexture {
  if (_toneGrid) return _toneGrid;
  const n = TONE_STEPS + 1;
  const data = new Float32Array(n * n * 4);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 4;
      data[o] = 1;
      data[o + 1] = i / TONE_STEPS;
      data[o + 2] = j / TONE_STEPS;
      data[o + 3] = 1;
    }
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.FloatType);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  _toneGrid = t;
  return t;
}

/** Shared by every car's multi-tone static parts (interior, wheels, mirrors, trim): colour comes
 * from vertex colours and roughness/metalness from `toneGrid` via UV, so dozens of tiny meshes
 * collapse into a few draws that all reuse one program and one uniform upload. Never disposed. */
function partsMaterial(): THREE.MeshStandardMaterial {
  if (_partsMat) return _partsMat;
  const grid = toneGrid();
  _partsMat = capHighlights(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, roughnessMap: grid, metalnessMap: grid }),
  );
  _partsMat.userData.shared = true;
  return _partsMat;
}

/** Paint `geo` one flat tone: vertex colour (linear, as `material.color` would be) and a UV at the
 * tone-grid texel for this roughness/metalness. */
function toned(geo: THREE.BufferGeometry, color: number, roughness: number, metalness: number): THREE.BufferGeometry {
  const n = geo.getAttribute("position").count;
  const c = new THREE.Color(color);
  const u = (Math.round(roughness * TONE_STEPS) + 0.5) / (TONE_STEPS + 1);
  const v = (Math.round(metalness * TONE_STEPS) + 0.5) / (TONE_STEPS + 1);
  const col = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
    uv[i * 2] = u;
    uv[i * 2 + 1] = v;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}

function mergeToned(parts: THREE.BufferGeometry[], what: string): THREE.BufferGeometry {
  const geo = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  if (!geo) throw new Error(`Failed to merge ${what}`);
  return geo;
}

export function makeGlassMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x1a2832,
    metalness: 0.18,
    roughness: 0.08,
    transparent: true,
    opacity: 0.72,
    envMapIntensity: 1.15,
    side: THREE.DoubleSide,
    // Panes are near-planar: each pixel sees one face, so three's back-then-front two-pass draw
    // only doubled the draws and re-resolved the program twice per pane per frame.
    forceSinglePass: true,
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

/** Grille slats in front-bumper space; the headlamps sit on the body (`makeLampUnit`). */
export function makeGrille(): THREE.Mesh {
  return new THREE.Mesh(toned(new THREE.BoxGeometry(0.72, 0.16, 0.06, 4, 2, 1), 0x1a1c20, 0.55, 0.45), partsMaterial());
}

/** Lower diffuser strip and the number plate, in rear-bumper space; the tail lamps sit on the body. */
export function makeTailTrim(): THREE.Mesh {
  const parts = [
    toned(new THREE.BoxGeometry(1.1, 0.05, 0.06), 0x15171a, 0.6, 0.3).translate(0, -0.12, -0.02),
    toned(new THREE.BoxGeometry(0.36, 0.11, 0.02), 0xd8d4cc, 0.6, 0.1).translate(0, 0.03, -0.08),
  ];
  return new THREE.Mesh(mergeToned(parts, "tail trim"), partsMaterial());
}

export type LampKind = "head" | "tail";

/** Lamp unit in lamp space (lens toward +z, origin on the body skin): dark housing plus lens, one draw.
 *  uv picks the `lampEmissiveMap` texel — housing 0, lens 1 — so a per-lamp emissive lights the lens alone. */
export function makeLampUnit(kind: LampKind): THREE.BufferGeometry {
  const head = kind === "head";
  const housing = toned(new THREE.BoxGeometry(head ? 0.27 : 0.31, 0.11, 0.05), head ? 0x1a1c20 : 0x15171a, 0, 0);
  const lens = toned(new THREE.BoxGeometry(head ? 0.22 : 0.26, head ? 0.085 : 0.075, 0.03), head ? 0xf4f1e8 : 0xc4121c, 0, 0);
  (housing.getAttribute("uv").array as Float32Array).fill(0.25);
  (lens.getAttribute("uv").array as Float32Array).fill(0.75);
  return mergeToned([housing.translate(0, 0, 0.015), lens.translate(0, 0, 0.03)], "lamp unit");
}

let _lampEmissive: THREE.DataTexture | null = null;

/** 2×1 emissive mask for `makeLampUnit`: black housing texel, white lens texel. Shared, never disposed. */
export function lampEmissiveMap(): THREE.DataTexture {
  if (_lampEmissive) return _lampEmissive;
  _lampEmissive = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]), 2, 1);
  _lampEmissive.needsUpdate = true;
  return _lampEmissive;
}
