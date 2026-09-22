#!/usr/bin/env node
import { createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "public", "env-studio.jpg");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

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
const browser = await chromium.launch({ args: ["--use-gl=angle", "--ignore-gpu-blocklist"] });
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 512 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await page.goto(`http://127.0.0.1:${port}/scripts/bake-env.html`, { waitUntil: "networkidle", timeout: 30000 });
  const dataUrl = await page
    .waitForFunction(() => window.__baked, null, { timeout: 20000 })
    .then((h) => h.jsonValue())
    .catch(() => null);
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/jpeg")) {
    throw new Error(`bake produced no jpeg\n${errors.join("\n")}`);
  }
  const buf = Buffer.from(dataUrl.split(",")[1], "base64");
  writeFileSync(OUT, buf);
  console.log(`wrote ${OUT} (${buf.length} bytes)`);
} finally {
  await browser.close();
  server.close();
}
