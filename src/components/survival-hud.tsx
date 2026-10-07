import { RotateCcw, Trophy } from "lucide-react";
import { MenuShell, NavButton } from "@/components/race-menu-shell";
import { ReelList } from "@/components/race-reel";
import { fmtTime } from "@/game/hud/race-clock";
import type { RaceCommand, RaceHud, SurvivalCause, SurvivalHud } from "@/game/match/types";

const CAUSE: Record<SurvivalCause, string> = { busted: "Busted", wrecked: "Wrecked", ended: "Run ended" };

/** One figure of the readout: label over value. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <dt className="uppercase tracking-[0.12em] text-fg/70">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

/**
 * Survival's readouts, top right (Driver 2's): the stopwatch that is the score, the best time, the cops chasing and the cops
 * wrecked. The bust hold counting down has the pursuit strip (`race-status.tsx`).
 */
export function SurvivalReadout({ race, survival }: { race: RaceHud; survival: SurvivalHud }) {
  return (
    <>
      <p className="hud-ink text-5xl font-semibold leading-none tracking-tight" aria-label="Survived">
        {fmtTime(race.time)}
      </p>
      <p className="hud-ink text-sm font-semibold" aria-label="Best time">
        <span className="uppercase tracking-[0.12em] text-fg/70">Best </span>
        {survival.best === null ? "–" : fmtTime(survival.best)}
      </p>
      <dl className="hud-ink flex gap-3 text-xs">
        <Stat label="Cops" value={String(survival.cops)} />
        <Stat label="Wrecked" value={String(survival.wrecked)} />
      </dl>
    </>
  );
}

/** The end-of-run card: the time, the best (and a new one), the cops wrecked, why it ended; Retry or leave. The crash reel, when the run left one, plays behind it. */
export function SurvivalResults({ race, pad, onCommand }: { race: RaceHud; pad: boolean; onCommand: (cmd: RaceCommand) => void }) {
  const r = race.survival?.result;
  const quit = () => onCommand({ type: "quit" });
  return (
    <MenuShell id="results" eyebrow={`${race.trackName} · Survival`} title={r ? CAUSE[r.cause] : "Run over"} pad={pad} sheet={race.reel ? onCommand : null} onBack={quit} onStart={null}>
      {r ? (
        <div className="font-display tabular-nums">
          <p className="text-5xl font-semibold leading-none tracking-tight" aria-label="Time survived">
            {fmtTime(r.time)}
          </p>
          {r.isNew ? (
            <p className="mt-2 flex items-center gap-2 text-lg font-semibold text-accent">
              <Trophy className="size-4" />
              New best
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted">Best {fmtTime(r.best)}</p>
          )}
          <p className="mt-1 text-sm text-muted">
            {r.wrecked} {r.wrecked === 1 ? "cop" : "cops"} wrecked
          </p>
        </div>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <NavButton onClick={() => onCommand({ type: "retry" })}>
          <RotateCcw />
          Retry
        </NavButton>
        <NavButton variant="ghost" onClick={quit}>
          Leave
        </NavButton>
      </div>
      {race.reel ? <ReelList reel={race.reel} shown={race.shown} onCommand={onCommand} /> : null}
    </MenuShell>
  );
}
