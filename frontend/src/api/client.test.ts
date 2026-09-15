import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch, ApiError, onUnauthenticated, SESSION_PATH } from "./client";

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
});
