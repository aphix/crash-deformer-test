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

export function clamp(n: number, lo: number, hi: number): number;
export function regionSoftness(name: string): number;
export function crushGate(closing: number, softness: number): number;
export function dtImpulseScale(dt: number): number;
export function closingKeScale(closing: number): number;
export function regionCrushBands(name: string): CrushBands;
export function forceTransfer(travel: number, bands: CrushBands, packed: boolean): number;
export function leftoverPass(remain: number, pass: number): number;
export function leftoverCrumple(travel: number): number;
export function cancelClosing(closing: number, pass: number, invSum: number, dt: number, e?: number): number;
export function satPushCap(dt: number): number;
export function round4(n: number): number;
