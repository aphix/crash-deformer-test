import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { hypot2 } from "../kernel/physics-core.js";
import { CAR_STYLES, type BodyStyle, type ProfileStation, type YZ } from "./car-variants.ts";

export const WHEEL_POS: [number, number, number][] = [
  [-0.74, 0.32, 1.34],
  [0.74, 0.32, 1.34],
  [-0.74, 0.32, -1.34],
  [0.74, 0.32, -1.34],
];

export const CAR_HALF = { x: 0.88, y: 0.68, z: 2.22 };

/** Shared-platform hardpoints (8e2dc49, five styles on one platform): arch opening radius about the hub (m), floor pan height (m). */
export const ARCH_R = 0.38;
const WHEEL_Y = WHEEL_POS[0]![1];
const Y_FLOOR = 0.145;
const SEDAN = CAR_STYLES.sedan;

/** Platform hardpoints every style shares. */
export const WINDSHIELD_BASE: YZ = [0.78, 1.03];
export const WINDSHIELD_W = { base: 1.3, top: 0.96 } as const;
export const B_PILLAR_Z = { rear: -0.13, front: -0.03 } as const;
export const GLASS_BELT_Y = 0.83;
const GLASS_BELT_X = 0.85;

type Pt = { x: number; y: number };
type V3 = readonly [number, number, number];

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * PCHIP tangent (Fritsch–Butland) of station field `key` at station `i`: flat at a local extremum, the end
 * interval's secant at either end. Keeps the loft's width and beltline C1 along z without overshoot; a
 * smoothstep per interval flattened every station into a visible ring.
 */
function stationSlope(p: readonly ProfileStation[], i: number, key: "hw" | "yBelt"): number {
  const secant = (k: number) => (p[k + 1]![key] - p[k]![key]) / (p[k + 1]!.z - p[k]!.z);
  if (i === 0) return secant(0);
  if (i === p.length - 1) return secant(i - 1);
  const d0 = secant(i - 1);
  const d1 = secant(i);
  if (d0 * d1 <= 0) return 0;
  const h0 = p[i]!.z - p[i - 1]!.z;
  const h1 = p[i + 1]!.z - p[i]!.z;
  const w0 = 2 * h1 + h0;
  const w1 = h1 + 2 * h0;
  return (w0 + w1) / (w0 / d0 + w1 / d1);
}

function sampleSlice(z: number, profile: readonly ProfileStation[]): ProfileStation {
  if (z <= profile[0]!.z) return { ...profile[0]!, z };
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]!;
    const b = profile[i]!;
    if (z <= b.z) {
      const h = b.z - a.z;
      const t = (z - a.z) / h;
      const s = THREE.MathUtils.smoothstep(t, 0, 1);
      // Cubic Hermite on [a, b] with PCHIP tangents for the shell's width and beltline.
      const hermite = (key: "hw" | "yBelt") =>
        (2 * t ** 3 - 3 * t ** 2 + 1) * a[key] +
        (t ** 3 - 2 * t ** 2 + t) * h * stationSlope(profile, i - 1, key) +
        (3 * t ** 2 - 2 * t ** 3) * b[key] +
        (t ** 3 - t ** 2) * h * stationSlope(profile, i, key);
      return {
        z,
        hw: hermite("hw"),
        yBelt: hermite("yBelt"),
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

/** Height of the roof panel's top at (`x`, `z`), the top ring of `makeRoofGeometry`: the centre-line crown, the dome's
 *  shoulder, then down to the cant line at the roof's half-width. */
export function roofTopY(x: number, z: number, style: BodyStyle): number {
  const r = roofAt(z, style);
  const [us, ys] = ROOF_SHOULDER;
  const u = Math.min(Math.abs(x) / r.x, 1);
  return r.y + (u < us ? lerp(ROOF_CROWN, ys, u / us) : lerp(ys, 0, (u - us) / (1 - us)));
}

/**
 * The body's top surface (m over the tyre plane) at car-local (`x`, `z`): the roof panel over the cabin, easing to the
 * beltline over the bonnet and boot and out across the shoulder; NaN past the body's plan. What a car resting on this
 * one stands on (`CarSurfaces`).
 */
export function bodyTopY(x: number, z: number, style: BodyStyle): number {
  const sl = sampleSlice(z, style.profile);
  const r = roofAt(z, style);
  const ax = Math.abs(x);
  if (ax > sl.hw || Math.abs(z) > CAR_HALF.z) return NaN;
  return ax <= r.x ? roofTopY(x, z, style) : lerp(r.y, sl.yBelt, (ax - r.x) / Math.max(sl.hw - r.x, 1e-3));
}

/** Side glass top edge: tucked under the roof cant rail. */
export function glassTopY(z: number, style: BodyStyle): number {
  return roofAt(z, style).y - 0.075;
}

function cantX(z: number, style: BodyStyle): number {
  return roofAt(z, style).x + 0.08;
}

/** Tumblehome: side glass leans in from the belt to the roof cant. */
export function glassX(z: number, y: number, style: BodyStyle): number {
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
    const r = y >= WHEEL_Y ? hypot2(dz, y - WHEEL_Y) : Math.abs(dz);
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

/** The side's widest line sits this far below the belt (m), `SIDE_OUT` proud of the station half-width. */
const FEATURE_DROP = 0.1;
const SIDE_OUT = 0.004;
/** Shoulder: a quarter-ellipse from the feature line (vertical tangent) toward the deck edge, `SHOULDER` = [out, up] radii (m). */
const SHOULDER = [0.074, 0.104] as const;
/** The side's shoulder stops at this arc angle (rad); the deck (or the door glass) takes over above it. */
const SHOULDER_TOP = Math.PI / 3;
/** Tuck-under from the feature line to the rocker (m, parabolic in height). */
const TUCK = 0.03;
const ROCKER_Y = 0.2;

/**
 * Body-side half-width at height `y` for a station of half-width `hw` and belt `yb`: the shoulder rolls in
 * above the feature line, the side tucks under below it, C1 at the feature line. The door skin follows it too.
 */
function sideX(y: number, hw: number, yb: number): number {
  const yF = yb - FEATURE_DROP;
  if (y >= yF) {
    const sin = Math.min((y - yF) / SHOULDER[1], Math.sin(SHOULDER_TOP));
    return hw + SIDE_OUT - SHOULDER[0] * (1 - Math.sqrt(1 - sin * sin));
  }
  const v = Math.min((yF - y) / (yF - ROCKER_Y), 1);
  return hw + SIDE_OUT - TUCK * v * v;
}

/** Shoulder arc angles sampled by the ring (rad), top down; the feature line (0) follows. Two 30° chords sag 3 mm. */
const SHOULDER_RING = [SHOULDER_TOP, Math.PI / 6] as const;
/** Half-ring indices of the feature line and the rocker: the side points between them flare at the arches. */
const FLARE_FIRST = 4;
const ROCKER = 6;

/**
 * Lower body ring (left half top→bottom, keel, right half bottom→top; the
 * wrap edge is the deck). Deck crown → deck edge → rounded shoulder → feature
 * line → tuck-under → rocker → sill. Tubs open the deck into a floor with walls;
 * the door cut drops the side to the sill. Greenhouse is never lofted metal.
 */
function sectionPoints(s: ProfileStation, style: BodyStyle): Pt[] {
  const { hw, yBelt: yb, z } = s;
  const hole = doorAperture(z);
  const tub = tubAt(z, style);
  const well = wheelWell(z);
  const archY = WHEEL_Y + well;
  const inset = seamInset(z, style);
  const yF = yb - FEATURE_DROP;
  const side = (y: number): [number, number] => [sideX(y, hw, yb) - inset, y];
  // One tuck point between the feature line and the rocker: the parabola's two chords sag under 2 mm.
  const half: [number, number][] = [
    [lerp(hw - 0.22, hw - 0.06, tub.t), lerp(yb + 0.012, tub.floor, tub.t)],
    [lerp(hw - 0.07, hw - 0.06, tub.t), lerp(yb + 0.004, yb - 0.006, tub.t)],
    ...SHOULDER_RING.map((a) => side(yF + SHOULDER[1] * Math.sin(a))),
    side(yF),
    side(lerp(yF, ROCKER_Y, 0.5)),
    side(ROCKER_Y),
    [hw - 0.05, 0.165],
    [hw * 0.8, Y_FLOOR + 0.004],
  ];
  // The door cut: every point above the rocker drops onto the sill's top.
  const sill: [number, number][] = [
    [hw - 0.1, 0.235],
    [hw - 0.07, 0.236],
    [hw - 0.05, 0.234],
    [hw - 0.036, 0.231],
    [hw - 0.029, 0.226],
    [hw - TUCK + SIDE_OUT, 0.22],
  ];
  for (let i = 0; i < sill.length; i++) {
    const p = half[i]!;
    p[0] = lerp(p[0], sill[i]![0], hole);
    p[1] = lerp(p[1], sill[i]![1], hole);
  }
  for (let i = FLARE_FIRST; i <= ROCKER; i++) half[i]![0] += 0.022 * archFlare(z, half[i]![1]);
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
  // The end caps are the shell's real hard edges (end panels, ~50–90° off the loft): each gets its own copy of the end
  // ring, so the cap shades flat and the loft smooth instead of averaging the corner into both. The copies share rest
  // positions, so they skin (and wrinkle) as one.
  const cap = (slice: number, inward: boolean) => {
    const ring = rings[slice]!;
    const z = zs[slice]!;
    let cx = 0,
      cy = 0;
    const base = positions.length / 3;
    for (const p of ring) {
      cx += p.x;
      cy += p.y;
      positions.push(p.x, p.y, z);
      uvs.push(inward ? 0 : 1, 0.5);
    }
    const center = positions.length / 3;
    positions.push(cx / n, cy / n, z);
    uvs.push(inward ? 0 : 1, 0.5);
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
/** The dome's shoulder: [share of the roof half-width, rise above the cant line (m)]. */
const ROOF_SHOULDER = [0.45, 0.018] as const;

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
      { x: -x * ROOF_SHOULDER[0], y: y + ROOF_SHOULDER[1] },
      { x: 0, y: y + ROOF_CROWN },
      { x: x * ROOF_SHOULDER[0], y: y + ROOF_SHOULDER[1] },
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
  // The loft is merged first: its vertex `s * ring + i` and its first (slices - 1) * ring * 2 triangles (`panelRegions` cuts panels out of them).
  merged.userData.loft = { ring: rings[0]!.length, slices: zs.length };
  // 0 = paint, 1 = primer (`car-materials.ts` withPrimer): a torn panel's vertices are set dark.
  merged.setAttribute("primer", new THREE.BufferAttribute(new Float32Array(merged.getAttribute("position").count), 1));
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

/** The tailgate stops this far (m) inside the tail panel's half-width: the tail lamps stand upright in the corners. */
const TAILGATE_INSET = 0.135;

/** Hatch / tailgate: a slightly bowed vertical panel hinged at its top edge. */
function makeTailgate(style: BodyStyle, y0: number, origin: YZ): THREE.BufferGeometry {
  const [y1, oz] = origin;
  const w = sampleSlice(oz, style.profile).hw - TAILGATE_INSET;
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
  /** Door skin mesh offset from the hinge along z (m). */
  skinZ: -0.28,
  /** Mirror base in door space (±mirrorX, mirrorY, 0); the cap reaches `mirrorReach` out and is ±`mirrorHalfDepth` deep. */
  mirrorX: 0.06,
  mirrorY: 0.32,
  mirrorReach: 0.21,
  mirrorHalfDepth: 0.08,
} as const;

/** Door skin over the body side at its outer face (m). */
const DOOR_PROUD = 0.003;

/**
 * Door skin in hinge-local space (parent at the A-pillar hinge, the skin `DOOR.skinZ` behind it). The outer face
 * follows the body side (`sideX`) at each height and station, 5 cm thick inboard; its rows bunch toward the top so
 * the shoulder roll reads round.
 */
export function makeDoorGeometry(sign: number, style: BodyStyle = SEDAN): THREE.BufferGeometry {
  const h = DOOR.halfHeight;
  const geo = new THREE.BoxGeometry(0.05, 2 * h, 0.58, 2, 8, 6);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const out = pos.getX(i) * sign;
    // float32 rows can sit a hair past ±h: clamp before the fractional power.
    const t = THREE.MathUtils.clamp((pos.getY(i) + h) / (2 * h), 0, 1);
    let y = h * (1 - 2 * (1 - t) ** 1.6);
    const z = pos.getZ(i);
    if (z > 0.16) y += (z - 0.16) * -0.06;
    if (z < -0.2) y += (-0.2 - z) * -0.04;
    const sl = sampleSlice(DOOR.hingeZ + DOOR.skinZ + z, style.profile);
    const outer = sideX(DOOR.hingeY + y, sl.hw, sl.yBelt) + DOOR_PROUD - DOOR.hingeX;
    pos.setXYZ(i, sign * (outer - 0.025 + out), y, z);
  }
  geo.computeVertexNormals();
  return geo;
}
