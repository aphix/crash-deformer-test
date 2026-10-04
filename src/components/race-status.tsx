import { Siren } from "lucide-react";
import { useSpeedUnit } from "@/components/use-speed-unit";
import type { RaceHud, RaceView } from "@/game/match/types";
import type { SpeedUnit } from "@/game/hud/speed-units";
import { cn } from "@/lib/utils";

/** Distance to the line (in the viewer's unit: yards with mph, metres with km/h) at which the last lap's countdown banner comes up. */
const NEAR_GOAL = 500;
const YARDS_PER_M = 1.0936;

/** The pursuit strip: police are chasing the viewed car. Cop count and, while the cops hold it slow beside one (the bust rule counting), the bust hold running out with the seconds left. */
function PursuitStrip({ chase }: { chase: NonNullable<RaceView["chase"]> }) {
  return (
    <div className="hud-ink relative flex flex-col items-center gap-1 whitespace-nowrap px-8 py-1 font-display md:min-w-80 md:px-16 md:py-1.5" role="status">
      <div className="absolute inset-0 bg-linear-to-r from-transparent via-signal-red/60 to-transparent" aria-hidden />
      <p className="relative flex items-center gap-2 text-lg font-semibold uppercase tracking-[0.2em] text-fg md:text-2xl">
        <Siren className={cn("size-5 md:size-6", chase.hold > 0.6 && "motion-safe:animate-pulse")} />
        Chased by {chase.cops} {chase.cops === 1 ? "cop" : "cops"}
      </p>
      {chase.hold > 0 ? (
        <div className="relative flex items-center gap-2">
          <div className="h-2 w-48 overflow-hidden rounded-full bg-fg/25 shadow-[var(--shadow-border)]" role="meter" aria-label="Bust hold" aria-valuenow={Math.round(chase.hold * 100)}>
            <div className="h-full w-full origin-left bg-signal-red transition-transform duration-150 ease-linear will-change-transform" style={{ transform: `scaleX(${chase.hold})` }} />
          </div>
          <span className="w-12 text-sm font-semibold tabular-nums">{chase.left.toFixed(1)} s</span>
        </div>
      ) : null}
    </div>
  );
}

/** Distance left on the last lap in `unit`, rounded up to the next 10; null while the banner stays down. */
function remaining(race: RaceHud, view: RaceView, unit: SpeedUnit): number | null {
  const r = view.racer;
  if (!r || r.toGo === null || r.done === null || r.lap < race.laps || r.done < 0.5 || r.toGo <= 0) return null;
  const left = unit === "mph" ? r.toGo * YARDS_PER_M : r.toGo;
  return left > NEAR_GOAL ? null : Math.ceil(left / 10) * 10;
}

/**
 * The race's status strips, over the 3D view and clear of every control: the pursuit strip (bottom centre) while police chase
 * the viewed car, and the near-goal banner (top centre) for the last stretch of the last lap. With a touch pad (`!corner`) both
 * ride above it instead, in the gap between the standings and the thumb controls. None under a menu or the reel.
 */
export function RaceStatus({ race, corner }: { race: RaceHud; corner: boolean }) {
  const unit = useSpeedUnit();
  const view = race.view;
  if (!view || race.phase !== "racing" || race.menu !== null || race.reel !== null) return null;
  const left = remaining(race, view, unit);
  return (
    <>
      {left === null ? null : (
        <div className={cn("pointer-events-none absolute inset-x-0 z-10 flex justify-center", corner ? "top-[12%]" : "bottom-[37%]")}>
          <p
            className="hud-ink whitespace-nowrap bg-linear-to-r from-transparent via-scene-race/75 to-transparent px-10 py-1 font-display text-2xl font-semibold uppercase tracking-wide tabular-nums text-fg md:px-16 md:text-4xl"
            role="status"
          >
            {left} {unit === "mph" ? "yd" : "m"} remaining
          </p>
        </div>
      )}
      {view.chase === null ? null : (
        <div className={cn("pointer-events-none absolute inset-x-0 z-10 flex justify-center", corner ? "bottom-[7%]" : "bottom-[30%]")}>
          <PursuitStrip chase={view.chase} />
        </div>
      )}
    </>
  );
}
