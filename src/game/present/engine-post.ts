import * as THREE from "three";
import { blueNoiseTexture } from "./blue-noise.ts";

/**
 * Cinematic FX quality, cheapest first. `off` and `minimal` render straight to the canvas (no post chain);
 * `minimal` keeps the director's camera moves, tyre marks and smoke, `off` drops those too; `low` / `high`
 * add the post chain. `ultra` runs the `high` chain over the Ultra scene look (`present/ultra/`): a manual pick only, never Auto's.
 */
export type FxTier = "off" | "minimal" | "low" | "high" | "ultra";
export const FX_TIERS: readonly FxTier[] = ["off", "minimal", "low", "high", "ultra"];
type PostTier = Exclude<FxTier, "off" | "minimal">;

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Dual-filter (Kawase) downsample; the first pass also keeps only what is brighter than the soft threshold. */
const DOWN = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
vec3 tap(vec2 uv) {
  vec3 c = min(texture2D(tSrc, uv).rgb, vec3(24.0));
#ifdef PREFILTER
  float br = max(c.r, max(c.g, c.b));
  // Narrow knee: nothing under 1.44 blooms, so capped car paint (≤ 1.1, car-mesh.ts) never feeds it.
  float knee = uThreshold * 0.1;
  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee + 1e-4);
  c *= max(soft, br - uThreshold) / max(br, 1e-4);
#endif
  return c;
}
void main() {
  vec2 o = uTexel;
  vec3 s = tap(vUv) * 4.0;
  s += tap(vUv - o);
  s += tap(vUv + o);
  s += tap(vUv + vec2(o.x, -o.y));
  s += tap(vUv - vec2(o.x, -o.y));
  gl_FragColor = vec4(s * 0.125, 1.0);
}`;

/** Dual-filter tent upsample, added onto the next larger mip. */
const UP = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uScatter;
varying vec2 vUv;
void main() {
  vec2 o = uTexel;
  vec3 s = texture2D(tSrc, vUv + vec2(-2.0 * o.x, 0.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(2.0 * o.x, 0.0)).rgb;
  s += texture2D(tSrc, vUv + vec2(0.0, -2.0 * o.y)).rgb;
  s += texture2D(tSrc, vUv + vec2(0.0, 2.0 * o.y)).rgb;
  s += texture2D(tSrc, vUv + vec2(-o.x, o.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(o.x, o.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(o.x, -o.y)).rgb * 2.0;
  s += texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
  gl_FragColor = vec4(s * (uScatter / 12.0), 1.0);
}`;

/**
 * One full-screen pass: radial blur (boost), chromatic punch (impacts), bloom, flash, the renderer's own
 * tone mapping, a light split-tone grade, vignette, then sRGB and display-space grain.
 */
const COMPOSITE = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform float uBloom;
uniform float uFlash;
uniform float uPunch;
uniform float uRadial;
uniform vec2 uCenter;
uniform float uGrain;
uniform float uPhase;
uniform sampler2D tNoise;
uniform float uVignette;
uniform float uSat;
uniform float uContrast;
uniform float uLetterbox;
uniform float uCel;
varying vec2 vUv;
float celL(vec2 p) {
  float l = dot(texture2D(tScene, p).rgb, vec3(0.2126, 0.7152, 0.0722));
  return l / (1.0 + l);
}
void main() {
  vec2 uv = vUv;
  vec3 c = texture2D(tScene, uv).rgb;
#ifdef RADIAL
  if (uRadial > 0.001) {
    vec2 d = (uv - uCenter) * uRadial;
    for (int i = 1; i < 8; i++) c += texture2D(tScene, uv - d * (float(i) / 7.0)).rgb;
    c *= 0.125;
  }
#endif
  if (uPunch > 0.001) {
    vec2 o = (uv - 0.5) * uPunch * 0.02;
    c.r = texture2D(tScene, uv + o).r;
    c.b = texture2D(tScene, uv - o).b;
  }
#ifdef BLOOM
  c += texture2D(tBloom, uv).rgb * uBloom;
#endif
  gl_FragColor = vec4(c * (1.0 + uFlash), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Grade in display space: saturation, warm highlights / cool shadows, an end-preserving S-curve.
  vec3 g = gl_FragColor.rgb;
  float l = dot(g, vec3(0.2126, 0.7152, 0.0722));
  g = mix(vec3(l), g, uSat);
  g *= mix(vec3(0.96, 0.99, 1.05), vec3(1.04, 1.0, 0.95), smoothstep(0.15, 0.7, l));
  g = clamp(g, 0.0, 1.0);
  g = mix(g, g * g * (3.0 - 2.0 * g), uContrast);
  if (uCel > 0.001) {
    // Scene-switch cel look: lit bands of the display colour plus dark Sobel outlines on the scene's luminance.
    vec2 px = 1.0 / vec2(textureSize(tScene, 0));
    float tl = celL(uv + px * vec2(-1.0, 1.0)), tm = celL(uv + px * vec2(0.0, 1.0)), tr = celL(uv + px);
    float ml = celL(uv + px * vec2(-1.0, 0.0)), mr = celL(uv + px * vec2(1.0, 0.0));
    float bl = celL(uv - px), bm = celL(uv - px * vec2(0.0, 1.0)), br = celL(uv + px * vec2(1.0, -1.0));
    float edge = smoothstep(0.09, 0.3, length(vec2(tr + 2.0 * mr + br - tl - 2.0 * ml - bl, tl + 2.0 * tm + tr - bl - 2.0 * bm - br)));
    float lc = dot(g, vec3(0.2126, 0.7152, 0.0722));
    vec3 cel = clamp(g * (floor(lc * 5.0 + 0.5) / 5.0 / max(lc, 0.02)), 0.0, 1.0);
    cel = mix(vec3(dot(cel, vec3(0.2126, 0.7152, 0.0722))), cel, 1.25) * (1.0 - 0.9 * edge);
    g = mix(g, cel, uCel);
  }
  vec2 q = uv - 0.5;
  g *= clamp(1.0 - dot(q, q) * (uVignette + uPunch * 0.9), 0.0, 1.0);
  g *= 1.0 - step(0.5 - uLetterbox * 0.128, abs(q.y));
  // Blue-noise dither / grain: the shared 64x64 table, rotated by the golden ratio each frame so it stays blue in space and decorrelates in time.
  float n = fract(texelFetch(tNoise, ivec2(gl_FragCoord.xy) & 63, 0).r + 0.5 / 255.0 + uPhase);
  gl_FragColor.rgb = g + (n - 0.5) * uGrain;
}`;

/**
 * Bloom runs over `mips` targets of the shared chain starting at `mip0` (the chain halves from ½ canvas res).
 * `grain` is the blue-noise amplitude (display units, peak to peak): one 8-bit step dithers away banding, the high tier adds visible film grain.
 */
type TierSpec = { mip0: number; mips: number; radial: boolean; grain: number };
const DITHER = 1 / 255;
/** The per-frame step of the noise's phase: the golden ratio's fraction, which never repeats and spreads the offsets evenly. */
const GOLDEN = 0.6180339887;
const TIER: Record<PostTier, TierSpec> = {
  low: { mip0: 1, mips: 3, radial: false, grain: DITHER },
  high: { mip0: 0, mips: 5, radial: true, grain: 0.03 },
  ultra: { mip0: 0, mips: 5, radial: true, grain: 0.03 },
};
/** Length of the shared bloom chain: ½, ¼, ⅛, 1/16, 1/32 of the canvas. */
const CHAIN = 5;

/** What a tier runs, for the bench page's card: the passes of `PostFX.render` and the numbers from `TIER`. */
export function describePost(tier: FxTier): string {
  if (tier === "off" || tier === "minimal") return "none: the scene draws straight to the canvas (no HDR target, bloom, grade, vignette or grain)";
  const s = TIER[tier];
  const radial = s.radial ? ", radial blur" : "";
  const grain = s.grain >= DITHER * 2 ? `, grain ${s.grain} (blue noise)` : ", blue-noise dither";
  const chain = `HDR half-float scene target, bloom (${s.mips} mips from 1/${2 ** (s.mip0 + 1)} res, threshold ${GRADE.threshold}, ${GRADE.bloom} strength), one composite pass: tone map, grade, vignette${radial}${grain}`;
  return tier === "ultra" ? `${chain}; ultra look: HDRI daylight lighting, soft sun shadows, PBR ground textures` : chain;
}

/** Look shared by both post tiers (tuned against the studio env at exposure 1.45). `contrast` is the S-curve mix. */
const GRADE = { bloom: 0.45, threshold: 1.6, scatter: 0.8, vignette: 0.55, saturation: 1.12, contrast: 0.22 };

const _size = new THREE.Vector2();

/** One clip-space triangle covering the screen (three's `FullScreenQuad`, kept as a plain mesh so it can be precompiled). */
function fullScreenTriangle(): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  const mesh = new THREE.Mesh(geo);
  mesh.frustumCulled = false;
  return mesh;
}
const QUAD_CAMERA = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/**
 * Post chain behind one `render(scene, camera)` call. The scene renders linear HDR into a half-float target
 * (MSAA when the canvas had it), bloom is a dual-filter mip chain, and one composite pass writes the canvas.
 * `flash` / `punch` / `radial` are per-frame drive values the director (`engine-cine.ts`) sets.
 * Targets are allocated once and only resized with the canvas, and each tier has its own composite, so a tier
 * switch allocates and compiles nothing.
 */
export class PostFX {
  /** 0–1+: exposure lift for a hit flash. */
  flash = 0;
  /** 0–1: chromatic split and vignette squeeze. */
  punch = 0;
  /** 0–0.06: radial blur length toward `center` (high tier only). */
  radial = 0;
  readonly center = new THREE.Vector2(0.5, 0.5);
  /** 0–1: 2.39:1 letterbox bars for the crash cam. */
  letterbox = 0;
  /** 0–1: scene-switch cel look (posterized bands, Sobel outlines), low / high tiers only (`scene-fade.ts`). */
  cel = 0;
  private tierNow: FxTier = "off";
  private readonly renderer: THREE.WebGLRenderer;
  /** The low / high tiers' HDR scene target (the warm-up draws into it once). */
  readonly sceneRT: THREE.WebGLRenderTarget;
  private readonly mips: THREE.WebGLRenderTarget[] = [];
  private readonly quad = fullScreenTriangle();
  private readonly down: THREE.ShaderMaterial;
  private readonly downPre: THREE.ShaderMaterial;
  private readonly up: THREE.ShaderMaterial;
  private readonly composites: Record<PostTier, THREE.ShaderMaterial>;
  private width = 1;
  private height = 1;

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const blit = (frag: string, extra: Record<string, THREE.IUniform>, defines: Record<string, string> = {}) =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: frag,
        uniforms: { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, ...extra },
        defines,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
    this.down = blit(DOWN, { uThreshold: { value: GRADE.threshold } });
    this.downPre = blit(DOWN, { uThreshold: { value: GRADE.threshold } }, { PREFILTER: "" });
    this.up = blit(UP, { uScatter: { value: GRADE.scatter } });
    this.up.blending = THREE.AdditiveBlending;
    this.up.transparent = true;
    const composite = (spec: TierSpec) =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: COMPOSITE,
        uniforms: {
          tScene: { value: null },
          tBloom: { value: null },
          uBloom: { value: GRADE.bloom },
          uFlash: { value: 0 },
          uPunch: { value: 0 },
          uRadial: { value: 0 },
          uCenter: { value: this.center },
          uGrain: { value: spec.grain },
          uPhase: { value: 0 },
          tNoise: { value: blueNoiseTexture() },
          uVignette: { value: GRADE.vignette },
          uSat: { value: GRADE.saturation },
          uContrast: { value: GRADE.contrast },
          uLetterbox: { value: 0 },
          uCel: { value: 0 },
        },
        defines: spec.radial ? { BLOOM: "", RADIAL: "" } : { BLOOM: "" },
        depthTest: false,
        depthWrite: false,
      });
    // Ultra's chain is the high chain: one material, so no extra program.
    const high = composite(TIER.high);
    this.composites = { low: composite(TIER.low), high, ultra: high };
    // Match the canvas: the renderer asked for MSAA only at a device pixel ratio of 1.
    const samples = renderer.getContextAttributes()?.antialias ? 4 : 0;
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples, depthBuffer: true, stencilBuffer: false });
    for (let i = 0; i < CHAIN; i++) {
      this.mips.push(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false }));
    }
  }

  get tier(): FxTier {
    return this.tierNow;
  }

  setTier(tier: FxTier): void {
    this.tierNow = tier;
  }

  /** Follow the renderer's drawing-buffer size (canvas size × pixel ratio). */
  setSize(): void {
    this.renderer.getDrawingBufferSize(_size);
    this.width = Math.max(1, _size.x);
    this.height = Math.max(1, _size.y);
    this.sceneRT.setSize(this.width, this.height);
    let w = this.width;
    let h = this.height;
    for (const m of this.mips) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      m.setSize(w, h);
    }
  }

  /**
   * Link every program the chain can draw (async where the driver allows) so a tier switch never compiles:
   * `scene` for both outputs (this HDR target at low / high, the canvas at off), each pass, each tier's
   * composite. `offscreen` scenes draw into other render targets (the mark map), which share the HDR programs.
   */
  warm(scene: THREE.Scene, camera: THREE.Camera, offscreen: readonly (readonly [THREE.Object3D, THREE.Camera])[]): Promise<unknown> {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const jobs: Promise<unknown>[] = [];
    r.setRenderTarget(this.sceneRT);
    jobs.push(r.compileAsync(scene, camera));
    for (const [root, cam] of offscreen) jobs.push(r.compileAsync(root, cam));
    for (const m of [this.down, this.downPre, this.up]) jobs.push(this.compilePass(m));
    r.setRenderTarget(null);
    jobs.push(r.compileAsync(scene, camera));
    for (const m of Object.values(this.composites)) jobs.push(this.compilePass(m));
    r.setRenderTarget(prev);
    return Promise.all(jobs);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    if (this.tierNow === "off" || this.tierNow === "minimal") {
      r.render(scene, camera);
      return;
    }
    const spec = TIER[this.tierNow];
    // Several render() calls make up one frame: keep renderer.info a whole-frame count.
    r.info.autoReset = false;
    r.info.reset();
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    const mips = this.mips;
    const end = spec.mip0 + spec.mips;
    let src: THREE.Texture = this.sceneRT.texture;
    let sw = this.width;
    let sh = this.height;
    for (let i = spec.mip0; i < end; i++) {
      const m = i === spec.mip0 ? this.downPre : this.down;
      m.uniforms.tSrc!.value = src;
      (m.uniforms.uTexel!.value as THREE.Vector2).set(1 / sw, 1 / sh);
      this.blit(m, mips[i]!);
      src = mips[i]!.texture;
      sw = mips[i]!.width;
      sh = mips[i]!.height;
    }
    const ac = r.autoClear;
    r.autoClear = false;
    for (let i = end - 1; i > spec.mip0; i--) {
      this.up.uniforms.tSrc!.value = mips[i]!.texture;
      (this.up.uniforms.uTexel!.value as THREE.Vector2).set(1 / mips[i]!.width, 1 / mips[i]!.height);
      this.blit(this.up, mips[i - 1]!);
    }
    r.autoClear = ac;

    const composite = this.composites[this.tierNow];
    const u = composite.uniforms;
    u.tScene!.value = this.sceneRT.texture;
    u.tBloom!.value = mips[spec.mip0]!.texture;
    u.uFlash!.value = this.flash;
    u.uPunch!.value = this.punch;
    u.uRadial!.value = this.radial;
    u.uLetterbox!.value = this.letterbox;
    u.uCel!.value = this.cel;
    u.uPhase!.value = (u.uPhase!.value as number + GOLDEN) % 1;
    this.blit(composite, null);
    r.info.autoReset = true;
  }

  dispose(): void {
    this.sceneRT.dispose();
    for (const m of this.mips) m.dispose();
    this.quad.geometry.dispose();
    this.down.dispose();
    this.downPre.dispose();
    this.up.dispose();
    this.composites.low.dispose();
    this.composites.high.dispose();
  }

  private compilePass(material: THREE.ShaderMaterial): Promise<unknown> {
    this.quad.material = material;
    return this.renderer.compileAsync(this.quad, QUAD_CAMERA);
  }

  private blit(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quad, QUAD_CAMERA);
  }
}
