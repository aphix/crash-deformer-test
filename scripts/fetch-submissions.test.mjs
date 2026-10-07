import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fetchSubmissions } from "./fetch-submissions.mjs";

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
    return row ? Response.json({ ...row, submission: { kind: row.kind } }) : new Response('{"error":"not found"}', { status: 404 });
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
