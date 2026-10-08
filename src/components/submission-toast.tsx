import { useState, useSyncExternalStore } from "react";
import { Check, Copy, X } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { dismissStatus, getStatus, subscribeStatus, type Status } from "@/lib/submissions/status";

const WHAT = { bench: "Benchmark", capture: "Capture", flag: "Flagged clip" } as const;

/**
 * The last submission's outcome over the game (whatever started it): the receipt id to keep, with a copy button, or why
 * nothing went. It stays until dismissed, so a solo view's exit tap or the bench loop moving on does not lose it.
 */
export function SubmissionToast() {
  const status = useSyncExternalStore(subscribeStatus, getStatus, () => null);
  if (!status) return null;
  return (
    <div
      role={status.phase === "failed" ? "alert" : "status"}
      className="pointer-events-auto fixed bottom-24 left-1/2 z-[60] flex max-w-[calc(100vw-1rem)] -translate-x-1/2 items-center gap-2 rounded-lg bg-surface px-3 py-2 text-xs text-fg shadow-[var(--shadow-border)] sm:bottom-16"
    >
      <Line status={status} />
      {status.phase === "sending" ? null : (
        <button type="button" aria-label="Dismiss" title="Dismiss" className="grid size-7 shrink-0 place-items-center rounded text-muted hover:text-fg" onClick={dismissStatus}>
          <X className="size-4" />
        </button>
      )}
    </div>
  );
}

function Line({ status }: { status: Status }) {
  const [copied, setCopied] = useState(false);
  if (status.phase === "sending") return <span>Sending {WHAT[status.kind].toLowerCase()}...</span>;
  if (status.phase === "failed") {
    return (
      <span className="text-signal-red">
        {WHAT[status.kind]} not sent: {status.message}
      </span>
    );
  }
  return (
    <>
      <span>{WHAT[status.kind]} sent. Receipt</span>
      <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-sm tracking-wider select-all">{status.id}</code>
      <button
        type="button"
        aria-label="Copy receipt id"
        title="Copy receipt id"
        className="grid size-7 shrink-0 place-items-center rounded bg-surface-2 hover:bg-accent hover:text-accent-fg"
        onClick={() => {
          void copyText(status.id).then((ok) => {
            if (!ok) return;
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
          });
        }}
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </>
  );
}
