import { FLIGHT } from "../vehicle/car.ts";
import { CAR_STYLE_IDS } from "../vehicle/car-variants.ts";
import { VEHICLE_CLASS_IDS } from "../vehicle/vehicle-classes.ts";
import { FINE_PEDALS, INPUT_BYTES, MEMORY, simFingerprint, type ClipEjection, type HighlightClip, type Reel, type ReelCar } from "../match/highlights.ts";
import { blankEjection } from "../vehicle/ejection.ts";
import { makeSnapshot, MAX_NET_CARS, MSG, NET_VERSION, readEjection, readSnapshot, Reader, writeEjection, Writer, type NetLayout } from "./codec.ts";

/**
 * Highlight clips on the wire and in storage (docs/HIGHLIGHTS.md): one byte layout for the `MSG.reel` message and a
 * saved clip. A clip's keyframes are netplay snapshot messages (`writeSnapshot`) of its cars, kept as bytes, so a host,
 * its clients and a saved copy replay the very same numbers. Little-endian.
 */

/**
 * Clip layout version: bump on any change to `writeClip` or to a keyframe's bytes after its snapshot (2: each car's
 * flight block and solver state; 3: that state XORed on the car's previous keyframe's; 4: the solver state's
 * wreck-flight scalars `aloft`, `floorsFresh`, `frameY`, `frameAt`, `frameVy`; 5: the race's driver-look seed after
 * the deform mode; 6: `ejects` and the ejections tail, a thrown driver's step and launch numbers; 7: `simState` carries
 * each face's load crush (a stack's roofs replay crushed as live, docs/LOAD_CRUSH.md); 8: each step's dt as a float32
 * instead of whole microseconds, and the solver state's hit block, `impactLocal`, `impactInward` and `endEbs2`; 9: the
 * solver state as doubles instead of float32 pairs (a keyframe restores a wreck bit for bit) and the clip's `fine` block
 * as the pedals' doubles, NaN where not recorded, instead of one rounding byte each; the pile-ups replay to the bit; 10:
 * the live sim changed under the same bytes: a car meets a solid or knock prop with its whole footprint, not six probes,
 * so a clip recorded against a prop replays another hit; 11: the live sim changed again: the course wall keeps a per-car
 * contact memory, so a car that arrives beyond a wall line from another road stays there, not thrown back across it;
 * 12: no layout change, the live trajectories of cars stacked on each other moved: a car over another's roof is carried
 * by it, not shoved off by the plan SAT, and a tyre on a car grips both ways, so an older clip is refused; 13: a car
 * pair's contact axis is signed by the cars' centres (`satTwoHulls`), so a clip saved under 12 replays its pairs' pushes
 * the other way round; 14: a hard hit on a fixed solid (a course wall, a prop, a ramp's flank) is met as the range's slab
 * is, masses held on its face and the crush spending the hit's stroke, not cancelled and bounced in one step; 15: the
 * solver state's `hubStand` (where each hub stood in the car frame) and the planted anchor that reads it, a
 * live-trajectory change; 16: the solver state's position-correction budget is a net translation (`PushBudget`: one
 * more double), a live-trajectory change of every pile: pair pushes, sphere shifts and wall translations share it, and
 * the plant frees the wheels within 8 m/s of the body; 19: no layout change, the live sim changed: head-on tyres whose
 * hit stroke reaches the wheels, with stroke left, tear off their hubs instead of stopping the pair, so a fast head-on
 * crushes on and an older clip replays another hit; 20: a fixed solid's face meeting only the crush hulls (a palm
 * between the bumpers) is a contact as the slab's is (kept open, crushing and braking), and a wreck's hull allowance at a
 * fixed solid ramps with its closing speed, a live-trajectory change; 21: a re-armed hit's damage base is read in the
 * frame `clampLocal` keeps (`rearmHit`) and a derby car's wear share is 250, so a re-hit crushes and kills differently;
 * 22: derby drivers that pace in one pocket go bold, the first 8 s lift off high-closing rams, and lost wheels take
 * their steering, thrust, brakes and grip with them, all live-trajectory changes; 23: a clip carries the world's step
 * schedule (`shape`), each keyframe the course's wall memory and knocked props, a placed car takes a keyframe, and
 * masses touching keep a car in the clip; 24: a wreck's spin is its masses' momentum, a re-measure is no vertical
 * speed, steering, the plant's wheel seat and the planted write-back turn the masses' velocities with their positions,
 * shape matching hands back the angular momentum it moves, and a slice's pushes, structure step and re-fits share one
 * budget, all live-trajectory changes; the sim scalars drop two doubles; 25: the police pack guard reads the soonest
 * mate ahead first and a parked mate as an obstacle, drops the boost only for a predicted hit, and same-beat stakeouts
 * don't stack, a live-trajectory change of every pursuit; 26: pair contact trades momentum (the COM-gap floor holds
 * only once the struck face's crush is spent, as an inelastic exchange), mass pairs solve mirror-symmetrically, and a
 * flying body lands only with its middle no deeper than its springs, all live-trajectory changes).
 * A saved clip also records `NET_VERSION` (its snapshots' layout).
 */
const REPLAY_VERSION = 26;
/** Bounds a decoder enforces (a clip is ≤ 13 s at ≤ 300 steps/s, ≤ 15 keyframes). */
const MAX_STEPS = 8192;
const MAX_KEYS = 64;
/** The deflated size the recorder budgets a reel's clips to (`CrashRecorder`). A reel over it still goes whole, in `reelParts` frames. */
export const REEL_BUDGET = 240 * 1024;
const SAVE_MAGIC = 0x4c484353; // "SCHL"
const utf8 = (s: string): number => Math.min(255, new TextEncoder().encode(s).length);

/** A clip's ejection record: its step (u32), then `writeEjection`'s 2 + 22 × 4 bytes. */
const EJECTION_BYTES = 4 + 2 + 22 * 4;

/** Exact encoded size of `clip` (`writeClip`). */
export function clipBytes(c: HighlightClip): number {
  const nc = c.cars.length;
  let n = 1 + utf8(c.trackId) + 82 + c.cars.reduce((a, car) => a + 4 + utf8(car.name), 0);
  n += 4 + c.h.length * (8 + nc * INPUT_BYTES) + 8 + c.fine.length * 8 + 2;
  for (const k of c.keys) n += 8 + k.length;
  return n + 1 + c.ejections.length * EJECTION_BYTES;
}

export function writeClip(w: Writer, c: HighlightClip): void {
  w.str(c.trackId);
  w.f32(c.score);
  w.u16(c.impacts);
  w.u8(c.kills);
  w.u8(Math.min(255, c.ejects));
  w.f32(c.peakKph);
  w.f64(c.t0);
  w.f64(c.firstImpact);
  w.u32(c.firstStep);
  w.f64(c.lastImpact);
  w.f32(c.x);
  w.f32(c.z);
  w.u8(c.focus);
  w.u8(c.firstA);
  w.u8(c.firstB < 0 ? 255 : c.firstB);
  w.f64(c.realism);
  w.u8(c.bleed ? 1 : 0);
  w.f64(c.squash);
  w.f64(c.buckle);
  w.u8(c.deformMode === "lattice" ? 1 : 0);
  w.u32(c.look);
  w.u8(c.cars.length);
  for (const car of c.cars) {
    w.u8(car.slot);
    w.u8(CAR_STYLE_IDS.indexOf(car.style));
    w.u8(VEHICLE_CLASS_IDS.indexOf(car.cls));
    w.str(car.name);
  }
  w.u32(c.h.length);
  // Each step's dt as the recorder's ring holds it (float32): whole microseconds moved a 2 x 20 m/s head-on's wreck 8 mm and its crush 10 mm.
  for (const h of c.h) w.f32(h);
  for (const s of c.shape) w.u32(s);
  w.bytes.set(c.inputs, w.off);
  w.off += c.inputs.length;
  w.u32(c.fineFrom);
  w.u32(c.fine.length / (c.cars.length * FINE_PEDALS));
  for (const p of c.fine) w.f64(p);
  w.u16(c.keys.length);
  for (let k = 0; k < c.keys.length; k++) {
    w.u32(c.keyStep[k]!);
    w.u32(c.keys[k]!.length);
    w.bytes.set(c.keys[k]!, w.off);
    w.off += c.keys[k]!.length;
  }
  w.u8(c.ejections.length);
  for (const x of c.ejections) {
    w.u32(x.step);
    writeEjection(w, x.e);
  }
}

/**
 * One clip; throws RangeError on a truncated or out-of-range one (another build, a corrupt store, a hostile peer).
 * Every keyframe is decoded once against the cars' netplay layout `L` to check it.
 */
export function readClip(r: Reader, L: NetLayout): HighlightClip {
  const trackId = r.str();
  const score = r.fin32();
  const impacts = r.u16();
  const kills = r.u8();
  const ejects = r.u8();
  const peakKph = r.fin32();
  const t0 = r.f64();
  const firstImpact = r.f64();
  const firstStep = r.u32();
  const lastImpact = r.f64();
  const x = r.fin32();
  const z = r.fin32();
  const focus = r.u8();
  const firstA = r.u8();
  const b = r.u8();
  const firstB = b === 255 ? -1 : b;
  const realism = r.f64();
  const bleed = r.u8() === 1;
  const squash = r.f64();
  const buckle = r.f64();
  if (!Number.isFinite(squash) || !Number.isFinite(buckle)) throw new RangeError("clip crumple");
  const deformMode = r.u8() === 1 ? "lattice" : "shape";
  const look = r.u32();
  const nc = r.u8();
  if (nc < 1 || nc > MAX_NET_CARS || focus >= nc || firstA >= nc || firstB >= nc) throw new RangeError("clip cars");
  if (![t0, firstImpact, lastImpact, realism].every(Number.isFinite)) throw new RangeError("clip clock");
  const cars: ReelCar[] = [];
  for (let j = 0; j < nc; j++) {
    const slot = r.u8();
    const style = CAR_STYLE_IDS[r.u8()];
    const cls = VEHICLE_CLASS_IDS[r.u8()];
    const name = r.str();
    if (!style || !cls || slot >= MAX_NET_CARS) throw new RangeError("clip car");
    cars.push({ slot, style, cls, name });
  }
  const steps = r.u32();
  if (steps < 1 || steps > MAX_STEPS) throw new RangeError("clip steps");
  const h = new Float32Array(steps);
  for (let s = 0; s < steps; s++) {
    h[s] = r.fin32();
    if (!(h[s]! > 0)) throw new RangeError("clip dt");
  }
  // Each step's schedule (`World.shape`): 19 bits, the slice count − 1 and 2 bits of SAT passes per slice.
  const shape = new Uint32Array(steps);
  for (let s = 0; s < steps; s++) {
    shape[s] = r.u32();
    if (shape[s]! >>> 19 !== 0) throw new RangeError("clip step shape");
  }
  const inputs = new Uint8Array(steps * nc * INPUT_BYTES);
  for (let i = 0; i < inputs.length; i++) inputs[i] = r.u8();
  const fineFrom = r.u32();
  const fineSteps = r.u32();
  if (fineFrom + fineSteps > steps) throw new RangeError("clip fine steps");
  const fine = new Float64Array(fineSteps * nc * FINE_PEDALS);
  for (let i = 0; i < fine.length; i++) {
    // NaN: not recorded. A pedal is a throttle or steer in −1..1, a brake in 0..1.
    const p = r.f64();
    if (!Number.isNaN(p) && !(Math.abs(p) <= 1 && (i % FINE_PEDALS !== 2 || p >= 0))) throw new RangeError("clip fine pedal");
    fine[i] = p;
  }
  const nk = r.u16();
  if (nk < 1 || nk > MAX_KEYS) throw new RangeError("clip keys");
  const keyStep = new Uint32Array(nk);
  const keys: Uint8Array[] = [];
  const check = makeSnapshot();
  const kr = new Reader();
  for (let k = 0; k < nk; k++) {
    keyStep[k] = r.u32();
    if (keyStep[k]! >= steps || (k > 0 && keyStep[k]! <= keyStep[k - 1]!) || (k === 0 && keyStep[0] !== 0)) throw new RangeError("clip key step");
    const len = r.u32();
    if (r.off + len > r.length) throw new RangeError("clip key length");
    const key = new Uint8Array(len);
    for (let i = 0; i < len; i++) key[i] = r.u8();
    kr.reset(key);
    if (kr.u8() !== MSG.snapshot) throw new RangeError("clip key type");
    kr.off = 0;
    readSnapshot(kr, check, L);
    // Then the knocked props (a u16 byte count and the bytes), and per car its flight block, course memory and solver state (`encodeKey`).
    const knockBytes = kr.u16();
    kr.off += knockBytes;
    let j = 0;
    for (; j < nc && kr.off + FLIGHT * 8 + MEMORY * 8 + 2 <= len; j++) {
      kr.off += FLIGHT * 8;
      // The wall memory (`RaceField.remember`): where the car stood (x ±Infinity: no history), how far past a wall line (m), the road segment its projection hint is on (-1: none).
      const wallX = kr.f64();
      const wallZ = kr.f64();
      const beyond = kr.f64();
      const seg = kr.f64();
      if (Number.isNaN(wallX) || !Number.isFinite(wallZ) || !(beyond >= 0 && beyond < Infinity) || !Number.isInteger(seg) || seg < -1) throw new RangeError("clip course memory");
      const n = kr.u16();
      kr.off += n * 8;
    }
    if (check.count !== nc || j !== nc || kr.off !== len) throw new RangeError("clip key cars");
    keys.push(key);
  }
  if (firstStep >= steps) throw new RangeError("clip first step");
  const ne = r.u8();
  const ejections: ClipEjection[] = [];
  for (let k = 0; k < ne; k++) {
    const step = r.u32();
    const e = blankEjection();
    readEjection(r, e);
    if (step >= steps || e.car >= nc || (k > 0 && step < ejections[k - 1]!.step)) throw new RangeError("clip ejection");
    ejections.push({ step, e });
  }
  return { trackId, score, impacts, kills, ejects, ejections, peakKph, t0, firstImpact, lastImpact, firstStep, x, z, focus, firstA, firstB, realism, bleed, squash, buckle, deformMode, look, cars, h, shape, inputs, fineFrom, fine, keyStep, keys };
}

/** A decoder never inflates past this (a hostile peer's or a corrupt store's deflate bomb). */
const INFLATE_MAX = 4 << 20;

/** deflate-raw (the platform's `CompressionStream`): a reel's clips shrink about 4× (inputs and keyframes repeat). */
async function deflate(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
}

/** Inflate at most `INFLATE_MAX` bytes; RangeError on bad or oversized data. */
async function inflate(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  try {
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      n += r.value.length;
      if (n > INFLATE_MAX) throw new RangeError("inflates past the cap");
      parts.push(r.value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e instanceof RangeError ? e : new RangeError("bad deflate data");
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function clipsBytes(clips: readonly HighlightClip[]): Uint8Array<ArrayBuffer> {
  const w = new Writer(1 + clips.reduce((n, c) => n + clipBytes(c), 0));
  w.u8(clips.length);
  for (const c of clips) writeClip(w, c);
  return w.done();
}

/**
 * The reel as one message (`reelParts` frames it for the wire): `MSG.reel`, seed (u32), the host-clock second every
 * peer starts the reel at (f64), then every clip deflated. The host plays the clips it sent, so every peer shows the same ones.
 */
export async function packReel(reel: Reel, startAt: number): Promise<Uint8Array<ArrayBuffer>> {
  const body = await deflate(clipsBytes(reel.clips));
  const w = new Writer(13 + body.length);
  w.u8(MSG.reel);
  w.u32(reel.seed);
  w.f64(startAt);
  w.bytes.set(body, w.off);
  w.off += body.length;
  return w.done();
}

/** A `MSG.reel`; RangeError on a malformed one. */
export async function unpackReel(data: Uint8Array, L: NetLayout): Promise<{ reel: Reel; startAt: number }> {
  const r = new Reader().reset(data);
  if (r.u8() !== MSG.reel) throw new RangeError("not a reel");
  const seed = r.u32();
  const startAt = r.f64();
  if (!Number.isFinite(startAt)) throw new RangeError("reel clock");
  const body = r.reset(await inflate(data.subarray(13)));
  const n = body.u8();
  const clips: HighlightClip[] = [];
  for (let k = 0; k < n; k++) clips.push(readClip(body, L));
  return { reel: { seed, clips }, startAt };
}

/**
 * A `MSG.reel` decoded and handed to `play`, its start (host clock) moved onto this browser's clock by `offset`. Decoding is
 * async: `current` says the session is still the one the message came from, else it is dropped; a malformed one plays nothing.
 */
export function playHostReel(data: Uint8Array, L: NetLayout, offset: number, play: (reel: Reel, startAt: number) => void, current: () => boolean): void {
  unpackReel(data, L).then(
    ({ reel, startAt }) => {
      if (current()) play(reel, startAt + offset);
    },
    () => {},
  );
}

/** A clip for `localStorage`: magic, `REPLAY_VERSION`, `NET_VERSION`, the sim fingerprint, then the clip deflated; base64. */
export async function encodeSaved(c: HighlightClip): Promise<string> {
  const w = new Writer(clipBytes(c));
  writeClip(w, c);
  const body = await deflate(w.done());
  const out = new Writer(11 + body.length);
  out.u32(SAVE_MAGIC);
  out.u16(REPLAY_VERSION);
  out.u8(NET_VERSION);
  out.u32(simFingerprint());
  out.bytes.set(body, out.off);
  out.off += body.length;
  let s = "";
  for (const b of out.done()) s += String.fromCharCode(b);
  return btoa(s);
}

/** A saved clip, or why it cannot replay here: "version" (another clip or keyframe layout, or another sim build) or "corrupt". */
export async function decodeSaved(text: string, L: NetLayout): Promise<HighlightClip | "version" | "corrupt"> {
  let bin: string;
  try {
    bin = atob(text);
  } catch {
    return "corrupt";
  }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const r = new Reader().reset(bytes);
  try {
    if (r.u32() !== SAVE_MAGIC) return "corrupt";
    if (r.u16() !== REPLAY_VERSION || r.u8() !== NET_VERSION || r.u32() !== simFingerprint()) return "version";
    return readClip(r.reset(await inflate(bytes.subarray(11))), L);
  } catch (e) {
    if (e instanceof RangeError) return "corrupt";
    throw e;
  }
}
