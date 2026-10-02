import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { once } from "./scalar.ts";

/** The shared car textures and materials (paint, tone grid, glass, crack map, lamp mask) and the small multi-tone parts built on them. */

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


const makePaintMaps = once((): { map: THREE.CanvasTexture; roughness: THREE.CanvasTexture } => {
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

  const paintTex = new THREE.CanvasTexture(paint);
  paintTex.colorSpace = THREE.SRGBColorSpace;
  paintTex.anisotropy = 8;
  paintTex.wrapS = paintTex.wrapT = THREE.RepeatWrapping;
  const roughTex = new THREE.CanvasTexture(rough);
  roughTex.colorSpace = THREE.NoColorSpace;
  roughTex.anisotropy = 4;
  roughTex.wrapS = roughTex.wrapT = THREE.RepeatWrapping;
  return { map: paintTex, roughness: roughTex };
});

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
const toneGrid = once((): THREE.DataTexture => {
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
  return t;
});

/** Shared by every car's multi-tone static parts (interior, mirrors, trim; the wheels have their own copy): colour
 * comes from vertex colours and roughness/metalness from `toneGrid` via UV, so dozens of tiny meshes
 * collapse into a few draws that all reuse one program and one uniform upload. Never disposed. */
const partsMaterial = once(makePartsMaterial);

export function makePartsMaterial(): THREE.MeshStandardMaterial {
  const grid = toneGrid();
  const m = capHighlights(
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, roughnessMap: grid, metalnessMap: grid }),
  );
  m.userData.shared = true;
  return m;
}

/** Paint `geo` one flat tone: vertex colour (linear, as `material.color` would be) and a UV at the
 * tone-grid texel for this roughness/metalness. */
export function toned(geo: THREE.BufferGeometry, color: number, roughness: number, metalness: number): THREE.BufferGeometry {
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

export function mergeToned(parts: THREE.BufferGeometry[], what: string): THREE.BufferGeometry {
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

export const getCrackMap = once((): THREE.Texture => {
  if (typeof document === "undefined") {
    const t = new THREE.DataTexture(new Uint8Array([180, 200, 210, 48]), 1, 1);
    t.needsUpdate = true;
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
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
});

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

/** 2×1 emissive mask for `makeLampUnit`: black housing texel, white lens texel. Shared, never disposed. */
export const lampEmissiveMap = once((): THREE.DataTexture => {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]), 2, 1);
  t.needsUpdate = true;
  return t;
});

/** Light bar lens texels in `sirenEmissiveMap` order: housing, red lens, blue lens. */
const SIREN_U = [1 / 6, 3 / 6, 5 / 6] as const;

/** Roof light bar in bar space (origin on the roof crown, +z forward): housing on two feet, a red lens
 *  on the left (−x) and a blue one on the right, one draw. `LIGHT_BAR_LENS` lists each lens's vertices. */
export function makeLightBar(): THREE.BufferGeometry {
  const box = (w: number, h: number, d: number, x: number, y: number, tone: number, texel: 0 | 1 | 2) => {
    const g = toned(new THREE.BoxGeometry(w, h, d), tone, 0, 0).translate(x, y, 0);
    const uv = g.getAttribute("uv").array as Float32Array;
    for (let i = 0; i < uv.length; i += 2) {
      uv[i] = SIREN_U[texel];
      uv[i + 1] = 0.5;
    }
    return g;
  };
  return mergeToned(
    [
      box(1.06, 0.05, 0.25, 0, 0.04, 0x16181c, 0),
      box(0.06, 0.07, 0.2, 0, 0.1, 0x8a909a, 0),
      box(0.08, 0.06, 0.18, -0.4, 0, 0x16181c, 0),
      box(0.08, 0.06, 0.18, 0.4, 0, 0x16181c, 0),
      box(0.47, 0.075, 0.22, -0.27, 0.1, 0x8c1218, 1),
      box(0.47, 0.075, 0.22, 0.27, 0.1, 0x1a36a8, 2),
    ],
    "light bar",
  );
}

/** [first vertex, count] of the red and blue lens in `makeLightBar` (a box is 24 vertices). */
export const LIGHT_BAR_LENS = [
  [96, 24],
  [120, 24],
] as const;

/** 3×1 emissive mask for `makeLightBar`: black housing, pure red lens, pure blue lens. The bar material's
 *  emissive colour picks the lit lens: (k, 0, 0) lights only red, (0, 0, k) only blue (any green or
 *  cross-channel in a texel tints the dark lens: the first cut lit the blue lens magenta). Shared, never disposed. */
const sirenEmissiveMap = once((): THREE.DataTexture => {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255]), 3, 1);
  t.needsUpdate = true;
  return t;
});

/** Per-car light bar material: emissive stays black until `setSirens` flashes it. */
export function makeSirenMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.25, emissive: 0x000000, emissiveMap: sirenEmissiveMap() });
}

