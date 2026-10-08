import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { leaveFollowUp } from "./online-leave.ts";
import type { NetRole } from "../net/net-ports.ts";

const testCases = [
  { it: "when a guest leaves in race mode, then race mode closes with its host's", role: "client", inRace: true, expected: "close-race" },
  { it: "when a host leaves in race mode, then the race goes back to its setup menu", role: "host", inRace: true, expected: "quit-race" },
  { it: "when a guest leaves a private room in the Fleet, then the scene is left as it is (no race is started)", role: "client", inRace: false, expected: "none" },
  { it: "when a host leaves outside race mode, then the scene is left as it is", role: "host", inRace: false, expected: "none" },
  { it: "when a browser still searching for a public race (no role yet) stops in race mode, then the scene is left as it is", role: "off", inRace: true, expected: "none" },
] as const satisfies readonly { it: string; role: NetRole; inRace: boolean; expected: string }[];

describe("given a browser leaving its online session", () => {
  for (const testCase of testCases) {
    it(testCase.it, () => {
      assert.equal(leaveFollowUp(testCase.role, testCase.inRace), testCase.expected, "scene follow-up");
    });
  }
});
