import { describe, expect, it, vi } from "vitest";

import { fetchSession, login, logout } from "./auth";

function stubFetch(implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchSession", () => {
  it("returns the authenticated status payload", async () => {
    stubFetch(() => Promise.resolve(Response.json({ authenticated: true, username: "juan" })));

    await expect(fetchSession()).resolves.toEqual({ authenticated: true, username: "juan" });
  });

  it("returns the anonymous status payload", async () => {
    stubFetch(() => Promise.resolve(Response.json({ authenticated: false, username: null })));

    await expect(fetchSession()).resolves.toEqual({ authenticated: false, username: null });
  });

  it("rejects an unexpected payload shape rather than silently treating it as anonymous", async () => {
    stubFetch(() => Promise.resolve(Response.json({ ok: true })));

    await expect(fetchSession()).rejects.toThrow(/unexpected payload/);
  });
});

describe("login", () => {
  it("posts credentials and reports the resulting session", async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(Response.json({ authenticated: true, username: "juan" })),
    );

    await expect(login("juan", "hunter2")).resolves.toEqual({ authenticated: true, username: "juan" });
    // No cookie is set in this test, so login() also primes one via a GET to
    // the session endpoint first; find the actual login POST among the calls.
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/v1/auth/login/");
    if (call === undefined) {
      throw new Error("the login endpoint was not called");
    }
    const [, init = {}] = call;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ username: "juan", password: "hunter2" });
  });

  it("propagates an invalid_credentials failure", async () => {
    stubFetch(() =>
      Promise.resolve(Response.json({ code: "invalid_credentials", detail: "Bad login" }, { status: 400 })),
    );

    await expect(login("juan", "wrong")).rejects.toMatchObject({ code: "invalid_credentials" });
  });
});

describe("logout", () => {
  it("resolves on a 204 with no body", async () => {
    stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));

    await expect(logout()).resolves.toBeUndefined();
  });
});
