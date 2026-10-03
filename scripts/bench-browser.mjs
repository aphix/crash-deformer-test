#!/usr/bin/env node
/**
 * Real-browser frame benchmark for the crash lab.
 *
 *   node scripts/bench-browser.mjs [--url http://127.0.0.1:8080/] [--cars 2,10,16,24,32]
 *     [--modes fleet,derby,race-oval,race-rally,race-city] [--seconds 8] [--warmup 2] [--out bench.json] [--headed] [--vsync]
 *
 * Drives the page through `window.__crush` (the CrashEngine), forces 1× time scale so
 * auto-slomo cannot hide sim cost, and wraps the hot entry points on the live instance:
 *   tick      — whole frame on the main thread (sim + deform + FX + render submit)
 *   physics   — CrashEngine.fixedStep (integration, contacts, structure)
 *   deform    — DeformableCar.updateDeform (cages/skin/normals)
 *   render    — WebGLRenderer.render (CPU-side submit; GPU work is async)
 * Frame interval comes from rAF deltas, uncapped by default (--disable-gpu-vsync,
 * --disable-frame-rate-limit), so fps reflects headroom rather than the display rate.
 *
 * GPU: on WSL either run this file with Windows node (`"/mnt/c/Program Files/nodejs/node.exe"
 * scripts/bench-browser.mjs`) — it then drives the installed Edge/Chrome on native D3D11, the
 * most representative setup — or stay in Linux with GALLIUM_DRIVER=d3d12 so ANGLE/GL reaches
 * the host GPU instead of llvmpipe. The renderer string is printed so a software fallback is
 * visible. Browser: CHROME_PATH overrides; Windows tries Edge then Chrome; Linux uses
 * Playwright's bundled Chromium, falling back to any Chromium in ~/.cache/ms-playwright.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

function parseArgs(argv) {
  const out = {
    url: "http://127.0.0.1:8080/",
    cars: [2, 10, 16, 24, 32],
    modes: ["fleet", "derby"],
    seconds: 8,
    warmup: 2,
    out: null,
    headed: false,
    vsync: false,
    rig: false,
    particles: false,
    profile: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--url") out.url = next();
    else if (a === "--cars") out.cars = next().split(",").map(Number).filter((n) => n > 0);
    else if (a === "--modes") out.modes = next().split(",").filter(Boolean);
    else if (a === "--seconds") out.seconds = Number(next());
    else if (a === "--warmup") out.warmup = Number(next());
    else if (a === "--out") out.out = next();
    else if (a === "--headed") out.headed = true;
    else if (a === "--vsync") out.vsync = true;
    else if (a === "--rig") out.rig = true;
    else if (a === "--particles") out.particles = true;
    else if (a === "--profile") out.profile = next();
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ];
    return candidates.find((p) => existsSync(p));
  }
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return undefined;
  } catch {
    /* fall through to the cache scan */
  }
  const cache = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  for (const d of dirs) {
    for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const p = join(cache, d, sub);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** Runs in the page: wraps hot paths on the live engine and returns a recorder. */
function installProbe() {
  const e = window.__crush;
  if (!e) throw new Error("window.__crush missing — engine did not boot");
  if (window.__bench) return true;
  const acc = { tick: 0, physics: 0, deform: 0, render: 0, frames: 0, intervals: [] };
  let last = 0;
  const wrap = (obj, key, bucket) => {
    const orig = obj[key];
    obj[key] = function (...args) {
      const t0 = performance.now();
      try {
        return orig.apply(this, args);
      } finally {
        acc[bucket] += performance.now() - t0;
      }
    };
  };
  const origTick = e.tickInner;
  e.tickInner = function (now) {
    const t0 = performance.now();
    try {
      return origTick.call(this, now);
    } finally {
      acc.tick += performance.now() - t0;
      acc.frames++;
      if (last > 0) acc.intervals.push(now - last);
      last = now;
    }
  };
  wrap(e, "fixedStep", "physics");
  wrap(e.renderer, "render", "render");
  const proto = Object.getPrototypeOf(e.cars[0]);
  wrap(proto, "updateDeform", "deform");
  window.__bench = {
    reset() {
      acc.tick = acc.physics = acc.deform = acc.render = 0;
      acc.frames = 0;
      acc.intervals = [];
      last = 0;
      e.renderer.info.reset?.();
    },
    read() {
      const iv = acc.intervals.slice().sort((a, b) => a - b);
      const pct = (p) => (iv.length ? iv[Math.min(iv.length - 1, Math.floor(iv.length * p))] : 0);
      const mean = iv.length ? iv.reduce((s, x) => s + x, 0) / iv.length : 0;
      const f = Math.max(acc.frames, 1);
      const info = e.renderer.info;
      return {
        frames: acc.frames,
        fps: mean > 0 ? 1000 / mean : 0,
        frameMs: mean,
        p50Ms: pct(0.5),
        p95Ms: pct(0.95),
        p99Ms: pct(0.99),
        maxMs: iv.length ? iv[iv.length - 1] : 0,
        tickMs: acc.tick / f,
        physicsMs: acc.physics / f,
        deformMs: acc.deform / f,
        renderMs: acc.render / f,
        calls: info.render.calls,
        triangles: info.render.triangles,
        heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null,
        cars: e.cars.length,
        derby: e.derbyMode,
      };
    },
  };
  return true;
}

/** Self time per function from a V8 .cpuprofile, top 25 — names need an unminified (dev) build. */
function printTopSelf(profile, label, file) {
  const dt = new Map();
  const { samples, timeDeltas, nodes } = profile;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (let i = 0; i < samples.length; i++) dt.set(samples[i], (dt.get(samples[i]) ?? 0) + (timeDeltas[i] ?? 0));
  const agg = new Map();
  let total = 0;
  for (const [id, us] of dt) {
    const cf = byId.get(id).callFrame;
    const where = cf.url ? `${cf.url.split("/").pop().split("?")[0]}:${cf.lineNumber + 1}` : "";
    const key = `${cf.functionName || "(anon)"} ${where}`;
    agg.set(key, (agg.get(key) ?? 0) + us);
    total += us;
  }
  const top = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  console.log(`\n  top self time — ${label} (${file})`);
  for (const [k, us] of top) console.log(`  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${(us / 1000).toFixed(0).padStart(6)}ms  ${k}`);
  console.log("");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  // Windows: default ANGLE (D3D11). Linux: ANGLE over GL so Mesa's d3d12/llvmpipe is used.
  const args = ["--ignore-gpu-blocklist", "--enable-gpu"];
  if (process.platform === "linux") args.push("--use-gl=angle", "--use-angle=gl");
  if (!opts.vsync) args.push("--disable-gpu-vsync", "--disable-frame-rate-limit");
  const executablePath = findChromium();
  const browser = await chromium.launch({ headless: !opts.headed, args, executablePath });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(opts.url, { waitUntil: "load", timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__crush), null, { timeout: 90_000 });
  await page.evaluate(() => (window.__crush.fadeScenes = false));
  const gpu = await page.evaluate(() => {
    const gl = window.__crush.renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
  console.log(`url ${opts.url}\ngpu ${gpu}\nchromium ${executablePath ?? "playwright default"}\n`);
  let cdp = null;
  if (opts.profile) {
    mkdirSync(opts.profile, { recursive: true });
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
  }

  const rows = [];
  for (const mode of opts.modes) {
    for (const n of opts.cars) {
      const race = mode.startsWith("race-") ? mode.slice(5) : null;
      await page.evaluate(
        ({ n, mode, race, rig, particles }) => {
          const e = window.__crush;
          if (e.race.active && !race) e.toggleRace();
          if (e.derbyMode && mode !== "derby") e.toggleDerby();
          if (e.showBarrier) e.toggleBarrier();
          if (e.showBalls) e.toggleBalls();
          if (e.showCompactor) e.toggleCompactor();
          if (!e.playing) e.togglePlay();
          if (race) {
            // n racers on the course (the AI drives every car, the player's too), plus the course's traffic.
            if (!e.race.active) e.toggleRace();
            else e.raceCommand({ type: "quit" });
            e.raceCommand({ type: "options", options: { trackId: race, aiCount: n - 1, laps: 5 } });
            e.raceCommand({ type: "start" });
            e.seat.mode = "follow";
          } else {
            e.setCarCount(n);
          }
          if (mode === "derby" && !e.derbyMode) e.toggleDerby();
          if (e.showRig !== rig) e.toggleRig();
          if (typeof e.toggleParticles === "function" && Boolean(e.showParticles) !== particles) e.toggleParticles();
          e.setTimeScale(1);
        },
        { n, mode, race, rig: opts.rig, particles: opts.particles },
      );
      await page.evaluate(installProbe);
      // A race measures from the green light, after the grid and countdown.
      if (race) await page.waitForFunction(() => window.__crush.race.session?.phase === "racing", null, { timeout: 120_000 });
      await page.waitForTimeout(opts.warmup * 1000);
      if (cdp) {
        await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
        await cdp.send("Profiler.start");
      }
      await page.evaluate(() => window.__bench.reset());
      await page.waitForTimeout(opts.seconds * 1000);
      const r = await page.evaluate(() => window.__bench.read());
      if (cdp) {
        const { profile } = await cdp.send("Profiler.stop");
        const file = join(opts.profile, `${mode}-${n}.cpuprofile`);
        writeFileSync(file, JSON.stringify(profile));
        printTopSelf(profile, `${mode} cars=${n}`, file);
      }
      rows.push({ mode, ...r });
      console.log(
        `${mode.padEnd(6)} cars=${String(n).padStart(2)}  fps ${r.fps.toFixed(1).padStart(6)}  frame ${r.frameMs.toFixed(2).padStart(6)}ms  p95 ${r.p95Ms.toFixed(2).padStart(6)}  p99 ${r.p99Ms.toFixed(2).padStart(6)}  max ${r.maxMs.toFixed(1).padStart(6)}  | tick ${r.tickMs.toFixed(2).padStart(6)}  phys ${r.physicsMs.toFixed(2).padStart(6)}  deform ${r.deformMs.toFixed(2).padStart(5)}  render ${r.renderMs.toFixed(2).padStart(5)}  calls ${String(r.calls).padStart(4)}  tris ${String(r.triangles).padStart(7)}`,
      );
    }
  }
  if (errors.length) console.log(`\nconsole errors (${errors.length}):\n  ${errors.slice(0, 8).join("\n  ")}`);
  if (opts.out) writeFileSync(opts.out, JSON.stringify({ url: opts.url, gpu, opts, rows, errors }, null, 2));
  await browser.close();
  if (errors.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
