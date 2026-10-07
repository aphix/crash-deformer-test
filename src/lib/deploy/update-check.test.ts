import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, fetchDeployedSha, newerBuild, planReload, settleReload } from "./update-check.ts";

/** A browser's local storage, in memory. */
function memoryStore(): Storage {
  const rows = new Map<string, string>();
  return {
    get length() {
      return rows.size;
    },
    clear: () => rows.clear(),
    getItem: (k: string) => rows.get(k) ?? null,
    key: (i: number) => [...rows.keys()][i] ?? null,
    removeItem: (k: string) => void rows.delete(k),
    setItem: (k: string, v: string) => void rows.set(k, v),
  };
}

function replying(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as typeof fetch;
}

const MIN = 60_000;
const HREF = "https://game.test/crush/?bench=city#seed=7";

describe("given the running build and the sha the server's version file names", () => {
  const cases = [
    { it: "the server names a different build", running: "3295bad", deployed: "a1b2c3d", expected: "a1b2c3d" },
    { it: "the server names the same build", running: "3295bad", deployed: "3295bad", expected: null },
    { it: "the version file could not be read", running: "3295bad", deployed: null, expected: null },
    { it: "the server's build had no git (dev)", running: "3295bad", deployed: "dev", expected: null },
    { it: "the running build had no git (dev)", running: "dev", deployed: "a1b2c3d", expected: null },
  ];
  for (const testCase of cases) {
    it(`when ${testCase.it}, then the newer build is ${testCase.expected ?? "none"}`, () => {
      assert.equal(newerBuild(testCase.running, testCase.deployed), testCase.expected);
    });
  }
});

describe("given the version file the build emits", () => {
  const cases = [
    { it: "it names a sha", fetcher: replying('{"sha":"3295bad"}'), expected: "3295bad" },
    { it: "the server answers an error page", fetcher: replying("<html>404</html>", 404), expected: null },
    { it: "the server answers HTML with a 200 (a single-page fallback)", fetcher: replying("<html></html>"), expected: null },
    { it: "the sha holds a path", fetcher: replying('{"sha":"../../x"}'), expected: null },
    { it: "the sha is not text", fetcher: replying('{"sha":12}'), expected: null },
    { it: "there is no network", fetcher: (async () => Promise.reject(new TypeError("offline"))) as typeof fetch, expected: null },
  ];
  for (const testCase of cases) {
    it(`when ${testCase.it}, then the deployed sha read is ${testCase.expected ?? "none"}`, async () => {
      assert.equal(await fetchDeployedSha(testCase.fetcher), testCase.expected);
    });
  }
});

describe("given an unattended page that keeps finding a newer build deployed", () => {
  it("when a reload goes and the page comes back still on the old build, then the next ones wait 2, 4, 8 ... minutes, and a new deploy goes at once", () => {
    const store = memoryStore();
    // The page asks every 30 s; the server's file says a1b2c3d, the page keeps coming back on 3295bad.
    const goes: number[] = [];
    for (let t = 0; t <= 20 * MIN; t += MIN / 2) if (planReload(store, HREF, "a1b2c3d", t) !== null) goes.push(t);
    assert.deepEqual(goes, [0, 2 * MIN, 6 * MIN, 14 * MIN]);
    assert.notEqual(planReload(store, HREF, "f00ba12", 15 * MIN), null, "another build is not held back by the first one's backoff");
  });

  it("when the backoff has grown past an hour of waiting, then it stays at an hour", () => {
    assert.deepEqual([1, 2, 3, 5, 6, 20].map(backoffMs), [2 * MIN, 4 * MIN, 8 * MIN, 32 * MIN, 60 * MIN, 60 * MIN]);
  });

  it("when the reload lands on the new build, then the record is spent and the next deploy starts from a first reload", () => {
    const store = memoryStore();
    planReload(store, HREF, "a1b2c3d", 0);
    settleReload(store, "a1b2c3d");
    assert.equal(store.length, 0);
    assert.notEqual(planReload(store, HREF, "a1b2c3d", 1000), null);
  });

  it("when the reload lands on a different build than it went for, then the record is kept", () => {
    const store = memoryStore();
    planReload(store, HREF, "a1b2c3d", 0);
    settleReload(store, "3295bad");
    assert.equal(planReload(store, HREF, "a1b2c3d", 1000), null);
  });

  it("when the device's clock is set back past the last reload, then the reload is not held for the whole jump", () => {
    const store = memoryStore();
    planReload(store, HREF, "a1b2c3d", 10 * MIN);
    assert.notEqual(planReload(store, HREF, "a1b2c3d", 0), null);
  });

  it("when a person taps the notice during the backoff, then the reload goes and counts toward the next backoff", () => {
    const store = memoryStore();
    planReload(store, HREF, "a1b2c3d", 0);
    assert.equal(planReload(store, HREF, "a1b2c3d", MIN), null);
    assert.notEqual(planReload(store, HREF, "a1b2c3d", MIN, true), null);
    assert.equal(planReload(store, HREF, "a1b2c3d", 4 * MIN), null, "the tap was the second try: 4 minutes more");
    assert.notEqual(planReload(store, HREF, "a1b2c3d", 5 * MIN), null);
  });

  it("when storage cannot remember the attempt, then no automatic reload goes (it could not back off), but a tap does", () => {
    assert.equal(planReload(null, HREF, "a1b2c3d", 0), null);
    assert.notEqual(planReload(null, HREF, "a1b2c3d", 0, true), null);
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };
    assert.equal(planReload(full, HREF, "a1b2c3d", 0), null);
  });
});

describe("given a page address with a query and a share fragment", () => {
  it("when the reload goes, then it keeps the query and the fragment and adds the deployed sha as v", () => {
    assert.equal(planReload(memoryStore(), HREF, "a1b2c3d", 0), "https://game.test/crush/?bench=city&v=a1b2c3d#seed=7");
  });

  it("when the address already carries an older v, then the reload replaces it", () => {
    assert.equal(planReload(memoryStore(), "https://game.test/crush/?v=old", "a1b2c3d", 0), "https://game.test/crush/?v=a1b2c3d");
  });
});
