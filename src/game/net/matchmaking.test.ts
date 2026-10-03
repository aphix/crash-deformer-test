import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NET_VERSION } from "./codec.ts";
import {
  BACKOFF_MS,
  openRooms,
  POLL_COLLAPSED_MS,
  POLL_EXPANDED_MS,
  publicMeta,
  publicRoomName,
  RoomPoller,
  SEARCH_POLL_MS,
  findMatch,
  WEAK_JITTER_MS,
  WEAK_WAIT_MS,
  type LobbyRoom,
  type MatchDeps,
} from "./matchmaking.ts";

/** A room name without its kind and build: "A" for `publicRoomName("race", "A")`, so expectations read as literals. */
const codeOf = (name: string): string => name.replace(/^pub-(race|derby)-v\d+-/, "");

const room = (code: string, players: number, meta = "lobby.oval", kind: "race" | "derby" = "race"): LobbyRoom => ({
  room: publicRoomName(kind, code),
  players,
  meta,
});

/** Virtual time: `sleep` and `at` queue a timer; `drain` runs the earliest until none is left, letting promises settle between. */
class Clock {
  now = 0;
  private timers: { at: number; fn: () => void }[] = [];

  at(ms: number, fn: () => void): void {
    this.timers.push({ at: this.now + ms, fn });
    this.timers.sort((a, b) => a.at - b.at);
  }

  sleep = (ms: number): Promise<void> => new Promise((resolve) => this.at(ms, resolve));

  async drain(): Promise<void> {
    for (;;) {
      await new Promise((resolve) => setImmediate(resolve));
      const next = this.timers.shift();
      if (!next) return;
      this.now = next.at;
      next.fn();
    }
  }
}

/** Mulberry32: a seeded [0, 1) stream, so a failing seed replays. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One search against a stubbed room list; records what the search did and when. */
function harness(lists: (call: number, clock: Clock) => readonly LobbyRoom[] | null, opts: { alone?: boolean; random?: () => number } = {}) {
  const clock = new Clock();
  const log: { at: number; what: string }[] = [];
  let calls = 0;
  const deps: MatchDeps = {
    list: async () => lists(calls++, clock),
    sleep: clock.sleep,
    random: opts.random ?? (() => 0),
    now: () => clock.now,
    join: (r) => log.push({ at: clock.now, what: `join ${codeOf(r)}` }),
    host: (weak) => {
      log.push({ at: clock.now, what: weak ? "host weak" : "host" });
      return "pub-race-v0-ME";
    },
    alone: () => opts.alone ?? true,
    live: () => true,
  };
  return { clock, log, deps, calls: () => calls };
}

describe("matchmaking: which listed rooms are open", () => {
  it("drops other kinds, other builds, full rooms and the room being left", () => {
    const list: LobbyRoom[] = [
      room("A", 2),
      room("B", 2, "lobby.oval", "derby"),
      { room: `pub-race-v${NET_VERSION + 1}-C`, players: 2, meta: "lobby.oval" },
      { room: "pub-race-D", players: 2, meta: "" },
      room("E", 8),
      room("F", 2),
    ];
    assert.deepEqual(openRooms(list, "race", [publicRoomName("race", "F")]).map((r) => codeOf(r.room)), ["A"]);
  });

  it("ranks a match that has not started before a running one, then the fullest, then the first name", () => {
    const list = [room("A", 7, "running.oval"), room("B", 2), room("C", 5, "over.rally"), room("D", 5), room("E", 3, "")];
    assert.deepEqual(
      openRooms(list, "race").map((r) => r.room.slice(-1)),
      ["C", "D", "E", "B", "A"],
    );
  });

  it("reads the stage and course from the host's tag; a relay without tags lists rooms unstaged", () => {
    assert.deepEqual(
      openRooms([room("A", 1, "over.rally"), room("B", 1, ""), room("C", 1, "bogus.x")], "race").map((r) => [r.stage, r.course]),
      [["over", "rally"], [null, ""], [null, "x"]],
    );
  });

  it("names rooms by kind and build, and tags are lowercase and relay-safe", () => {
    assert.equal(publicRoomName("derby", "AB12"), `pub-derby-v${NET_VERSION}-AB12`);
    assert.equal(publicMeta("lobby", "Harbour Streets!"), "lobby.harbourstreets");
    assert.match(publicMeta("running", "x".repeat(60)), /^running\.x{24}$/);
  });
});

describe("matchmaking: Play online decides", () => {
  it("joins the best open room at once, without hosting", async () => {
    const h = harness(() => [room("A", 1), room("B", 3, "running.oval"), room("C", 2)]);
    await findMatch("race", true, h.deps);
    assert.deepEqual(h.log, [{ at: 0, what: "join C" }]);
  });

  it("skips a room of another build and a full one, and hosts when nothing else is open", async () => {
    const h = harness(() => [{ room: `pub-race-v${NET_VERSION + 1}-A`, players: 3, meta: "lobby.oval" }, room("B", 8)]);
    const done = findMatch("race", true, h.deps);
    await h.clock.drain();
    await done;
    assert.equal(h.log[0]!.what, "host");
  });

  it("a capable device hosts after a pause under BACKOFF_MS and one more look, not before", async () => {
    const h = harness(() => [], { random: () => 0.5 });
    const done = findMatch("race", true, h.deps);
    await h.clock.drain();
    await done;
    assert.deepEqual(h.log.map((l) => l.what), ["host"]);
    assert.equal(h.log[0]!.at, BACKOFF_MS * 0.5);
    assert.equal(h.calls() >= 2, true, "it looked again before creating");
  });

  it("a capable device joins a room that appeared during its pause instead of hosting", async () => {
    const h = harness((call) => (call === 0 ? [] : [room("A", 1)]));
    const done = findMatch("race", true, h.deps);
    await h.clock.drain();
    await done;
    assert.deepEqual(h.log, [{ at: 0, what: "join A" }]);
  });

  it("a weak device keeps looking, polling every SEARCH_POLL_MS, and hosts a smaller field after WEAK_WAIT_MS", async () => {
    const h = harness(() => [], { random: () => 0 });
    const done = findMatch("race", false, h.deps);
    await h.clock.drain();
    await done;
    const hosted = h.log.find((l) => l.what === "host weak")!;
    // Polls at 0, 2.5, 5, … ; the first one at or past the patience hosts.
    assert.equal(hosted.at, Math.ceil(WEAK_WAIT_MS / SEARCH_POLL_MS) * SEARCH_POLL_MS);
    assert.ok(hosted.at >= 10_000 && hosted.at <= 15_000, `hosts between 10 and 15 s (${hosted.at} ms)`);
  });

  it("a weak device's patience is jittered up to WEAK_JITTER_MS, so the 10–15 s window holds at both ends", async () => {
    for (const r of [0, 0.999]) {
      const h = harness(() => [], { random: () => r });
      const done = findMatch("race", false, h.deps);
      await h.clock.drain();
      await done;
      const at = h.log.find((l) => l.what === "host weak")!.at;
      assert.ok(at >= WEAK_WAIT_MS && at < WEAK_WAIT_MS + WEAK_JITTER_MS + SEARCH_POLL_MS, `${at}`);
    }
  });

  it("a weak device joins a room that shows up mid-search", async () => {
    const h = harness((call) => (call < 3 ? [] : [room("A", 1)]));
    const done = findMatch("race", false, h.deps);
    await h.clock.drain();
    await done;
    assert.deepEqual(h.log.map((l) => l.what), ["join A"]);
    assert.equal(h.log[0]!.at, 3 * SEARCH_POLL_MS);
  });

  it("an unreachable relay hosts at once, weak or not: there is nothing to wait for", async () => {
    for (const fit of [true, false]) {
      const h = harness(() => null);
      const done = findMatch("race", fit, h.deps);
      await h.clock.drain();
      await done;
      assert.equal(h.log.length, 1);
      assert.equal(h.log[0]!.what, fit ? "host" : "host weak");
      assert.equal(h.log[0]!.at, 0);
    }
  });

  it("a search cancelled while a list is in flight joins and hosts nothing", async () => {
    const h = harness(() => [room("A", 1)]);
    const deps: MatchDeps = { ...h.deps, live: () => false };
    await findMatch("race", true, deps);
    await h.clock.drain();
    assert.deepEqual(h.log, []);
  });

  it("a room named in `skip` (the host that just died) is never joined", async () => {
    const h = harness(() => [room("A", 4)]);
    const done = findMatch("race", true, h.deps, [publicRoomName("race", "A")]);
    await h.clock.drain();
    await done;
    assert.equal(h.log[0]!.what, "host");
  });
});

describe("matchmaking: searchers who click together end in one room", () => {
  /** A guest whose room's host is gone starts another search after this (ms): net-play.ts `HOST_WAIT_MS`. */
  const HOST_WAIT_MS = 5000;
  const WIRE = { list: 120, register: 250, join: 250 };

  /**
   * N players, each pressing Play online `startsMs[i]` in, against a relay that shows a new room `register` ms
   * after its host made it and seats a joiner `join` ms after its press (latencies jittered by the seed). A
   * guest whose host left restarts its search after `HOST_WAIT_MS`, as `NetPlay` does. Returns the rooms that
   * stand once nothing is pending, and how many searches such a restart cost.
   */
  async function crowd(seed: number, startsMs: number[], fits: boolean[], latency = WIRE) {
    const clock = new Clock();
    const dice = rng(seed);
    const rooms = new Map<string, { players: number; guests: (() => void)[] }>();
    let restarts = 0;
    const kill = (name: string): void => {
      for (const gone of rooms.get(name)?.guests ?? []) gone();
      rooms.delete(name);
    };
    const play = async (i: number): Promise<void> => {
      await clock.sleep(startsMs[i]!);
      const skip: string[] = [];
      for (;;) {
        let mine: string | null = null;
        let joined: string | null = null;
        let gone: Promise<void> | null = null;
        const deps: MatchDeps = {
          list: async () => {
            await clock.sleep(latency.list * (0.5 + dice()));
            return [...rooms].map(([name, r]): LobbyRoom => ({ room: name, players: r.players, meta: "lobby.oval" }));
          },
          sleep: clock.sleep,
          random: dice,
          now: () => clock.now,
          join: (name) => {
            if (mine) kill(mine);
            mine = null;
            joined = name;
            gone = new Promise<void>((resolve) =>
              clock.at(latency.join * (0.5 + dice()), () => {
                const room = rooms.get(name);
                if (!room) return clock.at(HOST_WAIT_MS, resolve);
                room.players++;
                room.guests.push(() => clock.at(HOST_WAIT_MS, resolve));
              }),
            );
          },
          host: () => {
            const name = publicRoomName("race", `P${String.fromCharCode(65 + i)}${Math.floor(dice() * 1e6)}`);
            mine = name;
            clock.at(latency.register * (0.5 + dice()), () => rooms.set(name, { players: 1, guests: [] }));
            return name;
          },
          alone: () => (mine ? (rooms.get(mine)?.players ?? 1) <= 1 : true),
          live: () => true,
        };
        await findMatch("race", fits[i]!, deps, skip);
        if (!gone) return;
        await gone;
        skip.push(joined!);
        restarts++;
      }
    };
    void startsMs.map((_, i) => play(i));
    await clock.drain();
    return { rooms: [...rooms.values()].map((r) => r.players), restarts };
  }

  it("two capable players pressing at the same instant: one room of two, over 300 seeds, never a restart", async () => {
    const bad: number[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const r = await crowd(seed, [0, 0], [true, true]);
      if (r.rooms.length !== 1 || r.rooms[0] !== 2 || r.restarts > 0) bad.push(seed);
    }
    assert.deepEqual(bad, [], "seeds that ended in two rooms or needed a restart");
  });

  it("five players pressing within 300 ms, capable and weak mixed: no player is left alone, and 97 % of 200 seeds end in one room", async () => {
    // Two rooms made in the same quarter second each get a joiner before their hosts compare notes: both are live
    // rooms with players, so the rule leaves them (moving a host with guests would strand the guests).
    const loners: number[] = [];
    const split: number[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const dice = rng(seed * 7919);
      const starts = Array.from({ length: 5 }, () => Math.floor(dice() * 300));
      const fits = Array.from({ length: 5 }, () => dice() < 0.6);
      const r = await crowd(seed, starts, fits);
      if (r.rooms.some((players) => players < 2)) loners.push(seed);
      if (r.rooms.length !== 1) split.push(seed);
      assert.equal(r.restarts, 0, `seed ${seed}: nobody's host left under them`);
    }
    assert.deepEqual(loners, []);
    assert.ok(split.length <= 6, `${split.length} of 200 seeds ended in two rooms (${split})`);
  });

  it("a player pressing 2 s after another's room is up joins it (no second room)", async () => {
    const r = await crowd(5, [0, 2000], [true, true]);
    assert.deepEqual(r.rooms, [2]);
  });
});

describe("matchmaking: the live-rooms indicator's polling", () => {
  /** A fake timer set for the poller: `advance` runs what falls due, in order, letting each fetch settle. */
  function pollerHarness(results: (call: number) => LobbyRoom[] | null, visible = () => true) {
    let now = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let nextId = 1;
    const fetchedAt: number[] = [];
    const shown: (LobbyRoom[] | null)[] = [];
    const poller = new RoomPoller(
      {
        fetch: async () => {
          fetchedAt.push(now);
          return results(fetchedAt.length - 1);
        },
        setTimer: (fn, ms) => {
          const id = nextId++;
          timers.set(id, { at: now + ms, fn });
          return id;
        },
        clearTimer: (id) => void timers.delete(id as number),
        visible,
      },
      (rooms) => shown.push(rooms),
    );
    const advance = async (ms: number): Promise<void> => {
      const end = now + ms;
      for (;;) {
        await new Promise((resolve) => setImmediate(resolve));
        const due = [...timers].filter(([, t]) => t.at <= end).sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = end;
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { poller, advance, fetchedAt, shown, timers: () => timers.size };
  }

  it("fetches at once, then every POLL_COLLAPSED_MS while collapsed", async () => {
    const h = pollerHarness(() => []);
    h.poller.start();
    await h.advance(35_000);
    assert.deepEqual(h.fetchedAt, [0, 10_000, 20_000, 30_000]);
    h.poller.stop();
  });

  it("opening the list refreshes at once and then polls every POLL_EXPANDED_MS; closing returns to the slow rate", async () => {
    const h = pollerHarness(() => []);
    h.poller.start();
    await h.advance(1000);
    h.poller.setExpanded(true);
    await h.advance(9000);
    assert.deepEqual(h.fetchedAt, [0, 1000, 5000, 9000]);
    h.poller.setExpanded(false);
    await h.advance(20_000);
    assert.deepEqual(h.fetchedAt.slice(4), [13_000, 23_000]);
    h.poller.stop();
  });

  it("a failed poll (offline, rate limited) doubles the wait up to POLL_MAX_MS and a success resets it", async () => {
    const h = pollerHarness((call) => (call < 5 ? null : []));
    h.poller.start();
    await h.advance(400_000);
    const gaps = h.fetchedAt.slice(1).map((t, i) => t - h.fetchedAt[i]!);
    assert.deepEqual(gaps.slice(0, 5), [20_000, 40_000, 60_000, 60_000, 60_000]);
    assert.equal(gaps[5], POLL_COLLAPSED_MS, "back to the slow rate after one success");
    h.poller.stop();
  });

  it("asks nothing while the tab is hidden, and nothing after stop", async () => {
    let shown = false;
    const h = pollerHarness(() => [], () => shown);
    h.poller.start();
    await h.advance(60_000);
    assert.deepEqual(h.fetchedAt, []);
    shown = true;
    await h.advance(POLL_COLLAPSED_MS);
    assert.equal(h.fetchedAt.length, 1);
    h.poller.stop();
    const n = h.fetchedAt.length;
    await h.advance(120_000);
    assert.equal(h.fetchedAt.length, n);
    assert.equal(h.timers(), 0);
    assert.ok(POLL_EXPANDED_MS < POLL_COLLAPSED_MS);
  });
});
