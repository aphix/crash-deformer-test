import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Track } from "../world/track.ts";
import { TRACKS } from "../world/tracks/index.ts";
import { benchPlan } from "./engine-bench-plan.ts";
import { advance, autoReloadAsked, BIGGEST_COURSE, cycleOf, isBenchPage, loopProgress, loopSettings, newSession, parseRun, runFromPage, shareHashOf, startRun, stepHref, stepOf, ULTRA_AVAILABLE, type BenchRun } from "./bench-loop.ts";

const RUN: BenchRun = { session: "k3x9q2", loop: 1, step: 0, ultra: false, keep: false, auto: false, ultraNext: false };

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
    { it: "it is on the last step and keep is set", loop: 1, step: 2, keep: true, expectedLoop: 2, expectedStep: 0 },
    { it: "it is on the last step of the third cycle and keep is set", loop: 3, step: 2, keep: true, expectedLoop: 4, expectedStep: 0 },
    { it: "it is on the last step and keep is not set", loop: 1, step: 2, keep: false, expectedLoop: null, expectedStep: null },
  ];
  for (const testCase of cases) {
    it(`when ${testCase.it}, then the loop goes on to ${testCase.expectedLoop ? `cycle ${testCase.expectedLoop} step ${testCase.expectedStep}` : "nothing: it is over"}`, () => {
      const next = advance({ ...RUN, loop: testCase.loop, step: testCase.step, keep: testCase.keep });
      assert.equal(next?.loop ?? null, testCase.expectedLoop, "cycle count");
      assert.equal(next?.step ?? null, testCase.expectedStep, "step");
      assert.equal(next?.session ?? RUN.session, RUN.session, "session");
    });
  }

  it("when the loop runs three cycles from the start, then each submission's loop counter counts the cycle from 1 and the session never changes", () => {
    const seen: string[] = [];
    for (let run: BenchRun | null = { ...startRun("k3x9q2"), ultra: false, ultraNext: false }; run !== null && run.loop <= 3; run = advance(run)) {
      const s = loopSettings(run, stepOf(run));
      seen.push(`${s.session} ${s.loop} ${s.step}`);
    }
    assert.equal(seen.length, 9);
    assert.equal(seen.slice(0, 4).join(" | "), "k3x9q2 1 strip | k3x9q2 1 city | k3x9q2 1 dam-spine | k3x9q2 2 strip");
    assert.equal(new Set(seen.map((s) => s.split(" ")[0])).size, 1);
  });

  it("when a new loop is started, then it keeps benching and reloads onto new builds, with Ultra if this build has it", () => {
    const run = startRun("k3x9q2");
    assert.equal(run.keep, true, "keep");
    assert.equal(run.auto, true, "auto");
    assert.equal(run.ultra, ULTRA_AVAILABLE, "this cycle's Ultra");
    assert.equal(run.ultraNext, ULTRA_AVAILABLE, "the next cycle's Ultra");
  });
});

describe("given a loop whose state is in the address of its bench page", () => {
  const base = "https://game.test/crush/";
  const searchOf = (href: string): string => new URL(href).search;

  it("when the address's loopultra is turned on during a cycle, then that cycle runs its benches unchanged and the next cycle runs each with its Ultra twin", { skip: !ULTRA_AVAILABLE && "this build has no Ultra" }, () => {
    const ids: string[] = [];
    let href = stepHref(base, { ...RUN, keep: true });
    for (let run = parseRun(searchOf(href)); run !== null && run.loop <= 2; run = parseRun(searchOf(href))) {
      ids.push(`${run.loop} ${stepOf(run).id}`);
      const next = advance(run);
      if (next === null) break;
      href = stepHref(base, next);
      if (ids.length === 1) {
        const edited = new URL(href);
        edited.searchParams.set("loopultra", "1");
        href = edited.toString();
      }
    }
    assert.equal(
      ids.join(" | "),
      "1 strip | 1 city | 1 dam-spine | 2 strip | 2 strip+ultra | 2 city | 2 city+ultra | 2 dam-spine | 2 dam-spine+ultra",
    );
  });

  it("when keep is turned off (keep=0) in the address on the second step, then the loop goes on to the last step and ends there", () => {
    const second = new URL(stepHref(base, { ...RUN, step: 1, keep: true }));
    second.searchParams.set("keep", "0");
    const secondRun = parseRun(second.search);
    assert.equal(secondRun?.keep, false, "the edited address reads as keep off");
    const last = advance(secondRun!);
    assert.equal(last?.step, 2, "the step after the edit still runs");
    assert.equal(last?.loop, 1, "the cycle after the edit");
    assert.equal(advance(last!), null, "the loop ends at the cycle's end");
  });

  it("when auto is put into the address of a step, then that step and every step after it carry it", () => {
    const first = new URL(stepHref(base, RUN));
    first.searchParams.set("auto", "1");
    const firstRun = parseRun(first.search);
    assert.equal(firstRun?.auto, true, "the edited address reads as auto on");
    const secondHref = stepHref(base, advance(firstRun!)!);
    assert.equal(new URL(secondHref).searchParams.get("auto"), "1", "the next step's address");
    assert.equal(parseRun(searchOf(secondHref))?.auto, true, "the next step reads it back");
  });

  const hrefCases = [
    { it: "the address has a share fragment and a leftover v", from: `${base}?v=old#seed=7`, run: { ...RUN, step: 2 }, expected: `${base}?bench=city&course=dam-spine&loop=k3x9q2&cycle=1&step=2&keep=0&auto=0&loopultra=0&cycleultra=0` },
    {
      it: "every option is on",
      from: base,
      run: { ...RUN, loop: 3, step: 0, keep: true, auto: true, ultra: true, ultraNext: true },
      expected: `${base}?bench=strip&loop=k3x9q2&cycle=3&step=0&keep=1&auto=1&loopultra=1&cycleultra=1`,
    },
  ];
  for (const testCase of hrefCases) {
    it(`when a step's address is built and ${testCase.it}, then it names the step's bench, the session, the cycle, the step and every option on or off`, () => {
      assert.equal(stepHref(testCase.from, testCase.run), testCase.expected);
    });
  }

  it("when a step's address is read back, then it is the run it was built from", () => {
    const run: BenchRun = { session: "k3x9q2", loop: 7, step: 1, ultra: true, keep: true, auto: false, ultraNext: true };
    const back = parseRun(searchOf(stepHref(base, run)));
    assert.equal(back?.session, run.session, "session");
    assert.equal(back?.loop, run.loop, "cycle count");
    assert.equal(back?.step, run.step, "step");
    assert.equal(back?.ultra, run.ultra, "this cycle's Ultra");
    assert.equal(back?.keep, run.keep, "keep");
    assert.equal(back?.auto, run.auto, "auto");
    assert.equal(back?.ultraNext, run.ultraNext, "the next cycle's Ultra");
  });

  const parseCases = [
    { it: "it names every part of a loop", search: "?bench=city&loop=k3x9q2&cycle=2&step=1&keep=1&auto=1&loopultra=1&cycleultra=1", expected: "k3x9q2 2 1 keep auto ultra ultraNext" },
    { it: "it names only a session, a bench opened by hand that becomes a loop from there", search: "?bench=strip&loop=k3x9q2", expected: ULTRA_AVAILABLE ? "k3x9q2 1 0 keep auto ultraNext" : "k3x9q2 1 0 keep auto" },
    { it: "options are written as 0", search: "?bench=city&loop=k3x9q2&keep=0&auto=0&loopultra=0", expected: "k3x9q2 1 0" },
    { it: "it asks for a bench and names no session", search: "?bench=city", expected: "none" },
    { it: "it names a session but asks for no bench", search: "?loop=k3x9q2", expected: "none" },
    { it: "the session holds a path", search: "?bench=city&loop=../x", expected: "none" },
    { it: "the step is not a whole number", search: "?bench=city&loop=k3x9q2&step=x", expected: "none" },
    { it: "the cycle count is zero", search: "?bench=city&loop=k3x9q2&cycle=0", expected: "none" },
  ];
  for (const testCase of parseCases) {
    it(`when the page's address is read and ${testCase.it}, then the loop read is ${testCase.expected}`, () => {
      const run = parseRun(testCase.search);
      const flags = [run?.keep && "keep", run?.auto && "auto", run?.ultra && "ultra", run?.ultraNext && "ultraNext"].filter(Boolean);
      const read = run === null ? "none" : [`${run.session} ${run.loop} ${run.step}`, ...flags].join(" ");
      assert.equal(read, testCase.expected);
    });
  }
});

describe("given a bench page opened by its address alone, with no loop in it", () => {
  for (const step of cycleOf(ULTRA_AVAILABLE)) {
    it(`when the page is ${step.query}, then it runs as a loop with every option on, at the step that runs that same bench, and moves on after it`, () => {
      const run = runFromPage(`?${step.query}`, "k3x9q2");
      assert.ok(run !== null, "a cycle bench becomes a loop");
      assert.equal(stepOf(run).id, step.id);
      assert.equal(run.keep && run.auto, true, "keep benching and auto-reload on");
      assert.notEqual(advance(run), null, "the loop moves on after this bench");
    });
  }
  for (const search of ["?bench=lab", "?bench=city&course=four-count"]) {
    it(`when the page is ${search}, a bench the cycle doesn't run, then it runs once and is no loop`, () => {
      assert.equal(runFromPage(search, "k3x9q2"), null);
    });
  }
  it("when the page is the strip with keep, auto and loopultra turned off, then the loop it starts has them off and the address it rewrites keeps them off", () => {
    const run = runFromPage("?bench=strip&keep=0&auto=0&loopultra=0", "k3x9q2");
    assert.ok(run !== null);
    assert.equal(run.keep, false, "keep");
    assert.equal(run.auto, false, "auto");
    assert.equal(run.ultraNext, false, "loopultra");
    const back = parseRun(new URL(stepHref("https://game.test/crush/", run)).search);
    assert.ok(back !== null && back.session === "k3x9q2" && back.step === run.step && !back.keep && !back.auto && !back.ultraNext, "the rewritten address keeps them off");
  });
  it("when the page is the strip with only keep turned off, then the options it leaves out are on", () => {
    const run = runFromPage("?bench=strip&keep=0", "k3x9q2");
    assert.ok(run !== null);
    assert.equal(run.keep, false, "keep");
    assert.equal(run.auto, true, "auto");
    assert.equal(run.ultraNext, ULTRA_AVAILABLE, "loopultra");
  });
});

describe("given a loop address that leaves out its options (a loop carried over from an older build)", () => {
  it("when it is read, then keep benching and auto-reload are on, so the loop goes on past its cycle's last bench", () => {
    const run = parseRun("?bench=city&course=dam-spine&loop=af3fa60e&cycle=1&step=2");
    assert.ok(run !== null && run.keep && run.auto);
    assert.notEqual(advance(run), null, "the loop starts its next cycle");
  });
  it("when an option is turned off with =0, then it is off and the address it writes keeps it off", () => {
    const run = parseRun("?bench=strip&loop=af3fa60e&keep=0");
    assert.ok(run !== null && !run.keep);
    assert.equal(parseRun(new URL(stepHref("https://game.test/crush/", run)).search)!.keep, false);
  });
});

describe("given the address of a page", () => {
  const pageCases = [
    { it: "it asks for a bench", search: "?bench=city", expectedBench: true, expectedAuto: false },
    { it: "it asks for a bench and for reloading onto new builds", search: "?bench=strip&auto=1", expectedBench: true, expectedAuto: true },
    { it: "it is the plain game", search: "", expectedBench: false, expectedAuto: false },
    { it: "it only asks for reloading onto new builds", search: "?auto=1", expectedBench: false, expectedAuto: true },
  ];
  for (const testCase of pageCases) {
    it(`when ${testCase.it}, then it ${testCase.expectedBench ? "is" : "is not"} a bench page and it ${testCase.expectedAuto ? "asks" : "does not ask"} for reloading`, () => {
      assert.equal(isBenchPage(testCase.search), testCase.expectedBench, "bench page");
      assert.equal(autoReloadAsked(testCase.search), testCase.expectedAuto, "auto reload");
    });
  }

  it("when a loop is at the second step of its second cycle, then the bench card reads where it is", () => {
    assert.equal(loopProgress({ ...RUN, loop: 2, step: 1 }), "loop 2, step 2/3");
  });
});

describe("given a page whose address carries a share # (a stale one, or one pasted with the bench's query)", () => {
  const hash = "#scene=garage&night=1";
  it("when the page is the bench of the biggest course, then it follows no # at all, so the garage never replaces the bench's own course", () => {
    assert.equal(shareHashOf("?bench=city&course=dam-spine", hash), null);
  });
  it("when the page is a strip bench that a loop sent it to, then it follows no # at all", () => {
    assert.equal(shareHashOf("?bench=strip&loop=af3fa60e&cycle=1&step=0", hash), null);
  });
  it("when the page is the plain game, then it follows its # as it is", () => {
    assert.equal(shareHashOf("", hash), hash);
  });
});

describe("given a page outside a secure context (a build opened over plain http on the LAN), where crypto.randomUUID is missing", () => {
  it("when the Benchmark entry starts a loop, then it gets a session its own bench page reads back as that loop", (t) => {
    t.mock.method(crypto, "randomUUID", () => {
      throw new TypeError("crypto.randomUUID is not a function");
    });
    const run = startRun(newSession());
    const back = parseRun(new URL(stepHref("http://192.168.1.20:3000/", run)).search);
    assert.ok(back !== null && back.session === run.session && back.step === run.step, "the bench page reads its own loop back");
  });
});
