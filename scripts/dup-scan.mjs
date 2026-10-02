#!/usr/bin/env node
/**
 * Token-window clone detector (the jscpd method, no dependency): a clone is a run of >= MIN_TOKENS
 * identical tokens (comments and whitespace ignored) spanning >= MIN_LINES lines in two places.
 * `--renamed` also matches copies whose identifiers and literals differ (type-2 clones).
 *
 *   node scripts/dup-scan.mjs [--renamed] [--min-tokens N] [paths...]   (default: src scripts)
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const argv = process.argv.slice(2);
const RENAMED = argv.includes("--renamed");
const minAt = argv.indexOf("--min-tokens");
const MIN_TOKENS = minAt >= 0 ? Number(argv[minAt + 1]) : 50;
const MIN_LINES = 5;
const roots = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--min-tokens");
const files = execFileSync("git", ["ls-files", ...(roots.length ? roots : ["src", "scripts"])], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !f.endsWith(".d.ts") && !/routeTree\.gen|grok-pwa|^server\/|^public\//.test(f));

const tokens = []; // { f, line, t }
const fileStart = new Map();
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, text);
  fileStart.set(f, tokens.length);
  for (let k = scanner.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = scanner.scan()) {
    let t = scanner.getTokenText();
    if (RENAMED && (k === ts.SyntaxKind.Identifier || k === ts.SyntaxKind.NumericLiteral || k === ts.SyntaxKind.StringLiteral)) t = k === ts.SyntaxKind.Identifier ? "$" : "#";
    tokens.push({ f, line: text.slice(0, scanner.getTokenPos()).split("\n").length, t });
  }
}

const windows = new Map();
for (let i = 0; i + MIN_TOKENS <= tokens.length; i++) {
  if (tokens[i].f !== tokens[i + MIN_TOKENS - 1].f) continue;
  let key = "";
  for (let j = i; j < i + MIN_TOKENS; j++) key += tokens[j].t + "\u0001";
  const list = windows.get(key);
  if (list) list.push(i);
  else windows.set(key, [i]);
}

// Chain matching windows along the same diagonal (same offset between the two copies) into maximal runs.
const diag = new Map();
for (const list of windows.values()) {
  if (list.length < 2) continue;
  for (let a = 0; a < list.length && a < 8; a++)
    for (let b = a + 1; b < list.length && b < 8; b++) {
      const [x, y] = [list[a], list[b]];
      if (tokens[x].f === tokens[y].f && y - x < MIN_TOKENS) continue;
      const k = `${x - y}|${tokens[x].f}|${tokens[y].f}`;
      (diag.get(k) ?? diag.set(k, []).get(k)).push(y);
    }
}
const clones = [];
for (const [k, ys] of diag) {
  const off = Number(k.split("|")[0]);
  ys.sort((p, q) => p - q);
  for (let s = 0; s < ys.length; ) {
    let e = s;
    while (e + 1 < ys.length && ys[e + 1] === ys[e] + 1) e++;
    const b0 = ys[s], b1 = ys[e] + MIN_TOKENS - 1, a0 = b0 + off, a1 = b1 + off;
    const lines = tokens[b1].line - tokens[b0].line + 1;
    if (lines >= MIN_LINES) clones.push({ a: `${tokens[a0].f}:${tokens[a0].line}-${tokens[a1].line}`, b: `${tokens[b0].f}:${tokens[b0].line}-${tokens[b1].line}`, lines, toks: b1 - b0 + 1 });
    s = e + 1;
  }
}
clones.sort((p, q) => q.lines - p.lines);
const dupLines = new Map();
for (const c of clones) for (const side of [c.a, c.b]) {
  const [f, r] = side.split(":");
  const [lo, hi] = r.split("-").map(Number);
  const set = dupLines.get(f) ?? dupLines.set(f, new Set()).get(f);
  for (let l = lo; l <= hi; l++) set.add(l);
}
const total = [...dupLines.values()].reduce((n, s) => n + s.size, 0);
const all = files.reduce((n, f) => n + readFileSync(f, "utf8").split("\n").length, 0);
for (const c of clones) console.log(`${String(c.lines).padStart(4)} lines ${String(c.toks).padStart(5)} tok  ${c.a}  ==  ${c.b}`);
console.log(`clones ${clones.length}, duplicated lines ${total} of ${all} (${((100 * total) / all).toFixed(1)}%), files ${files.length}, min ${MIN_TOKENS} tokens/${MIN_LINES} lines${RENAMED ? ", renamed" : ""}`);
