import * as THREE from "three";
import type { RigidBody, World } from "@dimforge/rapier3d-simd";
import type { Rapier } from "../kernel/rapier.ts";
import { readPose } from "./ragdoll-body.ts";
import { knockedGroups } from "./ragdoll-config.ts";

/** One cardboard box in world coordinates: its centre, its turn about the vertical (rad), and its full size (m). */
export type BoxPlacement = { x: number; y: number; z: number; yaw: number; width: number; height: number; depth: number };

/** Floats per box in `BoxPile.copyPoses`: position xyz, then rotation xyzw. */
export const BOX_POSE_FLOATS = 7;
/**
 * A carton's mass per volume (kg/m³): single-wall board is about 0.55 kg per m² of face, so an empty 0.9 m cube (4.86 m² of
 * board) is 2.7 kg, 3.7 kg/m³; the stunt-crew boxes the dummy lands among are stuffed with crumpled paper to about 11 kg, 15 kg/m³.
 */
const CARDBOARD_DENSITY = 15;
/** Cardboard's grip; its Max rule holds it against the dummy's own Min-rule 0.12 (`SLIDE`), without which 15-25 m/s landings skated 4-8 m past the pile (measured). */
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
    const body = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(placement.x, placement.y, placement.z).setRotation(turned(placement)).setSleeping(true));
    world.createCollider(
      R.ColliderDesc.cuboid(placement.width / 2, placement.height / 2, placement.depth / 2)
        .setDensity(CARDBOARD_DENSITY)
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

function turned(placement: BoxPlacement): { x: number; y: number; z: number; w: number } {
  _q.setFromAxisAngle(Y, placement.yaw);
  _rot.x = _q.x;
  _rot.y = _q.y;
  _rot.z = _q.z;
  _rot.w = _q.w;
  return _rot;
}
