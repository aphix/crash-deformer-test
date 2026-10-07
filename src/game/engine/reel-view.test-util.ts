import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { frame, FRAME, type World } from "../world/race-world.test-util.ts";
import { blankPoint, type Track } from "../world/track.ts";
import { clipTitle, ownThrow, type HighlightClip } from "../match/highlights.ts";
import { phaseClock } from "../match/phase.ts";
import { CrashCam } from "../present/engine-cine.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import { addCars, sightLine, type Sight } from "../present/spectate-cam.ts";
import { FLIGHT_S, ReelDirector, type ReelHost } from "./engine-highlights.ts";

/**
 * The results reel's cameras headless, as the engine runs them minus the renderer (`ReelDirector.aim`: the thrown driver's
 * ride-along, the crash cam, the clip's shots), and what each shows at the moments a highlight is about: the first impact,
 * every driver thrown out and the subject car's take-offs. Not a test file itself.
 */

/** What "the moment is visible" means (owner, 2026-10-06), measurably. */
export const VIEW = {
  /** The moment's point projects inside this share of the frame's half-width and half-height (NDC): a 10 % margin at each edge. */
  margin: 0.8,
  /** A subject this tall (m: a car's length seen end-on, a driver) spans at least `share` of the frame's height. */
  subject: 2,
  share: 1 / 16,
};

/** The scene's lens (deg), as `ChaseCamera.lens`. */
const LENS = 55;

export type MomentKind = "impact" | "throw" | "takeoff";

/** One moment of a clip and the reel's camera at it. */
export type MomentView = {
  scene: string;
  title: string;
  kind: MomentKind;
  /** Clip seconds of the moment, and of the clip's first impact. */
  at: number;
  hitAt: number;
  /** Which camera held the frame: "ride", "crash", "shot:<kind>" ("chase" for a spot-less shot), "flight". */
  rig: string;
  x: number;
  y: number;
  z: number;
  /** The point in normalized device coordinates; `front` false: behind the eye. */
  ndcX: number;
  ndcY: number;
  front: boolean;
  /** No wall, building or hill of the course stands on the line from the eye to the point (`sightLine` over the static solids). */
  clear: boolean;
  /** The share of the frame's height a `VIEW.subject` m subject at the point spans. */
  share: number;
  seen: boolean;
  /** Wall seconds the viewer watches from the moment to the slow-mo's hand-back to 1× (`holdAfter`); 0 when it comes at 1×. */
  hold: number;
  /** Wall seconds into the clip's timeline of the moment, and of the clip's end (no hold outlasts it). */
  wall: number;
  end: number;
  /** What the camera stack was doing: the moment's car is the clip's subject or not, the crash cam's clock. */
  note: string;
};

/** A reel clip's wall timeline as `clipTimeline` steps it: per fixed wall step the clip second and the time scale. */
type ScaleCurve = { wall: number; sim: Float64Array; scale: Float32Array };

/** The first wall step of `tl` whose clip second reaches `at`. */
function stepOf(tl: ScaleCurve, at: number): number {
  let k = 0;
  while (k < tl.sim.length - 1 && tl.sim[k]! < at) k++;
  return k;
}

/**
 * Wall seconds from clip second `at` to the slow-mo's hand-back, read off the reel's time-scale curve: the first step on
 * from the moment where the scale, under 1×, starts rising back. 0 when the moment plays at 1× or on the way back up; the
 * clip's end when it ends first.
 */
export function holdAfter(tl: ScaleCurve, at: number): number {
  const dt = tl.wall / (tl.sim.length - 1);
  const k = stepOf(tl, at);
  for (let j = k; j + 1 < tl.scale.length; j++) {
    if (tl.scale[j]! >= 1) return 0;
    if (tl.scale[j + 1]! > tl.scale[j]!) return (j - k) * dt;
  }
  return (tl.scale.length - 1 - k) * dt;
}

const _ndc = new THREE.Vector3();

/** The moment at `p` as `cam` frames it, judged by `VIEW` against the course's static solids `s` (no cars). */
export function judge(cam: THREE.PerspectiveCamera, s: Sight, p: THREE.Vector3): Pick<MomentView, "ndcX" | "ndcY" | "front" | "clear" | "share" | "seen"> {
  cam.updateMatrixWorld();
  _ndc.copy(p).project(cam);
  const front = _ndc.z > -1 && _ndc.z < 1;
  const e = cam.position;
  const clear = sightLine(s, e.x, e.y, e.z, p.x, p.y, p.z) >= 0;
  const share = VIEW.subject / (2 * e.distanceTo(p) * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
  const seen = front && Math.abs(_ndc.x) <= VIEW.margin && Math.abs(_ndc.y) <= VIEW.margin && clear && share >= VIEW.share;
  return { ndcX: _ndc.x, ndcY: _ndc.y, front, clear, share, seen };
}

type Moment = { kind: MomentKind; at: number; point: THREE.Vector3 | null; car: number };

/**
 * A clip's moments known from its record: the first impact (its point set when it comes) and every throw of its own crash
 * (`ownThrow`), by clip time. Another crash's throw, in the lead-in or far off in the tail, is not the clip's moment.
 */
function momentsOf(clip: HighlightClip): Moment[] {
  const ends = new Float64Array(clip.h.length + 1);
  for (let i = 0; i < clip.h.length; i++) ends[i + 1] = ends[i]! + clip.h[i]!;
  const out: Moment[] = [{ kind: "impact", at: clip.firstImpact, point: null, car: clip.firstA }];
  for (const x of clip.ejections) if (ownThrow(clip, ends[x.step + 1]!, x.e.pos.x, x.e.pos.z)) out.push({ kind: "throw", at: ends[x.step + 1]!, point: x.e.pos.clone(), car: x.e.car });
  return out;
}

/** A take-off counts once the car has flown this long (clip s): a hop over a kerb does not. */
const FLIGHT_MIN = 0.3;

/**
 * Every clip of `clips` played through the reel's cameras at 60 Hz on `w`'s cars, a `aspect` frame: each moment judged on
 * the frame it happens in (the first frame whose clip time reaches it).
 */
export async function reelViews(w: World, clips: readonly HighlightClip[], scene: string, aspect = 16 / 9): Promise<MomentView[]> {
  const ragdolls = new RagdollSystem(new THREE.Scene(), () => {}, () => {});
  await ragdolls.preload();
  const crash = new CrashCam(false);
  let cut = false;
  const crashDirect: Pick<CrashCam, "direct"> = { direct: (camera, dt, allowed, hold) => (cut = crash.direct(camera, dt, allowed, hold)) };
  const course = (): Sight => w.race.courseSight()!;
  const sight = (focus: (typeof w.cars)[number] | null): Sight => {
    const s = course();
    const occ = [...s.occ];
    addCars(occ, w.live(), focus);
    return { ...s, occ };
  };
  let rode = false;
  const clock = phaseClock();
  const host: ReelHost = {
    carsOf: (clip) => clip.cars.map((c) => w.cars[c.slot]!),
    live: () => w.live(),
    scene: { dress: w.dress, collide: (car, slot, h) => w.race.courseHit(car, slot, h), restore: (slot, mem, at) => w.race.remember(slot, mem, at), knocks: (bits) => w.race.knockTo(bits), bounce: undefined },
    resetProps: () => w.race.resetProps(),
    clear: () => ragdolls.reset(),
    sight,
    still: course,
    clock,
    impact: (contact, normal) => crash.begin(contact, normal, course(), clock.hold),
    hit: () => {},
    eject: (e, ride) => {
      ragdolls.launch(e, w.live());
      if (ride) ragdolls.follow();
    },
    ride: (camera, dt, subject) => (rode = ragdolls.rideAlong && ragdolls.frameCamera(camera, dt, false, w.cars.indexOf(subject), false, LENS, () => sight(subject)) !== "none"),
  };
  const reel = new ReelDirector(host);
  reel.stepBudgetMs = Infinity;
  const camera = new THREE.PerspectiveCamera(LENS, aspect, 0.1, 900);
  const probe = new THREE.PerspectiveCamera(LENS, aspect, 0.1, 900);
  const out: MomentView[] = [];
  const s = course();
  for (const [i, clip] of clips.entries()) {
    crash.reset();
    reel.play({ seed: 0x5eed + i, clips: [clip] }, 0);
    const tl = reel["clips"][0]!.tl;
    const wall = tl.wall;
    const moments = momentsOf(clip);
    const title = clipTitle(clip);
    // The take-offs of the subject and the first impact's cars: judged as each leaves the ground, kept once it has flown `FLIGHT_MIN`.
    const watch = [clip.focus, clip.firstA, clip.firstB];
    const flightAt = [-1, -1, -1];
    const pending: (MomentView | null)[] = [null, null, null];
    for (let k = -1; k * FRAME < wall; k++) {
      const dt = reel.frame(FLIGHT_S + k * FRAME) ?? 0;
      ragdolls.update(dt, w.live(), true, false, 0, null);
      rode = false;
      cut = false;
      reel.aim(camera, probe, FRAME, crashDirect);
      const cur = reel["cur"];
      if (k < 0 || !cur) continue;
      const sim = cur.sim;
      const shot = cur.shots[Math.max(0, reel["shot"])]!;
      const rig = rode ? "ride" : cut ? "crash" : reel["flying"] ? "flight" : `shot:${shot.kind === "chase" || reel["shotCam"].found ? shot.kind : "chase"}`;
      const view = (kind: MomentKind, at: number, p: THREE.Vector3, car: number): MomentView => ({ scene, title, kind, at, hitAt: clip.firstImpact, rig, x: p.x, y: p.y, z: p.z, ...judge(camera, s, p), hold: holdAfter(tl, at), wall: (stepOf(tl, at) * wall) / (tl.sim.length - 1), end: wall, note: `${car === clip.focus ? "subject" : "other car"}, hit at ${clip.firstImpact.toFixed(2)} s, eye ${camera.position.toArray().map((v) => v.toFixed(1))}` });
      for (const m of moments) {
        if (m.at > sim.time + 1e-9 || m.at < 0) continue;
        const p = m.point ?? new THREE.Vector3(clip.x, sim.cars[m.car]!.group.position.y + 0.55, clip.z);
        out.push(view(m.kind, m.at, p, m.car));
        m.at = -1;
      }
      for (let j = 0; j < watch.length; j++) {
        const car = sim.cars[watch[j]!];
        if (!car || watch.indexOf(watch[j]!) < j) continue;
        if (!car.airborne) {
          flightAt[j] = -1;
          pending[j] = null;
          continue;
        }
        if (flightAt[j]! < 0) {
          flightAt[j] = sim.time;
          pending[j] = sim.time > 0.05 ? view("takeoff", sim.time, car.group.position.clone().setY(car.group.position.y + 0.55), watch[j]!) : null;
        }
        if (pending[j] && sim.time - flightAt[j]! >= FLIGHT_MIN) {
          out.push(pending[j]!);
          pending[j] = null;
        }
      }
    }
    reel.stop();
  }
  ragdolls.dispose();
  return out;
}

/**
 * A scripted crash: two cars head-on, a car into the wall (or the kerb's buildings), a car into another's side, a car over
 * a crest at `at` (a jump) onto another standing across its line `land` m past the crest, where it comes down, or a car
 * driven from (x, z) heading `yaw` up a ramp (a plateau's face) and off its lip, into whatever stands beyond it. `cars`:
 * the slots of `a` and `b` (the next pair from car 1 on when absent).
 */
export type Crash = (
  | { kind: "headOn" | "wall" | "tBone" | "jump"; at: number; speed: number; side?: 1 | -1; land?: number }
  | { kind: "ramp"; x: number; z: number; yaw: number; speed: number }
) & { cars?: readonly [number, number] };

const pt = blankPoint();

/** `car` on course `track` at (x, z) facing `yaw` at `speed`, on the road's surface there (as `RaceField.place` puts it). */
function put(track: Track, car: World["cars"][number], x: number, z: number, yaw: number, speed: number): void {
  car.spawnFacing(x, z, yaw, speed);
  car.group.position.y = track.ground().heightAt(x, z, pt.y + 0.5);
}

/** A staged jump's car runs at the crest from this far (m) short of it: too short for its driver to brake for it. */
const JUMP_RUN = 10;

/** Put cars `a` and `b` (`b` unused by a wall hit or a ramp) on course `track` for `c`: each a few metres from the meeting point, closing at `c.speed` each. */
export function stage(track: Track, a: World["cars"][number], b: World["cars"][number], c: Crash): void {
  if (c.kind === "ramp") {
    pt.y = track.ground().heightAt(c.x, c.z);
    put(track, a, c.x, c.z, c.yaw, c.speed);
    return;
  }
  if (c.kind === "jump") {
    track.pointAt(c.at - JUMP_RUN, pt);
    const { x, z, tx, tz } = pt;
    put(track, a, x, z, Math.atan2(tx, tz), c.speed);
    // `b` stands across `a`'s line (it flies straight), empty: its driver out, it coasts as a wreck does and stays put.
    const d = JUMP_RUN + (c.land ?? 0);
    put(track, b, x + tx * d, z + tz * d, Math.atan2(tz, -tx), 0);
    b.driverOut = "windshield";
    return;
  }
  track.pointAt(c.at, pt);
  const yaw = Math.atan2(pt.tx, pt.tz);
  if (c.kind === "headOn") {
    put(track, a, pt.x, pt.z, yaw, c.speed);
    track.pointAt(c.at + 9, pt);
    put(track, b, pt.x, pt.z, yaw + Math.PI, c.speed);
    return;
  }
  const side = c.side ?? 1;
  // The road's left (+lateral) normal is (tz, −tx).
  const nx = pt.tz * side;
  const nz = -pt.tx * side;
  if (c.kind === "wall") {
    const off = pt.half * 0.3;
    const dx = pt.tx * Math.cos(0.75) + nx * Math.sin(0.75);
    const dz = pt.tz * Math.cos(0.75) + nz * Math.sin(0.75);
    put(track, a, pt.x + nx * off, pt.z + nz * off, Math.atan2(dx, dz), c.speed);
    return;
  }
  // T-bone: `b` crosses the road from the right edge as `a` arrives.
  put(track, a, pt.x - pt.tx * 10, pt.z - pt.tz * 10, yaw, c.speed);
  put(track, b, pt.x - nx * 3, pt.z - nz * 3, Math.atan2(nx, nz), 4);
}

/** The player's seat floors it, wheel straight: a staged crash's car that the seat drives keeps its speed into the hit. */
function floor(w: World): void {
  const i = w.seat.intent;
  i.wheel = 0;
  i.gas = 1;
  i.brake = 0;
  i.handbrake = false;
}

/**
 * Race `w` (entered, its field started) on `track` for `seconds`, or until its recording ends (the race over and its last
 * thrown driver's hold recorded), staging `crashes` (each at its own race second from 1 on, on its `cars` or cars 1, 2, 3, …
 * in pairs); the clips its recorder kept.
 */
export function recordRace(w: World, track: Track, crashes: readonly Crash[], seconds: number): HighlightClip[] {
  const r = w.race;
  const state = { acc: 0 };
  let next = 0;
  for (let n = 0; n * FRAME < seconds && r.recorder.on; n++) {
    if (next < crashes.length && r.time >= 1 + next * 2.5) {
      const cars = w.live();
      const c = crashes[next]!;
      const a = cars[c.cars?.[0] ?? (1 + 2 * next) % cars.length]!;
      stage(track, a, cars[c.cars?.[1] ?? (2 + 2 * next) % cars.length]!, c);
      if (w.seat.mode === "drive" && a === cars[w.seat.carIndex]) floor(w);
      next++;
    }
    frame(w, state);
  }
  r.recorder.end();
  return [...r.recorder.ledger.kept];
}
