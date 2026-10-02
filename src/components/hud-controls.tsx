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
        className="h-11 w-full min-w-0 cursor-pointer accent-current sm:h-6"
      />
      {"shown" in end ? (
        <span className="w-14 shrink-0 text-right font-display text-xs tabular-nums text-fg">{end.shown}</span>
      ) : (
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value.toFixed(end.digits)}
          onChange={(e) => onValue(Number(e.target.value))}
          aria-label={`${name} value`}
          className={FIELD}
        />
      )}
    </label>
  );
}
