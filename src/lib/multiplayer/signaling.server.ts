/**
 * WebRTC signaling over the app database (Neon deployed, PGLite on a node server or in preview).
 * Only rendezvous traffic passes through here — roster + SDP/ICE relay while a mesh forms; game
 * data then flows peer-to-peer. Mounted at /api/rtc (under the app's base path); the client side
 * lives in `@/lib/multiplayer`. Tables: `migrations/0002_webrtc_signaling.sql`, applied by
 * `db:migrate` on deploy and by the PGLite fallback before its first query.
 *
 * The GET poll is the whole peer lifecycle: the first poll (since=0) IS the join — it registers
 * the peer, returns the roster, and prunes stale rows. `GET ?list=public` lists open public rooms.
 *
 * The repo and server are public, so every input is validated, rooms are capped, requests are
 * rate-limited per client IP and per room (in-process: exact on one long-lived node server, per
 * instance on serverless), nothing identifying is stored beyond a random peer id and a role tag,
 * and errors are logged by name only.
 */
import { z } from "zod";
import { getSql, type Sql } from "@/lib/db";
import type { PeerRow, RtcPollResponse, SignalRow } from "./p2p";
import { PUBLIC_PREFIX, ROOM_MAX } from "./rooms";

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
/** Signals a peer may have waiting in one room (offers, answers and ICE while a mesh forms). */
const INBOX_MAX = 400;

/** Token bucket: `rate` requests per second, bursts up to `burst`. */
interface Bucket {
  tokens: number;
  at: number;
}
const LIMITS = { ip: { rate: 15, burst: 60 }, room: { rate: 80, burst: 240 } } as const;
const BUCKETS_MAX = 20_000;

const globalRef = globalThis as typeof globalThis & {
  __rtcBuckets__?: Map<string, Bucket>;
};

/** False once `key` has spent its bucket. Stale buckets are swept when the map grows large. */
function allow(key: string, limit: { rate: number; burst: number }, now = Date.now()): boolean {
  const buckets = (globalRef.__rtcBuckets__ ??= new Map());
  let b = buckets.get(key);
  if (!b) {
    if (buckets.size >= BUCKETS_MAX) {
      for (const [k, v] of buckets) if (now - v.at > 60_000) buckets.delete(k);
      if (buckets.size >= BUCKETS_MAX) return false;
    }
    b = { tokens: limit.burst, at: now };
    buckets.set(key, b);
  }
  b.tokens = Math.min(limit.burst, b.tokens + ((now - b.at) / 1000) * limit.rate);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

/** The caller's address: the reverse proxy's `x-forwarded-for` first hop, else one shared bucket. */
function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${fwd || request.headers.get("x-real-ip") || "direct"}`;
}

async function roster(sql: Sql, room: string): Promise<PeerRow[]> {
  const rows = await sql.query<{ peer_id: string; name: string }>(
    `SELECT peer_id, name FROM webrtc_peers
     WHERE room = $1 AND last_seen > now() - make_interval(secs => $2)
     ORDER BY peer_id LIMIT $3`,
    [room, PEER_TTL_SECONDS, ROOM_MAX],
  );
  return rows.map((r) => ({ id: r.peer_id, name: r.name }));
}

async function touchPeer(sql: Sql, room: string, peer: string, name: string) {
  await sql.query(
    `INSERT INTO webrtc_peers (room, peer_id, name, last_seen)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (room, peer_id)
     DO UPDATE SET last_seen = now(), name = EXCLUDED.name`,
    [room, peer, name],
  );
}

/**
 * Rows are ephemeral; GC rides the polls instead of a cron: joins (since=0) always prune, and ~2% of
 * all other polls do too, so a busy room still gets swept and an emptied room vanishes within the TTL.
 */
async function prune(sql: Sql) {
  await Promise.all([
    sql.query(`DELETE FROM webrtc_signals WHERE created_at < now() - make_interval(secs => $1)`, [SIGNAL_TTL_SECONDS]),
    sql.query(`DELETE FROM webrtc_peers WHERE last_seen < now() - make_interval(secs => $1)`, [PEER_TTL_SECONDS]),
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

/** GET ?list=public — open public rooms (a live host, a free seat), fullest first. */
async function listPublic(sql: Sql): Promise<Response> {
  const rows = await sql.query<{ room: string; players: number }>(
    `SELECT room, count(*)::int AS players FROM webrtc_peers
     WHERE room LIKE $1 AND last_seen > now() - make_interval(secs => $2)
     GROUP BY room
     HAVING bool_or(name = 'host') AND count(*) < $3
     ORDER BY players DESC, room LIMIT 20`,
    [`${PUBLIC_PREFIX}%`, PEER_TTL_SECONDS, ROOM_MAX],
  );
  return json({ rooms: rows.map((r): PublicRoom => ({ room: r.room, players: Number(r.players) })) });
}

/** GET ?room&peer&name&since — join (since=0), heartbeat, and inbox. */
async function handleGet(url: URL): Promise<Response> {
  if (url.searchParams.get("list") === "public") {
    const sql = await getSql();
    return listPublic(sql);
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
  if (!allow(`room:${room}`, LIMITS.room)) return json({ error: "rate limited" }, 429);

  const sql = await getSql();
  if (since === 0 || Math.random() < 0.02) await prune(sql);
  const peers = await roster(sql, room);
  if (!peers.some((p) => p.id === peer) && peers.length >= ROOM_MAX) return json({ error: "room full" }, 409);
  await touchPeer(sql, room, peer, name);
  const rows = await sql.query<{ id: number; from_peer: string; kind: SignalRow["kind"]; payload: unknown }>(
    `SELECT id, from_peer, kind, payload FROM webrtc_signals
     WHERE room = $1 AND to_peer = $2 AND id > $3
     ORDER BY id LIMIT 200`,
    [room, peer, since],
  );
  const body: RtcPollResponse = {
    peers: peers.some((p) => p.id === peer) ? peers : [...peers, { id: peer, name }],
    signals: rows.map((r) => ({ id: r.id, from: r.from_peer, kind: r.kind, payload: r.payload })),
  };
  return json(body);
}

async function handlePost(request: Request): Promise<Response> {
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
  if (!allow(`room:${msg.room}`, LIMITS.room)) return json({ error: "rate limited" }, 429);
  const sql = await getSql();

  if (msg.op === "signal") {
    // Only members of the room may signal each other, and an inbox never grows without bound.
    const members = await roster(sql, msg.room);
    if (!members.some((p) => p.id === msg.from) || !members.some((p) => p.id === msg.to)) {
      return json({ error: "not in room" }, 403);
    }
    const [{ n }] = await sql.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM webrtc_signals WHERE room = $1 AND to_peer = $2`,
      [msg.room, msg.to],
    );
    if (Number(n) >= INBOX_MAX) return json({ error: "inbox full" }, 429);
    await sql.query(
      `INSERT INTO webrtc_signals (room, to_peer, from_peer, kind, payload) VALUES ($1, $2, $3, $4, $5)`,
      [msg.room, msg.to, msg.from, msg.kind, JSON.stringify(msg.payload)],
    );
  } else {
    await sql.query(`DELETE FROM webrtc_peers WHERE room = $1 AND peer_id = $2`, [msg.room, msg.peer]);
  }
  return json({ ok: true });
}

/** Request entrypoint for the /api/rtc route (GET poll / list, POST signal / leave). */
export async function handleSignaling(request: Request): Promise<Response> {
  const ip = clientKey(request);
  if (!allow(ip, LIMITS.ip)) return json({ error: "rate limited" }, 429);
  try {
    if (request.method === "GET") return await handleGet(new URL(request.url));
    if (request.method === "POST") return await handlePost(request);
    return json({ error: "method not allowed" }, 405);
  } catch (error) {
    // Name only: driver messages can carry connection strings, hosts or query values.
    console.error("[rtc] signaling error:", error instanceof Error ? error.name : typeof error);
    return json({ error: "signaling failed" }, 500);
  }
}
