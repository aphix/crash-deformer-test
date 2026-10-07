import * as THREE from "three";
import { setSunBias } from "../engine-world.ts";
import { loadHdrEnv } from "../look-env.ts";
import { gainOf } from "../prefabs.ts";
import { surfaceOf, type SurfaceRole, type SurfaceTag } from "./surface-tag.ts";
import { envYaw, LOOK, SURFACE_METRES } from "./ultra-look.ts";
import type { UltraHost } from "./load.ts";

/**
 * Ultra's assets, all CC0 from Poly Haven (https://polyhaven.com/license), 1k, in `public/ultra/`:
 *  - sky.hdr: "Rural Asphalt Road" by Alexander Scholten, https://polyhaven.com/a/rural_asphalt_road. Radiance RGBE; the sun disc (peak
 *    luminance 87,000) clamped to 60, because the sun is the shadow-casting light: left in, the environment would light the shadowed side too.
 *  - asphalt-*: "Asphalt 01" by Dario Barresi and Charlotte Baglioni, https://polyhaven.com/a/asphalt_01
 *  - concrete-*: "Concrete Floor Worn 001" by Dimitrios Savva and Rico Cilliers, https://polyhaven.com/a/concrete_floor_worn_001
 *  - ground-*: "Gravelly Sand" by Dario Barresi, https://polyhaven.com/a/gravelly_sand
 * `-diff` is the diffuse colour, `-nor` the OpenGL normal map, `-arm` ambient occlusion (R), roughness (G), metalness (B); the 1k JPEGs
 * re-encoded as WebP (quality 80, normals 88).
 */
const BASE = import.meta.env.BASE_URL;
const SKY_URL = `${BASE}ultra/sky.hdr`;
const ROLES: readonly SurfaceRole[] = ["asphalt", "concrete", "ground"];
const MAX_ANISOTROPY = 8;
/** Edge (px) the diffuse is shrunk to for its mean colour. */
const MEAN_EDGE = 256;

/** One role's photographs and `1 / mean linear colour` of its diffuse (the gain `prefabs.ts` keeps for the procedural ones). */
type PbrSet = { diff: THREE.Texture; nor: THREE.Texture; arm: THREE.Texture; gain: THREE.Color };
/** A set tiled for one place: the same images, a repeat that makes a tile cover its real size where one UV unit spans `uvMetres`. */
type Tiling = { diff: THREE.Texture; nor: THREE.Texture; arm: THREE.Texture };
/** A surface material as the procedural look left it; kept on the material (`userData`), so a disposed course takes it along. */
type Saved = {
  map: THREE.Texture | null;
  color: THREE.Color;
  roughness: number;
  normalMap: THREE.Texture | null;
  aoMap: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  normalScale: number;
  aoMapIntensity: number;
};
const SAVED = "ultraSaved";

const bitmaps = new THREE.ImageBitmapLoader().setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none", colorSpaceConversion: "none" });

async function loadImage(role: SurfaceRole, kind: "diff" | "nor" | "arm", anisotropy: number): Promise<THREE.Texture> {
  const bitmap = await bitmaps.loadAsync(`${BASE}ultra/${role}-${kind}.webp`);
  const tex = new THREE.Texture(bitmap);
  tex.colorSpace = kind === "diff" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  // An ImageBitmap carries its orientation already (`imageOrientation` above).
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

async function loadSet(role: SurfaceRole, anisotropy: number): Promise<PbrSet> {
  const [diff, nor, arm] = await Promise.all([loadImage(role, "diff", anisotropy), loadImage(role, "nor", anisotropy), loadImage(role, "arm", anisotropy)]);
  const c = document.createElement("canvas");
  c.width = c.height = MEAN_EDGE;
  c.getContext("2d")!.drawImage(diff.image as ImageBitmap, 0, 0, MEAN_EDGE, MEAN_EDGE);
  return { diff, nor, arm, gain: gainOf(c) };
}

/**
 * The Ultra look (FX tier "ultra"): an HDRI daylight environment turned to the sun's side, the sun's shadow on a larger map with a normal
 * bias and a wider soft edge, and photographic PBR textures (colour, normals, occlusion, roughness) over the asphalt, concrete and
 * natural-ground surfaces. A manual pick (`AutoFx` never lifts to it). The whole folder is one lazy chunk, fetched when Ultra is picked.
 */
export class Ultra {
  private on = false;
  private readonly tilings = new Map<string, Tiling>();
  private readonly procGain = new WeakMap<THREE.Texture, THREE.Color>();
  private readonly sunDir = new THREE.Vector3();
  private readonly host: UltraHost;
  private readonly env: THREE.Texture;
  private readonly sets: Record<SurfaceRole, PbrSet>;
  /** What the engine had before `enable`; null while off. */
  private before: { env: THREE.Texture | null; exposure: number; mapSize: number; radius: number } | null = null;

  private constructor(host: UltraHost, env: THREE.Texture, sets: Record<SurfaceRole, PbrSet>) {
    this.host = host;
    this.env = env;
    this.sets = sets;
  }

  /** Fetch the sky and the nine images. Throws when one is missing; the caller (`loadUltra`) logs it. */
  static async create(host: UltraHost): Promise<Ultra> {
    const anisotropy = Math.min(MAX_ANISOTROPY, host.renderer.capabilities.getMaxAnisotropy());
    const envLoad = loadHdrEnv(host.renderer, SKY_URL, host.alive);
    let loaded: PbrSet[];
    try {
      loaded = await Promise.all(ROLES.map((role) => loadSet(role, anisotropy)));
    } catch (err) {
      void envLoad.then((e) => e?.dispose());
      throw err;
    }
    const env = await envLoad;
    if (env === null) throw new Error(`Ultra sky ${SKY_URL} did not load (or the engine was disposed meanwhile)`);
    const sets = {} as Record<SurfaceRole, PbrSet>;
    for (let i = 0; i < ROLES.length; i++) sets[ROLES[i]!] = loaded[i]!;
    return new Ultra(host, env, sets);
  }

  enable(): void {
    if (this.on) return;
    const { renderer, scene, stage } = this.host;
    const shadow = stage.sun.shadow;
    this.before = { env: scene.environment, exposure: renderer.toneMappingExposure, mapSize: shadow.mapSize.x, radius: shadow.radius };
    this.on = true;
    scene.environment = this.env;
    scene.environmentRotation.y = envYaw(this.sunDir.copy(stage.sun.position).sub(stage.sun.target.position));
    stage.envGain = LOOK.envGain;
    scene.environmentIntensity = stage.envIntensity;
    renderer.toneMappingExposure = LOOK.exposure;
    shadow.mapSize.set(LOOK.shadow.mapSize, LOOK.shadow.mapSize);
    shadow.radius = LOOK.shadow.radius;
    setSunBias(shadow);
    // The surfaces are dressed in the warm's first step (`dress`), so their programs compile with everything else in it.
    this.host.queueWarm();
  }

  disable(): void {
    const before = this.before;
    if (!this.on || before === null) return;
    this.on = false;
    this.before = null;
    const { renderer, scene, stage } = this.host;
    const shadow = stage.sun.shadow;
    scene.environment = before.env;
    scene.environmentRotation.set(0, 0, 0);
    stage.envGain = 1;
    scene.environmentIntensity = stage.envIntensity;
    renderer.toneMappingExposure = before.exposure;
    shadow.mapSize.set(before.mapSize, before.mapSize);
    shadow.radius = before.radius;
    setSunBias(shadow);
    scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) for (const m of [(o as THREE.Mesh).material].flat()) this.undress(m);
    });
    this.host.queueWarm();
  }

  /** Swap the photographic set into every surface material in the scene that does not wear it yet (a course loaded while Ultra is on). */
  dress(): void {
    if (!this.on) return;
    this.host.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) for (const m of [(o as THREE.Mesh).material].flat()) this.dressMaterial(m);
    });
  }

  dispose(): void {
    this.disable();
    this.env.dispose();
    for (const t of this.tilings.values()) {
      t.diff.dispose();
      t.nor.dispose();
      t.arm.dispose();
    }
    this.tilings.clear();
    for (const role of ROLES) {
      const s = this.sets[role];
      for (const t of [s.diff, s.nor, s.arm]) {
        t.dispose();
        (t.image as ImageBitmap).close();
      }
    }
  }

  private dressMaterial(m: THREE.Material): void {
    if (!(m instanceof THREE.MeshStandardMaterial) || m.userData[SAVED] !== undefined || m.map === null) return;
    const tag = surfaceOf(m.map);
    if (tag === null) return;
    const saved: Saved = { map: m.map, color: m.color.clone(), roughness: m.roughness, normalMap: m.normalMap, aoMap: m.aoMap, roughnessMap: m.roughnessMap, normalScale: m.normalScale.x, aoMapIntensity: m.aoMapIntensity };
    m.userData[SAVED] = saved;
    const t = this.tiling(tag);
    // albedo = colour x map: the photograph keeps the average colour the procedural map gave (its vertex tints read the same).
    const was = this.meanGain(m.map);
    const gain = this.sets[tag.role].gain;
    m.color.setRGB((saved.color.r * gain.r) / was.r, (saved.color.g * gain.g) / was.g, (saved.color.b * gain.b) / was.b);
    m.map = t.diff;
    m.normalMap = t.nor;
    m.aoMap = t.arm;
    m.roughnessMap = t.arm;
    m.roughness = 1;
    m.normalScale.set(LOOK.normalScale, LOOK.normalScale);
    m.aoMapIntensity = LOOK.aoIntensity;
    m.needsUpdate = true;
  }

  private undress(m: THREE.Material): void {
    const saved = m.userData[SAVED] as Saved | undefined;
    if (saved === undefined || !(m instanceof THREE.MeshStandardMaterial)) return;
    m.map = saved.map;
    m.color.copy(saved.color);
    m.roughness = saved.roughness;
    m.normalMap = saved.normalMap;
    m.aoMap = saved.aoMap;
    m.roughnessMap = saved.roughnessMap;
    m.normalScale.set(saved.normalScale, saved.normalScale);
    m.aoMapIntensity = saved.aoMapIntensity;
    delete m.userData[SAVED];
    m.needsUpdate = true;
  }

  /** `1 / mean linear colour` of a procedural surface texture, measured once. */
  private meanGain(tex: THREE.Texture): THREE.Color {
    let g = this.procGain.get(tex);
    if (g === undefined) {
      g = gainOf(tex.image as HTMLCanvasElement);
      this.procGain.set(tex, g);
    }
    return g;
  }

  private tiling(tag: SurfaceTag): Tiling {
    const key = `${tag.role}@${tag.uvMetres}`;
    let t = this.tilings.get(key);
    if (t === undefined) {
      const set = this.sets[tag.role];
      const repeat = tag.uvMetres / SURFACE_METRES[tag.role];
      // A clone shares the images (one GPU copy); only its repeat differs.
      const tile = (src: THREE.Texture): THREE.Texture => {
        const c = src.clone();
        c.repeat.set(repeat, repeat);
        return c;
      };
      t = { diff: tile(set.diff), nor: tile(set.nor), arm: tile(set.arm) };
      this.tilings.set(key, t);
    }
    return t;
  }
}
