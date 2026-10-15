import * as THREE from "three";
import { TIME_OF_DAY, type TimeOfDay } from "../match/types.ts";
import { BITMAP_UPRIGHT } from "./constants.ts";

const BASE = import.meta.env?.BASE_URL ?? "/";

/**
 * One time of day's sky: a 360° panorama strip (`public/sky/<time>.webp`, a seamless loop; one column a 1/width turn, square
 * pixels) and what was read off it (`SKY_LOOKS`): the row of its horizon,
 * the column of its sun or moon disc (null: none in the picture), the colour along its horizon (the haze it blends into and,
 * past day, the course's fog) and at its top (what the sky fades to past the strip, toward the zenith).
 */
type SkyLook = {
  /** Strip size (px). */
  width: number;
  height: number;
  /** Horizon row from the top (px). */
  horizonRow: number;
  /** The disc's column (px) and its centre's row from the top (px); null when the picture has none. */
  disc: { column: number; row: number } | null;
  /** Mean colour just over the horizon and over the top rows (sRGB hex). */
  horizon: string;
  zenith: string;
  /** Elevation (rad) over which the picture rises out of the haze colour: wide by day, where each course's own haze differs from the picture's. */
  hazeTop: number;
};

/**
 * Read off the strips (the generator and the reader were throwaway scripts; these are what they measured). Day is five gpt-image-1
 * generations seam-matched row by row and cross-faded; sunset is that strip regraded to golden hour with a low sun, and night is
 * procedural (stars, a Milky Way of layered noise, a moon), both made locally when the image API ran out of credit.
 */
export const SKY_LOOKS: Record<TimeOfDay, SkyLook> = {
  [TIME_OF_DAY.day]: { width: 4096, height: 780, horizonRow: 702, disc: { column: 138, row: 116 }, horizon: "#adc3c9", zenith: "#24629b", hazeTop: 0.2 },
  [TIME_OF_DAY.sunset]: { width: 4096, height: 780, horizonRow: 702, disc: { column: 410, row: 657 }, horizon: "#cd877a", zenith: "#292761", hazeTop: 0.07 },
  [TIME_OF_DAY.night]: { width: 4096, height: 780, horizonRow: 702, disc: { column: 410, row: 298 }, horizon: "#213151", zenith: "#050816", hazeTop: 0.07 },
};

/** Elevation (rad) of a strip row: square pixels, a full turn across the width. */
export function rowElevation(look: SkyLook, row: number): number {
  return ((look.horizonRow - row) * 2 * Math.PI) / look.width;
}

/**
 * The texture's u at bearing 0 (u = bearing / turn + this): the disc's column lands on `discBearing` (rad from −z toward +x),
 * so the sun or moon drawn in the sky stands where the light comes from.
 */
export function uAtNorth(look: SkyLook, discBearing: number): number {
  const u = look.disc ? look.disc.column / look.width - discBearing / (2 * Math.PI) : 0;
  return u - Math.floor(u);
}

/** Clip-space depth of the dome, as a share of w: past every surface the far plane keeps (the backdrop's, nearer, draws over it). */
const FAR_DEPTH = 0.9999995;

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position.z = gl_Position.w * ${FAR_DEPTH};
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec3 haze;
uniform vec3 zenith;
uniform float uNorth;
uniform float horizonV;
uniform float vPerRad;
uniform float topEl;
uniform float hazeTop;
varying vec3 vDir;
const float TURN = 6.28318530718;
void main() {
  vec3 d = normalize(vDir);
  float el = asin(clamp(d.y, -1.0, 1.0));
  float u = atan(d.x, -d.z) / TURN + uNorth;
  vec2 uv = vec2(fract(u), clamp(horizonV + el * vPerRad, 0.0005, 0.9995));
  // The gradients from whichever of u and u + 1/2 has no seam here, so the wrap column samples the finest mip like the rest.
  float a = fract(u + 0.5);
  vec2 dx = vec2(abs(dFdx(uv.x)) < abs(dFdx(a)) ? dFdx(uv.x) : dFdx(a), dFdx(uv.y));
  vec2 dy = vec2(abs(dFdy(uv.x)) < abs(dFdy(a)) ? dFdy(uv.x) : dFdy(a), dFdy(uv.y));
  vec3 c = textureGrad(map, uv, dx, dy).rgb;
  c = mix(c, zenith, smoothstep(topEl - 0.18, topEl, el));
  c = mix(haze, c, smoothstep(0.0, hazeTop, el));
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

const bitmaps = new THREE.ImageBitmapLoader().setOptions(BITMAP_UPRIGHT);

/**
 * The race's sky (`WorldStage.setTime`): the time of day's panorama on a sphere round the camera, drawn at infinity (turned with
 * the camera, never moved, on the far plane, writing no depth) before everything else. It takes no fog and no tone mapping, as the
 * flat sky colour it replaces; under its own `hazeTop` it fades into the scene's fog colour, so the fogged course meets it with no
 * seam. Each picture loads the first time its time of day is asked for and stays; until then the flat colour shows.
 */
export class SkyDome {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.ShaderMaterial;
  private readonly maps = new Map<TimeOfDay, Promise<THREE.Texture | null>>();
  private want: TimeOfDay | null = null;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        map: { value: null },
        haze: { value: new THREE.Color() },
        zenith: { value: new THREE.Color() },
        uNorth: { value: 0 },
        horizonV: { value: 0 },
        vPerRad: { value: 0 },
        topEl: { value: 0 },
        hazeTop: { value: 0 },
      },
      depthWrite: false,
      side: THREE.BackSide,
      fog: false,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), this.mat);
    this.mesh.name = "sky-dome";
    // A unit sphere at the origin that the shader carries to the sky: never culled, never hit, first of the opaque draws.
    this.mesh.frustumCulled = false;
    this.mesh.raycast = () => {};
    this.mesh.renderOrder = -2e9;
    this.mesh.visible = false;
    // The haze follows the fog every frame: day and night mix it, and a course load replaces the fog.
    this.mesh.onBeforeRender = (_r, scene) => {
      const fog = scene.fog?.color ?? (scene.background instanceof THREE.Color ? scene.background : null);
      if (fog) (this.mat.uniforms.haze!.value as THREE.Color).copy(fog);
    };
  }

  /** Show `time`'s sky with its disc on `discBearing` (rad), or none (null). */
  show(time: TimeOfDay | null, discBearing: number): void {
    this.want = time;
    if (time === null) {
      this.mesh.visible = false;
      return;
    }
    const look = SKY_LOOKS[time];
    const u = this.mat.uniforms;
    u.uNorth!.value = uAtNorth(look, discBearing);
    u.horizonV!.value = 1 - look.horizonRow / look.height;
    u.vPerRad!.value = look.width / (2 * Math.PI) / look.height;
    u.topEl!.value = rowElevation(look, 0);
    u.hazeTop!.value = look.hazeTop;
    (u.zenith!.value as THREE.Color).set(look.zenith);
    this.load(time).then((map) => {
      if (this.want !== time || !map) return;
      u.map!.value = map;
      this.mesh.visible = true;
    });
  }

  private load(time: TimeOfDay): Promise<THREE.Texture | null> {
    let p = this.maps.get(time);
    if (!p) {
      p = bitmaps
        .loadAsync(`${BASE}sky/${time}.webp`)
        .then((bitmap) => {
          const tex = new THREE.Texture(bitmap);
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.wrapS = THREE.RepeatWrapping;
          tex.anisotropy = 8;
          // An ImageBitmap carries its orientation already.
          tex.flipY = false;
          tex.needsUpdate = true;
          return tex;
        })
        .catch((err: unknown) => {
          console.error(`sky ${time} failed to load`, err);
          return null;
        });
      this.maps.set(time, p);
    }
    return p;
  }
}
