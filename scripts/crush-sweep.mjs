#!/usr/bin/env node
// Squash × buckle sweep over the headless crash harness, scored against the
// real-car targets in docs/RIG_ANALYSIS.md §2-§3.3 and barrier.test.ts.
//
//   npm run sweep -- [--grid 0,0.2,0.4,0.6,0.8,1] [--cells 0.4:0.45,1:1] [--slomo]
//                    [--scenarios wall56,side50] [--after 1.5] [--root <tree>] [--out <dir>]
//
// `--grid` sets both axes; `--cells s:b,…` runs only those pairs. `--slomo` runs
// every scenario through the engine's impact slow-motion. `--after` is the sim
// seconds kept after first contact. `--root` imports the harness from another
// checkout (e.g. a scratch tree with a fix).
// Writes <out>/sweep.json and <out>/sweep.md and prints the markdown.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    grid: { type: "string", default: "0,0.2,0.4,0.6,0.8,1" },
    cells: { type: "string" },
    scenarios: { type: "string" },
    root: { type: "string", default: resolve(here, "..") },
    out: { type: "string", default: resolve(here, "../.bench/crush-sweep") },
    after: { type: "string", default: "1.5" },
    slomo: { type: "boolean", default: false },
  },
});

// test-support's paint() passes undefined texture maps; three warns once per car.
const warn = console.warn;
console.warn = (...a) => {
  if (!String(a[0]).startsWith("THREE.Material: parameter")) warn(...a);
};

const harness = await import(pathToFileURL(resolve(args.root, "src/game/contact/crash-scenarios.test-util.ts")).href);
const { runWall, runPair } = harness;
const { INITIAL_HUD } = await import(pathToFileURL(resolve(args.root, "src/game/hud/hud-store.ts")).href);

/** The tree's default HUD pair — always run and marked in every table. */
const DEFAULT = [INITIAL_HUD.squash, INITIAL_HUD.buckle];

const nose = (r) => (r.noseShortL + r.noseShortR) / 2;
const noseMax = (r) => Math.max(r.noseShortL, r.noseShortR);
const both = (rs, f) => (f(rs[0]) + f(rs[1])) / 2;

// band: [lo, hi] (null = open side); bool: expected value. w = weight.
const SCENARIOS = {
  wall35: {
    run: (o) => [runWall(35, 1, "front", o)],
    key: ["nose", (rs) => nose(rs[0])],
    targets: [
      ["nose permanent m (∝v from 56)", (rs) => nose(rs[0]), [0.15, 0.31], 2],
      ["pulse ms", (rs) => rs[0].pulseMs, [60, 150], 1],
      ["avg g (∝v from 56)", (rs) => rs[0].avgG, [11, 16], 1],
      ["cabin m", (rs) => rs[0].cabinIntrusion, [null, 0.06], 2],
      ["drivetrain alive", (rs) => rs[0].drivetrainAlive, true, 1],
    ],
  },
  wall56: {
    run: (o) => [runWall(56, 1, "front", o)],
    key: ["nose", (rs) => nose(rs[0])],
    targets: [
      ["nose permanent m", (rs) => nose(rs[0]), [0.25, 0.5], 2],
      ["COM travel m", (rs) => rs[0].comTravel, [0.35, 0.6], 1],
      ["pulse ms", (rs) => rs[0].pulseMs, [60, 150], 1],
      ["avg g", (rs) => rs[0].avgG, [18, 25], 1],
      ["cabin m", (rs) => rs[0].cabinIntrusion, [null, 0.06], 2],
      ["centre past face m", (rs) => rs[0].maxCentrePastFace, [null, 0.05], 1],
    ],
  },
  wall64: {
    run: (o) => [runWall(64, 1, "front", o)],
    key: ["nose", (rs) => nose(rs[0])],
    targets: [
      ["nose permanent m (∝v from 56)", (rs) => nose(rs[0]), [0.29, 0.57], 2],
      ["pulse ms", (rs) => rs[0].pulseMs, [60, 150], 1],
      ["avg g (∝v from 56)", (rs) => rs[0].avgG, [20.5, 28.5], 1],
      ["cabin m", (rs) => rs[0].cabinIntrusion, [null, 0.08], 1],
      ["drivetrain alive", (rs) => rs[0].drivetrainAlive, false, 1],
    ],
  },
  offset64: {
    run: (o) => [runWall(64, 0.4, "front", o)],
    key: ["struck nose", (rs) => noseMax(rs[0])],
    targets: [
      ["struck-side nose m", (rs) => noseMax(rs[0]), [0.3, 0.6], 2],
      ["cabin m", (rs) => rs[0].cabinIntrusion, [null, 0.15], 1],
      ["centre past face m", (rs) => rs[0].maxCentrePastFace, [null, 0.05], 1],
    ],
  },
  wall50: {
    run: (o) => [runWall(50, 1, "front", o)],
    key: ["nose", (rs) => nose(rs[0])],
    targets: [["nose permanent m (∝v from 56)", (rs) => nose(rs[0]), [0.22, 0.45], 1]],
  },
  rear50: {
    run: (o) => [runWall(50, 1, "rear", o)],
    key: ["tail", (rs) => rs[0].tailShort],
    targets: [
      ["tail permanent m", (rs) => rs[0].tailShort, [0.15, 0.4], 2],
      // barrier.test.ts: the tail is softer with a shorter stroke, 0.6–1.0× the 50 km/h nose (worse corner).
      ["tail / wall50 nose", (rs, done) => (done.wall50 ? rs[0].tailShort / Math.max(1e-3, noseMax(done.wall50[0])) : null), [0.6, 1], 2],
      ["nose m", (rs) => noseMax(rs[0]), [null, 0.03], 1],
      ["cabin m", (rs) => rs[0].cabinIntrusion, [null, 0.06], 1],
    ],
  },
  side50: {
    run: (o) => [runWall(50, 1, "side", o)],
    key: ["doorL", (rs) => rs[0].doorMaxL],
    targets: [
      ["door m", (rs) => rs[0].doorMaxL, [0.12, 0.28], 2],
      ["ends m", (rs) => Math.max(noseMax(rs[0]), rs[0].tailShort), [null, 0.1], 1],
      ["cell shift m", (rs) => rs[0].cellShift, [null, 0.12], 1],
    ],
  },
  headon28: {
    run: (o) => runPair(28, 28, "head-on", o),
    key: ["nose", (rs) => both(rs, nose)],
    targets: [
      ["nose permanent m (≈ 28 wall)", (rs) => both(rs, nose), [0.12, 0.26], 2],
      ["cabin m", (rs) => Math.max(rs[0].cabinIntrusion, rs[1].cabinIntrusion), [null, 0.06], 1],
      ["hubs popped", (rs) => rs[0].hubsPopped.length + rs[1].hubsPopped.length, [null, 0], 1],
      ["drivetrain alive", (rs) => rs[0].drivetrainAlive && rs[1].drivetrainAlive, true, 1],
    ],
  },
  headon56: {
    run: (o) => runPair(56, 56, "head-on", o),
    key: ["nose", (rs) => both(rs, nose)],
    targets: [
      ["nose permanent m (≈ 56 wall)", (rs) => both(rs, nose), [0.25, 0.5], 2],
      ["pulse ms", (rs) => rs[0].pulseMs, [60, 150], 1],
      ["cabin m", (rs) => Math.max(rs[0].cabinIntrusion, rs[1].cabinIntrusion), [null, 0.08], 1],
    ],
  },
  tbone50: {
    run: (o) => runPair(0, 50, "t-bone", o),
    key: ["struck doorR", (rs) => rs[0].doorMaxR],
    targets: [
      ["struck door m", (rs) => rs[0].doorMaxR, [0.12, 0.28], 2],
      ["bullet nose m (estimate)", (rs) => noseMax(rs[1]), [0.08, 0.3], 1],
    ],
  },
};

/** Normalised miss: 0 in band, band widths outside (one-sided: share of the limit), capped at 2. */
function miss(v, want) {
  if (typeof want === "boolean") return v === want ? 0 : 1;
  const [lo, hi] = want;
  const width = lo !== null && hi !== null ? hi - lo : Math.max(Math.abs(lo ?? hi), 0.02);
  const out = Math.max(0, lo !== null ? lo - v : 0, hi !== null ? v - hi : 0);
  return Math.min(2, out / width);
}

/** Distance from the middle of a two-sided band in half-widths, capped at 2; null for other targets. */
function offCentre(v, want) {
  if (typeof want === "boolean" || want[0] === null || want[1] === null) return null;
  const half = (want[1] - want[0]) / 2;
  return Math.min(2, Math.abs(v - (want[0] + half)) / half);
}

// streamed-deform.ts update()/the skin pass: wrinkleAmp = clamp(crush·(0.2+0.5b), 0, 0.18+0.5b);
// skin fold amplitude at the hit = wrinkle·0.16·(0.35+0.65b)·|(1, 0.28, ≤0.06)|, capped at 0.03+0.08b,
// and only drawn while wrinkle > 0.02. Visual only: no physics reads it.
function wrinkle(crush, b) {
  const amp = Math.min(Math.max(crush * (0.2 + 0.5 * b), 0), 0.18 + 0.5 * b);
  const skin = amp > 0.02 ? Math.min(0.03 + 0.08 * b, amp * 0.16 * (0.35 + 0.65 * b) * Math.hypot(1, 0.28, 0.06)) : 0;
  return { amp, skin };
}

const isDefault = (s, b) => s === DEFAULT[0] && b === DEFAULT[1];
const axis = args.grid.split(",").map(Number);
const gridCells = axis.flatMap((s) => axis.map((b) => [s, b]));
// The default pair always runs so its detail table exists, even off the grid.
const cells = args.cells
  ? args.cells.split(",").map((c) => c.split(":").map(Number))
  : gridCells.some(([s, b]) => isDefault(s, b)) ? gridCells : [...gridCells, DEFAULT];
const names = args.scenarios ? args.scenarios.split(",") : Object.keys(SCENARIOS);
for (const n of names) if (!SCENARIOS[n]) throw new Error(`unknown scenario ${n}; have ${Object.keys(SCENARIOS).join(",")}`);
for (const c of cells) if (c.length !== 2 || c.some((x) => !Number.isFinite(x))) throw new Error(`bad cell ${c.join(":")}`);

const t0 = performance.now();
const rows = [];
for (const [squash, buckle] of cells) {
  const row = { squash, buckle, score: 0, centre: 0, misses: 0, drift: 0, spinFrames: 0, scenarios: {} };
  const done = {};
  let wsum = 0;
  let csum = 0;
  for (const n of names) {
    const sc = SCENARIOS[n];
    const rs = sc.run({ squash, buckle, after: Number(args.after), slomo: args.slomo });
    done[n] = rs;
    const metrics = [];
    for (const [label, get, want, w] of sc.targets) {
      const v = get(rs, done);
      if (v === null) continue;
      const d = miss(v, want);
      row.score += w * d;
      wsum += w;
      if (d > 0) row.misses++;
      const c = offCentre(v, want);
      if (c !== null) {
        row.centre += w * c;
        csum += w;
      }
      metrics.push({ label, value: v, want, w, miss: d });
    }
    const drift = Math.max(...rs.map((r) => r.quietYawDrift));
    const spin = rs.reduce((a, r) => a + r.spinFrames, 0);
    row.drift = Math.max(row.drift, drift);
    row.spinFrames += spin;
    row.scenarios[n] = {
      key: sc.key[1](rs),
      metrics,
      drift,
      spinFrames: spin,
      wrinkle: wrinkle(Math.max(...rs.map((r) => r.crushMax)), buckle),
      results: rs,
    };
  }
  row.score /= wsum;
  row.centre /= Math.max(1, csum);
  rows.push(row);
  process.stderr.write(`squash ${squash} buckle ${buckle}: score ${row.score.toFixed(3)} centre ${row.centre.toFixed(3)} misses ${row.misses} drift ${row.drift.toFixed(2)} rad spin ${row.spinFrames}\n`);
}
const seconds = (performance.now() - t0) / 1000;

const f = (x, d = 2) => (typeof x === "boolean" ? (x ? "yes" : "no") : x.toFixed(d));
const sAxis = args.cells ? [...new Set(cells.map((c) => c[0]))] : axis;
const bAxis = args.cells ? [...new Set(cells.map((c) => c[1]))] : axis;
const at = (s, b) => rows.find((r) => r.squash === s && r.buckle === b);
function grid(title, cell) {
  const lines = [`**${title}** (rows squash, columns buckle)`, "", `| squash \\ buckle | ${bAxis.join(" | ")} |`, `|---|${bAxis.map(() => "---").join("|")}|`];
  for (const s of sAxis) lines.push(`| ${s} | ${bAxis.map((b) => (at(s, b) ? cell(at(s, b)) : "")).join(" | ")} |`);
  return lines.join("\n");
}
const sparse = Boolean(args.cells);
const DRIFT_FLAG = 0.5;
const flag = (r) => (r.drift > DRIFT_FLAG || r.spinFrames > 0 ? " ⟳" : "");

const md = [
  `Sweep: ${rows.length} cells × ${names.length} scenarios${args.slomo ? " (slomo)" : ""} in ${seconds.toFixed(1)} s, harness ${args.root}.`,
  `Score = weighted mean of normalised misses (0 = every target in band, capped at 2 per metric). Centre = weighted mean distance from the middle of the two-sided bands in half-widths (0 = every such metric mid-band, 1 = on an edge, capped at 2): the tie-break inside the in-band region. ⟳ = quiet-phase yaw drift > ${DRIFT_FLAG} rad or any frame at the ±6 rad/s spin clamp.`,
  "",
];
if (sparse) {
  md.push(`| squash | buckle | score | centre | misses | drift rad | spin frames | ${names.join(" | ")} |`, `|---|---|---|---|---|---|---|${names.map(() => "---").join("|")}|`);
  for (const r of rows) md.push(`| ${r.squash} | ${r.buckle} | ${f(r.score, 3)} | ${f(r.centre, 3)} | ${r.misses} | ${f(r.drift)} | ${r.spinFrames} | ${names.map((n) => f(r.scenarios[n].key)).join(" | ")} |`);
} else {
  md.push(grid("Realism score (lower is better)", (r) => `${isDefault(r.squash, r.buckle) ? "**" : ""}${f(r.score, 3)}${isDefault(r.squash, r.buckle) ? "**" : ""}${flag(r)}`), "");
  md.push(grid("Band centring (lower is better)", (r) => f(r.centre, 3)), "");
  md.push(grid("Targets missed", (r) => String(r.misses)), "");
  md.push(grid("Max quiet-phase yaw drift rad / spin-clamp frames", (r) => `${f(r.drift)} / ${r.spinFrames}`), "");
  for (const n of names) md.push(grid(`${n}: ${SCENARIOS[n].key[0]} (m)`, (r) => f(r.scenarios[n].key)), "");
  const vis = names.includes("wall56") ? "wall56" : names[0];
  md.push(grid(`Visual only — ${vis} wrinkle amp / skin fold at the hit (m)`, (r) => `${f(r.scenarios[vis].wrinkle.amp)} / ${f(r.scenarios[vis].wrinkle.skin, 3)}`), "");
}
md.push("", "Per-metric detail (value, ✗ = out of band) for each cell is in sweep.json.");
for (const r of rows.filter((x) => isDefault(x.squash, x.buckle) || (x.squash === 1 && x.buckle === 1) || x === rows.reduce((a, y) => (y.score < a.score ? y : a)))) {
  md.push("", `**Cell squash ${r.squash} / buckle ${r.buckle}** — score ${f(r.score, 3)}`, "", "| scenario | metric | value | target | |", "|---|---|---|---|---|");
  for (const n of names) {
    for (const m of r.scenarios[n].metrics) {
      const want = typeof m.want === "boolean" ? String(m.want) : `${m.want[0] ?? "…"}–${m.want[1] ?? "…"}`;
      md.push(`| ${n} | ${m.label} | ${f(m.value)} | ${want} | ${m.miss > 0 ? "✗" : ""} |`);
    }
  }
}
const text = md.join("\n");
mkdirSync(args.out, { recursive: true });
writeFileSync(resolve(args.out, "sweep.json"), JSON.stringify({ root: args.root, seconds, scenarios: names, rows }, null, 1));
writeFileSync(resolve(args.out, "sweep.md"), text + "\n");
console.log(text);
