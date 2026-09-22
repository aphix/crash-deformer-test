import * as THREE from "three";
import { StreamedDeformation } from "./streamed-deform.ts";
import { round4 } from "./physics-util.ts";
import {
  CAR_HALF,
  HULLS,
  CRUSH_HULLS,
  WHEEL_POS,
  getCrackMap,
  makeBumperGeometry,
  makeChassisGeometry,
  makeDoorGeometry,
  makeGlassMaterial,
  makeGrille,
  makeHoodGeometry,
  makeInterior,
  makeMirror,
  makePaintMaterial,
  makeRearGlass,
  makeRearSideGlass,
  makeSideGlass,
  makeTrimMaterial,
  makeTrunkGeometry,
  makeWheel,
  makeWindshield,
} from "./car-mesh.ts";

export { CAR_HALF, HULLS, CRUSH_HULLS, WHEEL_POS };
export type { Hull } from "./car-mesh.ts";

export interface CarPaint {
  body: number;
  accent: number;
  name: string;
}

export type WorldBounce = (pos: THREE.Vector3, vel: THREE.Vector3, r: number) => void;
export type GlassBurst = (origin: THREE.Vector3, velocity: THREE.Vector3, count: number) => void;

type GlassState = "intact" | "cracked" | "shattered";

interface GlassPane {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  restPos: THREE.Vector3;
  restVerts: Float32Array | null;
  state: GlassState;
  parts: ("roof" | "bonnet" | "boot" | "doorLeft" | "doorRight")[];
  skin: "glassFront" | "glassRear" | null;
}

interface Lamp {
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
  intact: boolean;
  kind: "head" | "tail";
  side: number;
  sensors: number[];
  parts: ("bumperFront" | "bumperRear" | "wingFL" | "wingFR" | "wingRL" | "wingRR")[];
}

interface DetachPart {
  name: string;
  object: THREE.Object3D;
  restPos: THREE.Vector3;
  restQuat: THREE.Quaternion;
  cage:
    | "bumperFront"
    | "bumperRear"
    | "bonnet"
    | "boot"
    | "doorLeft"
    | "doorRight"
    | "wingFL"
    | "wingFR";
  attachL: number;
  attachR: number;
  hinge: "cowl" | "tail" | "two-point" | "door";
  detached: boolean;
  folding: boolean;
  hingeT: number;
  velocity: THREE.Vector3;
  angular: THREE.Vector3;
  radius: number;
}

export class DeformableCar {
  readonly group = new THREE.Group();
  readonly body: THREE.Mesh;
  readonly deform: StreamedDeformation;
  readonly paint: CarPaint;
  readonly wheels: THREE.Group[] = [];
  readonly velocity = new THREE.Vector3();
  readonly angular = new THREE.Vector3();
  readonly forward = new THREE.Vector3(0, 0, 1);
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly fwdFlat = new THREE.Vector3(0, 0, 1);
  readonly rightFlat = new THREE.Vector3(1, 0, 0);

  speed = 0;
  crashed = false;
  yaw = 0;
  roll = 0;
  pitch = 0;
  spawnSpeed = 0;
  readonly drive = { throttle: 0, steer: 0, brake: 0, ebrake: false };

  private world: THREE.Scene;
  private onGlass: GlassBurst | null;
  private bodyMat: THREE.MeshPhysicalMaterial;
  private wheelSpin = 0;
  private glassPanes: GlassPane[] = [];
  private parts: DetachPart[] = [];
  private lamps: Lamp[] = [];
  private hullHelper: THREE.LineSegments | null = null;
  private bumperF: THREE.Group;
  private bumperR: THREE.Group;
  private hood: THREE.Mesh;
  private trunk: THREE.Mesh;
  private doorL: THREE.Group;
  private doorR: THREE.Group;
  private doorMeshL: THREE.Mesh;
  private doorMeshR: THREE.Mesh;
  private hoodRest: Float32Array;
  private trunkRest: Float32Array;
  private doorLRest: Float32Array;
  private doorRRest: Float32Array;
  private hoodOrigin: THREE.Vector3;
  private trunkOrigin: THREE.Vector3;
  private interior: THREE.Group;
  private mirrorL: THREE.Group;
  private mirrorR: THREE.Group;

  constructor(paint: CarPaint, world: THREE.Scene, onGlass: GlassBurst | null = null) {
    this.paint = paint;
    this.world = world;
    this.onGlass = onGlass;
    this.group.name = paint.name;

    this.bodyMat = makePaintMaterial(paint.body);
    const bodyGeo = makeChassisGeometry();
    this.body = new THREE.Mesh(bodyGeo, this.bodyMat);
    this.body.castShadow = true;
    this.body.receiveShadow = true;
    this.group.add(this.body);
    this.deform = new StreamedDeformation(bodyGeo);
    this.deform.createHelper(this.group);

    this.interior = makeInterior();
    this.group.add(this.interior);

    this.hood = new THREE.Mesh(makeHoodGeometry(), this.bodyMat);
    this.hood.castShadow = true;
    this.hood.position.set(0, 0.7, 0.74);
    this.group.add(this.hood);
    this.trunk = new THREE.Mesh(makeTrunkGeometry(), this.bodyMat);
    this.trunk.castShadow = true;
    this.trunk.position.set(0, 0.74, -0.72);
    this.group.add(this.trunk);

    this.doorL = new THREE.Group();
    this.doorR = new THREE.Group();
    this.doorL.position.set(-0.86, 0.54, 0.55);
    this.doorR.position.set(0.86, 0.54, 0.55);
    this.doorMeshL = new THREE.Mesh(makeDoorGeometry(-1), this.bodyMat);
    this.doorMeshL.position.set(0, 0, -0.28);
    this.doorMeshL.castShadow = true;
    this.doorMeshR = new THREE.Mesh(makeDoorGeometry(1), this.bodyMat);
    this.doorMeshR.position.set(0, 0, -0.28);
    this.doorMeshR.castShadow = true;
    this.doorL.add(this.doorMeshL);
    this.doorR.add(this.doorMeshR);
    const innerMat = new THREE.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.9, metalness: 0.04 });
    const innerL = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.5, 0.52), innerMat);
    innerL.position.set(0.024, 0, -0.28);
    const innerR = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.5, 0.52), innerMat);
    innerR.position.set(-0.024, 0, -0.28);
    this.doorL.add(innerL);
    this.doorR.add(innerR);
    this.group.add(this.doorL, this.doorR);

    this.hoodRest = this.copyRest(this.hood.geometry);
    this.trunkRest = this.copyRest(this.trunk.geometry);
    this.doorLRest = this.copyRest(this.doorMeshL.geometry);
    this.doorRRest = this.copyRest(this.doorMeshR.geometry);
    this.hoodOrigin = this.hood.position.clone();
    this.trunkOrigin = this.trunk.position.clone();

    this.bumperF = this.makeBumper(true, paint);
    this.bumperR = this.makeBumper(false, paint);
    this.group.add(this.bumperF, this.bumperR);

    this.mirrorL = makeMirror(-1);
    this.mirrorL.position.set(-0.06, 0.32, 0);
    this.doorL.add(this.mirrorL);
    this.mirrorR = makeMirror(1);
    this.mirrorR.position.set(0.06, 0.32, 0);
    this.doorR.add(this.mirrorR);

    this.addGlass();
    this.registerParts();
    this.buildHullHelper();

    for (const [x, y, z] of WHEEL_POS) {
      const w = makeWheel();
      w.position.set(x, y, z);
      this.group.add(w);
      this.wheels.push(w);
    }
    this.group.castShadow = true;
  }

  private copyRest(geo: THREE.BufferGeometry): Float32Array {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    return new Float32Array(pos.array as Float32Array);
  }

  private restoreRest(geo: THREE.BufferGeometry, rest: Float32Array): void {
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    (pos.array as Float32Array).set(rest);
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }

  private makeBumper(front: boolean, paint: CarPaint): THREE.Group {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(makeBumperGeometry(front), makeTrimMaterial(paint.accent));
    mesh.castShadow = true;
    g.add(mesh);
    if (front) {
      for (const sx of [-0.52, 0.52]) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0xf4f1e8,
          emissive: 0xf4f1e8,
          emissiveIntensity: 1.15,
          roughness: 0.2,
        });
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.09, 0.05), mat);
        f.position.set(sx, 0.15, 0.04);
        g.add(f);
        this.lamps.push({
          mesh: f,
          mat,
          intact: true,
          kind: "head",
          side: sx < 0 ? -1 : 1,
          sensors: sx < 0 ? [1, 4] : [2, 5],
          parts: sx < 0 ? ["wingFL"] : ["wingFR"],
        });
      }
    } else {
      for (const sx of [-0.52, 0.52]) {
        const mat = new THREE.MeshStandardMaterial({
          color: 0xc4121c,
          emissive: 0xe01018,
          emissiveIntensity: 2.6,
          roughness: 0.32,
        });
        const r = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.04), mat);
        r.position.set(sx, 0.15, -0.04);
        g.add(r);
        this.lamps.push({
          mesh: r,
          mat,
          intact: true,
          kind: "tail",
          side: sx < 0 ? -1 : 1,
          sensors: sx < 0 ? [16, 10] : [17, 11],
          parts: sx < 0 ? ["wingRL"] : ["wingRR"],
        });
      }
      const plate = new THREE.Mesh(
        new THREE.BoxGeometry(0.36, 0.11, 0.02),
        new THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.6, metalness: 0.1 }),
      );
      plate.position.set(0, 0.03, -0.08);
      g.add(plate);
    }
    g.position.set(0, 0.33, front ? 2.06 : -2.06);
    if (front) {
      const grille = makeGrille();
      grille.position.set(0, 0.1, 0.06);
      g.add(grille);
    }
    return g;
  }

  private addGlass(): void {
    const addPane = (
      mesh: THREE.Mesh,
      parent: THREE.Object3D,
      parts: GlassPane["parts"],
      skin: GlassPane["skin"] = null,
    ) => {
      mesh.renderOrder = 2;
      parent.add(mesh);
      this.glassPanes.push({
        mesh,
        mat: mesh.material as THREE.MeshPhysicalMaterial,
        restPos: mesh.position.clone(),
        restVerts: skin ? this.copyRest(mesh.geometry) : null,
        state: "intact",
        parts,
        skin,
      });
    };
    const glassMat = makeGlassMaterial();
    addPane(new THREE.Mesh(makeWindshield(), glassMat.clone()), this.group, ["roof", "bonnet"], "glassFront");
    addPane(new THREE.Mesh(makeRearGlass(), glassMat.clone()), this.group, ["roof", "boot"], "glassRear");
    const sideL = new THREE.Mesh(makeSideGlass(-1), glassMat.clone());
    sideL.position.set(0.02, 0.52, -0.28);
    addPane(sideL, this.doorL, ["doorLeft", "roof"]);
    const sideR = new THREE.Mesh(makeSideGlass(1), glassMat.clone());
    sideR.position.set(-0.02, 0.52, -0.28);
    addPane(sideR, this.doorR, ["doorRight", "roof"]);
    addPane(new THREE.Mesh(makeRearSideGlass(-1), glassMat.clone()), this.group, ["roof", "doorLeft"]);
    addPane(new THREE.Mesh(makeRearSideGlass(1), glassMat.clone()), this.group, ["roof", "doorRight"]);
  }

  private registerParts(): void {
    const add = (
      name: string,
      object: THREE.Object3D,
      cage: DetachPart["cage"],
      attachL: number,
      attachR: number,
      hinge: DetachPart["hinge"],
      radius: number,
    ) => {
      this.parts.push({
        name,
        object,
        restPos: object.position.clone(),
        restQuat: object.quaternion.clone(),
        cage,
        attachL,
        attachR,
        hinge,
        detached: false,
        folding: false,
        hingeT: 0,
        velocity: new THREE.Vector3(),
        angular: new THREE.Vector3(),
        radius,
      });
    };
    add("bumperF", this.bumperF, "bumperFront", 1, 2, "two-point", 0.42);
    add("bumperR", this.bumperR, "bumperRear", 16, 17, "two-point", 0.4);
    add("hood", this.hood, "bonnet", 3, 3, "cowl", 0.5);
    add("trunk", this.trunk, "boot", 18, 18, "tail", 0.48);
    add("doorL", this.doorL, "doorLeft", 6, 6, "door", 0.4);
    add("doorR", this.doorR, "doorRight", 7, 7, "door", 0.4);
    add("mirrorL", this.mirrorL, "doorLeft", 6, 4, "two-point", 0.1);
    add("mirrorR", this.mirrorR, "doorRight", 7, 5, "two-point", 0.1);
  }

  private buildHullHelper(): void {
    const pos: number[] = [];
    for (const h of HULLS) {
      const y0 = 0.18;
      const y1 = 0.72;
      const x0 = h.cx - h.hx;
      const x1 = h.cx + h.hx;
      const z0 = h.cz - h.hz;
      const z1 = h.cz + h.hz;
      const c = [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x0, y1, z1],
      ];
      const edges: [number, number][] = [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [4, 5],
        [5, 6],
        [6, 7],
        [7, 4],
        [0, 4],
        [1, 5],
        [2, 6],
        [3, 7],
      ];
      for (const [a, b] of edges) {
        pos.push(...c[a]!, ...c[b]!);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x8aa0b4,
      transparent: true,
      opacity: 0.7,
      depthTest: false,
    });
    this.hullHelper = new THREE.LineSegments(geo, mat);
    this.hullHelper.renderOrder = 4;
    this.hullHelper.visible = false;
    this.group.add(this.hullHelper);
  }

  private updateHullHelper(): void {
    if (!this.hullHelper) return;
    const attr = this.hullHelper.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    let o = 0;
    for (const h of this.hulls()) {
      const y0 = 0.18;
      const y1 = 0.72;
      const x0 = h.cx - h.hx;
      const x1 = h.cx + h.hx;
      const z0 = h.cz - h.hz;
      const z1 = h.cz + h.hz;
      const c = [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x0, y1, z1],
      ];
      const edges: [number, number][] = [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 0],
        [4, 5],
        [5, 6],
        [6, 7],
        [7, 4],
        [0, 4],
        [1, 5],
        [2, 6],
        [3, 7],
      ];
      for (const [a, b] of edges) {
        const pa = c[a]!;
        const pb = c[b]!;
        arr[o++] = pa[0]!;
        arr[o++] = pa[1]!;
        arr[o++] = pa[2]!;
        arr[o++] = pb[0]!;
        arr[o++] = pb[1]!;
        arr[o++] = pb[2]!;
      }
    }
    attr.needsUpdate = true;
  }

  hulls() {
    if (!this.deform.massActive) return HULLS;
    const frontOff = this.parts.some((p) => p.name === "bumperF" && p.detached);
    const rearOff = this.parts.some((p) => p.name === "bumperR" && p.detached);
    return this.deform.liveHulls(frontOff, rearOff);
  }

  crushHulls() {
    if (!this.deform.massActive) return CRUSH_HULLS;
    const frontOff = this.parts.some((p) => p.name === "bumperF" && p.detached);
    const rearOff = this.parts.some((p) => p.name === "bumperR" && p.detached);
    return this.deform.liveCrushHulls(frontOff, rearOff);
  }

  spawn(x: number, z: number, speed: number): void {
    this.resetVisual();
    this.group.position.set(x, 0, z);
    this.group.lookAt(0, 0, 0);
    this.refreshBasis();
    this.yaw = Math.atan2(this.forward.x, this.forward.z);
    this.group.rotation.set(0, this.yaw, 0, "YXZ");
    this.roll = 0;
    this.pitch = 0;
    this.speed = speed;
    this.spawnSpeed = speed;
    this.crashed = false;
    this.angular.set(0, 0, 0);
    this.refreshBasis();
    this.velocity.copy(this.forward).multiplyScalar(speed);
    this.deform.bindKinematic(this.group, this.velocity, this.angular);
    this.resetLamps();
  }

  spawnFacing(x: number, z: number, yaw: number, speed: number): void {
    this.resetVisual();
    this.yaw = yaw;
    this.group.position.set(x, 0, z);
    this.group.rotation.set(0, yaw, 0, "YXZ");
    this.roll = 0;
    this.pitch = 0;
    this.speed = speed;
    this.spawnSpeed = speed;
    this.crashed = false;
    this.angular.set(0, 0, 0);
    this.refreshBasis();
    this.velocity.copy(this.fwdFlat).multiplyScalar(speed);
    this.deform.bindKinematic(this.group, this.velocity, this.angular);
    this.resetLamps();
    this.setHighlight(false);
  }

  setHighlight(on: boolean): void {
    if (on) {
      this.bodyMat.emissive.setHex(0xffe08a);
      this.bodyMat.emissiveIntensity = 0.55;
    } else {
      this.bodyMat.emissive.setHex(0x000000);
      this.bodyMat.emissiveIntensity = 0;
    }
    this.bodyMat.needsUpdate = true;
  }

  resetVisual(): void {
    this.deform.reset();
    this.deform.restoreRest(this.body.geometry);
    this.restoreRest(this.hood.geometry, this.hoodRest);
    this.restoreRest(this.trunk.geometry, this.trunkRest);
    this.restoreRest(this.doorMeshL.geometry, this.doorLRest);
    this.restoreRest(this.doorMeshR.geometry, this.doorRRest);
    this.wheelSpin = 0;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      const rest = WHEEL_POS[i]!;
      w.position.set(rest[0], rest[1], rest[2]);
      w.rotation.set(0, 0, 0);
      w.visible = true;
    }
    this.bodyMat.roughness = 0.42;
    this.setHighlight(false);
    this.group.rotation.set(0, 0, 0);
    this.interior.scale.set(1, 1, 1);
    this.interior.position.set(0, 0, 0);

    for (const p of this.parts) {
      if (p.detached) {
        this.world.remove(p.object);
        if (p.name === "mirrorL") this.doorL.add(p.object);
        else if (p.name === "mirrorR") this.doorR.add(p.object);
        else this.group.add(p.object);
      }
      p.detached = false;
      p.folding = false;
      p.hingeT = 0;
      p.object.position.copy(p.restPos);
      p.object.quaternion.copy(p.restQuat);
      p.object.rotation.set(0, 0, 0);
      p.object.scale.set(1, 1, 1);
      p.object.visible = true;
      p.velocity.set(0, 0, 0);
      p.angular.set(0, 0, 0);
    }
    for (const g of this.glassPanes) {
      g.state = "intact";
      g.mesh.visible = true;
      g.mesh.position.copy(g.restPos);
      if (g.restVerts) this.restoreRest(g.mesh.geometry, g.restVerts);
      g.mat.opacity = 0.78;
      g.mat.map = null;
      g.mat.roughness = 0.06;
      g.mat.needsUpdate = true;
    }
    this.resetLamps();
  }

  private resetLamps(): void {
    for (const lamp of this.lamps) {
      lamp.intact = true;
      if (lamp.kind === "head") {
        lamp.mat.color.setHex(0xf4f1e8);
        lamp.mat.emissive.setHex(0xf4f1e8);
        lamp.mat.emissiveIntensity = 1.15;
      } else {
        lamp.mat.color.setHex(0xc4121c);
        lamp.mat.emissive.setHex(0xe01018);
        lamp.mat.emissiveIntensity = 2.6;
      }
      lamp.mat.needsUpdate = true;
    }
  }

  refreshBasis(): void {
    this.group.updateMatrixWorld();
    this.forward.set(0, 0, 1).applyQuaternion(this.group.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.group.quaternion);
    const fl = Math.hypot(this.forward.x, this.forward.z);
    if (fl > 1e-6) this.fwdFlat.set(this.forward.x / fl, 0, this.forward.z / fl);
    else this.fwdFlat.set(0, 0, 1);
    this.rightFlat.set(this.fwdFlat.z, 0, -this.fwdFlat.x);
  }

  worldToLocalPoint(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return this.group.worldToLocal(out.copy(world));
  }

  worldToLocalDir(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    this.group.updateMatrixWorld();
    const inv = _inv.copy(this.group.quaternion).invert();
    return out.copy(world).applyQuaternion(inv).normalize();
  }

  applyImpact(worldPoint: THREE.Vector3, worldInward: THREE.Vector3, impulse: number): void {
    this.crashed = true;
    const localP = this.worldToLocalPoint(worldPoint, _p);
    _in.copy(worldInward);
    _in.y = 0;
    _v.copy(this.group.position).sub(worldPoint);
    _v.y = 0;
    if (_v.lengthSq() > 1e-8) {
      _v.normalize();
      if (_in.dot(_v) < 0) _in.negate();
    }
    const localN = this.worldToLocalDir(_in, _n);
    this.deform.beginCrush(localP, localN, impulse, this.group, this.velocity, this.angular);
    this.deform.impulseAt(worldPoint, _in, impulse);
    this.bodyMat.roughness = Math.min(0.82, 0.42 + impulse * 0.012);
  }

  syncPose(dt: number): void {
    this.deform.followGroup(this.group, this.velocity, this.angular, dt);
    this.yaw = this.group.rotation.y;
    this.roll = this.group.rotation.z;
    this.pitch = this.group.rotation.x;
    this.refreshBasis();
  }

  afterContacts(dt: number, bounce?: WorldBounce): void {
    if (!this.deform.massActive) return;
    this.nudgeWheels(dt);
    this.stepLooseParts(dt, bounce);
  }

  snapshot(): Record<string, unknown> {
    return {
      name: this.paint.name,
      crashed: this.crashed,
      pos: { x: round4(this.group.position.x), y: round4(this.group.position.y), z: round4(this.group.position.z) },
      vel: { x: round4(this.velocity.x), y: round4(this.velocity.y), z: round4(this.velocity.z) },
      speed: round4(this.velocity.length()),
      angular: { x: round4(this.angular.x), y: round4(this.angular.y), z: round4(this.angular.z) },
      yaw: round4(this.yaw),
      pitch: round4(this.pitch),
      roll: round4(this.roll),
      spawnSpeed: round4(this.spawnSpeed),
      deform: this.deform.snapshot(),
      parts: this.parts.map((p) => ({
        name: p.name,
        detached: p.detached,
        folding: p.folding,
        hingeT: round4(p.hingeT),
        pos: { x: round4(p.object.position.x), y: round4(p.object.position.y), z: round4(p.object.position.z) },
        vel: { x: round4(p.velocity.x), y: round4(p.velocity.y), z: round4(p.velocity.z) },
      })),
      lamps: this.lamps.map((l) => ({
        kind: l.kind,
        side: l.side,
        intact: l.intact,
        on: l.intact && l.mat.emissiveIntensity > 0.05,
      })),
      glass: this.glassPanes.map((g) => g.state),
    };
  }

  step(dt: number): void {
    this.integrate(dt);
    this.updateDeform(dt);
  }

  integrate(dt: number): void {
    if (this.deform.massActive) {
      this.syncPose(dt);
      this.nudgeWheels(dt);
      this.stepLooseParts(dt);
      return;
    }
    if (!this.crashed) {
      this.velocity.y -= 9.6 * dt;
      this.group.position.addScaledVector(this.velocity, dt);
      this.wheelSpin += (this.speed / 0.32) * dt;
      for (const w of this.wheels) w.rotation.x = this.wheelSpin;
      this.deform.bindKinematic(this.group, this.velocity, this.angular);
    } else {
      this.velocity.y -= 9.6 * dt;
      this.velocity.x *= Math.pow(0.28, dt);
      this.velocity.z *= Math.pow(0.28, dt);
      this.angular.multiplyScalar(Math.pow(0.45, dt));
      this.group.position.addScaledVector(this.velocity, dt);
      this.yaw += this.angular.y * dt;
      this.roll = THREE.MathUtils.damp(this.roll, this.angular.z * 0.15, 4, dt);
      this.pitch = THREE.MathUtils.damp(this.pitch, this.angular.x * 0.12, 4, dt);
      this.group.rotation.set(this.pitch, this.yaw, this.roll, "YXZ");
      const v = this.velocity.length();
      this.wheelSpin += (v / 0.32) * dt;
      for (const w of this.wheels) w.rotation.x = this.wheelSpin;
    }
    if (this.group.position.y < 0) {
      this.group.position.y = 0;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }
    this.refreshBasis();
    this.stepLooseParts(dt);
  }

  updateDeform(dt: number): void {
    this.deform.update(dt, this.body.geometry);
    if (this.crashed) {
      if (this.deform.skinnedThisFrame) {
        const detached = (name: string) => this.parts.some((p) => p.name === name && p.detached);
        if (!detached("hood"))
          this.deform.skinPanel(this.hood.geometry, this.hoodRest, "bonnet", this.hoodOrigin);
        if (!detached("trunk"))
          this.deform.skinPanel(this.trunk.geometry, this.trunkRest, "boot", this.trunkOrigin);
        const origin = _zero;
        for (const g of this.glassPanes) {
          if (!g.skin || !g.restVerts || g.state === "shattered") continue;
          this.deform.skinPanel(g.mesh.geometry, g.restVerts, g.skin, origin);
        }
      }
      this.syncAttachedParts(dt);
      this.followGlass();
      this.evaluateBreakage(this.deform.impulseValue, dt);
    }
    if (this.deform.massActive) this.fitInterior();
    if (this.hullHelper?.visible) this.updateHullHelper();
  }

  private nudgeWheels(dt: number): void {
    const v = this.velocity.length();
    if (!this.deform.drivetrainAlive) {
      this.wheelSpin *= Math.pow(0.45, dt);
      this.wheelSpin += (v / 0.32) * dt * 0.2;
    } else {
      const drive = this.crashed && this.deform.crushElapsed > 0.05 ? 0.35 : 1;
      this.wheelSpin += (v / 0.32) * dt * drive;
    }
    const hubs = ["hubFL", "hubFR", "hubRL", "hubRR"] as const;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      const rest = WHEEL_POS[i]!;
      w.rotation.x = this.wheelSpin;
      if (!this.deform.massActive) {
        w.position.set(rest[0], rest[1], rest[2]);
        continue;
      }
      const hub = this.deform.massLocal(hubs[i]!);
      const popped = this.deform.hubPopped(hubs[i]!);
      if (!popped) {
        w.position.set(rest[0], THREE.MathUtils.clamp(hub.y, 0.16, 0.55), rest[2]);
        w.visible = true;
        continue;
      }
      w.position.set(
        hub.x,
        THREE.MathUtils.clamp(hub.y, 0.04, 1.4),
        hub.z,
      );
      w.visible = true;
    }
  }

  setRigVisible(v: boolean): void {
    this.deform.setHelperVisible(v);
    if (this.hullHelper) this.hullHelper.visible = v;
    if (v) this.updateHullHelper();
  }

  dispose(): void {
    this.deform.disposeHelper();
    for (const p of this.parts) {
      p.object.removeFromParent();
    }
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m.dispose();
      }
      if (obj instanceof THREE.Light) obj.dispose();
    });
  }

  private syncAttachedParts(dt: number): void {
    const ix = this.deform.impactInward.x;
    const iz = this.deform.impactInward.z;
    for (const p of this.parts) {
      if (p.detached) continue;
      const left = this.deform.sensorCompression(p.attachL);
      const right = this.deform.sensorCompression(p.attachR);
      const crush = Math.max(left, right, this.deform.partCompression(p.cage));
      const local = Math.min(left, right);
      const along = -(p.restPos.x * ix + p.restPos.z * iz);
      const onHit =
        this.deform.bidirectional
          ? Math.abs(p.restPos.z) > 0.8 || Math.abs(p.restPos.x) > 0.5
          : p.hinge === "door"
            ? Math.abs(p.restPos.x * ix) > 0.18 || crush > 0.16 || local > 0.12
            : along > 0.12;

      let target = 0;
      if (onHit) {
        if (p.hinge === "two-point") target = THREE.MathUtils.clamp((crush - 0.04) / 0.55, 0, 1);
        else if (p.hinge === "cowl") target = THREE.MathUtils.clamp((crush - 0.1) / 0.6, 0, 1);
        else if (p.hinge === "tail") target = THREE.MathUtils.clamp((crush - 0.1) / 0.6, 0, 1);
        else if (p.hinge === "door") target = THREE.MathUtils.clamp((Math.max(local, crush) - 0.08) / 0.5, 0, 1);
      }
      p.hingeT = Math.max(p.hingeT, Math.min(target, p.hingeT + Math.max(dt * 3.2, 0.012)));
      const t = p.hingeT;

      p.object.position.copy(p.restPos);
      p.object.quaternion.copy(p.restQuat);
      p.object.scale.set(1, 1, 1);

      if (p.hinge === "two-point") {
        if (p.name.startsWith("bumper")) {
          p.folding = t > 0.04;
          const fl = this.deform.massLocal(p.name === "bumperF" ? "bumperFL" : "bumperRL");
          const fr = this.deform.massLocal(p.name === "bumperF" ? "bumperFR" : "bumperRR");
          p.object.position.set((fl.x + fr.x) * 0.5, (fl.y + fr.y) * 0.5, (fl.z + fr.z) * 0.5);
          const span = Math.abs(fl.z - (p.name === "bumperF" ? 2.06 : -2.06));
          p.object.scale.set(1 + t * 0.04, Math.max(0.45, 1 - t * 0.28), Math.max(0.18, 1 - span * 0.45));
        } else {
          p.folding = t > 0.08;
          const side = p.name === "mirrorL" ? -1 : 1;
          p.object.rotation.z += side * t * 1.4;
          p.object.position.y -= t * 0.12;
          p.object.position.x += side * t * 0.18;
        }
      } else if (p.hinge === "cowl") {
        p.folding = t > 0.06;
        p.object.position.z -= t * 0.08;
        p.object.position.y += t * 0.26;
        p.object.rotation.x = -t * 0.5;
      } else if (p.hinge === "tail") {
        p.folding = t > 0.06;
        p.object.position.z += t * 0.08;
        p.object.position.y += t * 0.22;
        p.object.rotation.x = t * 0.5;
      } else if (p.hinge === "door") {
        p.folding = t > 0.08;
        const sign = p.name === "doorL" ? -1 : 1;
        p.object.rotation.y = -sign * t * 1.45;
        p.object.position.x += sign * t * 0.06;
        p.object.updateWorldMatrix(true, false);
        _box.setFromObject(p.object);
        if (_box.min.y < 0.04) p.object.position.y += 0.04 - _box.min.y;
      }
    }
  }

  private fitInterior(): void {
    if (!this.deform.massActive) {
      this.interior.scale.set(1, 1, 1);
      this.interior.position.set(0, 0, 0);
      return;
    }
    const l = this.deform.massLocal("doorL");
    const r = this.deform.massLocal("doorR");
    const cell = this.deform.massLocal("cell");
    const span = Math.max(0.35, r.x - l.x);
    this.interior.scale.x = THREE.MathUtils.clamp(span / 1.56, 0.32, 1);
    this.interior.position.x = (l.x + r.x) * 0.5;
    this.interior.position.z = cell.z * 0.35;
    this.interior.position.y = THREE.MathUtils.clamp(cell.y - 0.55, -0.08, 0.1);
  }

  private followGlass(): void {
    const inward = this.deform.impactInward;
    for (const g of this.glassPanes) {
      if (g.state === "shattered" || g.skin) continue;
      const onDoor = g.parts.includes("doorLeft") || g.parts.includes("doorRight");
      if (onDoor) continue;
      let nearby = 0;
      for (const part of g.parts) nearby = Math.max(nearby, this.deform.partCompression(part));
      g.mesh.position.copy(g.restPos);
      if (nearby < 0.02) continue;
      g.mesh.position.x += inward.x * nearby * 0.32;
      g.mesh.position.y += inward.y * nearby * 0.12 - nearby * 0.08;
      g.mesh.position.z += inward.z * nearby * 0.32;
    }
  }

  private evaluateBreakage(impulse: number, _dt: number): void {
    void _dt;
    const ix = this.deform.impactInward.x;
    const iz = this.deform.impactInward.z;
    for (const g of this.glassPanes) {
      if (g.state === "shattered") continue;
      let nearby = 0;
      for (const part of g.parts) nearby = Math.max(nearby, this.deform.partCompression(part));
      if (g.state === "intact" && nearby > 0.45 && this.deform.crushElapsed > 0.12) {
        g.state = "cracked";
        g.mat.map = getCrackMap();
        g.mat.opacity = 0.55;
        g.mat.roughness = 0.32;
        g.mat.needsUpdate = true;
      }
      if (
        (nearby > 0.7 && this.deform.crushElapsed > 0.2) ||
        (nearby > 0.55 && impulse > 40 && this.deform.crushElapsed > 0.16)
      ) {
        this.shatterGlass(g);
      }
    }

    for (const p of this.parts) {
      if (p.detached) continue;
      if (this.deform.bidirectional && p.hinge !== "door" && p.hinge !== "two-point") continue;
      const along = -(p.restPos.x * ix + p.restPos.z * iz);
      const crush = Math.max(this.deform.sensorCompression(p.attachL), this.deform.sensorCompression(p.attachR), this.deform.partCompression(p.cage));
      const onHit =
        p.hinge === "door"
          ? Math.abs(p.restPos.x * ix) > 0.18 || crush > 0.16
          : along > 0.12;
      if (!onHit) continue;
      let should = false;
      if (p.name.startsWith("mirror") && p.hingeT > 0.5) should = true;
      if (p.name === "bumperF" && p.hingeT > 0.7) should = true;
      if (p.name === "bumperR" && p.hingeT > 0.7) should = true;
      if (p.hinge === "cowl" && p.hingeT > 0.78) should = true;
      if (p.hinge === "tail" && p.hingeT > 0.78) should = true;
      if ((p.name === "doorL" || p.name === "doorR") && p.hingeT > 0.58) should = true;
      if (should) {
        this.detachPart(p, impulse);
      }
    }

    for (const lamp of this.lamps) {
      if (!lamp.intact) continue;
      let crush = 0;
      for (const s of lamp.sensors) crush = Math.max(crush, this.deform.sensorCompression(s));
      for (const part of lamp.parts) crush = Math.max(crush, this.deform.partCompression(part));
      if (crush > 0.18 && this.deform.crushElapsed > 0.02) this.breakLamp(lamp);
    }
  }

  private breakLamp(lamp: Lamp): void {
    lamp.intact = false;
    lamp.mat.color.setHex(0x3a3c40);
    lamp.mat.emissive.setHex(0x1a1b1c);
    lamp.mat.emissiveIntensity = 0.12;
    lamp.mat.needsUpdate = true;
  }

  private detachPart(p: DetachPart, impulse: number): void {
    if (p.detached) return;
    p.detached = true;
    this.group.updateMatrixWorld();
    const wpos = new THREE.Vector3();
    const wquat = new THREE.Quaternion();
    p.object.getWorldPosition(wpos);
    p.object.getWorldQuaternion(wquat);
    this.group.remove(p.object);
    this.world.add(p.object);
    p.object.position.copy(wpos);
    p.object.quaternion.copy(wquat);
    _p.copy(wpos).sub(this.group.position).setY(0);
    if (_p.lengthSq() < 1e-6) _p.set(p.restPos.x, 0, p.restPos.z).applyQuaternion(this.group.quaternion);
    _p.normalize();
    p.velocity.copy(this.velocity);
    p.velocity.addScaledVector(_p, 2.2 + Math.min(5, impulse * 0.06));
    p.velocity.y += 2.1 + p.hingeT * 1.2;
    p.angular.set(
      (Math.random() - 0.5) * 6,
      (Math.random() - 0.5) * 5,
      (Math.random() - 0.5) * 6,
    );
    if (p.hinge === "door") p.angular.y += (p.name === "doorL" ? -1 : 1) * (3.2 + p.hingeT * 2.4);
    else if (p.hinge === "cowl") p.angular.x -= 3.4;
    else if (p.hinge === "tail") p.angular.x += 3.4;
    p.object.position.addScaledVector(_p, 0.14);
    p.object.position.y += 0.08;
  }

  private shatterGlass(g: GlassPane): void {
    g.state = "shattered";
    g.mesh.visible = false;
    this.group.updateMatrixWorld();
    const origin = new THREE.Vector3();
    g.mesh.getWorldPosition(origin);
    origin.y += 0.12;
    _p.copy(origin).sub(this.group.position);
    const vel = new THREE.Vector3(
      this.velocity.x - this.angular.y * _p.z,
      this.velocity.y + 1.5 + Math.abs(this.angular.x) * 2,
      this.velocity.z + this.angular.y * _p.x,
    );
    this.onGlass?.(origin, vel, 56);
  }

  private stepLooseParts(dt: number, bounce?: WorldBounce): void {
    for (const p of this.parts) {
      if (!p.detached) continue;
      p.velocity.y -= 9.6 * dt;
      p.object.position.addScaledVector(p.velocity, dt);
      const spin = p.angular.length();
      if (spin > 1e-5) {
        _n.copy(p.angular).multiplyScalar(1 / spin);
        _qSpin.setFromAxisAngle(_n, spin * dt);
        p.object.quaternion.premultiply(_qSpin);
      }
      p.angular.multiplyScalar(Math.pow(0.72, dt));
      bounce?.(p.object.position, p.velocity, Math.min(0.22, p.radius * 0.45));
      if (p.object.position.y < 0.12) {
        p.object.position.y = 0.12;
        if (p.velocity.y < 0) p.velocity.y *= -0.28;
        p.velocity.x *= 0.96;
        p.velocity.z *= 0.96;
        p.angular.multiplyScalar(0.9);
      }
    }
  }
}
const _qSpin = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();
const _in = new THREE.Vector3();
const _inv = new THREE.Quaternion();
const _zero = new THREE.Vector3();
const _box = new THREE.Box3();
