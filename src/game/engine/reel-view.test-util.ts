import * as THREE from "three";
import "../kernel/rapier-node.test-util.ts";
import { frame, FRAME, type World } from "../world/race-world.test-util.ts";
import { blankPoint, type Track } from "../world/track.ts";
import { layOnGround } from "../vehicle/car-air.ts";
import { clipTitle, type HighlightClip } from "../match/highlights.ts";
import { phaseClock } from "../match/phase.ts";
import type { ViewBox } from "../match/types.ts";
import { CrashCam } from "../present/engine-cine.ts";
import { RagdollSystem } from "../present/engine-ragdoll.ts";
import { addCars, sightLine, type Sight } from "../present/spectate-cam.ts";
import { coverLens, FLIGHT_S, ReelDirector, type ReelHost } from "./engine-highlights.ts";
import { PoseBlend } from "../present/pose-blend.ts";

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

/** The page the reel plays on (CSS px) and the panels open over it (the results sheet, the standings list). */
export type Screen = { view: ViewBox; covers: readonly ViewBox[] };

/** The browser probe's desktop page, nothing over it. */
const DESKTOP: Screen = { view: { left: 0, top: 0, right: 1280, bottom: 720 }, covers: [] };

/** The scene's lens (deg), as `ChaseCamera.lens`. */
const LENS = 55;

export type MomentKind = "impact" | "hit" | "throw" | "takeoff";

/**
 * At a `hit` (an impact of the clip's scope after its first): the previous impact's point in the frame, and whether the
 * camera changed since that impact (a cut: another rig, another shot, another crash-cam cut). `inFrame`: front of the eye,
 * inside the frame's margin and clear of the panels.
 */
export type Back = { cut: boolean; inFrame: boolean; ndcX: number; ndcY: number };

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
  /** The point lies under a panel, or within the frame's margin of one. */
  covered: boolean;
  /** The share of the frame's height a `VIEW.subject` m subject at the point spans. */
  share: number;
  seen: boolean;
  /** The camera stack at the moment: the rig, the shot's index in the clip and the crash cam's held cut. */
  cam: string;
  /** Set for a `hit` (see `Back`), null for the other moments. */
  back: Back | null;
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

/** The moment at `p` as `cam` frames it on `screen`, judged by `VIEW` against the course's static solids `s` (no cars) and the screen's panels. */
export function judge(cam: THREE.PerspectiveCamera, s: Sight, p: THREE.Vector3, screen: Screen): Pick<MomentView, "ndcX" | "ndcY" | "front" | "clear" | "covered" | "share" | "seen"> {
  cam.updateMatrixWorld();
  _ndc.copy(p).project(cam);
  const front = _ndc.z > -1 && _ndc.z < 1;
  const e = cam.position;
  const clear = sightLine(s, e.x, e.y, e.z, p.x, p.y, p.z) >= 0;
  const { view, covers } = screen;
  const w = view.right - view.left;
  const h = view.bottom - view.top;
  // The point on the page, and the frame's margin around each panel (as at the frame's edges).
  const x = view.left + ((_ndc.x + 1) / 2) * w;
  const y = view.top + ((1 - _ndc.y) / 2) * h;
  const mx = ((1 - VIEW.margin) / 2) * w;
  const my = ((1 - VIEW.margin) / 2) * h;
  const covered = covers.some((c) => x > c.left - mx && x < c.right + mx && y > c.top - my && y < c.bottom + my);
  const share = VIEW.subject / (2 * e.distanceTo(p) * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2));
  const seen = front && Math.abs(_ndc.x) <= VIEW.margin && Math.abs(_ndc.y) <= VIEW.margin && clear && !covered && share >= VIEW.share;
  return { ndcX: _ndc.x, ndcY: _ndc.y, front, clear, covered, share, seen };
}

type Moment = { kind: MomentKind; at: number; point: THREE.Vector3 | null; car: number; x: number; z: number };

/**
 * A clip's moments known from its record: the first impact (its point set when it comes), every later impact of its scope
 * (`ClipHit`) and every throw of its own scope (`ClipEjection.own`), by clip time. Another crash's throw in the clip's steps
 * is not the clip's moment.
 */
function momentsOf(clip: HighlightClip): Moment[] {
  const ends = new Float64Array(clip.h.length + 1);
  for (let i = 0; i < clip.h.length; i++) ends[i + 1] = ends[i]! + clip.h[i]!;
  const out: Moment[] = [{ kind: "impact", at: clip.firstImpact, point: null, car: clip.firstA, x: clip.x, z: clip.z }];
  for (const h of clip.hits) if (h.t > clip.firstImpact + 1e-9) out.push({ kind: "hit", at: h.t, point: null, car: h.a, x: h.x, z: h.z });
  for (const x of clip.ejections) if (x.own) out.push({ kind: "throw", at: ends[x.step + 1]!, point: x.e.pos.clone(), car: x.e.car, x: x.e.pos.x, z: x.e.pos.z });
  return out.sort((p, q) => p.at - q.at);
}

/** A take-off counts once the car has flown this long (clip s): a hop over a kerb does not. */
const FLIGHT_MIN = 0.3;

/**
 * Every clip of `clips` played through the reel's cameras at 60 Hz on `w`'s cars, on `screen` (its lens as the engine fits
 * it, `coverLens`): each moment judged on the frame it happens in (the first frame whose clip time reaches it).
 */
export async function reelViews(w: World, clips: readonly HighlightClip[], scene: string, screen = DESKTOP): Promise<MomentView[]> {
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
    scene: { dress: w.dress, collide: (car, slot, h) => w.race.courseHit(car, slot, h), restore: (slot, mem, at) => w.race.remember(slot, mem, at), knocks: (bits) => w.race.knockTo(bits), blend: new PoseBlend() },
    resetProps: () => w.race.resetProps(),
    clear: () => ragdolls.reset(),
    sight,
    still: course,
    clock,
    impact: (contact, normal) => crash.begin(contact, normal, course(), clock.hold),
    hit: () => {},
    eject: (e, ride) => {
      ragdolls.launch(e, w.live(), ride);
      if (ride) ragdolls.follow();
    },
    ride: (camera, dt, subject) => (rode = ragdolls.rideAlong && ragdolls.frameCamera(camera, dt, false, w.cars.indexOf(subject), false, LENS, () => sight(subject)) !== "none"),
  };
  const reel = new ReelDirector(host);
  reel.stepBudgetMs = Infinity;
  const camera = new THREE.PerspectiveCamera(LENS, 1, 0.1, 900);
  coverLens(camera, screen.view, screen.covers);
  const probe = camera.clone();
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
    let last: { cam: string; p: THREE.Vector3 } | null = null;
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
      const rig = rode ? "ride" : cut ? "crash" : reel["flying"] ? "flight" : shot.ctx ? "shot:context" : `shot:${shot.kind === "chase" || reel["shotCam"].found ? shot.kind : "chase"}`;
      const cam = `${rig}|${reel["shot"]}|${crash["held"]}`;
      const view = (kind: MomentKind, at: number, p: THREE.Vector3, car: number): MomentView => ({ scene, title, kind, at, hitAt: clip.firstImpact, rig, x: p.x, y: p.y, z: p.z, ...judge(camera, s, p, screen), cam, back: null, hold: holdAfter(tl, at), wall: (stepOf(tl, at) * wall) / (tl.sim.length - 1), end: wall, note: `${car === clip.focus ? "subject" : "other car"}, hit at ${clip.firstImpact.toFixed(2)} s, eye ${camera.position.toArray().map((v) => v.toFixed(1))}` });
      for (const m of moments) {
        if (m.at > sim.time + 1e-9 || m.at < 0) continue;
        const p = m.point ?? new THREE.Vector3(m.x, sim.cars[m.car]!.group.position.y + 0.55, m.z);
        const v = view(m.kind, m.at, p, m.car);
        if (m.kind === "impact" || m.kind === "hit") {
          if (m.kind === "hit" && last) {
            const j = judge(camera, s, last.p, screen);
            v.back = { cut: cam !== last.cam, inFrame: j.front && Math.abs(j.ndcX) <= VIEW.margin && Math.abs(j.ndcY) <= VIEW.margin && !j.covered, ndcX: j.ndcX, ndcY: j.ndcY };
          }
          last = { cam, p };
        }
        out.push(v);
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
 * a crest at `at` (a jump) onto another standing across its line `land` m past the crest, where it comes down, a car
 * driven from (x, z) heading `yaw` up a ramp (a plateau's face) and off its lip, into whatever stands beyond it, or a chain:
 * a car into the rear of an empty one that stands 9 m ahead, which it shoves into a third standing `gap` m behind it.
 * `cars`: the slots of `a`, `b` (and the chain's third; the next pair from car 1 on when absent).
 */
export type Crash = (
  | { kind: "headOn" | "wall" | "tBone" | "jump"; at: number; speed: number; side?: 1 | -1; land?: number }
  | { kind: "chain"; at: number; speed: number; gap: number }
  | { kind: "ramp"; x: number; z: number; yaw: number; speed: number }
) & { cars?: readonly number[] };

const pt = blankPoint();

/** `car` on course `track` at (x, z) facing `yaw` at `speed`, on the road's surface there (as `RaceField.place` puts it). */
function put(track: Track, car: World["cars"][number], x: number, z: number, yaw: number, speed: number): void {
  car.spawnFacing(x, z, yaw, speed);
  car.group.position.y = track.ground().heightAt(x, z, pt.y + 0.5);
  layOnGround(car);
}

/** A staged jump's car runs at the crest from this far (m) short of it: too short for its driver to brake for it. */
const JUMP_RUN = 10;

/** Put cars `a` and `b` (`b` unused by a wall hit or a ramp; a chain's third car is `third`) on course `track` for `c`: each a few metres from the meeting point, closing at `c.speed` each. */
export function stage(track: Track, a: World["cars"][number], b: World["cars"][number], c: Crash, third: World["cars"][number] = b): void {
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
  if (c.kind === "chain") {
    put(track, a, pt.x, pt.z, yaw, c.speed);
    // All three are empty (driver out: they coast as wrecks do): `a` runs straight into `b` whatever the AI would do, and the other two stand put.
    a.driverOut = "windshield";
    track.pointAt(c.at + 9, pt);
    put(track, b, pt.x, pt.z, yaw, 0);
    b.driverOut = "windshield";
    track.pointAt(c.at + 9 + c.gap, pt);
    put(track, third, pt.x, pt.z, yaw, 0);
    third.driverOut = "windshield";
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

/** A race recorded: the clips its recorder kept and the recorder second (`CrashRecorder.now`) each staged crash began at. */
export type Recording = { clips: HighlightClip[]; stagedAt: number[] };

/**
 * Race `w` (entered, its field started) on `track` for `seconds`, or until its recording ends (the race over and its last
 * thrown driver's hold recorded), staging `crashes` (each at its own race second from 1 on, on its `cars` or cars 1, 2, 3, …
 * in pairs); the clips its recorder kept.
 */
export function recordRace(w: World, track: Track, crashes: readonly Crash[], seconds: number): Recording {
  const r = w.race;
  const state = { acc: 0 };
  const stagedAt: number[] = [];
  let next = 0;
  for (let n = 0; n * FRAME < seconds && r.recorder.on; n++) {
    if (next < crashes.length && r.time >= 1 + next * 2.5) {
      const cars = w.live();
      const c = crashes[next]!;
      const a = cars[c.cars?.[0] ?? (1 + 2 * next) % cars.length]!;
      stage(track, a, cars[c.cars?.[1] ?? (2 + 2 * next) % cars.length]!, c, cars[c.cars?.[2] ?? (3 + 2 * next) % cars.length]!);
      if (w.seat.mode === "drive" && a === cars[w.seat.carIndex]) floor(w);
      stagedAt.push(r.recorder.now);
      next++;
    }
    frame(w, state);
  }
  r.recorder.end();
  // A clip the end of the run cut short (an impact in its last seconds, `CrashRecorder.end`) has less than the post-roll (3 s) after its last impact: it plays no full hold, which no race clip owes. One that ends with its own thrown driver's hold is whole: the recorder runs on until that hold is recorded (`CrashRecorder.over`).
  const clips = [...r.recorder.ledger.kept].filter((c) => c.h.reduce((a, h) => a + h, 0) >= c.lastImpact + 2.95 || c.ejections.some((x) => x.own));
  return { clips, stagedAt };
}

/** A staged head-on, wall hit or T-bone meets within this many seconds: `stage` starts its cars at most 20 m from the meeting, the slowest closing at 20 m/s, doubled. */
export const STAGED_MEETING_S = 2;

/** Recorder seconds from the first staged crash to the first impact of the earliest clip; Infinity when there is no clip. */
export function secondsToFirstImpact(rec: Recording): number {
  let soonest = Infinity;
  for (const clip of rec.clips) soonest = Math.min(soonest, clip.t0 + clip.firstImpact - rec.stagedAt[0]!);
  return soonest;
}
