import * as THREE from "three";
import { planHalf } from "../scenes/lab.ts";
import { hypot2 } from "../kernel/physics-core.js";
import type { Lab } from "./engine-lab.ts";

/** The screen box the pointer's client coordinates are read in (the canvas's `getBoundingClientRect`). */
type Rect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
/** A pointer sample: client px and its time (ms); a `pointermove` is one, plus the moves the browser held back into it. */
type Pointer = { readonly clientX: number; readonly clientY: number; readonly timeStamp: number };
type PointerMove = Pointer & { getCoalescedEvents?(): readonly Pointer[] };

/** The flick's feel: what a press picks, what is a tap, over what time the release velocity is read, and the speed cap. */
export const FLICK = {
  /** A press within this many CSS px of a car's or a dummy's middle, or inside its drawn half length (a dummy's: `dummyHalf` m), picks it. */
  pickPx: 48,
  dummyHalf: 0.8,
  /** A swipe shorter than this (px) from the press is a tap: nothing leaves. */
  tapPx: 14,
  /** The release velocity is the swipe's over its last `windowMs`. */
  windowMs: 100,
  /** Launch speed cap (m/s): the bench's hits are measured nowhere faster (nothing passes through anything at 55). */
  max: 55,
  /**
   * How far apart (sine of the angle between them) the on-screen directions of the bench axis and of up must be to read a
   * swipe on the throw plane. Closer, the camera looks along the bench: the swipe is read as a tap and nothing leaves.
   */
  axesApart: 0.1,
};
/** Pointer samples kept for the release velocity: a 1000 Hz mouse's coalesced moves still fill the window. */
const SAMPLES = 128;
/** The bench's long axis, and up: the two axes of the throw plane, which holds the picked item. */
const BENCH_AXIS = new THREE.Vector3(1, 0, 0);
const UP_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * The Lab's flick (phone first): a press on a car, dummy or prop picks it (the camera's drag never starts); on the release it
 * leaves from where it is at the swipe's own velocity on the throw plane: the upright plane through it that holds the bench's
 * long axis (`BENCH_AXIS`). The swipe's screen velocity over its last `FLICK.windowMs` is read through the on-screen directions
 * of the plane's two axes at the item (a 2x2 solve), so it launches along the bench and up or down, never across it.
 * Nothing allocates per pointer event.
 */
export class LabFlick {
  private readonly camera: THREE.Camera;
  private readonly rect: () => Rect;
  private readonly lab: Lab;
  private readonly onFlick: (thing: number, velocity: THREE.Vector3) => void;
  /** The picked item (a layout index), -1 none. */
  private thing = -1;
  /** The press (client px). */
  private x0 = 0;
  private y0 = 0;
  /** Ring of the last `SAMPLES` pointer positions (px) and times (ms); `head` is the newest, `count` how many are set. */
  private readonly sx = new Float64Array(SAMPLES);
  private readonly sy = new Float64Array(SAMPLES);
  private readonly st = new Float64Array(SAMPLES);
  private head = 0;
  private count = 0;
  private readonly right = new THREE.Vector3();
  private readonly at = new THREE.Vector3();
  private readonly axisPoint = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly px = new THREE.Vector2();
  private readonly velocity = new THREE.Vector3();

  constructor(camera: THREE.Camera, rect: () => Rect, lab: Lab, onFlick: (thing: number, velocity: THREE.Vector3) => void) {
    this.camera = camera;
    this.rect = rect;
    this.lab = lab;
    this.onFlick = onFlick;
  }

  /** A press at client (x, y), `t` ms: picks the car or dummy under it (its middle within `pickPx`, or inside its drawn half length). */
  down(x: number, y: number, t: number): boolean {
    const r = this.rect();
    if (r.width < 2 || r.height < 2) return false;
    let best = -1;
    let bestD = Infinity;
    const lab = this.lab;
    this.right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    for (let s = 0; s < lab.thingN; s++) {
      const k = lab.things[s]!;
      if (!this.screen(lab.centre(k, this.at), r)) continue;
      const mx = this.px.x;
      const my = this.px.y;
      // The thing's drawn half length: its middle moved that far along the camera's right, on screen.
      const item = lab.layout[k]!;
      this.screen(this.at.addScaledVector(this.right, item.kind === "car" ? planHalf(item.type.style).hz : FLICK.dummyHalf), r);
      const reach = Math.max(FLICK.pickPx, hypot2(this.px.x - mx, this.px.y - my));
      const d = hypot2(x - mx, y - my);
      if (d <= reach && d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best < 0) return false;
    this.thing = best;
    this.x0 = x;
    this.y0 = y;
    this.count = 0;
    this.sample(x, y, t);
    return true;
  }

  /**
   * The picked item's swipe moves (a `pointermove`). Each move the browser coalesced into it is a sample: after a long frame
   * they all arrive in one event at the last's place, and without them the window would hold no travel.
   */
  move(e: PointerMove): void {
    if (this.thing < 0) return;
    const held = e.getCoalescedEvents?.();
    if (held && held.length > 0) for (let i = 0; i < held.length; i++) this.sample(held[i]!.clientX, held[i]!.clientY, held[i]!.timeStamp);
    else this.sample(e.clientX, e.clientY, e.timeStamp);
  }

  /** The release (or a cancel: nothing leaves): a swipe longer than a tap, read on the throw plane, flicks the picked item. */
  up(x: number, y: number, t: number, cancel: boolean): void {
    const thing = this.thing;
    this.thing = -1;
    if (thing < 0 || cancel) return;
    this.sample(x, y, t);
    if (hypot2(x - this.x0, y - this.y0) < FLICK.tapPx) return;
    if (this.planeVelocity(thing, t)) this.onFlick(thing, this.velocity);
  }

  private sample(x: number, y: number, t: number): void {
    this.head = (this.head + 1) % SAMPLES;
    this.sx[this.head] = x;
    this.sy[this.head] = y;
    this.st[this.head] = t;
    if (this.count < SAMPLES) this.count++;
  }

  /** `v` on the screen (client px) into `px`; false when it is behind the camera. */
  private screen(v: THREE.Vector3, r: Rect): boolean {
    this.p.copy(v).project(this.camera);
    if (this.p.z < -1 || this.p.z > 1) return false;
    this.px.set(r.left + ((this.p.x + 1) / 2) * r.width, r.top + ((1 - this.p.y) / 2) * r.height);
    return true;
  }

  /**
   * The swipe's velocity (m/s) on the throw plane through item `thing`, into `velocity` (along the bench, up, never across): its
   * screen velocity over the last `FLICK.windowMs` before `t`, solved through the on-screen vectors of one metre along the bench
   * and one up at the item. False (a tap) when the item is off the camera, the two vectors lie within `FLICK.axesApart` of
   * parallel (the camera looks along the bench), or the swipe is still. Speeds past `FLICK.max` keep their direction.
   */
  private planeVelocity(thing: number, t: number): boolean {
    const r = this.rect();
    const centre = this.lab.centre(thing, this.at);
    if (!this.screen(centre, r)) return false;
    const cx = this.px.x;
    const cy = this.px.y;
    if (!this.screen(this.axisPoint.copy(centre).add(BENCH_AXIS), r)) return false;
    const benchX = this.px.x - cx;
    const benchY = this.px.y - cy;
    if (!this.screen(this.axisPoint.copy(centre).add(UP_AXIS), r)) return false;
    const upX = this.px.x - cx;
    const upY = this.px.y - cy;
    const det = benchX * upY - benchY * upX;
    if (Math.abs(det) < FLICK.axesApart * hypot2(benchX, benchY) * hypot2(upX, upY)) return false;
    let old = this.head;
    for (let i = 1; i < this.count; i++) {
      const j = (this.head - i + SAMPLES) % SAMPLES;
      if (t - this.st[j]! > FLICK.windowMs) break;
      old = j;
    }
    const seconds = (t - this.st[old]!) / 1000;
    if (seconds <= 0) return false;
    const swipeX = (this.sx[this.head]! - this.sx[old]!) / seconds;
    const swipeY = (this.sy[this.head]! - this.sy[old]!) / seconds;
    const along = (swipeX * upY - swipeY * upX) / det;
    const up = (benchX * swipeY - benchY * swipeX) / det;
    const speed = hypot2(along, up);
    if (speed === 0) return false;
    const cap = Math.min(speed, FLICK.max) / speed;
    this.velocity.set(along * cap, up * cap, 0);
    return true;
  }
}
