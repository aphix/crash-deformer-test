import { HIT_SIZE } from "../world/surfaces.ts";

/** Where a `DeformableCar.flight` block holds each part: spin (3), pitch, yaw, roll (3), orientation quaternion (4), velocity (3), position (3), contact-end clocks (2), reach, squeeze flag, drift, the seconds the engine stays cut (`stalledS`), the weight borne on it by cars that stepped after it (6: `CarSurfaces.borneState`), what its wheels touch (`FLIGHT_CONTACT`: each wheel's contact, the wheels down, airborne, hard touch, yielding), a wreck's hub rise (`hubRise`, 5), its yaw inverse inertia (`invYaw`), its rest timer (`restS`: at `WRECK_REST_S` it sleeps), and the handbrake's grip and whether the boost was on (`drive.ebrakeK`, `drive.boostK`). */
export const FLIGHT_EULER = 3;
export const FLIGHT_QUATERNION = 6;
export const FLIGHT_VELOCITY = 10;
export const FLIGHT_POSITION = 13;
export const FLIGHT_END_AGO = 16;
export const FLIGHT_END_REACH = 18;
export const FLIGHT_END_SQUEEZE = 19;
export const FLIGHT_DRIFT = 20;
export const FLIGHT_STALL = 21;
export const FLIGHT_BORNE = 22;
export const FLIGHT_CONTACT = 28;
export const FLIGHT_DOWN = FLIGHT_CONTACT + 4 * HIT_SIZE;
export const FLIGHT_INV_YAW = FLIGHT_DOWN + 4;
export const FLIGHT_REST = FLIGHT_INV_YAW + 1;
export const FLIGHT_RAMPS = FLIGHT_REST + 1;
export const FLIGHT = FLIGHT_RAMPS + 2;
