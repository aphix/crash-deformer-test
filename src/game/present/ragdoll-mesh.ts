import * as THREE from "three";
import { JEANS, type DriverLook } from "./driver-look.ts";
import { PARTS } from "./ragdoll-body.ts";
import { applySpray, sprayUniforms, type SprayBitmap } from "./spray.ts";
import { PERSON_SPRAY } from "../match/look-data.ts";
import { BARE, BONES_ATTRIBUTE, BUILD, CAPPED, dummyGeometry, FLAGS_AT, isDrawn, KINDS_ATTRIBUTE, OPTIONAL, PALETTE_AT, ROLE, ROLES, ROW_TEXELS, skinPoint, UNIFORM, WHISKERS } from "./dummy-skin.ts";

/** FlatOut's thrown driver (sRGB, by role): skin, dark shoes and eyes are fixed; the tee, trousers and hair roles take the driver's `DriverLook`. */
const CIVILIAN = [0, 0xd8a27f, 0, 0, 0x1c1c1e, 0, 0, 0x1a1410, 0, 0, 0xb3202a, 0xf4f4f1];
/** A police driver: dark navy shirt and trousers, navy cap with a black peak, a gold badge, dark glasses; only the hair under the cap is the driver's. */
const COP = [0x1b2a4a, 0xd8a27f, 0x121a2e, 0x16213b, 0x0e0e10, 0x0b0b0d, 0xd4a52a, 0x0a0a0a, 0, 0, 0x101010, 0x8fa2c4];
/** A civilian's cap peak against its crown. */
const PEAK_SHADE = 0.6;
const _c = new THREE.Color();
const _o = new THREE.Vector3();
const IDENTITY = new THREE.Matrix4();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * The skinning in GLSL: each vertex rides bones `bones.x` and `bones.y` (weight `bones.z` on the second), moved by the
 * slot's bone transforms (`pose`); `dollShown` and `skinPoint` are the same rules in TS. A vertex the slot's build does not
 * draw collapses to a point.
 */
const DOLL_COMMON = /* glsl */ `
attribute vec3 bones;
attribute vec2 roleKind;
uniform sampler2D dolls;
vec4 dollTexel(int x) { return texelFetch(dolls, ivec2(x, gl_InstanceID), 0); }
vec3 dollTurn(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
bool dollShown() {
  int flags = int(dollTexel(${FLAGS_AT}).x + 0.5);
  int kinds = int(roleKind.y + 0.5);
  return (kinds & flags & 7) != 0 && (kinds & ${OPTIONAL} & ~flags) == 0;
}
void dollSkin(out vec3 p, out vec3 n) {
  int a = int(bones.x + 0.5);
  int b = int(bones.y + 0.5);
  vec4 qa = dollTexel(2 * a + 1);
  vec4 qb = dollTexel(2 * b + 1);
  vec3 pa = dollTexel(2 * a).xyz + dollTurn(qa, position);
  vec3 pb = dollTexel(2 * b).xyz + dollTurn(qb, position);
  p = dollShown() ? mix(pa, pb, bones.z) : vec3(0.0);
  n = normalize(mix(dollTurn(qa, normal), dollTurn(qb, normal), bones.z));
}
vec3 dollColour() { return dollTexel(${PALETTE_AT} + int(roleKind.x + 0.5)).rgb; }`;

/** Patch `material` to skin from `dolls`; `lit` also skins the normal and takes the vertex colour from the slot's palette. */
function applyDolls(material: THREE.Material, dolls: THREE.Texture, lit: boolean): void {
  const prev = material.onBeforeCompile;
  const prevKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    prev.call(material, shader, renderer);
    shader.uniforms.dolls = { value: dolls };
    shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>\n${DOLL_COMMON}`);
    if (lit) {
      shader.vertexShader = shader.vertexShader
        .replace("#include <beginnormal_vertex>", "#include <beginnormal_vertex>\nvec3 dollP;\nvec3 dollN;\ndollSkin(dollP, dollN);\nobjectNormal = dollN;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\ntransformed = dollP;")
        .replace("#include <color_vertex>", "#include <color_vertex>\nvColor.rgb = dollColour();");
      return;
    }
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvec3 dollP;\nvec3 dollN;\ndollSkin(dollP, dollN);\ntransformed = dollP;");
  };
  material.customProgramCacheKey = () => `${prevKey.call(material)}|dolls-${lit}`;
  material.needsUpdate = true;
}

/**
 * Every dummy in one instanced draw: one continuous body per slot (`dummyGeometry`), skinned in the vertex shader from the slot's ten
 * part poses (`pose`) and coloured by its look (`dress`); the instance is the slot. The draw ends after the highest slot with a dummy out.
 */
export class DummyMesh extends THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshStandardMaterial> {
  /** Slots with a dummy out, a bit each. */
  private shown = 0;
  /** Every slot's row of bone transforms (translation, rotation: `PARTS` rest to pose), role colours and flags. */
  private readonly rows: Float32Array;
  private readonly dolls: THREE.DataTexture;
  /** Every slot's spray (`PERSON_SPRAY`), one bitmap's rows per slot, slot 0 lowest. */
  private readonly sprayRgba: Uint8Array;
  private readonly sprayAtlas: THREE.DataTexture;

  constructor(slots: number) {
    super(dummyGeometry(), new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, vertexColors: true }), slots);
    this.rows = new Float32Array(slots * ROW_TEXELS * 4);
    this.dolls = new THREE.DataTexture(this.rows, ROW_TEXELS, slots, THREE.RGBAFormat, THREE.FloatType);
    this.sprayRgba = new Uint8Array(PERSON_SPRAY.w * PERSON_SPRAY.h * 4 * slots);
    this.sprayAtlas = new THREE.DataTexture(this.sprayRgba, PERSON_SPRAY.w, PERSON_SPRAY.h * slots);
    this.sprayAtlas.colorSpace = THREE.SRGBColorSpace;
    this.sprayAtlas.magFilter = THREE.LinearFilter;
    this.sprayAtlas.minFilter = THREE.LinearFilter;
    this.sprayAtlas.needsUpdate = true;
    this.customDepthMaterial = new THREE.MeshDepthMaterial();
    applyDolls(this.customDepthMaterial, this.dolls, false);
    applyDolls(this.material, this.dolls, true);
    // The posed body is wherever its parts are: nothing to cull against, and the instance transforms only hide.
    this.frustumCulled = false;
    applySpray(this.material, sprayUniforms(PERSON_SPRAY, this.sprayAtlas, slots), "", "vSprayP = position;\nvSprayN = normal;\nvSprayRow = float(gl_InstanceID);", "dummy");
    this.material.addEventListener("dispose", () => {
      this.sprayAtlas.dispose();
      this.dolls.dispose();
      this.customDepthMaterial!.dispose();
    });
    for (let s = 0; s < slots; s++) {
      this.setMatrixAt(s, HIDDEN);
      this.dress(s, false, { woman: false, shirt: 0x2b2d32, pants: JEANS, hair: 0x2a1d15, hat: null, mustache: false });
    }
    this.count = 0;
  }

  /**
   * Slot `s`'s clothes: a civilian's tee, trousers, hair, cap and moustache from `look`, or (`cop`) a police uniform with the
   * driver's hair under the cap; her build when `look.woman`.
   */
  dress(s: number, cop: boolean, look: DriverLook): void {
    const row = s * ROW_TEXELS * 4;
    const build = look.woman ? BUILD.WOMAN : look.portly ? BUILD.PORTLY : BUILD.MAN;
    const capped = cop || look.hat !== null;
    this.rows[row + FLAGS_AT * 4] = build | (look.mustache ? WHISKERS : 0) | (capped ? CAPPED : BARE) | (cop ? UNIFORM : 0);
    const base = cop ? COP : CIVILIAN;
    for (let role = 0; role < ROLES; role++) {
      if (!cop && look.hat !== null && role === ROLE.HAIR) _c.setHex(look.hat);
      else if (!cop && look.hat !== null && role === ROLE.BRIM) _c.setHex(look.hat).multiplyScalar(PEAK_SHADE);
      else if (role === ROLE.LOCKS || role === ROLE.MUSTACHE || (!cop && (role === ROLE.HAIR || role === ROLE.BRIM))) _c.setHex(look.hair);
      else if (!cop && role === ROLE.SHIRT) _c.setHex(look.shirt);
      else if (!cop && role === ROLE.LEGS) _c.setHex(look.pants);
      else if (!cop && role === ROLE.BADGE) _c.setHex(look.shirt).multiplyScalar(0.7);
      else _c.setHex(base[role]!);
      _c.toArray(this.rows, row + (PALETTE_AT + role) * 4);
    }
    this.dolls.needsUpdate = true;
  }

  /** Slot `s` wears `spray`'s paint (a `PERSON_SPRAY` bitmap), or none. */
  spray(s: number, spray: SprayBitmap | null): void {
    const at = s * PERSON_SPRAY.w * PERSON_SPRAY.h * 4;
    if (spray) this.sprayRgba.set(spray.rgba, at);
    else this.sprayRgba.fill(0, at, at + PERSON_SPRAY.w * PERSON_SPRAY.h * 4);
    this.sprayAtlas.needsUpdate = true;
  }

  /** Slot `s`'s body part `k` at pose `p`, `q`: the bone the skin blends its vertices from (translation `p - q c`, so the part's centre `c` standing lands on `p`). */
  pose(s: number, k: number, p: THREE.Vector3, q: THREE.Quaternion): void {
    if (((this.shown >> s) & 1) === 0) {
      this.shown |= 1 << s;
      this.count = 32 - Math.clz32(this.shown);
      this.setMatrixAt(s, IDENTITY);
      this.instanceMatrix.needsUpdate = true;
    }
    const c = PARTS[k]!.c;
    _o.set(c[0], c[1], c[2]).applyQuaternion(q);
    const at = (s * ROW_TEXELS + 2 * k) * 4;
    this.rows[at] = p.x - _o.x;
    this.rows[at + 1] = p.y - _o.y;
    this.rows[at + 2] = p.z - _o.z;
    this.rows[at + 4] = q.x;
    this.rows[at + 5] = q.y;
    this.rows[at + 6] = q.z;
    this.rows[at + 7] = q.w;
    this.dolls.needsUpdate = true;
  }

  hide(s: number): void {
    this.shown &= ~(1 << s);
    this.count = 32 - Math.clz32(this.shown);
    this.setMatrixAt(s, HIDDEN);
    this.instanceMatrix.needsUpdate = true;
  }

  /** Vertex `i` of slot `s` as posed now into `out`; false when the slot's build does not draw it. */
  posed(s: number, i: number, out: THREE.Vector3): boolean {
    const bones = this.geometry.getAttribute(BONES_ATTRIBUTE);
    if (!isDrawn(this.geometry.getAttribute(KINDS_ATTRIBUTE).getY(i), this.flagsOf(s))) return false;
    skinPoint(this.rows, s, bones.getX(i), bones.getY(i), bones.getZ(i), _o.fromBufferAttribute(this.geometry.getAttribute("position"), i), out);
    return true;
  }

  /** Slot `s`'s colour for `role` (linear) into `into`. */
  colourOf(s: number, role: number, into: THREE.Color): THREE.Color {
    return into.fromArray(this.rows, s * ROW_TEXELS * 4 + (PALETTE_AT + role) * 4);
  }

  private flagsOf(s: number): number {
    return this.rows[(s * ROW_TEXELS + FLAGS_AT) * 4]!;
  }

  /** A ray against each slot's drawn body as its torso carries it (every part is rigid on it at rest: the garage's standing driver, exactly). */
  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    const hits: THREE.Intersection[] = [];
    const kinds = this.geometry.getAttribute(KINDS_ATTRIBUTE);
    for (let s = 0; s < this.count; s++) {
      if (((this.shown >> s) & 1) === 0) continue;
      const at = s * ROW_TEXELS * 4;
      _torso.compose(_o.fromArray(this.rows, at), _q.fromArray(this.rows, at + 4), _unit);
      _world.multiplyMatrices(this.matrixWorld, _torso);
      _pick.geometry = this.geometry;
      _pick.material = this.material;
      _pick.matrixWorld = _world;
      _pick.raycast(raycaster, hits);
      for (const hit of hits) {
        if (!hit.face || !isDrawn(kinds.getY(hit.face.a), this.flagsOf(s))) continue;
        hit.instanceId = s;
        hit.object = this;
        intersects.push(hit);
      }
      hits.length = 0;
    }
  }
}

const _pick = new THREE.Mesh();
const _torso = new THREE.Matrix4();
const _world = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _unit = new THREE.Vector3(1, 1, 1);
