import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
// @ts-expect-error JS plugin alongside the TS vite config
import { grokPwaPlugin } from "./scripts/grok-pwa-plugin.mjs";
// @ts-expect-error JS plugin alongside the TS vite config
import { appEnvPlugin } from "./scripts/app-env-plugin.mjs";
import { isMigrationFile } from "./scripts/migration-plan.mjs";

/** The files `src/lib/db.ts` globs — same directory, same non-recursive scope. */
function hasGlobbedMigrations(root: string): boolean {
  try {
    return readdirSync(join(root, "migrations")).some(isMigrationFile);
  } catch {
    return false;
  }
}

/**
 * Finish PGLite bootstrap during dev-server setup (before traffic). Vite awaits
 * async `configureServer` hooks. Production: `src/lib/db` kicks `ensureDbReady`
 * on import.
 *
 * Vite awaiting the hook puts this on time-to-first-render, so an app with no
 * migrations — no schema to apply — skips it entirely rather than paying for a
 * PGLite instance it never queries.
 */
function pgliteBootstrapPlugin(): Plugin {
  return {
    name: "app-builder:pglite-bootstrap",
    apply: "serve",
    async configureServer(server) {
      if (!hasGlobbedMigrations(server.config.root)) return;
      try {
        const mod = (await server.ssrLoadModule("/src/lib/db.ts")) as {
          ensureDbReady?: () => Promise<void>;
        };
        if (typeof mod.ensureDbReady === "function") {
          await mod.ensureDbReady();
        }
      } catch (err) {
        console.error("[app-builder] DB bootstrap failed:", err);
        throw err;
      }
    },
  };
}

/**
 * Live-preview OAuth popup — handled HERE so the agent never has to create a
 * `/auth/popup` route (and cannot break it by scaffolding a React page that
 * paints the full app shell in the popup).
 *
 * `signIn` (client.ts) opens `/auth/popup?providerId=…` in a top-level window.
 * This middleware runs before TanStack Start, calls `handleAuthPopupRequest`,
 * and returns the 302 / completion HTML. Deployed apps do not use the popup
 * (full-page OAuth redirect), so `apply: "serve"` is enough.
 */
function authPopupPlugin(): Plugin {
  return {
    name: "app-builder:auth-popup",
    apply: "serve",
    configureServer(server) {
      // Register immediately (not in a returned post-hook) so we run BEFORE
      // TanStack Start / the SPA HTML fallback. A model-authored
      // `src/routes/auth/popup.tsx` React page must never win this path.
      server.middlewares.use(async (req, res, next) => {
        try {
          const rawUrl = req.url ?? "";
          const pathOnly = rawUrl.split("?", 1)[0] ?? "";
          if (pathOnly !== "/auth/popup") {
            next();
            return;
          }
          if ((req.method ?? "GET").toUpperCase() !== "GET") {
            res.statusCode = 405;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("Method Not Allowed");
            return;
          }

          const host = String(
            req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost:8080",
          );
          const proto = String(
            req.headers["x-forwarded-proto"] ??
              ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? "https" : "http"),
          );
          const requestHeaders = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (value === undefined) continue;
            if (Array.isArray(value)) {
              for (const v of value) requestHeaders.append(key, v);
            } else {
              requestHeaders.set(key, value);
            }
          }
          // Ensure Host is the public preview host so Better Auth's dynamic
          // baseURL / redirect_uri match the popup origin.
          if (!requestHeaders.has("host")) requestHeaders.set("host", host);

          const request = new Request(`${proto}://${host}${rawUrl}`, {
            method: "GET",
            headers: requestHeaders,
          });

          const mod = (await server.ssrLoadModule("/src/lib/auth/popup.server.ts")) as {
            handleAuthPopupRequest: (req: Request) => Promise<Response>;
          };
          const response = await mod.handleAuthPopupRequest(request);

          res.statusCode = response.status;
          // Preserve multiple Set-Cookie headers (OAuth state + session).
          const setCookies =
            typeof response.headers.getSetCookie === "function"
              ? response.headers.getSetCookie()
              : [];
          response.headers.forEach((value, key) => {
            if (key.toLowerCase() === "set-cookie") return;
            res.setHeader(key, value);
          });
          for (const cookie of setCookies) {
            res.appendHeader("set-cookie", cookie);
          }
          const body = Buffer.from(await response.arrayBuffer());
          res.end(body);
        } catch (err) {
          console.error("[app-builder] /auth/popup handler failed:", err);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "text/plain; charset=utf-8");
            res.end("auth popup failed");
          }
        }
      });
    },
  };
}

/**
 * WSL serves `/mnt/c` over 9p, where inotify never fires (measured: 0 `fs.watch` events for a WSL-side write), so
 * Vite's watcher misses every change there and the page never reloads. Poll the checked-out commit instead (reading
 * two small files: ~4 ms a second; stat-polling the source tree costs ~550 ms per pass over 9p), replay the files each
 * new commit changed as watcher events (Vite invalidates them, and restarts on a config change), then reload the page:
 * a merge is a new build, and hot-swapping the engine module would keep the old engine's state.
 * ponytail: commits only; an uncommitted edit under /mnt still needs a manual reload.
 */
function gitHeadWatchPlugin(): Plugin {
  return {
    name: "crush:git-head-watch",
    apply: "serve",
    configureServer(server) {
      const root = server.config.root;
      const git = join(root, ".git");
      // Only a main checkout on a Windows drive: a worktree's `.git` is a file, and ext4 has working inotify.
      if (process.platform !== "linux" || !root.startsWith("/mnt/") || !existsSync(join(git, "HEAD"))) return;
      const head = (): string | null => {
        try {
          const h = readFileSync(join(git, "HEAD"), "utf8").trim();
          if (!h.startsWith("ref: ")) return h;
          const ref = h.slice(5);
          if (existsSync(join(git, ref))) return readFileSync(join(git, ref), "utf8").trim();
          const packed = readFileSync(join(git, "packed-refs"), "utf8").split("\n");
          return packed.find((l) => l.endsWith(` ${ref}`))?.slice(0, 40) ?? null;
        } catch {
          return null;
        }
      };
      let seen = head();
      const timer = setInterval(() => {
        const now = head();
        if (!now || now === seen) return;
        const from = seen;
        seen = now;
        if (!from) return;
        execFile("git", ["diff", "--name-status", "--no-renames", from, now], { cwd: root }, (err, out) => {
          if (err) return server.config.logger.warn(`[git-head-watch] ${err.message}`);
          let n = 0;
          for (const line of out.split("\n")) {
            const [status, file] = line.split("\t");
            if (!file) continue;
            server.watcher.emit(status === "A" ? "add" : status === "D" ? "unlink" : "change", join(root, file));
            n++;
          }
          server.config.logger.info(`[git-head-watch] ${from.slice(0, 7)} -> ${now.slice(0, 7)}: ${n} files`, { timestamp: true });
          if (n) setTimeout(() => server.ws.send({ type: "full-reload", path: "*" }), 1000);
        });
      }, 1000);
      timer.unref();
      server.httpServer?.on("close", () => clearInterval(timer));
    },
  };
}

// Build-time deploy knobs (docs/DEPLOY.md): APP_BASE serves the app under a
// sub-path ("/crush/"; TanStack Start derives the router basepath from it), and
// NITRO_PRESET picks the server target ("node-server" for self-hosting).
const base = process.env.APP_BASE || "/";
const preset = process.env.NITRO_PRESET || "vercel";

// `0.0.0.0:8080` is the live-preview contract — don't change host/port.
// The dev server starts once `src/router.tsx` and `src/routes/` exist — see
// AGENTS.md § "First scaffold".
export default defineConfig(({ command, isPreview }) => ({
  base,
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  build: {
    // three.js gets its own vendor chunk (596 kB): it changes only on a three upgrade, so it stays cached across
    // game deploys. Measured: engine 760 → 404 kB, routes 430 → 188 kB; total client JS unchanged (1.59 MB).
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: "three", test: /[\\/]node_modules[\\/]three[\\/]/ }] } },
    },
    // Sized for the three chunk alone; every other client chunk is under the 500 kB default.
    chunkSizeWarningLimit: 700,
    // The 2.7 kB skin kernel is under the 4 kB inline limit: Vite would put it in the engine chunk as a data URL.
    // Keep every `.wasm` a file under `<base>assets/` (own cache entry, a fetch that can fail into the JS skin).
    assetsInlineLimit: (file) => (file.endsWith(".wasm") ? false : undefined),
  },
  plugins: [
    pgliteBootstrapPlugin(),
    // Reload on commits/merges where the file watcher is blind (a /mnt checkout under WSL).
    gitHeadWatchPlugin(),
    // Before tanstackStart so /auth/popup never falls through to the SPA.
    authPopupPlugin(),
    // Dev-only /__app-env, read by scripts/check-auth-invariant.mjs.
    appEnvPlugin(),
    // PWA head + ?install=1 tutorial page; runs before Start/Nitro.
    grokPwaPlugin(),
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview
      ? [
          nitro({
            preset,
            baseURL: base,
            // The self-hosted server runs signaling on PGLite (Vercel uses Neon), and
            // PGLite loads its .wasm/.data beside its module: ship the whole package.
            ...(preset === "node-server" ? { traceDeps: ["@electric-sql/pglite*"] } : {}),
            // Auto-registers server/middleware/* (the PWA install page +
            // manifest + head-tag middleware). Nitro v3 defaults serverDir to
            // false, so removing this silently unwires /?install=1 on deploys.
            serverDir: "./server",
          }),
        ]
      : []),
    viteReact(),
  ],
}));
