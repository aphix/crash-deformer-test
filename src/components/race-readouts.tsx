import { useState } from "react";
import { fmtGap, fmtTime } from "@/game/hud/race-clock";
import { useSpeedUnit } from "@/components/use-speed-unit";
import type { RaceHud, RaceView } from "@/game/match/types";
import { formatSpeed } from "@/game/hud/speed-units";
import { cn } from "@/lib/utils";

/** Seconds the split vs the leader stays up after each checkpoint. */
const SPLIT_FLASH = 3;

/** Boost meter cells (Burnout's segmented bar). */
const CELLS = 8;

/** One clock in the readouts cluster: label and value on one line. */
function Clock({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="uppercase tracking-[0.12em] text-fg/70">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

/** Shows the split for `SPLIT_FLASH` race seconds each time it changes (not the one present on mount). */
function useSplitFlash(split: number | null, time: number): boolean {
  const [seen, setSeen] = useState<{ split: number | null; at: number }>({ split, at: -Infinity });
  if (seen.split !== split) setSeen({ split, at: time });
  return split !== null && seen.split === split && time - seen.at < SPLIT_FLASH;
}

/**
 * The race readouts of the driven car, or the watched car's while spectating (what its driver sees), drawn
 * straight on the view (`hud-ink`): position, lap and clocks top right, the speed, gear and boost gauge under
 * them, or in the bottom-right corner (`corner`, the arcade racers' spot) where no thumb pad sits there. None while
 * the results reel plays: its cameras ride replayed wrecks, not a racer.
 */
export function RaceReadouts({ race, corner }: { race: RaceHud; corner: boolean }) {
  const view = race.view;
  if (!view || race.phase === null || race.reel !== null) return null;
  // Keyed by car: switching the watched car doesn't flash the new car's standing split.
  return <Cluster key={view.id} race={race} view={view} corner={corner} />;
}

function Cluster({ race, view, corner }: { race: RaceHud; view: RaceView; corner: boolean }) {
  const r = view.racer;
  const flash = useSplitFlash(r?.split ?? null, race.time);
  return (
    <div className="flex flex-col items-end gap-1 self-start text-right font-display tabular-nums" style={{ gridArea: "readouts" }}>
      {r ? (
        <>
          <div className="hud-ink flex items-baseline gap-3">
            <p className="text-sm font-semibold uppercase tracking-[0.12em] text-fg/70">
              Lap <span className="text-2xl text-fg">{r.lap}</span>/{race.laps}
            </p>
            <p className="text-5xl font-semibold leading-none tracking-tight">
              P{r.place}
              <span className="text-xl font-medium text-fg/70">/{race.field}</span>
            </p>
          </div>
          <p className="hud-ink text-xl font-semibold leading-none" aria-label="Race time">
            {fmtTime(race.time)}
          </p>
          <dl className="hud-ink flex gap-3 text-xs">
            <Clock label="Lap" value={fmtTime(r.lapTime)} />
            <Clock label="Last" value={r.lastLap === null ? "–" : fmtTime(r.lastLap)} />
            <Clock label="Best" value={r.bestLap === null ? "–" : fmtTime(r.bestLap)} />
          </dl>
        </>
      ) : null}
      <Gauge view={view} corner={corner} />
      <p
        className={cn(
          "rounded-full bg-accent px-2 text-sm font-semibold leading-5 text-accent-fg transition-opacity duration-[var(--motion-fast)]",
          flash ? "opacity-100" : "opacity-0",
        )}
        aria-live="polite"
      >
        {r?.split == null ? "–" : r.split === 0 ? "Lead" : `Split ${fmtGap(r.split)}`}
      </p>
    </div>
  );
}

/** Speed and gear over the segmented boost meter (lit while burning) and the draft cue; the derby driver's readout too. */
export function Gauge({ view, corner }: { view: RaceView; corner: boolean }) {
  const unit = useSpeedUnit();
  const boost = view.boost;
  return (
    <div className={cn("flex flex-col items-end gap-1", corner && "md:absolute md:bottom-4 md:right-4")}>
      <div className="hud-ink flex items-baseline gap-2">
        <p
          className={cn("grid size-7 place-items-center self-center rounded-md text-lg font-semibold leading-none shadow-[var(--shadow-border)]", corner && "md:size-10 md:text-2xl")}
          aria-label="Gear"
        >
          {view.gear === 0 ? "R" : view.gear}
        </p>
        <p className={cn("text-3xl font-semibold leading-none tracking-tight", corner && "md:text-6xl")} aria-label="Speed">
          {formatSpeed(view.speedKph / 3.6, unit)}
          <span className={cn("ml-0.5 text-xs font-medium text-fg/70", corner && "md:text-base")}>{unit}</span>
        </p>
      </div>
      {boost === null ? null : (
        <div className="flex items-center gap-2">
          {view.racer?.drafting ? <span className="hud-ink text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">Draft</span> : null}
          <span className="hud-ink text-[10px] font-semibold uppercase tracking-[0.12em] text-fg/70">Boost</span>
          <div
            className={cn("flex h-2 w-24 gap-0.5", corner && "md:h-3 md:w-44", view.boosting && "drop-shadow-[0_0_6px_var(--color-accent)]")}
            role="meter"
            aria-label="Boost"
            aria-valuenow={Math.round(boost * 100)}
          >
            {Array.from({ length: CELLS }, (_, i) => (
              <div key={i} className="flex-1 overflow-hidden rounded-[2px] bg-fg/25 shadow-[var(--shadow-border)]">
                <div className={cn("h-full", view.boosting ? "bg-fg" : "bg-accent")} style={{ width: `${Math.round(Math.min(1, Math.max(0, boost * CELLS - i)) * 100)}%` }} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
