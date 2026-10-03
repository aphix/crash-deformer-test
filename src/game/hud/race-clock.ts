/** m:ss.mmm; negative clock (before green) reads 0. */
export function fmtTime(seconds: number): string {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

export function fmtGap(seconds: number): string {
  return seconds < 60 ? `+${seconds.toFixed(2)}` : `+${fmtTime(seconds)}`;
}
