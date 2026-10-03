import { useEffect, useRef, useState, type RefObject } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CrashEngine } from "@/game/engine/engine";
import { roomLink } from "@/game/hud/share-url";
import type { NetStatus } from "@/game/net/net-ports";
import { cn } from "@/lib/utils";

/** 44 px tall on phones, 32 px from `sm`. */
const CONTROL = "h-11 sm:h-8";

/**
 * The room this browser hosts or has joined, as something to read out and pass on: the code big, a one-tap Copy link
 * (the page URL with `#room=CODE`: opening it joins) and, where the browser has it (phones), the system Share sheet.
 * A browser that refuses the clipboard (plain http, a locked-down frame) gets the link in a selected box instead.
 * A guest whose room has no host (`problem: "no-host"`) can host it. `onOpen` makes the code a button (the collapsed panel's chip).
 */
export function RoomShare({ engine, status, onOpen }: { engine: RefObject<CrashEngine | null>; status: NetStatus; onOpen?: () => void }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "manual">("idle");
  const [canShare, setCanShare] = useState(false);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => setCanShare(typeof navigator.share === "function"), []);
  useEffect(() => {
    if (copy === "copied") {
      const id = window.setTimeout(() => setCopy("idle"), 2000);
      return () => window.clearTimeout(id);
    }
    if (copy === "manual") box.current?.select();
  }, [copy]);

  const link = roomLink(`${window.location.origin}${import.meta.env.BASE_URL}`, status.room, status.tx);
  const label = status.room;
  const write = (): void => {
    const done = navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject(new Error("no clipboard"));
    void done.then(
      () => setCopy("copied"),
      () => setCopy("manual"),
    );
  };
  const share = (): void => {
    // A dismissed share sheet rejects (AbortError): nothing to report.
    void navigator.share({ title: "Crush Stream", text: `Join my room ${label}`, url: link }).catch(() => undefined);
  };
  // The code never truncates: in a narrow panel the buttons wrap under it instead.
  const codeClass = "min-w-max flex-1 text-left font-display text-xl tabular-nums tracking-[0.12em] select-all";

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {onOpen ? (
          <button type="button" className={cn(codeClass, "rounded-md px-1", CONTROL)} onClick={onOpen} aria-label={`Room ${label}: open the multiplayer panel`}>
            {label}
          </button>
        ) : (
          <p className={codeClass} aria-label="Room code">
            {label}
          </p>
        )}
        <Button variant="secondary" className={cn(CONTROL, "shrink-0 gap-1.5 px-3 text-xs")} onClick={write} aria-label="Copy room link" aria-live="polite">
          {copy === "copied" ? <Check /> : <Copy />}
          {copy === "copied" ? "Copied" : "Copy link"}
        </Button>
        {canShare ? (
          <Button variant="secondary" className={cn(CONTROL, "w-11 shrink-0 px-0 sm:w-8")} onClick={share} aria-label="Share room link">
            <Share2 />
          </Button>
        ) : null}
      </div>
      {copy === "manual" ? (
        <input
          ref={box}
          readOnly
          value={link}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Room link: select and copy"
          className={cn(CONTROL, "w-full rounded-md bg-surface-2 px-2 text-xs")}
        />
      ) : null}
      {status.problem === "no-host" ? (
        <Button className={cn(CONTROL, "w-full text-xs")} onClick={() => engine.current?.net.host(status.room, status.tx)}>
          Host this room
        </Button>
      ) : null}
    </div>
  );
}
