import { useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { reloadOntoUpdate } from "@/lib/deploy/update-check";
import { useCoarsePointer } from "@/components/use-coarse-pointer";

/** A small, non-blocking prompt: a newer build is deployed. Nothing reloads until the player taps it (`newer` is null while a race holds it back). */
export function UpdateNotice({ newer }: { newer: string | null }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (newer === null || dismissed === newer) return null;
  return (
    <div className="pointer-events-auto fixed left-1/2 top-2 z-[60] flex -translate-x-1/2 items-center gap-1 rounded-full bg-surface pl-3 pr-1 text-xs text-fg shadow-[var(--shadow-border)]">
      <button type="button" className="flex h-9 items-center gap-1.5 font-medium" onClick={() => reloadOntoUpdate(newer, true)}>
        <RefreshCw className="size-3.5" />
        Update available: tap to refresh
      </button>
      <button type="button" aria-label="Dismiss update notice" title="Dismiss" className="grid size-9 place-items-center rounded-full text-muted hover:text-fg" onClick={() => setDismissed(newer)}>
        <X className="size-4" />
      </button>
    </div>
  );
}

/** The running build's short sha in a screen corner, faint, on a desktop (a touch device finds it in the menu's Debug views). */
export function BuildLabel() {
  const touch = useCoarsePointer();
  if (touch) return null;
  return <p className="pointer-events-none fixed bottom-1 right-2 z-[5] select-none font-mono text-[10px] text-fg opacity-35">build {__BUILD_SHA__}</p>;
}
