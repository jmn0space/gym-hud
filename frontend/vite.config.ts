import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Django local settings trust exactly this origin for CSRF/CORS.
const DEV_SERVER_PORT = 5173;
const DEFAULT_API_PROXY_TARGET = "http://127.0.0.1:8000";

/** Rollup input name for the service worker, and the unhashed file it must emit to. */
const SERVICE_WORKER_INPUT = "service-worker";
const SERVICE_WORKER_FILE = "sw.js";

/**
 * Files copied verbatim out of `public/`. Vite never puts them in the bundle, so the
 * precache plugin reads them from disk to hash them.
 */
const PUBLIC_PRECACHE_FILES = [
  "manifest.webmanifest",
  "offline.html",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon-180.png",
];

/** Bundle outputs that make up the app shell. Everything else is fetched on demand. */
const PRECACHED_BUNDLE_EXTENSIONS = [".js", ".css", ".html"];

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Decision D1: Vite hashes the shell's file names, so the service worker has to be
 * told what to precache. This plugin collects the emitted shell assets plus the
 * copied `public/` files and prepends `self.__GYM_HUD_BUILD__` to the `sw.js` chunk.
 *
 * The version is a hash of every precached entry's name and content, never a
 * timestamp: rebuilding identical sources must yield an identical `sw.js`, or the
 * browser would see a "new" worker on every deploy and churn the shell cache.
 */
function serviceWorkerPrecachePlugin(root: string): Plugin {
  return {
    name: "gym-hud:service-worker-precache",
    // Build only: `vite dev` serves modules straight from source, and the shared
    // config is also loaded by Vitest, which must not try to bundle a worker.
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      // Indexed access on the bundle is typed as always-present; it is not.
      const worker = bundle[SERVICE_WORKER_FILE] as (typeof bundle)[string] | undefined;
      if (worker?.type !== "chunk") {
        throw new Error(
          `Expected an emitted "${SERVICE_WORKER_FILE}" chunk to inject the precache manifest into.`,
        );
      }

      const entries = new Map<string, string>();
      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName === SERVICE_WORKER_FILE) {
          // A worker never precaches itself: the browser owns that script's lifecycle.
          continue;
        }
        if (!PRECACHED_BUNDLE_EXTENSIONS.some((extension) => fileName.endsWith(extension))) {
          continue;
        }
        const source: string | Uint8Array = output.type === "chunk" ? output.code : output.source;
        entries.set(`/${fileName}`, sha256(source));
      }

      for (const relativePath of PUBLIC_PRECACHE_FILES) {
        // Missing icons or manifest must fail the build rather than ship a PWA that
        // silently cannot be installed. Run `npm run icons` to regenerate them.
        entries.set(`/${relativePath}`, sha256(readFileSync(join(root, "public", relativePath))));
      }

      const assets = [...entries.keys()].sort((left, right) => (left < right ? -1 : 1));
      // JSON keeps the name/content pairs unambiguous, so no separator can collide.
      const version = sha256(
        JSON.stringify(assets.map((asset) => [asset, entries.get(asset) ?? ""])),
      ).slice(0, 16);

      worker.code = `self.__GYM_HUD_BUILD__=${JSON.stringify({ version, assets })};\n${worker.code}`;
    },
  };
}

export default defineConfig(({ mode }) => {
  const root = import.meta.dirname;
  // API_PROXY_TARGET has no VITE_ prefix, so it never reaches the client bundle.
  const env = loadEnv(mode, root, "");
  const apiProxyTarget = env.API_PROXY_TARGET || DEFAULT_API_PROXY_TARGET;
  const underVitest = process.env.VITEST !== undefined;

  return {
    plugins: underVitest ? [react()] : [react(), serviceWorkerPrecachePlugin(root)],
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, "index.html"),
          [SERVICE_WORKER_INPUT]: resolve(root, "src/sw/service-worker.ts"),
        },
        output: {
          // The service worker must land unhashed at the site root: a hashed name
          // would be a different script every build, so the browser could never
          // update the registered one, and a nested path would narrow its scope.
          entryFileNames: (chunk) =>
            chunk.name === SERVICE_WORKER_INPUT ? SERVICE_WORKER_FILE : "assets/[name]-[hash].js",
        },
      },
    },
    server: {
      port: DEV_SERVER_PORT,
      strictPort: true,
      // Same-origin API requests in development: no CORS, and session cookies just work.
      proxy: {
        "/api": { target: apiProxyTarget, changeOrigin: true },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      restoreMocks: true,
      unstubGlobals: true,
    },
  };
});
