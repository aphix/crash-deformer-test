#!/usr/bin/env node
/**
 * Pull what players sent from the game (benchmark cards, JSON captures, flagged replay clips) down from the server.
 *
 *   SUBMISSIONS_OWNER_TOKEN=<token> node scripts/fetch-submissions.mjs <app url> [--kind bench|capture|flag] [--limit 50] [--id XXXX-XXXX] [--out dir] [--phases]
 *
 * `<app url>` is where the game is served, e.g. https://example.org/crush/ . Each submission is saved as `<out>/<receipt id>.json` (default
 * `.bench/submissions`, which git ignores); one already saved is not fetched again. The token is read from the environment only, so it
 * never appears in a process list or a shell history line. `--phases` prints each bench card's sim phase table (ms per sim-second by phase, the work
 * counts, long tasks and battery) under its line, for cards already saved too. Exit 0 when every request went; 1 otherwise.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RECEIPT = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const KINDS = ["bench", "capture", "flag"];
/** The server paces reads per address (a burst of 30, then one a second): a 429 is waited out, not an error. */
const RETRY_429_MS = 1_500;
const RETRY_429_MAX = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const f1 = (v) => v.toFixed(1);

/**
 * The lines of a bench card's phase table, for a submission as `readOne` answers it; none for another kind. A card from before the phase timing
 * has no `phases` and says so.
 */
export function phaseTable(one) {
  const result = one.submission?.payload?.result;
  if (one.kind !== "bench" || !result) return [];
  const p = result.phases;
  if (!p) return ["    phases: none (a card from before the phase timing)"];
  const phases = Object.entries(p.msPerSimS).map(([name, ms]) => `${name} ${f1(ms)}`).join("  ");
  const work = Object.entries(p.workPerSimS).map(([name, n]) => `${name} ${Math.round(n)}`).join("  ");
  const tasks = result.longTasks ? `${result.longTasks.count} long tasks, ${f1(result.longTasks.totalMs)} ms` : "long tasks n/a";
  const battery = result.device?.battery;
  const level = (b) => `${Math.round(100 * b.level)} %${b.charging ? " charging" : ""}`;
  return [
    `    ${result.course} ${f1(result.simMsPerSimS)} ms/sim-s = ${phases}  unattributed ${f1(p.unattributedMsPerSimS)}`,
    `    per sim-s: ${work}`,
    `    ${tasks}; battery ${battery ? `${level(battery.start)} -> ${level(battery.end)}` : "n/a"}`,
  ];
}

/** GET `url` with the bearer token, waiting out 429s. Resolves to the JSON body; throws with the status and the server's words otherwise. */
async function get(url, token, fetchImpl, pause) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (res.status === 429 && attempt < RETRY_429_MAX) {
      await pause(RETRY_429_MS);
      continue;
    }
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${url}: ${res.status}, not JSON`);
    }
    if (!res.ok) throw new Error(`${url}: ${res.status} ${body?.error ?? ""}`.trim());
    return body;
  }
}

/**
 * Save the submissions of `options.base` into `options.out`. Resolves to `{ saved, skipped }`, the receipt ids written and the ones
 * already there; rejects on the first request the server refuses.
 */
export async function fetchSubmissions(options) {
  const { base, token, out, kind, limit, id, phases = false, fetchImpl = fetch, pause = sleep, log = () => {} } = options;
  if (!token || token.length < 24) throw new Error("SUBMISSIONS_OWNER_TOKEN is not set (24 characters or more)");
  if (kind !== undefined && !KINDS.includes(kind)) throw new Error(`--kind is one of ${KINDS.join(", ")}`);
  if (id !== undefined && !RECEIPT.test(id)) throw new Error("--id is a receipt id like K7QM-2XWD");
  const api = new URL("api/submissions", base.endsWith("/") ? base : `${base}/`);
  await mkdir(out, { recursive: true });

  let ids;
  if (id !== undefined) ids = [id];
  else {
    const query = new URLSearchParams({ limit: String(limit ?? 50) });
    if (kind !== undefined) query.set("kind", kind);
    const listed = await get(`${api}?${query}`, token, fetchImpl, pause);
    // A receipt id becomes a file name here: only the receipt format gets through, whatever the server answers.
    ids = listed.submissions.map((s) => s.id).filter((s) => RECEIPT.test(s));
  }
  const saved = [];
  const skipped = [];
  for (const receipt of ids.toReversed()) {
    const file = path.join(out, `${receipt}.json`);
    if (existsSync(file)) {
      skipped.push(receipt);
      if (phases) for (const line of phaseTable(JSON.parse(await readFile(file, "utf8")))) log(line);
      continue;
    }
    const one = await get(`${api}?id=${receipt}`, token, fetchImpl, pause);
    await writeFile(file, `${JSON.stringify(one, null, 1)}\n`);
    saved.push(receipt);
    log(`${receipt}  ${one.kind.padEnd(7)} ${one.receivedAt}  build ${one.sha}  ${file}`);
    if (phases) for (const line of phaseTable(one)) log(line);
  }
  return { saved, skipped };
}

function parseArgs(argv) {
  const args = { out: ".bench/submissions" };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--kind") args.kind = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--id") args.id = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--phases") args.phases = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new Error("usage: fetch-submissions.mjs <app url> [--kind k] [--limit n] [--id receipt] [--out dir] [--phases]");
  return { ...args, base: positional[0] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { saved, skipped } = await fetchSubmissions({ ...args, token: process.env.SUBMISSIONS_OWNER_TOKEN, log: console.log });
    console.log(`${saved.length} saved, ${skipped.length} already in ${args.out}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
