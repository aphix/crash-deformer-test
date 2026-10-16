import * as THREE from "three";
import { LANDING_HEIGHT, MINIGAME_MODE, MINIGAME_MODES, STATION_ANCHORS, STATION_HALF_WIDTH, type MinigameMode } from "../scenes/minigame-constants.ts";
import { groundMesh } from "../scenes/ground-stack.ts";
import { BOX_COUNT, type HighJumpLayout } from "../scenes/minigame-high-jump.ts";
import { stationFrontX } from "../scenes/minigame-profile.ts";
import { RING_BACKSTOP, RING_BOARD_BOUNDS } from "../scenes/minigame-ring.ts";
import { CardboardBoxes } from "./cardboard-art.ts";
import { makeHighJumpArt } from "./high-jump-art.ts";
import { makeLongJumpArt } from "./long-jump-art.ts";
import { makeStationSurface, STATION_SURFACE_STYLES } from "./minigame-surface-art.ts";
import type { BoxPlacement } from "./ragdoll-boxes.ts";
import { makeRingFlingArt } from "./ring-fling-art.ts";

/**
 * The three stations' art, composed: each station is one group at its `STATION_ANCHORS` (x, z) with y = 0, holding its own art's
 * factory output (station-local frame: +x the throw, x = 0 the lip) and a flat concrete landing floor, since the world's own
 * ground disc is hidden in minigame mode and the floors plus the surfaces are all the ground there is. The cardboard boxes draw in
 * world coordinates (the ragdoll's), so their mesh stays at the world origin beside the stations.
 */

/** The long jump's floor runs out to this x (m): past the farthest distance sign the range paints. */
export const LONG_JUMP_FLOOR_END_X = 120;
/** The High jump's floor runs this far (m) past the net, and Ring Fling's past the backstop. */
export const LANDING_FLOOR_PAST_END = 10;
/** A landing floor spans this far (m) beyond the station's half width either side of the lane's middle. */
export const LANDING_FLOOR_SIDE_MARGIN = 4;

const LANDING_FLOOR_COLOUR = 0x8d8f91;
const LANDING_FLOOR_ROUGHNESS = 0.95;

/** A flat concrete plane at `LANDING_HEIGHT` from station-local `startX` to `endX`, `STATION_HALF_WIDTH + LANDING_FLOOR_SIDE_MARGIN` either side. */
function landingFloor(mode: MinigameMode, endX: number): THREE.Mesh {
  const startX = stationFrontX(mode);
  const halfWidth = STATION_HALF_WIDTH + LANDING_FLOOR_SIDE_MARGIN;
  const geometry = new THREE.PlaneGeometry(endX - startX, 2 * halfWidth).rotateX(-Math.PI / 2).translate((startX + endX) / 2, LANDING_HEIGHT, 0);
  const material = new THREE.MeshStandardMaterial({ color: LANDING_FLOOR_COLOUR, roughness: LANDING_FLOOR_ROUGHNESS, metalness: 0 });
  const floor = groundMesh(geometry, material, "terrain");
  floor.name = `landing-floor:${mode}`;
  floor.receiveShadow = true;
  return floor;
}

function stationGroup(mode: MinigameMode, ...parts: THREE.Object3D[]): THREE.Group {
  const station = new THREE.Group();
  station.name = `station:${mode}`;
  station.position.set(STATION_ANCHORS[mode].x, 0, STATION_ANCHORS[mode].z);
  station.visible = false;
  station.add(...parts);
  return station;
}

/** Free the geometry of every mesh under `root`, and its materials with their textures. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

export class MinigameArt {
  /** Invisible and in no scene until the engine adds it; `setMode` shows it. */
  readonly group = new THREE.Group();
  private readonly stations = {
    longJump: stationGroup(MINIGAME_MODE.longJump, makeLongJumpArt(), landingFloor(MINIGAME_MODE.longJump, LONG_JUMP_FLOOR_END_X)),
    highJump: stationGroup(MINIGAME_MODE.highJump, makeStationSurface(MINIGAME_MODE.highJump, STATION_SURFACE_STYLES.highJump)),
    ringFling: stationGroup(
      MINIGAME_MODE.ringFling,
      makeRingFlingArt(),
      landingFloor(MINIGAME_MODE.ringFling, RING_BOARD_BOUNDS.maxX + RING_BACKSTOP.distancePastBoard + RING_BACKSTOP.thickness + LANDING_FLOOR_PAST_END),
    ),
  } as const satisfies Record<MinigameMode, THREE.Group>;
  private readonly boxes = new CardboardBoxes(BOX_COUNT);
  /** The High jump's layout-dependent art and landing floor: replaced whole by every `setHighJumpLayout`. */
  private highJumpLayoutParts: THREE.Group | null = null;

  constructor() {
    this.group.name = "minigame-art";
    this.group.visible = false;
    this.boxes.mesh.visible = false;
    this.group.add(...MINIGAME_MODES.map((mode) => this.stations[mode]), this.boxes.mesh);
  }

  /** Show exactly `mode`'s station (and the boxes, for the High jump); null hides everything. */
  setMode(mode: MinigameMode | null): void {
    this.group.visible = mode !== null;
    for (const stationMode of MINIGAME_MODES) this.stations[stationMode].visible = stationMode === mode;
    this.boxes.mesh.visible = mode === MINIGAME_MODE.highJump;
  }

  /**
   * Build the High jump's art from `layout` (station-local, lip at height `lipY`), replacing any earlier build, and give the
   * cardboard boxes' world placements (the layout's plus the station's anchor) for the ragdoll's `setBoxes`; the drawn boxes take them too.
   */
  setHighJumpLayout(layout: HighJumpLayout, lipY: number): readonly BoxPlacement[] {
    if (this.highJumpLayoutParts) {
      this.highJumpLayoutParts.removeFromParent();
      disposeTree(this.highJumpLayoutParts);
    }
    this.highJumpLayoutParts = new THREE.Group();
    this.highJumpLayoutParts.name = "high-jump-layout";
    this.highJumpLayoutParts.add(makeHighJumpArt(layout, lipY), landingFloor(MINIGAME_MODE.highJump, layout.netX + LANDING_FLOOR_PAST_END));
    this.stations.highJump.add(this.highJumpLayoutParts);
    const anchor = STATION_ANCHORS.highJump;
    const placements = layout.boxes.map((box) => ({ ...box, x: box.x + anchor.x, z: box.z + anchor.z }));
    this.boxes.setLayout(placements);
    return placements;
  }

  /** Pose the boxes from `RagdollSystem.copyBoxPoses`' output (world coordinates). */
  updateBoxes(poses: Float32Array, count: number): void {
    this.boxes.update(poses, count);
  }

  dispose(): void {
    for (const mode of MINIGAME_MODES) disposeTree(this.stations[mode]);
    this.boxes.dispose();
  }
}
