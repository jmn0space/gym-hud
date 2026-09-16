import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiFetch,
  ApiError,
  bumpSessionGeneration,
  currentSessionGeneration,
  onUnauthenticated,
  SESSION_PATH,
} from "./client";

function stubFetch(implementation: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return implementation(url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setCookie(value: string) {
  document.cookie = value;
}

afterEach(() => {
  // jsdom keeps cookies across tests in the same document; each test sets its
  // own so start from a clean slate.
  document.cookie = "csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
});

describe("apiFetch", () => {
  it("attaches X-CSRFToken from the csrftoken cookie on a csrf request", async () => {
    setCookie("csrftoken=abc123");
    const fetchMock = stubFetch(() => Promise.resolve(Response.json({ authenticated: true, username: "juan" })));

    await apiFetch("/api/v1/auth/login/", { method: "POST", body: { username: "juan" }, csrf: true });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/login/",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-CSRFToken": "abc123" }) as unknown,
        credentials: "same-origin",
      }),
    );
  });

  it("fetches the session endpoint first to obtain a csrftoken cookie when none is set yet", async () => {
    const fetchMock = stubFetch((url) => {
      if (url === SESSION_PATH) {
        setCookie("csrftoken=fresh-token");
        return Promise.resolve(Response.json({ authenticated: false, username: null }));
      }
      return Promise.resolve(Response.json({ authenticated: true, username: "juan" }));
    });

    await apiFetch("/api/v1/auth/login/", { method: "POST", body: { username: "juan" }, csrf: true });

    expect(fetchMock).toHaveBeenNthCalledWith(1, SESSION_PATH, expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/auth/login/",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-CSRFToken": "fresh-token" }) as unknown,
      }),
    );
  });

  it("re-reads the cookie on every call, so a rotated token after login is picked up", async () => {
    setCookie("csrftoken=before-login");
    const fetchMock = stubFetch((url) => {
      if (url === "/api/v1/auth/login/") {
        setCookie("csrftoken=after-login");
        return Promise.resolve(Response.json({ authenticated: true, username: "juan" }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    await apiFetch("/api/v1/auth/login/", { method: "POST", body: {}, csrf: true });
    await apiFetch("/api/v1/auth/logout/", { method: "POST", csrf: true });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/auth/login/",
      expect.objectContaining({ headers: expect.objectContaining({ "X-CSRFToken": "before-login" }) as unknown }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/auth/logout/",
      expect.objectContaining({ headers: expect.objectContaining({ "X-CSRFToken": "after-login" }) as unknown }),
    );
  });

  it("retries once after a csrf_failed 403 by refetching the session and reattaching a fresh token", async () => {
    setCookie("csrftoken=stale-token");
    let loginAttempts = 0;
    const fetchMock = stubFetch((url) => {
      if (url === SESSION_PATH) {
        setCookie("csrftoken=rotated-token");
        return Promise.resolve(Response.json({ authenticated: false, username: null }));
      }
      loginAttempts += 1;
      if (loginAttempts === 1) {
        return Promise.resolve(Response.json({ code: "csrf_failed", detail: "CSRF check failed" }, { status: 403 }));
      }
      return Promise.resolve(Response.json({ authenticated: true, username: "juan" }));
    });

    const result = await apiFetch<{ authenticated: boolean }>("/api/v1/auth/login/", {
      method: "POST",
      body: {},
      csrf: true,
    });

    expect(result).toEqual({ authenticated: true, username: "juan" });
    expect(fetchMock).toHaveBeenCalledTimes(3); // login (403) -> session (prime) -> login (retry)
    // The retried request must carry the freshly-rotated token, not the
    // stale one that just failed (finding #14) -- re-attaching the same
    // stale cookie would just 403 again.
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/v1/auth/login/",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-CSRFToken": "rotated-token" }) as unknown,
      }),
    );
  });

  it("does not retry a second time after another csrf_failed", async () => {
    setCookie("csrftoken=always-stale");
    const fetchMock = stubFetch((url) => {
      if (url === SESSION_PATH) {
        return Promise.resolve(Response.json({ authenticated: false, username: null }));
      }
      return Promise.resolve(Response.json({ code: "csrf_failed" }, { status: 403 }));
    });

    await expect(
      apiFetch("/api/v1/auth/login/", { method: "POST", body: {}, csrf: true }),
    ).rejects.toMatchObject({ code: "csrf_failed" });
    expect(fetchMock).toHaveBeenCalledTimes(3); // login -> session (prime) -> login retry, then give up
  });

  it("notifies onUnauthenticated subscribers on a 401 and throws not_authenticated", async () => {
    stubFetch(() => Promise.resolve(Response.json({ code: "not_authenticated" }, { status: 401 })));
    const listener = vi.fn();
    const unsubscribe = onUnauthenticated(listener);

    await expect(apiFetch("/api/v1/health/")).rejects.toBeInstanceOf(ApiError);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("throws a network ApiError when fetch itself fails", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    await expect(apiFetch("/api/v1/health/")).rejects.toMatchObject({ code: "network" });
  });

  it("resolves undefined for a 204 response", async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));

    await expect(apiFetch("/api/v1/auth/logout/", { method: "POST" })).resolves.toBeUndefined();
  });

  it("surfaces a throttled 429 distinctly", async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 429 })));

    await expect(apiFetch("/api/v1/auth/login/", { method: "POST" })).rejects.toMatchObject({
      code: "throttled",
      status: 429,
    });
  });

  it("does not mislabel a non-CSRF 403 as csrf_failed and does not retry it (finding #8)", async () => {
    setCookie("csrftoken=t");
    const fetchMock = stubFetch(() =>
      Promise.resolve(Response.json({ code: "permission_denied", detail: "nope" }, { status: 403 })),
    );

    await expect(
      apiFetch("/api/v1/x/", { method: "POST", csrf: true }),
    ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("labels an unparseable 403 body (e.g. a WAF/proxy HTML page) as unknown, not csrf_failed (finding #8)", async () => {
    const fetchMock = stubFetch(() => Promise.resolve(new Response("<html>Forbidden</html>", { status: 403 })));

    await expect(apiFetch("/api/v1/x/")).rejects.toMatchObject({ status: 403, code: "unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("labels a second, different 403 after a csrf_failed retry by its own code, not csrf_failed again (finding #8)", async () => {
    setCookie("csrftoken=stale");
    let attempts = 0;
    stubFetch((url) => {
      if (url === SESSION_PATH) {
        setCookie("csrftoken=fresh");
        return Promise.resolve(anonymousSession());
      }
      attempts += 1;
      return Promise.resolve(
        attempts === 1
          ? Response.json({ code: "csrf_failed" }, { status: 403 })
          : Response.json({ code: "permission_denied" }, { status: 403 }),
      );
    });

    await expect(
      apiFetch("/api/v1/x/", { method: "POST", csrf: true }),
    ).rejects.toMatchObject({ status: 403, code: "permission_denied" });
  });

  it("keeps the last csrftoken cookie when the name appears more than once, matching Django's own parsing", async () => {
    // A real browser can hold two same-named cookies scoped to distinct
    // paths at once; jsdom's own cookie jar collapses same-path writes, so
    // the getter is stubbed directly to exercise that raw multi-occurrence
    // string deterministically (finding #18).
    const cookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => "csrftoken=first-path; csrftoken=second-path",
    });
    try {
      const fetchMock = stubFetch(() => Promise.resolve(Response.json({ authenticated: true, username: "juan" })));

      await apiFetch("/api/v1/auth/login/", { method: "POST", body: {}, csrf: true });

      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/auth/login/",
        expect.objectContaining({ headers: expect.objectContaining({ "X-CSRFToken": "second-path" }) as unknown }),
      );
    } finally {
      if (cookieDescriptor) {
        Object.defineProperty(document, "cookie", cookieDescriptor);
      }
    }
  });

  it("treats a malformed percent-encoded csrftoken cookie as missing rather than throwing (finding #18)", async () => {
    setCookie("csrftoken=%");
    const fetchMock = stubFetch((url) => {
      if (url === SESSION_PATH) {
        setCookie("csrftoken=valid-token");
        return Promise.resolve(anonymousSession());
      }
      return Promise.resolve(Response.json({ authenticated: true, username: "juan" }));
    });

    // A malformed cookie must fall back to (re)priming a fresh one instead of
    // surfacing as a thrown/network-class error.
    await expect(
      apiFetch("/api/v1/auth/login/", { method: "POST", body: {}, csrf: true }),
    ).resolves.toEqual({ authenticated: true, username: "juan" });
    expect(fetchMock).toHaveBeenNthCalledWith(1, SESSION_PATH, expect.anything());
  });
});

function anonymousSession() {
  return Response.json({ authenticated: false, username: null });
}

describe("session generation", () => {
  it("reports the generation a request captured when it was sent, not when it resolves (finding #17)", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    stubFetch(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));

    const listener = vi.fn();
    const unsubscribe = onUnauthenticated(listener);
    const generationAtSend = currentSessionGeneration();

    const pending = apiFetch("/api/v1/some-endpoint/").catch((error: unknown) => error);
    // A newer session (e.g. a fresh login) is established while the request
    // above is still in flight.
    bumpSessionGeneration();
    resolveResponse?.(Response.json({ code: "not_authenticated" }, { status: 401 }));
    await pending;

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(generationAtSend);
    expect(listener.mock.calls[0]?.[0]).not.toBe(currentSessionGeneration());
    unsubscribe();
  });
});
