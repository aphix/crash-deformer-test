import * as THREE from "three";
import { CAR_HALF } from "../vehicle/car.ts";
import { FREE, WALL, type Lab } from "./engine-lab.ts";

/** The screen box the pointer's client coordinates are read in (the canvas's `getBoundingClientRect`). */
type Rect = { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
/** A pointer sample: client px and its time (ms); a `pointermove` is one, plus the moves the browser held back into it. */
type Pointer = { readonly clientX: number; readonly clientY: number; readonly timeStamp: number };
type PointerMove = Pointer & { getCoalescedEvents?(): readonly Pointer[] };

/** The flick's feel: what a press picks, how the release speed maps to a launch, what is a tap, and what a swipe snaps to. */
const FLICK = {
  /** A press within this many CSS px of a car's or a dummy's middle, or inside its drawn half length (a dummy's: `dummyHalf` m), picks it. */
  pickPx: 48,
  dummyHalf: 0.8,
  /** Launch speed (m/s) per short side of the screen per second of release speed, and its range. */
  gain: 12,
  min: 6,
  max: 55,
  /** The release speed is the swipe's over its last `windowMs`. */
  windowMs: 100,
  /** A swipe shorter than this (px) is a tap: nothing leaves. */
  tapPx: 14,
  /** A swipe aims at the item (or the board) whose middle lies within this angle (rad) of its line on screen. */
  snap: (10 * Math.PI) / 180,
};
/** Pointer samples kept for the release speed: a 1000 Hz mouse's coalesced moves still fill the window. */
const SAMPLES = 128;
/** Dots along the predicted arc. */
const DOTS = 24;
/** The cue's colour from a soft flick to a full one. */
const SOFT = new THREE.Color(0x7fd6ff);
const HARD = new THREE.Color(0xff4b2b);

/**
 * The Lab's flick (phone first): a press on a car picks it (the camera's drag never starts), the swipe's line on screen picks what
 * it is thrown at (the item, or the pegboard, within `FLICK.snap` of it; else straight along it on the bench) and its speed at the
 * release sets the launch's. While the finger is down an arrow on the bench shows the aim and strength, and dots show the arc
 * (`Lab.flickAim`). Nothing allocates per pointer event.
 */
export class LabFlick {
  /** The cue: hidden unless a swipe is under way. */
  readonly group = new THREE.Group();
  private readonly arrow: THREE.Mesh;
  private readonly dots: THREE.InstancedMesh;
  private readonly cueMat: THREE.MeshBasicMaterial;
  private readonly camera: THREE.Camera;
  private readonly rect: () => Rect;
  private readonly lab: Lab;
  private readonly onFlick: (thing: number, target: number, dx: number, dz: number, speed: number) => void;
  /** The picked item (a layout index), -1 none, and what the swipe so far aims at (`aim`): an item, `WALL` or `FREE`. */
  private thing = -1;
  private target = FREE;
  /** The press (client px), the picked car's middle on screen, and its height (m): the level a free swipe is read on (`onLevel`). */
  private x0 = 0;
  private y0 = 0;
  private cx = 0;
  private cy = 0;
  private level = 0;
  /** Ring of the last `SAMPLES` pointer positions (px) and times (ms); `head` is the newest, `count` how many are set. */
  private readonly sx = new Float64Array(SAMPLES);
  private readonly sy = new Float64Array(SAMPLES);
  private readonly st = new Float64Array(SAMPLES);
  private head = 0;
  private count = 0;
  /** A free swipe's plan direction (unit). */
  private readonly dir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly at = new THREE.Vector3();
  private readonly from = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly px = new THREE.Vector2();
  private readonly aimOut = new THREE.Vector4();
  private readonly m4 = new THREE.Matrix4();

  constructor(camera: THREE.Camera, rect: () => Rect, lab: Lab, onFlick: (thing: number, target: number, dx: number, dz: number, speed: number) => void) {
    this.camera = camera;
    this.rect = rect;
    this.lab = lab;
    this.onFlick = onFlick;
    this.group.name = "lab-flick";
    this.group.visible = false;
    this.cueMat = new THREE.MeshBasicMaterial({ color: SOFT, transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false, side: THREE.DoubleSide });
    // A flat arrow along +z, its tail at the origin: shaft 0.65, head 0.35, 0.6 wide at the head.
    const shape = new THREE.Shape();
    shape.moveTo(-0.12, 0);
    shape.lineTo(0.12, 0);
    shape.lineTo(0.12, 0.65);
    shape.lineTo(0.3, 0.65);
    shape.lineTo(0, 1);
    shape.lineTo(-0.3, 0.65);
    shape.lineTo(-0.12, 0.65);
    shape.closePath();
    // The shape's xy plane laid on the ground: its +y becomes +z.
    this.arrow = new THREE.Mesh(new THREE.ShapeGeometry(shape).rotateX(Math.PI / 2), this.cueMat);
    this.arrow.renderOrder = 2;
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 8, 6), this.cueMat, DOTS);
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 2;
    this.group.add(this.arrow, this.dots);
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
      this.screen(this.at.addScaledVector(this.right, lab.slotOf[k]! >= 0 ? CAR_HALF.z : FLICK.dummyHalf), r);
      const reach = Math.max(FLICK.pickPx, Math.hypot(this.px.x - mx, this.px.y - my));
      const d = Math.hypot(x - mx, y - my);
      if (d <= reach && d < bestD) {
        bestD = d;
        best = k;
        this.cx = mx;
        this.cy = my;
      }
    }
    if (best < 0) return false;
    this.thing = best;
    this.x0 = x;
    this.y0 = y;
    this.level = lab.centre(best, this.at).y;
    this.count = 0;
    this.sample(x, y, t);
    return true;
  }

  /**
   * The picked car's swipe moves (a `pointermove`): the cue follows. Each move the browser coalesced into it is a sample: after
   * a long frame they all arrive in one event at the last's place, and without them the window would hold no travel.
   */
  move(e: PointerMove): void {
    if (this.thing < 0) return;
    const held = e.getCoalescedEvents?.();
    if (held && held.length > 0) for (let i = 0; i < held.length; i++) this.sample(held[i]!.clientX, held[i]!.clientY, held[i]!.timeStamp);
    else this.sample(e.clientX, e.clientY, e.timeStamp);
    const speed = this.aim(e.clientX, e.clientY, e.timeStamp);
    if (speed === 0) {
      this.group.visible = false;
      return;
    }
    this.cue(speed);
  }

  /** The release (or a cancel: nothing leaves): a swipe longer than a tap flicks the picked car. */
  up(x: number, y: number, t: number, cancel: boolean): void {
    const thing = this.thing;
    this.thing = -1;
    this.group.visible = false;
    if (thing < 0 || cancel) return;
    this.sample(x, y, t);
    this.thing = thing;
    const speed = this.aim(x, y, t);
    this.thing = -1;
    if (speed > 0) this.onFlick(thing, this.target, this.dir.x, this.dir.z, speed);
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
   * The swipe so far: what it aims at into `target` (the item or the board whose middle on screen lies nearest its line from the
   * car, within `FLICK.snap`; else `FREE`), a free swipe's plan direction into `dir`, and the launch speed (m/s) of a release now;
   * 0 while it is still a tap. A free swipe runs from the press's point to the finger's on the level of the car's middle; a finger
   * above the horizon falls back to the camera's turn (right is its right, up its forward).
   */
  private aim(x: number, y: number, t: number): number {
    const dx = x - this.x0;
    const dy = y - this.y0;
    const len = Math.hypot(dx, dy);
    if (len < FLICK.tapPx) return 0;
    const r = this.rect();
    const lab = this.lab;
    let best = FREE;
    let bestOff = FLICK.snap;
    for (let k = WALL; k < lab.layout.length; k++) {
      if (k >= 0 && !lab.canTarget(this.thing, k)) continue;
      if (!this.screen(lab.targetPoint(this.thing, k, this.at), r)) continue;
      const ox = this.px.x - this.cx;
      const oy = this.px.y - this.cy;
      const off = Math.acos(THREE.MathUtils.clamp((ox * dx + oy * dy) / (Math.hypot(ox, oy) * len || 1), -1, 1));
      if (off < bestOff) {
        bestOff = off;
        best = k;
      }
    }
    this.target = best;
    if (this.onLevel(this.x0, this.y0, this.from) && this.onLevel(x, y, this.at)) {
      this.dir.subVectors(this.at, this.from).setY(0).normalize();
    } else {
      const m = this.camera.matrixWorld;
      this.right.setFromMatrixColumn(m, 0).setY(0).normalize();
      // The camera looks down its −z.
      this.fwd.setFromMatrixColumn(m, 2).setY(0).normalize().negate();
      this.dir.copy(this.right).multiplyScalar(dx).addScaledVector(this.fwd, -dy).setY(0).normalize();
    }
    // The release speed over the window: the newest sample against the oldest still inside it.
    let old = this.head;
    for (let i = 1; i < this.count; i++) {
      const j = (this.head - i + SAMPLES) % SAMPLES;
      if (t - this.st[j]! > FLICK.windowMs) break;
      old = j;
    }
    const ms = t - this.st[old]!;
    const pxs = ms > 0.5 ? Math.hypot(x - this.sx[old]!, y - this.sy[old]!) / (ms / 1000) : 0;
    return THREE.MathUtils.clamp((FLICK.gain * pxs) / Math.max(1, Math.min(r.width, r.height)), FLICK.min, FLICK.max);
  }

  /** Where the ray through client (x, y) meets the picked car's middle's level (`level`), into `out`; false above the horizon. */
  private onLevel(x: number, y: number, out: THREE.Vector3): boolean {
    const r = this.rect();
    const eye = this.eye.setFromMatrixPosition(this.camera.matrixWorld);
    const ray = this.p.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1, 0.5).unproject(this.camera).sub(eye);
    const t = (this.level - eye.y) / ray.y;
    if (!(t > 0)) return false;
    out.copy(eye).addScaledVector(ray, t);
    return true;
  }

  /** Arrow and arc for a release at `speed` at `target` (or along `dir`). */
  private cue(speed: number): void {
    const lab = this.lab;
    lab.flickAim(this.thing, this.target, this.dir.x, this.dir.z, speed, this.aimOut);
    const v = this.aimOut;
    lab.centre(this.thing, this.at);
    const s = (speed - FLICK.min) / (FLICK.max - FLICK.min);
    this.cueMat.color.copy(SOFT).lerp(HARD, s);
    // On the bench under the car's middle, from its nose's reach out along the launch, longer the harder.
    const plan = Math.hypot(v.x, v.z) || 1;
    const reach = CAR_HALF.z + 0.3;
    this.arrow.position.set(this.at.x + (v.x / plan) * reach, this.at.y - 0.62, this.at.z + (v.z / plan) * reach);
    this.arrow.rotation.set(0, Math.atan2(v.x, v.z), 0);
    this.arrow.scale.set(1 + s, 1, 1 + 3 * s);
    for (let i = 0; i < DOTS; i++) {
      lab.flightAt(((i + 1) / DOTS) * v.w, this.at, null);
      this.m4.makeTranslation(this.at.x, this.at.y, this.at.z);
      this.dots.setMatrixAt(i, this.m4);
    }
    this.dots.instanceMatrix.needsUpdate = true;
    this.group.visible = true;
  }
}
