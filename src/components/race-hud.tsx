import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  Crown,
  Eye,
  Flag,
  Focus,
  PanelsTopLeft,
  Play,
  RotateCcw,
  Siren,
  Skull,
  TriangleAlert,
  Trophy,
  UserX,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { DriverRows } from "@/components/race-driver";
import { CARD, MenuShell, NavButton } from "@/components/race-menu-shell";
import { BustedBanner } from "@/components/race-busted";
import { FOCUS } from "@/components/race-menu-styles";
import { AudioRows, type AudioLevels } from "@/components/race-audio";
import { ReelList, SavedList } from "@/components/race-reel";
import { Choice, Stepper } from "@/components/race-rows";
import { ResetPrompt } from "@/components/reset-prompt";
import { StartLights } from "@/components/start-lights";
import { SurvivalResults } from "@/components/survival-hud";
import { useReelCover } from "@/components/use-reel-cover";
import { AI_DIFFICULTIES } from "@/game/ai/constants";
import { missedCheckpointText, type ResetInput } from "@/game/hud/reset-prompt";
import { courseTap, selectAll } from "@/game/hud/setup-patch";
import { LEAVE_MS, STANDING_LI, withLeavers, type StandingSlot } from "@/game/hud/standings-motion";
import { TIMES_OF_DAY, type CarStatus, type RaceCommand, type RaceHud, type RaceHudRow, type RaceOptions, type TimeOfDay } from "@/game/match/types";
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

/** FLIP over `ref`'s rows: one whose top moved since the last commit starts at its old place, and its CSS transition (`STANDING_LI`) slides it home. */
function useSlide(ref: RefObject<HTMLOListElement | null>): void {
  const tops = useRef(new Map<Element, number>());
  useLayoutEffect(() => {
    const ol = ref.current;
    if (!ol) return;
    const next = new Map<Element, number>();
    for (const li of Array.from(ol.children) as HTMLElement[]) {
      const top = li.offsetTop;
      const was = tops.current.get(li);
      next.set(li, top);
      if (was === undefined || was === top) continue;
      li.style.transition = "none";
      li.style.transform = `translateY(${was - top}px)`;
      void li.offsetHeight;
      li.style.transition = "";
      li.style.transform = "";
    }
    tops.current = next;
  });
}

/** `rows` plus the rows that left in the last `LEAVE_MS`, flagged leaving, so they fade out instead of vanishing. */
function useLeavers(rows: readonly RaceHudRow[]): StandingSlot[] {
  const seen = useRef(rows);
  const [gone, setGone] = useState<readonly RaceHudRow[]>([]);
  useEffect(() => {
    const left = seen.current.filter((p) => !rows.some((r) => r.id === p.id));
    seen.current = rows;
    if (left.length === 0) return;
    setGone((g) => [...g, ...left]);
    setTimeout(() => setGone((g) => g.filter((r) => !left.includes(r))), LEAVE_MS);
  }, [rows]);
  return withLeavers(rows, gone);
}

/** One standings row's `li`: it mounts faded (`data-fading`) and a frame later fades in; a leaver (`leaving`) fades out. A row the DOM only moves keeps its state, so a pass never re-fades it. */
function StandingItem({ leaving, className, children }: { leaving: boolean; className: string; children: ReactNode }) {
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <li data-fading={leaving || !arrived ? "" : undefined} className={className}>
      {children}
    </li>
  );
}

/**
 * Live order, panel-free. A name click follows that car (spectating or finished). Phones show P1, you, and the cars around
 * you (around the watched car while spectating). Over the results reel its box goes to the engine (`useReelCover`). A pass
 * slides the two rows past each other, a row that arrives or leaves fades (`STANDING_LI`).
 */
export function RaceStandings({ race, onCommand }: { race: RaceHud; onCommand: Send }) {
  const ref = useRef<HTMLOListElement>(null);
  const shown = race.phase !== null && race.standings.length > 0;
  useReelCover(ref, "standings", shown && race.reel ? onCommand : null);
  useSlide(ref);
  const slots = useLeavers(race.standings);
  if (!shown) return null;
  const watched = race.standings.find((r) => r.watched)?.place;
  const focusPlace = (race.spectating !== null ? watched : race.you?.place) ?? watched ?? 1;
  return (
    <ol ref={ref} aria-label="Standings" className="pointer-events-auto max-h-full w-36 space-y-px overflow-y-auto sm:w-48 idle:opacity-60">
      {race.spectating !== null ? (
        <li>
          <AutoRow on={race.auto} onWatch={() => onCommand({ type: "watch", id: -1 })} />
        </li>
      ) : null}
      {slots.map(({ row, leaving }) => (
        <StandingItem
          key={row.id}
          leaving={leaving}
          className={cn(STANDING_LI, row.place !== 1 && !row.you && row.place !== focusPlace && "max-sm:hidden", row.place !== 1 && row.place !== focusPlace && "phone-landscape:hidden")}
        >
          <StandingRow row={row} lead={race.standings[0]!.lap} onWatch={() => onCommand({ type: "watch", id: row.id })} />
        </StandingItem>
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
        "flex h-9 w-full items-center gap-2 rounded-md px-1.5 text-left font-display text-sm transition-colors duration-[var(--motion-quick)] sm:h-6 pointer-coarse:h-9",
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
        "flex h-9 w-full items-center gap-2 rounded-md px-1.5 text-left font-display text-sm transition-colors duration-[var(--motion-quick)] sm:h-6 pointer-coarse:h-9",
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
export function RaceOverlay({
  race,
  pad,
  reset,
  onReset,
  onCommand,
  onSurvival,
  audio,
}: {
  race: RaceHud;
  pad: boolean;
  reset: ResetInput | null;
  onReset: () => void;
  onCommand: Send;
  /** Enter Survival from the setup menu; null where the mode is not offered (a room). */
  onSurvival: (() => void) | null;
  /** The sound settings the setup and pause menus show (the modal covers the settings panel). */
  audio: AudioLevels;
}) {
  if (race.menu !== null) return <RaceMenu race={race} pad={pad} onCommand={onCommand} onSurvival={onSurvival} audio={audio} />;
  const you = race.you;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/3 z-10 flex flex-col items-center gap-3 px-3 sm:top-1/4">
      <ResetPrompt view={race.view} input={reset} race onTap={onReset} className="max-sm:hidden" />
      {race.phase === null ? null : <StartLights time={race.time} />}
      {you?.driverOut && race.spectating === null ? (
        <div
          className="flex items-center gap-2 rounded-xl bg-signal-red px-4 py-2 font-display text-2xl font-semibold uppercase tracking-widest text-fg shadow-lg sm:text-3xl"
          role="alert"
        >
          <UserX className="size-6" />
          Driver out
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
      {you?.missed && !you.wrongWay ? (
        <div
          className="flex items-center gap-2 rounded-xl bg-signal-amber px-4 py-2 font-display text-xl font-semibold uppercase tracking-widest text-accent-fg shadow-lg sm:text-2xl"
          role="alert"
        >
          <TriangleAlert className="size-5" />
          {missedCheckpointText(race.view, reset)}
        </div>
      ) : null}
      {race.view?.resetHold ? (
        <div
          className="flex w-72 flex-col gap-2 rounded-xl bg-surface px-4 py-2 shadow-lg ring-2 ring-signal-amber"
          role="progressbar"
          aria-label="Hold to reset"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={race.view.resetHold}
        >
          <p className="font-display text-xl font-semibold uppercase leading-none tracking-widest text-fg sm:text-2xl">Hold to reset</p>
          <div className="h-3 overflow-hidden rounded-full bg-fg/25">
            <div className="h-full origin-left bg-signal-amber" style={{ transform: `scaleX(${race.view.resetHold})` }} />
          </div>
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

function RaceMenu({ race, pad, onCommand, onSurvival, audio }: { race: RaceHud; pad: boolean; onCommand: Send; onSurvival: (() => void) | null; audio: AudioLevels }) {
  const quit = () => onCommand({ type: "quit" });
  const retry = () => onCommand({ type: "retry" });
  const end = () => onCommand({ type: "end" });
  switch (race.menu) {
    case "setup":
      return <SetupMenu race={race} pad={pad} onCommand={onCommand} onSurvival={onSurvival} audio={audio} />;
    case "pause": {
      const resume = () => onCommand({ type: "resume" });
      return (
        <MenuShell id="pause" eyebrow={race.survival ? `${race.trackName} · Survival` : `${race.trackName} · Lap ${race.you?.lap ?? 1}/${race.laps}`} title="Paused" pad={pad} adjust onBack={resume} onStart={resume}>
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
              {race.survival ? "End run" : "End race"}
            </NavButton>
            <NavButton variant="secondary" onClick={() => onCommand({ type: "fullUi", on: !race.fullUi })} aria-keyshortcuts="H">
              {race.fullUi ? <Focus /> : <PanelsTopLeft />}
              {race.fullUi ? "Race view" : "Full menu"}
            </NavButton>
            <AudioRows audio={audio} />
            <NavButton variant="ghost" onClick={quit}>
              Quit to menu
            </NavButton>
          </div>
        </MenuShell>
      );
    }
    case "dead":
      return (
        <MenuShell id="dead" eyebrow={race.trackName} title={race.you?.driverOut ? "Driver out" : "Wrecked"} pad={pad} onBack={null} onStart={null}>
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
      return race.survival ? <SurvivalResults race={race} pad={pad} onCommand={onCommand} /> : <ResultsMenu race={race} pad={pad} onCommand={onCommand} />;
    case "standings":
      return <StandingsMenu race={race} pad={pad} onCommand={onCommand} />;
    case null:
      return null;
  }
}

function SetupMenu({ race, pad, onCommand, onSurvival, audio }: { race: RaceHud; pad: boolean; onCommand: Send; onSurvival: (() => void) | null; audio: AudioLevels }) {
  const o = race.options;
  const options = (patch: Partial<RaceOptions>) => onCommand({ type: "options", options: patch });
  const campaign = o.mode === "campaign";
  const all = race.courses.map((c) => c.id);
  const allOn = all.every((id) => o.campaign.includes(id));
  return (
    <MenuShell id="setup" eyebrow="Race" title={campaign ? "Pick the campaign" : "Pick a course"} pad={pad} wide adjust onBack={() => onCommand({ type: "quit" })} onStart={null}>
      <div className="mb-2 grid gap-1.5">
        <Choice label="Mode" off="Single race" on="Campaign" value={campaign} onSet={(on) => options({ mode: on ? "campaign" : "single" })} />
        {campaign ? (
          <NavButton variant="secondary" onClick={() => options(selectAll(o, all))}>
            {allOn ? "Unselect all" : "Select all"}
          </NavButton>
        ) : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {race.courses.map((c) => {
          const place = o.campaign.indexOf(c.id) + 1;
          const on = campaign ? place > 0 : c.id === o.trackId;
          return (
            <button
              key={c.id}
              type="button"
              data-nav
              aria-pressed={on}
              onClick={() => options(courseTap(o, c.id))}
              className={cn(
                "flex min-h-11 flex-col items-start rounded-md px-2 py-1.5 text-left shadow-[var(--shadow-border)] transition-colors duration-[var(--motion-quick)]",
                on ? "bg-accent text-accent-fg" : "bg-surface-2 text-fg hover:bg-surface",
                FOCUS,
              )}
            >
              <span className="font-display text-lg font-semibold leading-tight">
                {campaign && on ? <span data-round={place}>{place}. </span> : null}
                {c.name}
              </span>
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
        <Stepper
          label="AI difficulty"
          value={AI_DIFFICULTIES.indexOf(o.aiDifficulty)}
          min={0}
          max={AI_DIFFICULTIES.length - 1}
          step={1}
          shown={o.aiDifficulty}
          hint="How well rivals drive: hard never slips and reacts every physics step; easy brakes late, runs wide and drifts off the line"
          onSet={(k) => options({ aiDifficulty: AI_DIFFICULTIES[k]! })}
        />
        <Stepper
          label="Time of day"
          value={TIMES_OF_DAY.indexOf(o.timeOfDay)}
          min={0}
          max={TIMES_OF_DAY.length - 1}
          step={1}
          shown={TIME_OF_DAY_LABEL[o.timeOfDay]}
          hint="The sky and the light: midday sun, a low golden sunset, or moonlight with the street lamps on"
          onSet={(k) => options({ timeOfDay: TIMES_OF_DAY[k]! })}
        />
        <Choice label="Wrecks" off="Respawn" on="No reset" value={o.noReset} onSet={(noReset) => options({ noReset })} />
        <Choice label="Police" off="Off" on="Chase" value={o.police} onSet={(police) => options({ police })} />
        <AudioRows audio={audio} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-1.5">
        <NavButton className="col-span-2" disabled={campaign && o.campaign.length === 0} onClick={() => onCommand({ type: campaign ? "campaign" : "start" })}>
          {campaign ? <Trophy /> : <Flag />}
          {campaign ? `Start campaign (${o.campaign.length})` : "Start race"}
        </NavButton>
        {onSurvival ? (
          <NavButton variant="secondary" onClick={onSurvival}>
            <Siren />
            Survival
          </NavButton>
        ) : null}
        <NavButton variant="ghost" className={onSurvival ? undefined : "col-span-2"} onClick={() => onCommand({ type: "quit" })}>
          Back
        </NavButton>
      </div>
      <SavedList saved={race.saved} outdated={race.outdated} autoPurge={race.autoPurge} onCommand={onCommand} />
    </MenuShell>
  );
}

const TIME_OF_DAY_LABEL: Record<TimeOfDay, string> = { daytime: "Daytime", sunset: "Sunset", nighttime: "Nighttime" };

const RESULT_STATUS: Record<CarStatus, string> = { racing: "Racing", respawning: "Racing", finished: "", out: "Out", dnf: "DNF" };

/**
 * The results and standings buttons: stacked on phones, one row from `sm` with even shares, but never narrower than a button's
 * label (`min-w-fit`), so a long course name takes the room it needs and the rest share what is left.
 */
const NAV_ROW = "mt-3 flex flex-col gap-1.5 sm:flex-row sm:*:min-w-fit sm:*:flex-1";

/** The finished race's link (the address bar already holds this run's share fragment), copied on a tap: muted, under the results. */
function RunLink() {
  const [said, setSaid] = useState<string | null>(null);
  return (
    <button
      type="button"
      className="mt-2 h-10 w-full text-xs text-muted underline-offset-2 hover:underline sm:h-7"
      onClick={() => void copyText(window.location.href).then((ok) => setSaid(ok ? "Link copied" : "Copy failed: the link is in the address bar"))}
    >
      {said ?? "Copy link to this run"}
    </button>
  );
}

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
      sheet={race.reel ? onCommand : null}
      onBack={campaign ? null : quit}
      onStart={null}
    >
      {race.winnerName ? (
        <p className="flex items-center gap-2 font-display text-lg font-semibold">
          <Trophy className="size-4 text-muted" />
          {race.winnerName} wins{race.winBy === "survival" ? ", last car running" : ""}
        </p>
      ) : null}
      {race.team ? (
        <p className="mt-1 text-sm text-muted">
          {[race.team.won === null ? null : race.team.won ? "Team wins" : "Team loses", `${race.team.won === null ? "Team: " : ""}best place ${race.team.place ?? "–"}`].filter(Boolean).join(" · ")}
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
      <div className={race.reel ? "mt-3 grid grid-cols-2 gap-1.5" : NAV_ROW}>
        {campaign ? (
          <NavButton className={race.reel ? "col-span-2" : undefined} onClick={() => onCommand({ type: "next" })}>
            {race.team?.won === false ? <RotateCcw /> : <Trophy />}
            {race.team?.won === false ? "Retry round" : "Standings"}
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
      <RunLink />
      {race.reel ? <ReelList reel={race.reel} shown={race.shown} onCommand={onCommand} /> : null}
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
      sheet={race.reel ? onCommand : null}
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
      {/* Names never truncate: on a narrow phone the round columns give way to their content instead (measured whole at 320 px with a
          16-character name beside eight round columns). */}
      <table className="w-full font-display text-sm tabular-nums">
        <thead>
          <tr className="hud-label text-left">
            <th className={cn(th, "w-8")}>#</th>
            <th className={cn(th, "pr-2")}>Driver</th>
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
              <td className="whitespace-nowrap py-1 pr-2">{r.name}</td>
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
      <div className={NAV_ROW}>
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
      {race.reel ? <ReelList reel={race.reel} shown={race.shown} onCommand={onCommand} /> : null}
    </MenuShell>
  );
}
