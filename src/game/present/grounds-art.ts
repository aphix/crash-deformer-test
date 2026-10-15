import type * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import type { LawnGuard } from "../scenes/lawn-guard.ts";
import type { Ground } from "../world/ground.ts";
import type { GuardSpec } from "../world/track-schema.ts";
import type { DriverLook } from "./driver-look.ts";
import { GuardSquad, People, VipEscort } from "./people.ts";

/** What the grounds' people need from the race each frame: the sparks of a hit, and the dummies' world for the VIP's throw. */
export type GroundsHost = {
  sparks: (at: THREE.Vector3, normal: THREE.Vector3, impulse: number) => void;
  throwPassenger: (car: number, look: DriverLook) => void;
};

/**
 * A guarded course's people (`GuardSpec`): its guard squad, and the VIP who comes out instead once the course's secret is out,
 * drawn as one set of figures (`People`): slots 0 to `count` - 1 the guards, the last the VIP.
 */
export class GroundsArt {
  private readonly people: People;
  private readonly squad: GuardSquad;
  private readonly vip: VipEscort;

  constructor(spec: GuardSpec, ground: Ground, parent: THREE.Object3D) {
    this.people = new People(spec.count + 1);
    this.squad = new GuardSquad(spec, ground, this.people);
    this.vip = new VipEscort(spec, ground, this.people, spec.count);
    parent.add(this.people.group);
  }

  /** A race starts: everyone back inside. */
  reset(): void {
    this.squad.reset();
    this.vip.reset();
  }

  /**
   * One frame of `dt` s: the guards by the sim's `guard` (none on a netplay client: they stay in), the VIP once `secretOut`, for
   * `player`, the car this browser drives (-1 none).
   */
  frame(dt: number, guard: LawnGuard | null, secretOut: boolean, cars: readonly DeformableCar[], player: number, host: GroundsHost): void {
    if (guard) this.squad.frame(dt, guard, cars, host.sparks);
    this.vip.frame(dt, secretOut, player, cars, host.throwPassenger);
    this.people.update(dt);
  }

  dispose(): void {
    this.people.dispose();
  }
}
