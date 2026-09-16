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

/** A Cache API stand-in: `open`/`keys`/`delete`, and `match`/`put` keyed by path. */
function createCacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  const storage = {
    open: (name: string) => {
      const entries = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, entries);
      return Promise.resolve({
        match: (key: string) => Promise.resolve(entries.get(key)),
        put: (key: string, response: Response) => {
          entries.set(key, response);
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

function createScope(fetchImplementation: typeof fetch) {
  const { storage, stores } = createCacheStorage();
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
    claim,
    skipWaiting,
    fetchMock,
    setFetch: (next: typeof fetch) => fetchMock.mockImplementation(next),
  };
}

function cacheEntries(stores: Map<string, Map<string, Response>>, name = CACHE_NAME): string[] {
  return [...(stores.get(name)?.keys() ?? [])].sort();
}

/** Runs the `install` handler and awaits whatever it passed to `waitUntil`. */
async function runLifecycle(handlers: Map<string, Handler>, type: "install" | "activate") {
  let pending: Promise<unknown> = Promise.resolve();
  handlers.get(type)?.({
    waitUntil: (value: Promise<unknown>) => {
      pending = value;
    },
  });
  await pending;
}

function request(path: string, init: { method?: string; mode?: string } = {}) {
  return {
    url: path.startsWith("http") ? path : `${ORIGIN}${path}`,
    method: init.method ?? "GET",
    mode: init.mode ?? "no-cors",
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

function okResponse(body: string) {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
}

/** Answers every request with a body naming what was asked for. */
const servingFetch: typeof fetch = (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : (input as Request).url;
  return Promise.resolve(okResponse(`served:${url}`));
};

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

    handlers.get("message")?.({ data: { type: "SOMETHING_ELSE" } });
    expect(skipWaiting).not.toHaveBeenCalled();

    handlers.get("message")?.({ data: { type: SKIP_WAITING_MESSAGE } });
    expect(skipWaiting).toHaveBeenCalledTimes(1);
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

  it("aborts a hanging navigation and falls back once the timeout elapses", async () => {
    const { scope, handlers, setFetch } = createScope(servingFetch);
    createServiceWorkerRuntime(scope, BUILD);
    await runLifecycle(handlers, "install");

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

    const pending = dispatchFetch(handlers, request("/pad", { mode: "navigate" }));
    await vi.advanceTimersByTimeAsync(NAVIGATION_TIMEOUT_MS);
    const response = await pending;

    expect(aborted).toHaveBeenCalledTimes(1);
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
