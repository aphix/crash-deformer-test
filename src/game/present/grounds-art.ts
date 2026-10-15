import type * as THREE from "three";
import type { DeformableCar } from "../vehicle/car.ts";
import type { FigureStrike } from "../scenes/figure-strike.ts";
import type { LawnGuard } from "../scenes/lawn-guard.ts";
import type { Ground } from "../world/ground.ts";
import type { GuardSpec } from "../world/track-schema.ts";
import type { DriverLook } from "./driver-look.ts";
import { GuardSquad, People, VIP_SLOT, VipEscort } from "./people.ts";

/** What the grounds' people need from the race each frame: the sparks of a shot's hit (at the car's surface, off the face's `normal`), and the dummies' world for the VIP's throw out of his car (`throwPassenger`) and where a car runs him down (`throwFigure`). */
export type GroundsHost = {
  sparks: (at: THREE.Vector3, normal: THREE.Vector3) => void;
  throwPassenger: (car: number, look: DriverLook) => void;
  throwFigure: (strike: FigureStrike) => void;
};

/**
 * A guarded course's people (`GuardSpec`): its guard squad, and the VIP who comes out instead once the course's secret is out,
 * drawn as one set of figures (`People`): the VIP in slot `VIP_SLOT`, the guards after him.
 */
export class GroundsArt {
  private readonly people: People;
  private readonly squad: GuardSquad;
  private readonly vip: VipEscort;

  constructor(spec: GuardSpec, ground: Ground, parent: THREE.Object3D) {
    this.people = new People(spec.count + 1);
    this.squad = new GuardSquad(spec, ground, this.people);
    this.vip = new VipEscort(spec, ground, this.people, VIP_SLOT);
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
    if (guard) this.squad.frame(guard, cars, host.sparks);
    this.vip.frame(dt, secretOut, player, cars, host.throwPassenger, host.throwFigure);
    this.people.update(dt);
  }

  dispose(): void {
    this.people.dispose();
  }
}
