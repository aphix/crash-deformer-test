import { Button } from "@/components/ui/button";
import { useEngine } from "@/components/engine-context";
import type { CrashEngine } from "@/game/engine/engine";
import { sendSubmission, type Parcel } from "@/lib/submissions/status";
import { cn } from "@/lib/utils";

/** The clip `id` as a flag sends it, or why there is none: the engine no longer holds it (another reel, or its view ended). */
async function flagParcel(engine: CrashEngine | null, id: number): Promise<Parcel> {
  const flagged = await engine?.flagClip(id);
  if (!engine || !flagged) return "that clip is no longer on screen";
  return { context: engine.submitContext(), payload: flagged };
}

/**
 * [!]: flag the replay on screen. `clip` is the clip id the HUD read when this button was drawn (`flagButton`), so a tap lands on that
 * clip even if the reel has looped on by the time the request is made; null (the flight between clips) leaves nothing to press.
 */
export function FlagButton({ clip, className }: { clip: number | null; className?: string }) {
  const engine = useEngine();
  return (
    <Button
      variant="secondary"
      className={cn("h-8 min-w-8 px-0 font-display text-base font-bold leading-none", className)}
      aria-label="Flag this replay"
      title="Flag this replay as wrong"
      disabled={clip === null}
      onClick={() => {
        if (clip !== null) void sendSubmission("flag", () => flagParcel(engine.current, clip));
      }}
    >
      !
    </Button>
  );
}
