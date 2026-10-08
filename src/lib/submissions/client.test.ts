import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { MAX_JSON_BYTES, MAX_WIRE_BYTES } from "./kinds.ts";
import { envelopeOf, submit, type Device } from "./client.ts";

const DEVICE: Device = { sha: "3295bad", ua: "Mozilla/5.0 Test", screen: { w: 390, h: 844, dpr: 3 } };
const CONTEXT = { scene: "race", settings: { seed: 7, fxTier: "low", session: "k3x9q2", loop: 4 } };
const NOW = 1_791_000_000_000;

interface Sent {
  url: string;
  method: string;
  contentType: string | null;
  body: unknown;
}

/** A fetch that records the request it got and answers with `status` and `reply`. */
function answering(status: number, reply: string, sent: Sent[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    sent.push({ url, method: String(init.method), contentType: new Headers(init.headers).get("content-type"), body: JSON.parse(String(init.body)) });
    return new Response(reply, { status });
  }) as typeof fetch;
}

describe("given a bench card ready to submit from a phone", () => {
  it("when it is posted, then the server gets the running build, the device, the clock, the scene, the settings and the card in one JSON request, and the receipt comes back", async () => {
    const sent: Sent[] = [];
    const result = await submit("bench", CONTEXT, { result: { fps: 58 } }, { fetch: answering(201, '{"id":"K7QM-2XWD"}', sent), device: DEVICE, now: NOW, gzip: false });
    assert.deepEqual(result, { id: "K7QM-2XWD" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.method, "POST");
    assert.equal(sent[0]!.contentType, "application/json");
    assert.deepEqual(sent[0]!.body, {
      kind: "bench",
      sha: "3295bad",
      at: NOW,
      ua: "Mozilla/5.0 Test",
      screen: { w: 390, h: 844, dpr: 3 },
      scene: "race",
      settings: CONTEXT.settings,
      payload: { result: { fps: 58 } },
    });
  });

  it("when the browser can gzip, then the request is gzipped and says so, and the server can read back the same envelope", async () => {
    let seen: { encoding: string | null; text: string } | null = null;
    const fetcher = (async (_url: string, init: RequestInit) => {
      seen = { encoding: new Headers(init.headers).get("content-encoding"), text: gunzipSync(init.body as Uint8Array).toString("utf8") };
      return new Response('{"id":"K7QM-2XWD"}', { status: 201 });
    }) as typeof fetch;
    const payload = { samples: Array.from({ length: 200 }, (_, i) => ({ t: i / 4, x: i % 7 })) };
    const result = await submit("capture", CONTEXT, payload, { fetch: fetcher, device: DEVICE, now: NOW, gzip: true });
    assert.deepEqual(result, { id: "K7QM-2XWD" });
    assert.equal(seen!.encoding, "gzip");
    assert.deepEqual(JSON.parse(seen!.text), envelopeOf("capture", CONTEXT, payload, DEVICE, NOW));
  });

  it("when the envelope is built for each kind, then it names that kind and carries the same build and device", () => {
    for (const kind of ["bench", "capture", "flag"] as const) {
      const e = envelopeOf(kind, CONTEXT, {}, DEVICE, NOW);
      assert.deepEqual([e.kind, e.sha, e.ua], [kind, "3295bad", "Mozilla/5.0 Test"]);
    }
  });
});

describe("given a submission the server refuses or cannot be reached for", () => {
  const cases = [
    { it: "the server's store is full", status: 507, reply: "{}", error: "the server's store is full" },
    { it: "the address has posted too much", status: 429, reply: "{}", error: "too many submissions just now, try again in a minute" },
    { it: "a proxy in front answers 413 with an HTML page", status: 413, reply: "<html>too large</html>", error: "too big to send" },
    { it: "the server fails", status: 500, reply: "{}", error: "the server answered 500" },
    { it: "the server accepts it but sends no receipt", status: 201, reply: "{}", error: "the server sent no receipt" },
  ];
  for (const testCase of cases) {
    it(`when ${testCase.it}, then the player is told: ${testCase.error}`, async () => {
      const result = await submit("bench", CONTEXT, {}, { fetch: answering(testCase.status, testCase.reply), device: DEVICE, now: NOW, gzip: false });
      assert.deepEqual(result, { error: testCase.error });
    });
  }

  it("when the network is down, then the player is told the server could not be reached", async () => {
    const offline = (async () => Promise.reject(new TypeError("offline"))) as typeof fetch;
    assert.deepEqual(await submit("bench", CONTEXT, {}, { fetch: offline, device: DEVICE, now: NOW }), { error: "could not reach the server" });
  });

  it("when a card is over the bench size cap, then nothing is sent and the player is told how big it is", async () => {
    const sent: Sent[] = [];
    const big = { filler: "x".repeat(MAX_JSON_BYTES.bench) };
    const result = await submit("bench", CONTEXT, big, { fetch: answering(201, '{"id":"K7QM-2XWD"}', sent), device: DEVICE, now: NOW, gzip: false });
    assert.deepEqual(sent, []);
    assert.ok("error" in result && result.error.startsWith("too big to send (49 KB, at most 48 KB)"), JSON.stringify(result));
  });

  it("when a body that is not gzipped is over the wire cap, then nothing is sent and the player is told how big it is on the wire", async () => {
    const sent: Sent[] = [];
    const big = { samples: [{ filler: "x".repeat(MAX_WIRE_BYTES + 1) }] };
    const result = await submit("capture", CONTEXT, big, { fetch: answering(201, '{"id":"K7QM-2XWD"}', sent), device: DEVICE, now: NOW, gzip: false });
    assert.deepEqual(sent, []);
    assert.ok("error" in result && result.error.includes("on the wire"), JSON.stringify(result));
  });
});
