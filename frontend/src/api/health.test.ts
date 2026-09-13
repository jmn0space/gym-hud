import { describe, expect, it, vi } from "vitest";

import { fetchHealth } from "./health";

function stubFetch(implementation: () => Promise<Response>) {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("fetchHealth", () => {
  it("requests the backend health endpoint without caching", async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(Response.json({ status: "ok", database: { connected: true } })),
    );

    await expect(fetchHealth()).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/health/",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("reports a database outage from the 503 response body", async () => {
    stubFetch(() =>
      Promise.resolve(
        Response.json({ status: "degraded", database: { connected: false } }, { status: 503 }),
      ),
    );

    await expect(fetchHealth()).resolves.toBe("degraded");
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["an unexpected status", () => Promise.resolve(new Response("Bad gateway", { status: 502 }))],
    ["a non-JSON body", () => Promise.resolve(new Response("<html>", { status: 200 }))],
    ["an unexpected payload", () => Promise.resolve(Response.json({ status: "ok" }))],
  ])("reports unreachable for %s", async (_case, implementation) => {
    stubFetch(implementation);

    await expect(fetchHealth()).resolves.toBe("unreachable");
  });
});
