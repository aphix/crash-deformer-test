import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CAR_STYLES, type BodyStyle, type GlassQuad, type ProfileStation, type YZ } from "./car-variants.ts";
import { toned, mergeToned, makePartsMaterial, treadNormalMap } from "./car-materials.ts";

export const WHEEL_POS: [number, number, number][] = [
  [-0.74, 0.32, 1.34],
  [0.74, 0.32, 1.34],
  [-0.74, 0.32, -1.34],
  [0.74, 0.32, -1.34],
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

/** Height of the roof panel's centre-line crown at `z` (the top ring point of `makeRoofGeometry`). */
export function roofCrownY(z: number, style: BodyStyle): number {
  return roofAt(z, style).y + ROOF_CROWN;
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

/** Roof crown above the cant line at the centre line (m): the roof panel's gentle dome. */
const ROOF_CROWN = 0.026;

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
      { x: 0, y: y + ROOF_CROWN },
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

/** Tyre half-section, bead to bead ([radius, axle offset] m, axle offset ascending so faces point out):
 *  bulged sidewalls, rounded shoulders, a slightly crowned tread whose crown is the rig's `TYRE_R` (0.32). */
const TYRE_PROFILE = [
  [0.205, -0.1],
  [0.262, -0.112],
  [0.298, -0.104],
  [0.314, -0.082],
  [0.32, 0],
  [0.314, 0.082],
  [0.298, 0.104],
  [0.262, 0.112],
  [0.205, 0.1],
] as const;
/** `treadNormalMap` v per profile point: flat (0 / 1) off the tread, 0.06 → 0.94 across it. */
const TYRE_TREAD_V = [0, 0, 0, 0.06, 0.5, 0.94, 1, 1, 1] as const;
/** Normal-map repeats round the tyre (× `TREAD_LUGS` lugs each). */
const TREAD_REPEATS = 8;
/** Rim barrel lip to lip, axle offset descending so the faces point at the axle (seen through the spokes). */
const RIM_PROFILE = [
  [0.216, 0.1],
  [0.2, 0.102],
  [0.188, 0.086],
  [0.188, -0.086],
  [0.2, -0.102],
  [0.216, -0.1],
] as const;

/** Lathe `profile` about the x axle, toned; `uv1` (the tread normal map's set) runs ×`repeats` round it, `v` per point. */
function latheX(
  profile: readonly (readonly [number, number])[],
  segs: number,
  v: readonly number[] | null,
  repeats: number,
  tone: readonly [number, number, number],
): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, x]) => new THREE.Vector2(r, x)), segs);
  const uv = g.getAttribute("uv");
  const uv1 = new Float32Array(uv.count * 2);
  for (let i = 0; i < uv.count; i++) {
    uv1[i * 2] = uv.getX(i) * repeats;
    uv1[i * 2 + 1] = v ? v[Math.round(uv.getY(i) * (profile.length - 1))]! : 0;
  }
  g.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
  return toned(g, ...tone).rotateZ(-Math.PI / 2);
}

/** A toned part with a flat `uv1` (row 0 of the tread map). */
function flatPart(g: THREE.BufferGeometry, tone: readonly [number, number, number]): THREE.BufferGeometry {
  g.setAttribute("uv1", new THREE.BufferAttribute(new Float32Array(g.getAttribute("position").count * 2), 2));
  return toned(g, ...tone);
}

const RUBBER = [0x121214, 0.92, 0.05] as const;
const ALLOY = [0xc9cdd4, 0.28, 0.92] as const;

/**
 * One wheel about the x axle, symmetric in x so the same instance serves both sides: a lathed tyre
 * (tread detail from `treadNormalMap`), a rim barrel, five spokes through the full rim width over a
 * dark centre disc, and the hub. ~680 triangles.
 */
export function makeWheelGeometry(): THREE.BufferGeometry {
  const parts = [latheX(TYRE_PROFILE, 24, TYRE_TREAD_V, TREAD_REPEATS, RUBBER), latheX(RIM_PROFILE, 16, null, 1, ALLOY)];
  for (const side of [1, -1]) parts.push(flatPart(new THREE.CircleGeometry(0.19, 16).rotateY((side * Math.PI) / 2), [0x1c1d20, 0.7, 0.3]));
  for (let k = 0; k < 5; k++) {
    parts.push(flatPart(new THREE.BoxGeometry(0.17, 0.15, 0.042).translate(0, 0.115, 0).rotateX((k * 2 * Math.PI) / 5), ALLOY));
  }
  parts.push(flatPart(new THREE.CylinderGeometry(0.062, 0.062, 0.19, 10).rotateZ(Math.PI / 2), [0x8a909a, 0.35, 0.8]));
  return mergeToned(parts, "wheel");
}

/**
 * Every car's wheels (tyre, rim, hub) as one instanced draw plus one shadow draw. Cars keep a
 * bare Group per wheel as the transform that spins, steers, rides the hub and pops; `sync` copies
 * those world matrices in once the scene's matrices are current for the frame.
 */
export class WheelBatch {
  readonly mesh: THREE.InstancedMesh;

  constructor(capacity: number) {
    // Its own copy of the parts material (and shadow depth material): on the material the plain part meshes use,
    // three re-ran program selection (`getProgram`, an allocation) on every instanced ↔ plain switch, twice a frame.
    const mat = makePartsMaterial();
    mat.normalMap = treadNormalMap();
    this.mesh = new THREE.InstancedMesh(makeWheelGeometry(), mat, capacity);
    this.mesh.customDepthMaterial = new THREE.MeshDepthMaterial();
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

