import { useId } from "react";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  Crown,
  Eye,
  Flag,
  Focus,
  Minus,
  PanelsTopLeft,
  Play,
  Plus,
  RotateCcw,
  Skull,
  TriangleAlert,
  Trophy,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DriverRows } from "@/components/race-driver";
import { CARD, MenuShell, NavButton } from "@/components/race-menu-shell";
import { BustedBanner } from "@/components/race-busted";
import { FOCUS, FOCUS_WITHIN } from "@/components/race-menu-styles";
import { ReelList, SavedList } from "@/components/race-reel";
import { ResetPrompt } from "@/components/reset-prompt";
import { StartLights } from "@/components/start-lights";
import type { ResetInput } from "@/game/hud/reset-prompt";
import type { CarStatus, RaceCommand, RaceHud, RaceHudRow, RaceOptions } from "@/game/match/types";
import { fmtGap, fmtTime } from "@/game/hud/race-clock";
import { cn } from "@/lib/utils";

type Send = (cmd: RaceCommand) => void;

/** Keeps a click from parking focus on a HUD button while driving (Space / Enter would press it). */
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

const STATUS_ICON: Partial<Record<CarStatus, { Icon: typeof Flag; label: string }>> = {
  finished: { Icon: Flag, label: "Finished" },
  respawning: { Icon: RotateCcw, label: "Respawning" },
  out: { Icon: Skull, label: "Out" },
  dnf: { Icon: Ban, label: "Did not finish" },
};

/** Live order, panel-free. A name click follows that car (spectating or finished). Phones show P1, you, and the cars around you (around the watched car while spectating). */
export function RaceStandings({ race, onCommand }: { race: RaceHud; onCommand: Send }) {
  if (race.phase === null || race.standings.length === 0) return null;
  const watched = race.standings.find((r) => r.watched)?.place;
  const focusPlace = (race.spectating !== null ? watched : race.you?.place) ?? watched ?? 1;
  return (
    <ol aria-label="Standings" className="pointer-events-auto max-h-full w-44 space-y-px overflow-y-auto sm:w-48 idle:opacity-60">
      {race.spectating !== null ? (
        <li>
          <AutoRow on={race.auto} onWatch={() => onCommand({ type: "watch", id: -1 })} />
        </li>
      ) : null}
      {race.standings.map((row) => (
        <li key={row.id} className={cn(row.place !== 1 && !row.you && Math.abs(row.place - focusPlace) > 1 && "max-sm:hidden", row.place !== 1 && row.place !== focusPlace && "phone-landscape:hidden")}>
          <StandingRow row={row} lead={race.standings[0]!.lap} onWatch={() => onCommand({ type: "watch", id: row.id })} />
        </li>
      ))}
    </ol>
  );
}

/** The standings' Auto entry (spectating): the director picks the car. Same row as a driver's. */
function AutoRow({ on, onWatch }: { on: boolean; onWatch: () => void }) {
  return (
    <button
      type="button"
      onMouseDown={keepFocus}
      onClick={onWatch}
      aria-pressed={on}
      aria-label="Watch Auto"
      className={cn(
        "flex h-11 w-full items-center gap-2 rounded-md px-1.5 text-left font-display text-sm transition-colors duration-[var(--motion-quick)] sm:h-6 pointer-coarse:h-11",
        on ? "bg-surface/80 text-fg" : "hud-ink text-fg hover:bg-surface/60",
      )}
    >
      <span className="w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">Auto</span>
      {on ? <Eye className="size-3.5 shrink-0" aria-label="Watching" /> : null}
    </button>
  );
}

/** "+1 lap" / "+2 laps" behind a leader on `lead` laps; empty when level. */
function lapsDown(lead: number, laps: number): string {
  const d = lead - laps;
  return d <= 0 ? "" : `+${d} lap${d === 1 ? "" : "s"}`;
}

function StandingRow({ row, lead, onWatch }: { row: RaceHudRow; lead: number; onWatch: () => void }) {
  const status = STATUS_ICON[row.status];
  const gone = row.status === "out" || row.status === "dnf";
  const dim = row.you ? "text-accent-fg" : "text-fg/85";
  return (
    <button
      type="button"
      onMouseDown={keepFocus}
      onClick={onWatch}
      aria-pressed={row.watched}
      aria-label={`Watch ${row.name}`}
      className={cn(
        "flex h-11 w-full items-center gap-2 rounded-md px-1.5 text-left font-display text-sm transition-colors duration-[var(--motion-quick)] sm:h-6 pointer-coarse:h-11",
        row.you ? "bg-accent text-accent-fg" : row.watched ? "bg-surface/80 text-fg" : "hud-ink text-fg hover:bg-surface/60",
      )}
    >
      <span className={cn("w-4 shrink-0 tabular-nums", dim)}>{row.place}</span>
      <span className={cn("min-w-0 flex-1 truncate", row.you && "font-semibold", gone && "line-through opacity-60")}>{row.name}</span>
      {row.watched && !row.you ? <Eye className="size-3.5 shrink-0" aria-label="Watching" /> : null}
      {row.place !== 1 && !gone && (row.gap !== null || row.status === "finished") ? (
        <span className={cn("shrink-0 text-xs tabular-nums", dim)}>{row.gap !== null ? fmtGap(row.gap) : lapsDown(lead, row.lap)}</span>
      ) : null}
      {status ? <status.Icon className="size-3.5 shrink-0" aria-label={status.label} /> : null}
    </button>
  );
}

/** Follow-cam chip above the dock while spectating: the car's name, previous / next, and the camera (`cam`, its name; `onCam` cycles it). */
export function SpectateBar({ race, pad, cam, onCommand, onCam }: { race: RaceHud; pad: boolean; cam: string | null; onCommand: Send; onCam: () => void }) {
  if (race.spectating === null || race.menu !== null) return null;
  return (
    <div className="hud-panel pointer-events-auto flex shrink-0 items-center gap-1 p-1" role="status">
      <Button variant="ghost" size="icon" className="sm:size-8 pointer-coarse:size-11" aria-label="Previous car" onMouseDown={keepFocus} onClick={() => onCommand({ type: "cycle", dir: -1 })}>
        <ChevronLeft />
      </Button>
      <div className="min-w-0 px-1 text-center">
        <p className="hud-label">Spectating · {pad ? "LB / RB" : "Q / E"}</p>
        <p className="truncate font-display text-base font-semibold leading-tight">{race.auto ? `Auto · ${race.spectating}` : race.spectating}</p>
      </div>
      <Button variant="ghost" size="icon" className="sm:size-8 pointer-coarse:size-11" aria-label="Next car" onMouseDown={keepFocus} onClick={() => onCommand({ type: "cycle", dir: 1 })}>
        <ChevronRight />
      </Button>
      {cam ? (
        <Button variant="ghost" className="h-10 gap-1.5 px-2 sm:h-8 pointer-coarse:h-11" aria-label="Camera view" title={`Camera view · ${pad ? "Y" : "V"}`} onMouseDown={keepFocus} onClick={onCam}>
          <Video />
          <span className="text-xs">{cam}</span>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * Race focus view ↔ full sandbox HUD; the engine binds H to the same command. `compact` hides the
 * label on phones; `bare` draws it straight on the view (focus view) instead of in the dock.
 */
export function RaceViewToggle({ race, onCommand, compact, bare }: { race: RaceHud; onCommand: Send; compact?: boolean; bare?: boolean }) {
  const label = race.fullUi ? "Race view" : "Full menu";
  return (
    <Button
      variant="ghost"
      onMouseDown={keepFocus}
      onClick={() => onCommand({ type: "fullUi", on: !race.fullUi })}
      aria-label={label}
      aria-keyshortcuts="H"
      title={`${label} (H)`}
      className={cn(bare ? "hud-ink pointer-events-auto px-2 text-fg/80 hover:bg-surface/60 hover:text-fg sm:h-8" : "text-muted hover:text-fg")}
    >
      {race.fullUi ? <Focus /> : <PanelsTopLeft />}
      <span className={cn(compact && "hidden sm:inline")}>{label}</span>
      <kbd className="hidden rounded bg-surface-2 px-1.5 font-display text-xs text-muted shadow-[var(--shadow-border)] text-shadow-none sm:inline">H</kbd>
    </Button>
  );
}

/**
 * Centre-screen race moments (lights, wrong way, respawn, finish) and the modal race menus. The reset prompt
 * heads the column, so it holds its spot while the banners come and go beneath it.
 */
export function RaceOverlay({ race, pad, reset, onReset, onCommand }: { race: RaceHud; pad: boolean; reset: ResetInput | null; onReset: () => void; onCommand: Send }) {
  if (race.menu !== null) return <RaceMenu race={race} pad={pad} onCommand={onCommand} />;
  const you = race.you;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/3 z-10 flex flex-col items-center gap-3 px-3 sm:top-1/4">
      <ResetPrompt view={race.view} input={reset} race onTap={onReset} className="max-sm:hidden" />
      {race.phase === null ? null : <StartLights time={race.time} />}
      {you?.wrongWay ? (
        <div
          className="flex items-center gap-2 rounded-xl bg-signal-red px-4 py-2 font-display text-2xl font-semibold uppercase tracking-widest text-fg shadow-lg sm:text-3xl"
          role="alert"
        >
          <TriangleAlert className="size-6" />
          Wrong way
        </div>
      ) : null}
      {you?.missed && !you.wrongWay ? (
        <div
          className="flex items-center gap-2 rounded-xl bg-signal-amber px-4 py-2 font-display text-xl font-semibold uppercase tracking-widest text-accent-fg shadow-lg sm:text-2xl"
          role="alert"
        >
          <TriangleAlert className="size-5" />
          Missed checkpoint
        </div>
      ) : null}
      {you?.respawnIn != null ? (
        <div className={cn(CARD, "px-4 py-2 text-center")} role="status">
          <p className="hud-label">Respawning</p>
          <p className="font-display text-4xl font-semibold leading-none tabular-nums">{you.respawnIn.toFixed(1)}</p>
        </div>
      ) : null}
      {you?.status === "finished" ? <FinishCard race={race} /> : null}
      <BustedBanner race={race} />
    </div>
  );
}

/** Gap to P1 for a finisher (P1 = 0), null for anyone still running or out. */
function finishGap(row: RaceHudRow | undefined): number | null {
  if (!row || row.status !== "finished") return null;
  return row.place === 1 ? 0 : row.gap;
}

function FinishCard({ race }: { race: RaceHud }) {
  const you = race.you!;
  const at = (place: number) => race.standings.find((r) => r.place === place);
  const mine = finishGap(at(you.place));
  const ahead = at(you.place - 1);
  const behind = at(you.place + 1);
  const aheadGap = finishGap(ahead);
  const behindGap = finishGap(behind);
  return (
    <div className={cn(CARD, "w-full max-w-xs px-4 py-3 text-center")} role="status">
      <p className="hud-label">Finished</p>
      <p className="mt-1 font-display text-5xl font-semibold leading-none tracking-tight">
        P{you.place}
        <span className="text-xl font-medium text-muted">/{race.field}</span>
      </p>
      <p className="mt-1 font-display text-xl font-semibold tabular-nums">{you.finishTime === null ? "–" : fmtTime(you.finishTime)}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-left">
        <div className="min-w-0">
          <dt className="hud-label">Ahead</dt>
          <dd className="truncate font-display text-sm">{ahead ? ahead.name : "Nobody"}</dd>
          <dd className="font-display text-lg font-semibold tabular-nums">
            {ahead && mine !== null && aheadGap !== null ? fmtGap(mine - aheadGap) : "–"}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="hud-label">Behind</dt>
          <dd className="truncate font-display text-sm">{behind ? behind.name : "Nobody"}</dd>
          <dd className="font-display text-lg font-semibold tabular-nums">
            {!behind ? "–" : behindGap !== null && mine !== null ? fmtGap(behindGap - mine) : STATUS_ICON[behind.status]?.label ?? "Racing"}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function RaceMenu({ race, pad, onCommand }: { race: RaceHud; pad: boolean; onCommand: Send }) {
  const quit = () => onCommand({ type: "quit" });
  const retry = () => onCommand({ type: "retry" });
  const end = () => onCommand({ type: "end" });
  switch (race.menu) {
    case "setup":
      return <SetupMenu race={race} pad={pad} onCommand={onCommand} />;
    case "pause": {
      const resume = () => onCommand({ type: "resume" });
      return (
        <MenuShell id="pause" eyebrow={`${race.trackName} · Lap ${race.you?.lap ?? 1}/${race.laps}`} title="Paused" pad={pad} onBack={resume} onStart={resume}>
          <div className="grid gap-2">
            <NavButton onClick={resume}>
              <Play />
              Resume
            </NavButton>
            <NavButton variant="secondary" onClick={retry}>
              <RotateCcw />
              Restart
            </NavButton>
            <NavButton variant="secondary" onClick={end}>
              <Flag />
              End race
            </NavButton>
            <NavButton variant="secondary" onClick={() => onCommand({ type: "fullUi", on: !race.fullUi })} aria-keyshortcuts="H">
              {race.fullUi ? <Focus /> : <PanelsTopLeft />}
              {race.fullUi ? "Race view" : "Full menu"}
            </NavButton>
            <NavButton variant="ghost" onClick={quit}>
              Quit to menu
            </NavButton>
          </div>
        </MenuShell>
      );
    }
    case "dead":
      return (
        <MenuShell id="dead" eyebrow={race.trackName} title="Wrecked" pad={pad} onBack={null} onStart={null}>
          <p className="text-sm leading-relaxed text-muted">
            No resets: you are out{race.you ? ` in P${race.you.place} of ${race.field}` : ""}. The last car running wins.
          </p>
          <div className="mt-3 grid gap-1.5">
            <NavButton onClick={retry}>
              <RotateCcw />
              Restart
            </NavButton>
            <NavButton variant="secondary" onClick={end}>
              <Flag />
              End race
            </NavButton>
            <NavButton variant="secondary" onClick={() => onCommand({ type: "spectate" })}>
              <Eye />
              Spectate
            </NavButton>
          </div>
        </MenuShell>
      );
    case "results":
      return <ResultsMenu race={race} pad={pad} onCommand={onCommand} />;
    case "standings":
      return <StandingsMenu race={race} pad={pad} onCommand={onCommand} />;
    case null:
      return null;
  }
}

function Stepper({
  label,
  value,
  min,
  max,
  step,
  shown,
  slider,
  hint,
  onSet,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  shown: string;
  slider?: boolean;
  /** One line under the row, inside the focus ring. */
  hint?: string;
  onSet: (value: number) => void;
}) {
  const hintId = useId();
  const set = (v: number) => onSet(Math.min(max, Math.max(min, Math.round(v * 100) / 100)));
  return (
    <div
      data-nav
      data-adjust
      tabIndex={0}
      role={slider ? "slider" : "spinbutton"}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={shown}
      aria-describedby={hint ? hintId : undefined}
      className={cn("flex min-h-11 flex-wrap items-center gap-x-2 rounded-md bg-surface-2 py-0.5 pl-2 pr-0.5 shadow-[var(--shadow-border)] sm:min-h-8", FOCUS_WITHIN)}
    >
      <span className="hud-label w-24 shrink-0 text-muted sm:w-32">{label}</span>
      {slider ? (
        <input
          type="range"
          tabIndex={-1}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => set(Number(e.target.value))}
          aria-label={label}
          className="h-8 min-w-0 flex-1 cursor-pointer accent-current"
        />
      ) : (
        <span className="flex-1" />
      )}
      <Button variant="ghost" size="icon" className="sm:size-8" tabIndex={-1} data-step="-1" aria-label={`Less ${label.toLowerCase()}`} disabled={value <= min} onClick={() => set(value - step)}>
        <Minus />
      </Button>
      <span className="w-10 shrink-0 text-center font-display text-lg font-semibold tabular-nums">{shown}</span>
      <Button variant="ghost" size="icon" className="sm:size-8" tabIndex={-1} data-step="1" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => set(value + step)}>
        <Plus />
      </Button>
      {hint ? (
        <p id={hintId} className="basis-full pb-1.5 pr-2 text-xs leading-snug text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A two-way row: ←/→ or a tap on a side picks it, a tap on the row flips it. */
function Choice({ label, off, on, value, onSet }: { label: string; off: string; on: string; value: boolean; onSet: (value: boolean) => void }) {
  const set = (v: boolean) => {
    if (v !== value) onSet(v);
  };
  const segment = (lit: boolean) =>
    cn(
      "h-11 rounded-md px-2 font-display text-sm font-medium transition-colors duration-[var(--motion-quick)] sm:h-7",
      lit ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
    );
  return (
    <div
      data-nav
      data-adjust
      tabIndex={0}
      role="group"
      aria-label={`${label}: ${value ? on : off}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) set(!value);
      }}
      className={cn("flex min-h-11 items-center gap-2 rounded-md bg-surface-2 py-0.5 pl-2 pr-0.5 shadow-[var(--shadow-border)] sm:min-h-8", FOCUS_WITHIN)}
    >
      <span className="hud-label w-24 shrink-0 text-muted sm:w-32">{label}</span>
      <div className="grid flex-1 grid-cols-2 gap-0.5 rounded-md bg-surface p-0.5">
        <button type="button" tabIndex={-1} data-step="-1" aria-pressed={!value} onClick={() => set(false)} className={segment(!value)}>
          {off}
        </button>
        <button type="button" tabIndex={-1} data-step="1" aria-pressed={value} onClick={() => set(true)} className={segment(value)}>
          {on}
        </button>
      </div>
    </div>
  );
}

function SetupMenu({ race, pad, onCommand }: { race: RaceHud; pad: boolean; onCommand: Send }) {
  const o = race.options;
  const options = (patch: Partial<RaceOptions>) => onCommand({ type: "options", options: patch });
  return (
    <MenuShell id="setup" eyebrow="Race" title="Pick a course" pad={pad} wide adjust onBack={() => onCommand({ type: "quit" })} onStart={null}>
      <div className="grid gap-2 sm:grid-cols-3">
        {race.courses.map((c) => {
          const on = c.id === o.trackId;
          return (
            <button
              key={c.id}
              type="button"
              data-nav
              aria-pressed={on}
              onClick={() => options({ trackId: c.id })}
              className={cn(
                "flex min-h-11 flex-col items-start rounded-md px-2 py-1.5 text-left shadow-[var(--shadow-border)] transition-colors duration-[var(--motion-quick)]",
                on ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg hover:bg-surface",
                FOCUS,
              )}
            >
              <span className="font-display text-lg font-semibold leading-tight">{c.name}</span>
              <span className={cn("mt-1 text-xs leading-snug", on ? "text-accent-fg" : "text-muted")}>{c.blurb}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-1.5">
        <DriverRows />
        <Choice label="You" off="Drive" on="Watch" value={o.spectate} onSet={(spectate) => options({ spectate })} />
        <Stepper label="Laps" value={o.laps} min={1} max={5} step={1} shown={String(o.laps)} onSet={(laps) => options({ laps })} />
        <Stepper label="AI cars" value={o.aiCount} min={1} max={15} step={1} shown={String(o.aiCount)} onSet={(aiCount) => options({ aiCount })} />
        <Stepper
          label="Max aggression"
          value={o.aggression}
          min={0}
          max={1}
          step={0.05}
          shown={`${Math.round(o.aggression * 100)}%`}
          slider
          hint="Each rival rolls its own 0–max, kept all campaign · 0 avoids hits · 50% hits weaker cars when safe · 100% rams"
          onSet={(aggression) => options({ aggression })}
        />
        <Choice label="Wrecks" off="Respawn" on="No reset" value={o.noReset} onSet={(noReset) => options({ noReset })} />
        <Choice label="Police" off="Off" on="Chase" value={o.police} onSet={(police) => options({ police })} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <NavButton className="col-span-2" onClick={() => onCommand({ type: "start" })}>
          <Flag />
          Start race
        </NavButton>
        <NavButton variant="secondary" onClick={() => onCommand({ type: "campaign" })}>
          <Trophy />
          Campaign
        </NavButton>
        <NavButton variant="ghost" onClick={() => onCommand({ type: "quit" })}>
          Back
        </NavButton>
      </div>
      <SavedList saved={race.saved} onCommand={onCommand} />
    </MenuShell>
  );
}

const RESULT_STATUS: Record<CarStatus, string> = { racing: "Racing", respawning: "Racing", finished: "", out: "Out", dnf: "DNF" };

function ResultsMenu({ race, pad, onCommand }: { race: RaceHud; pad: boolean; onCommand: Send }) {
  const rows = race.results ?? [];
  const campaign = race.mode === "campaign";
  const quit = () => onCommand({ type: "quit" });
  const th = "py-1 font-normal";
  return (
    // Esc / B must not throw a campaign away: its round only counts on Standings (`next`), so Back is off there.
    <MenuShell
      id="results"
      eyebrow={`${race.trackName} · ${race.laps} laps`}
      title="Results"
      pad={pad}
      wide
      sheet={race.reel !== null}
      onBack={campaign ? null : quit}
      onStart={null}
    >
      {race.winnerName ? (
        <p className="flex items-center gap-2 font-display text-lg font-semibold">
          <Trophy className="size-4 text-muted" />
          {race.winnerName} wins{race.winBy === "survival" ? ", last car running" : ""}
        </p>
      ) : null}
      <table className="mt-3 w-full font-display text-sm tabular-nums">
        <thead>
          <tr className="hud-label text-left">
            <th className={cn(th, "w-8")}>Pos</th>
            <th className={th}>Driver</th>
            <th className={cn(th, "text-right")}>Time</th>
            <th className={cn(th, "text-right")}>Gap</th>
            <th className={cn(th, "text-right max-sm:hidden")}>Best lap</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={cn("border-t border-border", r.kind === "player" ? "bg-surface-2 font-semibold text-fg" : "text-fg")}>
              <td className="py-1 pl-1 text-muted">{r.place}</td>
              <td className="max-w-0 truncate py-1 pr-2">{r.name}</td>
              <td className="py-1 text-right">{r.time === null ? (r.busted ? "Busted" : RESULT_STATUS[r.status]) : fmtTime(r.time)}</td>
              <td className="py-1 text-right text-muted">
                {r.gap !== null ? (r.gap === 0 ? "" : fmtGap(r.gap)) : r.status === "finished" ? lapsDown(rows[0]!.laps, r.laps) : `${r.laps}/${race.laps} laps`}
              </td>
              <td className="py-1 pr-1 text-right text-muted max-sm:hidden">{r.bestLap === null ? "–" : fmtTime(r.bestLap)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* The reel's side sheet is narrow: the long "next" label takes its own row. */}
      <div className={cn("mt-3 grid gap-1.5", race.reel ? "grid-cols-2" : "sm:auto-cols-fr sm:grid-flow-col")}>
        {campaign ? (
          <NavButton className={race.reel ? "col-span-2" : undefined} onClick={() => onCommand({ type: "next" })}>
            <Trophy />
            Standings
          </NavButton>
        ) : race.nextCourse !== null ? (
          <NavButton className={race.reel ? "col-span-2" : undefined} onClick={() => onCommand({ type: "next" })}>
            <ChevronRight />
            Next course: {race.nextCourse}
          </NavButton>
        ) : null}
        <NavButton variant="secondary" onClick={() => onCommand({ type: "retry" })}>
          <RotateCcw />
          Retry
        </NavButton>
        <NavButton variant="ghost" onClick={quit}>
          Menu
        </NavButton>
      </div>
      {race.reel ? <ReelList reel={race.reel} onCommand={onCommand} /> : null}
    </MenuShell>
  );
}

function StandingsMenu({ race, pad, onCommand }: { race: RaceHud; pad: boolean; onCommand: Send }) {
  const c = race.campaign;
  const rows = c?.standings ?? [];
  const rounds = c?.tracks.length ?? 0;
  const quit = () => onCommand({ type: "quit" });
  const champion = race.nextCourse === null ? rows[0] : undefined;
  const th = "py-1 font-normal";
  return (
    <MenuShell
      id="standings"
      eyebrow={champion ? "Campaign complete" : `Campaign · after round ${Math.min(c?.round ?? 0, rounds)} of ${rounds}`}
      title="Championship"
      pad={pad}
      wide
      sheet={race.reel !== null}
      onBack={null}
      onStart={null}
    >
      {champion ? (
        <div className="mb-2 flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-accent-fg">
          <Crown className="size-6 shrink-0" />
          <div className="min-w-0">
            <p className="font-display text-xs uppercase tracking-widest">Champion</p>
            <p className="truncate font-display text-2xl font-semibold leading-tight">{champion.name}</p>
          </div>
        </div>
      ) : null}
      <table className="w-full font-display text-sm tabular-nums">
        <thead>
          <tr className="hud-label text-left">
            <th className={cn(th, "w-8")}>#</th>
            <th className={th}>Driver</th>
            {Array.from({ length: rounds }, (_, i) => (
              <th key={i} className={cn(th, "w-8 text-center")} title={c?.tracks[i]}>
                R{i + 1}
              </th>
            ))}
            <th className={cn(th, "w-10 text-right")}>Wins</th>
            <th className={cn(th, "w-10 pr-1 text-right")}>Pts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={cn("border-t border-border", r.kind === "player" ? "bg-surface-2 font-semibold text-fg" : "text-fg")}>
              <td className="py-1 pl-1 text-muted">{i + 1}</td>
              <td className="max-w-0 truncate py-1 pr-2">{r.name}</td>
              {Array.from({ length: rounds }, (_, k) => (
                <td key={k} className="py-1 text-center text-muted">
                  {k < r.places.length ? (r.places[k] === 0 ? "–" : r.places[k]) : ""}
                </td>
              ))}
              <td className="py-1 text-right text-muted">{r.wins}</td>
              <td className="py-1 pr-1 text-right font-semibold">{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 grid gap-1.5 sm:auto-cols-fr sm:grid-flow-col">
        {race.nextCourse !== null ? (
          <NavButton onClick={() => onCommand({ type: "next" })}>
            <ChevronRight />
            Next round: {race.nextCourse}
          </NavButton>
        ) : null}
        <NavButton variant={race.nextCourse === null ? "default" : "ghost"} onClick={quit}>
          Menu
        </NavButton>
      </div>
      {race.reel ? <ReelList reel={race.reel} onCommand={onCommand} /> : null}
    </MenuShell>
  );
}
