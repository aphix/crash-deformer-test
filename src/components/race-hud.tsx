import { type ReactNode, useId, useRef, useState } from "react";
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
} from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { usePadMenu } from "@/components/use-pad-menu";
import type { CarStatus, RaceCommand, RaceHud, RaceHudRow, RaceOptions } from "@/game/race/types";
import { cn } from "@/lib/utils";

type Send = (cmd: RaceCommand) => void;

/** Seconds the split vs the leader stays up after each checkpoint. */
const SPLIT_FLASH = 3;

/** Focus ring for menu items: shown on any focus (pad and script focus are not "focus-visible"). */
const FOCUS = "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-surface";
const FOCUS_WITHIN = "focus-within:outline-none focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-surface";

/** Opaque card for centre-screen moments and menus (the translucent `hud-panel` lets panels behind bleed through). */
const CARD = "rounded-2xl bg-surface shadow-[var(--shadow-border)]";

const LIT = ["", "bg-signal-red shadow-lg shadow-signal-red/50", "bg-signal-amber shadow-lg shadow-signal-amber/50", "bg-signal-green shadow-lg shadow-signal-green/50"] as const;

/** m:ss.mmm; negative clock (before green) reads 0. */
function fmtTime(seconds: number): string {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

function fmtGap(seconds: number): string {
  return seconds < 60 ? `+${seconds.toFixed(2)}` : `+${fmtTime(seconds)}`;
}

/** Keeps a click from parking focus on a HUD button while driving (Space / Enter would press it). */
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

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
 * Position, lap, clocks, speed and the boost meter (`null` while not driving) in the readouts corner:
 * a panel-free cluster drawn straight on the view (`hud-ink`), position outermost.
 */
export function RaceReadouts({ race, boost }: { race: RaceHud; boost: number | null }) {
  const you = race.you;
  const flash = useSplitFlash(you?.split ?? null, race.time);
  if (!you || race.phase === null) return null;
  return (
    <div className="flex flex-col items-end gap-1 self-start text-right font-display tabular-nums" style={{ gridArea: "readouts" }}>
      <div className="hud-ink flex items-baseline gap-3">
        <p className="text-sm font-semibold uppercase tracking-[0.12em] text-fg/70">
          Lap <span className="text-2xl text-fg">{you.lap}</span>/{race.laps}
        </p>
        <p className="text-5xl font-semibold leading-none tracking-tight">
          P{you.place}
          <span className="text-xl font-medium text-fg/70">/{race.field}</span>
        </p>
      </div>
      <p className="hud-ink text-xl font-semibold leading-none" aria-label="Race time">
        {fmtTime(race.time)}
      </p>
      <dl className="hud-ink flex gap-3 text-xs">
        <Clock label="Lap" value={fmtTime(you.lapTime)} />
        <Clock label="Last" value={you.lastLap === null ? "–" : fmtTime(you.lastLap)} />
        <Clock label="Best" value={you.bestLap === null ? "–" : fmtTime(you.bestLap)} />
      </dl>
      <div className="flex items-center gap-2">
        {boost === null ? null : (
          <div className="h-1 w-16 overflow-hidden rounded-full bg-fg/25 shadow-[var(--shadow-border)]" role="meter" aria-label="Boost" aria-valuenow={Math.round(boost * 100)}>
            <div className="h-full bg-accent" style={{ width: `${Math.round(boost * 100)}%` }} />
          </div>
        )}
        <p className="hud-ink text-lg font-semibold leading-none">
          {you.speedKph.toFixed(0)}
          <span className="ml-0.5 text-xs font-medium text-fg/70">km/h</span>
        </p>
      </div>
      <p
        className={cn(
          "rounded-full bg-accent px-2 text-sm font-semibold leading-5 text-accent-fg transition-opacity duration-[var(--motion-fast)]",
          flash ? "opacity-100" : "opacity-0",
        )}
        aria-live="polite"
      >
        {you.split === null ? "–" : you.split === 0 ? "Lead" : `Split ${fmtGap(you.split)}`}
      </p>
    </div>
  );
}

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
    <ol aria-label="Standings" className="pointer-events-auto max-h-full w-44 space-y-px overflow-y-auto sm:w-48">
      {race.standings.map((row) => (
        <li key={row.id} className={cn(row.place !== 1 && !row.you && Math.abs(row.place - focusPlace) > 1 && "max-sm:hidden")}>
          <StandingRow row={row} onWatch={() => onCommand({ type: "watch", id: row.id })} />
        </li>
      ))}
    </ol>
  );
}

function StandingRow({ row, onWatch }: { row: RaceHudRow; onWatch: () => void }) {
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
        "flex h-11 w-full items-center gap-2 rounded-md px-1.5 text-left font-display text-sm transition-colors duration-[var(--motion-quick)] sm:h-6",
        row.you ? "bg-accent text-accent-fg" : row.watched ? "bg-surface/80 text-fg" : "hud-ink text-fg hover:bg-surface/60",
      )}
    >
      <span className={cn("w-4 shrink-0 tabular-nums", dim)}>{row.place}</span>
      <span className={cn("min-w-0 flex-1 truncate", row.you && "font-semibold", gone && "line-through opacity-60")}>{row.name}</span>
      {row.watched && !row.you ? <Eye className="size-3.5 shrink-0" aria-label="Watching" /> : null}
      {row.place !== 1 && row.gap !== null && !gone ? <span className={cn("shrink-0 text-xs tabular-nums", dim)}>{fmtGap(row.gap)}</span> : null}
      {status ? <status.Icon className="size-3.5 shrink-0" aria-label={status.label} /> : null}
    </button>
  );
}

/** Follow-cam chip above the dock while spectating: the car's name and previous / next. */
export function SpectateBar({ race, pad, onCommand }: { race: RaceHud; pad: boolean; onCommand: Send }) {
  if (race.spectating === null || race.menu !== null) return null;
  return (
    <div className="hud-panel pointer-events-auto flex items-center gap-1 p-1" role="status">
      <Button variant="ghost" size="icon" className="sm:size-8" aria-label="Previous car" onMouseDown={keepFocus} onClick={() => onCommand({ type: "cycle", dir: -1 })}>
        <ChevronLeft />
      </Button>
      <div className="min-w-0 px-1 text-center">
        <p className="hud-label">Spectating · {pad ? "LB / RB" : "Q / E"}</p>
        <p className="truncate font-display text-base font-semibold leading-tight">{race.spectating}</p>
      </div>
      <Button variant="ghost" size="icon" className="sm:size-8" aria-label="Next car" onMouseDown={keepFocus} onClick={() => onCommand({ type: "cycle", dir: 1 })}>
        <ChevronRight />
      </Button>
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

/** Centre-screen race moments (lights, wrong way, respawn, finish) and the modal race menus. */
export function RaceOverlay({ race, pad, onCommand }: { race: RaceHud; pad: boolean; onCommand: Send }) {
  if (race.menu !== null) return <RaceMenu race={race} pad={pad} onCommand={onCommand} />;
  const you = race.you;
  const t = race.time;
  const numeral = t >= -3 && t < 0 ? String(Math.ceil(-t)) : t >= 0 && t < 1 ? "GO" : null;
  const lights = race.phase === "grid" || race.phase === "countdown" || race.lights !== 0;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/3 z-10 flex flex-col items-center gap-3 px-3 sm:top-1/4">
      {lights || numeral ? (
        <div className={cn(CARD, "flex flex-col items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4 sm:py-3")}>
          <div className="flex gap-2 sm:gap-3" role="img" aria-label="Start lights">
            {([1, 2, 3] as const).map((n) => (
              <span
                key={n}
                className={cn(
                  "size-12 rounded-full transition-[background-color,box-shadow] duration-[var(--motion-quick)] sm:size-16",
                  race.lights === n ? LIT[n] : "bg-surface-2 shadow-[var(--shadow-border)]",
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
      ) : null}
      {you?.wrongWay ? (
        <div
          className="flex items-center gap-2 rounded-xl bg-signal-red px-4 py-2 font-display text-2xl font-semibold uppercase tracking-widest text-fg shadow-lg sm:text-3xl"
          role="alert"
        >
          <TriangleAlert className="size-6" />
          Wrong way
        </div>
      ) : null}
      {you?.respawnIn != null ? (
        <div className={cn(CARD, "px-4 py-2 text-center")} role="status">
          <p className="hud-label">Respawning</p>
          <p className="font-display text-4xl font-semibold leading-none tabular-nums">{you.respawnIn.toFixed(1)}</p>
        </div>
      ) : null}
      {you?.status === "finished" ? <FinishCard race={race} /> : null}
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

function NavButton({ className, ...props }: ButtonProps) {
  return <Button data-nav className={cn("w-full sm:h-8", FOCUS, className)} {...props} />;
}

function MenuShell({
  id,
  eyebrow,
  title,
  pad,
  wide,
  adjust,
  onBack,
  onStart,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  pad: boolean;
  wide?: boolean;
  /** The menu has ←/→ adjustable rows (hint only). */
  adjust?: boolean;
  onBack: (() => void) | null;
  onStart: (() => void) | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  usePadMenu(ref, id, { onBack, onStart });
  const chip = "rounded bg-surface-2 px-1.5 py-0.5 font-display text-xs text-fg shadow-[var(--shadow-border)]";
  const glyph = "inline-flex size-5 items-center justify-center rounded-full bg-surface-2 font-display text-xs font-semibold text-fg shadow-[var(--shadow-border)]";
  return (
    <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-bg/60 p-3 sm:p-6">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`race-menu-${id}`}
        className={cn(CARD, "max-h-full w-full overflow-y-auto p-3 sm:p-4", wide ? "max-w-2xl" : "max-w-sm")}
      >
        <p className="hud-label">{eyebrow}</p>
        <h2 id={`race-menu-${id}`} className="mt-0.5 font-display text-2xl font-semibold leading-none tracking-tight">
          {title}
        </h2>
        <div className="mt-3">{children}</div>
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {pad ? (
            <>
              <span className="flex items-center gap-1.5">
                <span className={glyph}>A</span>Select
              </span>
              {onBack ? (
                <span className="flex items-center gap-1.5">
                  <span className={glyph}>B</span>Back
                </span>
              ) : null}
              {onStart ? (
                <span className="flex items-center gap-1.5">
                  <span className={chip}>Start</span>Resume
                </span>
              ) : null}
              <span>D-pad / stick move{adjust ? " · ←/→ adjust" : ""}</span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-1.5">
                <kbd className={chip}>Enter</kbd>Select
              </span>
              {onBack ? (
                <span className="flex items-center gap-1.5">
                  <kbd className={chip}>Esc</kbd>Back
                </span>
              ) : null}
              <span>Arrows move{adjust ? " · ←/→ adjust" : ""}</span>
            </>
          )}
        </p>
      </div>
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

function SetupMenu({ race, pad, onCommand }: { race: RaceHud; pad: boolean; onCommand: Send }) {
  const o = race.options;
  const options = (patch: Partial<RaceOptions>) => onCommand({ type: "options", options: patch });
  const setNoReset = (noReset: boolean) => {
    if (noReset !== o.noReset) options({ noReset });
  };
  const segment = (on: boolean) =>
    cn(
      "h-11 rounded-md px-2 font-display text-sm font-medium transition-colors duration-[var(--motion-quick)] sm:h-7",
      on ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
    );
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
        <Stepper label="Laps" value={o.laps} min={3} max={5} step={1} shown={String(o.laps)} onSet={(laps) => options({ laps })} />
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
        <div
          data-nav
          data-adjust
          tabIndex={0}
          role="group"
          aria-label={`Wrecks: ${o.noReset ? "out for good" : "respawn"}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setNoReset(!o.noReset);
          }}
          className={cn("flex min-h-11 items-center gap-2 rounded-md bg-surface-2 py-0.5 pl-2 pr-0.5 shadow-[var(--shadow-border)] sm:min-h-8", FOCUS_WITHIN)}
        >
          <span className="hud-label w-24 shrink-0 text-muted sm:w-32">Wrecks</span>
          <div className="grid flex-1 grid-cols-2 gap-0.5 rounded-md bg-surface p-0.5">
            <button type="button" tabIndex={-1} data-step="-1" aria-pressed={!o.noReset} onClick={() => setNoReset(false)} className={segment(!o.noReset)}>
              Respawn
            </button>
            <button type="button" tabIndex={-1} data-step="1" aria-pressed={o.noReset} onClick={() => setNoReset(true)} className={segment(o.noReset)}>
              No reset
            </button>
          </div>
        </div>
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
    <MenuShell id="results" eyebrow={`${race.trackName} · ${race.laps} laps`} title="Results" pad={pad} wide onBack={quit} onStart={null}>
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
              <td className="py-1 text-right">{r.time === null ? RESULT_STATUS[r.status] : fmtTime(r.time)}</td>
              <td className="py-1 text-right text-muted">{r.gap === null ? "–" : r.gap === 0 ? "" : fmtGap(r.gap)}</td>
              <td className="py-1 pr-1 text-right text-muted max-sm:hidden">{r.bestLap === null ? "–" : fmtTime(r.bestLap)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-3 grid gap-1.5 sm:auto-cols-fr sm:grid-flow-col">
        {campaign ? (
          <NavButton onClick={() => onCommand({ type: "next" })}>
            <Trophy />
            Standings
          </NavButton>
        ) : race.nextCourse !== null ? (
          <NavButton onClick={() => onCommand({ type: "next" })}>
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
      onBack={quit}
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
    </MenuShell>
  );
}
