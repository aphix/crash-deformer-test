import * as THREE from "three";
import { detCos, detSin, hypot2 } from "../kernel/physics-core.js";
import { DERBY_ARENA } from "./constants.ts";
import { DIRT_EXTENT, makeDirtTexture } from "./derby-dirt-texture.ts";
import { DERBY_BOXES, DERBY_PLATEAUS, DERBY_PROP, DERBY_RAMPS, type DerbyGround, type DerbyPropKind, type DerbyRamp } from "./derby-ground.ts";
import {
  makeBarrierTexture,
  makeConcreteWallTexture,
  makeCorrugatedTexture,
  makeGlassTexture,
  makePlankTexture,
  makeRubberTexture,
  makeSeededRandom,
  makeTyreStackTexture,
  WALL_HEIGHT_METRES,
} from "./derby-textures.ts";
import { groundMesh } from "./ground-stack.ts";

/** Inner face of the ring wall (m from the middle): the AI's keep-in radius. */
export const DERBY_RADIUS = DERBY_ARENA.radius;

/** The floor: grid cells whose centre is within `DERBY_ARENA.radius` + this (m) of the middle are drawn. */
const FLOOR_MARGIN = 1;
/** The dirt texture is grey (mean 0.87 of white): this warm tan, every node's vertex colour, tints it. */
const FLOOR_DIRT_COLOUR = 0xa88358;
const FLOOR_SCRAP_COLOUR = 0x3a3835;
/** Spread of the per-vertex tint: a vertex colour is its base times 1 ± half of this. */
const FLOOR_TINT_RANGE = 0.16;
const FLOOR_SEED = 20240611;
const FLOOR_ROUGHNESS = 0.95;
const FLOOR_METALNESS = 0.02;
/** The scrap hump is the plateau of this height (`DERBY_PLATEAUS`); a node is scrap where it is lifted by at most this much (plus the tolerance). */
const SCRAP_HEIGHT = 0.8;
const SCRAP_HEIGHT_TOLERANCE = 1e-3;

/** Ramp decks: the plank texture's tile is one metre square (4 boards of 0.25 m); timber is dull. */
const PLANK_TILE_METRES = 1;
const DECK_ROUGHNESS = 0.9;
const DECK_METALNESS = 0.02;
/** Timber tint over the plank texture: the decks read a shade darker and redder than the tan dirt they lie on. */
const DECK_TINT = 0xc8a27a;

/** The plain past the wall: dark dirt from just under the wall's foot out to `OUTER_RADIUS` (m), a hair under the floor. */
const OUTER_INNER_OVERLAP = 0.5;
const OUTER_RADIUS = 90;
const OUTER_HEIGHT = -0.02;
const OUTER_SEGMENTS = 64;
const OUTER_COLOUR = 0x3f3427;

/** The metres a prop texture covers once across a box face (`across`: along its horizontal axis, `up`: its vertical axis). */
type TileMetres = { across: number; up: number };

/** The concrete wall and glass textures are one 3 m panel wide; the wall texture is `WALL_HEIGHT_METRES` tall, the glass texture stretches over its whole height. */
const PANEL_METRES = 3;
const WALL_TILE: TileMetres = { across: PANEL_METRES, up: WALL_HEIGHT_METRES };
/** The corrugated tile is 1 m: ribs every 0.2 m. */
const CONTAINER_TILE: TileMetres = { across: 1, up: 1 };
/** A K-rail box is 3.66 m long (two panels with a seam each) and 1.8 m high (the barrier texture's base, shoulder and top fill one tile). */
const RAIL_TILE: TileMetres = { across: 1.83, up: 1.8 };
/** The rubber tile is 1 m: studs every 0.25 m. */
const PAD_TILE: TileMetres = { across: 1, up: 1 };
/** A tyre is about 0.65 m across and the tyre texture packs two to a tile row. */
const TYRE_TILE: TileMetres = { across: 1.3, up: 1.3 };
/** Textures that carry their own colour are tinted white (the instance colour multiplies the texture). */
const WHITE = 0xffffff;
const WALL_COLOURS = [WHITE] as const;
/** Blue, red and rusted containers: one berm of four shows each in turn, the rusted one among them. */
const CONTAINER_COLOURS = [0x2f4f7a, 0x8a3a2a, 0x7b4a2d] as const;
const RAIL_COLOURS = [0xb0aca4] as const;
const PAD_COLOURS = [WHITE] as const;
const TYRE_COLOURS = [WHITE] as const;
const PROP_ROUGHNESS = 0.85;
const PROP_METALNESS = 0.08;
const CONTAINER_METALNESS = 0.3;

/** The glass above the concrete wall: its thickness (m), whose inner face is flush with the wall's, and its look. */
const GLASS_THICKNESS = 0.2;
const GLASS_ROUGHNESS = 0.1;
const GLASS_METALNESS = 0;

/** Mounds in the ring beyond the wall (count). */
const MOUND_COUNT = 20;
/** Height of a mound's dome (m). */
const MOUND_HEIGHT = 4;
const MOUND_RADIUS_RANGE = [8, 14] as const;
const MOUND_RING_RANGE = [50, 66] as const;
/** A mound's near edge stays this far (m) beyond the wall's inner face, so none reaches the arena or a tower. */
const MOUND_CLEARANCE = 12;
const MOUND_COLOUR = 0x4a3e30;
const MOUND_SEED = 31337;
const MOUND_RADIAL_SEGMENTS = 16;
const MOUND_HEIGHT_SEGMENTS = 4;

/** Floodlight towers around the arena (count). */
const TOWER_COUNT = 8;
/** How far past the arena radius a tower stands (m). */
const TOWER_DISTANCE = 8;
/** Radius of a tower pole (m). */
const TOWER_RADIUS = 0.4;
/** Height of a tower pole (m). */
const TOWER_HEIGHT = 14;
/** Radial segments of a tower pole's cylinder (count). */
const TOWER_SEGMENTS = 6;
const TOWER_COLOUR = 0x55575c;
/** The lamp head's box on top of a pole: width, height and length (m). */
const TOWER_HEAD = { width: 3, height: 0.6, length: 1.2 } as const;
const TOWER_LAMP_BODY = 0x2a2a2a;
const TOWER_LAMP_GLOW = 0xffe2b0;
/** Emissive intensity of a lamp head (unitless multiplier). */
const TOWER_LAMP_INTENSITY = 1.5;

/** The one indexed mesh of the baked grid: every node of a cell within reach of the middle, its colour by what the node is. */
function makeFloorGeometry(ground: DerbyGround): THREE.BufferGeometry {
  const nodesPerSide = Math.round(Math.sqrt(ground.heights.length));
  const reach = DERBY_ARENA.radius + FLOOR_MARGIN;
  const dirt = new THREE.Color(FLOOR_DIRT_COLOUR);
  const scrap = new THREE.Color(FLOOR_SCRAP_COLOUR);
  const scrapHumps = DERBY_PLATEAUS.filter((plateau) => plateau.height === SCRAP_HEIGHT);
  const random = makeSeededRandom(FLOOR_SEED);
  const vertexOfNode = new Int32Array(ground.heights.length).fill(-1);
  const positions: number[] = [];
  const colours: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const isScrap = (x: number, z: number, height: number): boolean =>
    height > 0 &&
    height <= SCRAP_HEIGHT + SCRAP_HEIGHT_TOLERANCE &&
    scrapHumps.some((hump) => Math.abs(x - hump.x) <= hump.halfX + hump.run[1] + hump.round && Math.abs(z - hump.z) <= hump.halfZ + hump.run[3] + hump.round);

  const vertexAt = (column: number, row: number): number => {
    const node = row * nodesPerSide + column;
    const known = vertexOfNode[node]!;
    if (known >= 0) return known;
    const x = column - DERBY_ARENA.gridHalf;
    const z = row - DERBY_ARENA.gridHalf;
    const height = ground.heights[node]!;
    const base = isScrap(x, z, height) ? scrap : dirt;
    const tint = 1 + (random() - 0.5) * FLOOR_TINT_RANGE;
    const vertex = positions.length / 3;
    positions.push(x, height, z);
    colours.push(base.r * tint, base.g * tint, base.b * tint);
    uvs.push((x + DIRT_EXTENT) / (2 * DIRT_EXTENT), (z + DIRT_EXTENT) / (2 * DIRT_EXTENT));
    vertexOfNode[node] = vertex;
    return vertex;
  };

  for (let row = 0; row < nodesPerSide - 1; row++) {
    for (let column = 0; column < nodesPerSide - 1; column++) {
      const centreX = column + 0.5 - DERBY_ARENA.gridHalf;
      const centreZ = row + 0.5 - DERBY_ARENA.gridHalf;
      if (hypot2(centreX, centreZ) > reach) continue;
      indices.push(...cellTriangles(vertexAt(column, row), vertexAt(column, row + 1), vertexAt(column + 1, row), vertexAt(column + 1, row + 1)));
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colours, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** The two triangles of a grid cell from the vertices of its corners (`nearLow`: lowest x and z, `farHigh`: highest): the one split the floor and the decks share. */
function cellTriangles(nearLow: number, farLow: number, nearHigh: number, farHigh: number): number[] {
  return [nearLow, farLow, nearHigh, farLow, farHigh, nearHigh];
}

function makeFloor(ground: DerbyGround): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: FLOOR_ROUGHNESS, metalness: FLOOR_METALNESS, map: makeDirtTexture() });
  const floor = groundMesh(makeFloorGeometry(ground), material, "terrain");
  floor.name = "derby-floor";
  floor.receiveShadow = true;
  return floor;
}

/** Where a ramp's deck lies: `lateral` and `along` read a plan point against the ramp's axis (along: m toward the wall from the middle), `from`..`to` its length. */
function deckOf(entry: DerbyRamp) {
  const { plateau, toward } = entry;
  const risesAlongX = toward.x !== 0;
  const halfCrest = risesAlongX ? plateau.halfX : plateau.halfZ;
  const crestCentre = toward.x * plateau.x + toward.z * plateau.z;
  return {
    halfWidth: risesAlongX ? plateau.halfZ : plateau.halfX,
    from: crestCentre - halfCrest - entry.length,
    to: crestCentre + halfCrest,
    along: (x: number, z: number): number => toward.x * x + toward.z * z,
    lateral: (x: number, z: number): number => (risesAlongX ? z - plateau.z : x - plateau.x),
  };
}

/** The timber of every ramp in one mesh: the floor's cells whose centre is on a deck, the floor's triangles and node heights, planks laid across the ramp (uv in metres: u across it, v along it). */
function makeDeckGeometry(ground: DerbyGround): THREE.BufferGeometry {
  const nodesPerSide = Math.round(Math.sqrt(ground.heights.length));
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const entry of DERBY_RAMPS) {
    const deck = deckOf(entry);
    const vertexOfNode = new Map<number, number>();
    const vertexAt = (column: number, row: number): number => {
      const node = row * nodesPerSide + column;
      const known = vertexOfNode.get(node);
      if (known !== undefined) return known;
      const x = column - DERBY_ARENA.gridHalf;
      const z = row - DERBY_ARENA.gridHalf;
      const vertex = positions.length / 3;
      positions.push(x, ground.heights[node]!, z);
      uvs.push(deck.lateral(x, z) / PLANK_TILE_METRES, deck.along(x, z) / PLANK_TILE_METRES);
      vertexOfNode.set(node, vertex);
      return vertex;
    };
    for (let row = 0; row < nodesPerSide - 1; row++) {
      for (let column = 0; column < nodesPerSide - 1; column++) {
        const centreX = column + 0.5 - DERBY_ARENA.gridHalf;
        const centreZ = row + 0.5 - DERBY_ARENA.gridHalf;
        const along = deck.along(centreX, centreZ);
        if (Math.abs(deck.lateral(centreX, centreZ)) > deck.halfWidth || along < deck.from || along > deck.to) continue;
        indices.push(...cellTriangles(vertexAt(column, row), vertexAt(column, row + 1), vertexAt(column + 1, row), vertexAt(column + 1, row + 1)));
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeRampDecks(ground: DerbyGround): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({ map: makePlankTexture(), color: DECK_TINT, roughness: DECK_ROUGHNESS, metalness: DECK_METALNESS });
  const decks = groundMesh(makeDeckGeometry(ground), material, "decal");
  decks.name = "derby-ramp-decks";
  decks.receiveShadow = true;
  return decks;
}

function makeOuterGround(): THREE.Mesh {
  const geometry = new THREE.RingGeometry(DERBY_ARENA.radius - OUTER_INNER_OVERLAP, OUTER_RADIUS, OUTER_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  geometry.translate(0, OUTER_HEIGHT, 0);
  const outer = groundMesh(geometry, new THREE.MeshStandardMaterial({ color: OUTER_COLOUR, roughness: 1, metalness: 0 }), "terrain");
  outer.name = "derby-outer-ground";
  outer.receiveShadow = true;
  return outer;
}

/** The uv of a `BoxGeometry` in metres of `tile`: each of its six faces (+x, -x, +y, -y, +z, -z; the top and bottom use the tile's across for both axes) spans its own metres. */
function setMetricUv(geometry: THREE.BoxGeometry, tile: TileMetres): void {
  const { width, height, depth } = geometry.parameters;
  const faceExtents = [
    [depth / tile.across, height / tile.up],
    [depth / tile.across, height / tile.up],
    [width / tile.across, depth / tile.across],
    [width / tile.across, depth / tile.across],
    [width / tile.across, height / tile.up],
    [width / tile.across, height / tile.up],
  ] as const;
  const uv = geometry.getAttribute("uv");
  const verticesPerFace = uv.count / faceExtents.length;
  for (const [face, [uExtent, vExtent]] of faceExtents.entries()) {
    for (let corner = 0; corner < verticesPerFace; corner++) {
      const vertex = face * verticesPerFace + corner;
      uv.setXY(vertex, uv.getX(vertex) * uExtent, uv.getY(vertex) * vExtent);
    }
  }
  uv.needsUpdate = true;
}

type PlacedBox = { x: number; z: number; yaw: number; hx: number; hz: number; height: number };
type PropLook = { material: THREE.MeshStandardMaterial; colours: readonly number[]; tile: TileMetres };

/**
 * One instanced draw of `boxes` standing `base` m up: the instance's box IS the placed box (centre, yaw, size), its colour cycling
 * through the look's colours. The shared geometry is as tall as the boxes' mean, so a box's stretch is at most half their spread.
 */
function makeInstancedBoxes(name: string, boxes: readonly PlacedBox[], base: number, look: PropLook): THREE.InstancedMesh {
  const first = boxes[0];
  if (!first) throw new Error(`no boxes to draw as ${name}`);
  const meanHeight = boxes.reduce((sum, box) => sum + box.height, 0) / boxes.length;
  const geometry = new THREE.BoxGeometry(2 * first.hx, meanHeight, 2 * first.hz);
  setMetricUv(geometry, look.tile);
  const mesh = new THREE.InstancedMesh(geometry, look.material, boxes.length);
  mesh.name = name;
  const placement = new THREE.Object3D();
  const colour = new THREE.Color();
  for (const [index, box] of boxes.entries()) {
    placement.position.set(box.x, base + box.height / 2, box.z);
    placement.rotation.y = box.yaw;
    placement.scale.set(box.hx / first.hx, box.height / meanHeight, box.hz / first.hz);
    placement.updateMatrix();
    mesh.setMatrixAt(index, placement.matrix);
    mesh.setColorAt(index, colour.setHex(look.colours[index % look.colours.length]!));
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

function makeProps(): THREE.InstancedMesh[] {
  const solid = (map: THREE.Texture, metalness = PROP_METALNESS) => new THREE.MeshStandardMaterial({ map, roughness: PROP_ROUGHNESS, metalness });
  const looks: Record<DerbyPropKind, PropLook> = {
    [DERBY_PROP.wall]: { material: solid(makeConcreteWallTexture()), colours: WALL_COLOURS, tile: WALL_TILE },
    [DERBY_PROP.container]: { material: solid(makeCorrugatedTexture(), CONTAINER_METALNESS), colours: CONTAINER_COLOURS, tile: CONTAINER_TILE },
    [DERBY_PROP.rail]: { material: solid(makeBarrierTexture()), colours: RAIL_COLOURS, tile: RAIL_TILE },
    [DERBY_PROP.pad]: { material: solid(makeRubberTexture()), colours: PAD_COLOURS, tile: PAD_TILE },
    [DERBY_PROP.tyres]: { material: solid(makeTyreStackTexture()), colours: TYRE_COLOURS, tile: TYRE_TILE },
  };
  return Object.values(DERBY_PROP).flatMap((kind) => {
    const listed = DERBY_BOXES.filter((box) => box.kind === kind);
    // The wall box is the whole 12 m collider; what is drawn as wall is its concrete foot, the glass above it is its own draw.
    const boxes = kind === DERBY_PROP.wall ? listed.map((box) => ({ ...box, height: DERBY_ARENA.concreteHeight })) : listed;
    return boxes.length > 0 ? [makeInstancedBoxes(kind, boxes, 0, looks[kind])] : [];
  });
}

/** The glass over the concrete wall: a thin box over each wall piece from the concrete's top to the wall's top, its inner face on the wall's, so a car that stops at the wall stops at the glass. */
function makeGlass(): THREE.InstancedMesh {
  const glassHeight = DERBY_ARENA.wallHeight - DERBY_ARENA.concreteHeight;
  const standOff = (DERBY_ARENA.radius + GLASS_THICKNESS / 2) / (DERBY_ARENA.radius + DERBY_ARENA.wallThickness / 2);
  const panes = DERBY_BOXES.filter((box) => box.kind === DERBY_PROP.wall).map((wall) => ({
    x: wall.x * standOff,
    z: wall.z * standOff,
    yaw: wall.yaw,
    hx: GLASS_THICKNESS / 2,
    hz: wall.hz - DERBY_ARENA.wallMitre,
    height: glassHeight,
  }));
  const material = new THREE.MeshStandardMaterial({
    map: makeGlassTexture(),
    transparent: true,
    // Front faces only: blending a closed box's back face over its front mirrors the reflection streak into an X lattice.
    side: THREE.FrontSide,
    depthWrite: false,
    roughness: GLASS_ROUGHNESS,
    metalness: GLASS_METALNESS,
  });
  const glass = makeInstancedBoxes("glass", panes, DERBY_ARENA.concreteHeight, { material, colours: [WHITE], tile: { across: PANEL_METRES, up: glassHeight } });
  glass.castShadow = false;
  glass.receiveShadow = false;
  return glass;
}

const lerp = (range: readonly [number, number], share: number): number => range[0] + (range[1] - range[0]) * share;

/** Low rounded hills round the plain, outside the wall and out of reach. */
function makeMounds(): THREE.InstancedMesh {
  const dome = new THREE.SphereGeometry(1, MOUND_RADIAL_SEGMENTS, MOUND_HEIGHT_SEGMENTS, 0, Math.PI * 2, 0, Math.PI / 2);
  const mounds = new THREE.InstancedMesh(dome, new THREE.MeshStandardMaterial({ color: MOUND_COLOUR, roughness: 1, metalness: 0 }), MOUND_COUNT);
  mounds.name = "mounds";
  const random = makeSeededRandom(MOUND_SEED);
  const placement = new THREE.Object3D();
  for (let index = 0; index < MOUND_COUNT; index++) {
    const angle = ((index + random()) * Math.PI * 2) / MOUND_COUNT;
    const radius = lerp(MOUND_RADIUS_RANGE, random());
    const ring = Math.max(lerp(MOUND_RING_RANGE, random()), DERBY_ARENA.radius + MOUND_CLEARANCE + radius);
    placement.position.set(detSin(angle) * ring, 0, detCos(angle) * ring);
    placement.scale.set(radius, MOUND_HEIGHT, radius);
    placement.updateMatrix();
    mounds.setMatrixAt(index, placement.matrix);
  }
  mounds.receiveShadow = true;
  mounds.computeBoundingSphere();
  return mounds;
}

/** Floodlight towers round the wall: one instanced draw of poles, one of their lamp heads (warm and emissive, they cast no light). */
function makeFloodlights(): THREE.InstancedMesh[] {
  const poles = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(TOWER_RADIUS, TOWER_RADIUS, TOWER_HEIGHT, TOWER_SEGMENTS),
    new THREE.MeshStandardMaterial({ color: TOWER_COLOUR, roughness: 0.7, metalness: 0.5 }),
    TOWER_COUNT,
  );
  poles.name = "floodlight-poles";
  const heads = new THREE.InstancedMesh(
    new THREE.BoxGeometry(TOWER_HEAD.width, TOWER_HEAD.height, TOWER_HEAD.length),
    new THREE.MeshStandardMaterial({ color: TOWER_LAMP_BODY, emissive: TOWER_LAMP_GLOW, emissiveIntensity: TOWER_LAMP_INTENSITY }),
    TOWER_COUNT,
  );
  heads.name = "floodlight-heads";
  const placement = new THREE.Object3D();
  const distance = DERBY_ARENA.radius + TOWER_DISTANCE;
  for (let index = 0; index < TOWER_COUNT; index++) {
    const angle = (index * Math.PI * 2) / TOWER_COUNT;
    placement.position.set(detSin(angle) * distance, TOWER_HEIGHT / 2, detCos(angle) * distance);
    placement.rotation.y = angle;
    placement.updateMatrix();
    poles.setMatrixAt(index, placement.matrix);
    placement.position.y = TOWER_HEIGHT + TOWER_HEAD.height / 2;
    placement.updateMatrix();
    heads.setMatrixAt(index, placement.matrix);
  }
  poles.castShadow = true;
  poles.computeBoundingSphere();
  heads.computeBoundingSphere();
  return [poles, heads];
}

/**
 * The arena as the player sees it, drawn from the ground it plays on (`DerbyGround`): the floor is its baked grid, the ramps' timber
 * decks lie over it, the wall and every prop is an instance of its `DERBY_BOXES` box, and the plain, hills and floodlights past the wall
 * are scenery nobody reaches. Twelve draws: floor, plain, wall, glass, tyres, containers, rails, pads, ramp decks, mounds, poles, lamp
 * heads. Hidden until the engine shows it.
 */
export function makeDerbyArena(ground: DerbyGround): THREE.Group {
  const arena = new THREE.Group();
  arena.name = "derby-arena";
  arena.add(makeFloor(ground), makeOuterGround(), ...makeProps(), makeGlass(), makeRampDecks(ground), makeMounds(), ...makeFloodlights());
  for (const child of arena.children) {
    child.matrixAutoUpdate = false;
    child.updateMatrix();
  }
  arena.visible = false;
  return arena;
}

/** Spot height above the winner (m) and its candela when on. */
const SPOT_HEIGHT = 7;
const SPOT_CANDELA = 1400;

/**
 * The derby winner's spotlight: a warm narrow cone from above that follows the champion and throws a soft
 * pool on the ground, plus an additive glow decal under the car. Built once; "off" is intensity and opacity
 * 0, so no light or mesh is ever added, removed or hidden at runtime (each would recompile lit materials).
 * ponytail: no shadow map — the pool reads without one; add `castShadow` only if a cheap one is wanted.
 */
export class WinnerSpot {
  readonly light = new THREE.SpotLight(0xfff0d8, 0, SPOT_HEIGHT * 2, 0.36, 0.65, 2);
  private readonly glow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;

  constructor(scene: THREE.Scene, pool: THREE.Texture) {
    this.glow = groundMesh(
      new THREE.PlaneGeometry(6.5, 6.5),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, map: pool, transparent: true, opacity: 0, blending: THREE.AdditiveBlending }),
      "glow",
    );
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = 0.03;
    scene.add(this.light, this.light.target, this.glow);
  }

  follow(x: number, z: number): void {
    this.light.position.set(x, SPOT_HEIGHT, z);
    this.light.target.position.set(x, 0, z);
    this.light.target.updateMatrixWorld();
    this.light.intensity = SPOT_CANDELA;
    this.glow.position.set(x, 0.03, z);
    this.glow.material.opacity = 0.85;
  }

  off(): void {
    this.light.intensity = 0;
    this.glow.material.opacity = 0;
  }
}
