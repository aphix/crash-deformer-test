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

export type CrushBands = { yield: number; middle: number; max: number };

export function regionSoftness(name: string): number;
export function crushGate(closing: number, softness: number): number;
export function dtImpulseScale(dt: number): number;
export function closingKeScale(closing: number): number;
export function regionCrushBands(name: string): CrushBands;
export function forceTransfer(travel: number, bands: CrushBands, packed: boolean): number;
export function leftoverPass(remain: number, pass: number): number;
export function leftoverCrumple(travel: number): number;
export function crushStroke(ebs: number, squash: number): number;
export function cancelClosing(closing: number, pass: number, invSum: number, dt: number, e?: number): number;
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
