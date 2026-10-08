import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import { GarageArt, GARAGE } from "../present/garage-art.ts";
import type { SprayBitmap } from "../present/spray.ts";
import type { PlayerLooks, SprayTarget } from "./player-looks.ts";
import type { SprayTool } from "../hud/hud-store.ts";

/** The screen box the pointer's client coordinates are read in (the canvas's `getBoundingClientRect`). */
type Rect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
type PointerMove = { readonly clientX: number; readonly clientY: number; getCoalescedEvents?(): readonly { readonly clientX: number; readonly clientY: number }[] };

/** The can's radius range (m), and what it starts at. */
export const SPRAY_RADIUS = { min: 0.02, max: 0.3, start: 0.06 } as const;
/** Along a drag, a puff every this many dot radii of the stroke's travel (world), so a fast drag leaves a line, not dots. */
const PUFF_STEP = 0.5;

const _ndc = new THREE.Vector2();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();

/**
 * The garage's runtime: its set (`GarageArt`) and the spray can. With the can on, a press on the car or the driver sprays
 * (the camera's drag never starts) and a drag keeps spraying along the stroke; a press elsewhere still turns the camera.
 * Mouse and touch alike (pointer events, through the camera's `take`).
 */
export class Garage {
  readonly art = new GarageArt();
  readonly tool: SprayTool = { on: false, radius: SPRAY_RADIUS.start, colour: 4 };
  private readonly camera: THREE.Camera;
  private readonly rect: () => Rect;
  private readonly car: () => DeformableCar | undefined;
  private readonly looks: PlayerLooks;
  private readonly onSprayed: (target: SprayTarget) => void;
  private readonly ray = new THREE.Raycaster();
  /** The stroke's target while the pointer is down, and the last point sprayed (world). */
  private target: SprayTarget | null = null;
  private readonly last = new THREE.Vector3();

  constructor(camera: THREE.Camera, rect: () => Rect, car: () => DeformableCar | undefined, looks: PlayerLooks, onSprayed: (target: SprayTarget) => void) {
    this.camera = camera;
    this.rect = rect;
    this.car = car;
    this.looks = looks;
    this.onSprayed = onSprayed;
  }

  down(x: number, y: number): boolean {
    if (!this.tool.on) return false;
    this.target = this.puff(x, y, null);
    return this.target !== null;
  }

  move(e: PointerMove): void {
    if (this.target === null) return;
    const samples = e.getCoalescedEvents?.() ?? [];
    for (const s of samples.length > 0 ? samples : [e]) this.puff(s.clientX, s.clientY, this.target);
  }

  up(): void {
    if (this.target === null) return;
    this.looks.save(this.target);
    this.onSprayed(this.target);
    this.target = null;
  }

  /**
   * Spray at client (x, y): the nearest of the car's paint and the driver under it (only `only`, once a stroke has its
   * target), with puffs filled in from the last point so a fast drag leaves a line, not dots. Returns what it sprayed, or null.
   */
  private puff(x: number, y: number, only: SprayTarget | null): SprayTarget | null {
    const r = this.rect();
    _ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(_ndc, this.camera);
    const car = this.car();
    const m = car?.lookMeshes();
    const meshes: THREE.Object3D[] = only === "person" || !m ? [] : [m.body, m.hood, m.trunk, ...m.doors];
    if (only !== "car") meshes.push(this.art.dummy);
    const hit = this.ray.intersectObjects(meshes, false)[0];
    if (!hit?.face) return null;
    const target: SprayTarget = hit.object === this.art.dummy ? "person" : "car";
    const bitmap = this.looks.sprayOf(target);
    // A stroke's first puff lands where it is; the next ones fill in from the last point sprayed.
    const from = only === null ? hit.point : this.last;
    const steps = Math.max(1, Math.ceil(from.distanceTo(hit.point) / (this.tool.radius * PUFF_STEP)));
    for (let k = 1; k <= steps; k++) {
      _p.lerpVectors(from, hit.point, k / steps);
      this.restPoint(hit, car, bitmap);
    }
    this.last.copy(hit.point);
    if (target === "person") this.art.dummy.spray(0, bitmap);
    return target;
  }

  /**
   * One puff at world point `_p` on what `hit` met (the driver, else `car`), its normal taken from the hit's face, both moved
   * into the thing's rest frame.
   */
  private restPoint(hit: THREE.Intersection, car: DeformableCar | undefined, bitmap: SprayBitmap): void {
    _n.copy(hit.face!.normal);
    if (hit.object === this.art.dummy) {
      this.art.dummy.getMatrixAt(hit.instanceId!, _m);
      _n.applyMatrix3(_nm.getNormalMatrix(_m));
      _p.sub(GARAGE.person);
    } else if (car) {
      _n.transformDirection(hit.object.matrixWorld).applyQuaternion(car.group.getWorldQuaternion(_q).invert());
      car.group.worldToLocal(_p);
    }
    bitmap.spray(_p, _n, this.tool.radius, this.tool.colour, Math.random);
  }

  dispose(): void {
    this.art.dispose();
  }
}
