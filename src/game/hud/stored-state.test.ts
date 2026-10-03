import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Nothing the previous run stored may pick this run's scene, settings or room (the page's `#` alone does:
 * `engine-share.ts`). The way to keep that true is to list everything the app persists and say what each is: a new
 * stored key or a new file that touches storage fails here until it is classified as a preference (kept) and added.
 */
const SRC = new URL("../../", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx?$/.test(e.name) && !/\.test(-util)?\.ts$/.test(e.name) ? [p] : [];
  });
}

const files = sources(SRC).map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, "utf8") }));

/** Every browser-storage user, and what it keeps (all preferences or user data; none is a previous run's session). */
const STORAGE_FILES = [
  // HUD layout preferences and the driver's name and car pick, via `useStoredString`.
  "components/use-stored-string.ts",
  // The player's saved highlight clips (user data the player asked to keep).
  "game/engine/highlight-store.ts",
  // The embedded preview's sign-in bearer token (not game state).
  "lib/auth/client.ts",
];

/** Every `useStoredString` key: HUD layout and driver preferences. */
const STORED_KEYS = ["crush.driver.car", "crush.driver.name", "crush.hud.sections", "crush.hud.settings"];

describe("what the browser keeps between runs", () => {
  it("good: only these files read or write localStorage or sessionStorage (all preferences, never a scene, setting or room)", () => {
    const users = files.filter((f) => /\b(local|session)Storage\.(get|set|remove)Item/.test(f.text)).map((f) => f.rel);
    assert.equal(users.sort().join(" "), [...STORAGE_FILES].sort().join(" "));
  });

  it("good: every useStoredString key is a listed preference", () => {
    const keys = files.flatMap((f) => [...f.text.matchAll(/useStoredString\(\s*"([^"]+)"/g)].map((m) => m[1]!));
    assert.ok(keys.length >= STORED_KEYS.length, "the scan finds the callers (not vacuous)");
    assert.equal([...new Set(keys)].sort().join(" "), STORED_KEYS.join(" "));
  });
});
