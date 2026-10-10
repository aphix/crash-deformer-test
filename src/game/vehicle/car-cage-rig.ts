import * as THREE from "three";
import { cageCoeffs } from "../deform/deform-state.ts";
import { INF_K } from "../deform/deform-build.ts";
import { RES_SLOTS, SKIN_K } from "../deform/deform-rig.ts";
import type { BodyPartName } from "../kernel/rig-spec.ts";
import { CarCage, type CageLive, type CageSource, P_CAP, P_CUT_X, P_CUT_Y, P_CUT_Z, P_ROOF_CLAMP } from "./car-cage.ts";
import type { DeformableCar } from "./car.ts";
import { hingePose, INTERIOR_MASSES } from "./part-pose.ts";
import type { DetachPart } from "./car-core.ts";
import { bodyLift } from "./car-suspension.ts";
import { CLASSES, carClass } from "./vehicle-classes.ts";
import { LID, LIGHT_BAR } from "./constants.ts";

/**
 * The bridge from a car's rig to its cage (`StreamedDeformation`'s skin tables and the inputs `skin` hands the skin kernel, read through the
 * rig's own protected fields) and the car's one cage: `CageRig` is the cage, the inputs it fits from (allocated once) and the refit.
 */

/** A mesh over the body that the rig skins from one cage's lattice (`skinPanel`): the lids, the light bar, the skinned panes. */
interface Panel {
  mesh: THREE.Mesh;
  rest: Float32Array;
  origin: THREE.Vector3;
  part: BodyPartName;
  /** Whether the panel is on the car now: its part not torn off, its pane not shattered (state, never the drawn mesh's parent). */
  on: () => boolean;
  /** The part whose hinge poses it (`hingePose`); null for a skinned pane, which stands at `seat`. */
  hinged: DetachPart | null;
  seat: THREE.Vector3;
}

const ZERO = new THREE.Vector3();

/** The rig's own protected fields the cage reads (element access reaches them): its cages, the cluster transforms, the mass positions, the net impact row. */
const CAGES = "cages";
const CLUSTER_XF = "clusterXf";
const MASS_POS = "massPos";
const NET_IMPACT = "netImpact";

/** `car`'s panels, in the order its source lays them out. */
function panelsOf(car: DeformableCar): Panel[] {
  const parts = car["parts"];
  const lid = (mesh: THREE.Mesh, rest: Float32Array, origin: THREE.Vector3, part: BodyPartName): Panel => {
    const hinged = parts.find((p) => p.object === mesh)!;
    return { mesh, rest, origin, part, on: () => !hinged.detached, hinged, seat: ZERO };
  };
  const panels: Panel[] = [lid(car[LID.hood], car["hoodRest"], car["hoodOrigin"], "bonnet"), lid(car[LID.trunk], car["trunkRest"], car["trunkOrigin"], "boot")];
  const bar = car[LIGHT_BAR];
  if (bar !== null) panels.push(lid(bar, car["lightBarRest"]!, car["lightBarOrigin"], "roof"));
  for (const pane of car["glassPanes"]) {
    if (pane.skin === null || pane.restVerts === null) continue;
    panels.push({ mesh: pane.mesh, rest: pane.restVerts, origin: ZERO, part: pane.skin, on: () => pane.state !== "shattered", hinged: null, seat: pane.restPos });
  }
  return panels;
}

/**
 * The rest-only tables of `car`'s drawn body (what `CarCage.shared` reads once per style): the body mesh with its skin tables, then each
 * panel's mesh with the single cage influence `skinPanel` gives its vertices (its place in the cage's box, weight 1).
 */
export function cageSourceOf(car: DeformableCar): CageSource {
  const rig = car.deform;
  const bodyIndex = car.body.geometry.index;
  if (bodyIndex === null) throw new Error("the body mesh has no index");
  const panels = panelsOf(car);
  const bodyCount = rig["vertexCount"];
  let total = bodyCount;
  let triangles = bodyIndex.count;
  for (const panel of panels) {
    total += panel.rest.length / 3;
    triangles += panel.mesh.geometry.index!.count;
  }
  const rest = new Float32Array(total * 3);
  const index = new Uint32Array(triangles);
  const group = new Uint8Array(total);
  const skinN = new Uint8Array(total);
  const skinXf = new Int32Array(total * SKIN_K);
  const skinW = new Float64Array(total * SKIN_K);
  const resJ = new Int32Array(total * RES_SLOTS);
  const resW = new Float64Array(total * RES_SLOTS);
  const resC = new Float64Array(total * 3);
  const skinHub = new Int32Array(total).fill(-1);
  const infN = new Uint8Array(total);
  const infCo = new Int32Array(total * INF_K);
  const infUvw = new Float64Array(total * INF_K * 4);
  rest.set(rig["restPos"].subarray(0, bodyCount * 3));
  skinN.set(rig["skinN"].subarray(0, bodyCount));
  skinXf.set(rig["skinXf"].subarray(0, bodyCount * SKIN_K));
  skinW.set(rig["skinW"].subarray(0, bodyCount * SKIN_K));
  resJ.set(rig["resJ"].subarray(0, bodyCount * RES_SLOTS));
  resW.set(rig["resW"].subarray(0, bodyCount * RES_SLOTS));
  resC.set(rig["resC"].subarray(0, bodyCount * 3));
  skinHub.set(rig["skinHub"].subarray(0, bodyCount));
  infN.set(rig["infN"].subarray(0, bodyCount));
  infCo.set(rig["infCo"].subarray(0, bodyCount * INF_K));
  infUvw.set(rig["infUvw"].subarray(0, bodyCount * INF_K * 4));
  index.set(bodyIndex.array);
  let vertex = bodyCount;
  let at = bodyIndex.count;
  for (const [k, panel] of panels.entries()) {
    const cage = rig["cageByPart"].get(panel.part)!;
    const cageIndex = rig[CAGES].indexOf(cage);
    const inverse = new THREE.Vector3(1 / (cage.size.x || 1), 1 / (cage.size.y || 1), 1 / (cage.size.z || 1));
    const into = new THREE.Vector3().copy(panel.origin).sub(cage.min);
    const count = panel.rest.length / 3;
    for (let i = 0; i < count; i++) {
      const v = vertex + i;
      group[v] = k + 1;
      rest[v * 3] = panel.rest[i * 3]! + panel.origin.x;
      rest[v * 3 + 1] = panel.rest[i * 3 + 1]! + panel.origin.y;
      rest[v * 3 + 2] = panel.rest[i * 3 + 2]! + panel.origin.z;
      infN[v] = 1;
      infCo[v * INF_K] = cageIndex * 24;
      infUvw[v * INF_K * 4] = THREE.MathUtils.clamp((panel.rest[i * 3]! + into.x) * inverse.x, -0.15, 1.15);
      infUvw[v * INF_K * 4 + 1] = THREE.MathUtils.clamp((panel.rest[i * 3 + 1]! + into.y) * inverse.y, -0.15, 1.15);
      infUvw[v * INF_K * 4 + 2] = THREE.MathUtils.clamp((panel.rest[i * 3 + 2]! + into.z) * inverse.z, -0.15, 1.15);
      infUvw[v * INF_K * 4 + 3] = 1;
    }
    const panelIndex = panel.mesh.geometry.index!;
    for (let i = 0; i < panelIndex.count; i++) index[at + i] = panelIndex.getX(i) + vertex;
    vertex += count;
    at += panelIndex.count;
  }
  const panelOrigin = new Float64Array(panels.length * 3);
  for (const [k, panel] of panels.entries()) panel.origin.toArray(panelOrigin, k * 3);
  const massRest = new Float64Array(rig.masses.length * 3);
  for (let j = 0; j < rig.masses.length; j++) {
    const massAt = rig.masses[j]!.rest;
    massRest[j * 3] = massAt.x;
    massRest[j * 3 + 1] = massAt.y;
    massRest[j * 3 + 2] = massAt.z;
  }
  const restCo = new Float64Array(rig[CAGES].length * 24);
  for (let p = 0; p < rig[CAGES].length; p++) cageCoeffs(rig[CAGES][p]!.restCorners, restCo, p * 24);
  const panelGlass = Uint8Array.from(panels, (p) => (p.hinged === null ? 1 : 0));
  const interior = car["interior"].geometry;
  const interiorIndex = interior.index;
  if (interiorIndex === null) throw new Error("the interior mesh has no index");
  const interiorMass = Int32Array.from(INTERIOR_MASSES, (name) => rig.masses.findIndex((m) => m.name === name) * 3);
  return { rest, index, skinN, skinXf, skinW, resJ, resW, resC, skinHub, massRest, clusterCount: rig["clusters"].length, restCo, infN, infCo, infUvw, group, panelCount: panels.length, panelOrigin, panelGlass, interiorRest: Float32Array.from(interior.getAttribute("position").array), interiorIndex: interiorIndex.array, interiorMass };
}

/** A car's cage on the lattice (or `step`), its style's build shared by every car of the style. */
export function cageOf(car: DeformableCar, step?: number): CarCage {
  return CarCage.shared(car.style, () => cageSourceOf(car), step);
}

/** Into `live`: what the sim's last bake left of `car` (the masses baked, the cluster maps and cages solved) and the panels' poses from the parts' state now (`hingePose`), as `StreamedDeformation.skin` hands the kernel. */
function readCageLive(car: DeformableCar, panels: readonly Panel[], live: CageLive): void {
  const rig = car.deform;
  for (let p = 0; p < rig[CAGES].length; p++) cageCoeffs(rig[CAGES][p]!.corners, live.co, p * 24);
  rig["fillKernelHubs"](live.hubs);
  live.params[P_CAP] = rig.mode === "shape" ? 1.35 : 2.2;
  live.params[P_ROOF_CLAMP] = !rig.deepCrush && rig["roofHolds"]() ? 1 : 0;
  live.params[P_CUT_Y] = rig[NET_IMPACT][9]!;
  live.params[P_CUT_X] = rig[NET_IMPACT][10]!;
  live.params[P_CUT_Z] = rig[NET_IMPACT][11]!;
  for (let k = 0; k < panels.length; k++) {
    const panel = panels[k]!;
    live.panelOn[k] = panel.on() ? 1 : 0;
    if (panel.hinged !== null) hingePose(panel.hinged, rig.impactInward.x, live.panelPose, k * 7);
    else {
      panel.seat.toArray(live.panelPose, k * 7);
      live.panelPose.fill(0, k * 7 + 3, k * 7 + 6);
      live.panelPose[k * 7 + 6] = 1;
    }
  }
  live.panelsFollow = car.crashed ? 1 : 0;
}

/**
 * A car's one cage, with the inputs it fits from allocated once (a refit allocates nothing): the car's contact shape, the drawn body as
 * its masses, cluster maps and panels stand after the skin's last solve (`DeformableCar.cage` makes it on first use).
 */
export class CageRig {
  readonly cage: CarCage;
  private readonly car: DeformableCar;
  private readonly panels: Panel[];
  /** The inputs the cage fits from, as of the last `refit` (its tests read them). */
  readonly live: CageLive;

  constructor(car: DeformableCar) {
    const rig = car.deform;
    this.car = car;
    this.cage = cageOf(car);
    this.panels = panelsOf(car);
    this.live = {
      X: rig[CLUSTER_XF],
      pos: rig[MASS_POS],
      hubs: new Float64Array(rig.masses.length * 5),
      params: new Float64Array(P_CUT_Z + 1),
      co: new Float64Array(rig[CAGES].length * 24),
      panelOn: new Uint8Array(this.panels.length),
      panelsFollow: 0,
      panelPose: new Float64Array(this.panels.length * 7),
    };
  }

  /** Fits the cage to the car as its skin last solved (true when the fields changed: `CarCage.refit`). */
  refit(): boolean {
    readCageLive(this.car, this.panels, this.live);
    return this.cage.refit(this.live);
  }
}

/** How far (m) up `car`'s drawn body stands over its frame: its class's lift while upright, none once on its side (`bodyLift`), read off the pose, never off the drawn body (drawn only: heave and pitch). */
export function cageLift(car: DeformableCar): number {
  const q = car.group.quaternion;
  return bodyLift(CLASSES[carClass(car)].lift, 1 - 2 * (q.x * q.x + q.z * q.z));
}

/** The highest (`high`) or lowest node of a cage field (m), the nodes with no height skipped. */
function extent(field: Float32Array, high: boolean): number {
  let best = high ? -Infinity : Infinity;
  for (let k = 0; k < field.length; k++) {
    const h = field[k]!;
    if (high ? h > best : h < best) best = h;
  }
  return best;
}

/** How high (m) over `car`'s origin its roof's crown stands now (class lift on): the body it draws, crushed as it is. */
export function crownY(car: DeformableCar): number {
  car.refitCage();
  return extent(car.cage.fields.top, true) + cageLift(car);
}

/** How high (m) over `car`'s origin its keel rides now (class lift on): a car on another's roof sits its crown less this over that car's origin. */
export function keelY(car: DeformableCar): number {
  car.refitCage();
  return extent(car.cage.fields.bottom, false) + cageLift(car);
}
