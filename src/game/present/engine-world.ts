import * as THREE from "three";
import { applyMarkMap } from "./engine-marks.ts";
import { groundMaterial, groundMesh } from "../scenes/ground-stack.ts";
import { tagSurface } from "./ultra/surface-tag.ts";
import { LAMP_POOL } from "./constants.ts";
import { rowElevation, SKY_LOOKS, SkyDome } from "./sky-dome.ts";
import { TIME_OF_DAY, type TimeOfDay } from "../match/types.ts";

/** The sandbox's asphalt disc: its UVs span this many metres (its texture repeats 18 times across). */
const STAGE_DIAMETER = 96;

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
  pool.name = LAMP_POOL;
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

/**
 * Sunset (`TIME_OF_DAY.sunset`): a low orange sun, a rose-violet sky light, a cool blue fill from the far side of the sky, the
 * street lamps lit early and the studio reflections dimmed; its sky (and fog) colour is the sunset strip's horizon. A course's own
 * daylight is a midday look and gives way to it.
 */
const SUNSET: Day = {
  sky: parseInt(SKY_LOOKS[TIME_OF_DAY.sunset].horizon.slice(1), 16),
  hemi: [0xc9a2b4, 1.1],
  sun: [0xffa257, 2.5],
  fill: [0x7f8ccc, 0.7],
  env: 0.55,
  lamp: 4,
  smoke: 0.85,
};

/**
 * Where the sun (and the moon) shines from: the default day's bearing (rad from −z toward +x) and height over the shadow box's
 * centre (m), kept at every time of day so the light stays above the roofs it shades past. Sunset's sun comes in no lower than
 * `LOW_SUN` (rad): the shadow map's texels stretch 1 / sin(elevation) along the light, 4.8× at 12°.
 */
const DEFAULT_SUN_OFFSET = new THREE.Vector3(-10, 22, 9);
const SUN_BEARING = Math.atan2(DEFAULT_SUN_OFFSET.x, -DEFAULT_SUN_OFFSET.z);
const LOW_SUN = THREE.MathUtils.degToRad(12);
/** The moon's light stays between these elevations (rad) whatever the picture has: lower stretches the shadows, higher flattens them. */
const MOON_ELEVATION = { min: THREE.MathUtils.degToRad(20), max: THREE.MathUtils.degToRad(60) };
/** The shadow camera reaches this far (m) past the shadow box's centre, beyond the sun's own distance (60 m over the default 25.8). */
const SHADOW_REACH = 34;

/** The sun's elevation (rad) for `time`: the default day's, or where the picture's disc is (sunset not under `LOW_SUN`). */
export function sunElevation(time: TimeOfDay | null): number {
  const look = time === null ? null : SKY_LOOKS[time];
  if (time === TIME_OF_DAY.sunset && look?.disc) return Math.max(LOW_SUN, rowElevation(look, look.disc.row));
  if (time === TIME_OF_DAY.night && look?.disc) return THREE.MathUtils.clamp(rowElevation(look, look.disc.row), MOON_ELEVATION.min, MOON_ELEVATION.max);
  return Math.atan2(DEFAULT_SUN_OFFSET.y, Math.sqrt(DEFAULT_SUN_OFFSET.x ** 2 + DEFAULT_SUN_OFFSET.z ** 2));
}

/** `out` = the offset (m) from the shadow box's centre to the sun for `time`: on `SUN_BEARING`, at the default's height. */
export function sunOffset(time: TimeOfDay | null, out: THREE.Vector3): THREE.Vector3 {
  const el = sunElevation(time);
  const flat = DEFAULT_SUN_OFFSET.y / Math.tan(el);
  return out.set(Math.sin(SUN_BEARING) * flat, DEFAULT_SUN_OFFSET.y, -Math.cos(SUN_BEARING) * flat);
}

/** The palette a course lights with: its own daylight over the default's, and its own sky colour (`sky`, else the daylight's, else the studio's). */
export function courseDay(light: Daylight | null, sky?: string): Day {
  const base: Day = light ? { ...DAY, sun: [hex(light.sun), light.sunIntensity], hemi: [hex(light.hemi), DAY.hemi[1]], fill: [hex(light.fill), DAY.fill[1]] } : DAY;
  const tint = sky ?? light?.sky;
  return tint ? { ...base, sky: hex(tint) } : base;
}

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
  /** A multiplier on the environment's day / night level: 1 except under Ultra (`present/ultra/`), whose HDRI is lit differently from the studio env. */
  envGain = 1;
  /** A race's time of day (`setTime`), null outside one: its sky, its sun, and night at night. */
  time: TimeOfDay | null = null;
  /** The sandbox's own night setting, kept while a race's time of day overrides it. */
  private nightOutside = false;
  /** The offset (m) from the shadow box's centre to the sun for the time of day (the race director keeps the box on the followed car). */
  readonly sunOffset = DEFAULT_SUN_OFFSET.clone();
  /** The race's sky (`present/sky-dome.ts`). */
  readonly sky = new SkyDome();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.hemi = new THREE.HemisphereLight(DAY.hemi[0], 0x1a1816, DAY.hemi[1]);
    scene.add(this.hemi);
    const dir = new THREE.DirectionalLight(DAY.sun[0], DAY.sun[1]);
    dir.position.copy(DEFAULT_SUN_OFFSET);
    dir.castShadow = true;
    dir.shadow.mapSize.set(1024, 1024);
    dir.shadow.camera.near = 2;
    dir.shadow.camera.far = DEFAULT_SUN_OFFSET.length() + SHADOW_REACH;
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
      map: tagSurface(makeAsphalt(), "asphalt", STAGE_DIAMETER),
    });
    applyMarkMap(this.groundMat);
    this.ground = groundMesh(new THREE.CircleGeometry(STAGE_DIAMETER / 2, 64), this.groundMat, "terrain");
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    scene.add(this.ground);
    scene.add(this.sky.mesh);
    this.apply();
  }

  /** Environment-map strength for the current time of day (the studio env loads async). */
  get envIntensity(): number {
    return THREE.MathUtils.lerp(this.lit.env, NIGHT.env, this.depth) * this.envGain;
  }

  /** Smoke brightness for the current time of day. */
  get smokeShade(): number {
    return THREE.MathUtils.lerp(this.lit.smoke, NIGHT.smoke, this.depth);
  }

  /** How far toward full night the lighting sits: `nightDepth` at night, 0 by day. */
  private get depth(): number {
    return this.night ? this.nightDepth : 0;
  }

  /**
   * A course's own daylight, or the default (null: it leaves), and its sky (and fog) colour `sky` when it has one: every relight
   * (night, a time of day) starts from it, never from the studio's.
   */
  look(light: Daylight | null, sky?: string): void {
    this.day = courseDay(light, sky);
    this.apply();
  }

  /** The palette the time of day lights with: sunset's own, else the course's daylight (which night darkens). */
  private get lit(): Day {
    return this.time === TIME_OF_DAY.sunset ? SUNSET : this.day;
  }

  /** Night lighting on or off. In a race it is the time of day: night, or back to day. */
  setNight(on: boolean): void {
    if (this.time !== null) {
      this.setTime(on ? TIME_OF_DAY.night : TIME_OF_DAY.day);
      return;
    }
    this.night = on;
    this.apply();
  }

  /**
   * A race's time of day (null: the race is over, the sandbox's own night setting comes back): its sky, the sun's direction (the
   * shadow camera reaching past it) and night's lighting at night.
   */
  setTime(time: TimeOfDay | null): void {
    if (this.time === null && time !== null) this.nightOutside = this.night;
    this.time = time;
    this.night = time === null ? this.nightOutside : time === TIME_OF_DAY.night;
    sunOffset(time, this.sunOffset);
    const cam = this.sun.shadow.camera;
    cam.far = this.sunOffset.length() + SHADOW_REACH;
    cam.updateProjectionMatrix();
    this.sky.show(time, SUN_BEARING);
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
      const pool = p.group.getObjectByName(LAMP_POOL);
      if (pool) pool.visible = p.intact;
    }
  }

  private apply(): void {
    const k = this.depth;
    if (!(this.scene.background instanceof THREE.Color)) this.scene.background = new THREE.Color();
    const sky = this.scene.background;
    const day = this.lit;
    // A race's night is its night sky's horizon, not the day's haze darkened.
    if (this.time === TIME_OF_DAY.night) sky.set(SKY_LOOKS[TIME_OF_DAY.night].horizon);
    else mixHex(sky, day.sky, NIGHT.sky, k);
    this.scene.fog?.color.copy(sky);
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
