import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { makePaintMaterial, trimMaterial } from "../vehicle/car-materials.ts";
import { CAR_SPRAY, carPickText, NO_CAR_PICK, type CarPart, type CarPick } from "../match/look-data.ts";
import { applySpray, BARE_SPRAY, sprayUniforms, type SprayBitmap } from "./spray.ts";

/** What wearing a look changed on a car: its own lid and door paints, the spray's uniforms, and the colours it had before. */
type Worn = {
  uniforms: Record<string, THREE.IUniform>;
  hood: THREE.MeshPhysicalMaterial;
  trunk: THREE.MeshPhysicalMaterial;
  doors: THREE.MeshPhysicalMaterial;
  bumpers: readonly THREE.Mesh[];
  base: CarBase;
};

/** A car's own colours: its body and door paint, bumper trim and glass (sRGB). */
type CarBase = { body: number; doors: number; bumpers: number; glass: number };

const worn = new WeakMap<DeformableCar, Worn>();
const _m = new THREE.Matrix4();
const _n = new THREE.Matrix3();
const _v = new THREE.Vector3();
const DEFAULT_PICK = carPickText(NO_CAR_PICK);
/** Rims as built: white is the instance tint (`WheelBatch`) that leaves the alloy as toned. */
const RIMS_AS_BUILT = 0xffffff;

/**
 * Car `car` in a player's colours (`pick`, null fields: its own paint) and spray (`spray`, a `CAR_SPRAY` bitmap, or none).
 * The first look a car wears gives its lids and doors their own paint, so each part takes its colour, and puts the spray
 * under the paint of all of them; a car that never wears one keeps the fleet's shared paint. Wearing `NO_CAR_PICK` with no
 * spray puts its own colours back.
 */
export function wearCarLook(car: DeformableCar, pick: CarPick, spray: SprayBitmap | null): void {
  let w = worn.get(car);
  if (!w) {
    if (carPickText(pick) === DEFAULT_PICK && !spray) return;
    w = firstWear(car);
    worn.set(car, w);
  }
  const m = car.lookMeshes();
  const c = lookColours(car, pick);
  m.bodyPaint.color.setHex(c.body);
  w.hood.color.setHex(c.hood);
  w.trunk.color.setHex(c.trunk);
  w.doors.color.setHex(c.doors);
  const trim = trimMaterial(c.bumpers);
  for (const bumper of w.bumpers) bumper.material = trim;
  for (const pane of m.glass) (pane.material as THREE.MeshStandardMaterial).color.setHex(c.glass);
  for (const wheel of car.wheels) {
    if (c.rims === RIMS_AS_BUILT) delete wheel.userData.rim;
    else wheel.userData.rim = new THREE.Color(c.rims);
  }
  w.uniforms.sprayMap!.value = spray?.texture ?? BARE_SPRAY;
}

/** Each part's colour (sRGB) as car `car` draws with `pick` on: a part not picked shows the car's own, the lids and doors the body's pick. */
export function lookColours(car: DeformableCar, pick: CarPick): Record<CarPart, number> {
  const base = worn.get(car)?.base ?? baseOf(car);
  const body = pick.body ?? base.body;
  return {
    body,
    doors: pick.doors ?? pick.body ?? base.doors,
    hood: pick.hood ?? body,
    trunk: pick.trunk ?? body,
    bumpers: pick.bumpers ?? base.bumpers,
    rims: pick.rims ?? RIMS_AS_BUILT,
    glass: pick.glass ?? base.glass,
  };
}

function baseOf(car: DeformableCar): CarBase {
  const m = car.lookMeshes();
  return {
    body: m.bodyPaint.color.getHex(),
    doors: (m.doors[0]!.material as THREE.MeshPhysicalMaterial).color.getHex(),
    bumpers: car.style.livery?.accent ?? car.paint.accent,
    glass: (m.glass[0]!.material as THREE.MeshStandardMaterial).color.getHex(),
  };
}

function firstWear(car: DeformableCar): Worn {
  const m = car.lookMeshes();
  const base = baseOf(car);
  const bumpers: THREE.Mesh[] = [];
  car.group.traverse((o) => {
    if (o instanceof THREE.Mesh && o.material === trimMaterial(base.bumpers)) bumpers.push(o);
  });
  const w: Worn = {
    uniforms: sprayUniforms(CAR_SPRAY, BARE_SPRAY, 1),
    hood: makePaintMaterial(base.body),
    trunk: makePaintMaterial(base.body),
    doors: makePaintMaterial(base.doors),
    bumpers,
    base,
  };
  m.hood.material = w.hood;
  m.trunk.material = w.trunk;
  for (const door of m.doors) door.material = w.doors;
  for (const paint of [m.bodyPaint, w.hood, w.trunk, w.doors]) {
    applySpray(paint, w.uniforms, "attribute vec3 sprayPos;\nattribute vec3 sprayNrm;", "vSprayP = sprayPos;\nvSprayN = sprayNrm;\nvSprayRow = 0.0;", "car");
  }
  for (const mesh of [m.body, m.hood, m.trunk, ...m.doors]) restFrame(mesh, car.group);
  return w;
}

/**
 * `sprayPos` / `sprayNrm` on `mesh`'s geometry: each vertex and its normal in the car's frame, read off the mesh as it is now
 * through its parents up to `group`.
 */
// ponytail: read off the car as it is at its first look (a fresh car in the garage or at a join); a car already dented or with a lid open then maps its paint off that shape. Read the rest arrays if a dented car ever wears one.
function restFrame(mesh: THREE.Mesh, group: THREE.Object3D): void {
  _m.identity();
  for (let o: THREE.Object3D | null = mesh; o && o !== group; o = o.parent) {
    o.updateMatrix();
    _m.premultiply(o.matrix);
  }
  _n.getNormalMatrix(_m);
  const geo = mesh.geometry;
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  const outP = new Float32Array(pos.count * 3);
  const outN = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    _v.fromBufferAttribute(pos, i).applyMatrix4(_m).toArray(outP, i * 3);
    _v.fromBufferAttribute(nrm, i).applyMatrix3(_n).normalize().toArray(outN, i * 3);
  }
  geo.setAttribute("sprayPos", new THREE.BufferAttribute(outP, 3));
  geo.setAttribute("sprayNrm", new THREE.BufferAttribute(outN, 3));
}
