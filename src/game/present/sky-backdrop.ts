import * as THREE from "three";
import type { TrackJson } from "../world/track-schema.ts";

/**
 * A picture on the sky (`environment.backdrop`): a panel of the sky sphere round the camera, `PANEL.half` (rad) either side of
 * the bearing, from just under the horizon (`foot`) to `top` (elevations, rad), painted on a canvas in those angles. It is drawn
 * at infinity: the vertex shader turns it with the camera but never moves it and puts it on the far plane, so the whole course
 * stands in front of it. It writes no depth and takes no fog and no tone mapping, as the sky colour behind it, which shows
 * through wherever the painting is clear (and darkens with night as before).
 */
export const PANEL = { half: 0.34, foot: -0.02, top: 0.42 } as const;
/** Quads across and up the panel: its curve within a pixel of the sphere's. */
const GRID = { across: 32, up: 12 };
/** The canvas (px): about 1500 px a radian both ways. */
const CANVAS = { w: 1024, h: 640 };
/** The cloud's size against the angles `paintMushroomCloud` lays it out in: its crown under the top of the race camera's view. */
const CLOUD_SCALE = 0.65;
/** Clip-space depth the panel is drawn at, as a share of w: past every surface the far plane keeps. */
const FAR_DEPTH = 0.999999;

type Backdrop = NonNullable<TrackJson["environment"]["backdrop"]>;

/** The panel round `bearing` (degrees from −z toward +x): a unit-sphere patch, u running with the bearing, v up. */
export function backdropGeometry(bearing: number): THREE.BufferGeometry {
  const b = THREE.MathUtils.degToRad(bearing);
  const pos: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (let j = 0; j <= GRID.up; j++) {
    const el = PANEL.foot + ((PANEL.top - PANEL.foot) * j) / GRID.up;
    for (let i = 0; i <= GRID.across; i++) {
      const az = b - PANEL.half + (2 * PANEL.half * i) / GRID.across;
      pos.push(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
      uv.push(i / GRID.across, j / GRID.up);
    }
  }
  const row = GRID.across + 1;
  for (let j = 0; j < GRID.up; j++) {
    for (let i = 0; i < GRID.across; i++) {
      const a = j * row + i;
      index.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  return g;
}

/** The backdrop's mesh, ready to add to the course's art; its texture goes with its material (`disposeBackdrop`). */
export function backdropMesh(spec: Backdrop): THREE.Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS.w;
  canvas.height = CANVAS.h;
  paintMushroomCloud(canvas.getContext("2d")!);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  // Premultiplied, so the filtering never pulls the clear canvas's black into the cloud's edge.
  map.premultiplyAlpha = true;
  map.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map, transparent: true, premultipliedAlpha: true, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "#include <project_vertex>",
      `vec4 mvPosition = vec4( mat3( viewMatrix ) * transformed, 1.0 );\ngl_Position = projectionMatrix * mvPosition;\ngl_Position.z = gl_Position.w * ${FAR_DEPTH};`,
    );
  };
  mat.customProgramCacheKey = () => "sky-backdrop";
  const mesh = new THREE.Mesh(backdropGeometry(spec.bearing), mat);
  mesh.name = `backdrop:${spec.kind}`;
  // Its geometry is a unit patch at the origin that the shader carries to the sky: never culled, never hit.
  mesh.frustumCulled = false;
  mesh.raycast = () => {};
  // First of the see-through draws, so smoke and glass blend over it.
  mesh.renderOrder = -1e9;
  return mesh;
}

export function disposeBackdrop(mesh: THREE.Mesh): void {
  const mat = mesh.material as THREE.MeshBasicMaterial;
  mat.map?.dispose();
  mat.dispose();
  mesh.geometry.dispose();
}

/** A small seeded generator (mulberry32): the same cloud every load. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The fire's light adds to what is under it. */
const ADDITIVE: GlobalCompositeOperation = "lighter";

type Rgb = readonly [number, number, number];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const rgba = (c: Rgb, a: number): string => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

/**
 * The cloud's shades: the cap's sunlit crown and its shadowed flank, the fire-lit underside and the smoke there, the stem's dust
 * low down and its glow high up, the base surge, the condensation ring and the fire itself.
 */
const SHADE = {
  crownLit: [246, 238, 228],
  crownShade: [168, 154, 143],
  underLit: [232, 150, 92],
  underShade: [94, 64, 56],
  stemLowLit: [190, 172, 156],
  stemLowShade: [110, 96, 88],
  stemHighLit: [228, 164, 118],
  stemHighShade: [138, 90, 68],
  surgeLit: [205, 188, 168],
  surgeShade: [126, 110, 98],
  ring: [244, 244, 240],
  fire: [255, 150, 60],
  halo: [255, 190, 120],
} as const satisfies Record<string, Rgb>;

/**
 * A mushroom cloud, laid out in angles (rad, x across from the bearing, el up from the horizon) the panel shows at `CLOUD_SCALE`: a dust surge along the
 * horizon, a stem rising to `STEM_TOP`, a condensation ring round it, and the cap, a flattened torus of billows lit on its
 * crown and glowing from beneath, in a faint orange halo.
 */
function paintMushroomCloud(ctx: CanvasRenderingContext2D): void {
  const k = (CANVAS.w / (2 * PANEL.half)) * CLOUD_SCALE;
  const px = (x: number): number => CANVAS.w / 2 + x * k;
  const py = (el: number): number => ((PANEL.top - el * CLOUD_SCALE) / (PANEL.top - PANEL.foot)) * CANVAS.h;
  const rand = seeded(1945);
  const between = (a: number, b: number): number => a + (b - a) * rand();
  /** A billow: a ball lit from above left, fading out at its rim. */
  const puff = (x: number, el: number, r: number, lit: Rgb, shade: Rgb, alpha: number): void => {
    const cx = px(x);
    const cy = py(el);
    const R = r * k;
    const g = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.35, 0, cx, cy, R);
    g.addColorStop(0, rgba(lit, alpha));
    g.addColorStop(0.55, rgba(mix(lit, shade, 0.55), alpha * 0.9));
    g.addColorStop(1, rgba(shade, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fill();
  };
  const glow = (x: number, el: number, rx: number, ry: number, c: Rgb, alpha: number): void => {
    ctx.save();
    ctx.translate(px(x), py(el));
    ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx * k);
    g.addColorStop(0, rgba(c, alpha));
    g.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rx * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  const CAP = { el: 0.31, rx: 0.16, ry: 0.075 };
  const STEM_TOP = CAP.el - CAP.ry * 0.5;
  const RING = { el: 0.15, rx: 0.08, ry: 0.012 };
  const ring = (from: number, to: number): void => {
    ctx.save();
    ctx.filter = "blur(3px)";
    ctx.strokeStyle = rgba(SHADE.ring, 0.5);
    ctx.lineWidth = 0.008 * k;
    ctx.beginPath();
    ctx.ellipse(px(0), py(RING.el), RING.rx * k, RING.ry * k, 0, from, to);
    ctx.stroke();
    ctx.restore();
  };

  // The halo round the cap, and the glow of the fire on the haze along the horizon.
  glow(0, CAP.el, 0.42, 0.34, SHADE.halo, 0.26);
  glow(0, 0, 0.34, 0.06, SHADE.fire, 0.4);
  // The surge: dust thrown out along the ground.
  for (let i = 0; i < 90; i++) {
    const x = (rand() + rand() + rand() - 1.5) * 0.14;
    puff(x, between(0, 0.035) * (1 - Math.abs(x) * 3), between(0.012, 0.03), SHADE.surgeLit, SHADE.surgeShade, 0.85);
  }
  // The ring's far half passes behind the stem.
  ring(Math.PI, Math.PI * 2);
  // The stem, widening as it climbs and flaring into the cap.
  for (let i = 0; i < 170; i++) {
    const t = rand();
    const el = 0.01 + t * (STEM_TOP - 0.01);
    const w = 0.018 + 0.012 * t + Math.max(0, t - 0.85) * 0.3;
    const s = Math.min(1, t * 1.4);
    puff((rand() - 0.5) * w * 1.2, el, w * between(0.55, 0.9), mix(SHADE.stemLowLit, SHADE.stemHighLit, s), mix(SHADE.stemLowShade, SHADE.stemHighShade, s), 0.9);
  }
  ctx.save();
  ctx.globalCompositeOperation = ADDITIVE;
  const core = ctx.createLinearGradient(0, py(0.05), 0, py(STEM_TOP));
  core.addColorStop(0, rgba(SHADE.fire, 0));
  core.addColorStop(1, rgba(SHADE.fire, 0.45));
  ctx.fillStyle = core;
  ctx.fillRect(px(-0.007), py(STEM_TOP), 0.014 * k, py(0.05) - py(STEM_TOP));
  ctx.restore();
  // The cap: billows over an ellipse, bottom first so the lit crown stands in front, then the torus's roll along its lower rim.
  const billows: { x: number; el: number; r: number; v: number }[] = [];
  for (let i = 0; i < 560; i++) {
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand());
    const x = Math.cos(a) * d * CAP.rx;
    const el = CAP.el + Math.sin(a) * d * CAP.ry;
    billows.push({ x, el, r: between(0.016, 0.04) * (1.15 - d * 0.5), v: (el - (CAP.el - CAP.ry)) / (2 * CAP.ry) });
  }
  billows.sort((p, q) => p.v - q.v);
  for (const b of billows) {
    const t = Math.min(1, Math.max(0, b.v * 1.3 - 0.15));
    puff(b.x, b.el, b.r, mix(SHADE.underLit, SHADE.crownLit, t), mix(SHADE.underShade, SHADE.crownShade, t), 0.92);
  }
  for (let i = 0; i < 140; i++) {
    const x = (rand() * 2 - 1) * CAP.rx * 0.95;
    const el = CAP.el - CAP.ry * (0.55 + 0.25 * Math.sqrt(1 - (x / CAP.rx) ** 2)) + between(-0.01, 0.01);
    puff(x, el, between(0.014, 0.026), SHADE.underLit, SHADE.underShade, 0.8);
  }
  // The fire still showing through the cap's underside.
  ctx.save();
  ctx.globalCompositeOperation = ADDITIVE;
  for (let i = 0; i < 50; i++) glow((rand() - 0.5) * CAP.rx * 0.9, CAP.el - CAP.ry * between(0.2, 0.7), between(0.01, 0.025), between(0.008, 0.016), SHADE.fire, 0.3);
  ctx.restore();
  // The ring's near half, in front of the stem.
  ring(0, Math.PI);
}
