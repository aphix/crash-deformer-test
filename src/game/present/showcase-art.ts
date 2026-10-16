import * as THREE from "three";
import { driverLook, JEANS, type DriverLook } from "./driver-look.ts";
import { blankStance, guardDress, People, VIP_LOOK, walkStance, type Stance } from "./people.ts";

/**
 * The showcase's set: every kind of person the game draws, standing in rows (`ROWS`) on the sandbox's disc so the owner can
 * survey how each looks and moves. A row is data: how its figures stand and where; the next kind of thing (props, cars,
 * prefabs) gets a row of its own beside these.
 */

/** One figure: its dress (`cop`: a uniform, else a civilian `look`). */
type Figure = { name: string; cop: boolean; look: DriverLook };

const CIVILIAN: DriverLook = { woman: false, shirt: 0x3d5a80, pants: JEANS, hair: 0x5a3a22, hat: null, mustache: false };

/** The people the game draws: a driver, a woman driver, a driver who picked a cap and a moustache, a plain-clothes guard, the VIP and a uniformed guard (a cop). */
const FIGURES: readonly Figure[] = [
  { name: "man", cop: false, look: CIVILIAN },
  { name: "woman", cop: false, look: { ...driverLook(3, 4), woman: true, shirt: 0x7b4fa6, hair: 0xb5532a } },
  { name: "cap and moustache", cop: false, look: { ...CIVILIAN, shirt: 0xc0392b, hat: 0x1f3463, mustache: true } },
  { name: "guard", ...guardDress(1) },
  { name: "president", cop: false, look: VIP_LOOK },
  { name: "uniformed cop", ...guardDress(0) },
];

/** The stride a walking row is caught at (rad of a whole stride's 2π): an elbow and a knee bent on each side. */
const STRIDE_PHASE = 1.1;

/** The rows, front to back: where they stand (`z`, m) and how. */
const ROWS: readonly { name: string; z: number; pose: (out: Stance) => Stance }[] = [
  { name: "standing", z: 0, pose: blankStance },
  { name: "mid-stride", z: -2.5, pose: (out) => walkStance(STRIDE_PHASE, false, out) },
];

/** Metres between neighbours in a row. */
const SPACING = 1.5;
const SLOTS = ROWS.length * FIGURES.length;

/** The eye the scene opens on (m; it looks at `look`), the sandbox car's parking spot out of sight, and a knock (m/s up, and away from the eye along -z). */
export const SHOWCASE_EYE = { x: 0, y: 1.5, z: 8, lookX: 0, lookY: 1, lookZ: 0 };
export const SHOWCASE_CAR = { x: 60, z: 60 };
export const SHOWCASE_KNOCK = { up: 2.5, away: 5 };

export class ShowcaseArt {
  readonly group = new THREE.Group();
  readonly people = new People(SLOTS);
  readonly slots = SLOTS;

  constructor() {
    this.group.name = "showcase";
    this.group.visible = false;
    this.group.add(this.people.group);
    for (let slot = 0; slot < SLOTS; slot++) this.people.dress(slot, this.figureOf(slot).cop, this.figureOf(slot).look);
    this.stand();
  }

  /** Every figure back on his mark (a reset). */
  stand(): void {
    const at = new THREE.Vector3();
    const stance = blankStance();
    for (let slot = 0; slot < SLOTS; slot++) {
      this.markOf(slot, at);
      this.people.stand(slot, at.x, at.y, at.z, 0, ROWS[Math.floor(slot / FIGURES.length)]!.pose(stance), false);
    }
    this.people.update(0);
  }

  /** Slot `slot` taken off the set (knocked over: the ragdoll world has him now). */
  take(slot: number): void {
    this.people.hide(slot);
    this.people.update(0);
  }

  /** Where slot `slot` stands (world, feet) into `out`. */
  markOf(slot: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(((slot % FIGURES.length) - (FIGURES.length - 1) / 2) * SPACING, 0, ROWS[Math.floor(slot / FIGURES.length)]!.z);
  }

  figureOf(slot: number): Figure {
    return FIGURES[slot % FIGURES.length]!;
  }

  dispose(): void {
    this.people.dispose();
  }
}
