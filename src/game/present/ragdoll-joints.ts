import type { RevoluteImpulseJoint, RigidBody, World } from "@dimforge/rapier3d";
import type { Rapier } from "../kernel/rapier.ts";
import { JOINTS, PARTS } from "./ragdoll-body.ts";

/**
 * The dummy's joints and what each may do (a crash-test dummy's neck does not fold into its chest). Rapier 0.19.3 takes
 * real limits in JS on revolute joints (`setLimits`) and, through the raw joint set, on each angular axis of a spherical
 * joint (Euler angles: x pitch, then y twist, then z roll). The solver holds them together with the contacts, so nothing
 * snaps or pops. A limit must stay well clear of ±180°, where the angle wraps: an arm limit at 150° blew dummies up
 * (400 throws: parts at 50–200 m/s) because a hard hit carried the angle over the wrap and the solver saw a 175° error.
 * Elbows and knees are hinges about x, the neck and hips spherical joints with Euler limits, and the shoulders plain
 * spherical joints: any limit on them (Euler angles are no cone round an arm that starts raised) blew up the same way.
 */
const DEG = Math.PI / 180;
/** `RawJointAxis` of the angular axes (the enum is not exported from the package's JS). */
const ANG = [3, 4, 5] as const;
/** Angle limits (rad) of a spherical joint's x, y, z rotation. */
type Euler = readonly [readonly [number, number], readonly [number, number], readonly [number, number]];
/** What a joint may do: bend about x between two angles (rad, growing toward the back, −z), swing within Euler limits, or (null) move freely. */
type Limit = { hinge: readonly [number, number] } | { euler: Euler } | null;

/** An elbow bends forward 120°, a knee back 120°; neither bends the wrong way at all. */
const ELBOW: Limit = { hinge: [-120 * DEG, 0] };
const KNEE: Limit = { hinge: [0, 120 * DEG] };
/** Neck: nods 45° either way, tilts 40° to a side (together at most 60°), turns 55°. */
const NECK: Limit = { euler: [[-45 * DEG, 45 * DEG], [-55 * DEG, 55 * DEG], [-40 * DEG, 40 * DEG]] };
/** Hip: a thigh swings forward 35° and back 10°, out 30° and across 5°, and turns 40°. Left and right mirror in roll. */
const HIP_L: Limit = { euler: [[-35 * DEG, 10 * DEG], [-40 * DEG, 40 * DEG], [-30 * DEG, 5 * DEG]] };
const HIP_R: Limit = { euler: [[-35 * DEG, 10 * DEG], [-40 * DEG, 40 * DEG], [-5 * DEG, 30 * DEG]] };
/** `JOINTS` order: neck, shoulder, elbow, shoulder, elbow, hip, knee, hip, knee. */
const LIMITS: readonly Limit[] = [NECK, null, ELBOW, null, ELBOW, HIP_L, KNEE, HIP_R, KNEE];
/**
 * The joints whose two parts also touch: the head on the chest (the neck's swing stops where the boxes meet, so the
 * head is never inside) and the arms on the chest (the shoulders have no limit of their own). The head sits `0.1` m
 * above its joint (`PARTS`) so a 45° nod still clears the chest; the thighs, whose boxes meet at the hip joint itself,
 * would stiffen to about 10° if they touched, so the hips keep their limits and no contact.
 */
const TOUCH = [0, 1, 3];

/** Build the dummy's joints between `bodies` (`JOINTS` order): limits set, contacts between jointed parts on only for `TOUCH`. */
export function joinUp(R: Rapier, world: World, bodies: readonly RigidBody[]): void {
  for (const [j, [a, b, x, y, z]] of JOINTS.entries()) {
    const pa = PARTS[a]!.c;
    const pb = PARTS[b]!.c;
    const at = [{ x: x - pa[0], y: y - pa[1], z: z - pa[2] }, { x: x - pb[0], y: y - pb[1], z: z - pb[2] }] as const;
    const limit = LIMITS[j]!;
    const hinge = limit !== null && "hinge" in limit;
    const joint = world.createImpulseJoint(hinge ? R.JointData.revolute(at[0], at[1], { x: 1, y: 0, z: 0 }) : R.JointData.spherical(at[0], at[1]), bodies[a]!, bodies[b]!, true);
    joint.setContactsEnabled(TOUCH.includes(j));
    if (limit === null) continue;
    if (hinge) (joint as RevoluteImpulseJoint).setLimits(limit.hinge[0], limit.hinge[1]);
    else for (const [k, [lo, hi]] of limit.euler.entries()) world.impulseJoints.raw.jointSetLimits(joint.handle, ANG[k]!, lo, hi);
  }
}
