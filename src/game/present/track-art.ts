import * as THREE from "three";
import { applyMarkMap } from "./engine-marks.ts";
import type { WorldStage } from "./engine-world.ts";
import { PREFABS, SURFACE_IDS, type PrefabId, type SurfaceId } from "../world/catalog.ts";
import type { Placed } from "../world/placements.ts";
import { box, makePrefabMaterials, makeRaceTextures, painted, prefabParts, type Piece, type RaceTextures } from "./prefabs.ts";
import { blankPoint, type Track, type TrackGround } from "../world/track.ts";
import {
  BLACK, DEPTH_INSTANCED, DEPTH_INSTANCED_COLOR, type DrawKind, GANTRY_BEAM, GRAVITY, hash01, LIGHT_OFF, LIGHT_ON,
  LIGHT_RGB, Mesher, RED, RoadIndex, sections, texClass,
} from "./track-mesh.ts";
import { buildGroundLayers } from "./track-ground.ts";
import { levelOffset } from "../world/ground-stack.ts";
import { addDecks, addTunnels, addWalls, pillarPieces } from "./track-structures.ts";

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


/** Knock state: in place, flying / tumbling, knocked and at rest. */
const AT_REST = 0;
const FLYING = 1;
const DOWN = 2;

export class TrackArt {
  readonly group = new THREE.Group();
  private readonly placed: readonly Placed[];
  private readonly ground: TrackGround;
  private readonly textures: RaceTextures;
  private readonly lamps: THREE.InstancedMesh;
  private readonly lampColour: number[] = [];
  private lights = -1;
  /** Per placement: instance slot in its prefab's meshes. */
  private readonly slot: Int32Array;
  private readonly meshes: Partial<Record<PrefabId, THREE.InstancedMesh[]>> = {};
  /** Scene-owned materials (lamp heads, light pools) that dispose() leaves alone. */
  private readonly shared: THREE.Material[] = [];
  /** `forDraw`: per source material, the material each draw kind uses (copies are disposed with the art). */
  private readonly byKind = new Map<THREE.Material, Partial<Record<DrawKind, THREE.Material>>>();
  private readonly state: Uint8Array;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly spin: Float32Array;
  private readonly rot: Float32Array;
  /** Indices of flying props: [0, flyingCount). */
  private readonly flying: Int32Array;
  private flyingCount = 0;
  private readonly m4 = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly dq = new THREE.Quaternion();
  private readonly v = new THREE.Vector3();
  private readonly sc = new THREE.Vector3();
  private readonly axis = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly identity = new THREE.Quaternion();
  private readonly col = new THREE.Color();
  private readonly stage: Pick<WorldStage, "look">;

  /** `stage` takes the course's own daylight while the art stands (its sun, hemisphere and fill; none: the default). */
  constructor(track: Track, placed: readonly Placed[], stage: Pick<WorldStage, "look">) {
    this.group.name = "track-art";
    this.stage = stage;
    stage.look(track.json.environment.light ?? null);
    this.placed = placed;
    this.ground = track.ground();
    const ground = this.ground;
    const tex = makeRaceTextures();
    this.textures = tex;
    const mats = makePrefabMaterials(tex);
    const paths = track.paths();
    const index = new RoadIndex(paths);
    const secs = paths.map((p) => sections(p, 0));
    // Ground materials (one per mesh) also darken under the tyre-mark map.
    const textured = (sid: number, extra: THREE.MeshStandardMaterialParameters = {}) => {
      const t = texClass(sid);
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: t === "asphalt" ? tex.asphalt : t === "concrete" ? tex.concrete : tex.detail,
        color: t === "asphalt" ? tex.asphaltGain : t === "concrete" ? tex.concreteGain : tex.detailGain,
        roughness: t === "asphalt" ? 0.9 : 0.95,
        metalness: 0.02,
        ...extra,
      });
      applyMarkMap(mat);
      return mat;
    };

    // Every ground mesh takes its depth offset from its level in the one stack (`ground-stack.ts`).
    const sharedMarkMat = new Map<string, THREE.MeshStandardMaterial>();
    for (const layer of buildGroundLayers(track, ground, index, paths, secs)) {
      const offset = levelOffset(layer.level);
      if (layer.surface == null) {
        // Markings and kerbs: vertex colour only, one material per level.
        let mat = sharedMarkMat.get(layer.level);
        if (!mat) {
          mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0, ...offset });
          sharedMarkMat.set(layer.level, mat);
        }
        if (!layer.m.empty) this.add(new THREE.Mesh(layer.m.geometry(layer.smooth), mat), { kind: layer.kind }, false);
        continue;
      }
      this.add(new THREE.Mesh(layer.m.geometry(layer.smooth), textured(SURFACE_IDS.indexOf(layer.surface), offset)), { kind: layer.kind, surface: layer.surface }, false);
    }

    const walls = new Mesher();
    const decks = new Mesher();
    const tunnels = new Mesher();
    const tunnelLights = new Mesher();
    const pillars: Piece[] = [];
    paths.forEach((p, i) => {
      if (p.wallL.includes(1) || p.wallR.includes(1)) addWalls(walls, p, ground, track.json.road.wallHeight);
      if (p.deck.includes(1)) {
        addDecks(decks, p, secs[i]!);
        pillars.push(...pillarPieces(p, secs[i]!, ground, index));
      }
      if (p.tunnel.includes(1)) addTunnels(tunnels, tunnelLights, p, secs[i]!, ground);
    });
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

    // Props: one InstancedMesh per prefab part.
    const byPrefab: Partial<Record<PrefabId, number[]>> = {};
    placed.forEach((pl, idx) => (byPrefab[pl.prefab] ??= []).push(idx));
    this.slot = new Int32Array(placed.length);
    for (const id of Object.keys(byPrefab) as PrefabId[]) {
      const list = byPrefab[id]!;
      const meshes = prefabParts(id, mats).map((part, pi) => {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        if (part.shared) this.shared.push(part.material);
        // Knocked props leave the instances' original bounds.
        mesh.frustumCulled = PREFABS[id].body !== "knock";
        list.forEach((idx, s) => {
          this.slot[idx] = s;
          this.restMatrix(idx);
          mesh.setMatrixAt(s, this.m4);
          if (pi === 0 && this.tint(id, idx, this.col)) mesh.setColorAt(s, this.col);
        });
        mesh.computeBoundingSphere();
        // Lamp heads and light pools neither cast shadows nor need to.
        this.add(mesh, { kind: "prop", prefab: id }, !part.shared);
        return mesh;
      });
      this.meshes[id] = meshes;
    }
    this.state = new Uint8Array(placed.length);
    this.pos = new Float32Array(placed.length * 3);
    this.vel = new Float32Array(placed.length * 3);
    this.spin = new Float32Array(placed.length * 3);
    this.rot = new Float32Array(placed.length * 4);
    this.flying = new Int32Array(placed.length);
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

  /** Send knockable prop `index` (into `placed`) flying with velocity (vx, vy, vz) m/s; it tumbles and comes to rest on the ground. */
  knock(index: number, vx: number, vy: number, vz: number): void {
    const p = this.placed[index]!;
    if (PREFABS[p.prefab].body !== "knock") return;
    const size = PREFABS[p.prefab].size;
    const i3 = index * 3;
    if (this.state[index] === AT_REST) {
      const hy = size[1] * p.sy * 0.5;
      this.pos[i3] = p.x;
      this.pos[i3 + 1] = p.y + hy;
      this.pos[i3 + 2] = p.z;
      this.q.setFromAxisAngle(this.up, p.yaw).toArray(this.rot, index * 4);
    }
    if (this.state[index] !== FLYING) this.flying[this.flyingCount++] = index;
    this.state[index] = FLYING;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    // Roll about the horizontal axis across the motion, plus a deterministic twist.
    const r = Math.max(0.3, size[1] * p.sy * 0.5);
    const twist = (Math.imul(index + 1, 2654435761) >>> 0) / 4294967296 - 0.5;
    this.spin[i3] = (vz / r) * 0.6;
    this.spin[i3 + 1] = twist * 6;
    this.spin[i3 + 2] = (-vx / r) * 0.6;
  }

  /** Animate knocked props (no allocation). */
  update(dt: number): void {
    if (this.flyingCount === 0 || dt <= 0) return;
    const { pos, vel, spin, rot, q, dq, m4 } = this;
    for (let f = 0; f < this.flyingCount; f++) {
      const i = this.flying[f]!;
      const p = this.placed[i]!;
      const size = PREFABS[p.prefab].size;
      const hx = size[0] * p.sx * 0.5;
      const hy = size[1] * p.sy * 0.5;
      const hz = size[2] * p.sz * 0.5;
      const i3 = i * 3;
      vel[i3 + 1]! -= GRAVITY * dt;
      pos[i3]! += vel[i3]! * dt;
      pos[i3 + 1]! += vel[i3 + 1]! * dt;
      pos[i3 + 2]! += vel[i3 + 2]! * dt;
      q.fromArray(rot, i * 4);
      const w = Math.hypot(spin[i3]!, spin[i3 + 1]!, spin[i3 + 2]!);
      if (w > 1e-6) {
        this.axis.set(spin[i3]! / w, spin[i3 + 1]! / w, spin[i3 + 2]! / w);
        q.premultiply(dq.setFromAxisAngle(this.axis, w * dt));
      }
      m4.makeRotationFromQuaternion(q);
      const e = m4.elements;
      // Lowest point of the oriented box below its centre.
      const reach = Math.abs(e[1]!) * hx + Math.abs(e[5]!) * hy + Math.abs(e[9]!) * hz;
      // The surface at or just above the prop's own level: a bridge deck only when it is on it.
      const floor = this.ground.heightAt(pos[i3]!, pos[i3 + 2]!, pos[i3 + 1]! - reach);
      if (pos[i3 + 1]! - reach <= floor) {
        pos[i3 + 1] = floor + reach;
        if (vel[i3 + 1]! < 0) vel[i3 + 1] = vel[i3 + 1]! < -1.5 ? -vel[i3 + 1]! * 0.3 : 0;
        const slide = Math.max(0, 1 - 3 * dt);
        vel[i3]! *= slide;
        vel[i3 + 2]! *= slide;
        const roll = Math.max(0, 1 - 4 * dt);
        spin[i3]! *= roll;
        spin[i3 + 1]! *= roll;
        spin[i3 + 2]! *= roll;
        // Settle onto the box face nearest to down.
        let best = 0;
        for (let a = 1; a < 3; a++) if (Math.abs(e[a * 4 + 1]!) > Math.abs(e[best * 4 + 1]!)) best = a;
        const sign = e[best * 4 + 1]! < 0 ? -1 : 1;
        this.axis.set(e[best * 4]! * sign, e[best * 4 + 1]! * sign, e[best * 4 + 2]! * sign);
        dq.setFromUnitVectors(this.axis, this.up);
        q.premultiply(dq.slerp(this.identity, 1 - Math.min(1, 5 * dt)));
        const v2 = vel[i3]! ** 2 + vel[i3 + 1]! ** 2 + vel[i3 + 2]! ** 2;
        if (v2 < 0.04 && w < 0.3) {
          this.state[i] = DOWN;
          this.flying[f] = this.flying[--this.flyingCount]!;
          f--;
        }
      }
      q.toArray(rot, i * 4);
      m4.makeRotationFromQuaternion(q);
      this.v.set(pos[i3]! - e[4]! * hy, pos[i3 + 1]! - e[5]! * hy, pos[i3 + 2]! - e[6]! * hy);
      m4.compose(this.v, q, this.sc.set(p.sx, p.sy, p.sz));
      const meshes = this.meshes[p.prefab]!;
      for (let k = 0; k < meshes.length; k++) {
        meshes[k]!.setMatrixAt(this.slot[i]!, m4);
        meshes[k]!.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Every knocked prop back in place (race restart). */
  reset(): void {
    for (let i = 0; i < this.placed.length; i++) {
      if (this.state[i] === AT_REST) continue;
      this.state[i] = AT_REST;
      this.restMatrix(i);
      for (const mesh of this.meshes[this.placed[i]!.prefab]!) {
        mesh.setMatrixAt(this.slot[i]!, this.m4);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.flyingCount = 0;
  }

  dispose(): void {
    this.stage.look(null);
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    this.group.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      geos.add(o.geometry as THREE.BufferGeometry);
      mats.add(o.material as THREE.Material);
      if (o instanceof THREE.InstancedMesh) o.dispose();
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

  /** Placement `i`'s standing matrix into `m4`. */
  private restMatrix(i: number): void {
    const p = this.placed[i]!;
    this.m4.compose(this.v.set(p.x, p.y, p.z), this.q.setFromAxisAngle(this.up, p.yaw), this.sc.set(p.sx, p.sy, p.sz));
  }
}
