/**
 * Is a newer build deployed, and how does a page reload onto it without ever looping?
 *
 * The build emits `version.json` (`{ "sha": "<short sha>" }`, `vite.config.ts` `versionFilePlugin`) beside its assets,
 * so the file a running page fetches comes from the release that serves it: it can name a newer build than the
 * page, never one the server is not yet serving. The app registers no service worker, so the browser's HTTP
 * cache is the only cache: the poll bypasses it, and a reload goes to the same address with `?v=<sha>`, one
 * no cache holds a document for (`location.reload(true)` is non-standard and Chrome ignores the argument).
 *
 * A reload that comes back still running the old build (a stale proxy, a deploy half-way) is remembered, and the
 * next attempt for that build waits longer each time, so an unattended phone never reloads in a loop.
 */

/** Where the build's `version.json` is served (next to the page, under the app's base path). */
const VERSION_URL = `${import.meta.env?.BASE_URL ?? "/"}version.json`;
/** How often a visible page asks; a tab that was away asks again when it comes back (`REFOCUS_MS`). */
export const POLL_MS = 3 * 60_000;
export const REFOCUS_MS = 30_000;

const SHA = /^[A-Za-z0-9._-]{1,40}$/;

/** The deployed build's sha from `version.json`; null when it cannot be read (offline, an error page, a dev server). */
export async function fetchDeployedSha(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  try {
    const res = await fetchImpl(`${VERSION_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null || !("sha" in body)) return null;
    return typeof body.sha === "string" && SHA.test(body.sha) ? body.sha : null;
  } catch {
    return null;
  }
}

/** The deployed sha when it names a different build than the running one. A build made without git ("dev") on either side has no identity to compare. */
export function newerBuild(running: string, deployed: string | null): string | null {
  return deployed !== null && deployed !== "dev" && running !== "dev" && deployed !== running ? deployed : null;
}

/** The last reload this browser made for an update: the build it went for, when, and how many times in a row it has gone for that build. */
export interface ReloadRecord {
  sha: string;
  at: number;
  tries: number;
}

const BACKOFF_FIRST_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
const RECORD_KEY = "crush.update.reload";

/** How long to wait after the `tries`-th reload for the same build before a next one: 2, 4, 8 ... minutes, at most an hour. */
export function backoffMs(tries: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** (tries - 1));
}

function readRecord(store: Pick<Storage, "getItem"> | null): ReloadRecord | null {
  try {
    const raw: unknown = JSON.parse(store?.getItem(RECORD_KEY) ?? "null");
    if (typeof raw !== "object" || raw === null || !("sha" in raw) || !("at" in raw) || !("tries" in raw)) return null;
    const { sha, at, tries } = raw;
    return typeof sha === "string" && typeof at === "number" && typeof tries === "number" ? { sha, at, tries } : null;
  } catch {
    return null;
  }
}

/**
 * Where a reload onto `deployed` goes (`href` with `?v=<sha>`), or null while the backoff holds it back; the attempt is
 * recorded in `store`. The first reload for a build goes at once. `force` is a person's tap: it goes whatever the
 * backoff says (and still counts). Without a store that remembers, an automatic reload does not go at all.
 */
export function planReload(store: Pick<Storage, "getItem" | "setItem"> | null, href: string, deployed: string, now: number, force = false): string | null {
  const last = readRecord(store);
  const prior = last?.sha === deployed ? last : null;
  // A clock set back (`now` before the record) would hold the reload for the whole jump: it counts as waited.
  const waited = prior === null || now < prior.at || now - prior.at >= backoffMs(prior.tries);
  if (!waited && !force) return null;
  let remembered = false;
  try {
    store?.setItem(RECORD_KEY, JSON.stringify({ sha: deployed, at: now, tries: prior ? prior.tries + 1 : 1 } satisfies ReloadRecord));
    remembered = store !== null;
  } catch {
    // A closed store (a private tab, a full quota) cannot hold the backoff: only a person's tap goes on.
  }
  if (!remembered && !force) return null;
  const url = new URL(href);
  url.searchParams.set("v", deployed);
  return url.toString();
}

/** A page that now runs the build its last reload went for has landed: the record is spent. */
export function settleReload(store: Pick<Storage, "getItem" | "removeItem">, running: string): void {
  if (readRecord(store)?.sha === running) store.removeItem(RECORD_KEY);
}

/** The browser's local storage; null where it is closed (reading `localStorage` itself throws in some private tabs). */
function openStore(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** Where a reload of `href` onto the deployed build goes, or null while the backoff holds it back (`force`: a tap goes anyway). */
export function reloadTarget(href: string, deployed: string, force = false): string | null {
  return planReload(openStore(), href, deployed, Date.now(), force);
}

/** Reload this page onto the deployed build; false when the backoff holds it back (`force`: a tap goes anyway). */
export function reloadOntoUpdate(deployed: string, force = false): boolean {
  const to = reloadTarget(location.href, deployed, force);
  if (to !== null) location.assign(to);
  return to !== null;
}

/** Page start: spend a landed reload's record, and drop the `?v=` the reload carried so the address and its share links stay clean. */
export function settleOnLoad(running: string): void {
  const store = openStore();
  if (store) settleReload(store, running);
  const url = new URL(location.href);
  if (!url.searchParams.has("v")) return;
  url.searchParams.delete("v");
  history.replaceState(history.state, "", url);
}
