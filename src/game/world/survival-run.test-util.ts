import * as THREE from "three";
import { activeGround, setGround } from "./ground.ts";
import { FRAME, frame, makeWorld, type World } from "./race-world.test-util.ts";
import { sightLine } from "../present/spectate-cam.ts";

/**
 * The Survival stack headless, as the browser runs it minus the renderer: `RaceDirector` in Survival mode on the Survival
 * course, the real hunters, rules, physics and contacts, a scripted player and a chase camera that the drop-ins must hide from.
 * Not a test file itself.
 */

/** A fresh world with a Survival run entered (the director has started it: formation placed, hunters held for the green); `seed` pins the field's dice. */
export function survivalWorld(course?: unknown, seed?: number): World {
  const w = makeWorld(course);
  if (seed !== undefined) w.race.reseed(seed);
  w.race.enter(true);
  return w;
}

export function leaveSurvival(w: World): void {
  w.race.exit();
  setGround(null);
}

/** The engine's chase camera, roughly: 7 m behind the player, 3 m up, looking at the car. */
export function chaseCam(w: World): void {
  const car = w.cars[0]!;
  const p = car.group.position;
  const f = car.fwdFlat;
  w.camera.position.set(p.x - f.x * 7, p.y + 3.2, p.z - f.z * 7);
  w.camera.lookAt(p.x, p.y + 1, p.z);
  w.camera.updateMatrixWorld();
}

const frustum = new THREE.Frustum();
const viewProj = new THREE.Matrix4();
const ball = new THREE.Sphere();

/**
 * Whether a car at (x, z) can be seen from the camera: a car-sized ball in the view frustum, and a clear sight line from the eye
 * to its belly or its roof. Independent of the director's own test (a different margin, a different way round).
 */
export function visibleFrom(w: World, x: number, z: number): boolean {
  const cam = w.camera;
  cam.updateMatrixWorld();
  viewProj.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  frustum.setFromProjectionMatrix(viewProj);
  const y = activeGround().heightAt(x, z);
  ball.set(ball.center.set(x, y + 0.8, z), 2.5);
  if (!frustum.intersectsSphere(ball)) return false;
  const sight = w.race.courseSight();
  if (!sight) return true;
  const e = cam.position;
  return sightLine(sight, e.x, e.y, e.z, x, y + 0.4, z) >= 0 || sightLine(sight, e.x, e.y, e.z, x, y + 1.3, z) >= 0;
}

/** Per world: seconds the scripted player has sat nearly still, and seconds left of its reverse. */
const wedge = new WeakMap<World, { still: number; back: number }>();

/**
 * The scripted player's pedals for this frame: steer at (tx, tz), hold `cap` m/s (null: flat out). A player wedged against a wall
 * or a prop for a second backs out for a second and a bit, as a human would.
 */
export function steerAt(w: World, tx: number, tz: number, cap: number | null): void {
  const car = w.cars[0]!;
  const p = car.group.position;
  const racing = w.race.phase === "racing";
  let a = Math.atan2(tx - p.x, tz - p.z) - Math.atan2(car.fwdFlat.x, car.fwdFlat.z);
  a -= Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
  const speed = car.velocity.length();
  const st = wedge.get(w) ?? { still: 0, back: 0 };
  wedge.set(w, st);
  st.still = racing && speed < 1.5 ? st.still + FRAME : 0;
  if (st.still > 1) {
    st.still = 0;
    st.back = 1.3;
  }
  const seat = w.seat;
  seat.mode = "drive";
  seat.carIndex = 0;
  seat.intent.analogWheel = true;
  seat.intent.analogGas = true;
  seat.intent.handbrake = false;
  if (st.back > 0) {
    st.back -= FRAME;
    seat.intent.wheel = -Math.max(-1, Math.min(1, a * 3));
    seat.intent.gas = 0;
    seat.intent.brake = 1;
    return;
  }
  seat.intent.wheel = racing ? Math.max(-1, Math.min(1, a * 3)) : 0;
  const over = cap !== null && speed > cap;
  seat.intent.gas = racing && !over ? 1 : 0;
  seat.intent.brake = racing && over ? 1 : 0;
}

/** The scripted player holds the line x = `x` down a straight toward −z, as a human does: it steers at the point `look` m ahead on that line, so a shove is steered back. */
export function holdLine(w: World, x: number, look: number, cap: number | null): void {
  steerAt(w, x, w.cars[0]!.group.position.z - look, cap);
}

/** The scripted player sits still: no gas, handbrake up (the brake pedal would reverse the car once it stopped). */
export function hold(w: World): void {
  const seat = w.seat;
  seat.mode = "drive";
  seat.carIndex = 0;
  seat.intent.analogWheel = true;
  seat.intent.analogGas = true;
  seat.intent.wheel = 0;
  seat.intent.gas = 0;
  seat.intent.brake = 0;
  seat.intent.handbrake = true;
}

/** Cars of the pack that are on the road and in one piece: visible, engine alive, not on their roof. */
export function liveCops(w: World): number[] {
  const out: number[] = [];
  const cars = w.live();
  for (let i = 1; i < cars.length; i++) {
    const c = cars[i]!;
    if (c.group.visible && c.deform.drivetrainAlive && c.group.matrixWorld.elements[5]! > 0.35) out.push(i);
  }
  return out;
}

export type Spawn = { t: number; x: number; z: number; dist: number; visible: boolean };
export type Gap = { t: number; nearest: number; /** Race clock (s): 0 at the green of the run it is in. */ time: number; /** Cops hunting, the HUD's count. */ cops: number };

export type Play = {
  /** Frames the loop ran, in seconds of game time. */
  seconds: number;
  /** Every cop that appeared on the road after the green (not the formation), judged against the camera at that frame. */
  spawns: Spawn[];
  /** The nearest live cop's distance to the player once a second. */
  gaps: Gap[];
  /** Cop-seconds a live cop spent under 1 m/s farther than 12 m from the player, in stretches over 3 s (a stuck cop). */
  stuck: { id: number; t: number; seconds: number; x: number; z: number }[];
  /** Most cops live at once. */
  peak: number;
  /** Runs started (the first, and a Retry after each end) and how each ended: at which frame second `t`, race second `time` (from the green), and why. */
  ends: { t: number; time: number; cause: string }[];
};

export type PlayOpts = {
  /** Seconds of game time to play (across runs). */
  seconds: number;
  /** The scripted player, once per frame, before the physics. */
  player: (w: World, t: number) => void;
  /** Start a new run when one ends. */
  retry?: boolean;
  /** The chase camera follows the player (needed for the spawn test). */
  cam?: boolean;
};

/** Play `seconds` of Survival with the scripted player, collecting the numbers the tests and the docs quote. */
export function play(w: World, o: PlayOpts): Play {
  const out: Play = { seconds: 0, spawns: [], gaps: [], stuck: [], peak: 0, ends: [] };
  const state = { acc: 0 };
  const n = w.live().length;
  const seen = new Uint8Array(n);
  const slow = new Float64Array(n);
  const slowAt = new Float64Array(n);
  const slowXZ: [number, number][] = Array.from({ length: n }, () => [0, 0]);
  let nextGap = 0;
  let wasOver = false;
  for (let f = 0; f * FRAME < o.seconds; f++) {
    const t = f * FRAME;
    if (o.cam ?? true) chaseCam(w);
    o.player(w, t);
    frame(w, state);
    out.seconds = t;
    const time = w.race.time;
    const hud = w.race.hud();
    const over = hud.phase === "finished";
    if (over && !wasOver) out.ends.push({ t, time, cause: hud.survival?.result?.cause ?? "?" });
    wasOver = over;
    if (over) {
      if (!o.retry || hud.menu === null) {
        if (!o.retry) break;
        continue;
      }
      // The results card is up: Retry, as the player would press it.
      w.race.command({ type: "retry" });
      seen.fill(0);
      slow.fill(0);
      wasOver = false;
      continue;
    }
    const cars = w.live();
    const p = cars[0]!.group.position;
    let near = Infinity;
    let live = 0;
    for (let i = 1; i < cars.length; i++) {
      const c = cars[i]!;
      const vis = c.group.visible ? 1 : 0;
      if (vis && !seen[i] && time > 0) {
        const d = Math.hypot(c.group.position.x - p.x, c.group.position.z - p.z);
        out.spawns.push({ t, x: c.group.position.x, z: c.group.position.z, dist: d, visible: visibleFrom(w, c.group.position.x, c.group.position.z) });
      }
      seen[i] = vis;
      if (vis && c.deform.drivetrainAlive && c.group.matrixWorld.elements[5]! > 0.35) {
        live++;
        const d = Math.hypot(c.group.position.x - p.x, c.group.position.z - p.z);
        near = Math.min(near, d);
        const slowNow = time > 0 && c.velocity.length() < 1 && d > 12;
        if (slowNow) {
          if (slow[i] === 0) {
            slowAt[i] = t;
            slowXZ[i] = [c.group.position.x, c.group.position.z];
          }
          slow[i]! += FRAME;
        } else {
          if (slow[i]! > 3) out.stuck.push({ id: i, t: slowAt[i]!, seconds: slow[i]!, x: slowXZ[i]![0], z: slowXZ[i]![1] });
          slow[i] = 0;
        }
      } else slow[i] = 0;
    }
    out.peak = Math.max(out.peak, live);
    if (t >= nextGap && time > 0 && near < Infinity) {
      out.gaps.push({ t, nearest: near, time, cops: hud.survival?.cops ?? 0 });
      nextGap = t + 1;
    }
  }
  return out;
}

