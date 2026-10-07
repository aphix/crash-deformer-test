import * as THREE from "three";
import { applyMarkMap } from "./engine-marks.ts";
import { groundMaterial, groundMesh } from "../scenes/ground-stack.ts";

function makeConcrete(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#b7b1a4";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2800; i++) {
    const n = Math.random();
    ctx.fillStyle = n > 0.55 ? `rgba(255,255,255,${n * 0.07})` : `rgba(30,26,22,${(1 - n) * 0.1})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, n > 0.88 ? 3 : 1, 1);
  }
  ctx.fillStyle = "rgba(40,38,34,0.18)";
  ctx.fillRect(0, 200, 256, 56);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeAsphalt(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 512;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#17181d";
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 9000; i++) {
    const n = Math.random();
    ctx.fillStyle = `rgba(255,255,255,${n * 0.045})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, n > 0.8 ? 2 : 1, 1);
  }
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.08 + Math.random() * 0.12})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 3, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(18, 18);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeJerseyBarrier(): THREE.Group {
  const g = new THREE.Group();
  g.name = "jersey-barrier";

  const shape = new THREE.Shape();
  shape.moveTo(-0.305, 0);
  shape.lineTo(0.305, 0);
  shape.lineTo(0.305, 0.075);
  shape.lineTo(0.215, 0.33);
  shape.lineTo(0.075, 0.81);
  shape.lineTo(-0.075, 0.81);
  shape.lineTo(-0.215, 0.33);
  shape.lineTo(-0.305, 0.075);
  shape.closePath();

  const concreteTex = makeConcrete();
  const concrete = new THREE.MeshStandardMaterial({
    color: 0xc4bfb3,
    roughness: 0.94,
    metalness: 0.05,
    map: concreteTex,
  });
  const weathered = new THREE.MeshStandardMaterial({
    color: 0xaea99d,
    roughness: 0.96,
    metalness: 0.04,
    map: concreteTex,
  });
  const jointMat = new THREE.MeshStandardMaterial({
    color: 0x5c5852,
    roughness: 0.8,
    metalness: 0.2,
  });

  const segLen = 1.78;
  for (const [zOff, mat] of [
    [-0.95, concrete],
    [0.95, weathered],
  ] as const) {
    const geo = new THREE.ExtrudeGeometry(shape, { depth: segLen, bevelEnabled: false, steps: 1 });
    geo.translate(0, 0, -segLen / 2);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = zOff;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.rest = (geo.getAttribute("position") as THREE.BufferAttribute).array.slice();
    g.add(mesh);
  }

  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.18, 8), jointMat);
  pin.position.set(0, 0.09, 0);
  pin.castShadow = true;
  g.add(pin);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.04, 0.12), jointMat);
  cap.position.set(0, 0.82, 0);
  g.add(cap);
  return g;
}

/** One head material for every lamp pole, so night mode lights them all at once. */
const lampHead = new THREE.MeshStandardMaterial({
  color: 0xf0e6c8,
  emissive: 0xf0e6c8,
  emissiveIntensity: 1.4,
  roughness: 0.4,
});
/** Fake light pool under each lamp: an additive ground decal, drawn only at night. */
const lampPool = groundMaterial(
  new THREE.MeshBasicMaterial({
    color: 0xffd9a0,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    visible: false,
  }),
  "decal",
);

export function makeLamp(): THREE.Group {
  const g = new THREE.Group();
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.1, 5.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x2a2c32, roughness: 0.7, metalness: 0.4 }),
  );
  pole.position.y = 2.6;
  pole.castShadow = true;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.1, 0.22), lampHead);
  head.position.set(0, 5.15, 0.15);
  lampPool.map ??= makePoolTexture();
  const pool = groundMesh(new THREE.PlaneGeometry(9, 9), lampPool, "decal");
  pool.name = "pool";
  pool.rotation.x = -Math.PI / 2;
  pool.position.set(0, 0.025, 0.15);
  g.add(pole, head, pool);
  return g;
}

/** Soft white radial falloff for additive ground light decals (lamp pools, the derby winner's glow). */
export function makePoolTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.45)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The day's lights: colour and intensity of the hemisphere, the sun and the fill, plus the sky, the studio env, the lamps and the smoke. */
type Day = { sky: number; hemi: readonly [number, number]; sun: readonly [number, number]; fill: readonly [number, number]; env: number; lamp: number; smoke: number };
const DAY: Day = {
  sky: 0x12141a,
  hemi: [0xb7c4d8, 1.35],
  sun: [0xf2f5ff, 2.6],
  fill: [0xc9d3e0, 0.9],
  env: 0.72,
  lamp: 1.4,
  smoke: 1,
};

/** A course's own daylight (`environment.light`), or the Lab's workshop: sun, hemisphere and fill colours (hex), the sun's intensity, and the sky (and fog) colour when it is not the studio's. */
type Daylight = { sun: string; sunIntensity: number; hemi: string; fill: string; sky?: string };
const hex = (c: string): number => parseInt(c.slice(1), 16);
const NIGHT = {
  sky: 0x040509,
  hemi: [0x5a6c94, 0.16],
  sun: [0x9fb4e0, 0.32],
  fill: [0x7a8aa8, 0.06],
  env: 0.1,
  lamp: 9,
  smoke: 0.4,
} as const;

const _night = new THREE.Color();
/** `out` = the day colour moved `k` of the way to the night one (linear working space). */
function mixHex(out: THREE.Color, day: number, night: number, k: number): void {
  out.setHex(day).lerp(_night.setHex(night), k);
}

/**
 * The sun's shadow bias, from the map's texel (the box's width over its resolution: 4.7 cm at 48 m / 1024). A normal offset of a
 * quarter texel stops a lit surface shading itself at grazing sun; the constant depth bias, half of the old -0.0004 (a fraction of
 * the 2..60 m depth range: 2.3 cm down to 1.2 cm), covers what the offset leaves, so a shadow starts at its caster's foot.
 * Picked by a grid sweep (depth bias 0 to -0.0004, normal offset 0 to 0.64 texel) against the same frame drawn with a 4096 map, on
 * city, oval and rally frames at sun elevations 8 to 58 degrees: against the old constant alone, fewer wrongly shadowed pixels
 * (city -38 %, oval -18 %, rally -3 %), about as many wrongly lit ones (city -4 %, oval +2 %, rally -11 %), and less acne away
 * from shadow edges (city -36 %, oval -13 %, rally -48 %). A half texel offset (0.023) cut acne as far but left 45 % more flat-area
 * pixels lit that 4096 shadows on the city frames: a gap at the caster's foot.
 */
const SUN_NORMAL_BIAS_TEXELS = 0.25;
const SUN_DEPTH_BIAS = -0.0002;
export function setSunBias(shadow: THREE.DirectionalLightShadow): void {
  const cam = shadow.camera;
  shadow.normalBias = (SUN_NORMAL_BIAS_TEXELS * (cam.right - cam.left)) / shadow.mapSize.x;
  shadow.bias = SUN_DEPTH_BIAS;
}

/**
 * Lights, sky colour and the asphalt disc, plus the time of day (day / night) and a wet-road option.
 * Night drops the sun to moonlight so the cars' own lamps, the pole heads (bloomed) and their fake light
 * pools carry the scene; wet asphalt turns glossy so those lights streak across it.
 */
export class WorldStage {
  readonly ground: THREE.Mesh;
  private readonly groundMat: THREE.MeshStandardMaterial;
  private readonly hemi: THREE.HemisphereLight;
  /** The shadow-casting sun (the race director moves its shadow box with the followed car). */
  readonly sun: THREE.DirectionalLight;
  private readonly fill: THREE.DirectionalLight;
  private readonly scene: THREE.Scene;
  night = false;
  wet = false;
  /** Share of the full DAY → NIGHT darkening that night applies (sky, ambient, sun, fill, env, smoke). At 1 the
   * owner found night too dark; 0.62–0.83 is the agreed range. The lamp heads always glow at full night strength. */
  nightDepth = 0.72;
  private day = DAY;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.hemi = new THREE.HemisphereLight(DAY.hemi[0], 0x1a1816, DAY.hemi[1]);
    scene.add(this.hemi);
    const dir = new THREE.DirectionalLight(DAY.sun[0], DAY.sun[1]);
    dir.position.set(-10, 22, 9);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 2;
    dir.shadow.camera.far = 60;
    dir.shadow.camera.left = -24;
    dir.shadow.camera.right = 24;
    dir.shadow.camera.top = 24;
    dir.shadow.camera.bottom = -24;
    setSunBias(dir.shadow);
    this.sun = dir;
    scene.add(dir);
    this.fill = new THREE.DirectionalLight(DAY.fill[0], DAY.fill[1]);
    this.fill.position.set(10, 12, -14);
    scene.add(this.fill);

    this.groundMat = new THREE.MeshStandardMaterial({
      color: 0x2a2c34,
      roughness: 0.88,
      metalness: 0.06,
      map: makeAsphalt(),
    });
    applyMarkMap(this.groundMat);
    this.ground = groundMesh(new THREE.CircleGeometry(48, 64), this.groundMat, "terrain");
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    scene.add(this.ground);
    this.apply();
  }

  /** Environment-map strength for the current time of day (the studio env loads async). */
  get envIntensity(): number {
    return THREE.MathUtils.lerp(this.day.env, NIGHT.env, this.depth);
  }

  /** Smoke brightness for the current time of day. */
  get smokeShade(): number {
    return THREE.MathUtils.lerp(this.day.smoke, NIGHT.smoke, this.depth);
  }

  /** How far toward full night the lighting sits: `nightDepth` at night, 0 by day. */
  private get depth(): number {
    return this.night ? this.nightDepth : 0;
  }

  /** A course's own daylight, or the default (null: it leaves). A course's sky and fog are its own (`RaceField.load`). */
  look(light: Daylight | null): void {
    this.day = light ? { ...DAY, sky: light.sky ? hex(light.sky) : DAY.sky, sun: [hex(light.sun), light.sunIntensity], hemi: [hex(light.hemi), DAY.hemi[1]], fill: [hex(light.fill), DAY.fill[1]] } : DAY;
    this.apply();
  }

  setNight(on: boolean): void {
    this.night = on;
    this.apply();
  }

  setWet(on: boolean): void {
    this.wet = on;
    this.apply();
  }

  /** A knocked-over pole's light pool goes out with it. */
  syncPools(poles: readonly { group: THREE.Group; intact: boolean }[]): void {
    if (!this.night) return;
    for (let k = 0; k < poles.length; k++) {
      const p = poles[k]!;
      const pool = p.group.getObjectByName("pool");
      if (pool) pool.visible = p.intact;
    }
  }

  private apply(): void {
    const k = this.depth;
    if (!(this.scene.background instanceof THREE.Color)) this.scene.background = new THREE.Color();
    const sky = this.scene.background;
    mixHex(sky, this.day.sky, NIGHT.sky, k);
    this.scene.fog?.color.copy(sky);
    const day = this.day;
    mixHex(this.hemi.color, day.hemi[0], NIGHT.hemi[0], k);
    this.hemi.intensity = THREE.MathUtils.lerp(day.hemi[1], NIGHT.hemi[1], k);
    mixHex(this.sun.color, day.sun[0], NIGHT.sun[0], k);
    this.sun.intensity = THREE.MathUtils.lerp(day.sun[1], NIGHT.sun[1], k);
    mixHex(this.fill.color, day.fill[0], NIGHT.fill[0], k);
    this.fill.intensity = THREE.MathUtils.lerp(day.fill[1], NIGHT.fill[1], k);
    if (this.scene.environment) this.scene.environmentIntensity = this.envIntensity;
    lampHead.emissiveIntensity = this.night ? NIGHT.lamp : day.lamp;
    lampPool.visible = this.night;
    // Wet is a satin sheen on the dry albedo. The old mirror (roughness 0.2, env 1.8, darker albedo) laid a
    // bright glare band over the ground: ground luminance +35 % vs dry; this one +16 %, car/ground contrast 2.67
    // (dry 2.47, old wet 2.56).
    const m = this.groundMat;
    m.roughness = this.wet ? 0.38 : 0.88;
    m.metalness = this.wet ? 0 : 0.06;
  }
}
