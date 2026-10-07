/**
 * What the player sees of their last submission: sending, the receipt id to keep, or why it did not go. One store for
 * every kind (a bench card, a capture, a flagged clip), so the notice outlives the button that started it (a solo
 * view's exit tap, the bench loop moving on).
 */
import { submit, type SubmitContext, type SubmitResult } from "./client.ts";
import type { Kind } from "./kinds.ts";

export type Status =
  | { phase: "sending"; kind: Kind }
  | { phase: "sent"; kind: Kind; id: string }
  | { phase: "failed"; kind: Kind; message: string };

/** What one submission is made of; a string says why there is nothing to send now (the clip is no longer on screen). */
export type Parcel = { context: SubmitContext; payload: unknown } | string;

let current: Status | null = null;
const listeners = new Set<() => void>();

function setStatus(next: Status | null): void {
  current = next;
  for (const listener of listeners) listener();
}

export function subscribeStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getStatus(): Status | null {
  return current;
}

export function dismissStatus(): void {
  setStatus(null);
}

/** Make a submission and post it: the status shows it sending, then its receipt or why it was not sent; resolves to the same outcome. */
export async function sendSubmission(kind: Kind, make: () => Promise<Parcel>, post: typeof submit = submit): Promise<SubmitResult> {
  setStatus({ phase: "sending", kind });
  const parcel = await make();
  const result: SubmitResult = typeof parcel === "string" ? { error: parcel } : await post(kind, parcel.context, parcel.payload);
  setStatus("id" in result ? { phase: "sent", kind, id: result.id } : { phase: "failed", kind, message: result.error });
  return result;
}
