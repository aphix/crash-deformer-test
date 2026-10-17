import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fetchSubmissions } from "./fetch-submissions.mjs";
import { roundCard } from "../src/game/engine/bench-card.ts";

const TOKEN = "owner-token-".padEnd(40, "x");
const ROWS = [
  { id: "BBBB-2222", kind: "flag", receivedAt: "2026-10-07T10:05:00Z", sha: "3295bad", size: 900 },
  { id: "AAAA-1111", kind: "bench", receivedAt: "2026-10-07T10:00:00Z", sha: "3295bad", size: 1200 },
];

/** A server that answers the way `submissions.server.ts` does: a list, and one submission by receipt. `refuse429` first answers that many requests with 429. */
function server(rows = ROWS, refuse429 = 0) {
  const calls = [];
  let refused = 0;
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.authorization });
    if (refused < refuse429) {
      refused++;
      return new Response('{"error":"rate limited"}', { status: 429 });
    }
    if (init.headers.authorization !== `Bearer ${TOKEN}`) return new Response('{"error":"unauthorized"}', { status: 401 });
    const u = new URL(url);
    const id = u.searchParams.get("id");
    if (id === null) return Response.json({ submissions: rows });
    const row = rows.find((r) => r.id === id);
    return row ? Response.json({ ...row, submission: row.submission ?? { kind: row.kind } }) : new Response('{"error":"not found"}', { status: 404 });
  };
  return { fetchImpl, calls };
}

const tempDir = () => mkdtemp(path.join(os.tmpdir(), "submissions-"));
const noPause = async () => {};

describe("given an owner pulling submissions from the server", () => {
  it("when it fetches a list of two, then each is saved as its receipt id's JSON file, with the owner token as a bearer header", async () => {
    const out = await tempDir();
    const { fetchImpl, calls } = server();
    const result = await fetchSubmissions({ base: "https://game.test/crush", token: TOKEN, out, fetchImpl, pause: noPause });
    assert.deepEqual(result, { saved: ["AAAA-1111", "BBBB-2222"], skipped: [] });
    assert.deepEqual((await readdir(out)).sort(), ["AAAA-1111.json", "BBBB-2222.json"]);
    assert.equal(JSON.parse(await readFile(path.join(out, "AAAA-1111.json"), "utf8")).submission.kind, "bench");
    assert.deepEqual(calls.map((c) => c.url), [
      "https://game.test/crush/api/submissions?limit=50",
      "https://game.test/crush/api/submissions?id=AAAA-1111",
      "https://game.test/crush/api/submissions?id=BBBB-2222",
    ]);
    assert.equal(new Set(calls.map((c) => c.auth)).size, 1);
  });

  it("when it is run again, then the submissions already saved are not fetched again", async () => {
    const out = await tempDir();
    await fetchSubmissions({ base: "https://game.test/crush/", token: TOKEN, out, fetchImpl: server().fetchImpl, pause: noPause });
    const { fetchImpl, calls } = server();
    const result = await fetchSubmissions({ base: "https://game.test/crush/", token: TOKEN, out, fetchImpl, pause: noPause });
    assert.deepEqual(result, { saved: [], skipped: ["AAAA-1111", "BBBB-2222"] });
    assert.equal(calls.length, 1, "only the list was asked for");
  });

  it("when a kind and a limit are given, then the list request carries them", async () => {
    const { fetchImpl, calls } = server([]);
    await fetchSubmissions({ base: "https://game.test/crush/", token: TOKEN, out: await tempDir(), kind: "flag", limit: 5, fetchImpl, pause: noPause });
    assert.equal(calls[0].url, "https://game.test/crush/api/submissions?limit=5&kind=flag");
  });

  it("when one receipt is asked for, then only that one is fetched, with no list request", async () => {
    const { fetchImpl, calls } = server();
    await fetchSubmissions({ base: "https://game.test/crush/", token: TOKEN, out: await tempDir(), id: "BBBB-2222", fetchImpl, pause: noPause });
    assert.deepEqual(calls.map((c) => c.url), ["https://game.test/crush/api/submissions?id=BBBB-2222"]);
  });

  it("when the server rate-limits the first requests, then the script waits and carries on instead of failing", async () => {
    const pauses = [];
    const { fetchImpl } = server(ROWS, 2);
    const result = await fetchSubmissions({ base: "https://game.test/crush/", token: TOKEN, out: await tempDir(), fetchImpl, pause: async (ms) => void pauses.push(ms) });
    assert.equal(result.saved.length, 2);
    assert.equal(pauses.length, 2);
  });
});

const PHASED = {
  id: "CCCC-3333",
  kind: "bench",
  receivedAt: "2026-10-17T10:00:00Z",
  sha: "3e214dff",
  size: 20000,
  submission: {
    kind: "bench",
    payload: {
      result: {
        course: "city",
        simMsPerSimS: 215.5,
        phases: { msPerSimS: { drive: 30.25, wreck: 80 }, unattributedMsPerSimS: 5, workPerSimS: { steps: 240, skins: 479.6 } },
        longTasks: { count: 4, totalMs: 312.5, maxMs: 120 },
        device: { battery: { start: { charging: false, level: 0.83 }, end: { charging: true, level: 0.81 } } },
      },
    },
  },
};
const OLD_CARD = { id: "DDDD-4444", kind: "bench", receivedAt: "2026-10-01T10:00:00Z", sha: "3295bad", size: 11000, submission: { kind: "bench", payload: { result: { course: "city", simMsPerSimS: 212 } } } };

describe("given the owner asks for each bench card's phase table (--phases)", () => {
  it("when a card carries phases and another is from before them, then each prints its table or says it has none, a flag clip prints nothing, and a card already saved prints too", async () => {
    const out = await tempDir();
    const rows = [ROWS[0], OLD_CARD, PHASED];
    const lines = [];
    await fetchSubmissions({ base: "https://game.test/crush/", token: TOKEN, out, fetchImpl: server(rows).fetchImpl, pause: noPause, phases: true, log: (l) => lines.push(l) });
    const table = lines.filter((l) => l.startsWith("    "));
    assert.deepEqual(table, [
      "    city 215.5 ms/sim-s = drive 30.3  wreck 80.0  unattributed 5.0",
      "    per sim-s: steps 240  skins 480",
      "    4 long tasks, 312.5 ms; battery 83 % -> 81 % charging",
      "    phases: none (a card from before the phase timing)",
    ]);
    const again = [];
    await fetchSubmissions({ base: "https://game.test/crush/", token: TOKEN, out, fetchImpl: server(rows).fetchImpl, pause: noPause, phases: true, log: (l) => again.push(l) });
    assert.deepEqual(again, table, "the saved cards print their tables without a fetch");
    const quiet = [];
    await fetchSubmissions({ base: "https://game.test/crush/", token: TOKEN, out, fetchImpl: server(rows).fetchImpl, pause: noPause, log: (l) => quiet.push(l) });
    assert.deepEqual(quiet, [], "no flag, no table");
  });
});

describe("given a bench card from before the card was shortened and the same card as it is sent now", () => {
  const fixture = JSON.parse(readFileSync(new URL("../src/game/engine/bench-card.fixture.json", import.meta.url), "utf8"));
  const phases = { msPerSimS: { drive: 30.2512, wreck: 80.0444 }, unattributedMsPerSimS: 5.0321, workPerSimS: { steps: 240.4, skins: 479.6 } };
  const longTasks = { count: 4, totalMs: 312.5, maxMs: 120 };
  const card = (result, hud) => ({ id: "EEEE-5555", kind: "bench", receivedAt: "2026-10-17T10:00:00Z", sha: "519348d", size: 1, submission: { kind: "bench", payload: { hud, result } } });
  const old = card({ ...fixture.result, phases, longTasks }, fixture.hud);
  const now = card(roundCard({ ...fixture.result, phases, longTasks }), {});

  it("when each is pulled with --phases, then both print the same table", async () => {
    const tables = [];
    for (const row of [old, now]) {
      const lines = [];
      await fetchSubmissions({ base: "https://game.test/crush/", token: TOKEN, out: await tempDir(), fetchImpl: server([row]).fetchImpl, pause: noPause, phases: true, log: (l) => lines.push(l) });
      tables.push(lines.filter((l) => l.startsWith("    ")));
    }
    assert.equal(tables[0].length, 3, tables[0].join("\n"));
    assert.deepEqual(tables[1], tables[0]);
  });
});

describe("given a pull that must fail loudly", () => {
  const cases = [
    { it: "no token is set", options: { token: undefined }, error: /SUBMISSIONS_OWNER_TOKEN is not set/ },
    { it: "the token is too short to be the owner's", options: { token: "short" }, error: /SUBMISSIONS_OWNER_TOKEN is not set/ },
    { it: "the token is wrong", options: { token: `${TOKEN}y` }, error: /401 unauthorized/ },
    { it: "the kind is not a kind", options: { kind: "../x" }, error: /--kind is one of/ },
    { it: "the receipt id is not a receipt id", options: { id: "../../etc/passwd" }, error: /--id is a receipt id/ },
  ];
  for (const testCase of cases) {
    it(`when ${testCase.it}, then it stops with a message and saves nothing`, async () => {
      const out = await tempDir();
      await assert.rejects(fetchSubmissions({ base: "https://game.test/crush/", token: TOKEN, out, fetchImpl: server().fetchImpl, pause: noPause, ...testCase.options }), testCase.error);
      assert.deepEqual(await readdir(out), []);
    });
  }

  it("when the server's list names an id that is not a receipt id, then it is never written as a file name", async () => {
    const out = await tempDir();
    const rows = [{ ...ROWS[0], id: "../../evil" }, ROWS[1]];
    const result = await fetchSubmissions({ base: "https://game.test/crush/", token: TOKEN, out, fetchImpl: server(rows).fetchImpl, pause: noPause });
    assert.deepEqual(result.saved, ["AAAA-1111"]);
    assert.deepEqual(await readdir(out), ["AAAA-1111.json"]);
  });
});
