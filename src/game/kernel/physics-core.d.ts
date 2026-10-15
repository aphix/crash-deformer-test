export const CRASH: {
  readonly pulseSec: number;
  readonly crushMeters: number;
  readonly muPeak: number;
  readonly muSlide: number;
  readonly muScuff: number;
  readonly grazeMps: number;
  readonly maxMassMps: number;
};

export const TRANSFER: {
  readonly belowMiddle: number;
  readonly atMiddle: number;
  readonly above: number;
  readonly packed: number;
};

export const PART_FAMILY: {
  readonly bumper: "bumper";
  readonly wing: "wing";
  readonly rail: "rail";
  readonly door: "door";
  readonly hub: "hub";
  readonly mirror: "mirror";
  readonly quarter: "quarter";
};

export type CrushBands = { yield: number; middle: number; max: number };

export function regionSoftness(name: string): number;
export function crushGate(closing: number, softness: number): number;
export function dtImpulseScale(dt: number): number;
export function closingKeScale(closing: number): number;
export function regionCrushBands(name: string): CrushBands;
export function forceTransfer(travel: number, bands: CrushBands, packed: boolean): number;
export function leftoverCrumple(travel: number): number;
export function crushStroke(ebs: number, squash: number): number;
export function satPushCap(dt: number): number;
export function round4(n: number): number;
/** Math.hypot, bit for bit, without the builtin call (allocation-free once inlined). */
export function hypot2(x: number, y: number): number;
export function hypot3(x: number, y: number, z: number): number;
/** Math.sin and Math.cos from + − × ÷ only: the same bits in every engine, under 1 ulp from correctly rounded for |x| < 1.6e6. */
export function detSin(x: number): number;
export function detCos(x: number): number;
/** `detSin(v[i])` to `v[i]` and `detCos(v[i])` to `v[i + 1]`, bit-equal to the two calls, boxing nothing when not inlined. */
export function sinCosAt(v: Float64Array, i: number): void;
/** Math.atan, Math.atan2, Math.asin and Math.acos from + − × ÷ and sqrt only: fdlibm's, the same bits in every engine, under 1 ulp from correctly rounded. `detAsin` and `detAcos` return NaN outside [-1, 1]. */
export function detAtan(x: number): number;
export function detAtan2(y: number, x: number): number;
export function detAsin(x: number): number;
export function detAcos(x: number): number;
