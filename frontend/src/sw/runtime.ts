/**
 * The Gym HUD service-worker runtime.
 *
 * Kept separate from `service-worker.ts` (the build entry) so every branch below can
 * be exercised against a constructed `ServiceWorkerGlobalScope` in jsdom, without
 * ever starting a real worker.
 *
 * Cache strategy (issue #17, decision D2):
 *  - navigations: network-first with a hard timeout, falling back to the precached
 *    `/index.html` shell and, only if that is genuinely absent, `/offline.html`;
 *  - precached shell assets: cache-first, because Vite hashes their file names, so a
 *    given URL is immutable;
 *  - `/api/**`: never cached, never intercepted. Private API data belongs in
 *    IndexedDB behind the login/logout boundary; a Cache API copy would outlive a
 *    logout and leak one account's data into the next session (docs/data-sync.md);
 *  - non-GET and cross-origin requests: never intercepted.
 *
 * Update policy (decision D3): `install` precaches but never calls `skipWaiting()` on
 * its own -- the page decides when it is safe to swap, and says so with a
 * `SKIP_WAITING` message. `activate` claims clients and drops superseded shells.
 */

/** Every cache this worker owns is named `gym-hud-shell-<build version>`. */
export const CACHE_PREFIX = "gym-hud-shell-";
export const SKIP_WAITING_MESSAGE = "SKIP_WAITING";
export const APP_SHELL_PATH = "/index.html";
export const OFFLINE_FALLBACK_PATH = "/offline.html";
/** Long enough for a slow gym-WiFi handshake, short enough not to stall a cold start. */
export const NAVIGATION_TIMEOUT_MS = 3_000;

const API_PREFIX = "/api";
const LAST_RESORT_BODY = "Gym HUD is offline and no cached app shell is available on this device.";

export interface ServiceWorkerBuild {
  /** Content-derived build id; changing it rotates the cache name. */
  readonly version: string;
  /** Absolute, same-origin paths precached on install. */
  readonly assets: readonly string[];
}

/**
 * Used when the build-time injection is missing (an unbuilt worker, or a test that
 * supplies nothing). Precaching still covers the shell and the offline page.
 */
export const DEVELOPMENT_BUILD: ServiceWorkerBuild = { version: "development", assets: [] };

/** Validates the `self.__GYM_HUD_BUILD__` object injected by the Vite plugin. */
export function parseInjectedBuild(value: unknown): ServiceWorkerBuild {
  if (typeof value !== "object" || value === null) {
    return DEVELOPMENT_BUILD;
  }
  const candidate = value as { version?: unknown; assets?: unknown };
  const rawAssets: unknown = candidate.assets;
  if (typeof candidate.version !== "string" || candidate.version.length === 0) {
    return DEVELOPMENT_BUILD;
  }
  if (!Array.isArray(rawAssets)) {
    return DEVELOPMENT_BUILD;
  }
  const assets = (rawAssets as unknown[]).filter(
    (asset): asset is string => typeof asset === "string" && asset.startsWith("/"),
  );
  return { version: candidate.version, assets };
}

/**
 * Opaque, error and partial responses must never reach the Cache API: an opaque
 * response hides its real status (so a captive-portal redirect would be cached as if
 * it were the app), and `cache.put` rejects a 206 outright.
 */
function isStorable(response: Response): boolean {
  return (
    response.ok &&
    response.status !== 206 &&
    response.type !== "opaque" &&
    response.type !== "opaqueredirect" &&
    response.type !== "error"
  );
}

function isApiRequest(pathname: string): boolean {
  return pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
}

/** Wires every lifecycle listener onto `scope`. Called once, by the worker entry. */
export function createServiceWorkerRuntime(
  scope: ServiceWorkerGlobalScope,
  build: ServiceWorkerBuild,
): void {
  const cacheName = `${CACHE_PREFIX}${build.version}`;
  const precachePaths = [...new Set([APP_SHELL_PATH, OFFLINE_FALLBACK_PATH, ...build.assets])];
  const precachedPaths = new Set(precachePaths);

  async function precacheShell(): Promise<void> {
    const cache = await scope.caches.open(cacheName);
    await Promise.all(
      precachePaths.map(async (path) => {
        // `reload` bypasses the HTTP cache so an install can never adopt a stale copy
        // of an asset whose hashed name it is about to treat as immutable.
        const response = await scope.fetch(path, { cache: "reload", credentials: "same-origin" });
        if (!isStorable(response)) {
          throw new Error(`Precaching ${path} failed with status ${response.status.toString()}`);
        }
        await cache.put(path, response);
      }),
    );
  }

  async function dropSupersededCaches(): Promise<void> {
    const keys = await scope.caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== cacheName)
        .map(async (key) => {
          await scope.caches.delete(key);
        }),
    );
  }

  async function cachedShell(): Promise<Response> {
    const cache = await scope.caches.open(cacheName);
    const shell = await cache.match(APP_SHELL_PATH);
    if (shell !== undefined) {
      return shell;
    }
    const offline = await cache.match(OFFLINE_FALLBACK_PATH);
    if (offline !== undefined) {
      return offline;
    }
    return new Response(LAST_RESORT_BODY, {
      status: 503,
      statusText: "Offline",
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  async function handleNavigation(request: Request): Promise<Response> {
    // Without an explicit deadline a cold start on a flaky mobile connection hangs on
    // a socket that never answers instead of falling back to the cached shell.
    const controller = new AbortController();
    const timeout = scope.setTimeout(() => {
      controller.abort();
    }, NAVIGATION_TIMEOUT_MS);
    try {
      const response = await scope.fetch(request, { signal: controller.signal });
      // A navigation request carries `redirect: "manual"`, so a redirect arrives as an
      // opaque redirect the browser still knows how to follow -- pass it straight on.
      if (response.type === "opaqueredirect" || response.ok) {
        return response;
      }
      // A non-OK document (a static host without SPA rewrites, or a server error) is
      // indistinguishable from being offline for a client-routed app: the cached
      // shell can render the route, an error page cannot.
    } catch {
      // Offline, or the navigation timed out.
    } finally {
      scope.clearTimeout(timeout);
    }
    return await cachedShell();
  }

  async function handlePrecachedAsset(request: Request, path: string): Promise<Response> {
    const cache = await scope.caches.open(cacheName);
    const cached = await cache.match(path);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const response = await scope.fetch(request);
      if (isStorable(response)) {
        // Clone before returning: the caller consumes the original body.
        const copy = response.clone();
        void cache.put(path, copy).catch(() => undefined);
      }
      return response;
    } catch {
      return new Response("", {
        status: 504,
        statusText: "Offline",
        headers: { "Cache-Control": "no-store" },
      });
    }
  }

  scope.addEventListener("install", (event) => {
    // Deliberately no `skipWaiting()`: the page owns that decision (D3).
    event.waitUntil(precacheShell());
  });

  scope.addEventListener("activate", (event) => {
    event.waitUntil(
      (async () => {
        await dropSupersededCaches();
        await scope.clients.claim();
      })(),
    );
  });

  scope.addEventListener("message", (event) => {
    const data: unknown = event.data;
    const type =
      typeof data === "object" && data !== null ? (data as { type?: unknown }).type : data;
    if (type === SKIP_WAITING_MESSAGE) {
      void scope.skipWaiting();
    }
  });

  scope.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") {
      return;
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return;
    }
    if (url.origin !== scope.location.origin) {
      return;
    }
    if (isApiRequest(url.pathname)) {
      return;
    }

    // `respondWith` must be called synchronously, before this handler returns, or the
    // browser has already gone to the network by the time a `.then` would run.
    if (request.mode === "navigate") {
      event.respondWith(handleNavigation(request));
      return;
    }
    if (precachedPaths.has(url.pathname)) {
      event.respondWith(handlePrecachedAsset(request, url.pathname));
    }
  });
}
