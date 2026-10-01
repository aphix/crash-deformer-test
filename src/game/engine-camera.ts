import * as THREE from "three";
import type { DeformableCar } from "./car.ts";
import type { DriverSeat } from "./car-drive.ts";

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** Mean car position (zero for an empty fleet). */
export function centroid(out: THREE.Vector3, cars: readonly DeformableCar[]): THREE.Vector3 {
  out.set(0, 0, 0);
  const n = cars.length;
  if (n === 0) return out;
  for (const car of cars) out.add(car.group.position);
  return out.multiplyScalar(1 / n);
}

/**
 * Orbit / chase / first-person rig over the shared PerspectiveCamera, plus canvas pointer input:
 * left-drag orbits (or turns the head while driving), wheel zooms, a short tap picks via `onClick`.
 */
export class ChaseCamera {
  /** Smoothed-toward eye position. */
  readonly pos = new THREE.Vector3(10, 6, 16);
  /** Look-at target; the engine aims it each frame before `orbit`. */
  readonly look = new THREE.Vector3();
  /** Screen-shake energy, decays in the engine tick. */
  trauma = 0;
  /** User dragged or zoomed since the last reset; cinematics stop re-aiming. */
  userFramed = false;
  private angle = 0;
  private radius = 14;
  private pitch = 0.4;
  private dragging = false;
  private lookDragging = false;
  private pointerTravel = 0;
  private lastX = 0;
  private lastY = 0;
  private readonly approachSide = new THREE.Vector3(1, 0, 0);

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    private readonly seat: DriverSeat,
    private readonly reduceMotion: boolean,
    private readonly onClick: (clientX: number, clientY: number) => void,
  ) {
    camera.position.copy(this.pos);
  }

  attach(): void {
    this.canvas.style.touchAction = "none";
    this.canvas.style.cursor = "grab";
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  detach(): void {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
  }

  /** Snap to the opening shot: fixed press angle, or broadside to the fleet's approach line. */
  frameReset(compactor: boolean, cars: readonly DeformableCar[]): void {
    this.userFramed = false;
    this.trauma = 0;
    if (compactor) {
      this.look.set(0, 0.55, 0);
      this.radius = 9.4;
      this.pitch = 0.44;
      this.angle = 0.85;
      const cp = Math.cos(this.pitch);
      this.pos.set(
        Math.sin(this.angle) * this.radius * cp,
        this.look.y + this.radius * Math.sin(this.pitch),
        Math.cos(this.angle) * this.radius * cp,
      );
    } else {
      if (cars.length >= 2) {
        _w.copy(cars[1]!.group.position).sub(cars[0]!.group.position).normalize();
      } else {
        _w.copy(cars[0]?.forward ?? _w.set(0, 0, 1));
      }
      this.approachSide.crossVectors(_w, _up).normalize();
      if (this.approachSide.lengthSq() < 0.1) this.approachSide.set(1, 0, 0);
      this.placeApproach(cars);
    }
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
    this.angle = Math.atan2(this.pos.x - this.look.x, this.pos.z - this.look.z);
    const dx = this.pos.x - this.look.x;
    const dy = this.pos.y - this.look.y;
    const dz = this.pos.z - this.look.z;
    this.radius = Math.hypot(dx, dy, dz);
    this.pitch = Math.asin(THREE.MathUtils.clamp(dy / Math.max(this.radius, 0.01), -0.99, 0.99));
  }

  /** Impact hit: shake, and unless the user framed the shot, orbit from where the camera is now. */
  kick(carCount: number): void {
    this.trauma = this.reduceMotion ? 0.15 : 0.85;
    if (!this.userFramed) {
      this.angle = Math.atan2(this.camera.position.x - this.look.x, this.camera.position.z - this.look.z);
      this.radius = THREE.MathUtils.clamp(this.radius + Math.max(0, carCount - 2) * 0.4, 8, 22);
    }
  }

  /** Ease toward the orbit around `look`; `spinRate` rad/s auto-rotates unless dragging or reduced motion. */
  orbit(wallDt: number, spinRate: number, shake: boolean): void {
    if (spinRate > 0 && !this.dragging && !this.reduceMotion) this.angle += spinRate * wallDt;

    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    this.pos.set(
      this.look.x + Math.sin(this.angle) * this.radius * cp,
      this.look.y + this.radius * sp,
      this.look.z + Math.cos(this.angle) * this.radius * cp,
    );

    const k = 1 - Math.exp((this.dragging ? -18 : -5.5) * wallDt);
    this.camera.position.lerp(this.pos, k);

    if (this.trauma > 0 && shake) {
      const s = this.trauma * this.trauma;
      const t = performance.now() * 0.017;
      this.camera.position.x += Math.sin(t * 37.1) * s * 0.28;
      this.camera.position.y += Math.cos(t * 29.4) * s * 0.18;
      this.camera.rotation.z = Math.sin(t * 21.2) * s * 0.025;
    } else {
      this.camera.rotation.z = 0;
    }
    this.camera.lookAt(this.look);
  }

  /** Chase (third) or cockpit (first) view of the driven car, head turned by the seat. */
  frameDrive(car: DeformableCar, wallDt: number): void {
    const speed = Math.hypot(car.velocity.x, car.velocity.z);
    const head = speed > 1.2 ? Math.atan2(car.velocity.x, car.velocity.z) : car.yaw;
    const yaw = head + this.seat.camYaw;
    const pitch = this.seat.camPitch;
    if (this.seat.view === "first") {
      const eye = _v.set(0.32, 1.08, 0.2);
      car.group.localToWorld(eye);
      this.pos.copy(eye);
      this.look.set(
        eye.x + Math.sin(yaw) * 8,
        eye.y + pitch * 2.2,
        eye.z + Math.cos(yaw) * 8,
      );
    } else {
      const dist = 7.4;
      this.pos.set(
        car.group.position.x - Math.sin(yaw) * dist,
        car.group.position.y + 2.4 + pitch * 0.6,
        car.group.position.z - Math.cos(yaw) * dist,
      );
      this.look.set(
        car.group.position.x + Math.sin(head) * 2.4,
        car.group.position.y + 0.85,
        car.group.position.z + Math.cos(head) * 2.4,
      );
    }
    const k = 1 - Math.exp(-12 * wallDt);
    this.camera.position.lerp(this.pos, k);
    this.camera.lookAt(this.look);
  }

  private placeApproach(cars: readonly DeformableCar[]): void {
    const mid = centroid(_v, cars);
    mid.y = 0.6;
    if (cars.length >= 2) {
      _w.copy(cars[1]!.group.position).sub(cars[0]!.group.position);
    } else {
      _w.copy(cars[0]?.forward ?? _w.set(0, 0, 1));
    }
    const dist = Math.max(_w.length(), 4);
    if (_w.lengthSq() > 1e-8) _w.normalize();
    else _w.set(0, 0, 1);
    const pull = THREE.MathUtils.lerp(16, 11, THREE.MathUtils.clamp(1 - dist / 28, 0, 1)) + Math.max(0, cars.length - 2) * 0.55;
    this.pos
      .copy(mid)
      .addScaledVector(this.approachSide, pull)
      .addScaledVector(_up, 5.2)
      .addScaledVector(_w, -1.4);
    this.look.copy(mid);
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    this.pointerTravel = 0;
    this.lookDragging = this.seat.mode === "drive";
    this.dragging = this.seat.mode !== "drive";
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.dragging) this.userFramed = true;
    this.canvas.setPointerCapture(e.pointerId);
    this.canvas.style.cursor = "grabbing";
  };

  private onPointerMove = (e: PointerEvent): void => {
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.pointerTravel += Math.hypot(dx, dy);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.lookDragging) {
      this.seat.nudgeLook(dx, dy);
      return;
    }
    if (!this.dragging) return;
    this.angle -= dx * 0.005;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.004, 0.08, 1.22);
  };

  private onPointerUp = (e: PointerEvent): void => {
    const click = this.pointerTravel < 8;
    this.dragging = false;
    this.lookDragging = false;
    this.canvas.style.cursor = "grab";
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (click) this.onClick(e.clientX, e.clientY);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const scale = Math.exp(e.deltaY * 0.00115);
    this.radius = THREE.MathUtils.clamp(this.radius * scale, 4.2, 32);
    this.userFramed = true;
  };
}
