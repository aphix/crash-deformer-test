import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sessionText } from "./session-text.ts";
import type { NetStatus } from "./net-ports.ts";

const guestInPrivateRoom: NetStatus = {
  role: "client",
  public: null,
  finding: false,
  room: "K7M2QX9P",
  tx: "rtc",
  selfId: "self",
  car: 1,
  lobby: null,
  gate: null,
  peers: [{ id: "host", rttMs: 30 }],
  snapHz: 30,
  bytesPerSec: 1024,
  problem: null,
  relayError: null,
};

const testCases = [
  { it: "when a guest is in a private room with the race on, then the chip names the room, the players and that the race is on", change: {}, expected: "Room K7M2QX9P · 2/8 · race on" },
  { it: "when a guest is in a public room's lobby, then the chip counts down to the start", change: { public: "race", lobby: 9 }, expected: "Joined · 2/8 · starts in 9 s" },
  { it: "when a host is alone in its public lobby, then the chip says it waits for players", change: { role: "host", public: "race", lobby: 12, peers: [] }, expected: "Waiting for players · starts in 12 s" },
  { it: "when a browser is still looking for a public race, then the chip says it is finding one", change: { role: "off", finding: true, peers: [] }, expected: "Finding a race…" },
  { it: "when the relay refused the guest, then the chip says why, first letter capitalised, instead of the room line", change: { relayError: "room full" }, expected: "Room full" },
  { it: "when the host runs another build, then the chip tells the guest to reload", change: { problem: "version" }, expected: "Different game version: reload" },
  { it: "when the host left, then the chip says the guest waits for a new host", change: { problem: "host-lost" }, expected: "Host left: waiting for a new host…" },
  { it: "when nobody answered in the room, then the chip says it may be closed", change: { problem: "no-host", peers: [] }, expected: "Nobody is hosting this room: it may be closed" },
  { it: "when the relay refused the guest and the host is also paused, then the refusal wins", change: { relayError: "host taken", problem: "host-paused" }, expected: "Host taken" },
  { it: "when a host is alone in a private lobby that needs two players, then the chip says it waits for one more player", change: { role: "host", peers: [], gate: { min: 2, kind: "race", players: 1 } }, expected: "Waiting for 1 more player" },
  { it: "when a guest is in a private lobby that needs three players and two are there, then the chip says the room waits for one more", change: { gate: { min: 3, kind: "race", players: 2 } }, expected: "Room K7M2QX9P · 2/8 · waiting for 1 more" },
  { it: "when the lobby has its players and the viewer is the host, then the chip says it is ready to go", change: { role: "host", gate: { min: 2, kind: "race", players: 2 } }, expected: "Room K7M2QX9P · 2/8 · ready to go" },
  { it: "when the lobby has its players and the viewer is a guest, then the chip says it waits for the host", change: { gate: { min: 2, kind: "race", players: 2 } }, expected: "Room K7M2QX9P · 2/8 · waiting for the host" },
  { it: "when a public lobby has its players and counts down, then the chip counts down to the start", change: { public: "race", lobby: 9, gate: { min: 2, kind: "race", players: 2 } }, expected: "Joined · 2/8 · starts in 9 s" },
] as const satisfies readonly { it: string; change: Partial<NetStatus>; expected: string }[];

describe("given a session's status", () => {
  for (const testCase of testCases) {
    it(testCase.it, () => {
      assert.equal(sessionText({ ...guestInPrivateRoom, ...testCase.change }), testCase.expected, "chip text");
    });
  }

  it("when the lobby counts down, then the screen-reader line leaves the seconds out so only a state change announces", () => {
    const lobby = { ...guestInPrivateRoom, public: "race", lobby: 9 } as const;
    assert.equal(sessionText(lobby, false), "Joined · 2/8 · in the lobby", "without seconds");
    assert.equal(sessionText({ ...lobby, lobby: 8 }, false), "Joined · 2/8 · in the lobby", "one second later it is the same line");
  });
});
