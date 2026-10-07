#!/usr/bin/env node
// Bakes three's RoomEnvironment to public/env-studio.hdr: a 1024x512 equirect in linear radiance (Radiance RGBE, run-length coded),
// so the softboxes keep their real brightness (peaks near 46 after the exposure match below) instead of the 8-bit jpeg's clip at 1.
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
/** `--width N` (1024, 512, 256): the equirect's width, box-filtered down from the 1024 bake; three's PMREM cube is a quarter of it. `--out FILE`. */
const arg = (name, fallback) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : fallback);
const WIDTH = Number(arg("width", 1024));
const OUT = resolve(arg("out", join(ROOT, "public", "env-studio.hdr")));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

/** Float RGB (w*h*3, rows top to bottom) as an RGBE .hdr: new-style run-length coding, one channel plane per scanline. */
function encodeRgbe(rgb, w, h) {
  const parts = [Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`, "latin1")];
  const planes = [new Uint8Array(w), new Uint8Array(w), new Uint8Array(w), new Uint8Array(w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const r = rgb[i];
      const g = rgb[i + 1];
      const b = rgb[i + 2];
      const max = Math.max(r, g, b);
      if (!(max > 1e-32)) {
        planes[0][x] = planes[1][x] = planes[2][x] = planes[3][x] = 0;
        continue;
      }
      const e = Math.ceil(Math.log2(max + 1e-30)) ;
      let scale = 256 / 2 ** e;
      let exp = e;
      // max / 2^e is in (0.5, 1]; a mantissa of 256 would overflow the byte, so bump the exponent for exact powers of two.
      if (max * scale >= 256) {
        exp = e + 1;
        scale = 256 / 2 ** exp;
      }
      planes[0][x] = Math.floor(r * scale);
      planes[1][x] = Math.floor(g * scale);
      planes[2][x] = Math.floor(b * scale);
      planes[3][x] = exp + 128;
    }
    const line = [2, 2, w >> 8, w & 255];
    for (const p of planes) {
      let x = 0;
      while (x < w) {
        let run = 1;
        while (x + run < w && run < 127 && p[x + run] === p[x]) run++;
        if (run >= 4) {
          line.push(128 + run, p[x]);
          x += run;
          continue;
        }
        const start = x;
        let n = 0;
        while (x < w && n < 128) {
          let r = 1;
          while (x + r < w && r < 4 && p[x + r] === p[x]) r++;
          if (r >= 4) break;
          x++;
          n++;
        }
        line.push(n, ...p.subarray(start, start + n));
      }
    }
    parts.push(Buffer.from(line));
  }
  return Buffer.concat(parts);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const file = resolve(ROOT, `.${url.pathname}`);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 512 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(`http://127.0.0.1:${port}/scripts/bake-env.html`, { waitUntil: "networkidle", timeout: 30000 });
  const baked = await page
    .waitForFunction(() => window.__baked, null, { timeout: 20000 })
    .then((h) => h.jsonValue())
    .catch(() => null);
  if (!baked || typeof baked.b64 !== "string") throw new Error(`bake produced no pixels\n${errors.join("\n")}`);
  const bytes = Buffer.from(baked.b64, "base64");
  const rgb = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  // The scene's ambient and night levels were tuned against the old jpeg, which clipped at 1: scale the radiance so the mean over the
  // sphere (rows weighted by the solid angle they cover, sin of the polar angle) matches that clipped mean. Light stays about where it
  // was; only the highlights above 1 are new.
  let clipped = 0;
  let full = 0;
  let weights = 0;
  let peak = 0;
  for (let y = 0; y < baked.h; y++) {
    const wRow = Math.sin(((y + 0.5) / baked.h) * Math.PI);
    for (let i = y * baked.w * 3; i < (y + 1) * baked.w * 3; i++) {
      clipped += Math.min(rgb[i], 1) * wRow;
      full += rgb[i] * wRow;
      peak = Math.max(peak, rgb[i]);
    }
    weights += wRow * baked.w * 3;
  }
  const k = clipped / full;
  for (let i = 0; i < rgb.length; i++) rgb[i] *= k;
  console.log(`sphere mean clipped ${(clipped / weights).toFixed(4)}, linear ${(full / weights).toFixed(4)}, peak ${peak.toFixed(2)}, scale ${k.toFixed(4)}`);
  const shrink = 1024 / WIDTH;
  const w = baked.w / shrink;
  const h = baked.h / shrink;
  const small = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = 0; dy < shrink; dy++) for (let dx = 0; dx < shrink; dx++) sum += rgb[(((y * shrink + dy) * baked.w) + x * shrink + dx) * 3 + c];
        small[(y * w + x) * 3 + c] = sum / (shrink * shrink);
      }
    }
  }
  const buf = encodeRgbe(small, w, h);
  writeFileSync(OUT, buf);
  console.log(`wrote ${OUT} (${w}x${h}, ${buf.length} bytes)`);
} finally {
  await browser.close();
  server.close();
}
