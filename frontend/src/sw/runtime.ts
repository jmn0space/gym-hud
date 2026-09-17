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

/**
 * Cache Storage is allowed to throw on a read, not only on a write --
 * QuotaExceededError, a Safari private-mode SecurityError, or storage
 * eviction/corruption can all surface on `caches.open` or `cache.match`.
 * `cachedShell()` is the documented last resort that must always resolve to
 * *something*, and `handlePrecachedAsset()` hits this on every JS/CSS request, so
 * both go through these two wrappers instead of touching `caches`/`Cache`
 * directly: a Cache Storage failure resolves to `undefined` here, never a
 * rejection, keeping the fallback chain genuinely unconditional.
 */
async function openCacheSafely(
  cacheStorage: CacheStorage,
  name: string,
): Promise<Cache | undefined> {
  try {
    return await cacheStorage.open(name);
  } catch {
    return undefined;
  }
}

async function matchCacheSafely(
  cache: Cache | undefined,
  path: string,
): Promise<Response | undefined> {
  if (cache === undefined) {
    return undefined;
  }
  try {
    return await cache.match(path);
  } catch {
    return undefined;
  }
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
    try {
      await Promise.all(
        precachePaths.map(async (path) => {
          // `reload` bypasses the HTTP cache so an install can never adopt a stale
          // copy of an asset whose hashed name it is about to treat as immutable.
          const response = await scope.fetch(path, {
            cache: "reload",
            credentials: "same-origin",
          });
          if (!isStorable(response)) {
            throw new Error(`Precaching ${path} failed with status ${response.status.toString()}`);
          }
          await cache.put(path, response);
        }),
      );
    } catch (error: unknown) {
      // `Promise.all` does not cancel the other in-flight puts just because one
      // asset failed, so this doomed, version-named cache can still hold a partial
      // copy of the shell. A failed install never activates (D3), so this is not a
      // serving hazard, but leaving it behind accumulates garbage across repeated
      // failed deploys. Best-effort: the original precaching failure is what must
      // propagate, even if this cleanup itself fails.
      await scope.caches.delete(cacheName).catch(() => undefined);
      throw error;
    }
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
    const cache = await openCacheSafely(scope.caches, cacheName);
    const shell = await matchCacheSafely(cache, APP_SHELL_PATH);
    if (shell !== undefined) {
      return shell;
    }
    const offline = await matchCacheSafely(cache, OFFLINE_FALLBACK_PATH);
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
    const cache = await openCacheSafely(scope.caches, cacheName);
    const cached = await matchCacheSafely(cache, path);
    if (cached !== undefined) {
      return cached;
    }
    // Same timeout discipline as `handleNavigation`: a cache miss here is realistic
    // after Cache Storage eviction under storage pressure, not just when offline, so
    // a dead socket on the network fallback must not leave this fetch event hanging
    // forever -- the 504 below has to be reachable even when the network never
    // answers at all.
    const controller = new AbortController();
    const timeout = scope.setTimeout(() => {
      controller.abort();
    }, NAVIGATION_TIMEOUT_MS);
    try {
      const response = await scope.fetch(request, { signal: controller.signal });
      if (isStorable(response) && cache !== undefined) {
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
    } finally {
      scope.clearTimeout(timeout);
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
      // Without `waitUntil` the worker could be terminated before `skipWaiting()`
      // completes, since nothing else tells the browser this message event is
      // still doing work.
      event.waitUntil(scope.skipWaiting());
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
