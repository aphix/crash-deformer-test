import type { DeformableCar } from "../vehicle/car.ts";
import { sideContact, type PropHits } from "../contact/prop-contact.ts";
import type { FleetRamps } from "./fleet-ramps.ts";

const NO_HITS: PropHits = { knock() {}, fx() {}, wall() {} };

/** The world's end-of-slice hook for a scene on `ramps`: the ramps' prisms follow the slab, then the car's points meet their sides (`engine-scenes.ts` `rampCollide`). */
export function collideOn(ramps: FleetRamps): (car: DeformableCar, i: number, h: number) => void {
  return (car, _i, h) => {
    ramps.sync();
    sideContact(car, ramps, NO_HITS, h);
  };
}
