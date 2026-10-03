#!/usr/bin/env node
/**
 * Program warm-up guard. A GPU program linked mid-play stalls its frame 50–800 ms, so the engine links every
 * program it can reach before its loop starts (`CrashEngine.ready`) and warms new scene content (a race
 * course, new cars) in the menu that loads it. This boots the game in headless Chromium, waits for that
 * warm-up, then plays through everything that can need a new program: a fast fleet crash (sparks, debris,
 * smoke, cracked glass, tyre marks), a boost launch and handbrake drift, night and wet, every FX tier, every
 * scene (derby, pistons fired, door ram, compactor, barrier, balls), the debug views, and a race on every
 * course (8 cars, the city's traffic). It fails if the renderer holds more programs after the sandbox play
 * than right after warm-up, or if any program links between a race's green light and its end of play.
 * Counts, not timings, so it is deterministic.
 *
 *   node scripts/check-programs.mjs [--url http://127.0.0.1:8080/]
 *
 * Needs a running dev or preview server. CHROME_PATH picks the browser; on Linux it renders through ANGLE/GL
 * like scripts/bench-browser.mjs.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const urlArg = process.argv.indexOf("--url");
const url = urlArg > 0 ? process.argv[urlArg + 1] : "http://127.0.0.1:8080/";

/** Playwright's own build if installed, else the newest cached Chromium (revision mismatch after upgrades). */
function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) return undefined;
  const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  return dirs.map((d) => join(cache, d, "chrome-linux64", "chrome")).find(existsSync);
}

const args = ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"];
if (process.platform === "linux") args.push("--use-gl=angle", "--use-angle=gl");
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});

const run = (body) => page.evaluate((b) => new Function("e", b)(window.__crush), body);
const wait = (s) => page.waitForTimeout(s * 1000);
/** Every program the renderer holds, keyed by its cache key, with the material type that built it. */
const programs = () =>
  page.evaluate(() => (window.__crush.renderer.info.programs ?? []).map((p) => ({ type: p.type, key: String(p.cacheKey) })));

try {
  await page.goto(url, { waitUntil: "load", timeout: 120_000 });
  await page.waitForFunction(() => Boolean(window.__crush), null, { timeout: 120_000 });
  await page.evaluate(() => window.__crush.ready);
  await page.evaluate(() => (window.__crush.fadeScenes = false));
  const warm = await programs();

  console.log("- fast fleet crash");
  await run("e.setSpeedRange(30, 45); e.setCarCount(12)");
  await wait(12);
  const broken = await run("return e.cars.flatMap((c) => c.snapshot().glass).filter((s) => s !== 'intact').length");
  console.log(`  ${broken} panes cracked or shattered (0 = the cracked-glass variant went unexercised)`);
  console.log("- drive: boost launch, handbrake drift");
  await run("e.setCarCount(4); e.seat.focus(0)");
  await wait(1);
  for (const keys of [["KeyW", "ShiftLeft"], ["KeyW", "KeyA", "Space"]]) {
    for (const k of keys) await page.keyboard.down(k);
    await wait(2.5);
    for (const k of keys) await page.keyboard.up(k);
  }
  const more = [
    ["leave the car", "e.seat.esc(); e.seat.esc()", 0.5],
    ["night", "e.setNight(true)", 1.5],
    ["wet", "e.setWet(true)", 1.5],
    ["day, dry", "e.setNight(false); e.setWet(false)", 1],
    ...["low", "off", "high", "minimal"].map((t) => [`fx ${t}`, `e.setFxTier("${t}")`, 1.5]),
    ["derby", "e.toggleDerby()", 6],
    ["derby off", "e.toggleDerby()", 1],
    ["pistons, fire all", "e.togglePistons(); e.firePiston(8)", 4],
    ["pistons off", "e.togglePistons()", 1],
    ["door ram", "e.toggleDoors(); e.fireDoorRam('shut')", 3],
    ["doors off", "e.toggleDoors()", 1],
    ["compactor", "e.toggleCompactor()", 8],
    ["compactor off", "e.toggleCompactor()", 1],
    ["barrier", "e.toggleBarrier()", 6],
    ["barrier off", "e.toggleBarrier()", 1],
    ["balls", "e.toggleBalls()", 6],
    ["balls off", "e.toggleBalls()", 1],
    ["debug views", "e.toggleRig(); e.toggleParticles()", 1],
    ["debug views off", "e.toggleRig(); e.toggleParticles()", 0.5],
  ];
  for (const [label, body, s] of more) {
    console.log(`- ${label}`);
    await run(body);
    await wait(s);
  }

  const after = await programs();
  const known = new Set(warm.map((p) => p.key));
  const late = after.filter((p) => !known.has(p.key));
  console.log(`programs after warm-up: ${warm.length}, after play: ${after.length}`);
  for (const p of late) console.log(`  linked mid-play: ${p.type} …${p.key.slice(-80).replace(/\s+/g, " ")}`);

  // Race: each course loads in the setup menu (its warm-up runs there and in the countdown); nothing may link once racing.
  await run("e.toggleRace()");
  for (const id of await run("return e.race.courses.map((c) => c.id)")) {
    await run(`e.raceCommand({ type: "options", options: { trackId: "${id}", aiCount: 7, laps: 9 } }); e.raceCommand({ type: "start" })`);
    await page.waitForFunction(() => window.__crush.race.hud().phase === "racing", null, { timeout: 60_000 });
    const green = new Set((await programs()).map((p) => p.key));
    // The player car rides the AI's racing line (out of drive mode the brain steers it) for 12 s.
    for (let t = 0; t < 12; t++) {
      await run("if (e.seat.mode === 'drive') e.seat.mode = 'follow'");
      await wait(1);
    }
    const raced = (await programs()).filter((p) => !green.has(p.key));
    console.log(`- race ${id}: ${green.size} programs at the green light, ${raced.length} linked while racing`);
    for (const p of raced) console.log(`  linked mid-race: ${p.type} …${p.key.slice(-80).replace(/\s+/g, " ")}`);
    late.push(...raced);
    await run(`e.raceCommand({ type: "end" }); e.raceCommand({ type: "quit" })`);
  }
  await run("e.toggleRace()");

  if (errors.length) console.log(`console errors:\n  ${errors.slice(0, 8).join("\n  ")}`);
  process.exitCode = late.length || errors.length ? 1 : 0;
} finally {
  await browser.close();
}
