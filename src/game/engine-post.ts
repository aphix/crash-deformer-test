import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";

/** Cinematic FX quality: `off` renders straight to the canvas exactly as before; `low` / `high` add the post chain. */
export type FxTier = "off" | "low" | "high";
export const FX_TIERS: readonly FxTier[] = ["off", "low", "high"];

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
  float knee = uThreshold * 0.5;
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
uniform float uSeed;
uniform float uVignette;
uniform float uSat;
uniform float uContrast;
uniform float uLetterbox;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
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
  vec2 q = uv - 0.5;
  g *= clamp(1.0 - dot(q, q) * (uVignette + uPunch * 0.9), 0.0, 1.0);
  g *= 1.0 - step(0.5 - uLetterbox * 0.128, abs(q.y));
  gl_FragColor.rgb = g + (hash(gl_FragCoord.xy + uSeed) - 0.5) * uGrain;
}`;

type TierSpec = { bloomMips: number; bloomDiv: number; radial: boolean; grain: number };
const TIER: Record<Exclude<FxTier, "off">, TierSpec> = {
  low: { bloomMips: 3, bloomDiv: 4, radial: false, grain: 0 },
  high: { bloomMips: 5, bloomDiv: 2, radial: true, grain: 0.03 },
};

/** Look shared by both post tiers (tuned against the studio env at exposure 1.45). `contrast` is the S-curve mix. */
export const GRADE = { bloom: 0.45, threshold: 1.6, scatter: 0.8, vignette: 0.55, saturation: 1.12, contrast: 0.22 };

const _size = new THREE.Vector2();

/**
 * Post chain behind one `render(scene, camera)` call. The scene renders linear HDR into a half-float target
 * (MSAA when the canvas had it), bloom is a dual-filter mip chain, and one composite pass writes the canvas.
 * `flash` / `punch` / `radial` are per-frame drive values the director (`engine-cine.ts`) sets.
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
  private tierNow: FxTier = "off";
  private readonly renderer: THREE.WebGLRenderer;
  private sceneRT: THREE.WebGLRenderTarget | null = null;
  private mips: THREE.WebGLRenderTarget[] = [];
  private readonly quad = new FullScreenQuad();
  private readonly down: THREE.ShaderMaterial;
  private readonly downPre: THREE.ShaderMaterial;
  private readonly up: THREE.ShaderMaterial;
  private readonly composite: THREE.ShaderMaterial;
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
    this.composite = new THREE.ShaderMaterial({
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
        uGrain: { value: 0 },
        uSeed: { value: 0 },
        uVignette: { value: GRADE.vignette },
        uSat: { value: GRADE.saturation },
        uContrast: { value: GRADE.contrast },
        uLetterbox: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
  }

  get tier(): FxTier {
    return this.tierNow;
  }

  setTier(tier: FxTier): void {
    if (tier === this.tierNow) return;
    this.tierNow = tier;
    this.release();
    if (tier === "off") return;
    const spec = TIER[tier];
    const defines: Record<string, string> = { BLOOM: "" };
    if (spec.radial) defines.RADIAL = "";
    this.composite.defines = defines;
    this.composite.needsUpdate = true;
    this.composite.uniforms.uGrain!.value = spec.grain;
    this.allocate();
  }

  /** Follow the renderer's drawing-buffer size (canvas size × pixel ratio). */
  setSize(): void {
    this.renderer.getDrawingBufferSize(_size);
    this.width = Math.max(1, _size.x);
    this.height = Math.max(1, _size.y);
    if (this.tierNow === "off") return;
    this.release();
    this.allocate();
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    if (this.tierNow === "off" || !this.sceneRT) {
      r.render(scene, camera);
      return;
    }
    // Several render() calls make up one frame: keep renderer.info a whole-frame count.
    r.info.autoReset = false;
    r.info.reset();
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);

    const mips = this.mips;
    let src: THREE.Texture = this.sceneRT.texture;
    let sw = this.width;
    let sh = this.height;
    for (let i = 0; i < mips.length; i++) {
      const m = i === 0 ? this.downPre : this.down;
      m.uniforms.tSrc!.value = src;
      (m.uniforms.uTexel!.value as THREE.Vector2).set(1 / sw, 1 / sh);
      this.blit(m, mips[i]!);
      src = mips[i]!.texture;
      sw = mips[i]!.width;
      sh = mips[i]!.height;
    }
    const ac = r.autoClear;
    r.autoClear = false;
    for (let i = mips.length - 1; i > 0; i--) {
      this.up.uniforms.tSrc!.value = mips[i]!.texture;
      (this.up.uniforms.uTexel!.value as THREE.Vector2).set(1 / mips[i]!.width, 1 / mips[i]!.height);
      this.blit(this.up, mips[i - 1]!);
    }
    r.autoClear = ac;

    const u = this.composite.uniforms;
    u.tScene!.value = this.sceneRT.texture;
    u.tBloom!.value = mips[0]!.texture;
    u.uFlash!.value = this.flash;
    u.uPunch!.value = this.punch;
    u.uRadial!.value = this.radial;
    u.uLetterbox!.value = this.letterbox;
    u.uSeed!.value = (u.uSeed!.value as number) + 17.31;
    if ((u.uSeed!.value as number) > 1e4) u.uSeed!.value = 0;
    this.blit(this.composite, null);
    r.info.autoReset = true;
  }

  dispose(): void {
    this.release();
    this.quad.dispose();
    this.down.dispose();
    this.downPre.dispose();
    this.up.dispose();
    this.composite.dispose();
  }

  private blit(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.quad.render(this.renderer);
  }

  private allocate(): void {
    const spec = TIER[this.tierNow as Exclude<FxTier, "off">];
    // Match the canvas: the renderer asked for MSAA only at a device pixel ratio of 1.
    const samples = this.renderer.getContextAttributes()?.antialias ? 4 : 0;
    this.sceneRT = new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.HalfFloatType,
      samples,
      depthBuffer: true,
      stencilBuffer: false,
    });
    let w = this.width;
    let h = this.height;
    for (let i = 0; i < spec.bloomMips; i++) {
      const div = i === 0 ? spec.bloomDiv : 2;
      w = Math.max(1, Math.round(w / div));
      h = Math.max(1, Math.round(h / div));
      this.mips.push(
        new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false }),
      );
    }
  }

  private release(): void {
    this.sceneRT?.dispose();
    this.sceneRT = null;
    for (const m of this.mips) m.dispose();
    this.mips = [];
  }
}
