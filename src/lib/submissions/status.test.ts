import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { dismissStatus, getStatus, sendSubmission, subscribeStatus, type Status } from "./status.ts";
import type { submit } from "./client.ts";

const CONTEXT = { scene: "race", settings: { seed: 1 } };

/** The statuses a submission goes through, in order. */
async function statusesOf(run: () => Promise<unknown>): Promise<(Status | null)[]> {
  const seen: (Status | null)[] = [];
  const stop = subscribeStatus(() => seen.push(getStatus()));
  await run();
  stop();
  return seen;
}

afterEach(dismissStatus);

describe("given a player who presses Submit, [!] or finishes a bench in the loop", () => {
  it("when the server accepts it, then the player sees it sending and then its receipt id, which stays until dismissed", async () => {
    const post: typeof submit = async () => ({ id: "K7QM-2XWD" });
    const seen = await statusesOf(() => sendSubmission("flag", async () => ({ context: CONTEXT, payload: { clip: "x" } }), post));
    assert.deepEqual(seen, [
      { phase: "sending", kind: "flag" },
      { phase: "sent", kind: "flag", id: "K7QM-2XWD" },
    ]);
    assert.deepEqual(getStatus(), { phase: "sent", kind: "flag", id: "K7QM-2XWD" });
    dismissStatus();
    assert.equal(getStatus(), null);
  });

  it("when the server refuses it, then the player sees why it was not sent", async () => {
    const post: typeof submit = async () => ({ error: "too many submissions just now, try again in a minute" });
    await sendSubmission("bench", async () => ({ context: CONTEXT, payload: {} }), post);
    assert.deepEqual(getStatus(), { phase: "failed", kind: "bench", message: "too many submissions just now, try again in a minute" });
  });

  it("when there is nothing to send (the clip is gone), then nothing is posted and the player sees why", async () => {
    let posts = 0;
    const post: typeof submit = async () => (posts++, { id: "K7QM-2XWD" });
    const result = await sendSubmission("flag", async () => "that clip is no longer on screen", post);
    assert.equal(posts, 0);
    assert.deepEqual(result, { error: "that clip is no longer on screen" });
    assert.deepEqual(getStatus(), { phase: "failed", kind: "flag", message: "that clip is no longer on screen" });
  });

  it("when a newer submission finishes after an older one, then the newest outcome is the one shown", async () => {
    await sendSubmission("capture", async () => ({ context: CONTEXT, payload: {} }), async () => ({ id: "AAAA-AAAA" }));
    await sendSubmission("flag", async () => ({ context: CONTEXT, payload: {} }), async () => ({ id: "BBBB-BBBB" }));
    assert.deepEqual(getStatus(), { phase: "sent", kind: "flag", id: "BBBB-BBBB" });
  });
});
