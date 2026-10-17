import * as THREE from "three";
import { JOINTS, PARTS } from "./ragdoll-body.ts";
import { BODY_VERTICES, bodyIndex, bodyPositions } from "./dummy-bodies.ts";

/**
 * The dummy's one continuous body and the skinning that poses it: `dummyGeometry` takes the three baked bodies (one topology,
 * three T-pose position sets), bends each into the rig's arms-down rest (`fitBody`), gives every vertex two of the ten `PARTS`
 * as bones with a blend between them, and lofts the wear (cap, hair, glasses, tie) on each build's measured head and chest.
 * `DummyMesh` (`ragdoll-mesh.ts`) poses it in the vertex shader; `skinPoint` is that skinning in TS (the picks and the tests).
 */

/** Colour roles: each vertex takes its colour from its slot's palette (`DummyMesh.dress`). */
export const ROLE = { SHIRT: 0, SKIN: 1, LEGS: 2, HAIR: 3, SHOE: 4, BRIM: 5, BADGE: 6, EYES: 7, LOCKS: 8, MUSTACHE: 9, TIE: 10, COLLAR: 11 } as const;
export const ROLES = 12;
/**
 * A slot's flags: its build (one of `BUILD`) and the optional bits it wears. A vertex is drawn when its kinds share the slot's
 * build bit and every optional bit its kinds hold is in the slot's flags: whiskers, a cap (a civilian's or a cop's), a uniform's
 * glasses, bare hair (no cap).
 */
export const BUILD = { MAN: 1, WOMAN: 2, PORTLY: 4 } as const;
export const WHISKERS = 8;
export const CAPPED = 16;
export const UNIFORM = 32;
export const BARE = 64;
export const OPTIONAL = WHISKERS | CAPPED | UNIFORM | BARE;
const CIVIL = BUILD.MAN | BUILD.WOMAN;
const EVERY_BUILD = CIVIL | BUILD.PORTLY;

/** Whether a vertex of `kinds` is drawn on a slot with `flags`: `dollShown` in the shader, line for line. */
export function isDrawn(kinds: number, flags: number): boolean {
  return (kinds & flags & EVERY_BUILD) !== 0 && (kinds & OPTIONAL & ~flags) === 0;
}

/** The geometry's attributes beside `position` and `normal`; the shader declares them by these names. */
export const BONES_ATTRIBUTE = "bones";
export const KINDS_ATTRIBUTE = "roleKind";

/** A slot's row in the pose texture: two texels per bone (translation, rotation), a texel per role colour, then the flags. */
const BONES = PARTS.length;
export const PALETTE_AT = BONES * 2;
export const FLAGS_AT = PALETTE_AT + ROLES;
export const ROW_TEXELS = FLAGS_AT + 1;

const TORSO = 0;
const HEAD = 1;
const [LEFT_ARM, RIGHT_ARM] = [2, 4];
const [LEFT_LEG, RIGHT_LEG] = [6, 8];
/** The rig's right-side joints (`JOINTS` rows: parent, child, x, y, z): the fitted body is bent and shifted onto these. */
const RIG_SHOULDER = new THREE.Vector3(JOINTS[3][2], JOINTS[3][3], JOINTS[3][4]);
const RIG_ELBOW_Y = JOINTS[4][3];
const RIG_HIP = new THREE.Vector3(JOINTS[7][2], JOINTS[7][3], JOINTS[7][4]);
const RIG_KNEE_Y = JOINTS[8][3];
const RIG_NECK_Y = JOINTS[0][3];

/** Rig head top (m): head centre plus its half height. The baked bodies are scaled to this. */
const RIG_TOP = 1.74;
/** The woman is shorter, so the shared height scale widens her past the man. This puts her shoulders back inside his. */
const WOMAN_NARROW = 0.9;

/** Smoothstep from `from` (0) to `to` (1), either way round; its steepest slope is `STEEPEST_SMOOTHSTEP / |to - from|`. */
function smooth(from: number, to: number, value: number): number {
  const fraction = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return fraction * fraction * (3 - 2 * fraction);
}
const STEEPEST_SMOOTHSTEP = 1.5;

/**
 * The shoulder's weight is one continuous function of where a vertex lies about the shoulder pivot: along the upper arm's axis
 * (`ALONG`, m from the pivot) and across it (`ACROSS`, m, negative under the arm). The baked edges are 5 to 6.7 cm at the
 * shoulder and the swing is 40 degrees, so the bands are wide: a weight falling over 0.10 m stretched a 5 cm edge to 12 cm, over 0.20 m to 9 cm.
 * The arm is 0.05 m in radius: its own vertices read ACROSS >= -0.06 and the chest under the armpit below -0.14.
 */
const SHOULDER_ALONG_FROM = -0.1;
const SHOULDER_ALONG_TO = 0.1;
const SHOULDER_ACROSS_FROM = -0.14;
const SHOULDER_ACROSS_TO = -0.06;
/** Half widths (m) of the elbow's and the wrist's blend along the arm (the elbow's is the skin band too). */
const ELBOW_HALF_BAND = 0.05;
const WRIST_HALF_BAND = 0.05;
/** An adult hand, wrist crease to fingertip (m): the wrist is this far back along the arm from the fitted fingertip. */
const HAND_LENGTH = 0.19;
/**
 * The thigh's weight climbs from 0 at `HIP_TOP` to 1 at `HIP_BOTTOM` (m; the hip joint sits in the middle). The crotch's
 * centre is lifted by `CROTCH_LIFT` into the torso's side of that over `CROTCH_WIDTH` of |x|, so the two legs do not tear the fork apart.
 */
const HIP_TOP = 0.92;
const HIP_BOTTOM = 0.76;
const CROTCH_LIFT = 0.06;
const CROTCH_WIDTH = 0.1;
/** The knee's blend half width (m): the shin's weight climbs across it. */
const KNEE_HALF_BAND = 0.05;
/**
 * The head's weight climbs over `NECK_FROM`..`NECK_TO` (m) in a height that sheds `NECK_SLANT` m per metre of |x| beyond the
 * neck's half width `NECK_HALF_WIDTH`, so the trapezius beside the neck never rides the head while the jaw is rigid on it.
 */
const NECK_FROM = 1.4;
const NECK_TO = 1.48;
const NECK_HALF_WIDTH = 0.07;
const NECK_SLANT = 1.2;

/**
 * The steepest each `JOINTS` row's blend weight climbs per metre, from the band widths above: a smoothstep of a coordinate
 * that itself moves at most `k` per metre climbs at most 1.5 k / width, and the product of smoothsteps of two orthogonal
 * coordinates at most the hypotenuse of their slopes. The joint-closure tests bound a band's stretch by it.
 */
const SLOPE_NECK = (STEEPEST_SMOOTHSTEP / (NECK_TO - NECK_FROM)) * Math.hypot(1, NECK_SLANT);
const SLOPE_SHOULDER = Math.hypot(STEEPEST_SMOOTHSTEP / (SHOULDER_ALONG_TO - SHOULDER_ALONG_FROM), STEEPEST_SMOOTHSTEP / (SHOULDER_ACROSS_TO - SHOULDER_ACROSS_FROM));
const SLOPE_ELBOW = STEEPEST_SMOOTHSTEP / (2 * ELBOW_HALF_BAND);
const SLOPE_HIP = (STEEPEST_SMOOTHSTEP / (HIP_TOP - HIP_BOTTOM)) * Math.hypot(1, (CROTCH_LIFT * STEEPEST_SMOOTHSTEP) / CROTCH_WIDTH);
const SLOPE_KNEE = STEEPEST_SMOOTHSTEP / (2 * KNEE_HALF_BAND);
export const JOINT_SLOPE = [SLOPE_NECK, SLOPE_SHOULDER, SLOPE_ELBOW, SLOPE_SHOULDER, SLOPE_ELBOW, SLOPE_HIP, SLOPE_KNEE, SLOPE_HIP, SLOPE_KNEE] as const;

/** One baked body fitted to the rig: its scaled T-pose, its arms-down rest, and the weights the bending and the skinning share. */
type Fit = {
  /** The T-pose scaled to the rig (x, y, z a vertex). */
  tpose: Float32Array;
  /** The rest pose: arms and legs bent straight down onto the rig's joints. */
  rest: Float32Array;
  /** 0 torso to 1 arm: the shoulder's blend. */
  shoulderWeight: Float32Array;
  /** 0 upper arm to 1 forearm: the elbow's blend (0 off the arm). */
  elbowWeight: Float32Array;
  /** 0 torso to 1 thigh: the hip's blend. */
  hipWeight: Float32Array;
  /** 0 torso to 1 head: the neck's blend. */
  neckWeight: Float32Array;
  /** The lowest y (m) of the rest arm: its fingertip, from which the wrist is `HAND_LENGTH` up. */
  fingertipY: number;
};

const vec3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const DOWN = vec3(0, -1, 0);
const NO_TURN = new THREE.Quaternion();

type Line = { at: THREE.Vector3; direction: THREE.Vector3 };
/** Only the arm (not the legs or the belly) is above this height (m) in an |x| slice out at the arm. */
const ARM_MIN_Y = 0.9;

/** The mean (x, y, z) of the vertices in each |x| slice from `from` to `to` (m, `step` wide): the arm's path. */
function slicePath(tpose: Float32Array, from: number, to: number, step: number): THREE.Vector3[] {
  const path: THREE.Vector3[] = [];
  for (let low = from; low < to - 1e-9; low += step) {
    const sum = vec3();
    let count = 0;
    for (let i = 0; i < tpose.length; i += 3) {
      const out = Math.abs(tpose[i]!);
      if (out < low || out >= low + step || tpose[i + 1]! < ARM_MIN_Y) continue;
      sum.add(vec3(out, tpose[i + 1]!, tpose[i + 2]!));
      count++;
    }
    if (count === 0) throw new RangeError(`no arm in the slice at |x| = ${low}`);
    path.push(sum.multiplyScalar(1 / count));
  }
  return path;
}

/** The least-squares line through `points`, y and z as linear functions of x. */
function fitLine(points: readonly THREE.Vector3[]): Line {
  const mean = points.reduce((sum, point) => sum.add(point), vec3()).multiplyScalar(1 / points.length);
  let [xx, xy, xz] = [0, 0, 0];
  for (const point of points) {
    xx += (point.x - mean.x) ** 2;
    xy += (point.x - mean.x) * (point.y - mean.y);
    xz += (point.x - mean.x) * (point.z - mean.z);
  }
  return { at: mean, direction: vec3(1, xy / xx, xz / xx).normalize() };
}

const pointAtX = (line: Line, x: number) => line.at.clone().addScaledVector(line.direction, (x - line.at.x) / line.direction.x);

type ArmMeasure = { shoulder: THREE.Vector3; elbow: THREE.Vector3; wrist: THREE.Vector3; fingertip: THREE.Vector3; upper: THREE.Vector3; fore: THREE.Vector3; hand: THREE.Vector3 };

/** The arm's path starts this far (m) out: past the belly of the portly man (0.27 m), where only the arm is. */
const ARM_PATH_FROM = 0.275;
/** The path ends this far (m) short of the farthest |x|: the hand's reach across x (the fingers fan out along the arm). */
const HAND_REACH_X = 0.17;
const ARM_PATH_STEP = 0.025;
/** The fingertip is the mean of the vertices this close (m) to the farthest |x|. */
const FINGERTIP_BAND = 0.02;
const WRIST_SEARCH_STEPS = 40;

/**
 * The arm of the scaled T-pose (mirrored to |x|), measured off its own vertices: its path is the mean of the vertices in each
 * |x| slice. The elbow is the path's sharpest turn (the angle between the path two slices before and two after); the upper
 * arm's and the forearm's axes are lines through the path either side of it; the shoulder pivot is the rig's upper arm length
 * back from the elbow along the upper axis (so the fitted elbow lands on the rig's); the wrist is `HAND_LENGTH` back from the
 * fingertip along the forearm's line.
 */
function measureArm(tpose: Float32Array): ArmMeasure {
  let farthest = 0;
  for (let i = 0; i < tpose.length; i += 3) farthest = Math.max(farthest, Math.abs(tpose[i]!));
  const path = slicePath(tpose, ARM_PATH_FROM, farthest - HAND_REACH_X, ARM_PATH_STEP);
  let [bend, sharpest] = [2, 0];
  for (let k = 2; k + 2 < path.length; k++) {
    const turn = path[k]!.clone().sub(path[k - 2]!).angleTo(path[k + 2]!.clone().sub(path[k]!));
    if (turn > sharpest) [bend, sharpest] = [k, turn];
  }
  const upper = fitLine(path.slice(0, bend + 1));
  const fore = fitLine(path.slice(bend));
  const elbow = pointAtX(upper, path[bend]!.x);
  const fingertip = vec3();
  let count = 0;
  for (let i = 0; i < tpose.length; i += 3) {
    if (Math.abs(tpose[i]!) < farthest - FINGERTIP_BAND) continue;
    fingertip.add(vec3(Math.abs(tpose[i]!), tpose[i + 1]!, tpose[i + 2]!));
    count++;
  }
  fingertip.multiplyScalar(1 / count);
  let [near, far] = [ARM_PATH_FROM, fingertip.x];
  for (let step = 0; step < WRIST_SEARCH_STEPS; step++) {
    const middle = (near + far) / 2;
    if (pointAtX(fore, middle).distanceTo(fingertip) > HAND_LENGTH) near = middle;
    else far = middle;
  }
  const wrist = pointAtX(fore, (near + far) / 2);
  const upperLength = RIG_SHOULDER.y - RIG_ELBOW_Y;
  return { shoulder: elbow.clone().addScaledVector(upper.direction, -upperLength), elbow, wrist, fingertip, upper: upper.direction, fore: fore.direction, hand: fingertip.clone().sub(wrist).normalize() };
}

type LegMeasure = { hip: THREE.Vector3; direction: THREE.Vector3 };

/** The leg is a line through the centres of its slices between these heights (m, `LEG_STEP` apart, `LEG_BAND` thick): from above the ankle to the thigh. */
const LEG_FROM = 0.2;
const LEG_TO = 0.72;
const LEG_STEP = 0.04;
const LEG_BAND = 0.02;

/** The leg of the scaled T-pose (the |x| mirror): the pivot is where its line crosses the rig's hip height. */
function measureLeg(tpose: Float32Array): LegMeasure {
  const centres: THREE.Vector3[] = [];
  for (let y = LEG_FROM; y <= LEG_TO + 1e-9; y += LEG_STEP) {
    let xRange: [number, number] = [Infinity, -Infinity];
    let zRange: [number, number] = [Infinity, -Infinity];
    for (let i = 0; i < tpose.length; i += 3) {
      if (tpose[i]! <= 0 || Math.abs(tpose[i + 1]! - y) > LEG_BAND) continue;
      xRange = [Math.min(xRange[0], tpose[i]!), Math.max(xRange[1], tpose[i]!)];
      zRange = [Math.min(zRange[0], tpose[i + 2]!), Math.max(zRange[1], tpose[i + 2]!)];
    }
    centres.push(vec3((xRange[0] + xRange[1]) / 2, y, (zRange[0] + zRange[1]) / 2));
  }
  const mean = centres.reduce((sum, centre) => sum.add(centre), vec3()).multiplyScalar(1 / centres.length);
  let [yy, yx, yz] = [0, 0, 0];
  for (const centre of centres) {
    yy += (centre.y - mean.y) ** 2;
    yx += (centre.y - mean.y) * (centre.x - mean.x);
    yz += (centre.y - mean.y) * (centre.z - mean.z);
  }
  const hipHeight = RIG_HIP.y - mean.y;
  return { hip: vec3(mean.x + (yx / yy) * hipHeight, RIG_HIP.y, mean.z + (yz / yy) * hipHeight), direction: vec3(-yx / yy, -1, -yz / yy).normalize() };
}

/**
 * `raw` (the baked T-pose, feet at 0) fitted to the rig: scaled so the crown meets `RIG_TOP`, then bent about the body's own
 * measured pivots, never blended, so every vertex keeps its distance to its pivot (no collapse, no sheet). The arm swings
 * down about the shoulder by the turn that lays its upper axis along -y, the forearm about the elbow and the hand about the
 * wrist by what is left of theirs, each by one smooth weight; each leg swings about its hip to hang straight. The
 * shoulder is then shifted onto the rig's shoulder and the hip onto its hip.
 */
function fitBody(raw: Float32Array, width = 1): Fit {
  const count = raw.length / 3;
  let height = 0;
  for (let i = 1; i < raw.length; i += 3) height = Math.max(height, raw[i]!);
  const scale = RIG_TOP / height;
  const tpose = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    tpose[i] = raw[i]! * scale * width;
    tpose[i + 1] = raw[i + 1]! * scale;
    tpose[i + 2] = raw[i + 2]! * scale;
  }
  const arm = measureArm(tpose);
  const leg = measureLeg(tpose);
  const turnToDown = (from: THREE.Vector3) => new THREE.Quaternion().setFromUnitVectors(from, DOWN);
  const shoulderTurn = turnToDown(arm.upper);
  const forearmAbsolute = turnToDown(arm.fore);
  const handAbsolute = turnToDown(arm.hand);
  const elbowTurn = shoulderTurn.clone().invert().multiply(forearmAbsolute);
  const wristTurn = forearmAbsolute.clone().invert().multiply(handAbsolute);
  const hipTurn = turnToDown(leg.direction);
  const upperAxis = arm.upper;
  const underNormal = vec3(-upperAxis.y, upperAxis.x, 0).normalize();
  const elbowAxis = arm.upper.clone().add(arm.fore).normalize();
  const wristAxis = arm.fore.clone().add(arm.hand).normalize();
  const rest = new Float32Array(raw.length);
  const shoulderWeight = new Float32Array(count);
  const elbowWeight = new Float32Array(count);
  const hipWeight = new Float32Array(count);
  const neckWeight = new Float32Array(count);
  const point = vec3();
  const offset = vec3();
  const partial = new THREE.Quaternion();
  const swing = (pivot: THREE.Vector3, turn: THREE.Quaternion, weight: number): void => {
    if (weight <= 0) return;
    point.sub(pivot).applyQuaternion(partial.copy(NO_TURN).slerp(turn, weight)).add(pivot);
  };
  let fingertipY = Infinity;
  for (let i = 0; i < count; i++) {
    const [x, y, z] = [tpose[i * 3]!, tpose[i * 3 + 1]!, tpose[i * 3 + 2]!];
    const side = x < 0 ? -1 : 1;
    const out = side * x;
    point.set(out, y, z);
    offset.copy(point).sub(arm.shoulder);
    const shoulder = smooth(SHOULDER_ALONG_FROM, SHOULDER_ALONG_TO, offset.dot(upperAxis)) * smooth(SHOULDER_ACROSS_FROM, SHOULDER_ACROSS_TO, offset.dot(underNormal));
    const elbow = shoulder * smooth(-ELBOW_HALF_BAND, ELBOW_HALF_BAND, offset.copy(point).sub(arm.elbow).dot(elbowAxis));
    const wrist = shoulder * smooth(-WRIST_HALF_BAND, WRIST_HALF_BAND, offset.copy(point).sub(arm.wrist).dot(wristAxis));
    const hip = smooth(HIP_TOP, HIP_BOTTOM, y + CROTCH_LIFT * (1 - smooth(0, CROTCH_WIDTH, out)));
    swing(arm.wrist, wristTurn, wrist);
    swing(arm.elbow, elbowTurn, elbow);
    swing(arm.shoulder, shoulderTurn, shoulder);
    point.addScaledVector(offset.copy(RIG_SHOULDER).sub(arm.shoulder), shoulder);
    swing(leg.hip, hipTurn, hip);
    point.addScaledVector(offset.copy(RIG_HIP).sub(leg.hip), hip);
    rest[i * 3] = side * point.x;
    rest[i * 3 + 1] = point.y;
    rest[i * 3 + 2] = point.z;
    shoulderWeight[i] = shoulder;
    elbowWeight[i] = elbow;
    hipWeight[i] = hip;
    neckWeight[i] = smooth(NECK_FROM, NECK_TO, y - NECK_SLANT * Math.max(0, out - NECK_HALF_WIDTH));
    if (shoulder >= 1) fingertipY = Math.min(fingertipY, point.y);
  }
  return { tpose, rest, shoulderWeight, elbowWeight, hipWeight, neckWeight, fingertipY };
}

let fits: { man: Fit; woman: Fit; portly: Fit } | undefined;
/** The three baked bodies fitted to the rig (computed once). */
export function restFits(): { man: Fit; woman: Fit; portly: Fit } {
  fits ??= { man: fitBody(bodyPositions("slenderMan")), woman: fitBody(bodyPositions("slenderWoman"), WOMAN_NARROW), portly: fitBody(bodyPositions("obeseMan")) };
  return fits;
}

/** A chest vertex of the fitted body: not an arm, a thigh or the neck. */
const isChest = (fit: Fit, i: number) => fit.shoulderWeight[i] === 0 && fit.hipWeight[i] === 0 && fit.neckWeight[i] === 0;

/**
 * The woman's breast peaks on the fitted mesh (m). The jiggle orbs sit on these, not on a guessed point:
 * each side's most forward chest vertex.
 */
export const CHEST_ORB = (() => {
  const woman = restFits().woman;
  const peak = { x: 0, y: 0, z: 0 };
  const left = { ...peak };
  const right = { ...peak };
  for (let i = 0; i < BODY_VERTICES; i++) {
    const [x, y, z] = [woman.rest[i * 3]!, woman.rest[i * 3 + 1]!, woman.rest[i * 3 + 2]!];
    if (!isChest(woman, i) || y < 1.05 || y > 1.42 || Math.abs(x) < 0.02 || Math.abs(x) > 0.16) continue;
    if (x < 0 && z > left.z) Object.assign(left, { x, y, z });
    if (x > 0 && z > right.z) Object.assign(right, { x, y, z });
  }
  const x = (Math.abs(left.x) + right.x) / 2;
  return { x, y: (left.y + right.y) / 2, r: Math.max(0.045, Math.min(0.08, x * 1.4)) };
})();

/** The head of a fitted body: chin and crown heights and, from the chin up, rings (y, half width in x, half depth, z of the middle) over the vertices that ride the head bone alone. */
type Head = { chin: number; top: number; rings: readonly (readonly [number, number, number, number])[] };
/** A face front is at least this far (m) in front of the neck's: the chin is the first height above the neck's joint whose centre line reaches it. */
const JAW_FRONT_Z = 0.07;
const CHIN_SEARCH_STEP = 0.005;
/** The centre line the chin is looked for on is this wide (m, half), and the head's rings are this far (m) apart and thick (half). */
const CENTRE_HALF_WIDTH = 0.03;
const HEAD_RING_STEP = 0.015;
const HEAD_RING_BAND = 0.0075;

function measureHead(fit: Fit): Head {
  const isHead = (i: number) => fit.neckWeight[i] === 1;
  let top = 0;
  for (let i = 0; i < BODY_VERTICES; i++) if (isHead(i)) top = Math.max(top, fit.rest[i * 3 + 1]!);
  let chin = 0;
  for (let y = RIG_NECK_Y; y < top && chin === 0; y += CHIN_SEARCH_STEP) {
    for (let i = 0; i < BODY_VERTICES; i++) {
      if (isHead(i) && Math.abs(fit.rest[i * 3]!) < CENTRE_HALF_WIDTH && Math.abs(fit.rest[i * 3 + 1]! - y) < HEAD_RING_BAND && fit.rest[i * 3 + 2]! > JAW_FRONT_Z) chin = y;
    }
  }
  const rings: [number, number, number, number][] = [];
  for (let y = chin; y < top; y += HEAD_RING_STEP) {
    let [halfWidth, back, front] = [0, Infinity, -Infinity];
    for (let i = 0; i < BODY_VERTICES; i++) {
      if (!isHead(i) || Math.abs(fit.rest[i * 3 + 1]! - y) > HEAD_RING_BAND) continue;
      halfWidth = Math.max(halfWidth, Math.abs(fit.rest[i * 3]!));
      back = Math.min(back, fit.rest[i * 3 + 2]!);
      front = Math.max(front, fit.rest[i * 3 + 2]!);
    }
    if (back > front) rings.push(rings[rings.length - 1]!);
    else rings.push([y, halfWidth, (front - back) / 2, (front + back) / 2]);
  }
  return { chin, top, rings };
}

/** The head's half width, half depth and middle z at height `y`, between its rings. */
function headAt(head: Head, y: number): readonly [number, number, number] {
  const rings = head.rings;
  if (y <= rings[0]![0]) return [rings[0]![1], rings[0]![2], rings[0]![3]];
  for (let i = 0; i + 1 < rings.length; i++) {
    const [low, high] = [rings[i]!, rings[i + 1]!];
    if (y > high[0]) continue;
    const t = (y - low[0]) / (high[0] - low[0]);
    return [low[1] + t * (high[1] - low[1]), low[2] + t * (high[2] - low[2]), low[3] + t * (high[3] - low[3])];
  }
  const last = rings[rings.length - 1]!;
  return [last[1], last[2], last[3]];
}

/**
 * The front-most z (m) of the fitted body's surface at (x, y): the highest plane of the triangles whose outline in the face
 * plane holds the point. The wear sits on this, not on the nearest vertex (the baked triangles are 5 to 7 cm across on the torso).
 */
function surfaceZ(fit: Fit, x: number, y: number): number {
  const index = bodyIndex();
  const p = fit.rest;
  let front = -Infinity;
  for (let t = 0; t < index.length; t += 3) {
    const [a, b, c] = [index[t]! * 3, index[t + 1]! * 3, index[t + 2]! * 3];
    const area = (p[b + 1]! - p[c + 1]!) * (p[a]! - p[c]!) + (p[c]! - p[b]!) * (p[a + 1]! - p[c + 1]!);
    if (Math.abs(area) < 1e-12) continue;
    const weightA = ((p[b + 1]! - p[c + 1]!) * (x - p[c]!) + (p[c]! - p[b]!) * (y - p[c + 1]!)) / area;
    const weightB = ((p[c + 1]! - p[a + 1]!) * (x - p[c]!) + (p[a]! - p[c]!) * (y - p[c + 1]!)) / area;
    if (weightA >= 0 && weightB >= 0 && weightA + weightB <= 1) front = Math.max(front, weightA * p[a + 2]! + weightB * p[b + 2]! + (1 - weightA - weightB) * p[c + 2]!);
  }
  if (front === -Infinity) throw new RangeError(`no body surface at (${x}, ${y})`);
  return front;
}

/** One cross-section: height, half widths in x and z (to the polygon's corners), the z of its middle, its role, and the share of its z half width its face half keeps (default 1). */
type Ring = readonly [y: number, halfWidth: number, halfDepth: number, middleZ: number, role: number, frontShare?: number];
/** A lofted shell: rings top to bottom around the vertical axis at `x`, riding one `bone`, closed at an end by a pole `top` above the first ring or `bottom` below the last (open when absent). `frontPower` narrows a brim so only the centre of the face half sticks out. */
type Shell = { x: number; sides: number; kinds: number; bone: number; rings: readonly Ring[]; top?: number; bottom?: number; frontPower?: number };

const { SHIRT, SKIN, LEGS, HAIR, SHOE, BRIM, BADGE, EYES, LOCKS, MUSTACHE, TIE, COLLAR } = ROLE;
/** 12, not 8: an octagon reads as a brick. Kept under the 12k triangle cap. */
const TUBE_SIDES = 12;
const BOX_SIDES = 4;

/** A box (a lofted square, flat ends) centred (x, y, z) with sizes (width, height, depth): the small features. */
function box(x: number, y: number, z: number, [width, height, depth]: readonly [number, number, number], role: number, kinds: number, bone: number): Shell {
  const corner = 1 / Math.cos(Math.PI / BOX_SIDES);
  const ring = (at: number): Ring => [at, (width / 2) * corner, (depth / 2) * corner, z, role];
  return { x, sides: BOX_SIDES, kinds, bone, rings: [ring(y + height / 2), ring(y - height / 2)], top: 0, bottom: 0 };
}

/** Rings over the measured head at heights `ys` (top to bottom), `out` m out of it, the face half of each ring scaled by `frontShare(y)` (below 1: under the skin, so the shell ends in a hairline). */
function overHead(head: Head, ys: readonly number[], out: number, role: number, frontShare: (y: number) => number): Ring[] {
  return ys.map((y): Ring => {
    const [halfWidth, halfDepth, middleZ] = headAt(head, y);
    return [y, halfWidth + out, halfDepth + out, middleZ, role, frontShare(y)];
  });
}

/**
 * The cap's peak stands this far (m) out of its crown, its reach falling off with the 4th power away from the centre (the
 * neighbours of the front vertex keep about a third of it: a visor, not a slab across the eyes). The peak's rings step down
 * from the rim by `PEAK_TOP_DROP` then `PEAK_DROP`.
 */
const PEAK_REACH = 0.045;
const PEAK_POWER = 4;
const PEAK_TOP_DROP = 0.004;
const PEAK_DROP = 0.01;
/** The crown's rings round the head's top at these drops (m) under it; a pole straight over a wide ring would be a cone. */
const CROWN_DROPS = [0.004, 0.016, 0.035];
/** Metres a crown, a woman's hair and the portly man's fuller hair stand out of the head. */
const CROWN_OUT = 0.02;
const HAIR_OUT = 0.016;
const FULL_HAIR_OUT = 0.025;
/** The woman's long hair stands 2 mm further out than a man's short hair, so it never z-fights a scalp painted under it. */
const LONG_HAIR_OUT = HAIR_OUT + 0.002;
/** The cap's rim sits at this fraction of the head's height above the chin: just over the brows. */
const RIM_AT = 0.74;
/** Hair rings below the rim go this far (share of the face half's depth) under the skin, so the shell ends in a hairline. */
const UNDER_SKIN = 0.5;
/** The fringe and the fuller hair end at these fractions of the head's height above the chin; the fuller hair's face half is this share under the skin. */
const FRINGE_AT = 0.62;
const FULL_HAIR_LOW_AT = 0.4;
const FULL_HAIR_UNDER_SKIN = 0.4;
/**
 * The woman's long hair hangs in rings at these fractions of the head's height above the chin (behind the ear, under the jaw,
 * over the shoulder, mid neck); each ring is `HANG_WIDEN` wider than the head's back at the first, narrows by `HANG_TAPER_X`
 * and `HANG_TAPER_Z` (m) a ring, starts `HANG_BACK_GAP` behind the head, and keeps `HANG_FRONT_SHARE` of its front half.
 */
const HAIR_HANG_AT = [0.35, 0.05, -0.07, -0.15];
const HANG_WIDEN = 0.03;
const HANG_TAPER_X = 0.005;
const HANG_HALF_DEPTH = 0.075;
const HANG_TAPER_Z = 0.008;
const HANG_BACK_GAP = 0.015;
const HANG_FRONT_SHARE = 0.5;
const HANG_END_CAP = 0.04;
const HANG_BACK_AT = 0.35;

/**
 * Where the eyes and the upper lip sit above the chin, as a fraction of the head's height (an adult face: eyes about half way
 * up, the lip a quarter). The face atlas's eye row (v = 0.61) lands on the eyes: its v runs from the chin up over `FACE_SPAN` of
 * the head's height, its u over `FACE_HALF_WIDTH` m either side of the middle (the atlas's eyes are 0.15 of u off centre:
 * 0.035 m, 0.07 m between the pupils on a head 0.16 m across).
 */
const EYES_AT = 0.54;
const LIP_AT = 0.26;
const FACE_SPAN = 0.885;
const FACE_HALF_WIDTH = 0.117;
/** Past this (z - middle) / half depth, a head vertex faces the front enough to take the face. */
const FACE_FRONT = 0.35;
/** The hairline's height as a fraction of the head's height above the chin at the forehead and behind the ears; the scalp above it is hair. */
const HAIRLINE_FRONT = 0.8;
const HAIRLINE_BACK = 0.3;
/** The hairline is the back's behind this (z - middle) / half depth and the forehead's past `HAIRLINE_FRONT_AT`. */
const HAIRLINE_BACK_AT = -0.2;
const HAIRLINE_FRONT_AT = 0.8;

/** A cop's glasses: a lens (m wide, tall, deep) at this |x| on the eye line, standing `LENS_OUT` out of the face. */
const LENS_X = 0.036;
const LENS_SIZE = [0.028, 0.012, 0.006] as const;
const LENS_OUT = 0.001;
/** The moustache: a bar on the upper lip, sunk `MOUSTACHE_SINK` into the face. */
const MOUSTACHE_SIZE = [0.04, 0.008, 0.012] as const;
const MOUSTACHE_SINK = 0.002;
/** The cop's badge: on the right of the chest at (x, y), `BADGE_OUT` out of it. */
const BADGE_AT = [0.095, 1.25] as const;
const BADGE_SIZE = [0.055, 0.065, 0.012] as const;
const BADGE_OUT = 0.002;
/** The portly man's tie: rings at these heights down his chest, `TIE_OUT` off it. */
const TIE_YS = [1.4, 1.33, 1.25, 1.15, 1.05, 0.99];
const TIE_HALF_WIDTH = 0.04;
const TIE_HALF_DEPTH = 0.02;
const TIE_OUT = 0.006;
/** His collar: rings dropping under the neck's measured section at `COLLAR_AT` (m), each wider by the neck's half width and depth plus these: (drop, widen, deepen). */
const COLLAR_AT = 1.47;
const COLLAR_RINGS = [[0.01, 0.012, 0.012], [0.035, 0.03, 0.025], [0.07, 0.065, 0.05]] as const;
const COLLAR_BAND = 0.01;
const COLLAR_MAX_X = 0.1;

/** The neck's section (m) at the collar's height: its half width, half depth and middle z. */
function measureNeck(fit: Fit): { halfWidth: number; halfDepth: number; middleZ: number } {
  let [halfWidth, back, front] = [0, Infinity, -Infinity];
  for (let i = 0; i < BODY_VERTICES; i++) {
    const [x, y, z] = [fit.rest[i * 3]!, fit.rest[i * 3 + 1]!, fit.rest[i * 3 + 2]!];
    if (Math.abs(y - COLLAR_AT) > COLLAR_BAND || Math.abs(x) > COLLAR_MAX_X || fit.shoulderWeight[i] !== 0) continue;
    halfWidth = Math.max(halfWidth, Math.abs(x));
    back = Math.min(back, z);
    front = Math.max(front, z);
  }
  return { halfWidth, halfDepth: (front - back) / 2, middleZ: (front + back) / 2 };
}

/** The wear of one build, on its own fitted body: cap crown and peak, long or fuller hair, a cop's glasses and badge, a moustache, the portly man's collar and tie. */
function wearFor(build: number, fit: Fit): Shell[] {
  const head = measureHead(fit);
  const { top, chin } = head;
  const height = top - chin;
  const at = (share: number) => chin + share * height;
  const rim = at(RIM_AT);
  const crownYs = [...CROWN_DROPS.map((drop) => top - drop), rim];
  const crown = overHead(head, crownYs, CROWN_OUT, HAIR, () => 1);
  const edge = crown[crown.length - 1]!;
  const reach = 1 + PEAK_REACH / edge[2];
  const peakRing = (drop: number, frontShare?: number): Ring => [edge[0] - drop, edge[1], edge[2], edge[3], BRIM, frontShare];
  const onHead = (kinds: number, rings: readonly Ring[], poleTop?: number, poleBottom?: number): Shell => ({ x: 0, sides: TUBE_SIDES, kinds, bone: HEAD, rings, top: poleTop, bottom: poleBottom });
  const peak = { ...onHead(build | CAPPED, [peakRing(0), peakRing(PEAK_TOP_DROP, reach), peakRing(PEAK_DROP, reach), peakRing(PEAK_DROP)]), frontPower: PEAK_POWER };
  const shells = [onHead(build | CAPPED, crown, top + CROWN_OUT - crownYs[0]!), peak];
  if (build === BUILD.WOMAN) {
    const back = headAt(head, at(HANG_BACK_AT));
    const backZ = back[2] - back[1];
    const hang = HAIR_HANG_AT.map((share, k): Ring => [at(share), back[0] + HANG_WIDEN - HANG_TAPER_X * k, HANG_HALF_DEPTH - HANG_TAPER_Z * k, backZ - HANG_BACK_GAP + HANG_HALF_DEPTH - HANG_TAPER_Z * k, LOCKS, HANG_FRONT_SHARE]);
    const crownHair = overHead(head, [...crownYs, at(FRINGE_AT)], LONG_HAIR_OUT, LOCKS, (y) => (y < rim ? UNDER_SKIN : 1));
    shells.push(onHead(BUILD.WOMAN, [...crownHair, ...hang], top + LONG_HAIR_OUT - crownYs[0]!, HANG_END_CAP));
  }
  if (build === BUILD.PORTLY) {
    const fuller = overHead(head, [...crownYs, at(FRINGE_AT), at(FULL_HAIR_LOW_AT)], FULL_HAIR_OUT, HAIR, (y) => (y < at(FRINGE_AT) ? FULL_HAIR_UNDER_SKIN : 1));
    shells.push(onHead(BUILD.PORTLY | BARE, fuller, top + FULL_HAIR_OUT - crownYs[0]!));
  }
  for (const side of [-1, 1]) shells.push(box(side * LENS_X, at(EYES_AT), surfaceZ(fit, side * LENS_X, at(EYES_AT)) + LENS_OUT, LENS_SIZE, EYES, build | UNIFORM, HEAD));
  shells.push(box(0, at(LIP_AT), surfaceZ(fit, 0, at(LIP_AT)) - MOUSTACHE_SINK, MOUSTACHE_SIZE, MUSTACHE, build | WHISKERS, HEAD));
  shells.push(box(BADGE_AT[0], BADGE_AT[1], surfaceZ(fit, BADGE_AT[0], BADGE_AT[1]) + BADGE_OUT, BADGE_SIZE, BADGE, build | UNIFORM, TORSO));
  if (build === BUILD.PORTLY) {
    const neck = measureNeck(fit);
    const collar = COLLAR_RINGS.map(([drop, widen, deepen]): Ring => [COLLAR_AT - drop, neck.halfWidth + widen, neck.halfDepth + deepen, neck.middleZ, COLLAR]);
    const tie = TIE_YS.map((y): Ring => [y, TIE_HALF_WIDTH, TIE_HALF_DEPTH, surfaceZ(fit, 0, y) + TIE_OUT, TIE]);
    shells.push({ x: 0, sides: TUBE_SIDES, kinds: BUILD.PORTLY, bone: TORSO, rings: collar }, { x: 0, sides: BOX_SIDES, kinds: BUILD.PORTLY, bone: TORSO, rings: tie, bottom: 0 });
  }
  return shells;
}

type Lofted = { position: number[]; bones: number[]; roleKind: number[]; index: number[] };

/** Shell `shell` into `mesh`: its rings joined side to side, its ends closed by a fan to a pole. The winding faces out only for rings running top to bottom. */
function loft(shell: Shell, mesh: Lofted): void {
  for (let r = 1; r < shell.rings.length; r++) {
    if (shell.rings[r]![0] > shell.rings[r - 1]![0]) throw new RangeError(`a shell's ring at y = ${shell.rings[r]![0]} is above the one before it (rings run top to bottom, else the shell is drawn inside out)`);
  }
  const sides = shell.sides;
  const phase = Math.PI / sides;
  const addVertex = (y: number, x: number, z: number, role: number): number => {
    mesh.bones.push(shell.bone, shell.bone, 0);
    mesh.roleKind.push(role, shell.kinds);
    mesh.position.push(x, y, z);
    return mesh.position.length / 3 - 1;
  };
  const rings = shell.rings.map(([y, halfWidth, halfDepth, middleZ, role, frontShare = 1]) =>
    Array.from({ length: sides }, (_, k) => {
      const angle = phase + (2 * Math.PI * k) / sides;
      const toFront = Math.sin(angle);
      const frontScale = toFront > 0 ? (shell.frontPower === undefined ? frontShare : 1 + (frontShare - 1) * toFront ** shell.frontPower) : 1;
      return addVertex(y, shell.x + halfWidth * Math.cos(angle), middleZ + halfDepth * toFront * frontScale, role);
    }),
  );
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let k = 0; k < sides; k++) {
      const [a, b, c, d] = [rings[r]![k]!, rings[r]![(k + 1) % sides]!, rings[r + 1]![(k + 1) % sides]!, rings[r + 1]![k]!];
      mesh.index.push(a, b, d, b, c, d);
    }
  }
  const close = (ring: number[], at: Ring, poleOffset: number, up: boolean): void => {
    const pole = addVertex(at[0] + poleOffset, shell.x, at[3], at[4]);
    for (let k = 0; k < sides; k++) mesh.index.push(pole, up ? ring[(k + 1) % sides]! : ring[k]!, up ? ring[k]! : ring[(k + 1) % sides]!);
  };
  if (shell.top !== undefined) close(rings[0]!, shell.rings[0]!, shell.top, true);
  if (shell.bottom !== undefined) close(rings[rings.length - 1]!, shell.rings[shell.rings.length - 1]!, -shell.bottom, false);
}

/** Bones (first, second, weight of the second) for a `weight` between `first` and `second`: a whole weight is the one bone alone. */
function blendOf(first: number, second: number, weight: number): [number, number, number] {
  return weight <= 0 ? [first, first, 0] : weight >= 1 ? [second, second, 0] : [first, second, weight];
}

/** The man's bare torso is narrowest between these heights (m): the hips and the navel, above which the ribs narrow again. Trousers start there. */
const WAIST_FROM = 0.94;
const WAIST_TO = 1.1;
const WAIST_STEP = 0.01;

/** Waist (m): the narrowest height of the bare torso between `WAIST_FROM` and `WAIST_TO`. */
function waistOf(fit: Fit): number {
  let [narrowest, waist] = [Infinity, 1];
  for (let y = WAIST_FROM; y <= WAIST_TO; y += WAIST_STEP) {
    let halfWidth = 0;
    for (let i = 0; i < BODY_VERTICES; i++) {
      if (fit.shoulderWeight[i] === 0 && fit.hipWeight[i] === 0 && Math.abs(fit.rest[i * 3 + 1]! - y) < WAIST_STEP) halfWidth = Math.max(halfWidth, Math.abs(fit.rest[i * 3]!));
    }
    if (halfWidth > 0 && halfWidth < narrowest) [narrowest, waist] = [halfWidth, y];
  }
  return waist;
}

/** The foot is the shoe below this height (m); the shin above is the trouser's. */
const FOOT_TOP = 0.1;
/** At the back of the neck the skin begins where the neck's blend is half done: a shirt's collar rises at the nape. */
const NAPE_SKIN_WEIGHT = 0.5;

/**
 * The body's bones, roles and face uv, from the man's fit: the three builds share one topology, so a vertex is the same
 * anatomy on each. Neck skin begins where the neck's blend does, so the shirt's neckline follows the trapezius up to the
 * neck instead of cutting the mesh's rings in a zigzag.
 */
function paintBody(fit: Fit): { bones: number[]; roleKind: number[]; faceUv: number[] } {
  const head = measureHead(fit);
  const height = head.top - head.chin;
  const waist = waistOf(fit);
  const wrist = fit.fingertipY + HAND_LENGTH;
  const bones: number[] = [];
  const roleKind: number[] = [];
  const faceUv: number[] = [];
  for (let i = 0; i < BODY_VERTICES; i++) {
    const [x, y, z] = [fit.rest[i * 3]!, fit.rest[i * 3 + 1]!, fit.rest[i * 3 + 2]!];
    const isLeft = fit.tpose[i * 3]! < 0;
    const upperArm = isLeft ? LEFT_ARM : RIGHT_ARM;
    const thigh = isLeft ? LEFT_LEG : RIGHT_LEG;
    const kneeWeight = smooth(RIG_KNEE_Y + KNEE_HALF_BAND, RIG_KNEE_Y - KNEE_HALF_BAND, y);
    if (fit.shoulderWeight[i]! > 0) bones.push(...(fit.shoulderWeight[i]! < 1 ? blendOf(TORSO, upperArm, fit.shoulderWeight[i]!) : blendOf(upperArm, upperArm + 1, fit.elbowWeight[i]!)));
    else if (fit.hipWeight[i]! > 0) bones.push(...(fit.hipWeight[i]! < 1 ? blendOf(TORSO, thigh, fit.hipWeight[i]!) : blendOf(thigh, thigh + 1, kneeWeight)));
    else bones.push(...blendOf(TORSO, HEAD, fit.neckWeight[i]!));
    const isHand = fit.shoulderWeight[i]! >= 1 && y < wrist;
    const isSkin = isHand || fit.neckWeight[i]! > (z < 0 ? NAPE_SKIN_WEIGHT : 0);
    const role = y < FOOT_TOP ? SHOE : isSkin ? SKIN : fit.shoulderWeight[i] === 0 && y < waist ? LEGS : SHIRT;
    let kind: number = role;
    let faceAt: [number, number] = [-1, -1];
    if (fit.neckWeight[i] === 1 && role === SKIN) {
      const [, halfDepth, middleZ] = headAt(head, y);
      const frontness = (z - middleZ) / halfDepth;
      const hairline = head.chin + height * (HAIRLINE_BACK + (HAIRLINE_FRONT - HAIRLINE_BACK) * smooth(HAIRLINE_BACK_AT, HAIRLINE_FRONT_AT, frontness));
      if (y > hairline) kind = y > head.chin + RIM_AT * height ? HAIR : LOCKS;
      else if (frontness > FACE_FRONT && y > head.chin && Math.abs(x) < FACE_HALF_WIDTH) faceAt = [0.5 + x / (2 * FACE_HALF_WIDTH), (y - head.chin) / (FACE_SPAN * height)];
    }
    roleKind.push(kind, EVERY_BUILD);
    faceUv.push(...faceAt);
  }
  return { bones, roleKind, faceUv };
}

/** The baked bodies, plus each build's cap, hair, tie, glasses and badge lofted on after. One vertex order; three position attributes. */
export function dummyGeometry(): THREE.BufferGeometry {
  const { man, woman, portly } = restFits();
  const index = Array.from(bodyIndex());
  const { bones, roleKind, faceUv } = paintBody(man);
  const wear: Lofted = { position: [], bones: [], roleKind: [], index: [] };
  for (const [build, fit] of [[BUILD.MAN, man], [BUILD.WOMAN, woman], [BUILD.PORTLY, portly]] as const) for (const shell of wearFor(build, fit)) loft(shell, wear);
  const geometry = new THREE.BufferGeometry();
  const withWear = (body: Float32Array) => {
    const all = new Float32Array(body.length + wear.position.length);
    all.set(body);
    all.set(wear.position, body.length);
    return all;
  };
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(withWear(man.rest), 3));
  geometry.setAttribute("shapeWoman", new THREE.Float32BufferAttribute(withWear(woman.rest), 3));
  geometry.setAttribute("shapePortly", new THREE.Float32BufferAttribute(withWear(portly.rest), 3));
  geometry.setAttribute("faceUv", new THREE.Float32BufferAttribute(faceUv.concat(new Array<number>((wear.position.length / 3) * 2).fill(-1)), 2));
  geometry.setAttribute(BONES_ATTRIBUTE, new THREE.Float32BufferAttribute(bones.concat(wear.bones), 3));
  geometry.setAttribute(KINDS_ATTRIBUTE, new THREE.Float32BufferAttribute(roleKind.concat(wear.roleKind), 2));
  for (const vertex of wear.index) index.push(vertex + BODY_VERTICES);
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();

/** Rest point `v` posed by `slot`'s bones `a` and `b` (weight `w` on b) in the pose rows `data`: each bone's rigid move, blended. */
export function skinPoint(data: Float32Array, slot: number, a: number, b: number, w: number, v: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const ta = slot * ROW_TEXELS * 4 + a * 8;
  const tb = slot * ROW_TEXELS * 4 + b * 8;
  _pa.copy(v).applyQuaternion(_qa.fromArray(data, ta + 4));
  _pb.copy(v).applyQuaternion(_qb.fromArray(data, tb + 4));
  return out.set(
    (1 - w) * (data[ta]! + _pa.x) + w * (data[tb]! + _pb.x),
    (1 - w) * (data[ta + 1]! + _pa.y) + w * (data[tb + 1]! + _pb.y),
    (1 - w) * (data[ta + 2]! + _pa.z) + w * (data[tb + 2]! + _pb.z),
  );
}
