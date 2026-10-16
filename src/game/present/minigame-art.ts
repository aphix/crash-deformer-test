import * as THREE from "three";
import { MINIGAME_MODE, MINIGAME_MODES, STATION_ANCHORS, type MinigameMode } from "../scenes/minigame-constants.ts";
import { BOX_COUNT, type HighJumpLayout } from "../scenes/minigame-high-jump.ts";
import { RING_BACKSTOP, RING_BOARD_BOUNDS } from "../scenes/minigame-ring.ts";
import { RANGE } from "../scenes/range.ts";
import { CardboardBoxes } from "./cardboard-art.ts";
import { makeHighJumpArt } from "./high-jump-art.ts";
import { makeLongJumpArt } from "./long-jump-art.ts";
import { flatGroundTiles, makeFlatGround, makeStationSurface, STATION_SURFACE_STYLES, stationBandBounds, type GroundRectangle } from "./minigame-surface-art.ts";
import type { BoxPlacement } from "./ragdoll-boxes.ts";
import { makeRingFlingArt } from "./ring-fling-art.ts";

/**
 * The three stations' art, composed: each station is one group at its `STATION_ANCHORS` (x, z) with y = 0, holding its own art's
 * factory output (station-local frame: +x the throw, x = 0 the lip). The world's own ground disc is hidden in minigame mode, so the
 * ground is the stations' band surfaces plus one flat ground at the pad's level around them (rectangular holes where the bands lie,
 * which a plug fills while that station is not shown). The cardboard boxes draw in world coordinates (the ragdoll's), so their mesh
 * stays at the world origin beside the stations.
 */

/** The flat ground reaches this far (m) past the stations' bands and far ends: along x, and across z. */
export const GROUND_MARGIN = { x: 40, z: 60 } as const;

/** Names of the flat ground's meshes: the ground around the bands, and a plug's prefix (the mode follows). */
export const OUTER_GROUND_NAME = "minigame-outer-ground";
export const STATION_PLUG_PREFIX = "station-plug:";

/** The station's band as a world rectangle. */
function bandInWorld(mode: MinigameMode): GroundRectangle {
  const band = stationBandBounds(mode);
  const anchor = STATION_ANCHORS[mode];
  return { minX: anchor.x + band.minX, maxX: anchor.x + band.maxX, minZ: anchor.z + band.minZ, maxZ: anchor.z + band.maxZ };
}

/** World x (m) of the farthest thing any station has: the range's sand field, the High jump's net at station-local `netX`, the Ring Fling backstop's back. */
function farthestEndX(netX: number): number {
  const ringFlingEnd = RING_BOARD_BOUNDS.maxX + RING_BACKSTOP.distancePastBoard + RING_BACKSTOP.thickness;
  return Math.max(STATION_ANCHORS.longJump.x + RANGE.length, STATION_ANCHORS.highJump.x + netX, STATION_ANCHORS.ringFling.x + ringFlingEnd);
}

/** The world rectangle the flat ground covers: every band and the farthest end, `GROUND_MARGIN` beyond. */
function minigameGroundExtent(farthestX: number): GroundRectangle {
  const bands = MINIGAME_MODES.map(bandInWorld);
  return {
    minX: Math.min(...bands.map((band) => band.minX)) - GROUND_MARGIN.x,
    maxX: farthestX + GROUND_MARGIN.x,
    minZ: Math.min(...bands.map((band) => band.minZ)) - GROUND_MARGIN.z,
    maxZ: Math.max(...bands.map((band) => band.maxZ)) + GROUND_MARGIN.z,
  };
}

/** Flat ground over the station's band: what lies there while the station's surface is hidden. */
function stationPlug(mode: MinigameMode): THREE.Mesh {
  return makeFlatGround(`${STATION_PLUG_PREFIX}${mode}`, [bandInWorld(mode)]);
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
    longJump: stationGroup(MINIGAME_MODE.longJump, makeLongJumpArt()),
    highJump: stationGroup(MINIGAME_MODE.highJump, makeStationSurface(MINIGAME_MODE.highJump, STATION_SURFACE_STYLES.highJump)),
    ringFling: stationGroup(MINIGAME_MODE.ringFling, makeRingFlingArt()),
  } as const satisfies Record<MinigameMode, THREE.Group>;
  private readonly boxes = new CardboardBoxes(BOX_COUNT);
  /** The flat ground in world coordinates: a plug over each band while its station is not shown, and the ground around the bands (built with the High jump's layout). */
  private readonly ground = new THREE.Group();
  private readonly plugs = {
    longJump: stationPlug(MINIGAME_MODE.longJump),
    highJump: stationPlug(MINIGAME_MODE.highJump),
    ringFling: stationPlug(MINIGAME_MODE.ringFling),
  } as const satisfies Record<MinigameMode, THREE.Mesh>;
  private outerGround: THREE.Mesh | null = null;
  /** The High jump's layout-dependent art: replaced whole by every `setHighJumpLayout`. */
  private highJumpLayoutParts: THREE.Group | null = null;

  constructor() {
    this.group.name = "minigame-art";
    this.group.visible = false;
    this.boxes.mesh.visible = false;
    this.ground.name = "minigame-ground";
    this.ground.add(...MINIGAME_MODES.map((mode) => this.plugs[mode]));
    this.group.add(this.ground, ...MINIGAME_MODES.map((mode) => this.stations[mode]), this.boxes.mesh);
  }

  /** Show exactly `mode`'s station (and the boxes, for the High jump), the flat ground over every other station's band; null hides everything. */
  setMode(mode: MinigameMode | null): void {
    this.group.visible = mode !== null;
    for (const stationMode of MINIGAME_MODES) {
      this.stations[stationMode].visible = stationMode === mode;
      this.plugs[stationMode].visible = stationMode !== mode;
    }
    this.boxes.mesh.visible = mode === MINIGAME_MODE.highJump;
  }

  /**
   * Build the High jump's art from `layout` (station-local, lip at height `lipY`) and the flat ground around the bands (it reaches
   * past the net), replacing any earlier build, and give the cardboard boxes' world placements (the layout's plus the station's
   * anchor) for the ragdoll's `setBoxes`; the drawn boxes take them too.
   */
  setHighJumpLayout(layout: HighJumpLayout, lipY: number): readonly BoxPlacement[] {
    if (this.highJumpLayoutParts) {
      this.highJumpLayoutParts.removeFromParent();
      disposeTree(this.highJumpLayoutParts);
    }
    this.highJumpLayoutParts = new THREE.Group();
    this.highJumpLayoutParts.name = "high-jump-layout";
    this.highJumpLayoutParts.add(makeHighJumpArt(layout, lipY));
    this.stations.highJump.add(this.highJumpLayoutParts);
    if (this.outerGround) {
      this.outerGround.removeFromParent();
      disposeTree(this.outerGround);
    }
    this.outerGround = makeFlatGround(OUTER_GROUND_NAME, flatGroundTiles(minigameGroundExtent(farthestEndX(layout.netX)), MINIGAME_MODES.map(bandInWorld)));
    this.ground.add(this.outerGround);
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
    disposeTree(this.ground);
    this.boxes.dispose();
  }
}
