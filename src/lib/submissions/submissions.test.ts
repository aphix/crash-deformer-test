import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { gzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "@/lib/db";
import { LIMITS } from "../multiplayer/rate-limit.ts";
import { KINDS, MAX_JSON_BYTES, MAX_WIRE_BYTES, RECEIPT_PATTERN, type Envelope, type Kind } from "./kinds.ts";
import { handleSubmissions, STORE_MAX_BYTES, STORE_MAX_ROWS } from "./submissions.server.ts";

const MIGRATIONS = new URL("../../../migrations/", import.meta.url);
const OWNER_TOKEN = "owner-token-".padEnd(40, "x");
/** The clock every request is handled at: address buckets neither refill nor drain between a test's requests. */
const NOW = 1_800_000_000_000;

/** The migrated in-memory database, built once: starting PGlite costs about a second. */
const migrated: Promise<PGlite> = (async () => {
  const pg = new PGlite({ parsers: { 20: Number } }); // int8 as db.ts parses it
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
  }
  return pg;
})();

/** The database with `migrations/*.sql` applied and no submissions, as the relay's tests build theirs. */
async function freshDb(): Promise<Sql> {
  const pg = await migrated;
  await pg.exec("TRUNCATE submissions");
  return { query: async (text: string, params?: unknown[]) => (await pg.query(text, params)).rows } as unknown as Sql;
}

const CLIP_TEXT = "U0NITAAqIAAAAAAAAAAA".repeat(40);
const PAYLOADS: Record<Kind, unknown> = {
  bench: { at: "2026-10-07T10:00:00.000Z", result: { fps: 58.5, build: "3295bad" }, hud: { carCount: 16 } },
  capture: { version: 1, captureTrace: true, samples: [{ t: 0.25, cars: [{ x: 1 }] }, { t: 0.5, cars: [{ x: 2 }] }] },
  flag: { title: "Head-on at the bridge", course: "City", from: "reel", clip: CLIP_TEXT },
};

function envelope(kind: Kind, over: Record<string, unknown> = {}): Envelope & Record<string, unknown> {
  return {
    kind,
    sha: "3295bad",
    at: 1_791_000_000_000,
    ua: "Mozilla/5.0 (X11; Linux x86_64) Test",
    screen: { w: 1920, h: 1080, dpr: 2 },
    scene: "race",
    settings: { scene: "race", seed: 12345, fxTier: "low", night: false, userTimeScale: null, session: "k3x9q2", loop: 2 },
    payload: PAYLOADS[kind],
    ...over,
  };
}

let lastIp = 0;
/** An address no earlier test has used: the limiter lives for the whole process. */
function freshIp(): string {
  lastIp++;
  return `10.20.${lastIp >> 8}.${lastIp & 255}`;
}

interface Listed {
  id: string;
  kind: Kind;
  receivedAt: string;
  sha: string;
  size: number;
}

interface Reply {
  status: number;
  body: {
    error?: string;
    id?: string;
    kind?: Kind;
    sha?: string;
    receivedAt?: string;
    submission?: Record<string, unknown>;
    submissions?: Listed[];
  };
}

/** One request, from its own fresh address unless `ip` is given; the server's owner token is `OWNER_TOKEN` unless `token` says otherwise (null: none configured). */
async function send(sql: Sql, init: RequestInit & { ip?: string; token?: string | null; search?: string; getSql?: () => Promise<Sql> } = {}): Promise<Reply> {
  const { ip = freshIp(), search = "", token = OWNER_TOKEN, getSql, ...rest } = init;
  const headers = { "x-forwarded-for": ip, ...(rest.headers as Record<string, string> | undefined) };
  const request = new Request(`http://game.test/api/submissions${search}`, { ...rest, headers });
  const res = await handleSubmissions(request, getSql ?? (async () => sql), token ?? undefined, NOW);
  return { status: res.status, body: (await res.json()) as Reply["body"] };
}

/** A JSON post: the body as text, or gzipped (`gzip`, with the header a browser's post carries). */
function post(sql: Sql, body: unknown, extra: { ip?: string; headers?: Record<string, string>; gzip?: boolean; getSql?: () => Promise<Sql> } = {}): Promise<Reply> {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return send(sql, {
    method: "POST",
    ip: extra.ip,
    getSql: extra.getSql,
    headers: { "content-type": "application/json", ...(extra.gzip ? { "content-encoding": "gzip" } : {}), ...extra.headers },
    body: extra.gzip ? gzipSync(text) : text,
  });
}

/** A read with the owner's bearer token; `serverToken` is what the server has configured (null: nothing). */
function owner(sql: Sql, search = "", serverToken: string | null = OWNER_TOKEN): Promise<Reply> {
  return send(sql, { search, token: serverToken, headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
}

function listedIds(reply: Reply): string[] {
  return reply.body.submissions!.map((s) => s.id);
}

/** A capture of `samples` samples of numbers that do not repeat, about 1.6 kB each. */
function bigCapture(samples: number): Envelope {
  const rows = Array.from({ length: samples }, (_, i) => ({ t: i / 4, cars: Array.from({ length: 8 }, (_, c) => ({ x: Math.sin(i * 7 + c) * 100, y: Math.cos(i * 3 + c), z: (i * 31 + c * 17) % 977 / 7 })) }));
  return envelope("capture", { payload: { version: 1, samples: rows } }) as Envelope;
}

describe("given the submissions endpoint on a freshly migrated database", () => {
  for (const kind of KINDS) {
    for (const gzip of [false, true]) {
      it(`when a ${kind} submission is posted${gzip ? " gzipped, as a browser sends it" : ""}, then it answers with a receipt id and the owner fetching that id gets back the same build, device, settings and payload`, async () => {
        const sql = await freshDb();
        const sent = envelope(kind);
        const receipt = await post(sql, sent, { gzip });
        assert.equal(receipt.status, 201);
        assert.match(receipt.body.id!, RECEIPT_PATTERN);
        const got = await owner(sql, `?id=${receipt.body.id}`);
        assert.equal(got.status, 200);
        assert.equal(got.body.id, receipt.body.id);
        assert.equal(got.body.kind, kind);
        assert.equal(got.body.sha, "3295bad");
        assert.ok(Math.abs(Date.now() - Date.parse(got.body.receivedAt!)) < 60_000, "the receipt time is the server's, now");
        assert.deepEqual(got.body.submission, sent);
      });
    }
  }

  it("when a capture of 300 samples of non-repeating numbers is posted gzipped, then the owner reads back every sample, and the store holds less than half its bytes", async () => {
    const sql = await freshDb();
    const sent = bigCapture(300);
    const receipt = await post(sql, sent, { gzip: true });
    assert.equal(receipt.status, 201);
    const got = await owner(sql, `?id=${receipt.body.id}`);
    assert.deepEqual(got.body.submission, sent);
    const [listed] = (await owner(sql)).body.submissions!;
    assert.ok(listed!.size < JSON.stringify(sent).length / 2, `${listed!.size} stored bytes for ${JSON.stringify(sent).length} sent`);
  });

  it("when two submissions are posted, then their receipt ids differ", async () => {
    const sql = await freshDb();
    const a = await post(sql, envelope("bench"));
    const b = await post(sql, envelope("bench"));
    assert.notEqual(a.body.id, b.body.id);
  });

  it("when a submission carries a field the endpoint does not know, then the owner never sees that field", async () => {
    const sql = await freshDb();
    const receipt = await post(sql, envelope("bench", { admin: true }));
    const got = await owner(sql, `?id=${receipt.body.id}`);
    assert.equal("admin" in got.body.submission!, false);
  });
});

describe("given the submissions endpoint refusing what it must refuse", () => {
  const refusedCases = [
    { it: "the body is not JSON", body: "{not json", status: 400 },
    { it: "the body is a JSON array", body: "[]", status: 400 },
    { it: "the kind is not one of bench, capture, flag", body: envelope("bench", { kind: "../../etc" }), status: 400 },
    { it: "the build sha holds a path", body: envelope("bench", { sha: "../../x" }), status: 400 },
    { it: "the build sha is empty", body: envelope("bench", { sha: "" }), status: 400 },
    { it: "the user agent is missing", body: envelope("bench", { ua: undefined }), status: 400 },
    { it: "the user agent is over 512 characters", body: envelope("bench", { ua: "u".repeat(513) }), status: 400 },
    { it: "the screen has a negative width", body: envelope("bench", { screen: { w: -1, h: 10, dpr: 1 } }), status: 400 },
    { it: "the scene holds a path", body: envelope("bench", { scene: "../x" }), status: 400 },
    { it: "a setting is an object", body: envelope("bench", { settings: { nested: { a: 1 } } }), status: 400 },
    { it: "a setting name holds a path", body: envelope("bench", { settings: { "../x": 1 } }), status: 400 },
    {
      it: "there are more than 64 settings",
      body: envelope("bench", { settings: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])) }),
      status: 400,
    },
    { it: "a bench payload is an array", body: envelope("bench", { payload: [1, 2] }), status: 400 },
    { it: "a capture has no samples", body: envelope("capture", { payload: { version: 1 } }), status: 400 },
    { it: "a capture has an empty sample list", body: envelope("capture", { payload: { samples: [] } }), status: 400 },
    { it: "a flagged clip's text is not base64", body: envelope("flag", { payload: { ...(PAYLOADS.flag as object), clip: "../../etc/passwd" } }), status: 400 },
    { it: "a flagged clip's text is empty", body: envelope("flag", { payload: { ...(PAYLOADS.flag as object), clip: "" } }), status: 400 },
    { it: "a flagged clip has no title", body: envelope("flag", { payload: { ...(PAYLOADS.flag as object), title: "" } }), status: 400 },
    { it: "a flagged clip says it came from somewhere else", body: envelope("flag", { payload: { ...(PAYLOADS.flag as object), from: "disk" } }), status: 400 },
    { it: "a bench body is over its size cap", body: envelope("bench", { payload: { filler: "x".repeat(MAX_JSON_BYTES.bench) } }), status: 413 },
    {
      it: "a flagged clip's body is over its size cap",
      body: envelope("flag", { payload: { ...(PAYLOADS.flag as object), clip: "A".repeat(MAX_JSON_BYTES.flag) } }),
      status: 413,
    },
  ];
  for (const testCase of refusedCases) {
    it(`when ${testCase.it}, then it answers ${testCase.status} and stores nothing`, async () => {
      const sql = await freshDb();
      const refused = await post(sql, testCase.body);
      assert.equal(refused.status, testCase.status);
      assert.equal(refused.body.id, undefined);
      assert.deepEqual((await owner(sql)).body.submissions, []);
    });
  }

  it("when a gzipped capture inflates past the capture cap (a few kB claiming 40 MB), then it answers 413 and stores nothing", async () => {
    const sql = await freshDb();
    const bomb = envelope("capture", { payload: { samples: [{ filler: "x".repeat(MAX_JSON_BYTES.capture + 8 * 1024 * 1024) }] } });
    const wire = gzipSync(JSON.stringify(bomb));
    assert.ok(wire.length < 100 * 1024, `the bomb is ${wire.length} bytes on the wire`);
    const refused = await post(sql, bomb, { gzip: true });
    assert.equal(refused.status, 413);
    assert.deepEqual((await owner(sql)).body.submissions, []);
  });

  it("when a body that is not gzip claims to be, then it answers 400", async () => {
    const sql = await freshDb();
    const refused = await send(sql, { method: "POST", headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: JSON.stringify(envelope("bench")) });
    assert.equal(refused.status, 400);
  });

  it("when the body claims an encoding the endpoint does not read, then it answers 415", async () => {
    const sql = await freshDb();
    const refused = await post(sql, envelope("bench"), { headers: { "content-encoding": "br" } });
    assert.equal(refused.status, 415);
  });

  it("when the request is not declared as JSON, then it answers 415 and stores nothing", async () => {
    const sql = await freshDb();
    const refused = await post(sql, envelope("bench"), { headers: { "content-type": "text/plain" } });
    assert.equal(refused.status, 415);
    assert.deepEqual((await owner(sql)).body.submissions, []);
  });

  it("when a body past the wire cap arrives as a stream that declares no length, then it answers 413 after taking no more than a chunk or two past the cap", async () => {
    const sql = await freshDb();
    const chunk = new Uint8Array(64 * 1024).fill(32);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.length;
        controller.enqueue(chunk);
        if (sent > MAX_WIRE_BYTES * 4) controller.close();
      },
    });
    const refused = await send(sql, { method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half" } as RequestInit);
    assert.equal(refused.status, 413);
    assert.ok(sent <= MAX_WIRE_BYTES + 2 * chunk.length, `${sent} bytes were taken for a cap of ${MAX_WIRE_BYTES}`);
  });

  for (const method of ["PUT", "DELETE", "PATCH"]) {
    it(`when the method is ${method}, then it answers 405`, async () => {
      const sql = await freshDb();
      assert.equal((await send(sql, { method })).status, 405);
    });
  }
});

describe("given more posts at once than the server works through", () => {
  it("when twelve posts from twelve addresses arrive while the first is still being stored, then six are stored and six are sent away as busy, and the busy ones left nothing", async () => {
    const sql = await freshDb();
    let release: () => void = () => undefined;
    // `Promise.withResolvers` is in the runtime but not in the project's ES2022 lib typings.
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = async (): Promise<Sql> => {
      await gate;
      return sql;
    };
    const all = Array.from({ length: 12 }, () => post(sql, envelope("bench"), { getSql: slow }));
    // The sixth waiter is admitted and the seventh is not: the busy ones answer before the gate opens.
    await nextTurn();
    release();
    const statuses = (await Promise.all(all)).map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 201, 503, 503, 503, 503, 503, 503]);
    assert.equal((await owner(sql)).body.submissions!.length, 6);
  });
});

describe("given one address posting submissions", () => {
  it("when it posts more than its burst, then the extra ones answer 429 and store nothing, while another address is still admitted", async () => {
    const sql = await freshDb();
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.submit.burst + 3; i++) statuses.push((await post(sql, envelope("bench"), { ip })).status);
    assert.deepEqual(statuses, [...Array<number>(LIMITS.submit.burst).fill(201), 429, 429, 429]);
    assert.equal((await post(sql, envelope("bench"))).status, 201);
    assert.equal((await owner(sql)).body.submissions!.length, LIMITS.submit.burst + 1);
  });

  it("when malformed posts have spent its burst, then a valid post answers 429 without touching the database", async () => {
    let touched = 0;
    const sql = { query: async () => (touched++, []) } as unknown as Sql;
    const ip = freshIp();
    for (let i = 0; i < LIMITS.submit.burst; i++) await post(sql, "{not json", { ip });
    const refused = await post(sql, envelope("bench"), { ip });
    assert.equal(refused.status, 429);
    assert.equal(touched, 0);
  });
});

describe("given the owner reading submissions back", () => {
  it("when no owner token is configured on the server, then reads answer 503 even with a bearer header", async () => {
    const sql = await freshDb();
    assert.equal((await owner(sql, "", null)).status, 503);
  });

  it("when the configured token is shorter than 24 characters, then reads answer 503, whatever the bearer header says", async () => {
    const sql = await freshDb();
    const reply = await send(sql, { token: "short", headers: { authorization: "Bearer short" } });
    assert.equal(reply.status, 503);
  });

  const unauthorizedCases: { it: string; headers: Record<string, string> }[] = [
    { it: "no authorization header is sent", headers: {} },
    { it: "the token is wrong", headers: { authorization: `Bearer ${OWNER_TOKEN}y` } },
    { it: "the token is a prefix of the right one", headers: { authorization: `Bearer ${OWNER_TOKEN.slice(0, 30)}` } },
    { it: "the scheme is not Bearer", headers: { authorization: `Basic ${OWNER_TOKEN}` } },
  ];
  for (const testCase of unauthorizedCases) {
    it(`when ${testCase.it}, then listing and fetching answer 401 and reveal no submission`, async () => {
      const sql = await freshDb();
      const receipt = await post(sql, envelope("bench"));
      const list = await send(sql, { headers: testCase.headers });
      const one = await send(sql, { search: `?id=${receipt.body.id}`, headers: testCase.headers });
      assert.equal(list.status, 401);
      assert.equal(one.status, 401);
      assert.equal(JSON.stringify([list.body, one.body]).includes("3295bad"), false);
    });
  }

  it("when the owner lists, then the newest submissions come first without their payloads, and `kind` and `limit` narrow the list", async () => {
    const sql = await freshDb();
    const ids: string[] = [];
    for (const kind of ["bench", "flag", "bench", "capture"] as const) ids.push((await post(sql, envelope(kind))).body.id!);
    const all = await owner(sql);
    assert.deepEqual(listedIds(all), [...ids].reverse());
    assert.deepEqual(Object.keys(all.body.submissions![0]!).sort(), ["id", "kind", "receivedAt", "sha", "size"]);
    assert.deepEqual(listedIds(await owner(sql, "?kind=bench")), [ids[2], ids[0]]);
    assert.equal((await owner(sql, "?limit=2")).body.submissions!.length, 2);
  });

  const badQueryCases = [
    { it: "the receipt id is not the receipt format", search: "?id=%27%3B%20DROP%20TABLE%20submissions%3B--", status: 400 },
    { it: "the receipt id holds a path", search: "?id=..%2F..%2Fetc%2Fpasswd", status: 400 },
    { it: "the kind filter is not a kind", search: "?kind=all", status: 400 },
    { it: "the limit is not a number", search: "?limit=lots", status: 400 },
    { it: "the limit is over 200", search: "?limit=201", status: 400 },
    { it: "the receipt id is well formed but unknown", search: "?id=2222-2222", status: 404 },
  ];
  for (const testCase of badQueryCases) {
    it(`when ${testCase.it}, then the owner gets ${testCase.status}`, async () => {
      const sql = await freshDb();
      assert.equal((await owner(sql, testCase.search)).status, testCase.status);
    });
  }

  it("when one address sends more than its burst of reads with a wrong token, then the extra ones answer 429 instead of 401", async () => {
    const sql = await freshDb();
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < LIMITS.read.burst + 5; i++) statuses.push((await send(sql, { ip, headers: { authorization: "Bearer wrong" } })).status);
    assert.deepEqual(statuses, [...Array<number>(LIMITS.read.burst).fill(401), 429, 429, 429, 429, 429]);
  });
});

describe("given the store is at its size cap", () => {
  it("when it holds the most rows it keeps, then a post answers 507 and the owner can still read what is there", async () => {
    const sql = await freshDb();
    await sql.query(
      `INSERT INTO submissions (id, kind, sha, size, body)
       SELECT 'T' || n, 'bench', 'abc1234', 10, '{}' FROM generate_series(1, $1::int) AS n`,
      [STORE_MAX_ROWS],
    );
    const refused = await post(sql, envelope("bench"));
    assert.equal(refused.status, 507);
    assert.equal((await owner(sql, "?limit=1")).body.submissions!.length, 1);
  });

  it("when it holds the most bytes it keeps, then a post answers 507", async () => {
    const sql = await freshDb();
    await sql.query(`INSERT INTO submissions (id, kind, sha, size, body) VALUES ('BIG', 'bench', 'abc1234', $1, '{}')`, [STORE_MAX_BYTES]);
    assert.equal((await post(sql, envelope("bench"))).status, 507);
  });
});
