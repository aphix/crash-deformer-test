import { RaceSession } from "./session.ts";
import { Track, blankProjection, blankPoint, pointOn } from "../world/track.ts";
import type { CarPose, CarRecord } from "./types.ts";

/** Seconds per rules step (the engine steps its rules at the sim's 1/120 s or 1/240 s). */
const DT = 1 / 120;
/** Metres of main road driven before the line, and the longest bridge (m) between the main road and a shortcut's road: a smooth turn. */
const PRE = 12;
const BRIDGE = 40;
/** Metres between a gate and where the car turns off the road toward the shortcut (after its from gate) or back onto it (before its to gate). */
const GATE_CLEAR = 3;
/** Fastest and slowest speed (m/s) of the scripted driver, the lateral acceleration it corners at (m/s²) and the one it brakes and accelerates at. */
const V_MAX = 50;
const V_MIN = 12;
const A_LAT = 16;
const A_LONG = 12;
/** Lateral acceleration (m/s²) a weave asks of the car: a sinusoid of amplitude A runs at ω = √(WEAVE_ACCEL / A). */
const WEAVE_ACCEL = 12;
/** A knock's sideways displacement peaks this long (s) after the hit. */
const KNOCK_T = 1.2;
/** A corner turning tighter than 1 / KNOCK_RADIUS (m) gets a knock at its apex. */
const KNOCK_RADIUS = 150;
/** Half the car's width (m): the closest its centre goes to a wall. */
const CAR_HALF = 1;
/** Tightest turn (m radius) the car makes: inside a bend its offset is limited to keep to it. */
const TURN_MIN = 6;
/** How far (m) past the edge of the road and runoff the car strays where there is no wall: the owner's 5-10 m swing, and a margin. */
const OUT_MAX = 10;
/** A limit on the car's sideways offset changes at most this much per metre of line, so the offset stays continuous. */
const LIMIT_SLOPE = 0.6;

/** How the scripted car strays from the road centreline: a constant offset, a weave, and knocks at the corners. */
export type Swing = {
  name: string;
  /** Constant offset (m, + left); with `edge`, how far past the road's edge (the side `offset` is on). */
  offset: number;
  /** Weave amplitude (m), a sinusoid in time at the lateral acceleration a fishtail can ask of a car; with `edge`, past the road's edge. */
  weave: number;
  phase: number;
  /** Peak sideways displacement (m, + toward the outside of the corner) of a knock at every corner apex; 0 none. */
  knock: number;
  /** Peak sideways displacement (m, alternating left and right) of a kick every `kickEvery` m of travel from `kickAt`, wherever the car is (a gate, a mouth, a straight); 0 none. */
  kick: number;
  kickEvery: number;
  kickAt: number;
  /** `offset` and `weave` are measured from the edge of the road and runoff, not from the centreline. */
  edge: boolean;
};

const swing = (name: string, s: Partial<Swing>): Swing => ({ name, offset: 0, weave: 0, phase: 0, knock: 0, kick: 0, kickEvery: 0, kickAt: 0, edge: false, ...s });

export const SWINGS: readonly Swing[] = [
  swing("centre", {}),
  swing("5 m left", { offset: 5 }),
  swing("5 m right", { offset: -5 }),
  swing("10 m left", { offset: 10 }),
  swing("10 m right", { offset: -10 }),
  swing("weave 5 m", { weave: 5 }),
  swing("weave 5 m, other phase", { weave: 5, phase: Math.PI }),
  swing("weave 10 m", { weave: 10, phase: Math.PI / 2 }),
  swing("weave 10 m, other phase", { weave: 10, phase: (3 * Math.PI) / 2 }),
  swing("knocks 10 m out", { weave: 5, phase: 1, knock: 10 }),
  swing("knocks 10 m in", { weave: 5, phase: 2, knock: -10 }),
  swing("kicks 10 m every 60 m", { kick: 10, kickEvery: 60 }),
  swing("kicks 10 m every 60 m from 20 m", { kick: 10, kickEvery: 60, kickAt: 20 }),
  swing("kicks 10 m every 60 m from 40 m", { kick: 10, kickEvery: 60, kickAt: 40 }),
  swing("kicks 10 m every 37 m with a 5 m weave", { kick: 10, kickEvery: 37, kickAt: 11, weave: 5, phase: 1 }),
  swing("kicks 10 m every 23 m", { kick: 10, kickEvery: 23, kickAt: 5 }),
  swing("kicks 10 m every 90 m from 30 m, 5 m left", { kick: 10, kickEvery: 90, kickAt: 30, offset: 5 }),
  swing("5 m outside the left edge", { offset: 5, edge: true }),
  swing("5 m outside the right edge", { offset: -5, edge: true }),
  swing("10 m outside the left edge", { offset: 10, edge: true }),
  swing("10 m outside the right edge", { offset: -10, edge: true }),
  swing("weave 5 m past the edges", { weave: 5, edge: true }),
  swing("weave 10 m past the edges", { weave: 10, phase: Math.PI / 2, edge: true }),
];

export type Finding = {
  course: string;
  line: string;
  swing: string;
  kind: "missed" | "wrongWay" | "laps" | "status";
  lap: number;
  /** Where the car was: main-road arc length (m) and lateral offset (m) of its projection, and the world position. */
  s: number;
  lateral: number;
  x: number;
  z: number;
  detail: string;
};

/** One lap of a line as a closed polyline of ~1 m steps from the start line. */
type Cycle = {
  n: number;
  x: Float64Array;
  z: Float64Array;
  tx: Float64Array;
  tz: Float64Array;
  /** Arc length (m) of each point from the first; `length` closes the loop. */
  cum: Float64Array;
  length: number;
  /** Distance (m) from the line to the edge of the road and runoff on each side. */
  edgeL: Float64Array;
  edgeR: Float64Array;
  /** Farthest the car's centre goes to each side: inside the wall, or OUT_MAX past the edge where there is none. */
  capL: Float64Array;
  capR: Float64Array;
  /** Race speed (m/s). */
  v: Float64Array;
  /** Signed curvature (1/m, + turns left). */
  kappa: Float64Array;
};

/** Line ids of a course: its main loop and each shortcut. */
export function lineIds(track: Track): { id: string; cut: number }[] {
  return [{ id: "main", cut: -1 }, ...track.shortcuts.map((sc, k) => ({ id: sc.id, cut: k }))];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The main road with shortcut `cut` taken (`cut` < 0: the main road alone), one lap from the start line. */
function buildCycle(track: Track, cut: number): Cycle {
  const L = track.length;
  const px: number[] = [];
  const pz: number[] = [];
  const edgeL: number[] = [];
  const edgeR: number[] = [];
  const capL: number[] = [];
  const capR: number[] = [];
  const pt = blankPoint();
  const road = track.path;
  const main = (s0: number, s1: number): void => {
    for (let s = s0; s < s1; s += 1) {
      pointOn(road, s, pt);
      px.push(pt.x);
      pz.push(pt.z);
      const k = Math.min(road.count - 1, Math.round((s / L) * road.count)) % road.count;
      const l = road.half[k]! + road.runL[k]!;
      const r = road.half[k]! + road.runR[k]!;
      edgeL.push(l);
      edgeR.push(r);
      capL.push(road.wallL[k] === 1 ? l - CAR_HALF : l + OUT_MAX);
      capR.push(road.wallR[k] === 1 ? r - CAR_HALF : r + OUT_MAX);
    }
  };
  const bridge = (x0: number, z0: number, tx0: number, tz0: number, x1: number, z1: number, tx1: number, tz1: number, edgeEnd: number): void => {
    const c = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(2, Math.ceil(c));
    const last = edgeL.length - 1;
    const e0 = [edgeL[last]!, edgeR[last]!];
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
      const h10 = t ** 3 - 2 * t ** 2 + t;
      const h01 = -2 * t ** 3 + 3 * t ** 2;
      const h11 = t ** 3 - t ** 2;
      px.push(h00 * x0 + h10 * c * tx0 + h01 * x1 + h11 * c * tx1);
      pz.push(h00 * z0 + h10 * c * tz0 + h01 * z1 + h11 * c * tz1);
      // The road's edge blends from one road's to the other's (the mouth is open: no wall).
      edgeL.push(lerp(e0[0]!, edgeEnd, t));
      edgeR.push(lerp(e0[1]!, edgeEnd, t));
      capL.push(edgeL[edgeL.length - 1]! + OUT_MAX);
      capR.push(edgeR[edgeR.length - 1]! + OUT_MAX);
    }
  };
  if (cut < 0) main(0, L);
  else {
    const sc = track.shortcuts[cut]!;
    const a = sc.path;
    const proj = blankProjection();
    track.project(a.x[0]!, a.z[0]!, -1, proj);
    const sm = proj.s;
    track.project(a.x[a.count - 1]!, a.z[a.count - 1]!, -1, proj);
    const se = proj.s;
    // Through the shortcut's from gate first, and onto the main road again before its to gate.
    const turnIn = Math.max(sm - BRIDGE, track.gateS(sc.from) + GATE_CLEAR);
    const turnOut = Math.min(se + BRIDGE, (sc.to === 0 ? L : track.gateS(sc.to)) - GATE_CLEAR);
    if (turnIn >= sm || turnOut <= se) throw new Error(`${track.id} ${sc.id}: no room to drive from the main road to the shortcut and back (mouth ${sm.toFixed(0)}, exit ${se.toFixed(0)})`);
    main(0, turnIn);
    pointOn(road, turnIn, pt);
    bridge(pt.x, pt.z, pt.tx, pt.tz, a.x[0]!, a.z[0]!, a.tx[0]!, a.tz[0]!, a.half[0]!);
    for (let i = 0; i < a.count; i++) {
      px.push(a.x[i]!);
      pz.push(a.z[i]!);
      edgeL.push(a.half[i]!);
      edgeR.push(a.half[i]!);
      capL.push(a.half[i]! + OUT_MAX);
      capR.push(a.half[i]! + OUT_MAX);
    }
    pointOn(road, turnOut, pt);
    const k = Math.min(road.count - 1, Math.round((turnOut / L) * road.count));
    bridge(a.x[a.count - 1]!, a.z[a.count - 1]!, a.tx[a.count - 1]!, a.tz[a.count - 1]!, pt.x, pt.z, pt.tx, pt.tz, road.half[k]! + road.runL[k]!);
    main(turnOut, L);
  }
  const n = px.length;
  const c: Cycle = {
    n,
    x: Float64Array.from(px),
    z: Float64Array.from(pz),
    tx: new Float64Array(n),
    tz: new Float64Array(n),
    cum: new Float64Array(n + 1),
    length: 0,
    edgeL: Float64Array.from(edgeL),
    edgeR: Float64Array.from(edgeR),
    capL: Float64Array.from(capL),
    capR: Float64Array.from(capR),
    v: new Float64Array(n),
    kappa: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) c.cum[i + 1] = c.cum[i]! + Math.hypot(c.x[(i + 1) % n]! - c.x[i]!, c.z[(i + 1) % n]! - c.z[i]!);
  c.length = c.cum[n]!;
  for (let i = 0; i < n; i++) {
    const a = (i + n - 1) % n;
    const b = (i + 1) % n;
    const dx = c.x[b]! - c.x[a]!;
    const dz = c.z[b]! - c.z[a]!;
    const len = Math.hypot(dx, dz) || 1;
    c.tx[i] = dx / len;
    c.tz[i] = dz / len;
  }
  const W = 8;
  for (let i = 0; i < n; i++) {
    const a = (i + n - W) % n;
    const b = (i + W) % n;
    const d = Math.atan2(c.tx[b]!, c.tz[b]!) - Math.atan2(c.tx[a]!, c.tz[a]!);
    c.kappa[i] = Math.atan2(Math.sin(d), Math.cos(d)) / (c.cum[b]! - c.cum[a]! + (b < a ? c.length : 0) || 1);
  }
  // Sideways limits change at most LIMIT_SLOPE per metre: round the loop twice each way so the offset stays continuous.
  const smooth = (lim: Float64Array): void => {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i <= n; i++) {
        const k = i % n;
        const j = (i - 1) % n;
        lim[k] = Math.min(lim[k]!, lim[j]! + LIMIT_SLOPE * (c.cum[i]! - c.cum[i - 1]!));
      }
      for (let i = n; i >= 1; i--) {
        const k = i - 1;
        const j = i % n;
        lim[k] = Math.min(lim[k]!, lim[j]! + LIMIT_SLOPE * (c.cum[i]! - c.cum[i - 1]!));
      }
    }
  };
  smooth(c.capL);
  smooth(c.capR);
  // Speed: what the corner allows, then braking into it and accelerating out of it, round the loop twice.
  for (let i = 0; i < n; i++) c.v[i] = Math.min(V_MAX, Math.max(V_MIN, Math.sqrt(A_LAT / Math.max(Math.abs(c.kappa[i]!), 1e-4))));
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i <= n; i++) {
      const k = i % n;
      const j = (i - 1) % n;
      c.v[k] = Math.min(c.v[k]!, Math.sqrt(c.v[j]! ** 2 + 2 * A_LONG * (c.cum[i]! - c.cum[i - 1]!)));
    }
    for (let i = n; i >= 1; i--) {
      const k = i - 1;
      const j = i % n;
      c.v[k] = Math.min(c.v[k]!, Math.sqrt(c.v[j]! ** 2 + 2 * A_LONG * (c.cum[i]! - c.cum[i - 1]!)));
    }
  }
  return c;
}

/** Corner apexes of the cycle: the arc length of the sharpest point of every stretch turning tighter than `KNOCK_RADIUS`, and the turn's sign. */
function apexes(c: Cycle): { d: number; turn: number }[] {
  const out: { d: number; turn: number }[] = [];
  let best = -1;
  for (let i = 0; i <= c.n; i++) {
    const k = i % c.n;
    const hot = i < c.n && Math.abs(c.kappa[k]!) > 1 / KNOCK_RADIUS;
    if (hot && (best < 0 || Math.abs(c.kappa[k]!) > Math.abs(c.kappa[best]!))) best = k;
    if (!hot && best >= 0) {
      out.push({ d: c.cum[best]!, turn: Math.sign(c.kappa[best]!) });
      best = -1;
    }
  }
  return out;
}

/**
 * Drive `laps` laps of one line of `track` (its main loop, or main + shortcut `cut`) through the real race rules with `how`, at
 * race speed, and list every way the rules disagree with the line: a checkpoint missed (`missed` set: the HUD says so and the lap
 * stays owed), the wrong-way flag up, a lap not completed. A car that follows its line must produce none.
 * `onStep` sees the record after every rules step (a probe for a debugging run).
 */
export function driveLine(track: Track, cut: number, how: Swing, laps = 2, onStep?: (car: CarRecord, pose: CarPose, lat: number) => void): Finding[] {
  const line = cut < 0 ? "main" : track.shortcuts[cut]!.id;
  const cyc = buildCycle(track, cut);
  const corners = how.knock === 0 ? [] : apexes(cyc);
  const session = new RaceSession(track, [{ id: 0, name: "Scripted", kind: "player", aggression: 0 }], { laps, noReset: false });
  const car = session.cars[0]!;
  const pose: CarPose = { x: 0, z: 0, yaw: 0, vx: 0, vz: 0, alive: true };
  const proj = blankProjection();
  const found: Finding[] = [];
  const flagged = new Set<Finding["kind"]>();
  const flag = (kind: Finding["kind"], detail: string): void => {
    if (flagged.has(kind)) return;
    flagged.add(kind);
    track.project(car.x, car.z, -1, proj);
    found.push({ course: track.id, line, swing: how.name, kind, lap: car.lap, s: proj.s, lateral: proj.lateral, x: car.x, z: car.z, detail });
  };

  let d = cyc.length - PRE;
  let i = 0;
  /** The car's pose for distance `dist` along the lap and `want` m left of the line, kept inside the walls and the bend. */
  const place = (dist: number, want: (edgeL: number, edgeR: number) => number): number => {
    const m = dist % cyc.length;
    while (!(cyc.cum[i]! <= m && m < cyc.cum[i + 1]!)) i = (i + 1) % cyc.n;
    const f = (m - cyc.cum[i]!) / (cyc.cum[i + 1]! - cyc.cum[i]! || 1);
    const j = (i + 1) % cyc.n;
    const tx = lerp(cyc.tx[i]!, cyc.tx[j]!, f);
    const tz = lerp(cyc.tz[i]!, cyc.tz[j]!, f);
    const len = Math.hypot(tx, tz) || 1;
    const kappa = lerp(cyc.kappa[i]!, cyc.kappa[j]!, f);
    const room = Math.max(0, 1 / Math.abs(kappa || 1e-9) - TURN_MIN);
    const lat = want(lerp(cyc.edgeL[i]!, cyc.edgeL[j]!, f), lerp(cyc.edgeR[i]!, cyc.edgeR[j]!, f));
    const l = Math.max(-Math.min(lerp(cyc.capR[i]!, cyc.capR[j]!, f), kappa < 0 ? room : Infinity), Math.min(lerp(cyc.capL[i]!, cyc.capL[j]!, f), kappa > 0 ? room : Infinity, lat));
    pose.x = lerp(cyc.x[i]!, cyc.x[j]!, f) + (tz / len) * l;
    pose.z = lerp(cyc.z[i]!, cyc.z[j]!, f) - (tx / len) * l;
    return l;
  };
  place(d, () => 0);
  const park = { x: pose.x, z: pose.z };
  for (let t = 0; session.phase !== "racing" && t < 20 / DT; t++) {
    pose.x = park.x;
    pose.z = park.z;
    session.step(DT, [pose]);
  }
  let px = park.x;
  let pz = park.z;
  const omega = how.weave > 0 ? Math.sqrt(WEAVE_ACCEL / how.weave) : 0;
  const hits: { at: number; amp: number }[] = [];
  const total = cyc.length * (laps + 0.5);
  let travelled = 0;
  let clock = 0;
  while (session.phase === "racing" && travelled < total) {
    const m = d % cyc.length;
    const v = lerp(cyc.v[i]!, cyc.v[(i + 1) % cyc.n]!, (m - cyc.cum[i]!) / (cyc.cum[i + 1]! - cyc.cum[i]! || 1));
    const before = d;
    const was = travelled;
    d += v * DT;
    travelled += v * DT;
    if (how.kickEvery > 0) {
      const k0 = Math.floor((was - how.kickAt) / how.kickEvery);
      const k1 = Math.floor((travelled - how.kickAt) / how.kickEvery);
      if (k1 > k0 && k1 > 0) hits.push({ at: clock + DT, amp: (k1 % 2 === 0 ? -1 : 1) * how.kick });
    }
    clock += DT;
    for (const k of corners) {
      for (let lap = 0; lap <= laps + 1; lap++) {
        const at = k.d + lap * cyc.length;
        if (before < at && at <= d) hits.push({ at: clock, amp: -k.turn * how.knock });
      }
    }
    while (hits.length > 0 && clock - hits[0]!.at > 10 * KNOCK_T) hits.shift();
    const ramp = Math.min(1, travelled / 120);
    const wave = Math.sin(omega * clock + how.phase);
    let bump = 0;
    for (const h of hits) {
      const u = (clock - h.at) / KNOCK_T;
      bump += h.amp * u * Math.exp(1 - u);
    }
    const lat = place(d, (edgeL, edgeR) => {
      const base = how.edge
        ? ramp * (how.offset > 0 ? edgeL + how.offset : how.offset < 0 ? -(edgeR - how.offset) : 0) + (how.weave > 0 ? ramp * wave * ((wave > 0 ? edgeL : edgeR) + how.weave) : 0)
        : ramp * (how.offset + how.weave * wave);
      return base + bump;
    });
    pose.vx = (pose.x - px) / DT;
    pose.vz = (pose.z - pz) / DT;
    pose.yaw = Math.atan2(pose.vx, pose.vz);
    px = pose.x;
    pz = pose.z;
    session.step(DT, [pose]);
    onStep?.(car, pose, lat);
    if (car.missed) flag("missed", `owes gate ${car.next}`);
    if (car.wrongWay) flag("wrongWay", `wrong-way timer ${car.wrongFor.toFixed(2)} s on route ${car.route}`);
    if (car.status !== "racing" && car.status !== "finished") flag("status", car.status);
  }
  flagged.clear();
  if (car.status !== "finished") flag("laps", `${car.lap} of ${laps} laps after ${travelled.toFixed(0)} m`);
  return found;
}
