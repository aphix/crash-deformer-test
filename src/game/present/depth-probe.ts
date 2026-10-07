import * as THREE from "three";

/** Distances (m) the probe bands the ground into, nearest first; the last band runs to the far plane. */
const BANDS = [5, 10, 20, 40, 80, 160, 320, 900] as const;
/** Slope offsets tried (pixels of the plane's own depth slope, `polygonOffsetFactor`): what `ground-stack.ts` lifts its painted layers by. */
const SLOPES = [0, 1 / 128, 1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1] as const;
/** Constant offsets tried (24-bit depth steps, `polygonOffsetUnits`), a doubling ladder: what ground layers were ordered by before. */
const STEPS = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048] as const;
/** Camera height over the plane (m), field of view (deg), planes: the race camera's. */
const HEIGHT = 2.4;
const FOV = 62;
const NEAR = 0.1;
const FAR = 900;

type OffsetNeeded = { u50: number | null; u95: number | null };
export type DepthProbe = {
  /** `gl.SUBPIXEL_BITS`: how finely the GPU says it places vertices on the screen (ANGLE reports 4 whatever the hardware does). */
  subpixelBits: number;
  /**
   * Per distance band: the offset a layer needs to show over a coplanar one on 50 % / 95 % of its pixels, as a share of a pixel
   * of its depth slope and as depth steps; null if the ladder's top is not enough.
   */
  bands: { from: number; to: number; slope: OffsetNeeded; steps: OffsetNeeded }[];
};

/**
 * The offset at which `shares` (the share of pixels showing the later layer, per offset in `offsets`, rising) first reaches
 * `target`, interpolated between the two offsets around it; null when it never does.
 */
export function crossing(offsets: readonly number[], shares: readonly number[], target: number): number | null {
  for (let i = 0; i < shares.length; i++) {
    if (shares[i]! < target) continue;
    if (i === 0) return offsets[0]!;
    const s0 = shares[i - 1]!;
    const t = shares[i]! > s0 ? (target - s0) / (shares[i]! - s0) : 1;
    return offsets[i - 1]! + (offsets[i]! - offsets[i - 1]!) * t;
  }
  return null;
}

/** The band (index into `BANDS`) of ground at view distance `z`, -1 outside them. */
export function bandOf(z: number): number {
  if (z < BANDS[0] || z >= BANDS[BANDS.length - 1]!) return -1;
  return BANDS.findIndex((b, i) => z >= b && z < BANDS[i + 1]!);
}

/** View distance (m) of the flat ground seen through the row `y` (from the bottom) of a `rows`-row view from `HEIGHT` up looking level; Infinity at or above the horizon. */
export function rowDistance(y: number, rows: number): number {
  const ndc = (2 * y + 1) / rows - 1;
  return ndc >= 0 ? Infinity : HEIGHT / (-ndc * Math.tan((FOV * Math.PI) / 360));
}

/**
 * The probe's vertex shader; `snap` > 0 rounds every vertex in front of the camera to 1/2^snap px first, to check the probe on a GPU
 * that rounds finely. A vertex behind the camera (w ≤ 0) has no screen position to round: the clipper cuts its triangle at the near
 * plane, so it is left as it is.
 */
const vertex = (snap: number, w: number, h: number) => /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  ${
    snap > 0
      ? `if (gl_Position.w > 0.0) {
    vec2 res = vec2(${w.toFixed(1)}, ${h.toFixed(1)});
    vec2 px = gl_Position.xy / gl_Position.w * 0.5 * res;
    px = floor(px * ${(2 ** snap).toFixed(1)} + 0.5) / ${(2 ** snap).toFixed(1)};
    gl_Position.xy = px / (0.5 * res) * gl_Position.w;
  }`
      : ""
  }
}`;
const FRAG = /* glsl */ `
uniform vec3 uColor;
void main() { gl_FragColor = vec4(uColor, 1.0); }`;

const plane = (cols: number, rows: number) => new THREE.PlaneGeometry(600, 1000, cols, rows).rotateX(-Math.PI / 2).translate(0, 0, -500);

/**
 * Measure, on this device and this drawing buffer, how far a ground layer has to be offset toward the camera to show over a coplanar
 * one, by distance: two flat planes on one height, triangulated differently, seen as the race camera sees ground. The offset is tried
 * as a share of a pixel of the plane's depth slope (what `ground-stack.ts` lifts its painted layers by) and as constant depth steps
 * (what the ground was ordered by before). The share of pixels showing the later plane rises from about half to all as the offset
 * passes the raster noise, so the offset for 95 % is the noise. Draws into the drawing buffer (the loop must be stopped; the next
 * frame draws over it) and restores the renderer's state.
 */
export function probeDepth(renderer: THREE.WebGLRenderer, snapBits = 0): DepthProbe {
  const gl = renderer.getContext();
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const w = size.x;
  const h = size.y;
  const rows = Math.floor(h / 2);
  const camera = new THREE.PerspectiveCamera(FOV, w / h, NEAR, FAR);
  camera.position.set(0, HEIGHT, 0);
  camera.lookAt(0, HEIGHT, -1);
  camera.updateMatrixWorld(true);
  const make = (c: number, strict: boolean) =>
    new THREE.ShaderMaterial({
      vertexShader: vertex(snapBits, w, h),
      fragmentShader: FRAG,
      uniforms: { uColor: { value: new THREE.Color(c) } },
      depthFunc: strict ? THREE.LessDepth : THREE.LessEqualDepth,
    });
  const under = make(0xff0000, false);
  const over = make(0x00ff00, true);
  over.polygonOffset = true;
  const scene = new THREE.Scene();
  // Rows every 4 m and every 5 m, like a road's sections: every band holds many vertices of each, so their rounding is not one shared error.
  const a = new THREE.Mesh(plane(60, 250), under);
  const b = new THREE.Mesh(plane(47, 199), over);
  a.frustumCulled = false;
  b.frustumCulled = false;
  b.renderOrder = 1;
  scene.add(a, b);

  const saved = { target: renderer.getRenderTarget(), auto: renderer.autoClear, tone: renderer.toneMapping, alpha: renderer.getClearAlpha(), clear: renderer.getClearColor(new THREE.Color()) };
  renderer.setRenderTarget(null);
  renderer.autoClear = true;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setClearColor(0x000000, 1);
  const buf = new Uint8Array(w * rows * 4);
  const band = new Int8Array(rows);
  for (let y = 0; y < rows; y++) band[y] = bandOf(rowDistance(y, h));
  const nBands = BANDS.length - 1;
  /** Per band, per offset of `ladder`: the share of the band's pixels showing the later plane. */
  const curves = (ladder: readonly number[], bySlope: boolean): number[][] => {
    const out = Array.from({ length: nBands }, () => new Array<number>(ladder.length).fill(0));
    for (let o = 0; o < ladder.length; o++) {
      over.polygonOffsetFactor = bySlope ? -ladder[o]! : 0;
      over.polygonOffsetUnits = bySlope ? 0 : -ladder[o]!;
      renderer.render(scene, camera);
      gl.readPixels(0, 0, w, rows, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const later = new Array<number>(nBands).fill(0);
      const all = new Array<number>(nBands).fill(0);
      for (let y = 0; y < rows; y++) {
        const k = band[y]!;
        if (k < 0) continue;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (buf[i + 1]! > 127) later[k]!++;
          if (buf[i + 1]! > 127 || buf[i]! > 127) all[k]!++;
        }
      }
      for (let k = 0; k < nBands; k++) out[k]![o] = all[k]! > 0 ? later[k]! / all[k]! : 0;
    }
    return out;
  };
  const slope = curves(SLOPES, true);
  const steps = curves(STEPS, false);

  renderer.setRenderTarget(saved.target);
  renderer.autoClear = saved.auto;
  renderer.toneMapping = saved.tone;
  renderer.setClearColor(saved.clear, saved.alpha);
  a.geometry.dispose();
  b.geometry.dispose();
  under.dispose();
  over.dispose();

  const need = (ladder: readonly number[], s: number[]): OffsetNeeded => ({ u50: crossing(ladder, s, 0.5), u95: crossing(ladder, s, 0.95) });
  return {
    subpixelBits: gl.getParameter(gl.SUBPIXEL_BITS) as number,
    bands: BANDS.slice(0, -1).map((from, k) => ({ from, to: BANDS[k + 1]!, slope: need(SLOPES, slope[k]!), steps: need(STEPS, steps[k]!) })),
  };
}

/** The probe for the bench card: the worst band's offset for 95 % of a coplanar layer's pixels, both ways. */
export function describeDepthProbe(p: DepthProbe): string {
  let slope: number | null = 0;
  let steps: number | null = 0;
  for (const b of p.bands) {
    slope = slope === null || b.slope.u95 === null ? null : Math.max(slope, b.slope.u95);
    steps = steps === null || b.steps.u95 === null ? null : Math.max(steps, b.steps.u95);
  }
  const px = slope === null ? `over ${SLOPES[SLOPES.length - 1]} px` : `${slope.toFixed(3)} px`;
  const st = steps === null ? `over ${STEPS[STEPS.length - 1]}` : String(Math.round(steps));
  return `coplanar layer shows at ${px} of slope or ${st} steps`;
}
