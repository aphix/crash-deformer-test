/**
 * Player submissions: bench cards, JSON trace captures and flagged replay clips, posted by the game and read
 * back by the owner. Mounted at /api/submissions (under the app's base path; `src/routes/api/submissions.ts`);
 * rows live in the app database (`migrations/0006_submissions.sql`), which on the self-hosted server is the
 * PGLite directory under the service's one writable path, so they survive deploys.
 *
 * The repo and server are public, so a post is untrusted. It is rate-limited per client address before its body is
 * read, declared as JSON (gzip allowed), read through a byte cap (the declared length is not trusted), un-gzipped
 * through an output cap (a few kB can claim gigabytes), parsed, checked against one schema per kind with a size cap
 * per kind, and stored as only the fields the schema names. Nothing in a request names a file, a column or a
 * query. The store itself is capped in rows and bytes. A receipt is a random id; reads (a list, or one submission
 * by receipt) need the owner token (`SUBMISSIONS_OWNER_TOKEN`).
 *
 * Memory: a 16 MB capture is several times that in transient strings and objects while it is checked, on a service
 * limited to 2 GB beside PGLite. So everything after the body is read runs one request at a time (`exclusive`), a
 * few may wait, and the rest are sent away to try again.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import type { Sql } from "@/lib/db";
import { clientIp, RateLimiter } from "../multiplayer/rate-limit.ts";
import { KINDS, MAX_JSON_BYTES, MAX_WIRE_BYTES, RECEIPT_ALPHABET, RECEIPT_PATTERN, type Kind } from "./kinds.ts";

type GetSql = () => Promise<Sql>;

/**
 * The most rows and stored bytes (gzipped, as base64 text) the table keeps: a post past either is refused, and nothing older is
 * evicted. At rest it is disk, not memory: the service's 2 GB limit (PGLite at 0.4-0.6 GB after its 1.2 GB peak at open) is spent by
 * the requests in flight, which `exclusive` bounds, and by what PGLite keeps resident, which `docs/DEPLOY.md` records as measured.
 */
export const STORE_MAX_ROWS = 5000;
export const STORE_MAX_BYTES = 128 * 1024 * 1024;
/** Requests that may wait for their turn at the exclusive work; the next is sent away. */
const WAITING_MAX = 6;
/** An owner token shorter than this is a misconfiguration, not a secret: reads stay closed. */
const OWNER_TOKEN_MIN = 24;
const LIST_DEFAULT = 50;
const LIST_MAX = 200;
const LARGEST_JSON = Math.max(...Object.values(MAX_JSON_BYTES));

const SHA = z.string().regex(/^[A-Za-z0-9._-]{1,40}$/);
const WORD = z.string().regex(/^[a-z0-9._-]{1,40}$/);
const SETTING_KEY = z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/);
const SETTINGS_MAX = 64;

const common = {
  sha: SHA,
  at: z.number().int().min(0),
  ua: z.string().min(1).max(512),
  screen: z.object({
    w: z.number().int().min(1).max(32_768),
    h: z.number().int().min(1).max(32_768),
    dpr: z.number().min(0.1).max(16),
  }),
  scene: WORD,
  settings: z
    .record(SETTING_KEY, z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
    .refine((s) => Object.keys(s).length <= SETTINGS_MAX, { message: "too many settings" }),
};

/** A saved clip is base64 text (`encodeSaved`): nothing in it is a path or markup. */
const CLIP_TEXT = /^[A-Za-z0-9+/]{8,}={0,2}$/;

const envelopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bench"), ...common, payload: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("capture"), ...common, payload: z.looseObject({ samples: z.array(z.unknown()).min(1) }) }),
  z.object({
    kind: z.literal("flag"),
    ...common,
    payload: z.object({
      title: z.string().min(1).max(120),
      course: z.string().max(60),
      from: z.enum(["reel", "saved"]),
      clip: z.string().regex(CLIP_TEXT),
    }),
  }),
]);

const idSchema = z.string().regex(RECEIPT_PATTERN);
const listSchema = z.object({
  kind: z.enum(KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MAX).default(LIST_DEFAULT),
});

/** One limiter per process, on globalThis so dev HMR keeps the buckets. */
const globalRef = globalThis as typeof globalThis & { __submissionsLimiter__?: RateLimiter; __submissionsTurn__?: Turns };
const limiter = (globalRef.__submissionsLimiter__ ??= new RateLimiter());

/** One job at a time, a few waiting. */
interface Turns {
  tail: Promise<unknown>;
  waiting: number;
}
const turns = (globalRef.__submissionsTurn__ ??= { tail: Promise.resolve(), waiting: 0 });

/** Run `job` after every earlier one; null when `WAITING_MAX` are already waiting. */
async function exclusive<T>(job: () => Promise<T>): Promise<T | null> {
  if (turns.waiting >= WAITING_MAX) return null;
  turns.waiting++;
  const run = turns.tail.then(job, job);
  turns.tail = run.catch(() => undefined);
  try {
    return await run;
  } finally {
    turns.waiting--;
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

const busy = (): Response => json({ error: "busy" }, 503, { "retry-after": "10" });

/** A receipt id: 40 random bits as `XXXX-XXXX`; the alphabet has 32 characters, so each byte maps without bias. */
function newReceipt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let id = "";
  for (let i = 0; i < 8; i++) id += (i === 4 ? "-" : "") + RECEIPT_ALPHABET[bytes[i]! & 31]!;
  return id;
}

/** The body's bytes, or null once they pass `cap`: the stream is cancelled there, so a sender claiming no length costs at most one chunk past it. */
async function readCapped(request: Request, cap: number): Promise<Buffer | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > cap) return null;
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

function isKind(v: unknown): v is Kind {
  return typeof v === "string" && (KINDS as readonly string[]).includes(v);
}

/** `wire` as JSON text bytes: as it is, or un-gzipped to at most `LARGEST_JSON`; the status to answer with when it cannot be. */
function jsonBytes(wire: Buffer, gzip: boolean): Buffer | 400 | 413 {
  if (!gzip) return wire.length > LARGEST_JSON ? 413 : wire;
  try {
    return gunzipSync(wire, { maxOutputLength: LARGEST_JSON });
  } catch (error) {
    return error instanceof RangeError ? 413 : 400;
  }
}

async function storePost(wire: Buffer, gzip: boolean, getSql: GetSql): Promise<Response> {
  const bytes = jsonBytes(wire, gzip);
  if (typeof bytes === "number") return json({ error: bytes === 413 ? "too large" : "invalid gzip" }, bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const kind = raw !== null && typeof raw === "object" && "kind" in raw ? raw.kind : undefined;
  if (!isKind(kind)) return json({ error: "invalid submission" }, 400);
  if (bytes.length > MAX_JSON_BYTES[kind]) return json({ error: "too large" }, 413);
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid submission" }, 400);

  const body = gzipSync(JSON.stringify(parsed.data)).toString("base64");
  const id = newReceipt();
  const sql = await getSql();
  // One statement checks the caps and inserts, so two posts in flight cannot both take the last slot.
  const stored = await sql.query<{ id: string }>(
    `INSERT INTO submissions (id, kind, sha, size, body)
     SELECT $1::text, $2::text, $3::text, $4::int, $5::text
     WHERE (SELECT count(*) FROM submissions) < $6::int
       AND (SELECT coalesce(sum(size), 0) FROM submissions) + $4::int <= $7::bigint
     RETURNING id`,
    [id, kind, parsed.data.sha, body.length, body, STORE_MAX_ROWS, STORE_MAX_BYTES],
  );
  if (stored.length === 0) return json({ error: "store full" }, 507);
  return json({ id }, 201);
}

async function handlePost(request: Request, ip: string, getSql: GetSql, now: number): Promise<Response> {
  if (!limiter.submit(ip, now)) return json({ error: "rate limited" }, 429);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "not JSON" }, 415);
  const encoding = (request.headers.get("content-encoding") ?? "identity").toLowerCase();
  if (encoding !== "identity" && encoding !== "gzip") return json({ error: "unsupported encoding" }, 415);
  const wire = await readCapped(request, MAX_WIRE_BYTES);
  if (!wire) return json({ error: "too large" }, 413);
  return (await exclusive(() => storePost(wire, encoding === "gzip", getSql))) ?? busy();
}

/** True when `request` carries exactly the owner token; compared as digests, so the comparison's time leaks nothing about the token. */
function isOwner(request: Request, token: string): boolean {
  const given = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(token));
}

interface Row {
  id: string;
  kind: Kind;
  sha: string;
  size: number;
  received_at: string;
}

/** Row timestamps as UTC ISO text, the same string on PGLite and Neon. */
const RECEIVED = `to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS received_at`;

/** One submission as the owner reads it: its row's fields, and the stored JSON text as it is (not parsed and written out again: a capture is megabytes). */
async function readOne(sql: Sql, id: string): Promise<Response> {
  const rows = await sql.query<Row & { body: string }>(`SELECT id, kind, sha, size, ${RECEIVED}, body FROM submissions WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row) return json({ error: "not found" }, 404);
  const head = JSON.stringify({ id: row.id, kind: row.kind, sha: row.sha, receivedAt: row.received_at });
  const text = gunzipSync(Buffer.from(row.body, "base64")).toString("utf8");
  return new Response(`${head.slice(0, -1)},"submission":${text}}`, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function handleRead(request: Request, ip: string, getSql: GetSql, ownerToken: string | undefined, now: number): Promise<Response> {
  if (!limiter.read(ip, now)) return json({ error: "rate limited" }, 429);
  if (!ownerToken || ownerToken.length < OWNER_TOKEN_MIN) return json({ error: "reads are not configured" }, 503);
  if (!isOwner(request, ownerToken)) return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });

  const url = new URL(request.url);
  const sql = await getSql();
  const idParam = url.searchParams.get("id");
  if (idParam !== null) {
    const id = idSchema.safeParse(idParam);
    if (!id.success) return json({ error: "invalid receipt" }, 400);
    return (await exclusive(() => readOne(sql, id.data))) ?? busy();
  }
  const query = listSchema.safeParse({ kind: url.searchParams.get("kind") ?? undefined, limit: url.searchParams.get("limit") ?? undefined });
  if (!query.success) return json({ error: "invalid query" }, 400);
  const rows = await sql.query<Row>(
    `SELECT id, kind, sha, size, ${RECEIVED} FROM submissions WHERE ($1::text IS NULL OR kind = $1::text) ORDER BY seq DESC LIMIT $2::int`,
    [query.data.kind ?? null, query.data.limit],
  );
  return json({ submissions: rows.map((r) => ({ id: r.id, kind: r.kind, receivedAt: r.received_at, sha: r.sha, size: r.size })) });
}

/** Request entrypoint for the /api/submissions route. `getSql` is `@/lib/db`'s; `ownerToken` the deploy env's. */
export async function handleSubmissions(request: Request, getSql: GetSql, ownerToken: string | undefined, now = Date.now()): Promise<Response> {
  const ip = clientIp(request);
  try {
    if (request.method === "POST") return await handlePost(request, ip, getSql, now);
    if (request.method === "GET") return await handleRead(request, ip, getSql, ownerToken, now);
    return json({ error: "method not allowed" }, 405);
  } catch (error) {
    // Name only: a driver message can carry connection strings, hosts or query values.
    console.error("[submissions] failed:", error instanceof Error ? error.name : typeof error);
    return json({ error: "submission failed" }, 500);
  }
}
