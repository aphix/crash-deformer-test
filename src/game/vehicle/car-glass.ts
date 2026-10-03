import * as THREE from "three";
import { CAR_STYLES, type BodyStyle, type GlassQuad } from "./car-variants.ts";
import { B_PILLAR_Z, GLASS_BELT_Y, WINDSHIELD_BASE, WINDSHIELD_W, glassTopY, glassX, lerp } from "./car-mesh.ts";

// Glass panes on the shared platform: windshield, rear glass, door and quarter glass, filling the greenhouse `car-mesh.ts` builds.

const SEDAN = CAR_STYLES.sedan;
/** Door glass pane origin in car space (door hinge + pane offset set in car.ts). */
const DOOR_GLASS_ORIGIN = { x: 0.84, y: 1.06, z: 0.27 } as const;

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
  origin: readonly [number, number, number],
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
