/**
 * The National Mall's landmarks as drawn pieces (`world/catalog.ts` and `world/landmarks.ts` hold their shapes and colliders): the
 * White House, the lawn fountains, the reflecting pools and the round basin, the Lincoln Memorial, the Capitol, the Capitol
 * Reflecting Pool, and the monuments of bronze on marble.
 */
import * as THREE from "three";
import { hypot2 } from "../kernel/physics-core.js";
import { BASIN, FOUNTAIN, LINCOLN, lincolnColumns, POOL, WHITE_HOUSE, type Slab } from "../world/catalog.ts";
import { box, cyl, MARBLE_SHADE, type Piece, type PrefabMaterials, type PrefabPart, painted, squareFrustum } from "./prefab-pieces.ts";
import { type Brick, CAPITOL, CAPITOL_POOL, FLAGPOLE, capitolBalustrades, capitolPool, capitolWestStair, domeRing, figure } from "../world/landmarks.ts";

/** The White House's whitewashed sandstone, its trim, the grey roof, dark glass and door, and the flag's colours. */
const WH_SHADE = { wall: 0xf6f4ee, trim: 0xe3dfd5, roof: 0x8d949b, glass: 0x2d3540, door: 0x4a3626, red: 0xb22234, white: 0xf5f5f5, blue: 0x3c3b6e, pole: 0xd9d9d9 };
/** How far (m) the windows and doors stand proud of the walls they are set in. */
const WH_PROUD = 0.04;
/** Radial segments of the White House's columns and its round South Portico: within 1.5 cm of the colliders' circles. */
const WH_SEGMENTS = { column: 16, bow: 64 };

type WhBlock = { hx: number; hz: number; x: number; z: number; y0: number; y1: number };
type WhDrum = { r: number; x: number; z: number; y0: number; y1: number };
const whBox = (b: WhBlock): THREE.BufferGeometry => box(b.hx * 2, b.y1 - b.y0, b.hz * 2, b.x, (b.y0 + b.y1) / 2, b.z);
const whDrum = (d: WhDrum, seg: number): THREE.BufferGeometry => cyl(d.r, d.r, d.y0, d.y1, seg).translate(d.x, 0, d.z);

/** A gable over a block's plan: a triangle across x from `y0` up to a ridge at `y1`, run along z. */
function gable(b: WhBlock): THREE.BufferGeometry {
  const shape = new THREE.Shape([new THREE.Vector2(-b.hx, 0), new THREE.Vector2(b.hx, 0), new THREE.Vector2(0, b.y1 - b.y0)]);
  return new THREE.ExtrudeGeometry(shape, { depth: b.hz * 2, bevelEnabled: false }).translate(b.x, b.y0, b.z - b.hz);
}

/**
 * Dark panes across a face: `bays` x centres (or z, `onX` false) on a wall face at `face`, each `w` wide from `y0` to `y1`,
 * standing `WH_PROUD` out of it.
 */
function panes(bays: readonly number[], face: number, onX: boolean, w: number, y0: number, y1: number, hex = WH_SHADE.glass): Piece[] {
  return bays.map((c): Piece => [onX ? box(w, y1 - y0, WH_PROUD * 2, c, (y0 + y1) / 2, face) : box(WH_PROUD * 2, y1 - y0, w, face, (y0 + y1) / 2, c), hex]);
}

/** `n` evenly spaced centres across `span` either side of 0. */
const bays = (n: number, span: number): number[] => Array.from({ length: n }, (_, i) => -span + (2 * span * i) / (n - 1));

export function whiteHouse(): Piece[] {
  const w = WHITE_HOUSE;
  const out: Piece[] = [
    [whBox(w.footing), WH_SHADE.trim],
    [whBox(w.walls), WH_SHADE.wall],
    [whBox(w.cornice), WH_SHADE.trim],
    [whBox(w.balustrade), WH_SHADE.wall],
    [squareFrustum(1, w.roof.top, w.roof.y0, w.roof.y1).scale(w.roof.hx, 1, w.roof.hz), WH_SHADE.roof],
    ...w.chimneys.map((c): Piece => [whBox(c), WH_SHADE.trim]),
    [whBox(w.northFloor), WH_SHADE.trim],
    ...w.northColumns.map((c): Piece => [whDrum(c, WH_SEGMENTS.column), WH_SHADE.wall]),
    [whBox(w.northEntablature), WH_SHADE.trim],
    [gable(w.pediment), WH_SHADE.wall],
    [whDrum(w.bow, WH_SEGMENTS.bow), WH_SHADE.wall],
    [whDrum(w.southTerrace, WH_SEGMENTS.bow), WH_SHADE.trim],
    ...w.southColumns.map((c): Piece => [whDrum(c, WH_SEGMENTS.column), WH_SHADE.wall]),
    [whDrum(w.balcony, WH_SEGMENTS.bow), WH_SHADE.trim],
    [whDrum(w.southEntablature, WH_SEGMENTS.bow), WH_SHADE.trim],
    [whDrum(w.southBalustrade, WH_SEGMENTS.bow), WH_SHADE.wall],
    ...[...w.colonnades, ...w.wings].map((b): Piece => [whBox(b), WH_SHADE.wall]),
    ...w.wingCornices.map((b): Piece => [whBox(b), WH_SHADE.trim]),
  ];
  // Eleven bays to a long front, five to an end: the State Floor's tall windows, the upper floor's, and on the south (where the
  // lawn falls away) the ground floor's; the bow hides the middle three bays of the south front.
  const { hx, hz } = w.walls;
  const front = bays(11, 23);
  const south = front.filter((x) => Math.abs(x) > w.bow.r);
  for (const [face, xs] of [[-hz, front], [hz, south]] as const) out.push(...panes(xs, face, true, 1.5, 4.6, 7.8), ...panes(xs, face, true, 1.4, 11.2, 13.6));
  out.push(...panes(south, hz, true, 1.3, 2.2, 3.8));
  for (const s of [-1, 1]) out.push(...panes(bays(5, 8.4), s * hx, false, 1.5, 6.2, 9.2), ...panes(bays(5, 8.4), s * hx, false, 1.4, 11.2, 13.6));
  out.push(...panes([0], -hz, true, 2.4, w.northFloor.y1, 5.4, WH_SHADE.door));
  // The colonnades' arches on their south side and a row of windows down each wing's fronts.
  for (const c of w.colonnades) out.push(...panes(bays(7, c.hx - 2.5).map((x) => x + c.x), c.z + c.hz, true, 2.2, 1, 3.8));
  for (const g of w.wings) for (const s of [-1, 1]) out.push(...panes(bays(8, g.hx - 3).map((x) => x + g.x), g.z + s * g.hz, true, 1.4, 4.2, 6.8));
  // The flag flies to +x from the top of the pole: thirteen stripes and the canton over the top seven.
  const { pole, fly, drop } = w.flag;
  out.push([cyl(pole.r * 0.6, pole.r, pole.y0, pole.y1, 8), WH_SHADE.pole]);
  const stripe = drop / 13;
  for (let i = 0; i < 13; i++) out.push([box(fly, stripe, 0.08, pole.r + fly / 2, pole.y1 - stripe * (i + 0.5), 0), i % 2 ? WH_SHADE.white : WH_SHADE.red]);
  out.push([box(fly * 0.4, stripe * 7, 0.1, pole.r + fly * 0.2, pole.y1 - stripe * 3.5, 0), WH_SHADE.blue]);
  return out;
}

/** Stone, water (a centimetre over the rim, so it shows) and spray. */
const FOUNTAIN_SHADE = { stone: 0xe6e1d6, water: 0x6f9fb8, spray: 0xe8f4fa };

export function fountain(): Piece[] {
  const { basin, water, pedestal, jet, spray } = FOUNTAIN;
  return [
    [cyl(basin.r, basin.r, 0, basin.y1, 48), FOUNTAIN_SHADE.stone],
    [cyl(water.r, water.r, water.y0, basin.y1 + 0.01, 48), FOUNTAIN_SHADE.water],
    [cyl(pedestal.r, pedestal.r, basin.y1, pedestal.y1, 24), FOUNTAIN_SHADE.stone],
    [cyl(jet.r, jet.r, pedestal.y1, jet.y1, 12), FOUNTAIN_SHADE.spray],
    [cyl(jet.r, spray.r, spray.y0, jet.y1, 24), FOUNTAIN_SHADE.spray],
  ];
}

/** Pool stone and still water (dark, so the sky's gloss carries it). */
const POOL_SHADE = { stone: 0xd9d4c8, water: 0x2f5b6e };
/** Sides of the round basin: its 27.5 m rim within a centimetre of the collider's circle. */
const BASIN_SEGMENTS = 128;
/** How deep (m) the water piece reaches under the stone's top, so no gap shows at the kerb. */
const WATER_DEPTH = 0.1;

export function pool(mats: PrefabMaterials): PrefabPart[] {
  const { half, rim, y1, brim } = POOL;
  const [hx, hz] = half;
  return [
    { geometry: painted([[box(hx * 2, y1, hz * 2, 0, y1 / 2, 0), POOL_SHADE.stone]]), material: mats.plain, shared: false },
    { geometry: painted([[box((hx - rim) * 2, WATER_DEPTH + brim, (hz - rim) * 2, 0, y1 + (brim - WATER_DEPTH) / 2, 0), POOL_SHADE.water]]), material: mats.water, shared: false },
  ];
}

export function basin(mats: PrefabMaterials): PrefabPart[] {
  const { r, rim, y1 } = BASIN;
  return [
    { geometry: painted([[cyl(r, r, 0, y1, BASIN_SEGMENTS), POOL_SHADE.stone]]), material: mats.plain, shared: false },
    { geometry: painted([[cyl(r - rim, r - rim, y1 - WATER_DEPTH, y1 + POOL.brim, BASIN_SEGMENTS), POOL_SHADE.water]]), material: mats.water, shared: false },
  ];
}

/** The Lincoln Memorial's stones: the terrace's granite, the chamber's shade, the inscribed panels, the carved festoons, bronze. */
const LINCOLN_SHADE = { granite: 0xb3ada1, shadow: 0x8e897f, panel: 0xa59e8f, festoon: 0xbdb6a5, bronze: 0x5c4b33 };
/** Drawn only (inside the colonnade's collider): the chamber's two rows of four Ionic columns, x either side, z along the row. */
const LINCOLN_IONIC = { r: 0.72, x: 8, zs: [-8, -2.7, 2.7, 8], y1: 22.4 };

/** The seated Lincoln (m), on his pedestal at the chamber's back: chair, figure and head, after Daniel Chester French's statue. */
function lincolnStatue(): Piece[] {
  const p = LINCOLN.statue.pedestal;
  const top = p.y1;
  const z = p.z;
  // The figure a shade whiter than the chair it sits in, so it reads from the steps.
  const white = MARBLE_SHADE.dome;
  const chair = MARBLE_SHADE.high;
  const at = (w: number, h: number, d: number, x: number, y0: number, dz: number): THREE.BufferGeometry => box(w, h, d, x, y0 + h / 2, z + dz);
  return [
    [box(p.hx * 2, p.y1 - p.y0, p.hz * 2, 0, (p.y0 + p.y1) / 2, z), MARBLE_SHADE.trim],
    // The chair: its seat, its high back, its arms (fasces under his hands).
    [at(4.6, 2.2, 3.8, 0, top, -0.3), chair],
    [at(4.6, 3.8, 0.6, 0, top + 2.2, -1.9), chair],
    ...[-1, 1].map((s): Piece => [at(0.6, 0.5, 3.4, s * 2, top + 2.2, -0.3), chair]),
    // The figure: thighs forward over the seat, the shins down to the feet on the pedestal, the body, the shoulders, the hands.
    [at(2.2, 0.8, 2.4, 0, top + 2.2, 1.1), white],
    ...[-1, 1].map((s): Piece => [at(0.8, 2.3, 0.8, s * 0.6, top, 2), white]),
    ...[-1, 1].map((s): Piece => [at(0.8, 0.4, 1.2, s * 0.6, top, 2.1), white]),
    [at(2.4, 2.6, 1.6, 0, top + 2.2, -0.8), white],
    [at(2.8, 0.6, 1.5, 0, top + 4.6, -0.8), white],
    ...[-1, 1].map((s): Piece => [at(0.5, 0.4, 0.6, s * 2, top + 2.7, 1), white]),
    [new THREE.SphereGeometry(0.5, 12, 8).translate(0, top + 5.75, z - 0.6), white],
  ];
}

export function lincoln(): Piece[] {
  const L = LINCOLN;
  const slab = (b: Slab): THREE.BufferGeometry => box(b.hx * 2, b.y1 - b.y0, b.hz * 2, b.x ?? 0, (b.y0 + b.y1) / 2, b.z ?? 0);
  const c = L.columns;
  const cap = L.capital;
  const shaftTop = c.y1 - cap.echinus - cap.abacus;
  const w = L.cella;
  const h = w.y1 - w.y0;
  const mid = (w.y0 + w.y1) / 2;
  const leaf = w.hx - w.door;
  const columns = lincolnColumns();
  // A frieze panel over each column, on the face it stands under; the attic's festoons evenly along its four faces.
  const fz = L.frieze;
  const panels = columns.map(([x, z]): Piece => {
    const y = (fz.y0 + fz.y1) / 2;
    if (Math.abs(z) === c.hz) return [box(1.8, 0.9, 0.06, x, y, Math.sign(z) * (fz.hz + 0.03)), LINCOLN_SHADE.panel];
    return [box(0.06, 0.9, 1.8, Math.sign(x) * (fz.hx + 0.03), y, z), LINCOLN_SHADE.panel];
  });
  const f = L.festoon;
  const a = L.attic;
  const festoons: Piece[] = [];
  for (let i = 0; i < f.alongX; i++) {
    const x = -a.hx + ((i + 0.5) * 2 * a.hx) / f.alongX;
    for (const s of [-1, 1]) festoons.push([box(f.w, f.h, f.proud, x, f.y, s * (a.hz + f.proud / 2)), LINCOLN_SHADE.festoon]);
  }
  for (let i = 0; i < f.alongZ; i++) {
    const z = -a.hz + ((i + 0.5) * 2 * a.hz) / f.alongZ;
    for (const s of [-1, 1]) festoons.push([box(f.proud, f.h, f.w, s * (a.hx + f.proud / 2), f.y, z), LINCOLN_SHADE.festoon]);
  }
  const bowl = L.bowl;
  const io = LINCOLN_IONIC;
  return [
    // The terrace, the grand stair and its cheek blocks with their braziers.
    [slab(L.terrace), LINCOLN_SHADE.granite],
    ...L.stair.map((b): Piece => [slab(b), MARBLE_SHADE.trim]),
    ...L.cheeks.flatMap((b): Piece[] => [[slab(b), LINCOLN_SHADE.granite], [slab({ ...b, x: -b.x }), LINCOLN_SHADE.granite]]),
    ...[-1, 1].flatMap((s): Piece[] => [
      [cyl(bowl.foot, bowl.foot, bowl.y0, bowl.y0 + 0.6, 12).translate(s * L.cheeks[0].x, 0, bowl.z), LINCOLN_SHADE.bronze],
      [cyl(bowl.r, bowl.foot, bowl.y0 + 0.6, bowl.y1, 16).translate(s * L.cheeks[0].x, 0, bowl.z), LINCOLN_SHADE.bronze],
    ]),
    // The great steps, the flight up through them, the stylobate.
    ...L.crepidoma.map((b): Piece => [slab(b), MARBLE_SHADE.trim]),
    ...L.upper.map((b): Piece => [slab(b), MARBLE_SHADE.low]),
    [slab(L.stylobate), MARBLE_SHADE.trim],
    // The cella: its back (shadowed inside), its ends, the east wall either side of the open door; the chamber's Ionic rows.
    [box(w.hx * 2, h, w.wall, 0, mid, -w.hz + w.wall / 2), MARBLE_SHADE.high],
    [box((w.hx - w.wall) * 2, h - 0.5, 0.1, 0, mid - 0.25, -w.hz + w.wall + 0.05), LINCOLN_SHADE.shadow],
    ...[-1, 1].map((s): Piece => [box(w.wall, h, w.hz * 2, s * (w.hx - w.wall / 2), mid, 0), MARBLE_SHADE.high]),
    ...[-1, 1].map((s): Piece => [box(leaf, h, w.wall, s * (w.door + leaf / 2), mid, w.hz - w.wall / 2), MARBLE_SHADE.high]),
    ...[-1, 1].flatMap((s) => io.zs.map((z): Piece => [cyl(io.r * 0.9, io.r, w.y0, io.y1, 16).translate(s * io.x, 0, z), MARBLE_SHADE.wall])),
    ...lincolnStatue(),
    // The peristyle: tapered shafts, each under its echinus and abacus.
    ...columns.flatMap(([x, z]): Piece[] => [
      [cyl(c.r1, c.r0, c.y0, shaftTop, 20).translate(x, 0, z), MARBLE_SHADE.wall],
      [cyl(cap.flare, c.r1, shaftTop, shaftTop + cap.echinus, 20).translate(x, 0, z), MARBLE_SHADE.wall],
      [box(cap.half * 2, cap.abacus, cap.half * 2, x, c.y1 - cap.abacus / 2, z), MARBLE_SHADE.trim],
    ]),
    // The entablature, its panels, the attic and its festoons, the attic's cornice, the roof.
    [slab(L.architrave), MARBLE_SHADE.wall],
    [slab(L.frieze), MARBLE_SHADE.high],
    ...panels,
    [slab(L.cornice), MARBLE_SHADE.trim],
    [slab(L.attic), MARBLE_SHADE.wall],
    ...festoons,
    [slab(L.atticCornice), MARBLE_SHADE.trim],
    [slab(L.roof), MARBLE_SHADE.high],
  ];
}


/** A statue's bronze, gone dark (sRGB). */
const BRONZE = 0x4d4434;
/** The Capitol's window glass (sRGB). */
const CAPITOL_GLASS = 0x2f3843;
/** Radial segments of the Capitol's round parts: the drawn rings stand within 3 cm of the colliders' circles. */
const CAPITOL_SEGMENTS = 64;
/** Sides of a Capitol column, and of one in the drum's colonnade. */
const COLUMN_SIDES = 12;

/** A brick (`landmarks.ts`) as drawn: turned by its yaw about its centre. */
function brickGeometry(b: Brick): THREE.BufferGeometry {
  return new THREE.BoxGeometry(b.hx * 2, b.y1 - b.y0, b.hz * 2).rotateY(b.yaw ?? 0).translate(b.x, (b.y0 + b.y1) / 2, b.z);
}

/** A monument of bricks: its marble ones white, the rest bronze. */
export function monumentPieces(bricks: readonly Brick[]): Piece[] {
  return bricks.map((b): Piece => [brickGeometry(b), b.stone ? MARBLE_SHADE.high : BRONZE]);
}

/** The Capitol Reflecting Pool: its stone rim, and its water a centimetre over the rim inside it. */
export function capitolPoolParts(mats: PrefabMaterials): PrefabPart[] {
  const { rim, water } = capitolPool();
  // The shape is drawn in (x, -z) and laid flat: x stays, its y becomes the world's z.
  const shape = new THREE.Shape(water.map(([x, z]) => new THREE.Vector2(x, -z)));
  const sheet = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, CAPITOL_POOL.y1 + CAPITOL_POOL.brim, 0);
  return [
    { geometry: painted(rim.map((b): Piece => [brickGeometry(b), POOL_SHADE.stone])), material: mats.plain, shared: false },
    { geometry: painted([[sheet, POOL_SHADE.water]]), material: mats.water, shared: false },
  ];
}

/** `count` centres evenly over -`half`..`half`. */
function spread(count: number, half: number): number[] {
  return Array.from({ length: count }, (_, i) => (count === 1 ? 0 : -half + (2 * half * i) / (count - 1)));
}

/** The Capitol's windows: two floors of dark panes down its fronts and its wings' ends, standing `proud` out of the walls. */
function capitolWindows(): Piece[] {
  const { floors, width, bay, proud } = CAPITOL.windows;
  const [, centre, north, south] = CAPITOL.blocks;
  const out: Piece[] = [];
  const pane = (onX: boolean, face: number, at: number, y0: number, y1: number): Piece => [
    onX ? box(proud * 2, y1 - y0, width, face, (y0 + y1) / 2, at) : box(width, y1 - y0, proud * 2, at, (y0 + y1) / 2, face),
    CAPITOL_GLASS,
  ];
  for (const [y0, y1] of floors) {
    // The central block's west front (its east is behind the portico); each wing's west and east fronts and its far end.
    for (const z of spread(Math.floor((centre!.hz * 2) / bay), centre!.hz - bay / 2)) out.push(pane(true, -centre!.hx, z, y0, y1));
    for (const w of [north!, south!]) {
      for (const z of spread(Math.floor((w.hz * 2) / bay), w.hz - bay / 2)) for (const face of [-w.hx, w.hx]) out.push(pane(true, face, w.z + z, y0, y1));
      for (const x of spread(Math.floor((w.hx * 2) / bay), w.hx - bay / 2)) out.push(pane(false, w.z + Math.sign(w.z) * w.hz, x, y0, y1));
    }
  }
  return out;
}

/** A pediment: its triangle across z, its peak `rise` up, from `x0` to `x1`. */
function pedimentGeometry(p: { half: number; z: number; x0: number; x1: number; y0: number; rise: number }): THREE.BufferGeometry {
  const shape = new THREE.Shape([new THREE.Vector2(-p.half, 0), new THREE.Vector2(p.half, 0), new THREE.Vector2(0, p.rise)]);
  // Extruded along the shape's z, then turned a quarter so that runs along x (the shape's x falls along -z: it is symmetric).
  return new THREE.ExtrudeGeometry(shape, { depth: p.x1 - p.x0, bevelEnabled: false }).rotateY(Math.PI / 2).translate(p.x0, p.y0, p.z);
}

/** The dome's ribs: each meridian a chain of slabs from ring to ring, standing `ribOut` out of the shell. */
function domeRibs(): Piece[] {
  const { ribs, rib, ribOut, rings } = CAPITOL.dome;
  const out: Piece[] = [];
  for (let i = 0; i < ribs; i++) {
    const a = (i * 2 * Math.PI) / ribs;
    for (let k = rings; k > 0; k--) {
      const lo = domeRing(k);
      const hi = domeRing(k - 1);
      const dr = hi.r - lo.r;
      const dy = hi.y - lo.y;
      const len = hypot2(dr, dy);
      // Out of the chord along its outward normal (dy, -dr) by half the rib's depth.
      const r = (lo.r + hi.r) / 2 + (dy / len) * (ribOut / 2);
      const y = (lo.y + hi.y) / 2 - (dr / len) * (ribOut / 2);
      const slab = new THREE.BoxGeometry(rib, len, ribOut).rotateX(Math.atan2(dr, dy)).rotateY(a).translate(Math.sin(a) * r, y, Math.cos(a) * r);
      out.push([slab, MARBLE_SHADE.dome]);
    }
  }
  return out;
}

/** The U.S. Capitol (`CAPITOL`), front +X the east front, its west front with the terraces' stair toward the Mall. */
export function capitol(): Piece[] {
  const { blocks, colonnades, entablatures, pediments, attic, columns, drum, entablature, dome, lantern, freedom } = CAPITOL;
  const block = (b: { hx: number; hz: number; x: number; z: number; y0: number; y1: number }): THREE.BufferGeometry => box(b.hx * 2, b.y1 - b.y0, b.hz * 2, b.x, (b.y0 + b.y1) / 2, b.z);
  const out: Piece[] = blocks.map((b): Piece => [block(b), b.y0 === 0 ? MARBLE_SHADE.trim : MARBLE_SHADE.wall]);
  out.push(...capitolWestStair().map((b): Piece => [block(b), MARBLE_SHADE.trim]));
  out.push(...capitolBalustrades().map((b): Piece => [block(b), MARBLE_SHADE.trim]));
  for (const c of colonnades) {
    for (const at of spread(c.count, (c.to - c.from) / 2)) {
      const mid = (c.from + c.to) / 2 + at;
      out.push([cyl(c.r * 0.9, c.r, c.y0, c.y1, COLUMN_SIDES).translate(c.alongX ? mid : c.at, 0, c.alongX ? c.at : mid), MARBLE_SHADE.dome]);
    }
  }
  out.push(...entablatures.map((e): Piece => [block(e), MARBLE_SHADE.trim]));
  out.push(...pediments.map((p): Piece => [pedimentGeometry(p), MARBLE_SHADE.wall]));
  out.push(...capitolWindows());
  out.push([cyl(attic.r, attic.r, attic.y0, attic.y1, CAPITOL_SEGMENTS), MARBLE_SHADE.wall]);
  out.push([cyl(drum.r, drum.r, drum.y0, drum.y1, CAPITOL_SEGMENTS), MARBLE_SHADE.trim]);
  for (let i = 0; i < columns.count; i++) {
    const a = (i * 2 * Math.PI) / columns.count;
    out.push([cyl(columns.r, columns.r, columns.y0, columns.y1, 8).translate(Math.sin(a) * columns.ring, 0, Math.cos(a) * columns.ring), MARBLE_SHADE.dome]);
    // The drum's tall windows, one behind each gap of the colonnade.
    const b = a + Math.PI / columns.count;
    out.push([box(1.4, 6, 0.1, 0, 0, 0).rotateY(b).translate(Math.sin(b) * drum.r, 42.5, Math.cos(b) * drum.r), CAPITOL_GLASS]);
  }
  out.push([cyl(entablature.r, entablature.r, entablature.y0, entablature.y1, CAPITOL_SEGMENTS), MARBLE_SHADE.wall]);
  // The sphere's own latitude rings are the ones `domeRing` names, so the colliders' steps meet the drawn dome on a ring.
  const shell = new THREE.SphereGeometry(dome.r, CAPITOL_SEGMENTS, dome.rings, 0, Math.PI * 2, 0, Math.PI / 2);
  out.push([shell.scale(1, (dome.crown - dome.spring) / dome.r, 1).translate(0, dome.spring, 0), MARBLE_SHADE.dome]);
  out.push(...domeRibs());
  out.push([cyl(lantern.r, lantern.r, lantern.y0, lantern.y1, 16), MARBLE_SHADE.dome]);
  for (let i = 0; i < lantern.columns; i++) {
    const a = (i * 2 * Math.PI) / lantern.columns;
    out.push([cyl(lantern.columnR, lantern.columnR, lantern.y0, lantern.y1, 8).translate(Math.sin(a) * lantern.ring, 0, Math.cos(a) * lantern.ring), MARBLE_SHADE.dome]);
  }
  out.push([cyl(0.9, lantern.r, lantern.y1, lantern.spire, 16), MARBLE_SHADE.trim]);
  out.push(...monumentPieces(figure(0, 0, lantern.spire, freedom.scale)));
  return out;
}

/** A flag's colours (sRGB): Old Glory red and white, the canton's blue, and a flagpole's aluminium. */
const FLAG_SHADE = { red: 0xb22234, white: 0xf5f5f5, blue: 0x3c3b6e, pole: 0xd0d3d6 };
/** The canton stands this much (m) proud of the stripes either side, so the two never fight for the same depth. */
const CANTON_PROUD = 0.004;

/** A flagpole and its flag: the pole, the stripes red and white top to bottom, and the blue canton at the pole over the top four. */
export function flagpole(): Piece[] {
  const { r, top, flag } = FLAGPOLE;
  const stripe = flag.height / flag.stripes;
  const out: Piece[] = [[cyl(r, r, 0, top, 12), FLAG_SHADE.pole]];
  for (let i = 0; i < flag.stripes; i++) {
    out.push([box(flag.length, stripe, flag.thick, r + flag.length / 2, top - stripe * (i + 0.5), 0), i % 2 ? FLAG_SHADE.white : FLAG_SHADE.red]);
  }
  const canton = flag.length * 0.4;
  out.push([box(canton, stripe * 4, flag.thick + CANTON_PROUD * 2, r + canton / 2, top - stripe * 2, 0), FLAG_SHADE.blue]);
  return out;
}
