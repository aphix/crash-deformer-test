/**
 * WebRTC signaling over the app database (Neon deployed, PGLite on a node server or in preview).
 * Only rendezvous traffic passes through here — roster + SDP/ICE relay while a mesh forms; game
 * data then flows peer-to-peer. Mounted at /api/rtc (under the app's base path); the client side
 * lives in `@/lib/multiplayer`. Tables: `migrations/0002_webrtc_signaling.sql` and
 * `0003_webrtc_peer_tokens.sql`, applied by `db:migrate` on deploy and by the PGLite fallback
 * before its first query.
 *
 * The GET poll is the whole peer lifecycle. A peer's first poll registers it in a free seat with the
 * role tag it sent and returns a token (only the token's hash is stored). Every later poll (heartbeat
 * and inbox read), signal and leave must carry that token in the `TOKEN_HEADER` header, so nobody can
 * read another peer's inbox, speak as it, retag it or remove it. A peer that stops polling for
 * `PEER_TTL_SECONDS` gives up its seat and registers afresh. `GET ?list=public` lists open public rooms.
 *
 * The repo and server are public, so every input is validated, rooms are capped, requests are
 * rate-limited per peer (keyed by client IP + peer id) and per client IP (in-process: exact on one
 * long-lived node server, per instance on serverless), nothing identifying is stored beyond a random
 * peer id, a role tag and a token hash, and errors are logged by name only.
 */
import { z } from "zod";
import type { Sql } from "@/lib/db";
import type { PeerRow, RtcPollResponse, SignalRow } from "./p2p";
import { RateLimiter } from "./rate-limit.ts";
import { PUBLIC_PREFIX, ROOM_MAX, TOKEN_HEADER } from "./rooms.ts";

type GetSql = () => Promise<Sql>;

const ID = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
/** Peer display tag: the game sends its role ("host" / "client"), never a person's name. */
const NAME = z.string().regex(/^[a-z]{0,12}$/);
const signalSchema = z.object({
  op: z.literal("signal"),
  room: ID,
  from: ID,
  to: ID,
  kind: z.enum(["offer", "answer", "ice"]),
  // SDP offers are typically 3–10 KB; the cap only blocks abuse. An absent payload is rejected
  // (JSON.stringify(undefined) has no .length).
  payload: z.unknown().refine((v) => v !== undefined && JSON.stringify(v).length <= 32_768, {
    message: "payload too large",
  }),
});
const leaveSchema = z.object({ op: z.literal("leave"), room: ID, peer: ID });
const postSchema = z.discriminatedUnion("op", [signalSchema, leaveSchema]);

const PEER_TTL_SECONDS = 30;
const SIGNAL_TTL_SECONDS = 60;
/**
 * Live signals one peer may have waiting from one sender (offer, answer and ICE, again per restart):
 * a room's seven senders together get about the 400 one inbox used to hold, and none can fill it alone.
 */
const INBOX_PER_SENDER = 60;
/** A peer row that has heartbeat within the TTL. */
const LIVE = `last_seen > now() - make_interval(secs => ${PEER_TTL_SECONDS})`;

/** One limiter per process, on globalThis so dev HMR keeps the buckets. */
const globalRef = globalThis as typeof globalThis & { __rtcLimiter__?: RateLimiter };
const limiter = (globalRef.__rtcLimiter__ ??= new RateLimiter());

/** The caller's address: the reverse proxy's `x-forwarded-for` first hop, else one shared address. */
function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || request.headers.get("x-real-ip") || "direct";
}

/** Only a token's SHA-256 is stored, so reading the database never yields a usable token. */
async function hashToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The room's seated peers; seats cap it at ROOM_MAX. */
async function roster(sql: Sql, room: string): Promise<PeerRow[]> {
  const rows = await sql.query<{ peer_id: string; name: string }>(
    `SELECT peer_id, name FROM webrtc_peers WHERE room = $1 AND ${LIVE} ORDER BY peer_id`,
    [room],
  );
  return rows.map((r) => ({ id: r.peer_id, name: r.name }));
}

/**
 * Seats `peer` with a new token (returned), or answers why it cannot join. One insert takes the
 * lowest free seat, and the unique (room, seat) and one-host indexes make it atomic: joins that race
 * never overfill a room, never seat a second host, and never displace a seated peer.
 */
async function join(sql: Sql, room: string, peer: string, name: string): Promise<string | Response> {
  // A peer that stopped polling gives up its seat and its id.
  await sql.query(`DELETE FROM webrtc_peers WHERE room = $1 AND NOT (${LIVE})`, [room]);
  const token = crypto.randomUUID().replaceAll("-", "");
  const seated = await sql.query(
    `INSERT INTO webrtc_peers (room, peer_id, name, secret_hash, seat, last_seen)
     SELECT $1, $2, $3, $4, seat, now() FROM generate_series(0, $5::int - 1) AS seat
     WHERE seat NOT IN (SELECT seat FROM webrtc_peers WHERE room = $1)
     ORDER BY seat LIMIT 1
     ON CONFLICT DO NOTHING RETURNING seat`,
    [room, peer, name, await hashToken(token), ROOM_MAX],
  );
  if (seated.length) return token;
  const peers = await roster(sql, room);
  if (peers.some((p) => p.id === peer)) return json({ error: "not your peer id" }, 403);
  if (name === "host" && peers.some((p) => p.name === "host")) return json({ error: "host taken" }, 409);
  return json({ error: "room full" }, 409);
}

/**
 * Rows are ephemeral; GC rides the polls instead of a cron: joins (since=0) always prune, and ~2% of
 * all other polls do too, so a busy room still gets swept and an emptied room vanishes within the TTL.
 */
async function prune(sql: Sql) {
  await Promise.all([
    sql.query(`DELETE FROM webrtc_signals WHERE created_at < now() - make_interval(secs => $1)`, [SIGNAL_TTL_SECONDS]),
    sql.query(`DELETE FROM webrtc_peers WHERE NOT (${LIVE})`),
  ]);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

interface PublicRoom {
  room: string;
  players: number;
}

/**
 * A host polls every 2 s once its pairs are up (p2p.ts IDLE_POLL_MS): one that has not polled for
 * `HOST_FRESH_SECONDS` closed its tab or lost its network, and its room is not offered any more.
 */
const HOST_FRESH_SECONDS = 5;

/** `?kind=`: one kind of public match; rooms are named `pub-<kind>-…` (net-play.ts `publicMatch`). */
const KIND = z.enum(["race", "derby"]).optional();

/** GET ?list=public[&kind=race|derby] — open public rooms (a host that polled recently, a free seat), fullest first. */
async function listPublic(sql: Sql, kind: "race" | "derby" | undefined): Promise<Response> {
  const rows = await sql.query<{ room: string; players: number }>(
    `SELECT room, count(*)::int AS players FROM webrtc_peers
     WHERE room LIKE $1 AND last_seen > now() - make_interval(secs => $2)
     GROUP BY room
     HAVING bool_or(name = 'host' AND last_seen > now() - make_interval(secs => $4)) AND count(*) < $3
     ORDER BY players DESC, room LIMIT 20`,
    [`${PUBLIC_PREFIX}${kind ? `${kind}-` : ""}%`, PEER_TTL_SECONDS, ROOM_MAX, HOST_FRESH_SECONDS],
  );
  return json({ rooms: rows.map((r): PublicRoom => ({ room: r.room, players: Number(r.players) })) });
}

/** GET ?room&peer&name&since — join (no valid token yet), heartbeat, and inbox. */
async function handleGet(request: Request, ip: string, getSql: GetSql): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.get("list") === "public") {
    if (!limiter.list(ip)) return json({ error: "rate limited" }, 429);
    const kind = KIND.safeParse(url.searchParams.get("kind") ?? undefined);
    if (!kind.success) return json({ error: "invalid query" }, 400);
    const sql = await getSql();
    return listPublic(sql, kind.data);
  }
  const parsed = z
    .object({ room: ID, peer: ID, name: NAME.default(""), since: z.coerce.number().int().min(0).default(0) })
    .safeParse({
      room: url.searchParams.get("room"),
      peer: url.searchParams.get("peer"),
      name: url.searchParams.get("name") ?? "",
      since: url.searchParams.get("since") ?? 0,
    });
  if (!parsed.success) return json({ error: "invalid query" }, 400);
  const { room, peer, name, since } = parsed.data;
  if (!limiter.peer(ip, peer)) return json({ error: "rate limited" }, 429);

  const sql = await getSql();
  if (since === 0 || Math.random() < 0.02) await prune(sql);
  const token = request.headers.get(TOKEN_HEADER);
  // A seated peer's poll is its heartbeat; its role tag stays the one it joined with.
  const seated = token
    ? await sql.query(
        `UPDATE webrtc_peers SET last_seen = now()
         WHERE room = $1 AND peer_id = $2 AND secret_hash = $3 AND ${LIVE} RETURNING seat`,
        [room, peer, await hashToken(token)],
      )
    : [];
  let issued: string | undefined;
  if (!seated.length) {
    const joined = await join(sql, room, peer, name);
    if (joined instanceof Response) return joined;
    issued = joined;
  }
  const peers = await roster(sql, room);
  const rows = await sql.query<{ id: number; from_peer: string; kind: SignalRow["kind"]; payload: unknown }>(
    `SELECT id, from_peer, kind, payload FROM webrtc_signals
     WHERE room = $1 AND to_peer = $2 AND id > $3
     ORDER BY id LIMIT 200`,
    [room, peer, since],
  );
  const body: RtcPollResponse = {
    peers,
    signals: rows.map((r) => ({ id: r.id, from: r.from_peer, kind: r.kind, payload: r.payload })),
    token: issued,
  };
  return json(body);
}

async function handlePost(request: Request, ip: string, getSql: GetSql): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 40_000) return json({ error: "too large" }, 413);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid request" }, 400);
  const msg = parsed.data;
  if (!limiter.peer(ip, msg.op === "signal" ? msg.from : msg.peer)) return json({ error: "rate limited" }, 429);
  const sql = await getSql();
  const hash = await hashToken(request.headers.get(TOKEN_HEADER) ?? "");

  if (msg.op === "leave") {
    const left = await sql.query(
      `DELETE FROM webrtc_peers WHERE room = $1 AND peer_id = $2 AND secret_hash = $3 RETURNING seat`,
      [msg.room, msg.peer, hash],
    );
    return left.length ? json({ ok: true }) : json({ error: "not in room" }, 403);
  }
  // Only a seated peer, holding its own token, may signal another seated peer of its room.
  const members = await sql.query<{ peer_id: string; secret_hash: string }>(
    `SELECT peer_id, secret_hash FROM webrtc_peers WHERE room = $1 AND ${LIVE}`,
    [msg.room],
  );
  if (!members.some((m) => m.peer_id === msg.from && m.secret_hash === hash) || !members.some((m) => m.peer_id === msg.to)) {
    return json({ error: "not in room" }, 403);
  }
  const [{ n }] = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM webrtc_signals
     WHERE room = $1 AND to_peer = $2 AND from_peer = $3 AND created_at > now() - make_interval(secs => $4)`,
    [msg.room, msg.to, msg.from, SIGNAL_TTL_SECONDS],
  );
  if (Number(n) >= INBOX_PER_SENDER) return json({ error: "inbox full" }, 429);
  await sql.query(
    `INSERT INTO webrtc_signals (room, to_peer, from_peer, kind, payload) VALUES ($1, $2, $3, $4, $5)`,
    [msg.room, msg.to, msg.from, msg.kind, JSON.stringify(msg.payload)],
  );
  return json({ ok: true });
}

/** Request entrypoint for the /api/rtc route (GET poll / list, POST signal / leave); `getSql` is `@/lib/db`'s. */
export async function handleSignaling(request: Request, getSql: GetSql): Promise<Response> {
  const ip = clientIp(request);
  if (!limiter.ip(ip)) return json({ error: "rate limited" }, 429);
  try {
    if (request.method === "GET") return await handleGet(request, ip, getSql);
    if (request.method === "POST") return await handlePost(request, ip, getSql);
    return json({ error: "method not allowed" }, 405);
  } catch (error) {
    // Name only: driver messages can carry connection strings, hosts or query values.
    console.error("[rtc] signaling error:", error instanceof Error ? error.name : typeof error);
    return json({ error: "signaling failed" }, 500);
  }
}
