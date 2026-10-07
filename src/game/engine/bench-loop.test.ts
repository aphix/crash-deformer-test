import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { benchPlan } from "./engine-bench-plan.ts";
import { advance, BIGGEST_COURSE, cycleOf, isStepPage, loopSettings, parseReceipts, parseRun, startRun, stepHref, stepOf, ULTRA_AVAILABLE, withReceipt, type BenchReceiptEntry, type BenchRun } from "./bench-loop.ts";

const RUN: BenchRun = { session: "k3x9q2", loop: 1, step: 0, ultra: false };

describe("given the race courses of the game", () => {
  it("when their roads are measured, then the course the benchmark loop calls the biggest has the longest road", () => {
    const roads = TRACKS.map((raw) => {
      const t = new Track(raw);
      return { id: t.id, length: t.length };
    }).sort((a, b) => b.length - a.length);
    assert.equal(roads[0]!.id, BIGGEST_COURSE, roads.map((r) => `${r.id} ${Math.round(r.length)} m`).join(", "));
    assert.equal(BIGGEST_COURSE, "dam-spine");
  });
});

describe("given one cycle of the benchmark loop", () => {
  it("when the cycle is listed, then it runs the strip, the city and the biggest course, in that order", () => {
    assert.equal(cycleOf(false).map((s) => s.id).join(" "), "strip city dam-spine");
  });

  it("when each step's page query is read as a bench, then every step is a bench the game knows, on the course its name says", () => {
    const plans = cycleOf(false).map((s) => benchPlan(`?${s.query}`)?.id);
    assert.equal(plans.join(" "), "bench city dam-spine");
  });

  it("when a bench is asked for a course that does not exist, then it benches the city instead", () => {
    assert.equal(benchPlan("?bench=city&course=nowhere")?.id, "city");
    assert.equal(benchPlan("?bench=city&course=../../etc")?.id, "city");
  });

  it("when Ultra is included, then every step is followed by its Ultra twin if this build has Ultra, and the cycle is unchanged if it has not", () => {
    const ids = cycleOf(true).map((s) => s.id).join(" ");
    assert.equal(ids, ULTRA_AVAILABLE ? "strip strip+ultra city city+ultra dam-spine dam-spine+ultra" : "strip city dam-spine");
  });
});

describe("given a loop that has just finished a step", () => {
  const cases = [
    { it: "it is on the first step", loop: 1, step: 0, keep: false, expectedLoop: 1, expectedStep: 1 },
    { it: "it is on the second step", loop: 1, step: 1, keep: true, expectedLoop: 1, expectedStep: 2 },
    { it: "it is on the last step and keep benching is ticked", loop: 1, step: 2, keep: true, expectedLoop: 2, expectedStep: 0 },
    { it: "it is on the last step of the third cycle and keep benching is ticked", loop: 3, step: 2, keep: true, expectedLoop: 4, expectedStep: 0 },
    { it: "it is on the last step and keep benching is not ticked", loop: 1, step: 2, keep: false, expectedLoop: null, expectedStep: null },
  ];
  for (const testCase of cases) {
    it(`when ${testCase.it}, then the loop goes on to ${testCase.expectedLoop ? `cycle ${testCase.expectedLoop} step ${testCase.expectedStep}` : "nothing: it is over"}`, () => {
      const next = advance({ ...RUN, loop: testCase.loop, step: testCase.step }, { keep: testCase.keep, ultra: false });
      assert.equal(next?.loop ?? null, testCase.expectedLoop);
      assert.equal(next?.step ?? null, testCase.expectedStep);
      assert.equal(next?.session ?? RUN.session, RUN.session);
    });
  }

  it("when the loop runs three cycles from the start, then each submission's loop counter counts the cycle from 1 and the session never changes", () => {
    const seen: string[] = [];
    for (let run: BenchRun | null = startRun("k3x9q2", false); run !== null && run.loop <= 3; run = advance(run, { keep: true, ultra: false })) {
      const s = loopSettings(run, stepOf(run));
      seen.push(`${s.session} ${s.loop} ${s.step}`);
    }
    assert.equal(seen.length, 9);
    assert.equal(seen.slice(0, 4).join(" | "), "k3x9q2 1 strip | k3x9q2 1 city | k3x9q2 1 dam-spine | k3x9q2 2 strip");
    assert.equal(new Set(seen.map((s) => s.split(" ")[0])).size, 1);
  });

  it("when include Ultra is ticked during a cycle, then that cycle runs its benches unchanged and the next cycle runs each with its Ultra twin", { skip: !ULTRA_AVAILABLE && "this build has no Ultra" }, () => {
    const ids: string[] = [];
    for (let run: BenchRun | null = startRun("k3x9q2", false); run !== null && run.loop <= 2; run = advance(run, { keep: true, ultra: true })) {
      ids.push(`${run.loop} ${stepOf(run).id}`);
    }
    assert.equal(ids.join(" | "), "1 strip | 1 city | 1 dam-spine | 2 strip | 2 strip+ultra | 2 city | 2 city+ultra | 2 dam-spine | 2 dam-spine+ultra");
  });
});

describe("given the address a loop step runs at", () => {
  it("when the page is the game's address with a share fragment and a leftover v, then the step's address keeps the path, names the bench and the session, and drops the rest", () => {
    const step = stepOf({ ...RUN, step: 2 });
    assert.equal(stepHref("https://game.test/crush/?v=old#seed=7", step, RUN), "https://game.test/crush/?bench=city&course=dam-spine&loop=k3x9q2");
  });

  const pageCases = [
    { it: "the page asks for a bench and names the run's session", search: "?bench=city&loop=k3x9q2", run: RUN, expected: true },
    { it: "the page asks for a bench but names no session (opened by hand)", search: "?bench=city", run: RUN, expected: false },
    { it: "the page names another run's session", search: "?bench=city&loop=zzzz99", run: RUN, expected: false },
    { it: "the page names the session but asks for no bench", search: "?loop=k3x9q2", run: RUN, expected: false },
    { it: "no loop is stored", search: "?bench=city&loop=k3x9q2", run: null, expected: false },
  ];
  for (const testCase of pageCases) {
    it(`when ${testCase.it}, then it is ${testCase.expected ? "" : "not "}a step of the loop`, () => {
      assert.equal(isStepPage(testCase.search, testCase.run), testCase.expected);
    });
  }
});

describe("given a run kept in the browser's storage", () => {
  const cases = [
    { it: "a run as stored", text: JSON.stringify(RUN), expectedSession: "k3x9q2" },
    { it: "no entry", text: null, expectedSession: null },
    { it: "text that is not JSON", text: "{nope", expectedSession: null },
    { it: "a session that holds a path", text: JSON.stringify({ ...RUN, session: "../x" }), expectedSession: null },
    { it: "a step that is not a whole number", text: JSON.stringify({ ...RUN, step: "1" }), expectedSession: null },
    { it: "a missing loop counter", text: JSON.stringify({ session: "k3x9q2", step: 0 }), expectedSession: null },
    { it: "a run stored before the cycle carried its Ultra choice (a loop left running across an update)", text: JSON.stringify({ session: "k3x9q2", loop: 1, step: 0 }), expectedSession: "k3x9q2" },
  ];
  for (const testCase of cases) {
    it(`when it holds ${testCase.it}, then the run read is ${testCase.expectedSession ? "that run" : "none"}`, () => {
      const run = parseRun(testCase.text);
      assert.equal(run?.session ?? null, testCase.expectedSession);
      if (run) assert.equal(`${run.loop}/${run.step}`, "1/0");
    });
  }
});

describe("given the receipts a loop keeps in the browser's storage", () => {
  it("when each step's receipt is added and the list is stored and read back after every page load, then every receipt is there in order", () => {
    let stored: string | null = null;
    const ids: string[] = [];
    for (let run: BenchRun | null = startRun("k3x9q2", false); run !== null && run.loop <= 2; run = advance(run, { keep: true, ultra: false })) {
      const id = `R${run.loop}${run.step}AA-BBBB`;
      ids.push(id);
      stored = JSON.stringify(withReceipt(parseReceipts(stored), { loop: run.loop, step: stepOf(run).id, id }));
    }
    assert.equal(parseReceipts(stored).map((r) => r.id).join(" "), ids.join(" "));
  });

  it("when far more receipts are added than the list keeps, then it still ends with the newest and never grows past what it keeps", () => {
    let kept: BenchReceiptEntry[] = [];
    let longest = 0;
    for (let i = 0; i < 500; i++) {
      kept = withReceipt(kept, { loop: i, step: "city", id: `N${i}` });
      longest = Math.max(longest, kept.length);
    }
    assert.equal(kept.at(-1)?.id, "N499");
    assert.equal(kept.length, longest);
    assert.ok(longest < 500, `kept all ${longest}`);
  });

  it("when the stored text is not a list or holds an entry that is not a receipt, then only the real receipts are read", () => {
    assert.deepEqual(parseReceipts("{nope"), []);
    assert.deepEqual(parseReceipts(JSON.stringify({ id: "X" })), []);
    const mixed = JSON.stringify([{ loop: 1, step: "city", id: "AB12-CD34" }, { loop: "1", step: "city", id: "BAD" }, null]);
    assert.equal(parseReceipts(mixed).map((r) => r.id).join(" "), "AB12-CD34");
  });
});
