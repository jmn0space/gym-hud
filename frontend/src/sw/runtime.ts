/**
 * The Gym HUD service-worker runtime.
 *
 * Kept separate from `service-worker.ts` (the build entry) so every branch below can
 * be exercised against a constructed `ServiceWorkerGlobalScope` in jsdom, without
 * ever starting a real worker.
 *
 * Cache strategy (issue #17, decision D2):
 *  - navigations: network-first with a hard timeout, falling back to the precached
 *    `/index.html` shell -- and, only if that is genuinely absent, `/offline.html` --
 *    on a network failure, a timeout or a 5xx. A 4xx is the server's own answer and
 *    is passed through untouched;
 *  - precached shell assets: cache-first, because Vite hashes their file names, so a
 *    given URL is immutable;
 *  - `/api/**`: never cached, never intercepted. Private API data belongs in
 *    IndexedDB behind the login/logout boundary; a Cache API copy would outlive a
 *    logout and leak one account's data into the next session (docs/data-sync.md);
 *  - `/admin/**` and `/static/**`: Django's, not the SPA's, so never intercepted
 *    even though they sit inside this worker's scope;
 *  - non-GET, `Range` and cross-origin requests: never served from the cache.
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

/**
 * Same-origin paths this worker never intercepts:
 *  - `/api`: private data, see the header comment;
 *  - `/admin` and `/static`: served by Django, not by the SPA. They sit inside this
 *    worker's `/` scope, so without this list a 404 or a maintenance page under
 *    `/admin/` would be swallowed and replaced by the Gym HUD shell.
 */
const BYPASSED_PREFIXES = ["/api", "/admin", "/static"] as const;
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

function isBypassedPath(pathname: string): boolean {
  return BYPASSED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** One place for the "this build is degraded" diagnostics, so they are greppable. */
function reportDegradation(message: string): void {
  console.warn(`[gym-hud sw] ${message}`);
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
  key: RequestInfo,
  options?: CacheQueryOptions,
): Promise<Response | undefined> {
  if (cache === undefined) {
    return undefined;
  }
  try {
    return await cache.match(key, options);
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
  /**
   * A build whose manifest never got injected (an unbuilt worker, or a plugin that
   * did not run). It knows nothing about the real build's assets, so it must never
   * be allowed to supersede a real cache -- see `dropSupersededCaches`.
   */
  const isDevelopmentBuild = build.version === DEVELOPMENT_BUILD.version;
  if (isDevelopmentBuild) {
    reportDegradation(
      "no build manifest was injected; running with an empty precache list. " +
        "Offline support is degraded and superseded caches will not be reclaimed.",
    );
  }
  /** Without these two the worker cannot answer a navigation offline at all. */
  const requiredPaths = [...new Set([APP_SHELL_PATH, OFFLINE_FALLBACK_PATH])];
  /** Icons, manifest, hashed chunks: nice to have offline, never worth failing over. */
  const optionalPaths = [...new Set(build.assets)].filter((path) => !requiredPaths.includes(path));
  const precachedPaths = new Set([...requiredPaths, ...optionalPaths]);

  async function cacheAlreadyExists(name: string): Promise<boolean> {
    try {
      return (await scope.caches.keys()).includes(name);
    } catch {
      // Unknown means "assume live": the cleanup below may only ever delete a cache
      // this install is certain it created.
      return true;
    }
  }

  async function precacheOne(cache: Cache, path: string): Promise<void> {
    // `reload` bypasses the HTTP cache so an install can never adopt a stale
    // copy of an asset whose hashed name it is about to treat as immutable.
    //
    // `credentials: "same-origin"` sends the session cookie. That is harmless while
    // every precached path is a static Vite/`public/` artifact, but if `/index.html`
    // ever becomes a Django template carrying a CSRF token or a username, that
    // per-user response would be baked into a cache bucket shared by every account
    // on the device and outliving logout. Precache a truly static shell, or drop
    // the credentials here and move the personalised part behind the API.
    const response = await scope.fetch(path, {
      cache: "reload",
      credentials: "same-origin",
    });
    if (!isStorable(response)) {
      throw new Error(`Precaching ${path} failed with status ${response.status.toString()}`);
    }
    await cache.put(path, response);
  }

  async function precacheShell(): Promise<void> {
    // Asked before opening, because `caches.open` is what creates the cache.
    const createdByThisInstall = !(await cacheAlreadyExists(cacheName));
    // `caches.open` can reject in its own right (Safari private mode's
    // SecurityError, a corrupt store). Left unguarded it escapes `waitUntil` as an
    // unhandled rejection and skips the cleanup below, so it goes through the same
    // wrapper as every other call site.
    const cache = await openCacheSafely(scope.caches, cacheName);
    if (cache === undefined) {
      throw new Error(`Opening the "${cacheName}" cache failed; the shell was not precached.`);
    }

    const required = requiredPaths.map((path) => precacheOne(cache, path));
    const optional = optionalPaths.map((path) => precacheOne(cache, path));
    // Every write, settled rather than raced: this is also the handle used to drain
    // in-flight puts before deleting the cache, so nothing can write into a Cache
    // object after `caches.delete` has unlinked it and leave storage unreachable.
    const allWrites = Promise.allSettled([...required, ...optional]);

    try {
      await Promise.all(required);
    } catch (error: unknown) {
      await allWrites;
      // Only ever delete a cache this install created. A build that changes nothing
      // but the worker's own source could otherwise share a name with the live
      // cache, and this cleanup would strip the *active* worker's shell -- the
      // failed install never activates, so the old worker would keep serving with
      // neither `/index.html` nor `/offline.html` left to serve. (`vite.config.ts`
      // now folds the worker chunk into the version hash, so the two names should
      // already differ; this guard is the second belt.) Best effort either way: the
      // original precaching failure is what must propagate.
      if (createdByThisInstall) {
        await scope.caches.delete(cacheName).catch(() => undefined);
      }
      throw error;
    }

    // A rejected optional put -- a `QuotaExceededError` on a storage-pressured
    // phone, a single 404 icon -- degrades the offline experience instead of
    // bricking the install. Failing here would leave the browser retrying the
    // identical install forever behind a home-screen icon that never works.
    const failures = (await allWrites).filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      reportDegradation(
        `${failures.length.toString()} of ${optionalPaths.length.toString()} optional assets were not precached; ` +
          "the app shell is installed but some resources will need the network.",
      );
    }
  }

  async function dropSupersededCaches(): Promise<void> {
    if (isDevelopmentBuild) {
      // This worker's `assets` list is empty, so its cache cannot replace what a
      // real build cached. Reclaiming here would delete a working offline copy and
      // leave the user with an app that silently stops working offline.
      return;
    }
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
    // The request goes to `fetch` *unchanged*. Per the Fetch spec's `Request(input,
    // init)` constructor a non-empty `init` -- `{ signal }` on its own is enough --
    // resets a `"navigate"` request to `"same-origin"` mode and clears the
    // reload-navigation flag, the history-navigation flag, the referrer and the
    // referrer policy. That would quietly defeat a hard reload or a pull-to-refresh
    // and break anything keyed on `Sec-Fetch-Mode: navigate`. `mode: "navigate"`
    // cannot be restored either: the constructor throws on it.
    //
    // So the deadline below is a race rather than an abort -- without one, a cold
    // start on flaky gym WiFi hangs on a socket that never answers instead of
    // falling back to the cached shell. A timed-out response is abandoned, not
    // cancelled; the `catch` keeps a late rejection from surfacing as an unhandled
    // rejection after the race has already been settled by the timeout.
    const network = scope.fetch(request).then(
      (response) => ({ response }),
      () => undefined,
    );
    let timeout: ReturnType<typeof scope.setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timeout = scope.setTimeout(() => {
        resolve(undefined);
      }, NAVIGATION_TIMEOUT_MS);
    });
    try {
      const settled = await Promise.race([network, deadline]);
      if (settled !== undefined) {
        const response = settled.response;
        // A navigation request carries `redirect: "manual"`, so a redirect arrives as
        // an opaque redirect the browser still knows how to follow -- pass it
        // straight on. Everything below 500 is passed through too: a 404 or a 403 is
        // the server's answer, and replacing it with the shell would hide a genuinely
        // missing page. Only a network failure, a timeout or a 5xx falls back, and a
        // 5xx only because a client-routed app can still render the route from cache.
        if (response.type === "opaqueredirect" || response.status < 500) {
          return response;
        }
      }
    } finally {
      if (timeout !== undefined) {
        scope.clearTimeout(timeout);
      }
    }
    return await cachedShell();
  }

  async function handlePrecachedAsset(request: Request): Promise<Response> {
    // A `Range` request must go to the network: the cached entry is a full 200 with
    // no `Content-Range`, which a media element treats as a protocol error, and
    // `cache.put` refuses to store the 206 that comes back (see `isStorable`).
    if (request.headers.has("range")) {
      return await scope.fetch(request);
    }
    const cache = await openCacheSafely(scope.caches, cacheName);
    // Keyed on the request, not on a bare pathname, so the Cache API applies its own
    // `Vary` matching. `ignoreSearch` is deliberate: Vite hashes these file names, so
    // the path alone identifies the content and a query string only ever decorates it.
    const cached = await matchCacheSafely(cache, request, { ignoreSearch: true });
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
        void cache.put(request, copy).catch(() => undefined);
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
    if (isBypassedPath(url.pathname)) {
      return;
    }

    // `respondWith` must be called synchronously, before this handler returns, or the
    // browser has already gone to the network by the time a `.then` would run.
    if (request.mode === "navigate") {
      event.respondWith(handleNavigation(request));
      return;
    }
    if (precachedPaths.has(url.pathname)) {
      event.respondWith(handlePrecachedAsset(request));
    }
  });
}
