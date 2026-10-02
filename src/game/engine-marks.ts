import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import { activeGround } from "./ground.ts";
import type { SurfaceId } from "./race/catalog.ts";

/**
 * Tyre marks on the GPU. Every slipping wheel stamps one short quad per frame into ONE ground-aligned render
 * target (the mark map); ground materials sample it by world xz (`applyMarkMap`). Draw cost is constant
 * however many marks exist: no per-mark meshes, an empty frame renders nothing, and a slow subtractive fade
 * pass ages old marks out.
 *
 * Channels: R rubber (asphalt, concrete, cobble), G rut / scrape groove (dirt, gravel, sand, a bare hub),
 * B torn turf (grass).
 */

/** Surface id → mark channel (0 rubber, 1 rut, 2 turf); the rest leave rubber. Read from `activeGround()`. */
const CHANNEL: Partial<Record<SurfaceId, number>> = { dirt: 1, gravel: 1, sand: 1, grass: 2 };

/** Sandbox mark rect: the 48 m ground disc. */
const SANDBOX = { minX: -48, minZ: -48, maxX: 48, maxZ: 48 } as const;

const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1);
blank.needsUpdate = true;

/** Shared by every material `applyMarkMap` patches; `uMarkRect` = (minX, minZ, 1/sizeX, 1/sizeZ). */
export const markMapUniforms = {
  uMarkMap: { value: blank as THREE.Texture },
  uMarkRect: {
    value: new THREE.Vector4(SANDBOX.minX, SANDBOX.minZ, 1 / (SANDBOX.maxX - SANDBOX.minX), 1 / (SANDBOX.maxZ - SANDBOX.minZ)),
  },
};

let boundsEpoch = 0;

/** Re-target the mark map to a world rect (a race track's bounds) and wipe it. */
export function setMarkBounds(minX: number, minZ: number, maxX: number, maxZ: number): void {
  markMapUniforms.uMarkRect.value.set(minX, minZ, 1 / Math.max(1e-3, maxX - minX), 1 / Math.max(1e-3, maxZ - minZ));
  boundsEpoch++;
}

/** Patch a ground / road MeshStandardMaterial to darken by the mark map, sampled at its world xz. */
export function applyMarkMap(material: THREE.MeshStandardMaterial): void {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    shader.uniforms.uMarkMap = markMapUniforms.uMarkMap;
    shader.uniforms.uMarkRect = markMapUniforms.uMarkRect;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec2 vMarkXZ;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvMarkXZ = (modelMatrix * vec4(transformed, 1.0)).xz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform sampler2D uMarkMap;\nuniform vec4 uMarkRect;\nvarying vec2 vMarkXZ;")
      .replace(
        "#include <map_fragment>",
        /* glsl */ `#include <map_fragment>
vec2 markUv = (vMarkXZ - uMarkRect.xy) * uMarkRect.zw;
vec4 markS = texture2D(uMarkMap, markUv) * (step(0.0, markUv.x) * step(markUv.x, 1.0) * step(0.0, markUv.y) * step(markUv.y, 1.0));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.004, 0.004, 0.005), markS.r * 0.95);
diffuseColor.rgb *= 1.0 - markS.g * 0.55;
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.075, 0.05, 0.028), markS.b * 0.85);`,
      )
      // The asphalt reads grey mostly from grazing env specular: rubber and ruts must kill it too.
      .replace(
        "#include <lights_fragment_end>",
        /* glsl */ `#include <lights_fragment_end>
float markDark = clamp(markS.r * 0.92 + markS.g * 0.5 + markS.b * 0.4, 0.0, 1.0);
reflectedLight.indirectSpecular *= 1.0 - markDark;
reflectedLight.directSpecular *= 1.0 - markDark * 0.8;
reflectedLight.indirectDiffuse *= 1.0 - markDark * 0.5;`,
      );
  };
  material.customProgramCacheKey = () => `${prevKey.call(material)}|marks`;
  material.needsUpdate = true;
}

const STAMP_VERT = /* glsl */ `
attribute vec4 aInk;
uniform vec4 uRect;
varying vec4 vInk;
varying float vEdge;
void main() {
  vInk = aInk;
  vEdge = position.z;
  gl_Position = vec4((position.xy - uRect.xy) * uRect.zw * 2.0 - 1.0, 0.0, 1.0);
}`;

const STAMP_FRAG = /* glsl */ `
varying vec4 vInk;
varying float vEdge;
void main() {
  gl_FragColor = vInk * (1.0 - smoothstep(0.45, 1.0, abs(vEdge)));
}`;

/** Wheel order matches `car.wheels` / `WHEEL_POS`: FL, FR, RL, RR. */
const HUBS = ["hubFL", "hubFR", "hubRL", "hubRR"] as const;
const WHEEL_R = 0.32;
const TYRE_W = 0.24;
const GROOVE_W = 0.07;
/** Rear-wheel sideways speed (m/s) where a slide starts to mark, at grip 1; a full-lock arcade turn stays under it. */
const SLIDE_START = 2.3;
const SLIDE_FULL = 4.5;
/** Handling's `drive.slide` counts any sideways creep; marks start at a real slide and are full at a drift. */
const DRIVE_SLIDE_START = 0.25;
const DRIVE_SLIDE_FULL = 0.8;
/** Subtract one 8-bit step from the whole map this often (s): a full-black mark is gone in ~2.5 min. */
const FADE_EVERY = 0.6;

export type WheelFx = {
  /** 0–1 slip this frame per wheel slot (car index × 4 + wheel). */
  readonly slip: Float32Array;
  /** 1 when a bare hub scrapes the ground this frame. */
  readonly scrape: Uint8Array;
  /** Surface channel under the wheel (0 rubber, 1 rut, 2 turf). */
  readonly channel: Uint8Array;
  /** Wheel contact (x, z) and velocity (x, z) per slot. */
  readonly px: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vz: Float32Array;
};

const _q = new THREE.Vector3();
const _clear = new THREE.Color();

export class SkidMarks {
  /** Per-wheel results for smoke and sparks (`engine-cine.ts`). */
  readonly wheels: WheelFx;
  private rt: THREE.WebGLRenderTarget | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly geo = new THREE.BufferGeometry();
  private readonly pos: Float32Array;
  private readonly ink: Float32Array;
  private readonly stamp: THREE.Mesh;
  private readonly fade: THREE.Mesh;
  private readonly cap: number;
  private readonly hasPrev: Uint8Array;
  /** Per car: launch spin held and eased out, so a boost launch lays two tapering stripes, not a 1 m dab. */
  private readonly spinHold: Float32Array;
  private quads = 0;
  private fadeAcc = 0;
  private needsClear = true;
  private epoch = -1;
  private any = false;

  constructor(maxCars: number) {
    const slots = maxCars * 4;
    this.cap = slots;
    this.wheels = {
      slip: new Float32Array(slots),
      scrape: new Uint8Array(slots),
      channel: new Uint8Array(slots),
      px: new Float32Array(slots),
      pz: new Float32Array(slots),
      vx: new Float32Array(slots),
      vz: new Float32Array(slots),
    };
    this.hasPrev = new Uint8Array(slots);
    this.spinHold = new Float32Array(maxCars);
    this.pos = new Float32Array(slots * 4 * 3);
    this.ink = new Float32Array(slots * 4 * 4);
    const index = new Uint16Array(slots * 6);
    for (let i = 0; i < slots; i++) index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    this.geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute("aInk", new THREE.BufferAttribute(this.ink, 4).setUsage(THREE.DynamicDrawUsage));
    const additive = {
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      // Quad winding flips with travel direction in the map's xz → clip mapping.
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    } as const;
    this.stamp = new THREE.Mesh(
      this.geo,
      new THREE.ShaderMaterial({ vertexShader: STAMP_VERT, fragmentShader: STAMP_FRAG, uniforms: { uRect: markMapUniforms.uMarkRect }, ...additive }),
    );
    this.stamp.frustumCulled = false;
    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.fade = new THREE.Mesh(
      tri,
      new THREE.ShaderMaterial({
        vertexShader: "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }",
        fragmentShader: "void main() { gl_FragColor = vec4(1.0 / 255.0); }",
        ...additive,
        blendEquation: THREE.ReverseSubtractEquation,
      }),
    );
    this.fade.frustumCulled = false;
    this.scene.add(this.stamp, this.fade);
  }

  /** Map edge in texels (0 = no map: the off tier). Allocates or frees the target and wipes it. */
  setResolution(size: number): void {
    this.rt?.dispose();
    this.rt = null;
    markMapUniforms.uMarkMap.value = blank;
    if (size <= 0) return;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.rt.texture.anisotropy = 8;
    markMapUniforms.uMarkMap.value = this.rt.texture;
    this.clear();
  }

  /** Wipe every mark (scene reset) and forget wheel history so nothing stamps across the teleport. */
  clear(): void {
    this.needsClear = true;
    this.hasPrev.fill(0);
    this.spinHold.fill(0);
    this.wheels.slip.fill(0);
    this.wheels.scrape.fill(0);
    this.any = false;
  }

  /**
   * Read every live car's wheels (state only) and queue this frame's stamps. Per wheel still on its hub:
   * Handling's `car.drive` slip (launch `spin` on the rear, brake `lock` on all four, `slide` for drifts and
   * handbrake turns) plus the rear wheels' own sideways speed (wrecks sliding with no driver). A wheel off
   * its hub marks nothing; the bare hub scraping low leaves a groove. Slide thresholds scale with grip.
   */
  update(cars: readonly DeformableCar[], simDt: number): void {
    const w = this.wheels;
    const ground = activeGround();
    this.quads = 0;
    if (simDt <= 1e-5) return;
    const n = Math.min(cars.length, this.cap / 4);
    let any = false;
    for (let c = 0; c < n; c++) {
      const car = cars[c]!;
      const v = car.velocity;
      const fx = car.fwdFlat.x;
      const fz = car.fwdFlat.z;
      const hadPrev = this.hasPrev[c * 4] === 1;
      const lock = car.drive.lock;
      // Launch spin eases out at 1.4/s after Handling's spin ends; a boost launch also spins the rears up to
      // ~14 m/s (a visual cheat: Handling's own spin is gone by 7 m/s), so it lays two long tapering stripes.
      const along = v.x * fx + v.z * fz;
      const launch = car.drive.boost && car.drive.throttle > 0.5 ? ramp(14 - along, 0, 6) : 0;
      const spin = (this.spinHold[c] = Math.max(car.drive.spin, launch, this.spinHold[c]! - simDt * 1.4));
      const bodySlide = ramp(car.drive.slide, DRIVE_SLIDE_START, DRIVE_SLIDE_FULL);
      for (let k = 0; k < 4; k++) {
        const s = c * 4 + k;
        if (!car.group.visible) {
          this.hasPrev[s] = 0;
          w.slip[s] = 0;
          continue;
        }
        // A popped hub's wheel may have left for the world (`dropWheel`): track the bare hub instead.
        const popped = car.deform.massActive && car.deform.hubPopped(HUBS[k]!);
        if (popped) _q.copy(car.deform.massWorld(HUBS[k]!));
        else _q.copy(car.wheels[k]!.position).applyQuaternion(car.group.quaternion).add(car.group.position);
        const x = _q.x;
        const z = _q.z;
        const vx = hadPrev ? (x - w.px[s]!) / simDt : 0;
        const vz = hadPrev ? (z - w.pz[s]!) / simDt : 0;
        const jump = vx * vx + vz * vz > 80 * 80;
        const grounded = _q.y - ground.heightAt(x, z) < WHEEL_R + 0.14;
        const grip = ground.frictionAt(x, z);
        const rear = k >= 2;
        let slip = 0;
        let scrape = 0;
        if (hadPrev && !jump && grounded && !popped) {
          const side = Math.abs(vx * fz - vz * fx);
          // Front tyres steer with the turn; only body sideslip (the hull's own velocity) slides them.
          const slide = Math.max(
            rear ? ramp(side, SLIDE_START * grip, SLIDE_FULL * grip) : ramp(Math.abs(v.x * fz - v.z * fx), SLIDE_START * grip, SLIDE_FULL * grip),
            rear ? bodySlide : bodySlide * 0.5,
          );
          slip = Math.max(slide, lock, rear ? spin : 0);
        } else if (hadPrev && !jump && popped && _q.y - ground.heightAt(x, z) < WHEEL_R * 0.75 && vx * vx + vz * vz > 2) {
          scrape = 1;
          slip = 0.9;
        }
        w.slip[s] = slip;
        w.scrape[s] = scrape;
        const ch = scrape ? 1 : (CHANNEL[ground.surfaceAt(x, z)] ?? 0);
        w.channel[s] = ch;
        if (slip > 0.04 && this.rt) this.queue(w.px[s]!, w.pz[s]!, x, z, scrape ? GROOVE_W : TYRE_W, ch, Math.min(1, slip * 0.9));
        if (slip > 0.04) any = true;
        w.px[s] = x;
        w.pz[s] = z;
        w.vx[s] = vx;
        w.vz[s] = vz;
        this.hasPrev[s] = jump ? 0 : 1;
      }
    }
    this.any = any;
  }

  /** True when any wheel slipped this frame (`wheels` holds the detail). */
  get slipping(): boolean {
    return this.any;
  }

  /** Draw this frame's stamps and the periodic fade into the map. Call once per frame before the main render. */
  flush(renderer: THREE.WebGLRenderer, wallDt: number): void {
    const rt = this.rt;
    if (!rt) return;
    if (this.epoch !== boundsEpoch) {
      this.epoch = boundsEpoch;
      this.needsClear = true;
    }
    this.fadeAcc += wallDt;
    const fade = this.fadeAcc >= FADE_EVERY;
    if (!this.needsClear && this.quads === 0 && !fade) return;
    const prevTarget = renderer.getRenderTarget();
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(rt);
    if (this.needsClear) {
      renderer.getClearColor(_clear);
      const alpha = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.setClearColor(_clear, alpha);
      this.needsClear = false;
    }
    this.stamp.visible = this.quads > 0;
    this.fade.visible = fade;
    if (fade) this.fadeAcc = 0;
    if (this.quads > 0) {
      this.geo.setDrawRange(0, this.quads * 6);
      (this.geo.attributes.position as THREE.BufferAttribute).addUpdateRange(0, this.quads * 12);
      (this.geo.attributes.aInk as THREE.BufferAttribute).addUpdateRange(0, this.quads * 16);
      this.geo.attributes.position!.needsUpdate = true;
      this.geo.attributes.aInk!.needsUpdate = true;
    }
    if (this.quads > 0 || fade) renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = ac;
    this.quads = 0;
  }

  dispose(): void {
    this.rt?.dispose();
    this.rt = null;
    markMapUniforms.uMarkMap.value = blank;
    this.geo.dispose();
    (this.stamp.material as THREE.Material).dispose();
    this.fade.geometry.dispose();
    (this.fade.material as THREE.Material).dispose();
  }

  /** One quad from the wheel's last contact to this one, `width` across, ink `a` in channel `ch`. */
  private queue(x0: number, z0: number, x1: number, z1: number, width: number, ch: number, a: number): void {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4 || this.quads >= this.cap) return;
    const nx = (-dz / len) * width * 0.5;
    const nz = (dx / len) * width * 0.5;
    const q = this.quads++;
    const p = this.pos;
    let o = q * 12;
    p[o++] = x0 - nx; p[o++] = z0 - nz; p[o++] = -1;
    p[o++] = x0 + nx; p[o++] = z0 + nz; p[o++] = 1;
    p[o++] = x1 + nx; p[o++] = z1 + nz; p[o++] = 1;
    p[o++] = x1 - nx; p[o++] = z1 - nz; p[o] = -1;
    const r = ch === 0 ? a : 0;
    const g = ch === 1 ? a : ch === 2 ? a * 0.3 : 0;
    const b = ch === 2 ? a : 0;
    for (let v = 0; v < 4; v++) this.ink.set([r, g, b, 0], q * 16 + v * 4);
  }
}

/** 0 below `a`, 1 above `b`, linear between. */
function ramp(x: number, a: number, b: number): number {
  return x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
}
