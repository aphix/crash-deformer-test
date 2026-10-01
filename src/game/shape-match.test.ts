import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  m3,
  m3Id,
  m3Mul,
  m3Det,
  m3Polar,
  m3FrobeniusI,
  m3RotationAngle,
  quatId,
  makeCluster,
  rebuildAqqWeighted,
  matchCluster,
  applyPlasticity,
  transformSkinPointInto,
  matchSkinLocal,
  transformNormal,
  deformBeta,
  goalAlpha,
  stiffnessIters,
  type ShapeParticle,
  type Mat3,
} from "./shape-match.ts";
import { StreamedDeformation } from "./streamed-deform.ts";
import { CAGES, MASS_SPECS, SHAPE_CLUSTERS } from "./rig-spec.ts";

const FRAME = 1 / 60;

interface Rig {
  d: StreamedDeformation;
  group: THREE.Group;
  vel: THREE.Vector3;
  omega: THREE.Vector3;
  geom: THREE.BufferGeometry;
  /** Car-local → world turn of the spawn pose. */
  yaw: number;
}

/** Shape-mode car at the origin turned by `yaw`, crashing along its local `inward` at `speed`. */
function crashRig(impact: THREE.Vector3, inward: THREE.Vector3, speed: number, yaw = 0): Rig {
  const geom = new THREE.BoxGeometry(1.7, 1.3, 4.3, 3, 2, 6);
  const d = new StreamedDeformation(geom);
  d.mode = "shape";
  d.squash = 0.4;
  d.buckle = 0.45;
  const group = new THREE.Group();
  group.rotation.set(0, yaw, 0);
  group.updateMatrixWorld();
  const vel = new THREE.Vector3(0, 0, speed).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
  const omega = new THREE.Vector3();
  d.beginCrush(impact, inward, Math.abs(speed), group, vel, omega);
  return { d, group, vel, omega, geom, yaw };
}

function node(d: StreamedDeformation, name: string): StreamedDeformation["masses"][number] {
  const m = d.masses.find((n) => n.name === name);
  assert.ok(m, name);
  return m;
}

/** One wall frame against the car-local plane normal `nLocal`, contact centred between two masses. */
function wallFrame(r: Rig, dt: number, overlap: number, a = "bumperFL", b = "bumperFR", contactX?: number, nLocal = new THREE.Vector3(0, 0, -1)): void {
  const n = nLocal.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, r.yaw);
  r.d.notifyContact();
  const pa = node(r.d, a).world;
  const pb = node(r.d, b).world;
  const contact = new THREE.Vector3(contactX ?? (pa.x + pb.x) * 0.5, (pa.y + pb.y) * 0.5, (pa.z + pb.z) * 0.5);
  const closing = Math.max(0, -r.vel.dot(n));
  r.d.feedOverlap(contact, n, overlap, closing, dt);
  const leftover = closing * 0.18;
  if (leftover > 0.3) r.d.applyImpulse(n.x, n.y, n.z, leftover * r.d.totalMass * dt * 4);
  r.d.stepStructure(dt);
  r.d.followGroup(r.group, r.vel, r.omega, dt);
  r.d.update(dt, r.geom);
}

/** Left/right partner of a mass name (centre masses map to themselves). */
function mirrorName(name: string): string {
  if (!/^(bumper|wing|hub)[FR][LR]$|^(engine|rail|door)[LR]$/.test(name)) return name;
  return name.slice(0, -1) + (name.endsWith("L") ? "R" : "L");
}

function rotY(rad: number): Mat3 {
  const c = Math.cos(rad),
    s = Math.sin(rad);
  const m = m3();
  m[0] = c;
  m[2] = s;
  m[4] = 1;
  m[6] = -s;
  m[8] = c;
  return m;
}

function particlesAt(pts: [number, number, number][], mass = 1): ShapeParticle[] {
  return pts.map(([x, y, z]) => ({ x, y, z, vx: 0, vy: 0, vz: 0, mass }));
}

describe("polar decomposition", () => {
  it("good: a pure rotation returns R ≈ that rotation and S ≈ I", () => {
    const A = rotY(0.7);
    const R = m3();
    const S = m3();
    m3Polar(A, quatId(), R, S);
    assert.ok(Math.abs(R[0]! - A[0]!) < 1e-5);
    assert.ok(m3FrobeniusI(S) < 1e-4);
    assert.ok(Math.abs(m3Det(R) - 1) < 1e-4);
  });

  it("good: stretch then rotate recovers the stretch magnitudes", () => {
    const S0 = m3Id();
    S0[0] = 0.5;
    S0[8] = 1.4;
    const A = m3();
    m3Mul(rotY(0.4), S0, A);
    const R = m3();
    const S = m3();
    m3Polar(A, quatId(), R, S);
    assert.ok(Math.abs(S[0]! - 0.5) < 0.04, `Sxx ${S[0]}`);
    assert.ok(Math.abs(S[8]! - 1.4) < 0.04, `Szz ${S[8]}`);
  });

  it("close-but-wrong: det(R) is +1, not a reflection", () => {
    const A = m3Id();
    A[0] = -1;
    const R = m3();
    const S = m3();
    m3Polar(A, quatId(), R, S);
    assert.ok(m3Det(R) > 0.5, `det(R)=${m3Det(R)}`);
  });

  it("bad: a 180° yaw is clamped, not applied as an inside-out mesh", () => {
    const A = rotY(Math.PI);
    const R = m3();
    const S = m3();
    m3Polar(A, quatId(), R, S);
    assert.ok(m3RotationAngle(R) < 1.0, `R still flipped ${m3RotationAngle(R)}`);
    assert.ok(m3Det(R) > 0.5);
  });

  it("bad: a huge/NaN A must not emit a light-speed R or S", () => {
    const A = m3Id();
    A[0] = 1e8;
    A[8] = -4e7;
    const R = m3();
    const S = m3();
    m3Polar(A, quatId(), R, S);
    for (let i = 0; i < 9; i++) {
      assert.ok(Number.isFinite(R[i]!) && Math.abs(R[i]!) < 5, `R[${i}]=${R[i]}`);
      assert.ok(Number.isFinite(S[i]!) && Math.abs(S[i]!) < 5, `S[${i}]=${S[i]}`);
    }
    A[0] = Number.NaN;
    m3Polar(A, quatId(), R, S);
    assert.equal(R[0], 1);
    assert.equal(S[0], 1);
  });

  it("good: a stale warm start (0.5 rad off about another axis) still lands on the polar rotation", () => {
    const S0 = m3Id();
    S0[0] = 0.7;
    S0[4] = 1.2;
    S0[8] = 0.9;
    const A = m3();
    m3Mul(rotY(0.6), S0, A);
    const q = quatId();
    q[0] = Math.sin(0.25);
    q[3] = Math.cos(0.25);
    const R = m3();
    const S = m3();
    m3Polar(A, q, R, S);
    const Rt = rotY(0.6);
    for (let i = 0; i < 9; i++) assert.ok(Math.abs(R[i]! - Rt[i]!) < 1e-6, `R[${i}]=${R[i]} vs ${Rt[i]}`);
    for (let i = 0; i < 9; i++) assert.ok(Math.abs(S[i]! - S0[i]!) < 1e-6, `S[${i}]=${S[i]} vs ${S0[i]}`);
  });

  it("bad: an over-limit turn is clamped on output, but the warm start keeps the real turn", () => {
    const q = quatId();
    const R = m3();
    const S = m3();
    m3Polar(rotY(1.2), q, R, S);
    const ang = m3RotationAngle(R);
    assert.ok(ang > 0.8 && ang < 0.9, `clamped angle ${ang}`);
    assert.ok(R[2]! > 0 && Math.abs(R[1]!) < 1e-9 && Math.abs(R[5]!) < 1e-9, "clamp left the yaw axis or reversed it");
    const qAng = 2 * Math.acos(Math.min(1, Math.abs(q[3]!)));
    assert.ok(Math.abs(qAng - 1.2) < 1e-6, `warm start stored the clamped turn ${qAng}`);
  });

  it("bad: a collapsed (zero) A holds the warm rotation instead of snapping or going NaN", () => {
    const q = quatId();
    q[1] = Math.sin(0.25);
    q[3] = Math.cos(0.25);
    const R = m3();
    const S = m3();
    m3Polar(m3(), q, R, S);
    for (let i = 0; i < 9; i++) assert.ok(Number.isFinite(R[i]!) && Number.isFinite(S[i]!), `R/S[${i}] not finite`);
    assert.ok(Math.abs(m3RotationAngle(R) - 0.5) < 1e-9, `rotation snapped to ${m3RotationAngle(R)}`);
  });
});

describe("shape matching goals", () => {
  it("good: a rigid translate+rotate of all particles has near-zero goal error", () => {
    const rest: [number, number, number][] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    const P = particlesAt(rest);
    const c = makeCluster(P, [0, 1, 2, 3]);
    rebuildAqqWeighted(c, P);
    const yaw = 0.5;
    const [cs, sn] = [Math.cos(yaw), Math.sin(yaw)];
    for (const p of P) {
      const x = p.x * cs + p.z * sn + 3;
      const z = -p.x * sn + p.z * cs - 2;
      p.x = x;
      p.y += 1;
      p.z = z;
    }
    matchCluster(c, P, 0);
    let err = 0;
    for (let i = 0; i < 4; i++) {
      const [gx, gy, gz] = [
        c.R[0]! * c.qx[i]! + c.R[1]! * c.qy[i]! + c.R[2]! * c.qz[i]! + c.cmx,
        c.R[3]! * c.qx[i]! + c.R[4]! * c.qy[i]! + c.R[5]! * c.qz[i]! + c.cmy,
        c.R[6]! * c.qx[i]! + c.R[7]! * c.qy[i]! + c.R[8]! * c.qz[i]! + c.cmz,
      ];
      err += Math.hypot(gx - P[i]!.x, gy - P[i]!.y, gz - P[i]!.z);
    }
    assert.ok(err < 0.05, `rigid match error ${err}`);
  });

  it("good: a Z squash produces S_zz < 1", () => {
    const rest: [number, number, number][] = [
      [1, 0, 1],
      [-1, 0, 1],
      [1, 0, -1],
      [-1, 0, -1],
      [0, 1, 0],
    ];
    const P = particlesAt(rest);
    const c = makeCluster(P, [0, 1, 2, 3, 4]);
    rebuildAqqWeighted(c, P);
    for (const p of P) p.z *= 0.4;
    matchCluster(c, P, 1);
    assert.ok(c.S[8]! < 0.7, `expected squash, Szz=${c.S[8]}`);
  });

  it("bad: beta=0 is rigid (S ignored), beta=1 keeps the squash", () => {
    assert.ok(deformBeta(0.2) < deformBeta(0.9));
    assert.ok(goalAlpha(0.2) > goalAlpha(0.9));
    assert.ok(stiffnessIters(0.2) >= stiffnessIters(0.9));
  });
});

describe("plasticity", () => {
  it("good: a held squash yields so rest q shortens and does not fully spring back", () => {
    const rest: [number, number, number][] = [
      [1, 0, 1],
      [-1, 0, 1],
      [1, 0, -1],
      [-1, 0, -1],
      [0, 1, 0],
      [0, -1, 0],
    ];
    const P = particlesAt(rest);
    const c = makeCluster(P, P.map((_, i) => i));
    rebuildAqqWeighted(c, P);
    for (const p of P) p.z *= 0.35;
    for (let i = 0; i < 12; i++) {
      matchCluster(c, P, 0.9);
      applyPlasticity(c, P, 1 / 30, 0.8, true);
    }
    assert.ok(m3FrobeniusI(c.Sp) > 0.08, `Sp never yielded ${m3FrobeniusI(c.Sp)}`);
    const qz = Math.hypot(c.qx[0]!, c.qy[0]!, c.qz[0]!);
    const q0 = Math.hypot(c.q0x[0]!, c.q0y[0]!, c.q0z[0]!);
    assert.ok(qz < q0 * 0.95 || m3FrobeniusI(c.Sp) > 0.15, "plastic rest did not shorten");
  });

  it("close-but-wrong: det(Sp) stays near 1 (volume not deleted)", () => {
    const rest: [number, number, number][] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    const P = particlesAt(rest);
    const c = makeCluster(P, P.map((_, i) => i));
    rebuildAqqWeighted(c, P);
    for (const p of P) p.z *= 0.3;
    for (let i = 0; i < 8; i++) {
      matchCluster(c, P, 1);
      applyPlasticity(c, P, 1 / 30, 0.7, true);
    }
    const det = m3Det(c.Sp);
    assert.ok(det > 0.25 && det < 2.8, `volume vanished det=${det}`);
  });
});

describe("normals", () => {
  it("good: n_new = (T^{-1})^T n_old for a z squash of the skin fit", () => {
    const rest = [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ];
    const P = particlesAt(rest.map((p) => [p.x, p.y, p.z] as [number, number, number]));
    const c = makeCluster(P, P.map((_, i) => i));
    const local = rest.map((p) => ({ x: p.x, y: p.y, z: p.z * 0.5 }));
    matchSkinLocal(
      c,
      rest,
      local,
      rest.map(() => 1),
      1,
    );
    const n = transformNormal(c, 0, 0, 1);
    assert.ok(Math.abs(n.x) < 0.2 && Math.abs(n.y) < 0.2, `n xy ${n.x},${n.y}`);
    assert.ok(n.z > 1.5, `n_z ${n.z} (a 0.5 squash scales the normal by 2)`);
  });
});

describe("local cell skin (Bugbear pipeline)", () => {
  it("good: identity when local equals rest", () => {
    const rest = [
      { x: 1, y: 0, z: 0 },
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 0, y: 0, z: -1 },
    ];
    const P = particlesAt(rest.map((p) => [p.x, p.y, p.z] as [number, number, number]));
    const c = makeCluster(P, P.map((_, i) => i));
    matchSkinLocal(
      c,
      rest,
      rest,
      rest.map(() => 1),
      0.8,
    );
    const p = transformSkinPointInto(c, 0.4, 0.2, 0.3);
    assert.ok(Math.hypot(p.x - 0.4, p.y - 0.2, p.z - 0.3) < 0.04, `identity drifted to ${p.x},${p.y},${p.z}`);
  });

  it("good: a z-squash of the particles shortens a rest vertex in z", () => {
    const rest = [
      { x: 1, y: 0, z: 1 },
      { x: -1, y: 0, z: 1 },
      { x: 1, y: 0, z: -1 },
      { x: -1, y: 0, z: -1 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: -1, z: 0 },
    ];
    const local = rest.map((p) => ({ x: p.x, y: p.y, z: p.z * 0.6 }));
    const P = particlesAt(rest.map((p) => [p.x, p.y, p.z] as [number, number, number]));
    const c = makeCluster(P, P.map((_, i) => i));
    matchSkinLocal(
      c,
      rest,
      local,
      rest.map(() => 1),
      1,
    );
    const { z } = transformSkinPointInto(c, 0, 0, 1);
    assert.ok(z < 0.85, `skin did not squash z=${z}`);
    assert.ok(z > 0.4, `skin collapsed z=${z}`);
  });

  it("bad: skin polar must not overwrite match R / Rprev (slomo two-state flicker)", () => {
    const rest = [
      [1, 0, 1],
      [-1, 0, 1],
      [1, 0, -1],
      [-1, 0, -1],
      [0, 1, 0],
      [0, -1, 0],
    ] as [number, number, number][];
    const P = particlesAt(rest);
    const c = makeCluster(P, P.map((_, i) => i));
    for (const p of P) p.z *= 0.7;
    matchCluster(c, P, 0.25);
    const r0 = Array.from(c.R);
    const rp0 = Array.from(c.Rprev);
    const local = rest.map(([x, y, z]) => ({ x, y, z: z * 0.55 }));
    matchSkinLocal(
      c,
      rest.map(([x, y, z]) => ({ x, y, z })),
      local,
      rest.map(() => 1),
      0.3,
    );
    for (let i = 0; i < 9; i++) {
      assert.equal(c.R[i], r0[i], `R[${i}] poisoned by skin polar`);
      assert.equal(c.Rprev[i], rp0[i], `Rprev[${i}] poisoned by skin polar`);
    }
  });
});

describe("StreamedDeformation shape mode", () => {
  it("good: default mode is shape matching", () => {
    const d = new StreamedDeformation(new THREE.BoxGeometry(1.7, 1.3, 4.3, 2, 2, 4));
    assert.equal(d.mode, "shape");
  });

  it("good: a frontal pulse still shortens the nose under shape matching", () => {
    const geom = new THREE.BoxGeometry(1.7, 1.3, 4.3, 3, 2, 6);
    const d = new StreamedDeformation(geom);
    d.mode = "shape";
    d.squash = 0.5;
    const group = new THREE.Group();
    group.updateMatrixWorld();
    const vel = new THREE.Vector3(0, 0, 16);
    d.beginCrush(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 16, 16, group, vel, new THREE.Vector3());
    const fl = d.masses.find((m) => m.name === "bumperFL")!;
    const z0 = fl.local.z;
    for (let i = 0; i < 24; i++) {
      d.notifyContact();
      d.feedOverlap(fl.world, new THREE.Vector3(0, 0, -1), 0.1, 16, 1 / 60);
      d.stepStructure(1 / 60);
      d.followGroup(group, vel, new THREE.Vector3(), 1 / 60);
      d.update(1 / 60, geom);
    }
    assert.ok(z0 - fl.local.z > 0.05, `shape mode did not crush ${z0} → ${fl.local.z}`);
    d.update(1 / 60, geom);
    const attr = geom.getAttribute("position") as THREE.BufferAttribute;
    let max = 0;
    let maxZ = -Infinity;
    for (let i = 0; i < attr.count; i++) {
      max = Math.max(max, Math.hypot(attr.getX(i), attr.getY(i), attr.getZ(i)));
      maxZ = Math.max(maxZ, attr.getZ(i));
    }
    assert.ok(max < 4.2, `shape skin exploded, vertex radius ${max}`);
    assert.ok(Math.abs(maxZ - fl.local.z) < 0.55, `mesh nose ${maxZ.toFixed(3)} drifted from particle ${fl.local.z.toFixed(3)}`);
  });

  it("good: lattice mode still exists as a toggle", () => {
    const d = new StreamedDeformation(new THREE.BoxGeometry(1.7, 1.3, 4.3, 2, 2, 4));
    d.setMode("lattice");
    assert.equal(d.mode, "lattice");
  });

  it("good: every mass belongs to at least one overlapping cluster", () => {
    const d = new StreamedDeformation(new THREE.BoxGeometry(1.7, 1.3, 4.3, 2, 2, 4));
    const snap = d.snapshot() as { clusters: { names: string[] }[] };
    const seen = new Set<string>();
    for (const c of snap.clusters) for (const n of c.names) seen.add(n);
    for (const m of d.masses) {
      if (m.name.startsWith("hub")) continue;
      assert.ok(seen.has(m.name), `${m.name} is in no cluster`);
    }
    assert.ok(snap.clusters.length >= 8, `too few clusters ${snap.clusters.length}`);
  });

  it("good: the cluster table is mirror-symmetric, duplicate-free and owned by real cages", () => {
    const key = (names: readonly string[]) => [...names].sort().join(",");
    const sets = SHAPE_CLUSTERS.map((c) => key(c.masses));
    assert.equal(new Set(sets).size, sets.length, "two clusters share a mass set");
    for (const c of SHAPE_CLUSTERS) {
      assert.ok(sets.includes(key(c.masses.map(mirrorName))), `${c.owner} [${c.masses.join(" ")}] has no mirror`);
      assert.ok(CAGES.some((g) => g.name === c.owner), `${c.owner} is not a cage`);
    }
  });

  it("good: mirrored ±0.62 m corner hits crush mirror-symmetrically", () => {
    const run = (x: number) => {
      const r = crashRig(new THREE.Vector3(x, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 14);
      const corner = x > 0 ? "bumperFR" : "bumperFL";
      for (let i = 0; i < 24; i++) wallFrame(r, FRAME, 0.12, undefined, undefined, node(r.d, corner).world.x);
      return r.d;
    };
    const left = run(-0.62);
    const right = run(0.62);
    let sum = 0;
    for (const m of left.masses) {
      const o = node(right, mirrorName(m.name)).local;
      sum += Math.hypot(m.local.x + o.x, m.local.y - o.y, m.local.z - o.z);
    }
    assert.ok(sum < 0.02, `left/right mirror error ${sum.toFixed(3)} m`);
  });

  it("good: every rig cluster recovers a rigid 0.3 rad turn about each axis", () => {
    const rest = MASS_SPECS.map((m) => ({ x: m.rest[0], y: m.rest[1], z: m.rest[2], vx: 0, vy: 0, vz: 0, mass: m.mass }));
    const index = new Map(MASS_SPECS.map((m, i) => [m.name, i]));
    for (const axis of [new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1)]) {
      const turn = new THREE.Quaternion().setFromAxisAngle(axis, 0.3);
      const moved = rest.map((p) => {
        const v = new THREE.Vector3(p.x, p.y, p.z).applyQuaternion(turn);
        return { ...p, x: v.x, y: v.y, z: v.z };
      });
      const e = new THREE.Matrix4().makeRotationFromQuaternion(turn).elements;
      for (const spec of SHAPE_CLUSTERS) {
        const c = makeCluster(rest, spec.masses.map((n) => index.get(n)!));
        matchCluster(c, moved, 0);
        // E = Rᵀ·R_true; R is row-major, three.js elements are column-major.
        const E = m3();
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) E[i * 3 + j] = c.R[i]! * e[j * 4]! + c.R[3 + i]! * e[j * 4 + 1]! + c.R[6 + i]! * e[j * 4 + 2]!;
        const err = m3RotationAngle(E);
        assert.ok(err < 0.02, `${spec.owner} [${spec.masses.join(" ")}] turn error ${err.toFixed(3)} rad about ${axis.toArray()}`);
      }
    }
  });

  it("good: the same local frontal crush is heading-independent", () => {
    const noseZ = (yaw: number) => {
      const r = crashRig(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 16, yaw);
      r.d.squash = 0.5;
      const fl = node(r.d, "bumperFL");
      const n = new THREE.Vector3(0, 0, -1).applyAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      for (let i = 0; i < 24; i++) {
        r.d.notifyContact();
        r.d.feedOverlap(fl.world, n, 0.1, 16, FRAME);
        r.d.stepStructure(FRAME);
        r.d.followGroup(r.group, r.vel, r.omega, FRAME);
        r.d.update(FRAME, r.geom);
      }
      return fl.local.z;
    };
    const z = [0, Math.PI / 2, Math.PI, -Math.PI / 2].map(noseZ);
    assert.ok(Math.max(...z) - Math.min(...z) < 0.03, `bumperFL local z by heading ${z.map((v) => v.toFixed(3)).join(" / ")}`);
  });

  it("good: a rigidly turned undamaged car is a fixed point of the structure step", () => {
    const settle = (yaw: number) => {
      const r = crashRig(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 0);
      const c = node(r.d, "cell").world.clone();
      const turn = new THREE.Quaternion().setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      for (const m of r.d.masses) m.world.sub(c).applyQuaternion(turn).add(c);
      for (let i = 0; i < 10; i++) {
        r.d.notifyContact();
        r.d.stepStructure(FRAME);
        r.d.followGroup(r.group, r.vel, r.omega, FRAME);
      }
      return r.d.masses.flatMap((a, i) => r.d.masses.slice(i + 1).map((b) => a.world.distanceTo(b.world)));
    };
    const still = settle(0);
    const turned = settle(0.3);
    const worst = Math.max(...still.map((v, i) => Math.abs(v - turned[i]!)));
    assert.ok(worst < 0.01, `a 0.3 rad heading distorts the body by ${worst.toFixed(3)} m`);
  });
});
