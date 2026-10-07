import * as THREE from "three";
import { applyMarkMap } from "./engine-marks.ts";
import type { WorldStage } from "./engine-world.ts";
import { SURFACE_IDS, type PrefabId, type SurfaceId } from "../world/catalog.ts";
import type { Placed } from "../world/placements.ts";
import { box, makePrefabMaterials, makeRaceTextures, painted, prefabParts, type Piece, type RaceTextures } from "./prefabs.ts";
import { blankPoint, type Track } from "../world/track.ts";
import {
  BLACK, DEPTH_INSTANCED, DEPTH_INSTANCED_COLOR, type DrawKind, GANTRY_BEAM, hash01, LIGHT_OFF, LIGHT_ON,
  LIGHT_RGB, Mesher, RED, RoadIndex, sections, texClass,
} from "./track-mesh.ts";
import { buildGroundLayers, TerrainBatch } from "./track-ground.ts";
import { depthProxy, groundMaterial, groundMesh, levelOrder } from "../scenes/ground-stack.ts";
import { addDecks, addTunnels, addWalls, pillarPieces } from "./track-structures.ts";
import { PropTumble } from "./prop-tumble.ts";

/**
 * The visible course: terrain (with a far skirt), road / runoff ribbons for the loop, shortcuts and
 * traffic routes, markings and kerbs, walls, bridge decks with pillars, tunnels, the start gantry and
 * every placed prop, in a few dozen draw calls. Heights come from `track.ground()` with the path's
 * own level as the layer hint, so a road under a bridge and the deck above it both sit right.
 */

type RaceMeshKind = "road" | "runoff" | "terrain" | "wall" | "marking" | "kerb" | "deck" | "pillar" | "tunnel" | "prop";
/** Weathered pastel stucco (pink, mint, ochre, sky, cream, terracotta, lilac): the Havana blocks and walls. */
const PASTELS = [0xf3c6c0, 0xbfe0d0, 0xf2d9a0, 0xb8d4ea, 0xf0e2cb, 0xe8b9a0, 0xd9c8e6];

type RaceMeshTag = { kind: RaceMeshKind; surface?: SurfaceId; prefab?: PrefabId };

export class TrackArt {
  readonly group = new THREE.Group();
  private readonly textures: RaceTextures;
  private readonly lamps: THREE.InstancedMesh;
  private readonly lampColour: number[] = [];
  private lights = -1;
  /** Scene-owned materials (lamp heads, light pools) that dispose() leaves alone. */
  private readonly shared: THREE.Material[] = [];
  /** `forDraw`: per source material, the material each draw kind uses (copies are disposed with the art). */
  private readonly byKind = new Map<THREE.Material, Partial<Record<DrawKind, THREE.Material>>>();
  /** The knockable props as a car sends them flying (`knock`, `update`, `reset`). */
  readonly props: PropTumble;
  private readonly m4 = new THREE.Matrix4();
  private readonly col = new THREE.Color();
  private readonly stage: Pick<WorldStage, "look">;

  /** `stage` takes the course's own daylight while the art stands (its sun, hemisphere and fill; none: the default). */
  constructor(track: Track, placed: readonly Placed[], stage: Pick<WorldStage, "look">) {
    this.group.name = "track-art";
    this.stage = stage;
    stage.look(track.json.environment.light ?? null);
    const ground = track.ground();
    const tex = makeRaceTextures();
    this.textures = tex;
    const mats = makePrefabMaterials(tex);
    const paths = track.paths();
    const index = new RoadIndex(paths);
    const secs = paths.map((p) => sections(p, 0));
    // Ground materials (one per mesh) also darken under the tyre-mark map.
    const textured = (sid: number) => {
      const t = texClass(sid);
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: t === "asphalt" ? tex.asphalt : t === "concrete" ? tex.concrete : tex.detail,
        color: t === "asphalt" ? tex.asphaltGain : t === "concrete" ? tex.concreteGain : tex.detailGain,
        roughness: t === "asphalt" ? 0.9 : 0.95,
        metalness: 0.02,
      });
      applyMarkMap(mat);
      return mat;
    };

    // Every ground mesh is drawn in its level's place in the one stack (`ground-stack.ts`).
    const sharedMarkMat = new Map<string, THREE.MeshStandardMaterial>();
    const layers = buildGroundLayers(track, ground, index, paths, secs);
    for (const layer of layers) {
      if (layer.surface == null) {
        // Markings and kerbs: vertex colour only, one material per level.
        let mat = sharedMarkMat.get(layer.level);
        if (!mat) {
          mat = groundMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0 }), layer.level);
          sharedMarkMat.set(layer.level, mat);
        }
        if (!layer.m.empty) this.add(groundMesh(layer.m.geometry(layer.smooth), mat, layer.level), { kind: layer.kind }, false);
        continue;
      }
      const mat = textured(SURFACE_IDS.indexOf(layer.surface));
      const mesh = layer.chunks ? new TerrainBatch(layer.m, layer.chunks, groundMaterial(mat, layer.level)) : groundMesh(layer.m.geometry(layer.smooth), mat, layer.level);
      // The chunked terrain is a batch, not a plain mesh: its place in the stack is set here.
      mesh.renderOrder = levelOrder(layer.level);
      this.add(mesh, { kind: layer.kind, surface: layer.surface }, false);
    }
    // The painted ribbons write no depth: their depth copy hides what a crest of road or run-off stands in front of.
    this.group.add(depthProxy(layers));

    const walls = new Mesher();
    const decks = new Mesher();
    const tunnels = new Mesher();
    const tunnelLights = new Mesher();
    const pillars: Piece[] = [];
    for (const [i, p] of paths.entries()) {
      if (p.wallL.includes(1) || p.wallR.includes(1)) addWalls(walls, p, ground, track.json.road.wallHeight);
      if (p.deck.includes(1)) {
        addDecks(decks, p, secs[i]!);
        pillars.push(...pillarPieces(p, secs[i]!, ground, index));
      }
      if (p.tunnel.includes(1)) addTunnels(tunnels, tunnelLights, p, secs[i]!, ground);
    }
    if (!walls.empty) this.add(new THREE.Mesh(walls.geometry(false), mats.concrete), { kind: "wall" }, true);
    if (!decks.empty) this.add(new THREE.Mesh(decks.geometry(false), mats.concrete), { kind: "deck" }, true);
    if (pillars.length > 0) this.add(new THREE.Mesh(painted(pillars), mats.concrete), { kind: "pillar" }, true);
    if (!tunnels.empty) this.add(new THREE.Mesh(tunnels.geometry(false), mats.concrete), { kind: "tunnel" }, true);
    if (!tunnelLights.empty) {
      const glow = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
      this.add(new THREE.Mesh(tunnelLights.geometry(false), glow), { kind: "tunnel" }, false);
    }

    // Start gantry, built in the line's frame: x = lateral (+ left), y up from the road, z forward.
    const pt = track.pointAt(0, blankPoint());
    const p = track.path;
    const roadY = ground.heightAt(pt.x, pt.z, pt.y);
    const frame = new THREE.Matrix4().makeRotationY(Math.atan2(pt.tx, pt.tz)).setPosition(pt.x, roadY, pt.z);
    const latL = pt.half + p.runL[0]! + 1.2;
    const latR = -(pt.half + p.runR[0]! + 1.2);
    const pieces: Piece[] = [];
    const pylon = prefabParts("gantry", mats)[0]!.geometry;
    for (const lat of [latL, latR]) {
      const foot = ground.heightAt(pt.x + pt.tz * lat, pt.z - pt.tx * lat, pt.y) - roadY;
      pieces.push([pylon.clone().scale(1, (GANTRY_BEAM - 0.4 - foot) / 6, 1).translate(lat, foot, 0), 0xc8cbd0]);
    }
    pylon.dispose();
    pieces.push([box(latL - latR + 1, 0.8, 0.9, (latL + latR) / 2, GANTRY_BEAM, 0), 0x2a2c32]);
    pieces.push([box(latL - latR + 1, 0.12, 0.92, (latL + latR) / 2, GANTRY_BEAM + 0.46, 0), RED]);
    const panelX = [pt.half * 0.45, -pt.half * 0.45];
    for (const x of panelX) pieces.push([box(3.3, 1.3, 0.3, x, GANTRY_BEAM - 1.05, 0), BLACK]);
    this.add(new THREE.Mesh(painted(pieces).applyMatrix4(frame), mats.plain), { kind: "prop", prefab: "gantry" }, true);

    const disc = new THREE.CircleGeometry(0.42, 20).rotateY(Math.PI);
    this.lamps = new THREE.InstancedMesh(disc, new THREE.MeshBasicMaterial({ toneMapped: false }), panelX.length * 3);
    let i = 0;
    for (const x of panelX) {
      for (let c = 0; c < 3; c++) {
        // Seen from the grid (looking +z), local +x is on the left: red left, green right.
        this.m4.makeTranslation(x + 1.05 - c * 1.05, GANTRY_BEAM - 1.05, -0.17).premultiply(frame);
        this.lamps.setMatrixAt(i, this.m4);
        this.lampColour.push(c);
        i++;
      }
    }
    this.add(this.lamps, { kind: "prop", prefab: "gantry" }, false);
    this.setLights(0);

    // Props: one InstancedMesh per prefab part (the course's lamp heads and pools are the scene's materials).
    this.props = new PropTumble(
      placed,
      ground,
      mats,
      (mesh, id, shared) => {
        if (shared) this.shared.push(shared);
        // Lamp heads and light pools neither cast shadows nor need to.
        this.add(mesh, { kind: "prop", prefab: id }, !shared);
      },
      (id, i, out) => this.tint(id, i, out),
    );
  }

  /** Start gantry: 0 off, 1 red, 2 yellow, 3 green. Cheap to call every frame (no-op when unchanged). */
  setLights(l: 0 | 1 | 2 | 3): void {
    if (l === this.lights) return;
    this.lights = l;
    for (let i = 0; i < this.lampColour.length; i++) {
      const c = this.lampColour[i]!;
      const k = c === l - 1 ? LIGHT_ON : LIGHT_OFF;
      const rgb = LIGHT_RGB[c]!;
      this.lamps.setColorAt(i, this.col.setRGB(rgb[0] * k, rgb[1] * k, rgb[2] * k, THREE.LinearSRGBColorSpace));
    }
    this.lamps.instanceColor!.needsUpdate = true;
  }

  dispose(): void {
    this.stage.look(null);
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      geos.add(o.geometry as THREE.BufferGeometry);
      mats.add(o.material as THREE.Material);
      if (o instanceof THREE.InstancedMesh || o instanceof THREE.BatchedMesh) o.dispose();
    });
    for (const g of geos) g.dispose();
    for (const m of mats) if (!this.shared.includes(m)) m.dispose();
    const t = this.textures;
    for (const x of [t.asphalt, t.concrete, t.detail, t.windows, t.billboard]) x.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }

  /** Add a tagged mesh: everything receives shadows; `cast` for solid things above the ground. */
  private add(mesh: THREE.Mesh, tag: RaceMeshTag, cast: boolean): void {
    mesh.name = tag.prefab ? `${tag.kind}:${tag.prefab}` : tag.surface ? `${tag.kind}:${tag.surface}` : tag.kind;
    mesh.userData.race = tag;
    mesh.receiveShadow = true;
    mesh.castShadow = cast;
    if (!Array.isArray(mesh.material)) mesh.material = this.forDraw(mesh.material, mesh);
    if (cast && mesh instanceof THREE.InstancedMesh) mesh.customDepthMaterial = mesh.instanceColor ? DEPTH_INSTANCED_COLOR : DEPTH_INSTANCED;
    this.group.add(mesh);
  }

  /**
   * One material per draw kind (plain, instanced, instanced with colours), and the same for the shadow depth
   * material (above): when one material draws more than one kind, three reselects its program (`getProgram`,
   * an allocation) at every switch, 4–5 times a frame on a course. A copy links no new program.
   */
  private forDraw(m: THREE.Material, mesh: THREE.Mesh): THREE.Material {
    const kind: DrawKind = mesh instanceof THREE.InstancedMesh ? (mesh.instanceColor ? "instancedColour" : "instanced") : "plain";
    let copies = this.byKind.get(m);
    if (!copies) {
      copies = { [kind]: m };
      this.byKind.set(m, copies);
    }
    return (copies[kind] ??= m.clone());
  }

  /** Per-instance tint for natural / building variety (deterministic by placement index); false = none. */
  private tint(id: PrefabId, i: number, out: THREE.Color): boolean {
    const h = hash01(i, 11);
    const h2 = hash01(i, 12);
    if (id === "tree" || id === "palm") {
      const k = 0.8 + 0.35 * h;
      out.setRGB(k * (1 + 0.24 * (h2 - 0.5)), k, k * (1 - 0.2 * (h2 - 0.5)), THREE.LinearSRGBColorSpace);
      return true;
    }
    if (id === "rock") {
      const k = 0.8 + 0.3 * h;
      out.setRGB(k, k, k, THREE.LinearSRGBColorSpace);
      return true;
    }
    if (id === "building") {
      out.setHex([0xffffff, 0xf2e3c6, 0xd5dde8, 0xeccbb6, 0xdcd8c4][Math.floor(h * 5)]!);
      return true;
    }
    if (id === "stucco" || id === "wall") {
      out.setHex(PASTELS[Math.floor(h * PASTELS.length)]!);
      return true;
    }
    return false;
  }
}
