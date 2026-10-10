#!/usr/bin/env node
/**
 * `node --test`, but the slowest files start first.
 *
 *   node --experimental-strip-types scripts/run-tests.mjs [--concurrency=4] [--shard=i/n [--weights=1,0.55]] [--learn] <file or glob>...
 *
 * Same files, same one-process-per-file isolation, same spec output and exit code as the CLI. The CLI sorts the files by
 * path, so a 200 s file near the end of the alphabet (`world/survival-chase`) starts last and sets the wall time; here the
 * files named in `test-cost.json` (seconds, from `--learn`) go first, longest first, and the rest follow in path order.
 * A missing or stale entry only costs speed. `--learn` rewrites `test-cost.json` from this run (files of 2 s and more).
 * `--shard=i/n` (i from 1) runs the i-th of n machines' shares: files go longest first to the share with the least cost per unit of
 * weight (`--weights`, one speed per share: a slower machine gets less), the same split on every machine, so n machines together run each
 * file once. The slowest files of the run print at the end (split any that sets the wall time).
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { run } from "node:test";
import { spec } from "node:test/reporters";

const COST = new URL("./test-cost.json", import.meta.url);
const args = process.argv.slice(2);
const learn = args.includes("--learn");
const concurrency = Number(args.find((a) => a.startsWith("--concurrency="))?.slice(14) ?? 4);
const patterns = args.filter((a) => !a.startsWith("--"));
/** @type {Record<string, number>} */
const cost = JSON.parse(readFileSync(COST, "utf8"));

// A pattern that matches nothing stays as given: the child fails on the missing file, as with the CLI.
let files = [...new Set(patterns.flatMap((p) => { const hit = globSync(p); return hit.length ? hit : [p]; }))].sort();
files.sort((a, b) => (cost[b] ?? 0) - (cost[a] ?? 0));
const shard = args.find((a) => a.startsWith("--shard="))?.slice(8);
if (shard) {
  const [mine, n] = shard.split("/").map(Number);
  const speed = args.find((a) => a.startsWith("--weights="))?.slice(10).split(",").map(Number) ?? Array(n).fill(1);
  const load = Array(n).fill(0);
  files = files.filter((f) => {
    let k = 0;
    for (let j = 1; j < n; j++) if (load[j] / speed[j] < load[k] / speed[k]) k = j;
    load[k] += cost[f] ?? 2;
    return k === mine - 1;
  });
}

/** @type {Map<string, number>} */
const seconds = new Map();
const stream = run({ files, concurrency, execArgv: ["--experimental-strip-types"] });
stream.on("test:summary", (s) => {
  if (s.file === undefined && !s.success) process.exitCode = 1;
});
for (const event of ["test:pass", "test:fail"]) {
  stream.on(event, (e) => {
    if (e.nesting === 0 && e.file) seconds.set(e.file, (seconds.get(e.file) ?? 0) + e.details.duration_ms / 1000);
  });
}
stream.compose(spec).pipe(process.stdout);
stream.on("end", () => {
  const slow = [...seconds].sort((a, b) => b[1] - a[1]).slice(0, 10);
  console.log(`\nslowest files: ${slow.map(([f, s]) => `${f.slice(process.cwd().length + 1)} ${Math.round(s)} s`).join(", ")}`);
  if (!learn) return;
  const next = { ...cost };
  for (const f of files) delete next[f];
  for (const [f, s] of seconds) if (s >= 2) next[f.slice(process.cwd().length + 1)] = Math.round(s);
  writeFileSync(COST, JSON.stringify(Object.fromEntries(Object.entries(next).sort((a, b) => b[1] - a[1])), null, 1) + "\n");
});
