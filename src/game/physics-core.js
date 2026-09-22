// @ts-nocheck
"use strict";

/**
 * Number-only crash kernels. Plain JS — no TS transform, no THREE.
 * physics-util.ts re-exports these and adds Vector3 helpers.
 */

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

const CRASH = {
  pulseSec: 0.12,
  crushMeters: 0.65,
  muPeak: 0.9,
  muSlide: 0.75,
  muScuff: 0.4,
  grazeMps: 1.8,
  maxMassMps: 55,
};

const TRANSFER = {
  belowMiddle: 0.1,
  atMiddle: 0.5,
  above: 0.62,
  packed: 1,
};

const FRONTAL_REF = 14;

function regionSoftness(name) {
  if (name.startsWith("bumper")) return 1;
  if (name.startsWith("wing")) return 0.78;
  if (name === "engineL" || name === "engineR") return 0.16;
  if (name.startsWith("rail")) return 0.3;
  if (name.startsWith("door")) return 0.22;
  if (name === "tank" || name === "axleR") return 0.34;
  if (name === "roof" || name === "cell") return 0.08;
  if (name.startsWith("hub")) return 0.06;
  return 0.2;
}

function crushGate(closing, softness) {
  const v = closing > 0 ? closing : 0;
  const min = CRASH.grazeMps + (1 - softness) * 9;
  const fatal = 7 + (1 - softness) * 26;
  if (v <= min) return 0;
  return clamp((v - min) / Math.max(0.5, fatal - min), 0, 1);
}

function dtImpulseScale(dt) {
  return clamp(dt * 60, 0.04, 1.2);
}

function closingKeScale(closing) {
  const v = closing > 0 ? closing : 0;
  return clamp((v * v) / (FRONTAL_REF * FRONTAL_REF), 0, 2.4);
}

function regionCrushBands(name) {
  const soft = regionSoftness(name);
  const max = 0.12 + soft * 0.72;
  return { yield: max * 0.16, middle: max * 0.48, max };
}

function forceTransfer(travel, bands, packed) {
  if (packed) return TRANSFER.packed;
  const t = travel > 0 ? travel : 0;
  if (t < bands.middle) return TRANSFER.belowMiddle;
  if (t < bands.max) return TRANSFER.atMiddle;
  return TRANSFER.above;
}

function leftoverPass(remain, pass) {
  return (remain > 0 ? remain : 0) * clamp(pass, 0, 1);
}

function leftoverCrumple(travel) {
  return clamp(travel / 1.5, 0, 1);
}

function cancelClosing(closing, pass, invSum, dt, e) {
  if (e === undefined) e = 0;
  if (closing <= 1e-6 || invSum < 1e-12) return 0;
  const used = leftoverPass(closing, pass);
  const dtS = dtImpulseScale(dt);
  const bounce = 1 + clamp(e, 0, 0.08);
  const dv = Math.min(used * dtS * bounce, closing * bounce);
  return dv / invSum;
}

function satPushCap(dt) {
  return 0.01 + 0.08 * dtImpulseScale(dt);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export {
  clamp,
  CRASH,
  TRANSFER,
  regionSoftness,
  crushGate,
  dtImpulseScale,
  closingKeScale,
  regionCrushBands,
  forceTransfer,
  leftoverPass,
  leftoverCrumple,
  cancelClosing,
  satPushCap,
  round4,
};
