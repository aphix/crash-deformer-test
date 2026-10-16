import { Button } from "@/components/ui/button";
import { courseTap, selectAll } from "@/game/hud/setup-patch";
import { GAME_KINDS, type GameKind } from "@/game/net/codec";
import type { CourseMenu } from "@/game/net/net-ports";
import { cn } from "@/lib/utils";

/** Taps stay 44 px tall on phones, 32 px from `sm`. */
const TAP = "h-11 sm:h-8";
const keepFocus = (e: { preventDefault: () => void }): void => e.preventDefault();

export const GAME_LABEL: Record<GameKind, string> = { race: "Race", campaign: "Campaign", survival: "Survival", derby: "Derby" };

type GameOptionsProps = {
  kind: GameKind;
  /** Picks the game; null when it is fixed (a public room is named after its game). */
  onKind: ((kind: GameKind) => void) | null;
  /** The course a race or a Survival run is on. */
  course: string;
  onCourse: (id: string) => void;
  /** The campaign's courses in play order. */
  playlist: readonly string[];
  onPlaylist: (ids: readonly string[]) => void;
  menu: CourseMenu;
};

/**
 * The game a room runs and what it needs, the same pick for every game: the hosting panel sets it before the room opens and the
 * lobby's start gate lets the host change it while the room waits. A race and a Survival run take a course, a campaign a playlist
 * (tap a course to add it at the end, tap again to drop it: the order of the taps is the order of play), a derby nothing.
 */
export function GameOptions({ kind, onKind, course, onCourse, playlist, onPlaylist, menu }: GameOptionsProps) {
  const courses = kind === "survival" ? menu.survival : menu.courses;
  return (
    <div className="space-y-1.5">
      {onKind ? (
        <div className="flex gap-1" role="group" aria-label="Game">
          {GAME_KINDS.map((k) => (
            <Button key={k} className={cn(TAP, "flex-1 px-1 text-xs")} variant={kind === k ? "default" : "secondary"} aria-pressed={kind === k} onMouseDown={keepFocus} onClick={() => onKind(k)}>
              {GAME_LABEL[k]}
            </Button>
          ))}
        </div>
      ) : null}
      {kind === "race" || kind === "survival" ? (
        <label className="flex items-center gap-2">
          <span className="hud-label w-12 shrink-0">Course</span>
          <select value={course} onChange={(e) => onCourse(e.target.value)} aria-label={kind === "race" ? "Race course" : "Survival course"} className={cn(TAP, "w-full rounded-md bg-surface-2 px-2")}>
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {kind === "campaign" ? (
        <div className="space-y-1" role="group" aria-label="Campaign courses">
          <div className="flex items-center justify-between gap-2">
            <p className="hud-label">
              Courses, in play order{playlist.length > 0 ? ` (${playlist.length})` : ""}
            </p>
            <Button variant="ghost" size="sm" className={cn(TAP, "px-2 text-xs")} onMouseDown={keepFocus} onClick={() => onPlaylist(selectAll({ campaign: playlist }, menu.courses.map((c) => c.id)).campaign ?? [])}>
              {menu.courses.every((c) => playlist.includes(c.id)) ? "Unselect all" : "Select all"}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-1">
            {menu.courses.map((c) => {
              const place = playlist.indexOf(c.id) + 1;
              return (
                <Button
                  key={c.id}
                  className={cn(TAP, "justify-start truncate px-2 text-xs")}
                  variant={place > 0 ? "default" : "secondary"}
                  aria-pressed={place > 0}
                  onMouseDown={keepFocus}
                  onClick={() => onPlaylist(courseTap({ mode: "campaign", campaign: playlist }, c.id).campaign ?? playlist)}
                >
                  {place > 0 ? `${place}. ` : ""}
                  {c.name}
                </Button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
