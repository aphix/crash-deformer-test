import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "@/lib/db";
import { handleSignaling } from "./signaling.server.ts";
import { ROOM_MAX, TOKEN_HEADER } from "./rooms.ts";

const MIGRATIONS = new URL("../../../migrations/", import.meta.url);

/** An in-memory relay database with `migrations/*.sql` applied; `legacy` writes rows between 0002 and the later files. */
async function relayDb(legacy?: (pg: PGlite) => Promise<void>): Promise<Sql> {
  const pg = new PGlite({ parsers: { 20: Number } }); // int8 as db.ts parses it
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await pg.exec(readFileSync(new URL(file, MIGRATIONS), "utf8"));
    if (file.startsWith("0002") && legacy) await legacy(pg);
  }
  return { query: async (text: string, params?: unknown[]) => (await pg.query(text, params)).rows } as unknown as Sql;
}

interface Reply {
  status: number;
  body: { error?: string; token?: string; peers?: { id: string; name: string }[]; signals?: { from: string }[] };
}

let lastIp = 0;

/** One browser tab on the relay: its address (its own unless given) and peer id, and the token once one is issued. */
function tab(sql: Sql, room: string, id: string, name = "client", ip = `10.0.${lastIp >> 8}.${lastIp++ & 255}`) {
  const self = {
    id,
    name,
    token: "",
    async call(search: string, init?: RequestInit): Promise<Reply> {
      const headers = { "x-forwarded-for": ip, [TOKEN_HEADER]: self.token };
      const res = await handleSignaling(new Request(`http://relay.test/api/rtc${search}`, { ...init, headers }), async () => sql);
      return { status: res.status, body: (await res.json()) as Reply["body"] };
    },
    async poll(): Promise<Reply> {
      const res = await self.call(`?${new URLSearchParams({ room, peer: id, name: self.name, since: "0" })}`);
      if (res.body.token) self.token = res.body.token;
      return res;
    },
    post: (body: object) => self.call("", { method: "POST", body: JSON.stringify({ room, ...body }) }),
    offer: (to: string) => self.post({ op: "signal", from: id, to, kind: "offer", payload: { sdp: id } }),
  };
  return self;
}

describe("signaling relay", () => {
  let sql: Sql;
  before(async () => {
    sql = await relayDb();
  });

  it("lets only a peer's own tab read its inbox, signal as it or remove it", async () => {
    const host = tab(sql, "AUTH1", "aaaa0001", "host");
    const guest = tab(sql, "AUTH1", "bbbb0002");
    assert.equal((await host.poll()).status, 200);
    assert.equal((await guest.poll()).status, 200);
    assert.equal((await guest.offer(host.id)).status, 200);

    const forger = tab(sql, "AUTH1", host.id, "host");
    const read = await forger.poll();
    assert.equal(read.status, 403);
    assert.equal(read.body.signals, undefined);
    assert.equal((await forger.offer(guest.id)).status, 403);
    assert.equal((await forger.post({ op: "leave", peer: host.id })).status, 403);

    const inbox = await host.poll();
    assert.deepEqual(inbox.body.signals?.map((s) => s.from), ["bbbb0002"]);
    assert.deepEqual(inbox.body.peers?.map((p) => p.id), ["aaaa0001", "bbbb0002"]);
    assert.equal((await guest.poll()).body.signals?.length, 0);

    assert.equal((await host.post({ op: "leave", peer: host.id })).status, 200);
    assert.deepEqual((await guest.poll()).body.peers?.map((p) => p.id), ["bbbb0002"]);
  });

  it("keeps the role tag a peer registered with, and one host per room", async () => {
    const host = tab(sql, "ROLE1", "aaaa0001", "host");
    const guest = tab(sql, "ROLE1", "bbbb0002");
    await host.poll();
    await guest.poll();
    guest.name = "host";
    await guest.poll();
    assert.deepEqual((await host.poll()).body.peers, [
      { id: "aaaa0001", name: "host" },
      { id: "bbbb0002", name: "client" },
    ]);
    const second = await tab(sql, "ROLE1", "cccc0003", "host").poll();
    assert.deepEqual([second.status, second.body.error], [409, "host taken"]);
  });

  it("keeps seated members seated when fake ids rush the room at once", async () => {
    const host = tab(sql, "RUSH1", "f00d0001", "host");
    const guest = tab(sql, "RUSH1", "f00d0002");
    await host.poll();
    await guest.poll();
    const fakes = Array.from({ length: ROOM_MAX }, (_, k) => tab(sql, "RUSH1", `0000000${k}`));
    const statuses = (await Promise.all(fakes.map((f) => f.poll()))).map((r) => r.status);
    for (const member of [host, guest]) {
      const res = await member.poll();
      assert.equal(res.status, 200);
      assert.equal(res.body.peers?.length, ROOM_MAX);
      assert.ok(res.body.peers?.some((p) => p.id === host.id) && res.body.peers.some((p) => p.id === guest.id));
    }
    assert.equal(statuses.filter((s) => s === 200).length, ROOM_MAX - 2);
  });

  it("keeps one member's backlog from filling another member's inbox", async () => {
    const host = tab(sql, "FLOOD1", "aaaa0001", "host");
    const flooder = tab(sql, "FLOOD1", "bbbb0002");
    const late = tab(sql, "FLOOD1", "cccc0003");
    for (const t of [host, flooder, late]) await t.poll();
    await sql.query(
      `INSERT INTO webrtc_signals (room, to_peer, from_peer, kind, payload)
       SELECT 'FLOOD1', $1, $2, 'ice', '{}' FROM generate_series(1, 400)`,
      [host.id, flooder.id],
    );
    assert.equal((await flooder.offer(host.id)).status, 429);
    assert.equal((await late.offer(host.id)).status, 200);
  });

  it("ranks a public room of real players above one address's padded rooms, and caps the rooms it hosts", async () => {
    // Every attacker tab has its own address, all in one subscriber's IPv6 /64.
    let n = 0;
    const attacker = (room: string, id: string, name?: string) => tab(sql, room, id, name, `2001:db8:0:1::${(++n).toString(16)}`);
    for (const [k, room] of ["pub-race-AAAA01", "pub-race-AAAA02"].entries()) {
      assert.equal((await attacker(room, `a${k}h`, "host").poll()).status, 200);
      for (let c = 0; c < ROOM_MAX - 2; c++) assert.equal((await attacker(room, `a${k}c${c}`).poll()).status, 200);
    }
    await tab(sql, "pub-race-ZZZZ01", "realhost", "host").poll();
    await tab(sql, "pub-race-ZZZZ01", "realguest").poll();
    const list = await handleSignaling(
      new Request("http://relay.test/api/rtc?list=public&kind=race", { headers: { "x-forwarded-for": "10.9.9.9" } }),
      async () => sql,
    );
    const listed: { rooms: { room: string }[] } = await list.json();
    assert.equal(listed.rooms[0]?.room, "pub-race-ZZZZ01");

    const third = await attacker("pub-race-AAAA03", "a2h", "host").poll();
    assert.deepEqual([third.status, third.body.error], [429, "too many public rooms"]);
  });

  it("keeps offering a public room through its host's stall between polls, and drops it once the host is gone", async () => {
    // Measured in a browser: a host's first course warm-up held its polls back 5.6–8.6 s.
    await tab(sql, "pub-derby-STALL1", "stallhost", "host").poll();
    await tab(sql, "pub-derby-GONE1", "gonehost", "host").poll();
    const since = `UPDATE webrtc_peers SET last_seen = now() - make_interval(secs => $2) WHERE room = $1`;
    await sql.query(since, ["pub-derby-STALL1", 9]);
    await sql.query(since, ["pub-derby-GONE1", 20]);
    const list = await handleSignaling(
      new Request("http://relay.test/api/rtc?list=public&kind=derby", { headers: { "x-forwarded-for": "10.9.9.8" } }),
      async () => sql,
    );
    const listed: { rooms: { room: string }[] } = await list.json();
    assert.deepEqual(listed.rooms.map((r) => r.room), ["pub-derby-STALL1"]);
  });

  it("migrates a store the pre-token relay wrote", async () => {
    const legacy = await relayDb(async (pg) => {
      for (let k = 0; k <= ROOM_MAX; k++) {
        await pg.query(`INSERT INTO webrtc_peers (room, peer_id, name) VALUES ('OLD1', $1, 'host')`, [`old${k}`]);
      }
    });
    const fresh = tab(legacy, "OLD1", "aaaa0001", "host");
    const res = await fresh.poll();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.peers, [{ id: "aaaa0001", name: "host" }]);
  });
});
