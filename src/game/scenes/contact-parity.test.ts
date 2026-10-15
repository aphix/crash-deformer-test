import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { carDoorPass, carSandwich, carStrike, copIntoSide, crushMismatch, DOOR_FORMS, doorGap, doorHit, onGround, pistonStrike, pressByForce, pressUntil, ramDoorPass, shortening, type CarState, type DoorGap, type Strike } from "./contact-parity.test-util.ts";
import { assertSameDigest } from "../vehicle/test-support.ts";

// docs/CONTACT_PARITY.md: one hit, two deliveries (scene rig vs other cars), same outcome.
const CAR_KG = 858;

/** `run` called once per distinct arguments: a case compares one deterministic run against several others and reads it each time. */
function cached<A extends (string | number | boolean)[], T>(run: (...args: A) => T): (...args: A) => T {
  const seen = new Map<string, T>();
  return (...args) => {
    const key = args.join("/");
    if (!seen.has(key)) seen.set(key, run(...args));
    return seen.get(key)!;
  };
}

function sameParts(x: CarState, y: CarState, what: string): void {
  assertSameDigest(x.detached, y.detached, `${what}: parts off car [${x.detached}] vs rig [${y.detached}]`);
  assert.ok(Math.abs(x.doorDeg - y.doorDeg) <= 3, `${what}: door ${x.doorDeg.toFixed(1)}° vs ${y.doorDeg.toFixed(1)}°`);
  assert.equal(x.latched, y.latched, `${what}: latch`);
  assert.ok(Math.abs(x.mirrorFoldDeg - y.mirrorFoldDeg) <= 3, `${what}: mirror fold ${x.mirrorFoldDeg.toFixed(1)}° vs ${y.mirrorFoldDeg.toFixed(1)}°`);
  assert.equal(x.drivetrainAlive, y.drivetrainAlive, `${what}: drivetrain`);
}

function sameCrush(x: CarState, y: CarState, what: string): void {
  const off = crushMismatch(x, y);
  assert.deepEqual(off, [], `${what}: particle crush (car/rig mm) ${off.join(", ")}`);
  assert.ok(Math.abs(x.cabinMm - y.cabinMm) <= Math.max(10, 0.15 * Math.max(x.cabinMm, y.cabinMm)), `${what}: cabin ${x.cabinMm} vs ${y.cabinMm} mm`);
}

describe("given the Doors ram lane's three scenes (mirror: the striker grazes a shut door's mirror; overOpen: it drives an open door past its stop; shut: it drives an open door shut)", () => {
  for (const scenario of ["mirror", "overOpen", "shut"] as const) {
    for (const kph of [12, 30]) {
      it(`when a ${CAR_KG} kg car at ${kph} km/h runs the ${scenario} scene instead of the ${CAR_KG} kg ram, then the same parts come off and the door, latch, mirror fold, drivetrain and crush match the ram's`, () => {
        const car = carDoorPass(scenario, kph);
        // Same striker geometry: a ram head shaped like the car body on the same lane (the scene's
        // 0.5 m head on the C lane runs under the mirror, a car body does not).
        const ram = ramDoorPass(scenario, kph, CAR_KG, true);
        sameParts(car, ram, scenario);
        sameCrush(car, ram, scenario);
      });
    }
  }
});

describe("given two cars driving into the nose and tail of a middle car, and a press closed to the same shortening", () => {
  it("when each car hits at 20 km/h, then the middle car's parts and crush match the press's", { todo: "after the plan: close the sandwich's car-car crush to the press's at the same shortening; at 20 km/h the car crushes less than the press (car / press mm: engineL 18 / 37, engineR 18 / 37, railL 13 / 25, railR 13 / 25, tank 17 / 36, axleR 20 / 40, bumperRL 22 / 65, bumperRR 22 / 65, wingFL 17 / 28, wingFR 17 / 28)" }, () => {
    const s = carSandwich(20);
    const press = pressUntil((p) => shortening(p.car!) * 1000 >= s.a.shortenMm).state;
    sameParts(s.a, press, "sandwich");
    sameCrush(s.a, press, "sandwich");
  });
});

describe("given two cars driving into the nose and tail of a middle car, and a press whose plates are pushed by the same force over time as the two cars pushed (not closed to a shortening)", () => {
  for (const kph of [10, 20, 30, 40, 60]) {
    it(`when each car hits at ${kph} km/h, then the middle car's parts and crush match the force-driven press's`, { todo: "after the plan: give the force-driven press a crush force independent of the first slice's arming speed, or the sandwich the same law; at every speed 10-60 km/h the press tears quarterR off the middle car where the cars' sandwich tears none (parts off car [] vs rig [quarterR], 5 of 5 speeds red)" }, () => {
      const s = carSandwich(kph);
      const press = pressByForce(s.force).state;
      sameParts(s.a, press, `sandwich ${kph} km/h`);
      sameCrush(s.a, press, `sandwich ${kph} km/h`);
    });
  }
});

/**
 * Since the wreck split (3bf63441): the car-car pair parts about 0.07 s into the hit, so the struck car's contact window (`live`: quiet
 * under 0.35 s) closes at 0.42 s while its nose is still springing back, and the crush freezes: front 20 km/h at softness 0.4, bumperFL
 * peaks at 106 mm (the piston's 112) and stays at 55, where the piston, holding the face, springs back to 30 by 0.6 s. Measured fixes:
 * the window kept open while the shape still springs back faster than 5 mm/s closes rear 30 and the bumper but leaves front 20 and 40
 * off on the rails and the engine block (railL 31 / 17, engine 4 / 32 mm) and breaks barrier.test.ts :43 and :204 and the police
 * side-hit rows; kept open 0.7 s past the hit closes front 10 and 20 but not 30, 40, 60 or rear 30 and breaks the police 10 m/s rows;
 * the springback played out in full where the window closes takes front 20 to 36 / 29 but leaves rear 30 at 67 / 44 (the struck tail's
 * plastic set itself differs) and moves a roof and a bumper 6-7 cm in one slice (crash-parts' per-slice bound).
 */
const FROZEN_SPRINGBACK = "after the plan: the struck car's crush must not depend on how long the striker's contact lasts; since the wreck split the car-car pair parts 0.07 s in, the struck car's contact window closes at 0.42 s mid-springback (front 20 km/h bumperFL 55 mm car / 30 mm piston from the same 106 / 112 mm peak; front 40 wingFL 39 / 24), and the struck tail's plastic set differs even with the springback played out at once (rear 30 bumperRL 67 / 44). Played out one shape pass a slice after the window until no particle moves 0.1 mm, front 20 and rear 30 match and front 40 does not, and a packed nose's second wall hit (35 km/h after 52) then moves the block 0.036 m at squash 0.4 and 0.045 m at 0.32 (0.088 / 0.075 today; barrier bar > 0.04): its springback plays out too";

describe("given a piston and a car of the same mass and speed striking a crushable face", () => {
  for (const kph of [20, 40]) {
    // A car's crushable nose takes its share of the closing (pair-contact EBS split): for equal
    // masses the struck car gets half the reduced-mass energy, the piston's hardness 0.5. Each at
    // main's squash 0.4 and the calibrated 0.32: at 0.32 the 40 km/h block sank 72 mm under a car's
    // nose vs 61 mm under the piston, a bounce frozen when the shorter car-car contact closed the solve.
    it(`when a ${CAR_KG} kg car and a ${CAR_KG} kg piston each hit at ${kph} km/h at crush softness 0.4 and 0.32, then the car's parts and crush match the piston's`, { todo: FROZEN_SPRINGBACK }, () => {
      for (const squash of [0.4, 0.32]) {
        const car = carStrike("front", kph, squash).a;
        const piston = pistonStrike("front", kph, CAR_KG, 0.5, squash);
        sameParts(car, piston, `front, squash ${squash}`);
        sameCrush(car, piston, `front, squash ${squash}`);
      }
    });
  }
});

describe("given a piston and a car of the same mass and speed striking the parked car's nose at the speeds the cases above leave out, and its tail and right side", () => {
  const hits: [Strike, number][] = [["front", 10], ["front", 30], ["front", 60], ["rear", 30], ["right", 30]];
  const PISTON_TODO: Record<string, string> = {
    "front 10": "after the plan: put the car side's push on the same impulse the piston side takes; front 10 km/h at softness 0.4 crushes the engine block 33 mm car / 45 mm piston, tank 32 / 44, bumperRL 32 / 44, rails 6 / 18, wings 4 / 16 (the 15 % bound)",
    "front 30": "after the plan: put the car side's push on the same impulse the piston side takes; front 30 km/h at softness 0.32 crushes bumperFL and bumperFR 76 mm car / 63 mm piston (the 15 % bound)",
    "front 60": "after the plan: put the car side's push on the same impulse the piston side takes; front 60 km/h at softness 0.4 crushes the engine block 63 mm car / 50 mm piston, wings 40 / 21 (the 15 % bound)",
    "right 30": "after the plan: put the car side's push on the same impulse the piston side takes; right 30 km/h at softness 0.4 swings the door 0.0 deg car / 23.1 deg piston (3 deg bound)",
    "rear 30": FROZEN_SPRINGBACK,
  };
  for (const [at, kph] of hits) {
    const todo = PISTON_TODO[`${at} ${kph}`] ?? false;
    it(`when a ${CAR_KG} kg car and a ${CAR_KG} kg piston each hit the ${at} at ${kph} km/h at crush softness 0.4 and 0.32, then the car's parts and crush match the piston's`, { todo }, () => {
      for (const squash of [0.4, 0.32]) {
        const car = carStrike(at, kph, squash).a;
        const piston = pistonStrike(at, kph, CAR_KG, 0.5, squash);
        sameParts(car, piston, `${at}, squash ${squash}`);
        sameCrush(car, piston, `${at}, squash ${squash}`);
      }
    });
  }
});

// The owner's case (shots owner-1..4): a police sedan's nose sat about 1 m inside a sedan's side and neither car was dented.
// The contact tolerance is the skin's own (docs/UNIFIED_CONTACT.md: SKIN 0.2 m).
const SKIN = 0.2;

describe("given a police sedan driving nose-first into the right side of a parked sedan", () => {
  for (const mps of [10, 20, 30]) {
    for (const coarse of [false, true]) {
      it(`when it hits at ${mps} m/s with the sim stepped at 1/${coarse ? 120 : 240} s, then the drawn bodies never overlap by more than ${SKIN} m, and any overlap shows as dent depth in the struck side and the police nose after they separate`, (t) => {
        const hit = copIntoSide(mps, coarse);
        t.diagnostic(`overlap ${hit.overlapM.toFixed(3)} m, struck side intrusion ${hit.intrusionMm} mm, police nose crush ${hit.noseMm} mm`);
        const failures: string[] = [];
        if (hit.overlapM > SKIN) failures.push(`overlap ${hit.overlapM.toFixed(3)} m`);
        const dentM = (hit.intrusionMm + hit.noseMm) / 1000;
        if (dentM < hit.overlapM - SKIN) failures.push(`overlap ${hit.overlapM.toFixed(3)} m, dents only ${dentM.toFixed(3)} m (side ${hit.intrusionMm} mm, nose ${hit.noseMm} mm)`);
        assert.deepEqual(failures, []);
      });
    }
  }
});

// Frame swap (owner): only the relative motion of a hit may matter. Zero-grip control first: with no tyres anywhere the four
// forms of a door hit must agree to the tight bound, or the difference is a defect. The one legitimate frame term is the tyres
// (still in one frame, rolling at v in the other, in neutral with the brakes off: the car loses rolling and air drag on its
// run-up and the door's pendulum feels the car's slowing): bounded by what grip changes in the car-moves form, the forward
// delivery of a rolling car, alone.
const TIGHT = { doorDeg: 0.5, mirrorDeg: 0.5, crushMm: 1, cabinMm: 1 } as const;
const GAP_KEYS = ["doorDeg", "mirrorDeg", "crushMm", "cabinMm"] as const;

function gapLine(g: DoorGap): string {
  return `${g.parts ? "parts=" : "PARTS≠"} ${GAP_KEYS.map((k) => `${k} ${g[k].toFixed(1)}`).join(", ")}`;
}

describe("given every door scene (mirror, overOpen, shut, panelPush, panelPull) on the left and the right side, at 12 and 30 km/h and at striker masses 5, 300, 858 and 5000 kg, each hit delivered four ways: the ram runs into a still car, the car runs into a still ram, a car stands in for the ram, the struck car runs into that still car", () => {
  for (const side of [-1, 1] as const) {
    for (const scenario of ["mirror", "overOpen", "shut", "panelPush", "panelPull"] as const) {
      for (const kph of [12, 30]) {
        for (const kg of [5, 300, CAR_KG, 5000]) {
          // A car stands in for the ram only at a car's own mass.
          const forms = kg === CAR_KG ? DOOR_FORMS : DOOR_FORMS.slice(0, 2);
          const todo = scenario === "shut" && kph === 12 && kg === CAR_KG ? "after the plan: find why the car as the ram folds the shut door's mirror 0.6 deg with no tyre grip (bound 0.5 deg) and 0.8 deg with grip (bound tyre term 0.0 + 0.5 deg) at 12 km/h, left and right; the carStrikes and reversingCar forms only" : false;
          it(`when the ${scenario} hit runs on the ${side < 0 ? "left" : "right"} side at ${kph} km/h with a ${kg} kg striker (${forms.length} forms), then every form breaks off the same parts and leaves the door, latch, mirror, drivetrain and crush as the ram-moves form does, to ${TIGHT.crushMm} mm and ${TIGHT.doorDeg}° with no tyre grip and to that plus the tyres' own effect with grip`, { todo }, (t) => {
            const hit = cached((form: (typeof DOOR_FORMS)[number], grip: boolean) => doorHit(form, scenario, kph, kg, grip, side));
            const reference = hit("ramMoves", true);
            const referenceFree = hit("ramMoves", false);
            const tyre = doorGap(hit("carMoves", false), hit("carMoves", true));
            const failures: string[] = [];
            const rows = [`tyre term (car-moves form, grip vs none): ${gapLine(tyre)}`];
            for (const form of forms.slice(1)) {
              const free = doorGap(referenceFree, hit(form, false));
              const gripped = doorGap(reference, hit(form, true));
              rows.push(`${form}: no grip ${gapLine(free)} | grip ${gapLine(gripped)}`);
              if (!free.parts) failures.push(`${form} without grip: parts, latch or drivetrain differ`);
              if (!gripped.parts) failures.push(`${form} with grip: parts, latch or drivetrain differ`);
              for (const k of GAP_KEYS) {
                if (free[k] > TIGHT[k]) failures.push(`${form} without grip: ${k} ${free[k].toFixed(1)} > ${TIGHT[k]}`);
                if (gripped[k] > tyre[k] + TIGHT[k]) failures.push(`${form} with grip: ${k} ${gripped[k].toFixed(1)} > tyre term ${tyre[k].toFixed(1)} + ${TIGHT[k]}`);
              }
            }
            t.diagnostic(rows.join("\n"));
            assert.deepEqual(failures, []);
          });
        }
      }
    }
  }
});

const SWAPPED_FRAME = "after the plan: put the swapped-frame forms' first slices on the kernel's push and the tyre stop the moving piston gets, so car into piston, striker car moves and struck car moves match it; ";
const SWAPPED_TODO: Record<string, string> = {
  "front 10": `${SWAPPED_FRAME}front 10 km/h: crush 8 mm (car into piston), 25 mm (striker moves, struck moves) over the 1 mm bound`,
  "front 30": `${SWAPPED_FRAME}front 30 km/h: crush 52 mm and cabin 2 mm (car into piston), 37 mm (striker moves, struck moves) over the 1 mm bound`,
  "rear 10": `${SWAPPED_FRAME}rear 10 km/h: crush 9 mm and cabin 3 mm (car into piston), 30 mm (striker moves, struck moves), struck car with grip 33 mm over the tyre term 30 + 1 mm`,
  "rear 30": `${SWAPPED_FRAME}rear 30 km/h: crush 8 mm and cabin 2 mm (car into piston), crush 61 mm and cabin 8 mm (striker moves), crush 62 mm and cabin 9 mm (struck moves) over the 1 mm bound`,
  "right 10": `${SWAPPED_FRAME}right 10 km/h: parts or latch differ with grip in all three forms; crush 17 mm over the 1 mm bound, cabin 13 mm (car into piston)`,
  "right 30": `${SWAPPED_FRAME}right 30 km/h: parts, latch or drivetrain differ in all three forms with and without grip; crush 16 / 85 / 13 mm (car into piston / striker moves / struck moves) over the 1 mm bound, with grip 138 and 144 mm over the tyre term 135 + 1 mm`,
};

describe("given the same hit on the nose, tail and right side of a parked car delivered by a moving piston, by a moving car, and in the swapped frame (the head, or the striker car, standing still while the struck car drives into it)", () => {
  for (const at of ["front", "rear", "right"] as const) {
    for (const kph of [10, 30]) {
      it(`when a ${CAR_KG} kg striker hits the ${at} at ${kph} km/h, then the struck car's parts and crush are the same whichever of the four runs it is, to ${TIGHT.crushMm} mm with no tyre grip and to that plus the tyres' own effect with grip`, { todo: SWAPPED_TODO[`${at} ${kph}`] }, (t) => {
        const runs = {
          pistonMoves: cached((grip: boolean) => onGround(grip, () => pistonStrike(at, kph, CAR_KG, 0.5))),
          carMovesIntoPiston: cached((grip: boolean) => onGround(grip, () => pistonStrike(at, kph, CAR_KG, 0.5, undefined, true))),
          strikerCarMoves: cached((grip: boolean) => onGround(grip, () => carStrike(at, kph).a)),
          struckCarMoves: cached((grip: boolean) => onGround(grip, () => carStrike(at, kph, undefined, true).a)),
        };
        const reference = runs.pistonMoves(true);
        const tyre = doorGap(reference, runs.pistonMoves(false));
        const failures: string[] = [];
        const rows = [`tyre term (piston-moves, grip vs none): ${gapLine(tyre)}`];
        for (const form of ["carMovesIntoPiston", "strikerCarMoves", "struckCarMoves"] as const) {
          const free = doorGap(runs.pistonMoves(false), runs[form](false));
          const gripped = doorGap(reference, runs[form](true));
          rows.push(`${form}: no grip ${gapLine(free)} | grip ${gapLine(gripped)}`);
          if (!free.parts) failures.push(`${form} without grip: parts, latch or drivetrain differ`);
          if (!gripped.parts) failures.push(`${form} with grip: parts, latch or drivetrain differ`);
          for (const k of ["crushMm", "cabinMm"] as const) {
            if (free[k] > TIGHT[k]) failures.push(`${form} without grip: ${k} ${free[k].toFixed(1)} > ${TIGHT[k]}`);
            if (gripped[k] > tyre[k] + TIGHT[k]) failures.push(`${form} with grip: ${k} ${gripped[k].toFixed(1)} > tyre term ${tyre[k].toFixed(1)} + ${TIGHT[k]}`);
          }
        }
        t.diagnostic(rows.join("\n"));
        assert.deepEqual(failures, []);
      });
    }
  }
});
