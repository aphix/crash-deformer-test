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
  makeCluster,
  rebuildAqqWeighted,
  matchCluster,
  applyPlasticity,
  transformPoint,
  transformSkinPoint,
  matchSkinLocal,
  transformNormal,
  deformBeta,
  goalAlpha,
  stiffnessIters,
  type ShapeParticle,
  type Mat3,
} from "./shape-match.ts";
import { StreamedDeformation } from "./streamed-deform.ts";

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
    m3Polar(A, R, S);
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
    m3Polar(A, R, S);
    assert.ok(Math.abs(S[0]! - 0.5) < 0.04, `Sxx ${S[0]}`);
    assert.ok(Math.abs(S[8]! - 1.4) < 0.04, `Szz ${S[8]}`);
  });

  it("close-but-wrong: det(R) is +1, not a reflection", () => {
    const A = m3Id();
    A[0] = -1;
    const R = m3();
    const S = m3();
    m3Polar(A, R, S);
    assert.ok(m3Det(R) > 0.5, `det(R)=${m3Det(R)}`);
  });

  it("bad: a 180° yaw is clamped, not applied as an inside-out mesh", () => {
    const A = rotY(Math.PI);
    const R = m3();
    const S = m3();
    m3Polar(A, R, S);
    assert.ok(m3RotationAngle(R) < 1.0, `R still flipped ${m3RotationAngle(R)}`);
    assert.ok(m3Det(R) > 0.5);
  });

  it("bad: a huge/NaN A must not emit a light-speed R or S", () => {
    const A = m3Id();
    A[0] = 1e8;
    A[8] = -4e7;
    const R = m3();
    const S = m3();
    m3Polar(A, R, S);
    for (let i = 0; i < 9; i++) {
      assert.ok(Number.isFinite(R[i]!) && Math.abs(R[i]!) < 5, `R[${i}]=${R[i]}`);
      assert.ok(Number.isFinite(S[i]!) && Math.abs(S[i]!) < 5, `S[${i}]=${S[i]}`);
    }
    A[0] = Number.NaN;
    m3Polar(A, R, S);
    assert.equal(R[0], 1);
    assert.equal(S[0], 1);
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
  it("good: n_new = (T^{-1})^T n_old for a uniform scale", () => {
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
    for (const p of P) p.z *= 0.5;
    matchCluster(c, P, 1);
    const [nx, ny, nz] = transformNormal(c, 0, 0, 1);
    assert.ok(Math.abs(nx) < 0.2 && Math.abs(ny) < 0.2, `n xy ${nx},${ny}`);
    assert.ok(nz > 0.5, `n_z ${nz}`);
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
    const [x, y, z] = transformSkinPoint(c, 0.4, 0.2, 0.3);
    assert.ok(Math.hypot(x - 0.4, y - 0.2, z - 0.3) < 0.04, `identity drifted to ${x},${y},${z}`);
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
    const [, , z] = transformSkinPoint(c, 0, 0, 1);
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
    d.beginCrush(new THREE.Vector3(0, 0.36, 2.06), new THREE.Vector3(0, 0, -1), 16, group, vel, new THREE.Vector3());
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
});
