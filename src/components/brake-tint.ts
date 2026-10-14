/** The speed digits' colour for a brake cue (0..1, `RaceView.brakeCue`): their own colour mixed toward amber by the cue; undefined (the class's own colour) at 0. */
export function brakeTint(cue: number): string | undefined {
  return cue > 0 ? `color-mix(in srgb, var(--color-signal-amber) ${Math.round(cue * 100)}%, var(--color-fg))` : undefined;
}
