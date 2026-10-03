import { Wrench } from "lucide-react";
import { resetPromptLabel, type ResetInput } from "@/game/hud/reset-prompt";
import type { RaceView } from "@/game/match/types";

const PILL =
  "mt-14 sm:mt-0 flex items-center gap-2 rounded-xl bg-fg px-4 py-1.5 font-display text-xl font-semibold uppercase tracking-widest text-accent-fg shadow-lg motion-safe:animate-pulse sm:text-2xl";

/**
 * "[R] to reset" once the view's car has lost two wheels: big, near-white and pulsing (not under reduced
 * motion), naming the control of the input in use. On touch the whole pill is a button that does what the
 * thumb pad's wrench does (`onTap`). The race overlay and the derby HUD both draw it, in a column that takes no
 * pointer events (on a phone it sits below the standings panel). Nothing where the game would refuse the reset, or `input` is null (no control on screen).
 */
export function ResetPrompt({ view, input, race, onTap }: { view: RaceView | null; input: ResetInput | null; race: boolean; onTap: () => void }) {
  if (!view || !input) return null;
  const label = resetPromptLabel(view, input, race);
  if (label === null) return null;
  if (input === "touch") {
    return (
      <button type="button" onClick={onTap} className={`${PILL} pointer-events-auto min-h-12 touch-manipulation`}>
        <Wrench className="size-5" />
        Tap to {label.toLowerCase()}
      </button>
    );
  }
  return (
    <p role="status" className={PILL}>
      <kbd className="rounded-md bg-accent-fg px-2 font-display text-fg">{label}</kbd>
      to reset
    </p>
  );
}
