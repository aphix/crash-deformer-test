import { useRef } from "react";
import { Bookmark, BookmarkCheck, Play, Trash2 } from "lucide-react";
import { NavButton } from "@/components/race-menu-shell";
import { usePadMenu } from "@/components/use-pad-menu";
import type { RaceCommand, ReelHud, SavedHud, SaveResult } from "@/game/match/types";
import { cn } from "@/lib/utils";

type Send = (cmd: RaceCommand) => void;

/** Highlight row: title and detail line, then its touch-sized actions. */
const CLIP_ROW = "flex items-center gap-1.5 rounded-md py-1 pl-2 pr-1 shadow-[var(--shadow-border)]";

/** Why a Save was refused (`SaveResult`), on the clip's row. */
const SAVE_REFUSED: Record<Exclude<SaveResult, "saved">, string> = {
  "too big": "Not saved: this clip is too big to store",
  full: "Not saved: saved highlights are full (delete one in race setup)",
  failed: "Not saved: this browser refused the storage",
};

/** The results reel's clips (docs/HIGHLIGHTS.md): the one on screen now, watch one alone, keep one in this browser. */
export function ReelList({ reel, onCommand }: { reel: ReelHud; onCommand: Send }) {
  return (
    <section className="mt-3" aria-label="Highlights">
      <p className="hud-label">Highlights</p>
      <ol className="mt-1 grid gap-1.5">
        {reel.clips.map((c, i) => {
          const now = i === reel.playing;
          return (
            <li key={i} aria-current={now || undefined} className={cn(CLIP_ROW, now ? "bg-accent text-accent-fg" : "bg-surface-2")}>
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-sm font-semibold leading-tight">{c.title}</p>
                <p className={cn("text-xs tabular-nums", now ? "text-accent-fg" : "text-muted")}>
                  {now ? "Now · " : ""}Score {c.score.toFixed(1)} · {c.cars} {c.cars === 1 ? "car" : "cars"}
                </p>
                {c.saved && c.saved !== "saved" ? (
                  <p role="status" className="text-xs font-semibold">
                    {SAVE_REFUSED[c.saved]}
                  </p>
                ) : null}
              </div>
              <NavButton variant="secondary" className="w-auto px-3" onClick={() => onCommand({ type: "reelView", clip: i })}>
                <Play />
                Watch
              </NavButton>
              <NavButton variant="secondary" className="w-auto px-3" disabled={c.saved === "saved"} onClick={() => onCommand({ type: "reelSave", clip: i })}>
                {c.saved === "saved" ? <BookmarkCheck /> : <Bookmark />}
                {c.saved === "saved" ? "Saved" : "Save"}
              </NavButton>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** This browser's saved highlights in the setup menu: play one alone, or delete it. */
export function SavedList({ saved, onCommand }: { saved: SavedHud[]; onCommand: Send }) {
  if (saved.length === 0) return null;
  return (
    <section className="mt-3" aria-label="Saved highlights">
      <p className="hud-label">Saved highlights</p>
      <ul className="mt-1 grid gap-1.5">
        {saved.map((s) => (
          <li key={s.key} className={cn(CLIP_ROW, "bg-surface-2")}>
            <div className="min-w-0 flex-1">
              <p className="truncate font-display text-sm font-semibold leading-tight">{s.title}</p>
              <p className="truncate text-xs text-muted">
                {s.trackName} · {new Date(s.savedAt).toLocaleDateString()}
              </p>
            </div>
            <NavButton variant="secondary" className="w-auto px-3" onClick={() => onCommand({ type: "savedPlay", key: s.key })}>
              <Play />
              Play
            </NavButton>
            <NavButton
              variant="ghost"
              className="w-11 px-0 sm:w-8"
              aria-label={`Delete ${s.title}`}
              title="Delete"
              onClick={() => onCommand({ type: "savedDelete", key: s.key })}
            >
              <Trash2 />
            </NavButton>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Solo view (a reel clip or a saved one shown alone): the whole HUD is this transparent exit; a tap, Esc or pad B sends `reelBack`. */
export function SoloExit({ title, onCommand }: { title: string; onCommand: Send }) {
  const ref = useRef<HTMLButtonElement>(null);
  const back = () => onCommand({ type: "reelBack" });
  // No `[data-nav]` inside: the hook only supplies Esc and B.
  usePadMenu(ref, "solo", { onBack: back, onStart: null });
  return (
    <button
      ref={ref}
      type="button"
      aria-label="Exit replay"
      title={`${title} · tap or Esc to exit`}
      onClick={back}
      className="pointer-events-auto absolute inset-0 z-30 cursor-pointer bg-transparent outline-none"
    />
  );
}
