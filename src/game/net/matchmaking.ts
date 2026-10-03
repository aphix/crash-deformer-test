import { z } from "zod";
import { PUBLIC_PREFIX, ROOM_MAX } from "../../lib/multiplayer/rooms.ts";
import { NET_VERSION } from "./codec.ts";
import type { MatchStage, NetGame, PublicKind } from "./net-ports.ts";

/**
 * Live matchmaking over the relay's public room list (docs/MULTIPLAYER.md "Play online"): which listed room
 * to join, when this device hosts a new one, and how simultaneous searchers end up in one room. Pure of the
 * network and the clock (`MatchDeps`), so the rules are testable with a stubbed list and a virtual clock.
 */

/** A public room as the relay lists it (signaling.server.ts `listPublic`); `meta` is its host's `publicMeta`. */
export interface LobbyRoom {
  room: string;
  /** Every peer in the room: the full-room test and what the list shows. One address can pad it with idle peers. */
  players: number;
  /** Distinct addresses in the room: what ranks it, since padding adds players but not addresses. */
  addrs: number;
  meta: string;
}

/** A listed room this build can join. */
export interface OpenRoom {
  room: string;
  players: number;
  addrs: number;
  /** Where the host says its match stands; null when the relay predates room meta. */
  stage: MatchStage | null;
  /** The host's course id ("" for a derby or an old relay). */
  course: string;
}

/** `GET api/rtc?list=public&kind=…`, as the game reads it: a relay without `meta` lists rooms without one. */
const LIST = z.object({
  rooms: z.array(z.object({ room: z.string().startsWith(PUBLIC_PREFIX).max(64), players: z.number().int(), addrs: z.number().int(), meta: z.string().max(64).default("") })),
});

/** Rooms carry the build's `NET_VERSION`, so a search never lands in one it would be refused from. */
export function publicRoomName(kind: PublicKind, code: string): string {
  return `${PUBLIC_PREFIX}${kind}-v${NET_VERSION}-${code}`;
}

const ROOM_RE = /^pub-(race|derby)-v(\d+)-/;
const STAGES: readonly string[] = ["lobby", "running", "over"];

/** A host's heartbeat tag, `<stage>.<course>`: lowercase, digits, `.-_` only (the relay's `META` rule). */
export function publicMeta(stage: MatchStage, course: string): string {
  return `${stage}.${course.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24)}`;
}

/** Where public match `kind` stands on this host (race: the director's phase; derby: its stage); null while its mode is not up yet. */
export function matchStage(game: Pick<NetGame, "race" | "derbyPhase">, kind: PublicKind): MatchStage | null {
  if (kind === "derby") return game.derbyPhase();
  const phase = game.race()?.phase;
  return phase === undefined ? null : phase === null ? "lobby" : phase === "finished" ? "over" : "running";
}

/** A weak device's public match runs a smaller field: this many AI in a race (the player makes it 4), this many cars in a derby. */
export const WEAK_AI = 3;
export const WEAK_DERBY_FIELD = 4;

/**
 * Rooms of `kind` this build can join, best first: a match not mid-way (lobby or results, the next one
 * starts within ~30 s) before a running one (a late joiner spectates until its end), then the most distinct
 * addresses (the relay's own order: one address padding a room with idle peers adds players, not addresses),
 * then the lexically first, which is the same room on every searcher's screen. Wrong build, full rooms and
 * `skip` (rooms the caller is leaving or gave up on) are dropped.
 */
export function openRooms(list: readonly LobbyRoom[], kind: PublicKind, skip: readonly string[] = []): OpenRoom[] {
  const out: OpenRoom[] = [];
  for (const r of list) {
    const m = ROOM_RE.exec(r.room);
    if (!m || m[1] !== kind || Number(m[2]) !== NET_VERSION || r.players >= ROOM_MAX || skip.includes(r.room)) continue;
    const [stage = "", course = ""] = r.meta.split(".");
    out.push({ room: r.room, players: r.players, addrs: r.addrs, stage: STAGES.includes(stage) ? (stage as MatchStage) : null, course });
  }
  const rank = (r: OpenRoom) => (r.stage === "running" ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || b.addrs - a.addrs || (a.room < b.room ? -1 : 1));
}

/** The relay's open public rooms of `kind`, or null when it cannot be reached (offline, rate limited, down). */
export async function fetchRooms(kind: PublicKind): Promise<LobbyRoom[] | null> {
  try {
    // `?.`: outside Vite (node tests) there is no `import.meta.env`; the app is then served from "/".
    const res = await fetch(`${import.meta.env?.BASE_URL ?? "/"}api/rtc?list=public&kind=${kind}`);
    const list = LIST.safeParse(res.ok ? await res.json() : null);
    return list.success ? list.data.rooms : null;
  } catch {
    return null;
  }
}

/** A capable device pauses up to this long (ms, random) before creating a room, then looks once more. */
export const BACKOFF_MS = 600;
/** A weak device keeps looking this long (ms) plus up to `WEAK_JITTER_MS` before it hosts anyway. */
export const WEAK_WAIT_MS = 12_000;
export const WEAK_JITTER_MS = 3_000;
/** A weak device's list polls while it looks (ms). */
export const SEARCH_POLL_MS = 2_500;
/** After hosting, when (ms since the previous check) to look for a twin room made at the same moment. */
const TWIN_CHECKS_MS: readonly number[] = [1_500, 2_500];

/** What a search needs from the game; every effect of it goes through here. */
export interface MatchDeps {
  list(): Promise<readonly LobbyRoom[] | null>;
  sleep(ms: number): Promise<void>;
  /** [0, 1). */
  random(): number;
  now(): number;
  /** Open a link to `room` as a guest (leaving the room this peer hosts, if any). */
  join(room: string): void;
  /** Host a fresh public room, `weak` for a device that should run a smaller field; returns its name. */
  host(weak: boolean): string;
  /** Nobody has joined the room this peer hosts. */
  alone(): boolean;
  /** False once the search was cancelled (the player left, or started another). */
  live(): boolean;
}

/**
 * One-tap Play online: join the best open room; else host, if this device `fit`s, after a short random
 * pause and a second look (two clicks in the same instant must not both create); a weak device keeps looking
 * for up to `WEAK_WAIT_MS` first and hosts a smaller field. Whoever hosts re-checks twice while alone: of
 * several empty rooms made in the same moment the lexically first stays and the others join it, so searchers
 * who clicked together end in one room. `skip` names rooms never to join (a host that just died).
 */
export async function findMatch(kind: PublicKind, fit: boolean, deps: MatchDeps, skip: readonly string[] = []): Promise<void> {
  const start = deps.now();
  const patience = WEAK_WAIT_MS + deps.random() * WEAK_JITTER_MS;
  const best = async (): Promise<{ room: string | undefined; reachable: boolean }> => {
    const list = await deps.list();
    return { room: list ? openRooms(list, kind, skip)[0]?.room : undefined, reachable: list !== null };
  };
  for (;;) {
    const seen = await best();
    if (!deps.live()) return;
    if (seen.room) return deps.join(seen.room);
    // Relay out of reach: nothing to wait for, host a room others can still find later.
    if (!seen.reachable) break;
    if (fit) {
      await deps.sleep(deps.random() * BACKOFF_MS);
      if (!deps.live()) return;
      const again = await best();
      if (!deps.live()) return;
      if (again.room) return deps.join(again.room);
      break;
    }
    if (deps.now() - start >= patience) break;
    await deps.sleep(SEARCH_POLL_MS);
    if (!deps.live()) return;
  }
  const mine = deps.host(!fit);
  for (const wait of TWIN_CHECKS_MS) {
    await deps.sleep(wait);
    if (!deps.live()) return;
    const list = await deps.list();
    if (!deps.live() || !list) continue;
    if ((list.find((r) => r.room === mine)?.players ?? 1) > 1 || !deps.alone()) return;
    const other = openRooms(list, kind, [...skip, mine])[0];
    if (other && other.stage !== "running" && (other.addrs > 1 || other.room < mine)) return deps.join(other.room);
  }
}

/** Milliseconds between polls of the room list while the indicator is collapsed / its list is open. */
export const POLL_COLLAPSED_MS = 10_000;
export const POLL_EXPANDED_MS = 4_000;
/** A failed poll (offline, rate limited) doubles the wait up to this. */
const POLL_MAX_MS = 60_000;

interface PollEnv {
  fetch(): Promise<LobbyRoom[] | null>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  visible(): boolean;
}

/**
 * Keeps the live-rooms indicator's list fresh at a rate the relay (10 requests/s per address) never feels:
 * every `POLL_COLLAPSED_MS`, every `POLL_EXPANDED_MS` while the list is open, none while the tab is hidden,
 * and slower after each failure. One request at a time.
 */
export class RoomPoller {
  private timer: unknown = null;
  private expanded = false;
  private failures = 0;
  private busy = false;
  private stopped = true;

  private readonly env: PollEnv;
  private readonly onRooms: (rooms: LobbyRoom[] | null) => void;

  constructor(env: PollEnv, onRooms: (rooms: LobbyRoom[] | null) => void) {
    this.env = env;
    this.onRooms = onRooms;
  }

  start(): void {
    this.stopped = false;
    void this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = null;
  }

  /** The list opened or closed: opening refreshes at once and speeds the cadence up. */
  setExpanded(expanded: boolean): void {
    if (expanded === this.expanded) return;
    this.expanded = expanded;
    if (!this.stopped && expanded) void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.busy) return;
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = null;
    if (this.env.visible()) {
      this.busy = true;
      const rooms = await this.env.fetch();
      this.busy = false;
      if (this.stopped) return;
      this.failures = rooms === null ? this.failures + 1 : 0;
      this.onRooms(rooms);
    }
    const base = this.expanded ? POLL_EXPANDED_MS : POLL_COLLAPSED_MS;
    this.timer = this.env.setTimer(() => void this.tick(), Math.min(POLL_MAX_MS, base * 2 ** this.failures));
  }
}
