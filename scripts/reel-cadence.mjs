// Input cadence of saved clips: per clip and car, steer sign changes per minute, handbrake seconds and boost seconds.
// Usage: node scripts/reel-cadence.mjs <file>...
// A file is the base64 text `encodeSaved` makes (a localStorage clip), or a flag submission's JSON (`payload.clip`).
// The reel stores no lap boundaries, so a clip (one highlight) is the unit.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { DeformableCar } from "../src/game/vehicle/car.ts";
import { carLayout } from "../src/game/net/car-pose.ts";
import { decodeSaved } from "../src/game/net/reel-codec.ts";
import { INPUT_BYTES } from "../src/game/match/highlights.ts";

/** Flag bits of a step's last input byte (`engine-record.ts` `endStep`). */
const EBRAKE = 1;
const BOOST = 2;

/** The clip's base64 text from a saved-clip file or a submission envelope. */
function clipText(path) {
  const raw = readFileSync(path, "utf8").trim();
  if (!raw.startsWith("{")) return raw;
  const json = JSON.parse(raw);
  const text = json.payload?.clip ?? json.clip;
  if (typeof text !== "string") throw new Error("JSON has no payload.clip");
  return text;
}

const layout = carLayout(new DeformableCar({ body: 0, accent: 0, name: "layout" }, new THREE.Scene()));
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node scripts/reel-cadence.mjs <clip file>...");
  process.exit(2);
}
let failed = false;
for (const path of files) {
  const clip = await decodeSaved(clipText(path), layout);
  if (typeof clip === "string") {
    console.log(`${path}: cannot decode (${clip})`);
    failed = true;
    continue;
  }
  const nc = clip.cars.length;
  const steps = clip.h.length;
  let seconds = 0;
  for (let s = 0; s < steps; s++) seconds += clip.h[s];
  console.log(`${path}: ${clip.trackId}, ${nc} cars, ${steps} steps, ${seconds.toFixed(2)} s from t0 ${clip.t0.toFixed(2)}`);
  for (let c = 0; c < nc; c++) {
    let flips = 0;
    let last = 0;
    let ebrake = 0;
    let boost = 0;
    for (let s = 0; s < steps; s++) {
      const o = (s * nc + c) * INPUT_BYTES;
      const steer = (clip.inputs[o + 1] << 24) >> 24;
      const sign = Math.sign(steer);
      if (sign !== 0) {
        if (last !== 0 && sign !== last) flips++;
        last = sign;
      }
      const flags = clip.inputs[o + 3];
      if (flags & EBRAKE) ebrake += clip.h[s];
      if (flags & BOOST) boost += clip.h[s];
    }
    const perMin = seconds > 0 ? (flips * 60) / seconds : 0;
    console.log(`  ${String(c).padStart(2)} ${clip.cars[c].name.padEnd(12)} steer flips/min ${perMin.toFixed(1).padStart(6)}  ebrake ${ebrake.toFixed(2)} s  boost ${boost.toFixed(2)} s`);
  }
}
process.exit(failed ? 1 : 0);
