import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchChanges } from "./api";

/**
 * Direct coverage of `fetchChanges`'s query string (issue #20 review, M10):
 * before this file existed, the only thing exercising `fetchChanges` was
 * `App.test.tsx`'s stub, which matches on `url.includes("/sync/changes/")`
 * and never inspects `?since=`/`?limit=` -- so a wrong or missing `since`
 * (e.g. always re-pulling page 0) would have passed every test in the suite
 * silently.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function requestUrl(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): URL {
  const call = fetchMock.mock.calls[callIndex] as [unknown, unknown] | undefined;
  const [url] = call ?? [];
  return new URL(String(url), "http://localhost");
}

describe("sync/api: fetchChanges query string", () => {
  it("sends the exact since and limit given", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ changes: [], cursor: 41, has_more: false })));
    vi.stubGlobal("fetch", fetchMock);

    await fetchChanges(41, 100);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = requestUrl(fetchMock);
    expect(url.pathname).toBe("/api/v1/sync/changes/");
    expect(url.searchParams.get("since")).toBe("41");
    expect(url.searchParams.get("limit")).toBe("100");
  });

  it("always sends since, even when it is 0 -- never silently omitted as falsy", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ changes: [], cursor: 0, has_more: false })));
    vi.stubGlobal("fetch", fetchMock);

    await fetchChanges(0);

    const url = requestUrl(fetchMock);
    expect(url.searchParams.has("since")).toBe(true);
    expect(url.searchParams.get("since")).toBe("0");
  });

  it("omits limit entirely when not given, rather than sending an empty or default value", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ changes: [], cursor: 7, has_more: false })));
    vi.stubGlobal("fetch", fetchMock);

    await fetchChanges(7);

    const url = requestUrl(fetchMock);
    expect(url.searchParams.get("since")).toBe("7");
    expect(url.searchParams.has("limit")).toBe(false);
  });

  it("advances since on the next call to the page cursor just returned, never re-requesting page 0", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ changes: [], cursor: 12, has_more: true }))
      .mockResolvedValueOnce(Response.json({ changes: [], cursor: 30, has_more: false }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchChanges(0);
    expect(first.cursor).toBe(12);
    await fetchChanges(first.cursor);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(fetchMock, 0).searchParams.get("since")).toBe("0");
    expect(requestUrl(fetchMock, 1).searchParams.get("since")).toBe("12");
  });
});
