import { CARD } from "@/components/race-menu-shell";
import { startLights } from "@/game/match/session";
import { cn } from "@/lib/utils";

const LIT = ["", "bg-signal-red shadow-lg shadow-signal-red/50", "bg-signal-amber shadow-lg shadow-signal-amber/50", "bg-signal-green shadow-lg shadow-signal-green/50"] as const;

/**
 * The start lights and the 3-2-1-GO numeral for a match clock that runs negative to the green light at 0 (race and
 * derby share it: `startLights`, `GRID_TIME`, `COUNTDOWN`). Nothing once the green has gone out.
 */
export function StartLights({ time }: { time: number }) {
  const lights = startLights(time);
  if (time >= 0 && lights === 0) return null;
  const numeral = time >= -3 && time < 0 ? String(Math.ceil(-time)) : time >= 0 && time < 1 ? "GO" : null;
  return (
    <div className={cn(CARD, "flex flex-col items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4 sm:py-3")}>
      <div className="flex gap-2 sm:gap-3" role="img" aria-label="Start lights">
        {([1, 2, 3] as const).map((n) => (
          <span
            key={n}
            className={cn(
              "size-12 rounded-full transition-[background-color,box-shadow] duration-[var(--motion-quick)] sm:size-16",
              lights === n ? LIT[n] : "bg-surface-2 shadow-[var(--shadow-border)]",
            )}
          />
        ))}
      </div>
      {numeral ? (
        <p
          className={cn("font-display text-6xl font-semibold leading-none tracking-tight sm:text-7xl", numeral === "GO" ? "text-signal-green" : "text-fg")}
          aria-live="assertive"
        >
          {numeral}
        </p>
      ) : null}
    </div>
  );
}
