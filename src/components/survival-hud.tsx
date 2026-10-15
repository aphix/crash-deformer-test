import { MapPinned, RotateCcw, Siren, Trophy } from "lucide-react";
import { AudioRows } from "@/components/race-audio";
import { DriverRows } from "@/components/race-driver";
import { MenuShell, NavButton } from "@/components/race-menu-shell";
import { copCount } from "@/components/cop-count";
import { ReelList } from "@/components/race-reel";
import { CourseCard, TimeOfDayRow } from "@/components/race-rows";
import type { AudioLevels } from "@/game/hud/audio-levels";
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
        {race.team ? <Stat label="Free" value={`${race.team.free}/${race.team.humans}`} /> : null}
      </dl>
    </>
  );
}

/**
 * Survival's own setup menu, up before the run (the bottom bar's Survival opens it; Race's menu has no Survival bits): the Survival courses as
 * cards, the rows that apply to a run (the car, the time of day, the sound), Start survival, Back to the fleet. A pick shows the course behind the menu.
 */
export function SurvivalMenu({ race, pad, onCommand, audio }: { race: RaceHud; pad: boolean; onCommand: (cmd: RaceCommand) => void; audio: AudioLevels }) {
  const quit = () => onCommand({ type: "quit" });
  const start = () => onCommand({ type: "start" });
  return (
    <MenuShell id="survival" eyebrow="Survival" title="Pick a course" pad={pad} wide adjust onBack={quit} onStart={start}>
      <div className="grid gap-2 sm:grid-cols-2">
        {race.survivalCourses.map((c) => (
          <CourseCard key={c.id} name={c.name} blurb={c.blurb} on={c.id === race.survivalCourse} onPick={() => onCommand({ type: "survivalCourse", id: c.id })} />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-1.5">
        <DriverRows />
        <TimeOfDayRow value={race.options.timeOfDay} onSet={(timeOfDay) => onCommand({ type: "options", options: { timeOfDay } })} />
        <AudioRows audio={audio} />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-1.5">
        <NavButton onClick={start}>
          <Siren />
          Start survival
        </NavButton>
        <NavButton variant="ghost" onClick={quit}>
          Back
        </NavButton>
      </div>
    </MenuShell>
  );
}

/**
 * The end-of-run card: the time, the best (and a new one), the cops wrecked, why it ended; Retry (the same course), Change course (back to Survival's menu) or leave.
 * The crash reel, when the run left one, plays behind it. `canChange`: a room's course is the lobby gate's, so a room has no way back to the menu.
 */
export function SurvivalResults({ race, pad, canChange, onCommand }: { race: RaceHud; pad: boolean; canChange: boolean; onCommand: (cmd: RaceCommand) => void }) {
  const r = race.survival?.result;
  const quit = () => onCommand({ type: "quit" });
  return (
    <MenuShell id="results" eyebrow={`${race.trackName} · Survival${race.team ? ` · Team of ${race.team.humans}` : ""}`} title={r ? CAUSE[r.cause] : "Run over"} pad={pad} sheet={race.reel ? onCommand : null} onBack={quit} onStart={null}>
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
            {copCount(r.wrecked)} wrecked
          </p>
        </div>
      ) : null}
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <NavButton onClick={() => onCommand({ type: "retry" })}>
          <RotateCcw />
          Retry
        </NavButton>
        {canChange ? (
          <NavButton variant="secondary" onClick={() => onCommand({ type: "survivalMenu" })}>
            <MapPinned />
            Change course
          </NavButton>
        ) : null}
        <NavButton variant="ghost" className={canChange ? "col-span-2" : undefined} onClick={quit}>
          Leave
        </NavButton>
      </div>
      {race.reel ? <ReelList reel={race.reel} shown={race.shown} onCommand={onCommand} /> : null}
    </MenuShell>
  );
}
