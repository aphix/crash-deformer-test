import * as THREE from "three";

const _e = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Critically damped spring, exact for any dt: no overshoot, ~98% settled after 6/omega s. */
export class Spring {
  x = 0;
  v = 0;

  step(target: number, omega: number, dt: number): number {
    const e = this.x - target;
    const t = (this.v + omega * e) * dt;
    const k = Math.exp(-omega * dt);
    this.v = (this.v - omega * t) * k;
    this.x = target + (e + t) * k;
    return this.x;
  }

  snap(x: number): void {
    this.x = x;
    this.v = 0;
  }
}

/** Vector critically damped spring; `v` is relative to whatever frame the caller carries `x` in. */
export class Spring3 {
  readonly x = new THREE.Vector3();
  readonly v = new THREE.Vector3();

  step(target: THREE.Vector3, omega: number, dt: number): void {
    const k = Math.exp(-omega * dt);
    _e.subVectors(this.x, target);
    _t.copy(this.v).addScaledVector(_e, omega).multiplyScalar(dt);
    this.v.addScaledVector(_t, -omega).multiplyScalar(k);
    this.x.copy(target).addScaledVector(_e.add(_t), k);
  }

  snap(x: THREE.Vector3): void {
    this.x.copy(x);
    this.v.set(0, 0, 0);
  }
}
