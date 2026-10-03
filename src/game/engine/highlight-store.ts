import { clipTitle, type HighlightClip } from "../match/highlights.ts";
import type { SavedHud } from "../match/types.ts";
import { encodeSaved } from "../net/reel-codec.ts";

/** `localStorage` keys: the index (JSON `SavedHud[]`, newest first) and one entry per clip under `CLIP_PREFIX` + key. */
const INDEX = "crush.highlights";
const CLIP_PREFIX = "crush.highlight.";
/** Caps in UTF-16 chars (what `localStorage` quotas count): one clip, and all saved clips together. */
const CLIP_MAX_CHARS = 300_000;
const TOTAL_MAX_CHARS = 2_000_000;

type Entry = SavedHud & { chars: number };

function readIndex(): Entry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(INDEX) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is Entry =>
        typeof e === "object" &&
        e !== null &&
        typeof e.key === "string" &&
        typeof e.title === "string" &&
        typeof e.trackName === "string" &&
        typeof e.savedAt === "number" &&
        typeof e.chars === "number",
    );
  } catch {
    return [];
  }
}

/** This browser's saved highlights, newest first. */
export function listSaved(): SavedHud[] {
  return readIndex().map(({ key, title, trackName, savedAt }) => ({ key, title, trackName, savedAt }));
}

/**
 * Keep `clip` (docs/HIGHLIGHTS.md "Saving"): refused when its text passes `CLIP_MAX_CHARS`, when all saved clips would
 * pass `TOTAL_MAX_CHARS` (nothing is evicted: a saved clip is the player's), or when the browser's quota throws.
 */
export async function saveClip(clip: HighlightClip, trackName: string): Promise<"saved" | "too big" | "full" | "failed"> {
  const text = await encodeSaved(clip);
  if (text.length > CLIP_MAX_CHARS) return "too big";
  const index = readIndex();
  if (index.reduce((a, e) => a + e.chars, 0) + text.length > TOTAL_MAX_CHARS) return "full";
  const savedAt = Date.now();
  const key = `${savedAt.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  try {
    localStorage.setItem(CLIP_PREFIX + key, text);
    localStorage.setItem(INDEX, JSON.stringify([{ key, title: clipTitle(clip), trackName, savedAt, chars: text.length }, ...index]));
    return "saved";
  } catch {
    localStorage.removeItem(CLIP_PREFIX + key);
    return "failed";
  }
}

/** A saved clip's stored text (`decodeSaved` reads it), null when gone. */
export function loadSaved(key: string): string | null {
  return localStorage.getItem(CLIP_PREFIX + key);
}

export function deleteSaved(key: string): void {
  localStorage.removeItem(CLIP_PREFIX + key);
  localStorage.setItem(INDEX, JSON.stringify(readIndex().filter((e) => e.key !== key)));
}
