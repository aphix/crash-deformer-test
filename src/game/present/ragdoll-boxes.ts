import * as THREE from "three";
import type { RigidBody, World } from "@dimforge/rapier3d-simd";
import type { Rapier } from "../kernel/rapier.ts";
import { readPose } from "./ragdoll-body.ts";
import { knockedGroups } from "./ragdoll-config.ts";

/** One cardboard box in world coordinates: its centre, its turn about the vertical (rad), and its full size (m). */
export type BoxPlacement = { x: number; y: number; z: number; yaw: number; width: number; height: number; depth: number };

/** A release-velocity multiplier: `forward` scales the horizontal (x, z) components, `upward` the vertical (y) one. */
export type ReleaseScale = { forward: number; upward: number };
/** The event's own release velocity, unscaled. */
export const NO_RELEASE_SCALE: ReleaseScale = { forward: 1, upward: 1 };

/** Floats per box in `BoxPile.copyPoses`: position xyz, then rotation xyzw. */
export const BOX_POSE_FLOATS = 7;
/**
 * Mass of the board per m² of a carton's surface (kg): single-wall corrugated board is about 0.55 kg/m², and an empty carton is its
 * six faces only, so a 2.1 m cube is 14.6 kg and a 0.9 m one 2.7 kg. A mass per volume instead (15 kg/m³ was the first try) made a
 * 2.6 m box 264 kg: the dummy's 60 m/s landings then moved no box (0.01 m) where this lets them shove boxes several metres.
 */
const CARDBOARD_KG_PER_SQUARE_METRE = 0.55;
/**
 * Air drag on a carton as a damping (per s) at a shove's typical 10 m/s: half the air's 1.2 kg/m³ times a cube's drag coefficient (about
 * 1) times 10 m/s times its frontal area per kg (a face's L² over six faces' 0.55 kg/m², 0.3 m²/kg) is 1.9 per s. Light board is mostly
 * drag: its fall speed is under 6 m/s, and without any (the dummy's 0.05 per s) a shoved box slid 40 m (measured).
 */
const CARDBOARD_DAMPING = 1.9;
/** Cardboard's grip; its Max rule holds it against the dummy's own Min-rule 0.12 (`SLIDE`), without which a dummy skated over the stacks and 10 of 15 drops moved no box (measured). */
const CARDBOARD_FRICTION = 0.6;
/** A carton hardly bounces. */
const CARDBOARD_RESTITUTION = 0.05;

const _q = new THREE.Quaternion();
const Y = new THREE.Vector3(0, 1, 0);
const _still = { x: 0, y: 0, z: 0 };
const _rot = { x: 0, y: 0, z: 0, w: 1 };

/**
 * A pile of cardboard boxes as dynamic cuboids in the dummies' world (cosmetic, like the knocked props): created and restacked
 * asleep, so a pile stands where it was put until something hits it. They collide with the world, the dummies, the cars and each
 * other (`knockedGroups`), so a dummy thrown into the pile comes to rest on or among them and the boxes he hits tumble.
 * Placements are remembered: `restack` puts every box back, and a pile set before Rapier is in is built when it is.
 */
export class BoxPile {
  private R: Rapier | null = null;
  private world: World | null = null;
  private placements: readonly BoxPlacement[] = [];
  private bodies: RigidBody[] = [];
  /** Per box, its pose (`BOX_POSE_FLOATS` floats) as last read: a sleeping box is read once, when it is first seen asleep. */
  private poses = new Float32Array(0);
  private seenAsleep = new Uint8Array(0);
  private awake = 0;

  /** Rapier is in: build the boxes `set` before it was. */
  load(R: Rapier, world: World): void {
    this.R = R;
    this.world = world;
    this.build();
  }

  /** Replace the pile with boxes at `placements`, all asleep. */
  set(placements: readonly BoxPlacement[]): void {
    this.placements = placements.map((placement) => ({ ...placement }));
    this.build();
  }

  /** No boxes, and none remembered. */
  clear(): void {
    this.placements = [];
    this.build();
  }

  get count(): number {
    return this.bodies.length;
  }

  /** Is every box asleep (as of the last `capture`)? Nothing needs stepping for the pile then. */
  asleep(): boolean {
    return this.awake === 0;
  }

  /** Every box back at its placement, still, asleep. */
  restack(): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i]!;
      const placement = this.placements[i]!;
      body.setTranslation({ x: placement.x, y: placement.y, z: placement.z }, false);
      body.setRotation(turned(placement), false);
      body.setLinvel(_still, false);
      body.setAngvel(_still, false);
      body.sleep();
    }
    this.writePlacedPoses();
  }

  /** The poses after the last step (`readPose`) of every box that is awake or was not read asleep yet. */
  capture(): void {
    this.awake = 0;
    for (let i = 0; i < this.bodies.length; i++) {
      const body = this.bodies[i]!;
      const asleep = body.isSleeping();
      if (!asleep) this.awake++;
      if (asleep && this.seenAsleep[i]) continue;
      readPose(body, this.poses, i * BOX_POSE_FLOATS);
      this.seenAsleep[i] = asleep ? 1 : 0;
    }
  }

  /** Every box's pose into `out` (`BOX_POSE_FLOATS` each, in placement order); returns how many boxes there are. Throws when `out` is too short. */
  copyPoses(out: Float32Array): number {
    out.set(this.poses);
    return this.bodies.length;
  }

  /** The world is being freed with its bodies: forget them. */
  dispose(): void {
    this.bodies = [];
    this.world = null;
    this.R = null;
  }

  private build(): void {
    if (this.world) for (const body of this.bodies) this.world.removeRigidBody(body);
    this.bodies = this.world ? this.placements.map((placement) => this.create(placement)) : [];
    this.poses = new Float32Array(this.bodies.length * BOX_POSE_FLOATS);
    this.seenAsleep = new Uint8Array(this.bodies.length).fill(1);
    this.writePlacedPoses();
  }

  private create(placement: BoxPlacement): RigidBody {
    const R = this.R!;
    const world = this.world!;
    const body = world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(placement.x, placement.y, placement.z).setRotation(turned(placement)).setLinearDamping(CARDBOARD_DAMPING).setAngularDamping(CARDBOARD_DAMPING).setSleeping(true),
    );
    world.createCollider(
      R.ColliderDesc.cuboid(placement.width / 2, placement.height / 2, placement.depth / 2)
        .setDensity(cartonDensity(placement))
        .setFriction(CARDBOARD_FRICTION)
        .setFrictionCombineRule(R.CoefficientCombineRule.Max)
        .setRestitution(CARDBOARD_RESTITUTION)
        .setCollisionGroups(knockedGroups(-1)),
      body,
    );
    return body;
  }

  private writePlacedPoses(): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const placement = this.placements[i]!;
      const rotation = turned(placement);
      this.poses.set([placement.x, placement.y, placement.z, rotation.x, rotation.y, rotation.z, rotation.w], i * BOX_POSE_FLOATS);
    }
    this.seenAsleep.fill(1);
    this.awake = 0;
  }
}

/** A hollow carton's density (kg/m³): the board's mass over the box's volume, so the body weighs `CARDBOARD_KG_PER_SQUARE_METRE` per m² of its faces. */
function cartonDensity(placement: BoxPlacement): number {
  const { width, height, depth } = placement;
  const surface = 2 * (width * height + width * depth + height * depth);
  return (CARDBOARD_KG_PER_SQUARE_METRE * surface) / (width * height * depth);
}

function turned(placement: BoxPlacement): { x: number; y: number; z: number; w: number } {
  _q.setFromAxisAngle(Y, placement.yaw);
  _rot.x = _q.x;
  _rot.y = _q.y;
  _rot.z = _q.z;
  _rot.w = _q.w;
  return _rot;
}
