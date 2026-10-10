import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAGE_STEP, CAGE_VERTICES, type CageSource, CarCage } from "./car-cage.ts";
import { cageGaps, cageLiveOf, cageOf, cageSourceOf, fitToDrawn } from "./car-cage.test-util.ts";
import { BODIES, carInState, drawnField, STATES, TOP_P95_M, TOP_PARTS, TOP_WORST_M, topGapsOff } from "./drawn-body.test-util.ts";

/**
 * docs/UNIFIED_CONTACT.md stage 3, "the cage is the body": the cage fitted to a car is the drawn body, in every state the body
 * can be in, on the 5 cm lattice (the 10 cm one misses the p95 bar in 11 of 60 part cases, the 5 cm in 6; docs in the handoff). The fit is read per part (hood, cabin, deck) in
 * the car's own frame against the 5 cm drawn field, as `car-top-fit.test.ts` reads the surface other cars stand on.
 */

/**
 * The parts the cage is off the drawn top by more than the bars, read against the drawn relief (the 3 x 3 neighbourhood clamp of
 * `reliefGap`, p95 and worst alike): measured p95 / worst (m) against the 0.05 / 0.10 bars. Each is a todo for the Stage 3 lane.
 */
const interiorThroughRoof =
  "the drawn interior (its headliner stands 1.09 m over the origin and does not follow the roof mass) pokes up through the roof the drop crushed, so the drawn top is the interior and the cage's is the roof (the cage carries the interior over a gone pane's opening only: over the whole roof it takes stack-crush.test.ts to 6 of 8); closes when the drawn interior follows the roof's crush";
const edgeCliffs: readonly { key: string; part: string; measured: string; cause: string }[] = [
  { key: "sedan/rolled", part: "cabin", measured: "p95 0.061 (bar 0.05), worst 0.078 under (bar 0.10)", cause: interiorThroughRoof },
  { key: "pickup truck/rolled", part: "cabin", measured: "p95 0.062 (bar 0.05), worst 0.077 under (bar 0.10)", cause: interiorThroughRoof },
  { key: "monster pickup/rolled", part: "cabin", measured: "p95 0.062 (bar 0.05), worst 0.078 under (bar 0.10)", cause: interiorThroughRoof },
];

for (const body of BODIES) {
  for (const state of STATES) {
    const cliffs = edgeCliffs.filter((c) => c.key === `${body.body}/${state.id}`);
    describe(`given a ${body.body} body ${state.text} and a ${CAGE_STEP * 100} cm cage`, () => {
      it(`when the cage's top is read over its hood, cabin and deck, then it lies within ${TOP_P95_M * 100} cm of the drawn top (95th percentile), ${TOP_WORST_M * 100} cm at worst, and answers over the drawn part`, (t) => {
        const car = carInState(state.id, body.style, body.cls);
        const cage = cageOf(car);
        fitToDrawn(car, cage);
        const field = drawnField(car);
        const wrong: string[] = [];
        for (const [part, region] of Object.entries(TOP_PARTS)) {
          const g = cageGaps(car, cage, field, region);
          t.diagnostic(`${part}: cells ${g.cells} p95 ${g.p95.toFixed(3)} up ${g.worstUp.toFixed(3)} down ${g.worstDown.toFixed(3)} missing ${g.missing}`);
          if (cliffs.some((c) => c.part === part)) continue;
          wrong.push(...topGapsOff(part, g));
        }
        assert.deepEqual(wrong, []);
      });
      for (const cliff of cliffs) it.todo(`the cage's ${cliff.part} within the bars (measured ${cliff.measured}: ${cliff.cause}; Stage 3 lane)`);
    });
  }
}

describe("given the cage's vertex budget", () => {
  it("when a style's cage is built, then it has about a hundred vertices", () => {
    const car = carInState("untouched", "sedan", "sedan");
    const cage = cageOf(car);
    assert.ok(cage.style.vertexCount <= CAGE_VERTICES + 2 && cage.style.vertexCount >= CAGE_VERTICES / 2, `${cage.style.vertexCount} vertices`);
    assert.ok(cage.style.triCount >= 150 && cage.style.triCount <= 330, `${cage.style.triCount} triangles`);
  });
});

describe("given a pristine car and a crushed car of one style", () => {
  it("when both are fitted, then the pristine one stands on the style's shared fields and the crushed one on its own", () => {
    const pristine = carInState("untouched", "sedan", "sedan");
    const crushed = carInState("loaded", "sedan", "sedan");
    const a = cageOf(pristine);
    const b = cageOf(crushed);
    fitToDrawn(pristine, a);
    fitToDrawn(crushed, b);
    assert.equal(a.pristine, true);
    assert.equal(b.pristine, false);
    assert.equal(a.fields, a.style.pristine);
    assert.notEqual(b.fields, b.style.pristine);
    assert.equal(cageOf(pristine).style, a.style);
  });
});

describe("given a fitted car whose masses have not moved", () => {
  it("when it is fitted again, then nothing is refitted and the fields stay where they are", () => {
    const car = carInState("loaded", "sedan", "sedan");
    const cage = cageOf(car);
    assert.equal(fitToDrawn(car, cage), true);
    const fields = cage.fields;
    const serial = cage.serial;
    assert.equal(cage.refit(cageLiveOf(car)), false);
    assert.equal(cage.fields, fields);
    assert.equal(cage.serial, serial);
  });
});

describe("given a crushed car refitted over and over", () => {
  it("when its masses move each time, then the cage's own buffers are the ones written, never new ones", () => {
    const car = carInState("loaded", "sedan", "sedan");
    const cage = cageOf(car);
    fitToDrawn(car, cage);
    const own = cage.fields;
    const top = own.top;
    const pos = own.pos;
    for (let k = 1; k <= 4; k++) {
      car.deform.masses[0]!.local.y += 0.01 * k;
      car.deform["loadDirty"][0] = 1;
      fitToDrawn(car, cage);
      assert.equal(cage.fields, own);
      assert.equal(cage.fields.top, top);
      assert.equal(cage.fields.pos, pos);
    }
  });
});

describe("given two cages asked for one style key", () => {
  it("when they are built from one source, then the source is read once and they share the style", () => {
    const car = carInState("untouched", "pickup", "truck");
    const key = {};
    let reads = 0;
    const source = (): CageSource => {
      reads++;
      return cageSourceOf(car);
    };
    const a = CarCage.shared(key, source);
    const b = CarCage.shared(key, source);
    assert.equal(reads, 1);
    assert.equal(a.style, b.style);
  });
});

describe("given a pristine sedan's cage", () => {
  it("when its plan distance field is read along the car's width, then it is negative inside, positive outside, and changes by at most one node's width from node to node", () => {
    const car = carInState("untouched", "sedan", "sedan");
    const cage = cageOf(car);
    const { nu, step, u0, v0 } = cage.style;
    const plan = cage.planField();
    const row = Math.round((0 - v0) / step) * nu;
    assert.ok(plan[row + Math.round((0 - u0) / step)]! < 0, `centre ${plan[row + Math.round((0 - u0) / step)]}`);
    assert.ok(plan[row]! > 0 && plan[row + nu - 1]! > 0, `edges ${plan[row]} ${plan[row + nu - 1]}`);
    for (let i = 1; i < nu; i++) assert.ok(Math.abs(plan[row + i]! - plan[row + i - 1]!) <= step + 1e-6, `node ${i}: ${plan[row + i - 1]} to ${plan[row + i]}`);
  });
});

describe("given a car dropped on its roof, whose glass is gone and whose crushed roof the drawn interior pokes through", () => {
  it("when its cage is fitted with the glass off and as if it were on, then the tops differ over a gone pane's opening alone, never over the roof between them", () => {
    const car = carInState("rolled", "sedan", "sedan");
    const off = cageOf(car);
    fitToDrawn(car, off);
    const live = cageLiveOf(car);
    const gone = Array.from(live.panelOn, (on, k) => (on === 0 && off.style.panelGlass[k] === 1 ? k + 1 : 0)).filter((g) => g > 0);
    assert.ok(gone.length > 0, "fixture: the drop must have shattered a pane");
    live.panelOn.fill(1);
    const on = new CarCage(off.style);
    on.refit(live);
    const { nu, nv, step, u0, v0, vertexCount, vertexGroup } = off.style;
    // Each gone pane's opening: the plan box of its vertices (they stand where the frame holds them).
    const boxes = gone.map((group) => {
      const box = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity };
      for (let i = 0; i < vertexCount; i++) {
        if (vertexGroup[i] !== group) continue;
        box.x0 = Math.min(box.x0, off.fields.pos[i * 3]!);
        box.x1 = Math.max(box.x1, off.fields.pos[i * 3]!);
        box.z0 = Math.min(box.z0, off.fields.pos[i * 3 + 2]!);
        box.z1 = Math.max(box.z1, off.fields.pos[i * 3 + 2]!);
      }
      return box;
    });
    let differ = 0;
    const outside: string[] = [];
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = off.fields.top[j * nu + i]!;
        const b = on.fields.top[j * nu + i]!;
        if (Object.is(a, b)) continue;
        differ++;
        const x = u0 + i * step;
        const z = v0 + j * step;
        if (!boxes.some((q) => x >= q.x0 - 2 * step && x <= q.x1 + 2 * step && z >= q.z0 - 2 * step && z <= q.z1 + 2 * step)) outside.push(`(${x.toFixed(2)}, ${z.toFixed(2)}): ${a} against ${b}`);
      }
    }
    assert.ok(differ > 0, "the opening read the same as the pane");
    assert.deepEqual(outside, []);
  });
});
