import { FOCUS, FOCUS_WITHIN } from "@/components/race-menu-styles";
import { useDriver } from "@/components/use-driver";
import { DRIVER_CARS, NAME_MAX } from "@/game/race/types";
import { cn } from "@/lib/utils";

/** Race setup rows: the player's name and car type (stored by `useDriver`; touch-sized, pad-navigable). */
export function DriverRows() {
  const driver = useDriver();
  const car = DRIVER_CARS.some((c) => c.id === driver.car) ? driver.car : DRIVER_CARS[0]!.id;
  return (
    <>
      <label className={cn("flex min-h-11 items-center gap-2 rounded-md bg-surface-2 py-0.5 pl-2 pr-0.5 shadow-[var(--shadow-border)] sm:min-h-8", FOCUS_WITHIN)}>
        <span className="hud-label w-24 shrink-0 text-muted sm:w-32">Name</span>
        {/* 16 px text on phones: a smaller input makes iOS zoom the page on focus. */}
        <input
          data-nav
          type="text"
          value={driver.name}
          maxLength={NAME_MAX}
          placeholder="You"
          autoComplete="nickname"
          enterKeyHint="done"
          spellCheck={false}
          onChange={(e) => driver.setName(e.target.value)}
          className="h-10 min-w-0 flex-1 rounded-md bg-surface px-2 font-display text-base text-fg outline-none placeholder:text-muted sm:h-7 sm:text-sm"
        />
      </label>
      <div role="group" aria-label="Car" className="flex items-center gap-2 rounded-md bg-surface-2 py-1 pl-2 pr-1 shadow-[var(--shadow-border)]">
        <span className="hud-label w-24 shrink-0 text-muted sm:w-32">Car</span>
        <div className="grid flex-1 grid-cols-2 gap-0.5 rounded-md bg-surface p-0.5 min-[420px]:grid-cols-3 sm:grid-cols-4">
          {DRIVER_CARS.map((c) => (
            <button
              key={c.id}
              type="button"
              data-nav
              aria-pressed={c.id === car}
              onClick={() => driver.setCar(c.id)}
              className={cn(
                "h-11 rounded-md px-2 font-display text-sm font-medium transition-colors duration-[var(--motion-quick)] sm:h-7",
                c.id === car ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
                FOCUS,
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
