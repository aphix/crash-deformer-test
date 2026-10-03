import * as THREE from "three";
import { computeNormalsFast } from "../deform/fast-normals.ts";
import { ARCH_R, DOOR, WHEEL_POS } from "./car-mesh.ts";
import type { BodyStyle } from "./car-variants.ts";

/**
 * Quarter panels and wheel-arch flares: patches of the body loft's own skin that hinge, peel and tear off.
 * Attached, a panel is just body (no mesh, no draw, no per-frame work). Once its hinge value rises, a thin
 * shell built on the same skinned vertices (`makeShell`) sits 4 mm proud of the body and bends away
 * (`poseShell`); under it the body's own vertices are turned to primer (`setPrimer`, no extra draw), so when the
 * shell tears off a darker under-panel, the right shape, stays on the car.
 */

export const PANEL_NAMES = ["quarterL", "quarterR", "archFL", "archFR", "archRL", "archRR"] as const;
export type PanelName = (typeof PANEL_NAMES)[number];

export interface PanelRegion {
  name: PanelName;
  kind: "quarter" | "arch";
  /** -1 left, +1 right: the way the panel peels. */
  side: -1 | 1;
  /** Body vertex of each shell vertex. */
  verts: Uint16Array;
  /** Peel weight per vertex: 0 at the hinge, 1 at the free end. */
  w: Float32Array;
  /** The panel's rest centroid in car space: its part's origin. */
  origin: THREE.Vector3;
  /** Quarter panels: the vertical hinge line (x, z) at the trailing edge. */
  pivot: readonly [number, number];
  /** The shell's triangles (front, back, rim skirt), shared by every car of the style. */
  shell: THREE.BufferAttribute;
  /** The same triangles in body vertex ids. */
  tris: THREE.BufferAttribute;
}

/** The shell stands this far proud of the skin (m), as the door skin does: no z-fight. */
const PROUD = 0.004;
/** Sheet thickness behind the skin (m). */
const THICK = 0.02;
/** Rad a quarter panel's free end peels at hinge value 1; lift (m) there. */
const PEEL = 1;
const PEEL_LIFT = 0.03;
/** m the arch flare's free ends flap out, and drop, at hinge value 1. */
const FLAP = 0.16;
const FLAP_DROP = 0.04;
/** The arch flare is the skin from this far inside to this far outside the arch opening's radius (m). */
const ARCH_IN = 0.04;
const ARCH_OUT = 0.1;
/** Loft rings of the body side, deck edge to rocker: left rings 1-5, right rings 12-16 (`sectionPoints`). */
const SIDE_RINGS = 5;

const cache = new WeakMap<BodyStyle, readonly PanelRegion[]>();

/** The style's panel regions, cut once from its rest loft (`makeChassisGeometry`). */
export function panelRegions(style: BodyStyle, body: THREE.BufferGeometry): readonly PanelRegion[] {
  let r = cache.get(style);
  if (!r) cache.set(style, (r = cut(style, body)));
  return r;
}

function cut(style: BodyStyle, body: THREE.BufferGeometry): PanelRegion[] {
  const { ring: n, slices } = body.userData.loft as { ring: number; slices: number };
  const pos = (body.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  // The quarter runs from behind the rear door's shut line (on a two-door, behind the door) to the tail corner.
  const zFront = style.rearDoorSeam ?? DOOR.hingeZ - DOOR.length;
  const zTail = style.profile[0]!.z + 0.15;
  const hubY = WHEEL_POS[0]![1];
  const tris = Object.fromEntries(PANEL_NAMES.map((k) => [k, [] as number[]])) as Record<PanelName, number[]>;
  for (let s = 0; s < slices - 1; s++) {
    for (let i = 1; i < n; i++) {
      const side = i >= 2 && i <= SIDE_RINGS ? -1 : i >= n - 2 - SIDE_RINGS && i <= n - 4 ? 1 : 0;
      if (side === 0) continue;
      // The flare stays below the shoulder strip (ring 2 from the top): on a pickup that strip is the bed rail.
      const archOk = (side < 0 ? i : n - 2 - i) >= 3;
      const a = s * n + i;
      const b = a + 1;
      const c = a + n;
      const d = b + n;
      const z = (pos[a * 3 + 2]! + pos[c * 3 + 2]!) / 2;
      const y = (pos[a * 3 + 1]! + pos[b * 3 + 1]! + pos[c * 3 + 1]! + pos[d * 3 + 1]!) / 4;
      let name: PanelName | null = null;
      for (let k = 0; k < 4; k++) {
        const [wx, , wz] = WHEEL_POS[k]!;
        if (Math.sign(wx) !== side) continue;
        const dy = y - hubY;
        const r = dy > 0 ? Math.hypot(z - wz, dy) : Math.abs(z - wz);
        if (archOk && r >= ARCH_R - ARCH_IN && r <= ARCH_R + ARCH_OUT) name = PANEL_NAMES[2 + k]!;
      }
      if (!name && z <= zFront && z >= zTail) name = side < 0 ? "quarterL" : "quarterR";
      if (name) tris[name].push(a, b, c, b, d, c);
    }
  }
  return PANEL_NAMES.map((name) => region(name, tris[name], pos));
}

function region(name: PanelName, ids: number[], pos: Float32Array): PanelRegion {
  const local = new Map<number, number>();
  const verts: number[] = [];
  const tris: number[] = [];
  for (const g of ids) {
    let l = local.get(g);
    if (l === undefined) local.set(g, (l = verts.push(g) - 1));
    tris.push(l);
  }
  const nv = verts.length;
  // Boundary edges, directed as their triangle has them: the skirt closes the sheet along them.
  const edges = new Set<number>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) edges.add(tris[t + e]! * 65536 + tris[t + (e + 1) % 3]!);
  const shell = [...tris];
  for (let t = 0; t < tris.length; t += 3) shell.push(nv + tris[t]!, nv + tris[t + 2]!, nv + tris[t + 1]!);
  for (const k of edges) {
    const a = Math.floor(k / 65536);
    const b = k % 65536;
    if (!edges.has(b * 65536 + a)) shell.push(a, nv + b, b, a, nv + a, nv + b);
  }
  const kind = name.startsWith("quarter") ? "quarter" : "arch";
  const side = name.endsWith("L") ? -1 : 1;
  const origin = new THREE.Vector3();
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const g of verts) {
    origin.x += pos[g * 3]! / nv;
    origin.y += pos[g * 3 + 1]! / nv;
    origin.z += pos[g * 3 + 2]! / nv;
    zMin = Math.min(zMin, pos[g * 3 + 2]!);
    zMax = Math.max(zMax, pos[g * 3 + 2]!);
  }
  const hub = WHEEL_POS[PANEL_NAMES.indexOf(name) - 2];
  const w = new Float32Array(nv);
  let px = 0;
  let pn = 0;
  for (let k = 0; k < nv; k++) {
    const g = verts[k]! * 3;
    if (kind === "quarter") {
      w[k] = THREE.MathUtils.smoothstep((pos[g + 2]! - zMin) / (zMax - zMin), 0, 1);
      if (pos[g + 2]! - zMin < 0.05) {
        px += pos[g]!;
        pn++;
      }
    } else {
      // Hinged at the top of the arch, free where it meets the rocker.
      w[k] = Math.pow(Math.atan2(Math.abs(pos[g + 2]! - hub![2]), Math.max(pos[g + 1]! - hub![1], 0)) / (Math.PI / 2), 1.3);
    }
  }
  return {
    name,
    kind,
    side,
    verts: Uint16Array.from(verts),
    w,
    origin,
    pivot: [pn ? px / pn : side * 0.8, zMin],
    shell: new THREE.BufferAttribute(Uint16Array.from(shell), 1),
    tris: new THREE.BufferAttribute(Uint16Array.from(ids), 1),
  };
}

/** A panel's shell, posed on `body`'s current skin, unbent. */
export function makeShell(r: PanelRegion, body: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(r.verts.length * 6), 3));
  g.setIndex(r.shell);
  poseShell(r, g, body, 0, 0);
  return g;
}

/**
 * Rebuild `shell` from the body's skin, bent by hinge value `t`: a quarter panel peels from its leading edge
 * about the vertical hinge line at its tail; an arch flare flaps out at both feet (`flutter` -1..1 shakes it).
 * Vertices are relative to the region's origin, the part's frame.
 */
export function poseShell(r: PanelRegion, shell: THREE.BufferGeometry, body: THREE.BufferGeometry, t: number, flutter: number): void {
  const bp = (body.getAttribute("position") as THREE.BufferAttribute).array as Float32Array;
  const bn = (body.getAttribute("normal") as THREE.BufferAttribute).array as Float32Array;
  const attr = shell.getAttribute("position") as THREE.BufferAttribute;
  const o = attr.array as Float32Array;
  const nv = r.verts.length;
  const quarter = r.kind === "quarter";
  const flap = r.side * FLAP * t * (1 + 0.18 * flutter);
  for (let k = 0; k < nv; k++) {
    const g = r.verts[k]! * 3;
    const x = bp[g]!;
    const y = bp[g + 1]!;
    const z = bp[g + 2]!;
    const w = r.w[k]!;
    let dx = flap * w;
    let dy = -FLAP_DROP * t * w;
    let dz = 0;
    if (quarter) {
      const phi = r.side * PEEL * t * w;
      const rx = x - r.pivot[0];
      const rz = z - r.pivot[1];
      const sin = Math.sin(phi);
      const cos = Math.cos(phi) - 1;
      dx = rx * cos + rz * sin;
      dz = -rx * sin + rz * cos;
      dy = PEEL_LIFT * t * w;
    }
    for (let c = 0, at = k * 3, sign = PROUD; c < 2; c++, at += nv * 3, sign = -THICK) {
      o[at] = x + dx + bn[g]! * sign - r.origin.x;
      o[at + 1] = y + dy + bn[g + 1]! * sign - r.origin.y;
      o[at + 2] = z + dz + bn[g + 2]! * sign - r.origin.z;
    }
  }
  attr.needsUpdate = true;
  computeNormalsFast(shell);
}

/** Move the shell's vertices so its centroid is the part's origin (a torn panel tumbles about its middle); `out` ← the centroid it had. */
export function recentre(shell: THREE.BufferGeometry, out: THREE.Vector3): void {
  const attr = shell.getAttribute("position") as THREE.BufferAttribute;
  const o = attr.array as Float32Array;
  out.set(0, 0, 0);
  const n = o.length / 3;
  for (let i = 0; i < o.length; i += 3) out.set(out.x + o[i]! / n, out.y + o[i + 1]! / n, out.z + o[i + 2]! / n);
  for (let i = 0; i < o.length; i += 3) {
    o[i] -= out.x;
    o[i + 1] -= out.y;
    o[i + 2] -= out.z;
  }
  attr.needsUpdate = true;
}

/** The under-panel: the panel's vertices on the body painted to primer (or back to paint), by the paint's `primer` attribute. */
export function setPrimer(r: PanelRegion, body: THREE.BufferGeometry, on: boolean): void {
  const attr = body.getAttribute("primer") as THREE.BufferAttribute;
  for (const v of r.verts) attr.setX(v, on ? 1 : 0);
  attr.needsUpdate = true;
}

const _axis = new THREE.Vector3();
const _up = new THREE.Vector3();
const _turn = new THREE.Quaternion();
const _step = new THREE.Quaternion();
/** Rad/s a torn panel turns to lie flat. */
const FLAT_RATE = 7;

/** A torn panel's thin axis is its local x: turn it toward straight up (or down) so the sheet lies on the road. */
export function layFlat(object: THREE.Object3D, dt: number): void {
  _axis.set(1, 0, 0).applyQuaternion(object.quaternion);
  const angle = Math.acos(Math.min(1, Math.abs(_axis.y)));
  if (angle < 1e-3) return;
  _turn.setFromUnitVectors(_axis, _up.set(0, _axis.y < 0 ? -1 : 1, 0));
  object.quaternion.premultiply(_step.identity().slerp(_turn, Math.min(1, (FLAT_RATE * dt) / angle)));
}
