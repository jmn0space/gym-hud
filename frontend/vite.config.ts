import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Django local settings trust exactly this origin for CSRF/CORS.
const DEV_SERVER_PORT = 5173;
const DEFAULT_API_PROXY_TARGET = "http://127.0.0.1:8000";

/** Rollup input name for the service worker, and the unhashed file it must emit to. */
const SERVICE_WORKER_INPUT = "service-worker";
const SERVICE_WORKER_FILE = "sw.js";
/** The global the plugin injects and `src/sw/service-worker.ts` reads back. */
const BUILD_GLOBAL = "__GYM_HUD_BUILD__";

/**
 * Files copied verbatim out of `public/`. Vite never puts them in the bundle, so the
 * precache plugin reads them from disk to hash them.
 *
 * The list is declared rather than derived so that precaching something large stays a
 * deliberate act -- but `assertPublicPrecacheFilesMatchDisk` fails the build when it
 * and `public/` disagree in *either* direction, so a new file cannot be silently
 * omitted from the offline precache.
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

/** Precaching these two is what makes an offline navigation answerable at all. */
const REQUIRED_PRECACHE_PATHS = ["/index.html", "/offline.html"];

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Every file under `public/`, as `/`-separated paths relative to it. */
function listPublicFiles(directory: string, prefix = ""): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix === "" ? entry.name : posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      return listPublicFiles(join(directory, entry.name), relativePath);
    }
    return entry.isFile() ? [relativePath] : [];
  });
}

/**
 * Bundle outputs are precached from the real Rollup bundle, but `public/` is copied
 * verbatim and has to be listed by hand. Dropping a file in there without updating
 * the list used to build fine and ship a PWA missing that file offline, so a
 * mismatch in either direction fails the build.
 */
function assertPublicPrecacheFilesMatchDisk(root: string): void {
  const onDisk = new Set(listPublicFiles(join(root, "public")));
  const declared = new Set(PUBLIC_PRECACHE_FILES);
  const missingFromList = [...onDisk].filter((file) => !declared.has(file)).sort();
  const missingFromDisk = [...declared].filter((file) => !onDisk.has(file)).sort();
  if (missingFromList.length === 0 && missingFromDisk.length === 0) {
    return;
  }
  throw new Error(
    "PUBLIC_PRECACHE_FILES in vite.config.ts does not match the contents of public/." +
      (missingFromList.length > 0
        ? `\n  In public/ but not precached: ${missingFromList.join(", ")}`
        : "") +
      (missingFromDisk.length > 0
        ? `\n  Precached but not in public/: ${missingFromDisk.join(", ")} (run \`npm run icons\`?)`
        : ""),
  );
}

/**
 * Decision D1: Vite hashes the shell's file names, so the service worker has to be
 * told what to precache. This plugin collects the emitted shell assets plus the
 * copied `public/` files and prepends `self.__GYM_HUD_BUILD__` to the `sw.js` chunk.
 *
 * The version is a hash of every precached entry's name and content *plus the
 * worker's own code*, never a timestamp: rebuilding identical sources must yield an
 * identical `sw.js`, or the browser would see a "new" worker on every deploy and
 * churn the shell cache. Including the worker chunk is what keeps `gym-hud-shell-
 * <version>` unique per *worker* build -- a change confined to the worker's source
 * would otherwise ship a new `sw.js` under the live cache's name, letting an install
 * that then fails delete the cache the active worker is still serving from.
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

      // Missing icons or manifest must fail the build rather than ship a PWA that
      // silently cannot be installed. Run `npm run icons` to regenerate them.
      assertPublicPrecacheFilesMatchDisk(root);
      for (const relativePath of PUBLIC_PRECACHE_FILES) {
        entries.set(`/${relativePath}`, sha256(readFileSync(join(root, "public", relativePath))));
      }

      const assets = [...entries.keys()].sort((left, right) => (left < right ? -1 : 1));
      const missingRequired = REQUIRED_PRECACHE_PATHS.filter((path) => !entries.has(path));
      if (missingRequired.length > 0) {
        // The worker treats an absent manifest as a "development" build that
        // precaches nothing; shipping one would install a PWA with no offline shell.
        throw new Error(
          `The precache manifest is missing ${missingRequired.join(", ")}; the worker would ship without an offline shell.`,
        );
      }
      // JSON keeps the name/content pairs unambiguous, so no separator can collide.
      const version = sha256(
        JSON.stringify({
          worker: sha256(worker.code),
          assets: assets.map((asset) => [asset, entries.get(asset) ?? ""]),
        }),
      ).slice(0, 16);

      if (!worker.code.includes(BUILD_GLOBAL)) {
        // The worker would fall back to its "development" build -- an empty precache
        // list -- and the mistake would only show up as a PWA that does not work
        // offline, long after the deploy.
        throw new Error(
          `The emitted "${SERVICE_WORKER_FILE}" chunk never reads \`self.${BUILD_GLOBAL}\`, so injecting the precache manifest would have no effect.`,
        );
      }
      worker.code = `self.${BUILD_GLOBAL}=${JSON.stringify({ version, assets })};\n${worker.code}`;
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
