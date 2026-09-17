import { describe, expect, it, vi } from "vitest";

import {
  APP_SHELL_PATH,
  CACHE_PREFIX,
  createServiceWorkerRuntime,
  DEVELOPMENT_BUILD,
  NAVIGATION_TIMEOUT_MS,
  OFFLINE_FALLBACK_PATH,
  parseInjectedBuild,
  SKIP_WAITING_MESSAGE,
  type ServiceWorkerBuild,
} from "./runtime";

const ORIGIN = "https://gym-hud.test";
const BUILD: ServiceWorkerBuild = {
  version: "abc123",
  assets: ["/assets/index-abc.js", "/assets/index-abc.css", "/manifest.webmanifest"],
};
const CACHE_NAME = `${CACHE_PREFIX}${BUILD.version}`;

/**
 * Lets a test flip Cache Storage from working to throwing partway through a
 * scenario -- e.g. a healthy install followed by eviction, a Safari private-mode
 * SecurityError, or a corrupted store, all of which surface on `open` or `match`.
 */
interface CacheStorageFailures {
  open?: Error;
  match?: Error;
  /** Rejects `cache.put` -- a quota blip, a full disk -- for `putPaths`, or for every write. */
  put?: Error;
  putPaths?: readonly string[];
}

/** A real `Cache` keys entries by absolute URL, whether it was given a path or a Request. */
function cacheKey(key: RequestInfo): string {
  const url = typeof key === "string" ? key : key.url;
  return new URL(url, ORIGIN).href;
}

function withoutSearch(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  return parsed.href;
}

/** A Cache API stand-in: `open`/`keys`/`delete`, and `match`/`put` keyed by URL. */
function createCacheStorage(failures: CacheStorageFailures = {}) {
  const stores = new Map<string, Map<string, Response>>();
  const storage = {
    open: (name: string) => {
      if (failures.open !== undefined) {
        return Promise.reject(failures.open);
      }
      const entries = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, entries);
      return Promise.resolve({
        match: (key: RequestInfo, options?: CacheQueryOptions) => {
          if (failures.match !== undefined) {
            return Promise.reject(failures.match);
          }
          const wanted = cacheKey(key);
          const stored =
            entries.get(wanted) ??
            (options?.ignoreSearch === true
              ? [...entries].find(
                  ([candidate]) => withoutSearch(candidate) === withoutSearch(wanted),
                )?.[1]
              : undefined);
          // A real `Cache.match` hands back a fresh Response every time; returning the
          // same instance would let one consumed body break every later read.
          return Promise.resolve(stored?.clone());
        },
        put: (key: RequestInfo, response: Response) => {
          const stored = cacheKey(key);
          if (
            failures.put !== undefined &&
            (failures.putPaths === undefined ||
              failures.putPaths.some((path) => cacheKey(path) === stored))
          ) {
            return Promise.reject(failures.put);
          }
          entries.set(stored, response);
          return Promise.resolve();
        },
      });
    },
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name: string) => Promise.resolve(stores.delete(name)),
  };
  return { storage, stores };
}

type Handler = (event: unknown) => void;

function createScope(
  fetchImplementation: typeof fetch,
  cacheFailures: CacheStorageFailures = {},
  /** Lets a second runtime share one storage, the way two workers share the browser's. */
  sharedStorage?: ReturnType<typeof createCacheStorage>,
) {
  const { storage, stores } = sharedStorage ?? createCacheStorage(cacheFailures);
  const handlers = new Map<string, Handler>();
  const claim = vi.fn(() => Promise.resolve());
  const skipWaiting = vi.fn(() => Promise.resolve());
  const fetchMock = vi.fn(fetchImplementation);

  const scope = {
    addEventListener: (type: string, handler: Handler) => {
      handlers.set(type, handler);
    },
    caches: storage,
    clients: { claim },
    skipWaiting,
    location: { origin: ORIGIN },
    fetch: fetchMock,
    // Resolved lazily so a test that installs fake timers still gets the fake ones.
    setTimeout: (handler: () => void, ms: number) => globalThis.setTimeout(handler, ms),
    clearTimeout: (id: number) => { globalThis.clearTimeout(id); },
  };

  return {
    scope: scope as unknown as ServiceWorkerGlobalScope,
    handlers,
    stores,
    cacheStorage: { storage, stores },
    claim,
    skipWaiting,
    fetchMock,
    setFetch: (next: typeof fetch) => fetchMock.mockImplementation(next),
  };
}

/** The cache's contents as same-origin paths, which is how the runtime names them. */
function cacheEntries(stores: Map<string, Map<string, Response>>, name = CACHE_NAME): string[] {
  return [...(stores.get(name)?.keys() ?? [])]
    .map((key) => {
      const url = new URL(key);
      return `${url.pathname}${url.search}`;
    })
    .sort();
}

/** Dispatches a lifecycle event and returns whatever it passed to `waitUntil`. */
function lifecycle(handlers: Map<string, Handler>, type: "install" | "activate") {
  let pending: Promise<unknown> = Promise.resolve();
  handlers.get(type)?.({
    waitUntil: (value: Promise<unknown>) => {
      pending = value;
    },
  });
  return pending;
}

/** The install's `waitUntil` promise, for tests that assert on how it settles. */
function installing(handlers: Map<string, Handler>) {
  return lifecycle(handlers, "install");
}

async function runLifecycle(handlers: Map<string, Handler>, type: "install" | "activate") {
  await lifecycle(handlers, type);
}

/**
 * A Request stand-in carrying the fields the runtime actually reads. `headers` is a
 * real `Headers` so the `Range` check behaves, and `mode`/`redirect` are what a
 * browser would set, so a test can assert the runtime passes a navigation on
 * unchanged rather than downgrading it.
 */
function request(
  path: string,
  init: { method?: string; mode?: string; headers?: Record<string, string> } = {},
) {
  const mode = init.mode ?? "no-cors";
  return {
    url: path.startsWith("http") ? path : `${ORIGIN}${path}`,
    method: init.method ?? "GET",
    mode,
    headers: new Headers(init.headers),
    credentials: "same-origin",
    redirect: mode === "navigate" ? "manual" : "follow",
  } as unknown as Request;
}

/** Dispatches a fetch event and returns whatever `respondWith` received, if anything. */
function dispatchFetch(handlers: Map<string, Handler>, target: Request): Promise<Response> | null {
  const responded: Promise<Response>[] = [];
  handlers.get("fetch")?.({
    request: target,
    respondWith: (value: Promise<Response>) => {
      responded.push(value);
    },
  });
  return responded[0] ?? null;
}

/** Dispatches a message event and returns whatever it passed to `waitUntil`, if any. */
function dispatchMessage(handlers: Map<string, Handler>, data: unknown): Promise<unknown> | undefined {
  let pending: Promise<unknown> | undefined;
  handlers.get("message")?.({
    data,
    waitUntil: (value: Promise<unknown>) => {
      pending = value;
    },
  });
  return pending;
}

function okResponse(body: string) {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
}

function requestedUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : (input as Request).url;
}

/** Answers every request with a body naming what was asked for. */
const servingFetch: typeof fetch = (input: RequestInfo | URL) =>
  Promise.resolve(okResponse(`served:${requestedUrl(input)}`));

/** Serves everything except `path`, which answers `status`. */
function failingPath(path: string, status = 404): typeof fetch {
  return (input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    return Promise.resolve(
      url.endsWith(path) ? new Response("nope", { status }) : okResponse(`served:${url}`),
    );
  };
}

const failingFetch: typeof fetch = () => Promise.reject(new TypeError("Failed to fetch"));

describe("parseInjectedBuild", () => {
  it("accepts the object the build plugin injects", () => {
    expect(parseInjectedBuild({ version: "v1", assets: ["/a.js", 7, "relative.js"] })).toEqual({
      version: "v1",
      assets: ["/a.js"],
    });
  });

  it("falls back to the development build for anything else", () => {
    expect(parseInjectedBuild(undefined)).toBe(DEVELOPMENT_BUILD);
    expect(parseInjectedBuild(null)).toBe(DEVELOPMENT_BUILD);
    expect(parseInjectedBuild("nope")).toBe(DEVELOPMENT_BUILD);
    expect(parseInjectedBuild({ version: "", assets: [] })).toBe(DEVELOPMENT_BUILD);
    expect(parseInjectedBuild({ version: "v1" })).toBe(DEVELOPMENT_BUILD);
  });
});

describe("service worker install and activate", () => {
  it("precaches the shell, the offline page, and every build asset", async () => {
    const { scope, handlers, stores } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);

    await runLifecycle(handlers, "install");

    expect(cacheEntries(stores)).toEqual(
      [APP_SHELL_PATH, OFFLINE_FALLBACK_PATH, ...BUILD.assets].sort(),
    );
  });

  it("never calls skipWaiting during install", async () => {
    const { scope, handlers, skipWaiting } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);

    await runLifecycle(handlers, "install");

    expect(skipWaiting).not.toHaveBeenCalled();
  });

  it("fails the install rather than caching a partial shell", async () => {
    const { scope, handlers } = createScope(() =>
      Promise.resolve(new Response("nope", { status: 404 })),
    );
    createServiceWorkerRuntime(scope, BUILD);

    let pending: Promise<unknown> = Promise.resolve();
    handlers.get("install")?.({
      waitUntil: (value: Promise<unknown>) => {
        pending = value;
      },
    });

    await expect(pending).rejects.toThrow(/Precaching/);
  });

  it("removes superseded gym-hud-shell caches and keeps the current one", async () => {
    const { scope, handlers, stores, claim } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");
    await scope.caches.open(`${CACHE_PREFIX}stale-one`);
    await scope.caches.open(`${CACHE_PREFIX}stale-two`);
    await scope.caches.open("some-other-app-cache");

    await runLifecycle(handlers, "activate");

    expect([...stores.keys()].sort()).toEqual([CACHE_NAME, "some-other-app-cache"]);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it("skips waiting only when the page sends SKIP_WAITING", () => {
    const { scope, handlers, skipWaiting } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);

    void dispatchMessage(handlers, { type: "SOMETHING_ELSE" });
    expect(skipWaiting).not.toHaveBeenCalled();

    void dispatchMessage(handlers, { type: SKIP_WAITING_MESSAGE });
    expect(skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("extends the message event's lifetime with waitUntil while skipWaiting settles", () => {
    const { scope, handlers, skipWaiting } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);

    const pending = dispatchMessage(handlers, { type: SKIP_WAITING_MESSAGE });

    // Without `waitUntil`, the worker could be torn down before `skipWaiting()`
    // completes; wiring the call through it is what keeps the event alive.
    expect(pending).not.toBeUndefined();
    expect(skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("deletes the partially populated cache it created when the install fails", async () => {
    const { scope, handlers, stores } = createScope(failingPath(OFFLINE_FALLBACK_PATH));
    createServiceWorkerRuntime(scope, BUILD);

    await expect(installing(handlers)).rejects.toThrow(/Precaching/);

    // The other assets in the same batch still landed in this version-named cache
    // before the offline page's fetch rejected; a failed install must not leave
    // them (or the cache itself) behind to accumulate across repeated failed
    // deploys.
    expect(stores.has(CACHE_NAME)).toBe(false);
  });

  it("tolerates an optional asset that cannot be fetched", async () => {
    const { scope, handlers, stores } = createScope(failingPath("/manifest.webmanifest"));
    createServiceWorkerRuntime(scope, BUILD);

    await installing(handlers);

    // One 404 icon or manifest must degrade the install, not brick it: a rejected
    // install is retried forever behind a home-screen icon that never works.
    expect(cacheEntries(stores)).toEqual(
      [APP_SHELL_PATH, OFFLINE_FALLBACK_PATH, "/assets/index-abc.js", "/assets/index-abc.css"].sort(),
    );
  });

  it("tolerates a QuotaExceededError while writing an optional asset", async () => {
    const quota = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    const { scope, handlers, stores } = createScope(servingFetch, {
      put: quota,
      putPaths: ["/assets/index-abc.js", "/assets/index-abc.css", "/manifest.webmanifest"],
    });
    createServiceWorkerRuntime(scope, BUILD);

    await installing(handlers);

    expect(cacheEntries(stores)).toEqual([APP_SHELL_PATH, OFFLINE_FALLBACK_PATH].sort());
  });

  it("fails the install when a required shell file cannot be written", async () => {
    const quota = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    const { scope, handlers, stores } = createScope(servingFetch, {
      put: quota,
      putPaths: [APP_SHELL_PATH],
    });
    createServiceWorkerRuntime(scope, BUILD);

    await expect(installing(handlers)).rejects.toThrow(/quota/i);
    expect(stores.has(CACHE_NAME)).toBe(false);
  });

  it("rejects the install rather than escaping waitUntil when caches.open throws", async () => {
    const { scope, handlers } = createScope(servingFetch, {
      open: new DOMException("The operation is not allowed.", "SecurityError"),
    });
    createServiceWorkerRuntime(scope, BUILD);

    // Unguarded, this rejection leaves `waitUntil` as an unhandled rejection and
    // skips the cleanup entirely.
    await expect(installing(handlers)).rejects.toThrow(/cache/i);
  });

  it("keeps a pre-existing cache of the same name when a fresh install fails", async () => {
    // Two workers, one cache name: what a build that changes only the worker's own
    // source used to produce, because the version hash covered assets alone. The
    // failed install must not strip the shell the *active* worker is still serving.
    const live = createScope(servingFetch);
    createServiceWorkerRuntime(live.scope, BUILD);
    await installing(live.handlers);

    // Same storage, so the new runtime sees the live worker's populated cache.
    const installer = createScope(failingPath(APP_SHELL_PATH), {}, live.cacheStorage);
    createServiceWorkerRuntime(installer.scope, BUILD);

    await expect(installing(installer.handlers)).rejects.toThrow(/Precaching/);

    expect(live.stores.has(CACHE_NAME)).toBe(true);
    live.setFetch(failingFetch);
    const response = await dispatchFetch(live.handlers, request("/pad", { mode: "navigate" }));
    expect(await response?.text()).toBe(`served:${APP_SHELL_PATH}`);
  });

  it("never supersedes a real cache from a build with no injected manifest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { scope, handlers, stores } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, DEVELOPMENT_BUILD);
    await installing(handlers);
    await scope.caches.open(`${CACHE_PREFIX}${BUILD.version}`);

    await runLifecycle(handlers, "activate");

    // A worker with an empty precache list knows nothing about the real build's
    // assets, so reclaiming its cache would silently destroy offline support.
    expect([...stores.keys()]).toContain(`${CACHE_PREFIX}${BUILD.version}`);
    expect(warn).toHaveBeenCalled();
  });
});

describe("service worker fetch handling", () => {
  it("does not intercept non-GET requests", () => {
    const { scope, handlers } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);

    expect(dispatchFetch(handlers, request("/index.html", { method: "POST" }))).toBeNull();
  });

  it("does not intercept cross-origin requests", () => {
    const { scope, handlers } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);

    expect(dispatchFetch(handlers, request("https://cdn.example.test/index.html"))).toBeNull();
  });

  it("never intercepts or caches /api requests", async () => {
    const { scope, handlers, stores } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");

    expect(dispatchFetch(handlers, request("/api/v1/health/"))).toBeNull();
    expect(dispatchFetch(handlers, request("/api", { mode: "navigate" }))).toBeNull();
    expect(cacheEntries(stores)).not.toContain("/api/v1/health/");
  });

  it("serves precached assets from the cache without touching the network", async () => {
    const { scope, handlers, fetchMock } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");
    fetchMock.mockClear();

    const response = await dispatchFetch(handlers, request("/assets/index-abc.js"));

    expect(await response?.text()).toBe(`served:/assets/index-abc.js`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves the same precached asset to two separate fetches", async () => {
    const { scope, handlers } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");

    const first = await dispatchFetch(handlers, request("/assets/index-abc.js"));
    const second = await dispatchFetch(handlers, request("/assets/index-abc.js"));

    // A real `Cache.match` clones; handing out one instance twice would leave the
    // second reader with an already-consumed body.
    expect(await first?.text()).toBe("served:/assets/index-abc.js");
    expect(await second?.text()).toBe("served:/assets/index-abc.js");
  });

  it("serves a precached asset for a cache-busted URL", async () => {
    const { scope, handlers, fetchMock } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");
    fetchMock.mockClear();

    const response = await dispatchFetch(handlers, request("/assets/index-abc.js?v=2"));

    // Vite hashes these names, so the path alone identifies the content and the
    // query string is only decoration: `ignoreSearch` keeps the hit.
    expect(await response?.text()).toBe("served:/assets/index-abc.js");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a Range request to the network instead of answering it from the cache", async () => {
    const { scope, handlers, fetchMock, stores } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");
    fetchMock.mockClear();

    const ranged = request("/assets/index-abc.js", { headers: { Range: "bytes=0-1023" } });
    const response = await dispatchFetch(handlers, ranged);

    // The cached entry is a full 200 with no `Content-Range`; answering a range
    // request with it is a protocol error for the consumer.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [call] = fetchMock.mock.calls;
    expect(call?.[0]).toBe(ranged);
    expect(await response?.text()).toBe(`served:${ORIGIN}/assets/index-abc.js`);
    // ...and the 206 that a real server would answer with is never stored.
    expect(cacheEntries(stores)).toEqual(
      [APP_SHELL_PATH, OFFLINE_FALLBACK_PATH, ...BUILD.assets].sort(),
    );
  });

  it("stores a network-fetched asset under the request it was fetched for", async () => {
    const { scope, handlers, stores } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);

    await dispatchFetch(handlers, request("/assets/index-abc.js"));

    expect(cacheEntries(stores)).toEqual(["/assets/index-abc.js"]);
  });

  it("leaves requests outside the precache list to the network", () => {
    const { scope, handlers } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);

    expect(dispatchFetch(handlers, request("/assets/not-precached.js"))).toBeNull();
  });

  it("does not cache an opaque or error response for a precached path", async () => {
    const { scope, handlers, stores, setFetch } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    const opaque = { ok: false, status: 0, type: "opaque", clone: () => opaque };
    setFetch(() => Promise.resolve(opaque as unknown as Response));

    const response = await dispatchFetch(handlers, request("/assets/index-abc.js"));

    expect(response).toBe(opaque);
    expect(cacheEntries(stores)).toEqual([]);
  });

  it("returns a 504 rather than rejecting when a precached asset is missing offline", async () => {
    const { scope, handlers, setFetch } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    setFetch(failingFetch);

    const response = await dispatchFetch(handlers, request("/assets/index-abc.js"));

    expect(response?.status).toBe(504);
  });

  it("serves a navigation from the network when it is reachable", async () => {
    const { scope, handlers } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");

    const response = await dispatchFetch(handlers, request("/pad", { mode: "navigate" }));

    expect(await response?.text()).toBe(`served:${ORIGIN}/pad`);
  });

  it("falls back to the cached shell when a navigation fails", async () => {
    const { scope, handlers, setFetch } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");
    setFetch(failingFetch);

    const response = await dispatchFetch(handlers, request("/pad", { mode: "navigate" }));

    expect(await response?.text()).toBe(`served:${APP_SHELL_PATH}`);
  });

  it("falls back to the cached shell when the server answers a navigation with an error", async () => {
    const { scope, handlers, setFetch } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");
    setFetch(() => Promise.resolve(new Response("boom", { status: 500 })));

    const response = await dispatchFetch(handlers, request("/pad", { mode: "navigate" }));

    expect(await response?.text()).toBe(`served:${APP_SHELL_PATH}`);
  });

  it("passes a 404 navigation through instead of replacing it with the shell", async () => {
    const { scope, handlers, setFetch } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");
    setFetch(() => Promise.resolve(new Response("not found", { status: 404 })));

    const response = await dispatchFetch(handlers, request("/nope", { mode: "navigate" }));

    // Swallowing a 4xx would hide a genuinely missing page behind the app shell.
    expect(response?.status).toBe(404);
    expect(await response?.text()).toBe("not found");
  });

  it("passes an opaque redirect straight through", async () => {
    const { scope, handlers, setFetch } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");
    // What a server-side login redirect looks like to a `redirect: "manual"`
    // navigation: status 0, not ok, and only the browser can follow it.
    const redirect = { ok: false, status: 0, type: "opaqueredirect" } as unknown as Response;
    setFetch(() => Promise.resolve(redirect));

    const response = await dispatchFetch(handlers, request("/pad", { mode: "navigate" }));

    expect(response).toBe(redirect);
  });

  it("passes the navigation request to the network unchanged", async () => {
    const { scope, handlers, fetchMock } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    const navigation = request("/pad", { mode: "navigate" });

    await dispatchFetch(handlers, navigation);

    // Any `init` at all -- `{ signal }` included -- would reset this request's
    // "navigate" mode to "same-origin" and drop the reload/history flags, the
    // referrer and the referrer policy, defeating a hard reload or pull-to-refresh.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [call] = fetchMock.mock.calls;
    expect(call).toEqual([navigation]);
    expect((call?.[0] as Request | undefined)?.mode).toBe("navigate");
  });

  it("does not intercept /admin or /static, which Django owns", () => {
    const { scope, handlers } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);

    expect(dispatchFetch(handlers, request("/admin/", { mode: "navigate" }))).toBeNull();
    expect(dispatchFetch(handlers, request("/admin/gym/session/", { mode: "navigate" }))).toBeNull();
    expect(dispatchFetch(handlers, request("/static/admin/css/base.css"))).toBeNull();
  });

  it("falls back once the navigation deadline elapses, without awaiting the network", async () => {
    const { scope, handlers, setFetch } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");

    vi.useFakeTimers();
    // A socket that never answers: with the request passed through unchanged there
    // is no signal to abort it, so the deadline has to win the race on its own.
    setFetch(() => new Promise<Response>(() => undefined));

    const pending = dispatchFetch(handlers, request("/pad", { mode: "navigate" }));
    await vi.advanceTimersByTimeAsync(NAVIGATION_TIMEOUT_MS);
    const response = await pending;

    expect(await response?.text()).toBe(`served:${APP_SHELL_PATH}`);
  });

  it("falls back to the offline page when the shell itself was never cached", async () => {
    const { scope, handlers, setFetch } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    const cache = await scope.caches.open(CACHE_NAME);
    await cache.put(OFFLINE_FALLBACK_PATH, okResponse("offline page"));
    setFetch(failingFetch);

    const response = await dispatchFetch(handlers, request("/pad", { mode: "navigate" }));

    expect(await response?.text()).toBe("offline page");
  });

  it("answers with a 503 when nothing at all has been cached", async () => {
    const { scope, handlers, setFetch } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    setFetch(failingFetch);

    const response = await dispatchFetch(handlers, request("/pad", { mode: "navigate" }));

    expect(response?.status).toBe(503);
  });
});

describe("service worker resilience to Cache Storage and network failures", () => {
  it("still answers with the inline fallback instead of rejecting when Cache Storage throws on open", async () => {
    const cacheFailures: CacheStorageFailures = {};
    const { scope, handlers, setFetch } = createScope(servingFetch, cacheFailures);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");

    // Cache Storage failing after a healthy install -- eviction, a Safari
    // private-mode SecurityError, or a corrupted store -- must not turn into a
    // rejected `respondWith` promise (the browser's own network-error page)
    // instead of the documented fallback chain.
    cacheFailures.open = new DOMException("The operation is not allowed.", "SecurityError");
    setFetch(failingFetch);

    const response = await dispatchFetch(handlers, request("/pad", { mode: "navigate" }));

    expect(response?.status).toBe(503);
  });

  it("still answers with the inline fallback when cache.match itself throws", async () => {
    const cacheFailures: CacheStorageFailures = {};
    const { scope, handlers, setFetch } = createScope(servingFetch, cacheFailures);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");

    cacheFailures.match = new DOMException("The database is corrupted.", "InvalidStateError");
    setFetch(failingFetch);

    const response = await dispatchFetch(handlers, request("/pad", { mode: "navigate" }));

    expect(response?.status).toBe(503);
  });

  it("still falls through to the network for a precached asset when Cache Storage throws on open", async () => {
    const cacheFailures: CacheStorageFailures = {};
    const { scope, handlers, fetchMock } = createScope(servingFetch, cacheFailures);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");
    fetchMock.mockClear();

    // The network is fine; only Cache Storage is broken -- the common case of an
    // evicted or corrupted cache on an otherwise-online device. This path is hit
    // on every JS/CSS request, not just when the network is also down.
    cacheFailures.open = new DOMException("The operation is not allowed.", "SecurityError");

    const response = await dispatchFetch(handlers, request("/assets/index-abc.js"));

    expect(await response?.text()).toBe(`served:${ORIGIN}/assets/index-abc.js`);
  });

  it(
    "aborts a hanging precached-asset fetch instead of waiting forever",
    async () => {
      const { scope, handlers, setFetch } = createScope(servingFetch);
      createServiceWorkerRuntime(scope, BUILD);
      // No install: the asset is not yet cached, so this exercises the network
      // fallback -- realistic after Cache Storage eviction under storage pressure.

      vi.useFakeTimers();
      const aborted = vi.fn();
      setFetch(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              aborted();
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      );

      const pending = dispatchFetch(handlers, request("/assets/index-abc.js"));
      await vi.advanceTimersByTimeAsync(NAVIGATION_TIMEOUT_MS);
      const response = await pending;

      expect(aborted).toHaveBeenCalledTimes(1);
      expect(response?.status).toBe(504);
    },
    1_000,
  );
});
