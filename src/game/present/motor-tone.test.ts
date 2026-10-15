import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { REV_IDLE, VEHICLE_CLASS_IDS, type VehicleClassId } from "../vehicle/vehicle-classes.ts";
import { accelLoad, channelGains, damageTone, MOTOR_OUTPUT_GAIN, MOTOR_SOUND_CREDIT, motorLoad, motorRev, motorRpm, TONE_COUNT, toneMessage, toneMessages, toneOptions } from "./motor-tone.ts";

const EPS = 1e-9;
const SAMPLE_RATE = 48000;
const SEDAN: VehicleClassId = "sedan";

/** The keys the vendored processor reads off a port message (`kernels/motor/motor-processor.js`, `applyMessage`). */
function processorMessageKeys(): string[] {
  const source = readFileSync(new URL("../../../kernels/motor/motor-processor.js", import.meta.url), "utf8");
  const applied = source.slice(source.indexOf("applyMessage (parameters)"), source.indexOf("static get parameterDescriptors"));
  return [...applied.matchAll(/parameters\["([a-z_]+)"\]/g)].map((m) => m[1]!).sort();
}

describe("given each vehicle class's engine", () => {
  for (const cls of VEHICLE_CLASS_IDS) {
    const idleRpm = motorRpm(cls, REV_IDLE, 1);
    const redlineRpm = motorRpm(cls, 1, 1);
    it(`when ${cls} idles, then its rpm is above zero and under its redline`, () => {
      assert.ok(idleRpm > 0 && idleRpm < redlineRpm);
    });
    it(`when ${cls} is in slow-mo at the pitch floor, then its redline drops to a quarter`, () => {
      assert.ok(Math.abs(motorRpm(cls, 1, 0.032) - 0.25 * redlineRpm) < EPS);
    });
    it(`when ${cls} is in slow-mo below the floor, then the pitch stops at the floor`, () => {
      assert.equal(motorRpm(cls, 1, 0), motorRpm(cls, 1, 0.25));
    });
  }
  const pitch = [
    { cls: "sedan", idle: 850, redline: 6800 },
    { cls: "police", idle: 800, redline: 7000 },
    { cls: "muscle", idle: 700, redline: 6200 },
    { cls: "truck", idle: 650, redline: 5000 },
    { cls: "monster", idle: 600, redline: 5500 },
  ] as const;
  for (const c of pitch) {
    it(`when ${c.cls} sits at the idle and the redline of the gauge, then the rpm is ${c.idle} and ${c.redline}`, () => {
      assert.ok(Math.abs(motorRpm(c.cls, REV_IDLE, 1) - c.idle) < EPS);
      assert.ok(Math.abs(motorRpm(c.cls, 1, 1) - c.redline) < EPS);
    });
  }
});

describe("given the revs the gas lifts", () => {
  const testCases = [
    { name: "a standing car under full gas", gauge: REV_IDLE, load: 1, expected: REV_IDLE + 0.35 },
    { name: "a fast car with no gas", gauge: 0.9, load: 0, expected: 0.9 },
    { name: "a standing car with no gas", gauge: REV_IDLE, load: 0, expected: REV_IDLE },
  ];
  for (const c of testCases) {
    it(`when ${c.name}, then the revs are ${c.expected}`, () => {
      assert.ok(Math.abs(motorRev(c.gauge, c.load) - c.expected) < EPS);
    });
  }
});

describe("given the engine load", () => {
  const testCases = [
    { name: "no pedal and no acceleration", throttle: 0, boost: 0, accel: 0, expected: 0 },
    { name: "full reverse", throttle: -1, boost: 0, accel: 0, expected: 1 },
    { name: "full boost thrust with a lifted pedal", throttle: 0, boost: 1, accel: 0, expected: 1 },
    { name: "half the pedal", throttle: 0.5, boost: 0, accel: 0.2, expected: 0.5 },
    { name: "no pedal but 4 m/s gained in 1 s (a netplay client's car)", throttle: 0, boost: 0, accel: accelLoad(4, 0, 1), expected: 1 },
    { name: "no pedal but 2 m/s gained in 1 s", throttle: 0, boost: 0, accel: accelLoad(2, 0, 1), expected: 0.5 },
    { name: "no pedal and slowing down", throttle: 0, boost: 0, accel: accelLoad(0, 4, 1), expected: 0 },
  ];
  for (const c of testCases) {
    it(`when ${c.name}, then the load is ${c.expected}`, () => {
      assert.ok(Math.abs(motorLoad(c.throttle, c.boost, c.accel) - c.expected) < EPS);
    });
  }
});

describe("given the channel levels ahead of the output gain (the demo's 100% each, tilted per class)", () => {
  const out = new Float64Array(3);
  for (const cls of VEHICLE_CLASS_IDS) {
    it(`when ${cls} is tuned, then every channel is audible and no louder than 1.5 (the output gain scales the sum)`, () => {
      channelGains(out, cls);
      for (const level of out) assert.ok(level > 0 && level <= 1.5);
    });
  }
  it("when the sedan is tuned, then it is lighter than the demo: the block and the outlet sit under the demo's 100%", () => {
    channelGains(out, SEDAN);
    assert.ok(out[1]! < 1 && out[2]! < 1 && out[0]! > 1);
  });
  it("when the monster is tuned, then its outlet is louder than the sedan's", () => {
    channelGains(out, SEDAN);
    const sedan = out[2]!;
    channelGains(out, "monster");
    assert.ok(out[2]! > sedan);
  });
  it("when the output gain is set, then it is at most the demo's own 10% default (the summed channels swing to +-7: nothing clips them)", () => {
    assert.ok(MOTOR_OUTPUT_GAIN > 0 && MOTOR_OUTPUT_GAIN <= 0.1);
  });
});

describe("given the class tweaks", () => {
  const sedan = toneOptions(SEDAN, 44100);
  for (const cls of VEHICLE_CLASS_IDS) {
    if (cls === SEDAN) continue;
    it(`when ${cls} is compared with the sedan, then at least two of cylinders, idle, redline and straight pipe differ`, () => {
      const options = toneOptions(cls, 44100);
      const differs = [
        options.cylinders !== sedan.cylinders,
        motorRpm(cls, REV_IDLE, 1) !== motorRpm(SEDAN, REV_IDLE, 1),
        motorRpm(cls, 1, 1) !== motorRpm(SEDAN, 1, 1),
        options.straightPipeWaveguideLength !== sedan.straightPipeWaveguideLength,
      ];
      assert.ok(differs.filter(Boolean).length >= 2);
    });
  }
});

describe("given the class table against the demo's defaults (4 cylinders, waveguides 100, straight pipe 128, outlet 5, ignition 0.016, action 0.1)", () => {
  const testCases = [
    { cls: "sedan", cylinders: 4, intake: 90, exhaust: 90, straightPipe: 109, outlet: 4, ignition: 0.0144, action: 0.09 },
    { cls: "police", cylinders: 4, intake: 95, exhaust: 100, straightPipe: 134, outlet: 5, ignition: 0.0152, action: 0.1 },
    { cls: "muscle", cylinders: 4, intake: 105, exhaust: 110, straightPipe: 154, outlet: 6, ignition: 0.0176, action: 0.11 },
    { cls: "truck", cylinders: 4, intake: 120, exhaust: 125, straightPipe: 192, outlet: 8, ignition: 0.02, action: 0.085 },
    { cls: "monster", cylinders: 6, intake: 130, exhaust: 140, straightPipe: 230, outlet: 10, ignition: 0.0224, action: 0.12 },
  ] as const;
  for (const c of testCases) {
    const o = toneOptions(c.cls, 44100);
    it(`when ${c.cls} is built at 44.1 kHz, then each part is the demo's value times its class factor`, () => {
      assert.equal(o.cylinders, c.cylinders);
      assert.equal(o.intakeWaveguideLength, c.intake);
      assert.equal(o.exhaustWaveguideLength, c.exhaust);
      assert.equal(o.straightPipeWaveguideLength, c.straightPipe);
      assert.equal(o.outletWaveguideLength, c.outlet);
      assert.ok(Math.abs(o.ignitionTime - c.ignition) < EPS);
      assert.ok(Math.abs(o.action - c.action) < EPS);
    });
  }
});

describe("given the classes ordered light to deep", () => {
  const order = ["sedan", "police", "muscle", "truck", "monster"] as const;
  for (let i = 1; i < order.length; i++) {
    const lighter = toneOptions(order[i - 1]!, 44100);
    const deeper = toneOptions(order[i]!, 44100);
    it(`when ${order[i]} is compared with ${order[i - 1]}, then its exhaust, straight pipe and ignition are no shorter`, () => {
      assert.ok(deeper.exhaustWaveguideLength >= lighter.exhaustWaveguideLength);
      assert.ok(deeper.straightPipeWaveguideLength >= lighter.straightPipeWaveguideLength);
      assert.ok(deeper.ignitionTime >= lighter.ignitionTime);
    });
  }
});

describe("given the generator options of each class at 48 kHz", () => {
  for (const cls of VEHICLE_CLASS_IDS) {
    const o = toneOptions(cls, SAMPLE_RATE);
    const lengths = [o.intakeWaveguideLength, o.exhaustWaveguideLength, o.extractorWaveguideLength, o.outletWaveguideLength, ...o.mufflerElementsLength];
    it(`when ${cls} is built, then the cylinders are 1-8 and the waveguide lengths are whole samples in 1-200`, () => {
      assert.ok(o.cylinders >= 1 && o.cylinders <= 8 && Number.isInteger(o.cylinders));
      for (const length of lengths) assert.ok(Number.isInteger(length) && length >= 1 && length <= 200);
    });
    it(`when ${cls} is built, then the straight pipe is 1-500, the ignition 0.01-0.5 and the action 0-0.2`, () => {
      assert.ok(Number.isInteger(o.straightPipeWaveguideLength) && o.straightPipeWaveguideLength >= 1 && o.straightPipeWaveguideLength <= 500);
      assert.ok(o.ignitionTime >= 0.01 && o.ignitionTime <= 0.5);
      assert.ok(o.action >= 0 && o.action <= 0.2);
    });
    it(`when ${cls} is built, then the reflection factors are in 0-1`, () => {
      const factors = [o.intakeOpenReflectionFactor, o.intakeClosedReflectionFactor, o.exhaustOpenReflectionFactor, o.exhaustClosedReflectionFactor, o.straightPipeReflectionFactor, o.outletReflectionFactor];
      for (const f of factors) assert.ok(f >= 0 && f <= 1);
    });
  }
  it("when the sedan is built at 48 kHz, then its 90-sample waveguide (0.9 x the demo's 100) scales by 48000/44100 and rounds", () => {
    assert.equal(toneOptions(SEDAN, 48000).intakeWaveguideLength, Math.round((90 * 48000) / 44100));
  });
  it("when a length would round to zero, then it stays at least one sample", () => {
    assert.equal(toneOptions(SEDAN, 1000).outletWaveguideLength, 1);
  });
});

describe("given the damage stages", () => {
  it("when the stages worsen, then the misfires rise from none", () => {
    assert.equal(damageTone("healthy").misfirePerS, 0);
    assert.ok(damageTone("damaged").misfirePerS > damageTone("healthy").misfirePerS);
    assert.ok(damageTone("limping").misfirePerS > damageTone("damaged").misfirePerS);
  });
  it("when the stages worsen, then the muffling lowpass closes", () => {
    assert.ok(damageTone("limping").cutoffHz < damageTone("damaged").cutoffHz);
    assert.ok(damageTone("damaged").cutoffHz < damageTone("healthy").cutoffHz);
  });
  for (const cls of VEHICLE_CLASS_IDS) {
    it(`when ${cls} limps, then its ignition time is 1.6 x the healthy one`, () => {
      const limping = toneMessage(cls, "limping", SAMPLE_RATE).ignition_time;
      const healthy = toneMessage(cls, "healthy", SAMPLE_RATE).ignition_time;
      assert.ok(Math.abs(limping - 1.6 * healthy) < EPS);
    });
    it(`when ${cls} is damaged, then its ignition time is 1.25 x the healthy one`, () => {
      const damaged = toneMessage(cls, "damaged", SAMPLE_RATE).ignition_time;
      const healthy = toneMessage(cls, "healthy", SAMPLE_RATE).ignition_time;
      assert.ok(Math.abs(damaged - 1.25 * healthy) < EPS);
    });
    it(`when ${cls} limps, then the message ignition time stays inside the generator's range`, () => {
      const ignition = toneMessage(cls, "limping", SAMPLE_RATE).ignition_time;
      assert.ok(ignition >= 0.01 && ignition <= 0.5);
    });
    it(`when ${cls} wears, then its muffler action is 0.8 x (damaged) and 0.6 x (limping) the healthy one`, () => {
      const healthy = toneMessage(cls, "healthy", SAMPLE_RATE).action;
      assert.ok(Math.abs(toneMessage(cls, "damaged", SAMPLE_RATE).action - 0.8 * healthy) < EPS);
      assert.ok(Math.abs(toneMessage(cls, "limping", SAMPLE_RATE).action - 0.6 * healthy) < EPS);
    });
  }
  it("when a message is built, then its keys are the processor's port.onmessage keys", () => {
    assert.equal(Object.keys(toneMessage(SEDAN, "healthy", SAMPLE_RATE)).sort().join(), processorMessageKeys().join());
  });
  it("when a message is built, then its lengths match the class options", () => {
    const o = toneOptions("muscle", SAMPLE_RATE);
    const m = toneMessage("muscle", "healthy", SAMPLE_RATE);
    assert.equal(m.cylinder_count, o.cylinders);
    assert.equal(m.exhaust_waveguide_length, o.exhaustWaveguideLength);
    assert.equal(m.muffler_elements_length.join(), o.mufflerElementsLength.join());
  });
  const tuning = [
    { stage: "healthy", toneIndex: 0 },
    { stage: "dented", toneIndex: 0 },
    { stage: "damaged", toneIndex: 1 },
    { stage: "limping", toneIndex: 2 },
    { stage: "dead", toneIndex: 2 },
  ] as const;
  for (const c of tuning) {
    it(`when a car is ${c.stage}, then it plays tuning ${c.toneIndex} (a dented engine is not re-tuned)`, () => {
      assert.equal(damageTone(c.stage).toneIndex, c.toneIndex);
    });
  }
  it("when every tuning message is prebuilt, then there are TONE_COUNT per class in class order and each matches its stage", () => {
    const all = toneMessages(SAMPLE_RATE);
    assert.equal(all.length, VEHICLE_CLASS_IDS.length * TONE_COUNT);
    for (const [c, cls] of VEHICLE_CLASS_IDS.entries()) {
      assert.equal(all[c * TONE_COUNT]!.ignition_time, toneMessage(cls, "healthy", SAMPLE_RATE).ignition_time);
      assert.equal(all[c * TONE_COUNT + damageTone("damaged").toneIndex]!.ignition_time, toneMessage(cls, "damaged", SAMPLE_RATE).ignition_time);
      assert.equal(all[c * TONE_COUNT + damageTone("limping").toneIndex]!.ignition_time, toneMessage(cls, "limping", SAMPLE_RATE).ignition_time);
    }
  });
});

describe("given the engine sound's credit", () => {
  it("when the credit is compared with the vendored licence, then the licence carries its copyright notice and the MIT name", () => {
    const licence = readFileSync(new URL("../../../kernels/motor/LICENSE", import.meta.url), "utf8");
    assert.ok(licence.includes(MOTOR_SOUND_CREDIT.notice));
    assert.ok(licence.includes("MIT"));
  });
});

