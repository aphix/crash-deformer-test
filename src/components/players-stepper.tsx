import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ROOM_MAX } from "@/lib/multiplayer/rooms";
import { cn } from "@/lib/utils";

/** Taps stay 44 px tall on phones, 32 px from `sm`. */
const TAP = "h-11 sm:h-8";
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

/**
 * "N players to start": how many players (the host included) the Havana lobby's Go waits for, 1 to the room size. The host sets it
 * before hosting (the hosting panel) and while the room waits (the lobby gate); `onStep` gets the change, the caller clamps nothing.
 */
export function PlayersStepper({ value, onStep }: { value: number; onStep: (by: number) => void }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Players needed before Go">
      <Button className={cn(TAP, "px-2")} variant="secondary" disabled={value <= 1} aria-label="Fewer players needed" onMouseDown={keepFocus} onClick={() => onStep(-1)}>
        <Minus />
      </Button>
      <span className="min-w-6 text-center font-display tabular-nums" aria-live="polite">
        {value}
      </span>
      <Button className={cn(TAP, "px-2")} variant="secondary" disabled={value >= ROOM_MAX} aria-label="More players needed" onMouseDown={keepFocus} onClick={() => onStep(1)}>
        <Plus />
      </Button>
      <span className="text-muted">players to start</span>
    </div>
  );
}
