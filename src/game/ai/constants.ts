/**
 * Slots of the tune buffer a brain hands `guardContact` (`contact-guard.ts`, called per car per step). A number passed to a
 * call V8 does not inline is boxed on the heap; a slot the caller writes and the guard reads is not.
 */
export const GUARD_BRAKE_IDX = 0; // m/s²: what the car can brake at (the guard's share of it)
export const GUARD_LEAD_IDX = 1; // m/s²: what a car ahead is taken to brake at
export const GUARD_TURN_IDX = 2; // rad/s: yaw rate at full lock
export const GUARD_COUNT = 3;
