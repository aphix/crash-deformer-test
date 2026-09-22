import * as THREE from "three";
import { round4, snapshotPoints } from "./physics-util.ts";

export class DebrisSystem {
  private mesh: THREE.InstancedMesh;
  private life: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private dummy = new THREE.Object3D();
  private vel = new THREE.Vector3();
  private n: number;

  constructor(scene: THREE.Scene, n = 180) {
    this.n = n;
    const geo = new THREE.BoxGeometry(0.038, 0.016, 0.026);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x6a6e74,
      metalness: 0.72,
      roughness: 0.4,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.count = 0;
    this.life = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    scene.add(this.mesh);
  }

  reset(): void {
    this.mesh.count = 0;
    this.life.fill(0);
  }

  snapshot() {
    const items: { x: number; y: number; z: number; life: number }[] = [];
    for (let i = 0; i < this.mesh.count && items.length < 16; i++) {
      if (this.life[i]! <= 0) continue;
      this.mesh.getMatrixAt(i, this.dummy.matrix);
      this.dummy.position.setFromMatrixPosition(this.dummy.matrix);
      items.push({
        x: round4(this.dummy.position.x),
        y: round4(this.dummy.position.y),
        z: round4(this.dummy.position.z),
        life: round4(this.life[i]!),
      });
    }
    return { count: items.length, items };
  }

  burst(origin: THREE.Vector3, normal: THREE.Vector3, count: number): void {
    const n = Math.min(this.n, Math.floor(count));
    this.mesh.count = n;
    for (let i = 0; i < n; i++) {
      this.life[i] = 0.9 + Math.random() * 1.5;
      const side = Math.random() - 0.5;
      this.vx[i] = -normal.x * (2 + Math.random() * 6) + (Math.random() - 0.5) * 5 + normal.z * side * 4;
      this.vy[i] = 1.4 + Math.random() * 4.2;
      this.vz[i] = -normal.z * (2 + Math.random() * 6) + (Math.random() - 0.5) * 5 - normal.x * side * 4;
      this.dummy.position.copy(origin);
      this.dummy.position.y += 0.08;
      this.dummy.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
      this.dummy.scale.setScalar(0.45 + Math.random() * 0.7);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number, bounce: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void): void {
    if (this.mesh.count === 0) return;
    let any = false;
    for (let i = 0; i < this.mesh.count; i++) {
      if (this.life[i]! <= 0) continue;
      any = true;
      this.life[i]! -= dt;
      this.vy[i]! -= 9.6 * dt;
      this.mesh.getMatrixAt(i, this.dummy.matrix);
      this.dummy.position.setFromMatrixPosition(this.dummy.matrix);
      this.dummy.position.x += this.vx[i]! * dt;
      this.dummy.position.y += this.vy[i]! * dt;
      this.dummy.position.z += this.vz[i]! * dt;
      this.vel.set(this.vx[i]!, this.vy[i]!, this.vz[i]!);
      bounce(this.dummy.position, this.vel, 0.03);
      this.dummy.position.y = Math.max(0.04, this.dummy.position.y);
      this.vx[i] = this.vel.x;
      this.vy[i] = this.vel.y;
      this.vz[i] = this.vel.z;
      this.dummy.rotation.x += dt * 5;
      this.dummy.rotation.y += dt * 3.2;
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!any) this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

function makeDotTexture(color: string, glow: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, color);
  g.addColorStop(0.35, glow);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class SparkSystem {
  private points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private life: Float32Array;
  private tmp = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private n: number;
  private cursor = 0;
  private anyAlive = false;

  constructor(scene: THREE.Scene, n = 480) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.life = new Float32Array(n);
    for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = 250;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setDrawRange(0, n);
    const mat = new THREE.PointsMaterial({
      map: makeDotTexture("rgba(255,248,220,1)", "rgba(255,170,70,0.7)"),
      color: 0xffffff,
      size: 0.055,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  reset(): void {
    this.life.fill(0);
    this.cursor = 0;
    this.anyAlive = false;
    for (let i = 0; i < this.n; i++) this.pos[i * 3 + 1] = 250;
    this.geo.setDrawRange(0, this.n);
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  burst(origin: THREE.Vector3, normal: THREE.Vector3, count: number): void {
    this.poof(origin, normal, count);
  }

  poof(origin: THREE.Vector3, normal: THREE.Vector3, count: number): void {
    const n = Math.min(this.n, Math.max(0, Math.floor(count)));
    for (let i = 0; i < n; i++) {
      const k = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;
      const ox = (Math.random() - 0.5) * 2;
      const oy = Math.random();
      const oz = (Math.random() - 0.5) * 2;
      const mag = Math.hypot(ox, oy, oz) || 1;
      this.pos[k * 3] = origin.x + (Math.random() - 0.5) * 0.22;
      this.pos[k * 3 + 1] = Math.max(0.08, origin.y) + Math.random() * 0.12;
      this.pos[k * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.22;
      const speed = 1.1 + Math.random() * 2.4;
      this.vx[k] = (ox / mag) * speed - normal.x * 0.6;
      this.vy[k] = (oy / mag) * speed * 0.85 + 0.8;
      this.vz[k] = (oz / mag) * speed - normal.z * 0.6;
      this.life[k] = 0.14 + Math.random() * 0.2;
    }
    if (n > 0) this.anyAlive = true;
    this.geo.setDrawRange(0, this.n);
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  snapshot() {
    return snapshotPoints(this.pos, null, null, this.life, true);
  }

  update(dt: number, bounce: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void): void {
    if (!this.anyAlive) return;
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue;
      any = true;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) {
        this.pos[i * 3 + 1] = 250;
        continue;
      }
      this.tmp.set(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
      this.vel.set(this.vx[i]!, this.vy[i]!, this.vz[i]!);
      this.tmp.addScaledVector(this.vel, dt);
      this.vel.y -= 6.5 * dt;
      bounce(this.tmp, this.vel, 0.025);
      this.tmp.y = Math.max(0.04, this.tmp.y);
      this.pos[i * 3] = this.tmp.x;
      this.pos[i * 3 + 1] = this.tmp.y;
      this.pos[i * 3 + 2] = this.tmp.z;
      this.vx[i] = this.vel.x;
      this.vy[i] = this.vel.y;
      this.vz[i] = this.vel.z;
    }
    this.anyAlive = any;
    if (any) (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    const mat = this.points.material as THREE.PointsMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}

export class GlassDotSystem {
  private points: THREE.Points;
  private geo: THREE.BufferGeometry;
  private pos: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private life: Float32Array;
  private tmp = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private n: number;
  private cursor = 0;
  private anyAlive = false;

  constructor(scene: THREE.Scene, n = 320) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.life = new Float32Array(n);
    for (let i = 0; i < n; i++) this.pos[i * 3 + 1] = 250;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setDrawRange(0, n);
    const mat = new THREE.PointsMaterial({
      map: makeDotTexture("rgba(255,255,255,1)", "rgba(210,230,245,0.55)"),
      color: 0xffffff,
      size: 0.042,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  reset(): void {
    this.life.fill(0);
    this.cursor = 0;
    this.anyAlive = false;
    for (let i = 0; i < this.n; i++) this.pos[i * 3 + 1] = 250;
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  burst(origin: THREE.Vector3, inherit: THREE.Vector3, count: number): void {
    const n = Math.min(this.n, Math.floor(count));
    for (let i = 0; i < n; i++) {
      const k = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;
      this.pos[k * 3] = origin.x + (Math.random() - 0.5) * 0.55;
      this.pos[k * 3 + 1] = Math.max(0.12, origin.y) + (Math.random() - 0.2) * 0.28;
      this.pos[k * 3 + 2] = origin.z + (Math.random() - 0.5) * 0.4;
      this.vx[k] = inherit.x * 0.85 + (Math.random() - 0.5) * 5.5;
      this.vy[k] = inherit.y * 0.55 + 1.4 + Math.random() * 3.6;
      this.vz[k] = inherit.z * 0.85 + (Math.random() - 0.5) * 5.5;
      this.life[k] = 1.1 + Math.random() * 1.1;
    }
    if (n > 0) this.anyAlive = true;
    (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  update(dt: number, bounce: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void): void {
    if (!this.anyAlive) return;
    let any = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue;
      any = true;
      this.life[i]! -= dt;
      if (this.life[i]! <= 0) {
        this.pos[i * 3 + 1] = 250;
        continue;
      }
      this.tmp.set(this.pos[i * 3]!, this.pos[i * 3 + 1]!, this.pos[i * 3 + 2]!);
      this.vel.set(this.vx[i]!, this.vy[i]!, this.vz[i]!);
      this.tmp.addScaledVector(this.vel, dt);
      this.vel.y -= 9.6 * dt;
      bounce(this.tmp, this.vel, 0.02);
      this.tmp.y = Math.max(0.04, this.tmp.y);
      this.pos[i * 3] = this.tmp.x;
      this.pos[i * 3 + 1] = this.tmp.y;
      this.pos[i * 3 + 2] = this.tmp.z;
      this.vx[i] = this.vel.x;
      this.vy[i] = this.vel.y;
      this.vz[i] = this.vel.z;
    }
    this.anyAlive = any;
    if (any) (this.geo.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    const mat = this.points.material as THREE.PointsMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}

export class TireSmokeSystem {
  private mesh: THREE.InstancedMesh;
  private px: Float32Array;
  private py: Float32Array;
  private pz: Float32Array;
  private vx: Float32Array;
  private vy: Float32Array;
  private vz: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private size: Float32Array;
  private dummy = new THREE.Object3D();
  private n: number;
  private cursor = 0;
  private anyAlive = false;

  constructor(scene: THREE.Scene, n = 420) {
    this.n = n;
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.pz = new Float32Array(n);
    this.vx = new Float32Array(n);
    this.vy = new Float32Array(n);
    this.vz = new Float32Array(n);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size = new Float32Array(n);
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({
      map: makeDotTexture("rgba(210,210,206,0.95)", "rgba(70,70,68,0.25)"),
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.mesh.frustumCulled = false;
    this.mesh.count = n;
    scene.add(this.mesh);
    this.hideAll();
  }

  private hideAll(): void {
    this.dummy.scale.setScalar(0.001);
    this.dummy.position.set(0, 250, 0);
    this.dummy.updateMatrix();
    for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  reset(): void {
    this.life.fill(0);
    this.cursor = 0;
    this.anyAlive = false;
    this.hideAll();
  }

  emitAt(origin: THREE.Vector3, inherit: THREE.Vector3, count: number): void {
    this.spawn(origin, inherit, count, 0.28, 1.2, 0.7);
  }

  plume(origin: THREE.Vector3, inherit: THREE.Vector3, count: number): void {
    this.spawn(origin, inherit, count, 0.55, 2.2, 1.4);
  }

  private spawn(
    origin: THREE.Vector3,
    inherit: THREE.Vector3,
    count: number,
    size: number,
    life: number,
    rise: number,
  ): void {
    const n = Math.min(this.n, Math.max(0, Math.floor(count)));
    for (let i = 0; i < n; i++) {
      const k = this.cursor;
      this.cursor = (this.cursor + 1) % this.n;
      this.px[k] = origin.x + (Math.random() - 0.5) * 0.35;
      this.py[k] = Math.max(0.08, origin.y);
      this.pz[k] = origin.z + (Math.random() - 0.5) * 0.35;
      this.vx[k] = inherit.x * 0.04 + (Math.random() - 0.5) * 0.22;
      this.vy[k] = rise + Math.random() * 0.7;
      this.vz[k] = inherit.z * 0.04 + (Math.random() - 0.5) * 0.22;
      const L = life + Math.random() * 1.1;
      this.life[k] = L;
      this.maxLife[k] = L;
      this.size[k] = size + Math.random() * 0.4;
    }
    if (n > 0) this.anyAlive = true;
  }

  snapshot() {
    return snapshotPoints(this.px, this.py, this.pz, this.life, false);
  }

  update(
    dt: number,
    _bounce: (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void,
    camera: THREE.Camera,
  ): void {
    void _bounce;
    if (!this.anyAlive) return;
    const damp = Math.exp(-0.7 * dt);
    let any = false;
    let wrote = false;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      const fade = Math.max(0, this.life[i]! / Math.max(this.maxLife[i]!, 1e-4));
      if (fade <= 0) {
        this.life[i] = 0;
        this.dummy.position.set(0, 250, 0);
        this.dummy.scale.setScalar(0.001);
        this.dummy.updateMatrix();
        this.mesh.setMatrixAt(i, this.dummy.matrix);
        wrote = true;
        continue;
      }
      any = true;
      this.px[i]! += this.vx[i]! * dt;
      this.py[i]! += this.vy[i]! * dt;
      this.pz[i]! += this.vz[i]! * dt;
      this.vy[i]! += 0.55 * dt;
      this.vx[i]! *= damp;
      this.vz[i]! *= damp;
      this.dummy.position.set(this.px[i]!, this.py[i]!, this.pz[i]!);
      this.dummy.scale.setScalar(this.size[i]! * (0.7 + (1 - fade) * 1.8));
      this.dummy.quaternion.copy(camera.quaternion);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      const g = 0.55 + fade * 0.4;
      this.mesh.setColorAt(i, _smokeColor.setRGB(g, g, g * 0.96));
      wrote = true;
    }
    this.anyAlive = any;
    if (wrote) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    const mat = this.mesh.material as THREE.MeshBasicMaterial;
    mat.map?.dispose();
    mat.dispose();
  }
}

const _smokeColor = new THREE.Color();

export class CrashAudio {
  private ctx: AudioContext | null = null;
  unlocked = false;

  unlock(): void {
    if (this.unlocked) {
      void this.ctx?.resume();
      return;
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.unlocked = true;
    void this.ctx.resume();
  }

  impact(impulse: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 0.35 + Math.min(0.4, impulse * 0.01);

    const thump = ctx.createOscillator();
    const thumpG = ctx.createGain();
    thump.type = "sine";
    thump.frequency.setValueAtTime(48, t);
    thump.frequency.exponentialRampToValueAtTime(22, t + dur);
    thumpG.gain.setValueAtTime(Math.min(0.7, 0.22 + impulse * 0.012), t);
    thumpG.gain.exponentialRampToValueAtTime(0.001, t + dur);
    thump.connect(thumpG).connect(ctx.destination);
    thump.start(t);
    thump.stop(t + dur);

    const noise = ctx.createBufferSource();
    const nbuf = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
    const data = nbuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    noise.buffer = nbuf;
    const ng = ctx.createGain();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900;
    bp.Q.value = 0.7;
    ng.gain.setValueAtTime(Math.min(0.45, 0.12 + impulse * 0.008), t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    noise.connect(bp).connect(ng).connect(ctx.destination);
    noise.start(t);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
  }
}
