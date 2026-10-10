import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ROOM_MAX } from "../../lib/multiplayer/rooms.ts";
import { NAME_MAX } from "../match/types.ts";
import { MAX_NET_CARS, MSG } from "./codec.ts";
import { packRoster, readRoster } from "./roster-codec.ts";

const roundTripCases = [
  { it: "when a roster of the host alone is sent, then the guest reads the host in car 0 under its name", entries: [{ peer: "a1b2c3d4", car: 0, name: "Ann" }] },
  { it: "when a roster of a host and two guests is sent, then every peer comes back with its car and name, in order", entries: [{ peer: "a1b2c3d4", car: 0, name: "Ann" }, { peer: "e5f6a7b8", car: 1, name: "Zed the Great" }, { peer: "c9d0e1f2", car: 5, name: "Player 5" }] },
  { it: "when a roster of an empty room is sent, then it reads back empty", entries: [] },
  { it: "when a peer id uses the relay's whole alphabet and its longest length, then it survives", entries: [{ peer: `Az09_-${"x".repeat(58)}`, car: MAX_NET_CARS - 1, name: "x" }] },
  { it: "when a name is empty, then it reads back empty", entries: [{ peer: "a1b2c3d4", car: 2, name: "" }] },
  { it: "when a name is 16 four-byte characters (the longest a cleaned name gets), then it survives whole", entries: [{ peer: "a1b2c3d4", car: 2, name: "😀".repeat(NAME_MAX) }] },
  { it: "when a name is accented and in another script, then it survives byte for byte", entries: [{ peer: "a1b2c3d4", car: 2, name: "Zoë Łukasz 名前" }] },
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
        assert.equal(read[i]!.name, testCase.entries[i]!.name, `entry ${i} name`);
      }
    });
  }
});

const good = packRoster([{ peer: "a1b2c3d4", car: 1, name: "Ann" }, { peer: "e5f6a7b8", car: 2, name: "Zed" }]);
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
  { it: "when a name's length runs past the end, then it is not a roster", data: withByte(good.length - 4, 200) },
  { it: "when a name's length is over what a cleaned name can take, then it is not a roster", data: withByte(good.length - 4, NAME_MAX * 4 + 1) },
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

/** Hostile names: what a rogue host (or a bug) packs, as every peer reads it back. */
const hostileNames = [
  { it: "when a name has bidi overrides and zero-width characters, then the reader drops them", raw: "Zed\u202Eevil\u200B", read: "Zedevil" },
  { it: "when a name has tabs, newlines and runs of spaces, then the reader folds them to single spaces", raw: "a\t\n  b", read: "a b" },
  { it: "when a name has a stack of combining marks, then the reader keeps two per letter", raw: `e${"\u0301".repeat(20)}`, read: `e${"\u0301".repeat(2)}` },
  { it: "when a name is far over 16 characters, then the reader cuts it to 16", raw: "x".repeat(200), read: "x".repeat(16) },
  { it: "when a name is nothing but control characters, then the reader sees no name", raw: "\u0000\u0007\u202E", read: "" },
] as const;

describe("given a roster whose names are hostile", () => {
  for (const testCase of hostileNames) {
    it(testCase.it, () => {
      // `packRoster` cleans too: build the bytes by hand so the reader's own cleaning is what is tested.
      const id = new TextEncoder().encode("a1b2c3d4");
      const name = new TextEncoder().encode(testCase.raw).slice(0, NAME_MAX * 4);
      const bytes = Uint8Array.from([MSG.roster, 1, 1, id.length, ...id, name.length, ...name]);
      assert.equal(readRoster(bytes)?.[0]?.name, testCase.read);
    });
  }

  it("when the host packs a hostile name, then the message already carries it cleaned", () => {
    const read = readRoster(packRoster([{ peer: "a1b2c3d4", car: 1, name: "  Zed\u202E\u0000 the\tquick brown fox jumps  " }]));
    assert.equal(read?.[0]?.name, "Zed the quick br");
  });
});
