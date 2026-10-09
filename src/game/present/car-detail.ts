import * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";

/**
 * Distance detail, one rule for every car in every scene. Seen from the camera (m, at the 50 degree lens the game frames with),
 * a car (never the followed one) goes through two cuts as it gets further:
 *
 * - beyond `mid` it drops its small parts that cast no shadow (trims, grille, mirrors, door linings, glass: 12 of its 20 draws) and
 *   its 4 lamps from the lamp batch. They are a few pixels there; body, interior, panels and wheels stay, and so do the hood,
 *   boot lid, doors and bumpers (`flushCasters`), whether or not they cast right now.
 * - beyond `far` it draws its body alone: the interior, the panels, the wheels and every flush part (bumpers, hood, trunk, doors)
 *   leave the camera too, a wreck's as well as a whole car's (at 50 m a car is ~20 px on the phone and the body carries the paint
 *   and the dents). Only the police light bar stays: it is how a cop reads from afar. Loose bodies (a torn door, a dropped wheel)
 *   are not the car's meshes and keep drawing.
 *
 * Both cuts take meshes off the camera's layer 0 (so out of the shadow pass too), never `visible`, which stays the car's own
 * (broken lamps, loose parts). Each comes back within `BACK` of its distance (hysteresis). A car the camera frames (`keep`: the
 * followed car, a replay's focus) is never cut, and a narrower lens counts a car nearer by the ratio of its half-angle's tangent to
 * the 50 degree lens's, so a zoom on a far car sees it whole. `DETAIL_LEVELS` is the ladder `DetailGovernor` walks.
 */
interface DetailLevel {
  /** Distance (m) beyond which the small parts go. */
  readonly mid: number;
  /** Distance (m) beyond which only the body is drawn. */
  readonly far: number;
}

export const DETAIL_LEVELS: readonly DetailLevel[] = [
  { mid: 35, far: 75 },
  { mid: 30, far: 60 },
  { mid: 25, far: 50 },
  { mid: 20, far: 40 },
  { mid: 15, far: 30 },
];
/** The rung a phone starts on: a ~20 px car at 50 m loses nothing the eye can use, and the frame it saves is the one it needs. */
export const PHONE_LEVEL = 2;
/** A cut ends when the car is within this share of the distance that started it. */
const BACK = 0.92;
const REF_HALF_TAN = Math.tan(THREE.MathUtils.degToRad(25));

/** What one car has taken off the camera's layer: the small parts (`mid`) and the rest of its meshes bar the body (`far`); null: not cut. */
interface Cut {
  mid: THREE.Object3D[] | null;
  far: THREE.Object3D[] | null;
}

const _eye = new THREE.Vector3();

/** The small parts a mid cut takes: the lamp seats and the plain meshes that cast no shadow. A hinged panel's shell stays (the body under it is primer). */
function takeMid(car: DeformableCar): THREE.Object3D[] {
  const parts: THREE.Object3D[] = [];
  car.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (o.name !== "lamp" && (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || m.castShadow || car.flushCasters.includes(m) || m.name === "interior" || m.name === "panel")) return;
    m.layers.disable(0);
    parts.push(m);
  });
  return parts;
}

/** What a far cut takes beyond the mid cut: every other mesh of the car but its body and light bar. */
function takeFar(car: DeformableCar): THREE.Object3D[] {
  const parts: THREE.Object3D[] = [];
  car.group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || m === car.body || m.name === "lightBar" || !m.layers.isEnabled(0)) return;
    m.layers.disable(0);
    parts.push(m);
  });
  return parts;
}

function give(parts: readonly THREE.Object3D[]): void {
  for (let i = 0; i < parts.length; i++) parts[i]!.layers.enable(0);
}

export class CarDetail {
  /** The rung in force (an index into `DETAIL_LEVELS`; -1 while `setDistances` holds other numbers). */
  level = 0;
  /** Squared distances (m^2 at the 50 degree lens): a cut starts beyond `mid2`/`far2` and ends within `midBack2`/`farBack2`. */
  private mid2 = 0;
  private midBack2 = 0;
  private far2 = 0;
  private farBack2 = 0;
  private readonly cuts = new WeakMap<DeformableCar, Cut>();

  constructor(level = 0) {
    this.setLevel(level);
  }

  /** Put the ladder's rung `i` in force (clamped); the next `update` moves the cars. */
  setLevel(i: number): void {
    const at = Math.min(DETAIL_LEVELS.length - 1, Math.max(0, i));
    const l = DETAIL_LEVELS[at]!;
    this.setDistances(l.mid, l.far);
    this.level = at;
  }

  /** The two distances by hand (m; Infinity: that cut never starts), for the bench's A/B. */
  setDistances(mid: number, far: number): void {
    this.mid2 = mid * mid;
    this.midBack2 = this.mid2 * BACK * BACK;
    this.far2 = far * far;
    this.farBack2 = this.far2 * BACK * BACK;
    this.level = -1;
  }

  /** Whether `car` is cut to its body alone right now: the wheel batch draws it its far wheels (`WheelBatch.sync`). */
  isFar(car: DeformableCar): boolean {
    return this.cuts.get(car)?.far != null;
  }

  /** Once a frame, after the camera and the sim have settled and before the draw. `keepA` and `keepB` are never cut. */
  update(cars: readonly DeformableCar[], camera: THREE.PerspectiveCamera, keepA: DeformableCar | null, keepB: DeformableCar | null): void {
    _eye.setFromMatrixPosition(camera.matrixWorld);
    const lens = Math.tan(THREE.MathUtils.degToRad(camera.fov * 0.5)) / REF_HALF_TAN;
    const lens2 = lens * lens;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      let cut = this.cuts.get(car);
      const p = car.group.position;
      const dx = p.x - _eye.x;
      const dy = p.y - _eye.y;
      const dz = p.z - _eye.z;
      const d2 = (dx * dx + dy * dy + dz * dz) * lens2;
      const keep = car === keepA || car === keepB;
      const mid = !keep && d2 > (cut !== undefined && cut.mid !== null ? this.midBack2 : this.mid2);
      const far = mid && d2 > (cut !== undefined && cut.far !== null ? this.farBack2 : this.far2);
      if (cut === undefined) {
        if (!mid) continue;
        cut = { mid: null, far: null };
        this.cuts.set(car, cut);
      }
      // Entering: the mid cut first, so the far cut skips what it already took; leaving: the far cut first, the mid cut last.
      if (mid && cut.mid === null) cut.mid = takeMid(car);
      if (far !== (cut.far !== null)) {
        if (far) cut.far = takeFar(car);
        else {
          give(cut.far!);
          cut.far = null;
        }
      }
      if (!mid && cut.mid !== null) {
        give(cut.mid);
        cut.mid = null;
      }
    }
  }
}
