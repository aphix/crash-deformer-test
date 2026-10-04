import * as THREE from "three";
import { computeNormalsFast } from "./fast-normals.ts";
import { matchSkinLocal, type ShapeCluster } from "./shape-match.ts";
import { DeformSolve } from "./deform-solve.ts";
import { RES_SLOTS, SIM_SCALAR_NUMBERS, SKIN_K, type Beam, type MassNode, type Sensor } from "./deform-rig.ts";
import { INF_K } from "./deform-build.ts";
import { cageAxis, cageCoeffs } from "./deform-state.ts";
import { skinKernel, skinKey, type SkinDynamic, type SkinKernel, type SkinStatic, type SkinTables } from "./skin-kernel.ts";

const _a = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _e = new THREE.Vector3();
const _f = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _axis = new THREE.Vector3();
/**
 * Strain share (β) of the cluster map a skin point's offset from its parent masses takes; the
 * rotation is taken whole. At 1 the strain between the particles extrapolates past them: paint
 * 0.1 m outboard of a pushed door went 8% deeper than the door (piston `right`), at 0.65 within 1%.
 */
const SKIN_STRAIN = 0.65;
/** The roof mass sunk past this (m) is load crush: a crash alone holds it within `maxLift` (0.07 m, deep 0.28), so the skin's 0.1 m roof clamp lifts. */
const SUNK_ROOF = 0.075;

/** `simState`: `v` into `buf` at `o`, or with `write` from it; returns the next offset. */
function simVec(buf: Float64Array, o: number, v: THREE.Vector3, write: boolean): number {
  if (write) v.set(buf[o]!, buf[o + 1]!, buf[o + 2]!);
  else {
    buf[o] = v.x;
    buf[o + 1] = v.y;
    buf[o + 2] = v.z;
  }
  return o + 3;
}
/** `simState`: a sensor's compression. */
function simSensor(buf: Float64Array, o: number, s: Sensor, write: boolean): number {
  if (write) s.compression = buf[o]!;
  else buf[o] = s.compression;
  return o + 1;
}
/** `simState`: `a` into `buf` at `o` (a native copy: no double boxed even before V8 optimizes), or with `write` from it. */
function simArray(buf: Float64Array, o: number, a: Float64Array, write: boolean): number {
  if (!write) buf.set(a, o);
  else for (let i = 0; i < a.length; i++) a[i] = buf[o + i]!;
  return o + a.length;
}
// One helper per element: called many times per `simState`, they run optimized long before `simState` itself does.
/** `simState`: a mass's world, local, velocity, crush offsets and flags; returns the next offset. */
function simMass(buf: Float64Array, o: number, m: MassNode, write: boolean): number {
  o = simVec(buf, simVec(buf, simVec(buf, o, m.world, write), m.local, write), m.vel, write);
  if (write) {
    m.shoveX = buf[o]!;
    m.shoveZ = buf[o + 1]!;
    m.crushSet = buf[o + 2]!;
    m.baseX = buf[o + 3]!;
    m.baseZ = buf[o + 4]!;
    m.dynamic = buf[o + 5] !== 0;
    m.clipping = buf[o + 6] !== 0;
    m.popped = buf[o + 7] !== 0;
  } else {
    buf[o] = m.shoveX;
    buf[o + 1] = m.shoveZ;
    buf[o + 2] = m.crushSet;
    buf[o + 3] = m.baseX;
    buf[o + 4] = m.baseZ;
    buf[o + 5] = m.dynamic ? 1 : 0;
    buf[o + 6] = m.clipping ? 1 : 0;
    buf[o + 7] = m.popped ? 1 : 0;
  }
  return o + 8;
}
/** `simState`: a beam's rest, set, floor and life; returns the next offset. */
function simBeam(buf: Float64Array, o: number, b: Beam, write: boolean): number {
  if (write) {
    b.rest = buf[o]!;
    b.plastic = buf[o + 1]!;
    b.minLen = buf[o + 2]!;
    b.alive = buf[o + 3] !== 0;
  } else {
    buf[o] = b.rest;
    buf[o + 1] = b.plastic;
    buf[o + 2] = b.minLen;
    buf[o + 3] = b.alive ? 1 : 0;
  }
  return o + 4;
}
/** `simState`: q ← Sp·q0, the rest points a cluster's fit reads (`applyPlasticity` keeps them so whenever it moves Sp). */
function plasticRestPoints(c: ShapeCluster): void {
  const s = c.Sp;
  for (let i = 0; i < c.q0x.length; i++) {
    const x = c.q0x[i]!;
    const y = c.q0y[i]!;
    const z = c.q0z[i]!;
    c.qx[i] = s[0]! * x + s[1]! * y + s[2]! * z;
    c.qy[i] = s[3]! * x + s[4]! * y + s[5]! * z;
    c.qz[i] = s[6]! * x + s[7]! * y + s[8]! * z;
  }
}
/**
 * `simState`: a shape cluster's plastic rest (q0, cm0, AqqInv, plane normal, `planar`, Sp) and the fit's carried state:
 * the last rotation `Rprev` that `stabilizeMat` blends the next one with and the warm start `rotQ` (the rest points the
 * fit reads, Sp·q0, are rebuilt from Sp). Without those a restored wreck's first fit ran against the identity and a
 * respawn's rest: 16 of a monster wreck's 20 masses sat 5-200 mm off the live ones one step later. Returns the next offset.
 */
function simCluster(buf: Float64Array, o: number, c: ShapeCluster, write: boolean): number {
  o = simArray(buf, simArray(buf, simArray(buf, o, c.q0x, write), c.q0y, write), c.q0z, write);
  if (write) {
    c.cm0x = buf[o]!;
    c.cm0y = buf[o + 1]!;
    c.cm0z = buf[o + 2]!;
    c.planar = buf[o + 3] !== 0;
  } else {
    buf[o] = c.cm0x;
    buf[o + 1] = c.cm0y;
    buf[o + 2] = c.cm0z;
    buf[o + 3] = c.planar ? 1 : 0;
  }
  o = simArray(buf, simArray(buf, simArray(buf, o + 4, c.AqqInv, write), c.n, write), c.Sp, write);
  o = simArray(buf, simArray(buf, o, c.Rprev, write), c.rotQ, write);
  if (write) plasticRestPoints(c);
  return o;
}

/** Netplay state of one car's deformation (docs/MULTIPLAYER.md), preallocated from `netSizes()`. */
export interface DeformNetState {
  /** masses × 3: each control particle's current body-frame position (the hulls read these). */
  readonly local: Float32Array;
  /** masses × 3: the particles as of the last skin bake (`massPos`). */
  readonly skinPos: Float32Array;
  /** clusters × 9: each shape cluster's skin map `skinM` at the last bake, row-major. */
  readonly skinXf: Float32Array;
  /** sensors: compression (m). */
  readonly sensor: Float32Array;
  /** 9: impactLocal xyz, impactInward xyz, wrinkle amplitude (ramp applied), buckle, squash. */
  readonly impact: Float32Array;
  /** Bit i: masses[i] popped now (hubs are 16–19); wheels follow these. */
  popped: number;
  /** Bit i: masses[i] popped at the last bake; the skin's wheel arches follow these. */
  skinPopped: number;
  /** 1 massActive, 2 drivetrainAlive (now); 4 deepCrush, 8 bidirectional, 16 lattice mode (at the last bake). */
  flags: number;
  /** Rearward engine-block travel (m) and the travel that kills it (class × realism): `drivetrainHealth`. */
  engineTravel: number;
  killTravel: number;
}

export class StreamedDeformation extends DeformSolve {

  protected pullSensorsFromMasses(dt: number): void {
    const inward = this.impactInward;
    const cap = Math.max(0.022, dt * 24);
    for (let si = 0; si < this.sensors.length; si++) {
      const s = this.sensors[si]!;
      const far = s.rest.x * inward.x + s.rest.z * inward.z;
      if (!this.bidirectional && far > 0.18) continue;
      const doorOnly = s.spec.part === "doorLeft" || s.spec.part === "doorRight";
      let best = 0;
      for (let mi = 0; mi < this.masses.length; mi++) {
        const m = this.masses[mi]!;
        if (doorOnly && m.name !== "doorL" && m.name !== "doorR") continue;
        const d = s.rest.distanceTo(m.rest);
        const reach = s.spec.radius * 2.2 + 0.22;
        if (d > reach) continue;
        const fall = (1 - d / reach) ** 2;
        _a.copy(m.local).sub(m.rest);
        const along = Math.max(0, -_a.dot(inward));
        const mag = _a.length();
        const strain = (along * 1.6 + mag * 0.7) / 0.2;
        const lat = Math.abs(s.rest.x - this.impactLocal.x);
        const hitSide = Math.sign(this.impactLocal.x);
        const sensorSide = Math.sign(s.rest.x);
        const opposite = hitSide !== 0 && sensorSide !== 0 && hitSide !== sensorSide;
        best = Math.max(best, strain * fall * Math.exp(-lat * (opposite ? 3.8 : 2.4)) * (opposite ? 0.15 : 1));
      }
      const next = THREE.MathUtils.clamp(best, 0, s.spec.maxCompression);
      if (next > s.compression) s.compression = Math.min(next, s.compression + cap);
      s.pos.copy(s.rest);
      let wsum = 0;
      _d.set(0, 0, 0);
      for (let mi = 0; mi < this.masses.length; mi++) {
        const m = this.masses[mi]!;
        const dist = s.rest.distanceTo(m.rest);
        if (dist > s.spec.radius * 2.4 + 0.3) continue;
        const w = Math.exp(-dist * 1.35);
        _e.copy(m.local).sub(m.rest);
        _d.addScaledVector(_e, w);
        wsum += w;
      }
      if (wsum > 1e-6) s.pos.addScaledVector(_d, 1 / wsum);
    }
  }

  /**
   * Skin (A5) = a skin point's parent masses where they are now, plus the blend of its clusters'
   * least-squares maps of rest onto the current local particles (SKIN_STRAIN of the strain,
   * plastic Sp composed in) on its short offset from those parents. The paint rides the
   * particles, so a dent is as deep as they went; the clusters add the region's rotation and
   * strain. The masses' positions are captured here, so a deferred skin flushes this solve's pose
   * (lattice mode captures only the positions: netplay re-solves its cages from them).
   */
  protected bakeLocalSkin(): void {
    if (this.mode === "shape") for (const c of this.clusters) matchSkinLocal(c, this.skinRest, this.skinLocal, this.skinMassN, SKIN_STRAIN);
    const pos = this.massPos;
    for (let j = 0, r = 0; j < this.masses.length; j++, r += 3) {
      const p = this.masses[j]!.local;
      pos[r] = p.x;
      pos[r + 1] = p.y;
      pos[r + 2] = p.z;
    }
    for (let c = 0; c < this.clusters.length; c++) this.netSkinXf.set(this.clusters[c]!.skinM, c * 9);
    const im = this.netImpact;
    this.impactLocal.toArray(im, 0);
    this.impactInward.toArray(im, 3);
    im[6] = this.wrinkleAmp * Math.min(1, this.elapsed * 6);
    im[7] = this.buckle;
    im[8] = this.squash;
    let popped = 0;
    for (let i = 0; i < this.masses.length; i++) if (this.masses[i]!.popped) popped |= 1 << i;
    this.netPopped = popped;
    this.netFlags = (this.deepCrush ? 4 : 0) | (this.bidirectional ? 8 : 0) | (this.mode === "lattice" ? 16 : 0);
  }

  /** `clusterXf` ← each cluster's skin map M (row-major 9). */
  private refreshClusterXf(): void {
    const X = this.clusterXf;
    for (let ci = 0, o = 0; ci < this.clusters.length; ci++, o += 9) X.set(this.clusters[ci]!.skinM, o);
  }

  private solveCagesFromShape(): void {
    this.refreshClusterXf();
    const X = this.clusterXf;
    const n = this.vertexCount;
    const pos = this.massPos;
    for (let j = 0; j < this.cages.length * 8; j++) {
      const cage = this.cages[j >> 3]!;
      const rest = cage.restCorners[j & 7]!;
      const wsum = this.cornerWsum[j]!;
      // A5, as a skin vertex: parents' positions + the cluster maps on the offset from them.
      const dx = rest.x - this.resC[(n + j) * 3]!;
      const dy = rest.y - this.resC[(n + j) * 3 + 1]!;
      const dz = rest.z - this.resC[(n + j) * 3 + 2]!;
      let px = dx,
        py = dy,
        pz = dz;
      if (wsum > 1e-6) {
        px = py = pz = 0;
        for (let k = this.cornerStart[j]!, e = this.cornerStart[j + 1]!; k < e; k++) {
          const o = this.cornerXf[k]!;
          const w = this.cornerW[k]! / wsum;
          px += (X[o]! * dx + X[o + 1]! * dy + X[o + 2]! * dz) * w;
          py += (X[o + 3]! * dx + X[o + 4]! * dy + X[o + 5]! * dz) * w;
          pz += (X[o + 6]! * dx + X[o + 7]! * dy + X[o + 8]! * dz) * w;
        }
      }
      for (let k = (n + j) * RES_SLOTS, e = k + RES_SLOTS; k < e; k++) {
        const m = this.resJ[k]!;
        const w = this.resW[k]!;
        px += pos[m]! * w;
        py += pos[m + 1]! * w;
        pz += pos[m + 2]! * w;
      }
      cage.corners[j & 7]!.set(px, py, pz);
    }
    this.capCageCorners();
    if (this.bidirectional) this.fitCagesToMasses();
  }

  protected solveCages(): void {
    if (this.mode === "shape") {
      this.solveCagesFromShape();
      return;
    }
    const inward = this.impactInward;
    const ramp = THREE.MathUtils.clamp(this.elapsed / 0.08, 0.45, 1);

    for (const cage of this.cages) {
      for (let i = 0; i < 8; i++) {
        const rest = cage.restCorners[i]!;
        const corner = cage.corners[i]!;
        corner.copy(rest);
        let wsum = 0;
        _d.set(0, 0, 0);
        for (const m of this.masses) {
          if (m.hub && !m.popped) continue;
          const dist = rest.distanceTo(m.rest);
          if (dist > 1.15) continue;
          const w = Math.exp(-dist * 3.2);
          _e.copy(m.local).sub(m.rest);
          _d.addScaledVector(_e, w);
          wsum += w;
        }
        if (wsum > 1e-6) {
          const lid = cage.spec.name === "bonnet" || cage.spec.name === "boot" || cage.glass;
          // Follow live masses. A far-side 0.12 scale left rest-sized cages
          // sticking through walls / the other car.
          const scale = lid && !this.bidirectional ? 0.45 : 1;
          corner.addScaledVector(_d, scale / wsum);
        }
      }
    }

    if (!this.bidirectional) for (const s of this.sensors) {
      if (s.compression < 0.015) continue;
      const cage = this.cages[s.partIndex]!;
      const amount = s.compression * cage.spec.maxCrush * 0.95 * ramp;
      const hinge = cage.spec.maxAngle * s.compression * 0.95 * ramp;
      _axis.copy(inward).cross(_a.set(0, 1, 0));
      if (_axis.lengthSq() < 1e-6) _axis.set(1, 0, 0);
      _axis.normalize();
      _q.setFromAxisAngle(_axis, hinge);
      const pivot = _c.copy(cage.center).addScaledVector(inward, cage.size.length() * 0.28);
      for (let i = 0; i < 8; i++) {
        const rest = cage.restCorners[i]!;
        const corner = cage.corners[i]!;
        const dist = rest.distanceTo(s.rest);
        const fall = Math.exp(-dist * 1.35);
        const lat = Math.abs(rest.x - this.impactLocal.x);
        const hitSide = Math.sign(this.impactLocal.x);
        const restSide = Math.sign(rest.x);
        const opposite = hitSide !== 0 && restSide !== 0 && hitSide !== restSide;
        const cornerFall = fall * Math.exp(-lat * (opposite ? 3.6 : 2.2)) * (opposite ? 0.14 : 1);
        const lid = cage.spec.name === "bonnet" || cage.spec.name === "boot";
        if (lid) {
          const alongCage = cage.spec.name === "bonnet"
            ? (rest.z - cage.min.z) / Math.max(cage.size.z, 1e-4)
            : (cage.max.z - rest.z) / Math.max(cage.size.z, 1e-4);
          const pop = amount * cornerFall * Math.sin(THREE.MathUtils.clamp(alongCage, 0, 1) * Math.PI) * (0.45 + this.buckle * 0.9);
          corner.y += pop * 0.85;
          corner.x += Math.sign(rest.x || 1) * pop * 0.18;
          corner.z += inward.z * amount * cornerFall * alongCage * 0.25;
        } else if (rest.x * inward.x + rest.z * inward.z < 0.12) {
          corner.addScaledVector(inward, amount * cornerFall * this.squash);
        }
        _e.copy(rest).sub(cage.center);
        const along = _e.dot(inward);
        const crease = Math.sin(along * 9 + s.compression * 4) * s.compression * (lid ? 0.04 : 0.08) * cornerFall;
        if (lid) corner.y += Math.abs(crease) * 0.6;
        else corner.addScaledVector(inward, crease);
        const name = cage.spec.name;
        const keepFrame = name === "chassisCell" || name === "roof" || name === "chassisFront" || name === "chassisRear";
        if (!keepFrame) {
          _f.copy(corner).sub(pivot).applyQuaternion(_q).add(pivot);
          corner.lerp(_f, Math.min(1, fall * (lid ? 0.95 : 0.45)));
        }
      }
    }

    this.capCageCorners();
    if (this.bidirectional) this.fitCagesToMasses();
  }

  private capCageCorners(): void {
    let maxTravel = 0;
    for (const m of this.masses) maxTravel = Math.max(maxTravel, m.local.distanceTo(m.rest));
    for (const cage of this.cages) {
      const isCell = cage.spec.name === "chassisCell" || cage.spec.name === "roof";
      let cap: number;
      if (this.bidirectional) {
        cap = isCell && !this.deepCrush ? 0.16 : Math.max(2.2, maxTravel + 0.2);
      } else if (cage.spec.name === "chassisCell") cap = 0.1;
      else if (cage.spec.name === "roof") cap = 0.14;
      else if (cage.spec.name === "doorLeft" || cage.spec.name === "doorRight") cap = 0.28;
      else cap = Math.min(cage.spec.maxCrush * 0.9, 0.85);
      cap = Math.max(cap, maxTravel * 0.95);
      if (isCell && !this.deepCrush) cap = Math.min(cap, this.bidirectional ? 0.16 : 0.14);
      for (let i = 0; i < 8; i++) {
        const rest = cage.restCorners[i]!;
        const corner = cage.corners[i]!;
        const mag = corner.distanceTo(rest);
        if (mag > cap) corner.lerpVectors(rest, corner, cap / mag);
      }
    }
  }

  /** Cage boxes follow the live mass hull — whatever collision already resolved. */
  private fitCagesToMasses(): void {
    let minZ = Infinity,
      maxZ = -Infinity,
      minX = Infinity,
      maxX = -Infinity;
    for (const m of this.masses) {
      minZ = Math.min(minZ, m.local.z);
      maxZ = Math.max(maxZ, m.local.z);
      minX = Math.min(minX, m.local.x);
      maxX = Math.max(maxX, m.local.x);
    }
    const zPad = 0.1;
    const xPad = 0.16;
    for (const cage of this.cages) {
      for (const corner of cage.corners) {
        corner.z = THREE.MathUtils.clamp(corner.z, minZ - zPad, maxZ + zPad);
        corner.x = THREE.MathUtils.clamp(corner.x, minX - xPad, maxX + xPad);
      }
    }
  }

  /** The WASM skin's inputs (the arrays this car's skin reads, and the two it rewrites before each run), once the kernel is first used. */
  private kernelIn: SkinDynamic | null = null;
  /** This car's style in the kernel's memory (shared by every car of the style). */
  private kernelSet: SkinTables | null = null;

  private placeKernelTables(kernel: SkinKernel, index: ArrayLike<number>, d: SkinDynamic): SkinTables {
    const n = this.vertexCount;
    const s: SkinStatic = {
      rest: this.restPos,
      rC: this.resC.subarray(0, n * 3),
      sN: this.skinN,
      sXf: this.skinXf,
      sW: this.skinW,
      rJ: this.resJ.subarray(0, n * RES_SLOTS),
      rW: this.resW.subarray(0, n * RES_SLOTS),
      iN: this.infN,
      iCo: this.infCo,
      iUvw: this.infUvw,
      hub: this.skinHub,
      seed: this.wrinkleSeed,
      idx: index instanceof Uint32Array ? index : Uint32Array.from(index),
    };
    return kernel.tables(skinKey(s, d), () => s, d);
  }

  /** The kernel's wheel-arch inputs: per mass, 5 numbers (popped, local x and z, rest x and z). */
  private fillKernelHubs(hubs: Float64Array): void {
    for (let j = 0, o = 0; j < this.masses.length; j++, o += 5) {
      const m = this.masses[j]!;
      hubs[o] = m.popped ? 1 : 0;
      hubs[o + 1] = m.local.x;
      hubs[o + 2] = m.rest.x;
      hubs[o + 3] = m.local.z;
      hubs[o + 4] = m.rest.z;
    }
  }

  /** The skin's 0.1 m roof clamp holds unless load crush sank the roof mass past `SUNK_ROOF` (read off the baked masses: a netplay client's skin lifts it the same way). */
  private roofHolds(): boolean {
    const roof = this.byName.get("roof")!;
    return this.massPos[this.masses.indexOf(roof) * 3 + 1]! > roof.rest.y - SUNK_ROOF;
  }

  protected skin(geometry: THREE.BufferGeometry): void {
    const attr = geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const rest = this.restPos;
    const shape = this.mode === "shape";
    if (shape) this.refreshClusterXf();
    const X = this.clusterXf;
    const co = this.cageCo;
    for (let p = 0; p < this.cages.length; p++) cageCoeffs(this.cages[p]!.corners, co, p * 24);
    const sN = this.skinN;
    const sXf = this.skinXf;
    const sW = this.skinW;
    const iN = this.infN;
    const iCo = this.infCo;
    const iUvw = this.infUvw;
    const rJ = this.resJ;
    const rW = this.resW;
    const rC = this.resC;
    const pos = this.massPos;
    const ix = this.impactLocal.x;
    const iy = this.impactLocal.y;
    const iz = this.impactLocal.z;
    const wrinkle = this.wrinkleAmp * Math.min(1, this.elapsed * 6);
    const wrinkles = wrinkle > 0.02;
    const b = this.buckle;
    const ampK = wrinkle * 0.16 * (0.35 + b * 0.65);
    const extraCap = 0.03 + b * 0.08;
    const cap = shape ? 1.35 : 2.2;
    const roofClamp = !this.deepCrush && this.roofHolds();
    const kernel = skinKernel();
    const nor = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
    if (kernel && geometry.index && nor && nor.count === attr.count && nor.array instanceof Float32Array) {
      // The kernel's loop is this one below, with `computeNormalsFast`: same bits out (skin-kernel.test.ts).
      const d = (this.kernelIn ??= { X, co, pos, hubs: new Float64Array(this.masses.length * 5), params: new Float64Array(9) });
      const p = d.params;
      p[0] = wrinkles ? 1 : 0;
      p[1] = ampK;
      p[2] = extraCap;
      p[3] = cap;
      p[4] = roofClamp ? 1 : 0;
      p[5] = ix;
      p[6] = iy;
      p[7] = iz;
      p[8] = shape ? 1 : 0;
      this.fillKernelHubs(d.hubs);
      kernel.run((this.kernelSet ??= this.placeKernelTables(kernel, geometry.index.array, d)), d, arr, nor.array);
      attr.needsUpdate = true;
      nor.needsUpdate = true;
      this.dirty = true;
      this.skinnedThisFrame = true;
      return;
    }

    for (let i = 0, r = 0; i < this.vertexCount; i++, r += 3) {
      const rx = rest[r]!;
      const ry = rest[r + 1]!;
      const rz = rest[r + 2]!;
      let px = 0,
        py = 0,
        pz = 0;
      const n = shape ? sN[i]! : 0;
      if (n > 0) {
        // A5: parents' positions + the blended cluster map on the offset from their rest centroid.
        const dx = rx - rC[r]!;
        const dy = ry - rC[r + 1]!;
        const dz = rz - rC[r + 2]!;
        for (let k = i * SKIN_K, e = k + n; k < e; k++) {
          const o = sXf[k]!;
          const w = sW[k]!;
          px += (X[o]! * dx + X[o + 1]! * dy + X[o + 2]! * dz) * w;
          py += (X[o + 3]! * dx + X[o + 4]! * dy + X[o + 5]! * dz) * w;
          pz += (X[o + 6]! * dx + X[o + 7]! * dy + X[o + 8]! * dz) * w;
        }
        for (let k = i * RES_SLOTS, e = k + RES_SLOTS; k < e; k++) {
          const j = rJ[k]!;
          const w = rW[k]!;
          px += pos[j]! * w;
          py += pos[j + 1]! * w;
          pz += pos[j + 2]! * w;
        }
      } else {
        for (let k = i * INF_K, e = k + iN[i]!; k < e; k++) {
          const o = iCo[k]!;
          const u = iUvw[k * 4]!;
          const v = iUvw[k * 4 + 1]!;
          const w = iUvw[k * 4 + 2]!;
          const wt = iUvw[k * 4 + 3]!;
          px += cageAxis(co, o, u, v, w) * wt;
          py += cageAxis(co, o + 8, u, v, w) * wt;
          pz += cageAxis(co, o + 16, u, v, w) * wt;
        }
      }
      if (wrinkles && ry > 0.34) {
        const dx = rx - ix;
        const dy = ry - iy;
        const dz = rz - iz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 0.82 * 0.82) {
          const n0 = this.wrinkleSeed[i]!;
          // Accordion folds along the crush axis (~12 cm wavelength), not a clay blob.
          // Wreckfest impact radius sweet spot is 0.3–0.5 m; 1.6 m wrinkled the whole nose.
          const wave = Math.sin(rz * 18 + n0 * 1.2);
          const amp = ampK * Math.exp(-Math.sqrt(d2) * 3.4);
          let ox = Math.sign(rx || 1) * n0 * amp * 0.12;
          let oy = Math.abs(wave) * amp * 0.28;
          let oz = wave * amp;
          const extra = Math.sqrt(ox * ox + oy * oy + oz * oz);
          if (extra > extraCap) {
            const t = extraCap / extra;
            ox *= t;
            oy *= t;
            oz *= t;
          }
          px += ox;
          py += oy;
          pz += oz;
        }
      }
      const tx = px - rx;
      const ty = py - ry;
      const tz = pz - rz;
      const travel2 = tx * tx + ty * ty + tz * tz;
      if (travel2 > cap * cap) {
        const t = cap / Math.sqrt(travel2);
        px = rx + tx * t;
        py = ry + ty * t;
        pz = rz + tz * t;
      }
      if (roofClamp && ry > 1.05) py = THREE.MathUtils.clamp(py, ry - 0.1, ry + 0.08);
      const h = this.skinHub[i]!;
      if (h >= 0) {
        // Wheel arch: plant the paint at its rest offset from the hub (the hub's rest while the wheel
        // is on). Blending onto the hub centre folded every arch vertex ~0.34 m in, even on a tap.
        const m = this.masses[h]!;
        const keep = m.popped ? 0.15 : 0.82;
        const hx = m.popped ? rx + m.local.x - m.rest.x : rx;
        const hz = m.popped ? rz + m.local.z - m.rest.z : rz;
        px = px * (1 - keep) + hx * keep;
        pz = pz * (1 - keep) + hz * keep;
      }
      arr[i * 3] = px;
      arr[i * 3 + 1] = py;
      arr[i * 3 + 2] = pz;
    }
    attr.needsUpdate = true;
    computeNormalsFast(geometry);
    this.dirty = true;
    this.skinnedThisFrame = true;
  }

  /** The solver arrays and vectors outside the scalar fields, `masses`, `beams` and `clusters` that one step leaves for the next to read (built with the car: a recorder's steady state allocates nothing). */
  private readonly simTables = {
    vecs: [this.impactLocal, this.impactInward, this.bodyC, this.bodyRestC],
    arrays: [this.endEbs2, this.floorPre, this.floorPost, this.gripPost, this.pose],
  };

  private simBlocks(): { vecs: THREE.Vector3[]; arrays: Float64Array[] } {
    return this.simTables;
  }

  /** Numbers in a `simState` block (fixed by the class and the rig: the same for every car). */
  simSize(): number {
    const { vecs, arrays } = this.simBlocks();
    let n = SIM_SCALAR_NUMBERS + this.sensors.length + vecs.length * 3 + this.masses.length * 17 + this.beams.length * 4;
    n += this.crush.length * 2;
    for (let i = 0; i < arrays.length; i++) n += arrays[i]!.length;
    for (const c of this.clusters) n += c.q0x.length * 3 + 38;
    return n;
  }

  /**
   * Highlight keyframes (docs/HIGHLIGHTS.md): the solver state a netplay wreck section leaves out, `simSize()` numbers
   * read into `buf`, or with `write` restored from it. Every scalar field (crash clocks, crush, settle and plant
   * state; not the renderer's skin flags); the current hit (`impactLocal`, `impactInward`), the body frame
   * (`bodyC`, `bodyRestC`), each end's accumulated hit energy (`endEbs2`), the ground under each mass and the body pose
   * the last step measured (`floorPre`, `floorPost`, `gripPost`, `pose`: the next step's hub plane and suspension tilt
   * read them before they are measured again); each mass's world, local and velocity with its crush offsets, each
   * beam's rest and set, each shape cluster's plastic rest (q0, cm0, AqqInv, plane normal, `planar`, Sp) and the fit's
   * carried `Rprev` and `rotQ`. Restored from the net
   * state alone, a wreck in the middle of a hit lost its masses' motion (up to 31 m/s about their mean) and its clocks:
   * it shed 5.2 m/s in its first replayed step and was 2.8 m off the record 76 steps later (engine-replay.test.ts).
   * The net state's hit vectors are the last skin bake's, which comes after the frame and not after the step: a
   * keyframe cut the step after a first impact held the default `impactInward`, the replayed wreck pushed along the
   * wrong axis and a 2 x 20 m/s head-on played 2.6 m/s and 0.3 m off the live one (replay-fidelity.test.ts).
   */
  simState(buf: Float64Array, write: boolean): void {
    let o = 0;
    // Every number a double: the replay is the sim that recorded it only if its restored state is bit for bit the record's (a
    // 1e-9 m difference between two wedged wrecks becomes decimetres within a second).
    o = write ? this.simScalarsIn(buf, o) : this.simScalarsOut(buf, o);
    for (let i = 0; i < this.sensors.length; i++) o = simSensor(buf, o, this.sensors[i]!, write);
    const { vecs, arrays } = this.simBlocks();
    for (let i = 0; i < vecs.length; i++) o = simVec(buf, o, vecs[i]!, write);
    for (let i = 0; i < arrays.length; i++) o = simArray(buf, o, arrays[i]!, write);
    for (let i = 0; i < this.masses.length; i++) o = simMass(buf, o, this.masses[i]!, write);
    for (let i = 0; i < this.beams.length; i++) o = simBeam(buf, o, this.beams[i]!, write);
    for (let i = 0; i < this.clusters.length; i++) o = simCluster(buf, o, this.clusters[i]!, write);
    // Load crush (docs/LOAD_CRUSH.md): each face's depth and the depth already baked into the masses.
    o = simArray(buf, o, this.crush, write);
    simArray(buf, o, this.crushBaked, write);
  }

  /** Netplay: array sizes for a `DeformNetState` (fixed by the rig). */
  netSizes(): { masses: number; clusters: number; sensors: number } {
    return { masses: this.masses.length, clusters: this.clusters.length, sensors: this.sensors.length };
  }

  /** Netplay host: the skin inputs as of the last bake, plus the current particles (the hulls) and flags. */
  readNetState(out: DeformNetState): void {
    let popped = 0;
    for (let i = 0, r = 0; i < this.masses.length; i++, r += 3) {
      const m = this.masses[i]!;
      out.local[r] = m.local.x;
      out.local[r + 1] = m.local.y;
      out.local[r + 2] = m.local.z;
      if (m.popped) popped |= 1 << i;
    }
    out.popped = popped;
    out.skinPos.set(this.massPos);
    out.skinXf.set(this.netSkinXf);
    for (let s = 0; s < this.sensors.length; s++) out.sensor[s] = this.sensors[s]!.compression;
    out.impact.set(this.netImpact);
    out.skinPopped = this.netPopped;
    out.flags = (this.massActive ? 1 : 0) | (this.drivetrainAlive ? 2 : 0) | this.netFlags;
    out.engineTravel = this.engineTravel;
    out.killTravel = this.killTravel;
  }

  /**
   * Netplay client: take the host's state and re-skin from it. No physics: the cages and skin are
   * solved from the baked inputs exactly as the host's last skin was, then `local` is set to the
   * host's current particles (the hulls) and `world` follows `group`. Allocation-free.
   */
  writeNetState(src: DeformNetState, group: THREE.Object3D, geometry: THREE.BufferGeometry): void {
    const f = src.flags;
    this.massActive = (f & 1) !== 0;
    this.drivetrainAlive = (f & 2) !== 0;
    this.engineTravel = src.engineTravel;
    this.killTravel = src.killTravel;
    this.deepCrush = (f & 4) !== 0;
    this.bidirectional = (f & 8) !== 0;
    this.mode = (f & 16) !== 0 ? "lattice" : "shape";
    const im = src.impact;
    this.impactLocal.set(im[0]!, im[1]!, im[2]!);
    this.impactInward.set(im[3]!, im[4]!, im[5]!);
    this.wrinkleAmp = im[6]!;
    this.buckle = im[7]!;
    this.squash = im[8]!;
    // Saturates the wrinkle and lattice ramps: the host's value already carries its ramp.
    this.elapsed = Math.max(this.elapsed, 1);
    let maxC = 0;
    for (let s = 0; s < this.sensors.length; s++) {
      const c = src.sensor[s]!;
      this.sensors[s]!.compression = c;
      if (c > maxC) maxC = c;
    }
    this.crushAmount = maxC;
    this.massPos.set(src.skinPos);
    for (let c = 0; c < this.clusters.length; c++) {
      const m = this.clusters[c]!.skinM;
      for (let k = 0, o = c * 9; k < 9; k++) m[k] = src.skinXf[o + k]!;
    }
    for (let i = 0, r = 0; i < this.masses.length; i++, r += 3) {
      const m = this.masses[i]!;
      m.local.set(src.skinPos[r]!, src.skinPos[r + 1]!, src.skinPos[r + 2]!);
      m.popped = (src.skinPopped & (1 << i)) !== 0;
    }
    // Skinned now, LoD or not: a deferred flush would read the hubs after they move on below.
    this.solveCages();
    this.flushSkin(geometry, true);
    this.skinOwed = false;
    group.updateWorldMatrix(false, false);
    for (let i = 0, r = 0; i < this.masses.length; i++, r += 3) {
      const m = this.masses[i]!;
      m.local.set(src.local[r]!, src.local[r + 1]!, src.local[r + 2]!);
      m.popped = (src.popped & (1 << i)) !== 0;
      m.world.copy(m.local).applyMatrix4(group.matrixWorld);
      m.vel.set(0, 0, 0);
    }
  }
}
