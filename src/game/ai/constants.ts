/**
 * Slots of the tune buffer a brain hands `guardContact` (`contact-guard.ts`, called per car per step). A number passed to a
 * call V8 does not inline is boxed on the heap; a slot the caller writes and the guard reads is not.
 */
export const GUARD_BRAKE_IDX = 0; // m/s²: what the car can brake at (the guard's share of it)
export const GUARD_LEAD_IDX = 1; // m/s²: what a car ahead is taken to brake at
export const GUARD_TURN_IDX = 2; // rad/s: yaw rate at full lock
export const GUARD_COUNT = 3;
/** The throttle a unit backs out with (a share of reverse): full is more than the drive can use. */
export const REVERSE_THROTTLE = -0.9;
/** The throttle a unit crawls forward at while its lock swings the nose round (facing the wrong way, or pinned against the boards). */
export const TURN_ROUND_THROTTLE = 0.6;
/** A road's curvature (1/m) below this is a straight: no corner to slow for. */
export const STRAIGHT_CURV = 1e-4;
/** The AI difficulties a race offers (menu order). */
export const AI_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type AiDifficulty = (typeof AI_DIFFICULTIES)[number];
/** The difficulty whose rivals think every physics slice (today's AI, bit for bit); the default. */
export const AI_EVERY_SLICE: AiDifficulty = AI_DIFFICULTIES[2];
/** Think rate band per difficulty (Hz of sim time); each rival rolls its own rate in the band once (`hash01`, salt `THINK_SALT`). `hard` is documentation: it thinks every slice. */
export const THINK_HZ: Readonly<Record<AiDifficulty, readonly [number, number]>> = { hard: [192, 240], medium: [96, 192], easy: [8, 20] };
/** `hash01` salt of a rival's think rate roll (`personality.ts` takes 2-10). */
export const THINK_SALT = 11;
type Range = readonly [number, number];
/**
 * Per-tier skill a rival rolls once (`lo+(hi-lo)*hash01(id, SKILL_SALT.k)`). `push` scales the corner speed it plans for, `brake` the braking it plans for,
 * `steer` its steering gain, `look` its look-ahead, `apex` how far it uses the road toward an apex, `wobble` (m) the amplitude of its seeded sway about the line.
 * `slipP` is its chance per corner entry of a mistake: for `SLIP_WINDOW` s it plans corners at `slipPush` x the speed and braking at `slipBrake` x the decel
 * (past the grip reserve, so it arrives too fast), then for `SLIP_RECOVER` s it is shaken and holds to `shaken` x top speed.
 * `calm` (m): another car this close makes it drive as `hard` until the road is open again (0: only a car it follows or swerves for does). Medium keeps
 * its errors to an open road, so a gentle medium field never touches; easy errs in traffic too and may bump.
 * Every `push` stays at or under 1: the tiers corner no faster than `hard` except inside a mistake. `hard` is exactly 1 / 0 everywhere: today's AI, bit for bit.
 * Easy's `push` is set where its oval winner runs about 10 % behind hard's, with room over the 8 % floor (`race-ai.test.ts`): the owner asked for easy a little less easy.
 * The AI plans its stops at the guard's 0.72 of the class brake (`BRAKE_SHARE`; it was 0.5), which took 1.7 s off hard's oval (52.1 to 50.4 s). Oval easy, each car planning
 * with its class: 0.76–0.84 reads 57.0 s (13.2 % behind hard), 0.78–0.86 reads 55.6 s (10.4 %; four-count 304 s, 12.8 %), 0.79–0.87 reads 54.9 s (9.0 %).
 * Easy's `slipBrake` keeps a mistake's planned braking where it was, 1.25 x the class brake, past what the car sheds (2.5 x 0.5 then, 1.75 x 0.72 now; at 2.5 x 0.72 four-count's easy mean lap read 116 s against 106 s).
 */
type AiSkill = { push: Range; brake: Range; steer: Range; look: Range; apex: Range; wobble: Range; slipP: Range; slipPush: number; slipBrake: number; shaken: number; calm: number };
export const AI_SKILL: Record<AiDifficulty, AiSkill> = {
  easy: { push: [0.78, 0.86], brake: [0.6, 0.9], steer: [0.85, 0.95], look: [0.75, 0.95], apex: [0.5, 0.9], wobble: [0.4, 0.9], slipP: [0.3, 0.5], slipPush: 1.3, slipBrake: 1.75, shaken: 0.65, calm: 0 },
  medium: { push: [0.97, 1.0], brake: [0.95, 1.0], steer: [0.97, 1.0], look: [0.95, 1.0], apex: [0.9, 1.0], wobble: [0.05, 0.2], slipP: [0.05, 0.1], slipPush: 1.1, slipBrake: 1.5, shaken: 0.93, calm: 40 },
  hard: { push: [1, 1], brake: [1, 1], steer: [1, 1], look: [1, 1], apex: [1, 1], wobble: [0, 0], slipP: [0, 0], slipPush: 1, slipBrake: 1, shaken: 1, calm: 0 },
};
export const SKILL_SALT = { push: 40, brake: 41, steer: 42, look: 43, apex: 44, wobble: 45, phase: 46, slipP: 47, slipRoll: 48 } as const;
/**
 * A mistake overcooks for `SLIP_WINDOW` s, then holds back for `SLIP_RECOVER` s; the next waits `SLIP_COOL` s after one starts,
 * and a corner is "ahead" when the plan wants under `SLIP_CORNER` x top speed.
 */
export const SLIP_WINDOW = 1.5;
export const SLIP_RECOVER = 4;
export const SLIP_COOL = 8;
export const SLIP_CORNER = 0.85;
/** Wavelength (m) of the sway about the line, as rad per m of track. */
export const WOBBLE_K = (2 * Math.PI) / 30;
/** Seconds a car may think early: slices are float32, so a sum of them lands a hair under a whole think interval. */
export const THINK_DUE_SLACK = 1e-9;
