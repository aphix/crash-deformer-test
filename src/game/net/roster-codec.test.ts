import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROOM_MAX } from "../../lib/multiplayer/rooms.ts";
import { MAX_NET_CARS, MSG } from "./codec.ts";
import { packRoster, readRoster } from "./roster-codec.ts";

const roundTripCases = [
  { it: "when a roster of the host alone is sent, then the guest reads the host in car 0", entries: [{ peer: "a1b2c3d4", car: 0 }] },
  { it: "when a roster of a host and two guests is sent, then every peer comes back with its car, in order", entries: [{ peer: "a1b2c3d4", car: 0 }, { peer: "e5f6a7b8", car: 1 }, { peer: "c9d0e1f2", car: 5 }] },
  { it: "when a roster of an empty room is sent, then it reads back empty", entries: [] },
  { it: "when a peer id uses the relay's whole alphabet and its longest length, then it survives", entries: [{ peer: `Az09_-${"x".repeat(58)}`, car: MAX_NET_CARS - 1 }] },
] as const;

describe("given the host's roster of peers and their cars", () => {
  for (const testCase of roundTripCases) {
    it(testCase.it, () => {
      const read = readRoster(packRoster(testCase.entries));
      assert.ok(read, "the message reads");
      assert.equal(read.length, testCase.entries.length, "entry count");
      for (let i = 0; i < testCase.entries.length; i++) {
        assert.equal(read[i]!.peer, testCase.entries[i]!.peer, `entry ${i} peer`);
        assert.equal(read[i]!.car, testCase.entries[i]!.car, `entry ${i} car`);
      }
    });
  }
});

const good = packRoster([{ peer: "a1b2c3d4", car: 1 }, { peer: "e5f6a7b8", car: 2 }]);
const withByte = (index: number, value: number): Uint8Array => {
  const copy = good.slice();
  copy[index] = value;
  return copy;
};

const hostileCases = [
  { it: "when the message is empty, then it is not a roster", data: new Uint8Array(0) },
  { it: "when the type byte is another message's, then it is not a roster", data: withByte(0, MSG.look) },
  { it: "when the count promises more entries than the bytes hold, then it is not a roster", data: withByte(1, 3) },
  { it: "when the count is over the room size, then it is not a roster", data: withByte(1, ROOM_MAX + 1) },
  { it: "when a car index is past the field, then it is not a roster", data: withByte(2, MAX_NET_CARS) },
  { it: "when a peer id's length runs past the end, then it is not a roster", data: withByte(3, 200) },
  { it: "when a peer id holds a character the relay never issues, then it is not a roster", data: withByte(4, 0x20) },
  { it: "when a peer id is empty, then it is not a roster", data: withByte(3, 0) },
  { it: "when bytes trail the last entry, then it is not a roster", data: Uint8Array.from([...good, 0]) },
  { it: "when the last entry is cut short, then it is not a roster", data: good.slice(0, good.length - 1) },
] as const;

describe("given a roster message from a peer that cannot be trusted", () => {
  for (const testCase of hostileCases) {
    it(testCase.it, () => {
      assert.equal(readRoster(testCase.data), null);
    });
  }

  it("when the unmodified message is read, then the cases above fail only for the byte they change", () => {
    const read = readRoster(good);
    assert.ok(read, "the untouched message reads");
    assert.equal(read.length, 2, "entry count");
  });
});
