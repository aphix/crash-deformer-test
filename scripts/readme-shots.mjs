#!/usr/bin/env node
// Regenerates the README's pictures from a served build, at the Ultra FX tier: a webp per scene and the animated crash into
// docs/images/, then the GitHub social card (.github/social-preview.png) from the new hero.
//
//   node scripts/readme-shots.mjs <port|url> [name ...] [--out DIR] [--tmp DIR] [--at S,S,...] [--keep]
//
// `<port|url>` is a served build (`npm run build:node` then `PORT=8130 HOST=127.0.0.1 npm run start:node`; `npm run build` then
// `npm run preview:restart` serves one on 8081; any base path works). No names = every scene, then `slowmo` and `card`.
// Each scene opens the page at `?fx=ultra#<the scene's hash>`, waits for the Ultra look to load and the scene fade to settle, hides the
// HUD (the scenes with `ui` keep it), steps the sim to the scene's moment and screenshots the canvas; ffmpeg then resizes and encodes
// the webp into `--out` (default docs/images). The animation is stepped frame by frame (`advance`), so it does not depend on how fast
// this machine renders.
//   --at 1.2,1.6   no encoding: one still per time (sim seconds after the scene's setup) into --tmp, to find a scene's best moment.
//   --tmp DIR      keep the raw frames there (default: a temp folder, removed after unless --keep).
//   --fx TIER      open every scene at this FX tier instead of ultra (off, minimal, low, high): to see what a lower tier draws.
// Needs Playwright's Chromium and ffmpeg with libwebp. On WSL the GPU is reached through ANGLE over d3d12 (a software renderer is
// too slow for Ultra). The browser is muted. Look at every result: a washed-out or mid-fade frame is re-taken with a different `at`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const STILL_W = 1280;
const WIDE_W = 1600;
const CARD_SIZE = [1280, 640];
const ANIM_W = 720;
const ANIM_FPS = 20;
const ANIM_LEAD_FRAMES = 12;
const ANIM_FRAMES = 64;
const ANIM_MAX_BYTES = 400_000;
const ANIM_QUALITIES = [60, 50, 40, 30, 20];
const WEBP_QUALITY = 82;
const LOAD_MS = 120000;
const SETTLE_MS = 3000;
const STEP_CHUNK_S = 1;
const STEP_WAIT_MS = 60;
const HIDE_UI = "body *:not(canvas){visibility:hidden !important} canvas{visibility:visible !important}";

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: "string" }, tmp: { type: "string" }, at: { type: "string" }, keep: { type: "boolean" }, fx: { type: "string" } },
});
const [target, ...wanted] = positionals;
if (!target) {
  console.error("usage: node scripts/readme-shots.mjs <port|url> [scene ...] [--out DIR] [--tmp DIR] [--at S,S,...] [--keep]");
  process.exit(2);
}
const BASE = /^\d+$/.test(target) ? `http://127.0.0.1:${target}/` : target.replace(/\/?$/, "/");
const OUT = resolve(flags.out ?? join(ROOT, "docs", "images"));
const KEEP = Boolean(flags.keep || flags.tmp || flags.at);
/** The FX tier every scene opens at: Ultra, the README's, unless `--fx` names a lower one (a survey of what each tier draws). */
const FX_TIER = flags.fx ?? "ultra";
const TMP = resolve(flags.tmp ?? mkdtempSync(join(tmpdir(), "readme-shots-")));
const PROBE_AT = flags.at?.split(",").map(Number) ?? null;

const run = (p, fn, arg) => p.evaluate(fn, arg);
/**
 * Sim seconds in steps of at most STEP_CHUNK_S with a short wait between: a race course's art, textures and warm-up finish in
 * tasks that one long synchronous `advance` never lets run, and a shot taken before them has a black sky and stand-in cars.
 */
const stepSim = async (p, seconds, frameDt = 1 / 60) => {
  for (let left = seconds; left > 1e-9; left -= STEP_CHUNK_S) {
    await run(p, ({ step, frameDt }) => window.__crush.advance(step, { frameDt }), { step: Math.min(left, STEP_CHUNK_S), frameDt });
    await p.waitForTimeout(STEP_WAIT_MS);
  }
};
const holdGas = (p) => run(p, () => window.__crush.keys.add("KeyW"));

/** The orbit camera: distance, pitch and angle (rad), framed by hand so the cinematics leave it alone. */
const frame = (p, radius, pitch, angle) =>
  run(
    p,
    ({ radius, pitch, angle }) => {
      const v = window.__crush.view;
      v.userFramed = true;
      v.radius = radius;
      v.pitch = pitch;
      if (angle !== undefined) v.angle = angle;
    },
    { radius, pitch, angle },
  );

/** A race on `track` with a field of eight, its random picks fixed by seed 1: start it and hold the gas. */
const startRace = async (p, track) => {
  await run(p, () => window.__crush.race.reseed(1));
  await run(p, (trackId) => window.__crush.raceCommand({ type: "options", options: { trackId, aiCount: 7 } }), track);
  await run(p, () => window.__crush.raceCommand({ type: "start" }));
  await holdGas(p);
};

/**
 * The scene's run again from its start with `seed` pinned, so the field is the same on every machine (the page's own first run
 * is cut short by the freeze at an unknown moment, and any later reset rolls a new seed).
 */
const restartWithSeed = (p, seed) =>
  run(
    p,
    (seed) => {
      const e = window.__crush;
      e.pinnedSeed = seed;
      try {
        e.reset();
      } finally {
        e.pinnedSeed = null;
      }
    },
    seed,
  );

/** Two cars in a pile-up, paused and framed close, with one debug view on (`toggle`: toggleParticles or toggleRig). */
const debugView = (toggle) => async (p) => {
  await run(p, () => {
    const e = window.__crush;
    for (let i = 0; i < 600 && e.phase === "approach"; i++) e.advance(1 / 60);
    e.advance(2.5);
    e.togglePlay();
  });
  await frame(p, 7, 0.5, 0.8);
  await run(p, (name) => window.__crush[name](), toggle);
  await stepSim(p, 0.8);
};

/** The HUD's Playback and Cars & crash sections open over a night pile-up. */
const hudOpen = async (p) => {
  await stepSim(p, 1.6);
  await frame(p, 15, 0.3, 0.8);
  await stepSim(p, 1.5);
  await p.getByRole("button", { name: /^Playback/ }).click();
  await p.getByRole("button", { name: /^Cars & crash/ }).click();
  await p.waitForTimeout(600);
};

/**
 * The derby runs on its own AI, so no fixed time has a pile-up in it on every machine: step until three cars lie within a few metres
 * of one another (at most a minute), then orbit the car in the middle of them.
 */
const derbyPileUp = async (p) => {
  await run(p, () => {
    const PILE_M = 5;
    const e = window.__crush;
    for (let t = 0; t < 60; t += 0.5) {
      e.advance(0.5);
      const live = e.live();
      const hub = live.find((car) => live.filter((other) => other.group.position.distanceTo(car.group.position) < PILE_M).length >= 3);
      if (hub === undefined) continue;
      e.seat.focus(e.cars.indexOf(hub));
      e.view.spec = null;
      return;
    }
  });
  await frame(p, 14, 0.45, 0.8);
};

/**
 * The race's grid from behind the last car on it (every other car of the field ahead of it in the picture), the HUD hidden. Logs the
 * field's look seed and the grid (car ids, pole first), which `rivalLook` turns into the patterns by name.
 */
const rivalGridView = async (p) => {
  const { look, grid } = await run(p, () => {
    const e = window.__crush;
    const grid = [...e.race.grid];
    e.seat.focus(grid.at(-1));
    return { look: e.race.look, grid };
  });
  console.log("race.look", look, "grid", grid.join(","));
  await frame(p, 13, 0.32, 0);
  await stepSim(p, 0.3);
};

/** Derby car `id` alone: the orbit round it, 6 m off its flank (square to its yaw), low. */
const derbyCloseUp = async (p, id) => {
  const yaw = await run(
    p,
    (id) => {
      const e = window.__crush;
      e.seat.focus(id);
      e.view.spec = null;
      return e.cars[id].yaw;
    },
    id,
  );
  await frame(p, 6, 0.14, yaw + Math.PI / 2);
  await stepSim(p, 0.2);
};

/**
 * One entry per picture. `hash` is the page's shareable `#` (scene, settings, seed: docs/CONTROLS.md) the page opens at; `seed`, when
 * set, restarts the scene with that seed before `setup`, so the field is the same on every run; `size` is the viewport; `setup`
 * runs once the page has settled; `at` is the sim time (s) after `setup` the still is taken; `ui` keeps the HUD in the picture;
 * `wide` encodes at 1600 px instead of the stills' 1280. Every camera that is framed by hand sets its angle, which the live
 * orbit would otherwise have turned by however long the page ran.
 */
const SCENES = {
  hero: {
    size: [1600, 640],
    wide: true,
    hash: "cars=8&smin=26&smax=30&seed=2",
    seed: 2,
    setup: (p) => frame(p, 11, 0.18, 4.5),
    at: 1.2,
  },
  derby: {
    hash: "scene=derby&cars=14&seed=7",
    seed: 7,
    setup: derbyPileUp,
    at: 0.4,
  },
  "race-city": {
    ui: true,
    hash: "scene=race",
    setup: (p) => startRace(p, "city"),
    at: 8,
  },
  "race-stunt": {
    hash: "scene=race",
    setup: (p) => startRace(p, "stunt"),
    at: 7,
  },
  survival: {
    hash: "scene=survival",
    setup: holdGas,
    at: 13,
  },
  press: {
    hash: "scene=press",
    setup: (p) => frame(p, 6.5, 0.45),
    at: 8,
  },
  pistons: {
    hash: "scene=pistons",
    setup: async (p) => {
      await frame(p, 6.5, 0.45);
      await stepSim(p, 1.5);
      await run(p, () => window.__crush.firePiston(8));
    },
    at: 0.5,
  },
  doors: {
    hash: "scene=doors&dkph=40",
    setup: async (p) => {
      await frame(p, 5.2, 0.35);
      await stepSim(p, 0.9);
      await run(p, () => window.__crush.toggleDoorOpen());
      await stepSim(p, 0.9);
      await run(p, () => window.__crush.fireDoorRam("overOpen"));
    },
    at: 0.4,
  },
  corkscrew: {
    hash: "scene=corkscrew&seed=1",
    seed: 1,
    setup: (p) => run(p, () => { window.__crush.seat.focus(0); window.__crush.view.spec = "third"; }),
    at: 0.8,
  },
  night: {
    hash: "night=1&cars=1&smin=20&smax=20&seed=3",
    seed: 3,
    setup: (p) =>
      run(p, () => {
        const e = window.__crush;
        e.seat.focus(0);
        for (const key of ["KeyW", "KeyA", "Space"]) e.keys.add(key);
      }),
    at: 1,
  },
  particles: { hash: "cars=2&smin=22&smax=24&seed=3", seed: 3, setup: debugView("toggleParticles"), at: 0.1 },
  rig: { hash: "cars=2&smin=22&smax=24&seed=3", seed: 3, setup: debugView("toggleRig"), at: 0.1 },
  hud: { ui: true, hash: "cars=5&smin=22&smax=26&seed=2&night=1", seed: 2, setup: hudOpen, at: 0 },
  // The hidden survey scene (docs/CONTROLS.md): shot only when named (`survey`), not one of the README's pictures. W flies the free camera in to the front row.
  showcase: { survey: true, hash: "scene=showcase", setup: holdGas, at: 0.2 },
  // The rows from behind: the free eye flown through them and turned round.
  "showcase-back": {
    survey: true,
    hash: "scene=showcase",
    setup: (p) =>
      run(p, () => {
        const free = window.__crush.view.free;
        free.eye.x -= Math.sin(free.yaw) * 14;
        free.eye.z -= Math.cos(free.yaw) * 14;
        free.yaw += Math.PI;
      }),
    at: 0.1,
  },
  // Every figure knocked over (the showcase's own press: Rapier loaded first, then knock and take) with the Rig debug view on (G): each body's
  // ten part boxes and joints over its drawn mesh, to see that the skin rides its rig, falling (0.3 s) and lying on the ground (2 s and on).
  // The free eye is set 9 m in and tipped down at the front row (no held key, so it stays put whatever `--at`).
  "showcase-rig": {
    survey: true,
    hash: "scene=showcase",
    setup: async (p) => {
      await run(p, () => window.__crush.ragdolls.preload());
      await run(p, () => {
        const e = window.__crush;
        const free = e.view.free;
        free.eye.x -= Math.sin(free.yaw) * 9;
        free.eye.z -= Math.cos(free.yaw) * 9;
        free.pitch = -0.45;
        e.toggleRig();
        for (let slot = 0; slot < 12; slot++) if (e.knockShowcase(slot)) e.showcase.art.take(slot);
      });
    },
    at: 0.3,
  },
  // The rivals' spray (docs/CINEMATIC.md, Rival spray): the grid of a race (`rival-grid`), the same field in round 2 of a campaign (`rival-campaign`:
  // `snap` takes rounds 1 and 2 from the same views, the cars' ids unchanged) and flank close-ups of six derby cars (`rival-close`, one still each).
  "rival-grid": { survey: true, hash: "scene=race", setup: async (p) => { await startRace(p, "city"); await rivalGridView(p); }, at: 0.1 },
  "rival-close": {
    survey: true,
    hash: "scene=derby&cars=14&seed=7",
    seed: 7,
    setup: async (p, snap) => {
      for (const id of [1, 2, 3, 4, 5, 6]) {
        await derbyCloseUp(p, id);
        await snap(`car${id}`);
      }
    },
    at: 0.1,
  },
  "rival-campaign": {
    survey: true,
    hash: "scene=race",
    setup: async (p, snap) => {
      await run(p, () => window.__crush.race.reseed(1));
      await run(p, () => window.__crush.raceCommand({ type: "options", options: { trackId: "city", aiCount: 7, campaign: ["city", "stunt"] } }));
      await run(p, () => window.__crush.raceCommand({ type: "campaign" }));
      await stepSim(p, 2);
      await rivalGridView(p);
      await snap("round1");
      // End the round, read the results, the standings, then the next round's start.
      await run(p, () => window.__crush.raceCommand({ type: "end" }));
      for (let i = 0; i < 2; i++) await run(p, () => window.__crush.raceCommand({ type: "next" }));
      await stepSim(p, 2);
      await rivalGridView(p);
      await snap("round2");
    },
    at: 0.1,
  },
};

/** The crash animation: two cars head-on, the engine's own crash cam (not framed by hand), from just before the hit through the slow-mo. */
const ANIMATION = { out: "crash-slowmo", size: [1440, 576], hash: "cars=2&smin=24&smax=28&seed=1", seed: 1 };

/** Playwright's own Chromium if installed, else the newest cached full Chromium (a revision mismatch after an upgrade). */
function newestChromium() {
  if (existsSync(chromium.executablePath())) return undefined;
  const cache = join(process.env.HOME, ".cache", "ms-playwright");
  const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  return dirs.map((d) => join(cache, d, "chrome-linux64", "chrome")).find(existsSync);
}

function launchOptions() {
  const args = ["--ignore-gpu-blocklist", "--enable-gpu", "--mute-audio"];
  if (process.platform !== "win32") {
    process.env.GALLIUM_DRIVER ??= "d3d12";
    args.push("--use-gl=angle", "--use-angle=gl");
  }
  return { executablePath: process.env.CHROME_PATH ?? newestChromium(), headless: true, args };
}

/** The page open at `hash`, Ultra loaded and the scene fade over, the HUD hidden unless `ui`. Page errors go to `errors`. */
async function open(browser, { size = [1600, 900], hash, ui }, errors) {
  const [width, height] = size;
  const page = await browser.newPage({ viewport: { width, height } });
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(`${BASE}?fx=${FX_TIER}#${hash}`, { waitUntil: "load" });
  await page.waitForFunction((tier) => window.__crush?.cine.tier === tier && !window.__crush.fxLoading, FX_TIER, { timeout: LOAD_MS });
  await page.waitForFunction(() => {
    const fade = window.__crush.sceneFade;
    return fade.pending === null && fade.black === 0 && fade.cel === 0;
  });
  if (!ui) await page.addStyleTag({ content: HIDE_UI });
  await page.waitForTimeout(SETTLE_MS);
  // The live loop would run the sim between this script's steps (a slow screenshot is seconds of sim), so a scene's moment would
  // depend on the machine: from here only `advance` moves time.
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 0;
  });
  await page.waitForTimeout(200);
  return page;
}

function ffmpeg(args) {
  const done = spawnSync("ffmpeg", ["-y", "-loglevel", "error", ...args], { encoding: "utf8" });
  if (done.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}\n${done.stderr}`);
}

async function shootScene(browser, name, errors) {
  const scene = SCENES[name];
  const page = await open(browser, scene, errors);
  if (scene.seed !== undefined) await restartWithSeed(page, scene.seed);
  // A setup may take stills of its own along the way (`snap(label)`: a png `<name>-<label>.png` in --out, full size).
  const extras = [];
  await scene.setup(page, async (label) => {
    const file = join(OUT, `${name}-${label}.png`);
    await page.screenshot({ path: file });
    extras.push(file);
  });
  const times = PROBE_AT ?? [scene.at];
  let now = 0;
  const pngs = [];
  for (const t of times) {
    await stepSim(page, t - now);
    now = t;
    const png = join(TMP, PROBE_AT ? `${name}-${t}.png` : `${name}.png`);
    await page.screenshot({ path: png });
    pngs.push(png);
  }
  await page.close();
  if (PROBE_AT) return pngs;
  const file = join(OUT, `${name}.webp`);
  ffmpeg(["-i", pngs[0], "-vf", `scale=${scene.wide ? WIDE_W : STILL_W}:-2:flags=lanczos`, "-c:v", "libwebp", "-quality", String(WEBP_QUALITY), file]);
  return [file, ...extras];
}

async function shootAnimation(browser, errors) {
  const page = await open(browser, ANIMATION, errors);
  await restartWithSeed(page, ANIMATION.seed);
  const dir = mkdtempSync(join(TMP, "anim-"));
  await stepSim(page, ANIM_LEAD_FRAMES / ANIM_FPS, 1 / ANIM_FPS);
  for (let i = 0; i < ANIM_FRAMES; i++) {
    await run(page, (dt) => window.__crush.advance(dt, { frameDt: dt, render: true }), 1 / ANIM_FPS);
    await page.screenshot({ path: join(dir, `f${String(i).padStart(3, "0")}.png`) });
  }
  await page.close();
  const file = join(OUT, `${ANIMATION.out}.webp`);
  for (const quality of ANIM_QUALITIES) {
    ffmpeg(["-framerate", String(ANIM_FPS), "-i", join(dir, "f%03d.png"), "-vf", `scale=${ANIM_W}:-2:flags=lanczos`, "-c:v", "libwebp_anim", "-quality", String(quality), "-loop", "0", file]);
    if (statSync(file).size <= ANIM_MAX_BYTES) return [file];
  }
  throw new Error(`${file} is over ${ANIM_MAX_BYTES} bytes at the lowest quality ${ANIM_QUALITIES.at(-1)}`);
}

/** The GitHub social preview from the new hero (`scripts/social-card.html`), so it runs after `hero`. */
async function shootCard(browser) {
  const page = await browser.newPage({ viewport: { width: CARD_SIZE[0], height: CARD_SIZE[1] } });
  await page.goto(pathToFileURL(join(ROOT, "scripts", "social-card.html")).href, { waitUntil: "load" });
  await page.waitForFunction(() => [...document.images].every((img) => img.complete));
  const file = join(ROOT, ".github", "social-preview.png");
  await page.screenshot({ path: file });
  await page.close();
  return [file];
}

const SHOOTERS = {
  slowmo: shootAnimation,
  card: shootCard,
};

mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });
const errors = [];
const browser = await chromium.launch(launchOptions());
try {
  const names = wanted.length ? wanted : [...Object.keys(SCENES).filter((name) => !SCENES[name].survey), "slowmo", "card"];
  for (const name of names) {
    if (!SCENES[name] && !SHOOTERS[name]) throw new Error(`unknown picture ${name}; known: ${[...Object.keys(SCENES), ...Object.keys(SHOOTERS)].join(", ")}`);
    const files = SHOOTERS[name] ? await SHOOTERS[name](browser, errors) : await shootScene(browser, name, errors);
    for (const file of files) console.log(`${name}: ${file} (${statSync(file).size} bytes)`);
  }
} finally {
  await browser.close();
}
console.log(errors.length ? `page errors:\n${errors.slice(0, 5).join("\n")}` : "no page errors");
if (KEEP) console.log(`frames kept in ${TMP}`);
else rmSync(TMP, { recursive: true, force: true });
