import { useState } from "react";

/** Number boxes and the time-scale field: 44 px tall on phones, 32 px from `sm`. */
export const FIELD =
  "h-11 w-14 shrink-0 rounded-md bg-surface-2 px-1.5 text-right font-display text-xs tabular-nums text-fg shadow-[var(--shadow-border)] sm:h-8";

/**
 * Label, range slider, then either a read-out (`shown`, the rig panels' narrow rows) or a typed number field
 * (`digits`, the settings column). 44 px tall on phones, 24 px from `sm`.
 */
export function RangeRow({
  label,
  name = label,
  title,
  value,
  min,
  max,
  step,
  onValue,
  disabled,
  ...end
}: {
  label: string;
  /** Accessible name of the slider (the number field adds " value"); defaults to `label`. */
  name?: string;
  /** Hover help for the whole row. */
  title?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onValue: (v: number) => void;
  /** Greys the slider; the row stays in place. */
  disabled?: boolean;
} & ({ shown: string } | { digits: number })) {
  return (
    <label className="flex items-center gap-2" title={title}>
      <span className={"shown" in end ? "hud-label w-10 shrink-0" : "hud-label w-12 shrink-0"}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onValue(Number(e.target.value))}
        aria-label={name}
        disabled={disabled}
        className="h-11 w-full min-w-0 cursor-pointer accent-current disabled:cursor-not-allowed disabled:opacity-40 sm:h-6"
      />
      {"shown" in end ? (
        <span className="w-14 shrink-0 text-right font-display text-xs tabular-nums text-fg">{end.shown}</span>
      ) : (
        <NumberField value={value} digits={end.digits} min={min} max={max} step={step} label={`${name} value`} onValue={onValue} />
      )}
    </label>
  );
}

/**
 * Typed number box. While focused it shows the user's own text (a controlled `toFixed` value would rewrite "0" as "0.00"
 * mid-typing), commits each keystroke that parses inside [min, max], and on blur or Enter commits an out-of-range entry
 * (the engine clamps it) and shows the engine's value again.
 */
export function NumberField({
  value,
  digits,
  min,
  max,
  step,
  label,
  onValue,
}: {
  value: number;
  digits: number;
  min: number;
  max: number;
  step: number;
  label: string;
  onValue: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft ?? value.toFixed(digits)}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = e.target.value.trim() === "" ? NaN : Number(e.target.value);
        if (n >= min && n <= max) onValue(n);
      }}
      onBlur={() => {
        const n = draft == null || draft.trim() === "" ? NaN : Number(draft);
        if (Number.isFinite(n) && (n < min || n > max)) onValue(n);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      aria-label={label}
      className={FIELD}
    />
  );
}
