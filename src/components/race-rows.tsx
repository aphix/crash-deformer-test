import { Minus, Plus } from "lucide-react";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { FOCUS_WITHIN } from "@/components/race-menu-styles";
import { cn } from "@/lib/utils";

/** A ←/→ adjustable row of the race menus: a number (and with `slider` a range input) stepped by `step`; pad and keyboard drive its `data-step` buttons. */
export function Stepper({
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
export function Choice({ label, off, on, value, onSet }: { label: string; off: string; on: string; value: boolean; onSet: (value: boolean) => void }) {
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

/** An n-way row: a tap on a segment picks it; ←/→ pick the neighbours (the segment before the lit one is `data-step="-1"`, the one after `"1"`). */
export function Pick({ label, options, value, onSet }: { label: string; options: readonly { id: string; name: string }[]; value: string; onSet: (id: string) => void }) {
  const lit = options.findIndex((o) => o.id === value);
  const segment = (on: boolean) =>
    cn(
      "h-11 rounded-md px-2 font-display text-sm font-medium transition-colors duration-[var(--motion-quick)] sm:h-7",
      on ? "bg-accent text-accent-fg" : "text-muted hover:text-fg",
    );
  return (
    <div
      data-nav
      data-adjust
      tabIndex={0}
      role="group"
      aria-label={`${label}: ${options[lit]?.name ?? ""}`}
      className={cn("flex min-h-11 items-center gap-2 rounded-md bg-surface-2 py-0.5 pl-2 pr-0.5 shadow-[var(--shadow-border)] sm:min-h-8", FOCUS_WITHIN)}
    >
      <span className="hud-label w-24 shrink-0 text-muted sm:w-32">{label}</span>
      <div className="grid flex-1 auto-cols-fr grid-flow-col gap-0.5 rounded-md bg-surface p-0.5">
        {options.map((o, i) => (
          <button key={o.id} type="button" tabIndex={-1} data-step={i === lit - 1 ? "-1" : i === lit + 1 ? "1" : undefined} aria-pressed={i === lit} onClick={() => onSet(o.id)} className={segment(i === lit)}>
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}
