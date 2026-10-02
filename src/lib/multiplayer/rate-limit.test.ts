import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, RateLimiter } from "./rate-limit.ts";
import { ROOM_MAX } from "./rooms.ts";

/** One relay request as signaling.server.ts admits it: the address, then the peer. Its room spends no bucket. */
function request(l: RateLimiter, ip: string, peer: string, _room: string, now: number): boolean {
  return l.ip(ip, now) && l.peer(ip, peer, now);
}

describe("signaling rate limits", () => {
  it("lets a full room of friends behind one NAT finish their mesh handshake", () => {
    const l = new RateLimiter();
    // Worse than the measured 8-page smoke (~30 requests per peer over 7 s): 60 per peer inside 2 s.
    let refused = 0;
    for (let k = 0; k < 60; k++) {
      for (let p = 0; p < ROOM_MAX; p++) if (!request(l, "nat", `peer${p}`, "pub-ROOM", k * 33)) refused++;
    }
    assert.equal(refused, 0);
  });

  it("holds one peer id that floods to one peer's burst, then its refill rate", () => {
    const l = new RateLimiter();
    let ok = 0;
    for (let k = 0; k < 1000; k++) if (request(l, "a", "same", "R", 0)) ok++;
    assert.equal(ok, LIMITS.peer.burst);
    ok = 0;
    for (let k = 0; k < 1000; k++) if (request(l, "a", "same", "R", 1000)) ok++;
    assert.equal(ok, LIMITS.peer.rate);
  });

  it("holds an address that rotates peer ids to a full room's worth", () => {
    const l = new RateLimiter();
    let ok = 0;
    for (let k = 0; k < 5000; k++) if (request(l, "a", `p${k}`, `R${k}`, 0)) ok++;
    assert.equal(ok, LIMITS.ip.burst);
  });

  it("keeps an exhausted address or peer id from costing anyone else", () => {
    const l = new RateLimiter();
    for (let k = 0; k < 5000; k++) request(l, "a", `p${k}`, `R${k}`, 0);
    for (let k = 0; k < 1000; k++) request(l, "b", "victim", "S", 0);
    // Same peer id from another address: its own bucket, not the flooder's.
    assert.ok(request(l, "c", "victim", "T", 0));
    assert.ok(l.list("c", 0));
  });

  it("admits a new address and peer however many keys flooders mint", () => {
    // ReviewA's probe: three addresses at their full rate, a fresh peer and room per request, 70 s.
    const l = new RateLimiter();
    const tick = 1000 / LIMITS.ip.rate;
    let now = 0;
    for (let k = 0; now < 70_000; k++, now = k * tick) {
      for (const ip of ["x1", "x2", "x3"]) request(l, ip, `${ip}-${k}`, `R${ip}-${k}`, now);
    }
    assert.ok(request(l, "victim", "fresh", "pub-race-X", now - tick));
  });

  it("keeps an outsider rotating peer ids from spending a room's members' budget", () => {
    const l = new RateLimiter();
    for (let k = 0; k < 5000; k++) request(l, "outsider", `p${k}`, "pub-race-R", 0);
    for (let p = 0; p < ROOM_MAX; p++) assert.ok(request(l, "nat", `peer${p}`, "pub-race-R", 0), `peer${p}`);
  });
});
