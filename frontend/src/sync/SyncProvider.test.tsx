import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider } from "../auth/AuthProvider";
import { LocalDataProvider, useLocalData } from "../local/LocalDataProvider";
import { createLocalRepository, type LocalRepository } from "../storage";
import { SyncProvider, useSync } from "./SyncProvider";
import { SyncRejectionBanner, SyncStatus } from "./SyncStatus";

/**
 * Issue #20 review, M10: there was no test at all for `SyncProvider`'s
 * triggers 1/3/4, nor for `SyncStatus`/`SyncRejectionBanner`, which is how
 * M1 (trigger 1 stops firing after the first drain) got through 319 green
 * tests. This file adds that coverage directly against the real providers
 * and a real `fake-indexeddb` repository (mocking only `fetch`), the same
 * way `App.test.tsx` exercises the sync engine end to end.
 */

type MutationBody = { mutation_id: string }[];

interface StubOverrides {
  changes?: () => Response | Promise<Response>;
  /** Given the mutations actually sent, returns the push response's `results`. */
  mutationResults?: (mutations: MutationBody) => { mutation_id: string; status: string; code?: string; retryable?: boolean; detail?: string }[];
}

function stubFetch(overrides: StubOverrides = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/session/")) {
      return Promise.resolve(Response.json({ authenticated: true, username: "tester" }));
    }
    if (url.includes("/sync/bootstrap/")) {
      return Promise.resolve(
        Response.json({
          cursor: 0,
          limits: { max_mutations_per_request: 50, max_changes_per_mutation: 500 },
          pad: {
            defaults: { speed_kmh: 5, incline_pct: 2, max_bout_seconds: 480 },
            next_session_settings: {
              source: "defaults",
              walking_session_id: null,
              speed_kmh: 5,
              incline_pct: 2,
              max_bout_seconds: 480,
            },
          },
        }),
      );
    }
    if (url.includes("/sync/changes/")) {
      return Promise.resolve(overrides.changes ? overrides.changes() : Response.json({ changes: [], cursor: 0, has_more: false }));
    }
    if (url.includes("/sync/mutations/")) {
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      const mutations = Array.isArray((body as { mutations?: unknown }).mutations)
        ? ((body as { mutations: MutationBody }).mutations)
        : [];
      const results = overrides.mutationResults
        ? overrides.mutationResults(mutations)
        : mutations.map((m) => ({ mutation_id: m.mutation_id, status: "applied" }));
      return Promise.resolve(Response.json({ results }));
    }
    return Promise.resolve(Response.json({ status: "ok" }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mutationCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/sync/mutations/")).length;
}

function Probe() {
  const { commitAction, snapshot } = useLocalData();
  const sync = useSync();
  return (
    <>
      <output aria-label="Pending count">{snapshot?.pendingOutbox.length ?? "unavailable"}</output>
      <output aria-label="Active session count">{snapshot?.records.walking_sessions.length ?? "unavailable"}</output>
      <output aria-label="Sync state">{sync.state}</output>
      <button
        type="button"
        onClick={() => {
          void commitAction({
            actionId: crypto.randomUUID(),
            changes: [{ store: "exercise_registry", operation: "put", record: { id: crypto.randomUUID(), name: "x" } }],
          }).catch(() => undefined);
        }}
      >
        Commit
      </button>
    </>
  );
}

function renderHarness(repository: LocalRepository, syncRepository?: LocalRepository) {
  return render(
    <AuthProvider repository={repository}>
      <LocalDataProvider repository={repository}>
        <SyncProvider repository={syncRepository ?? repository}>
          <SyncStatus />
          <SyncRejectionBanner />
          <Probe />
        </SyncProvider>
      </LocalDataProvider>
    </AuthProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SyncProvider: trigger 1 (after a local commit)", () => {
  it("fires on every commit while online, not only once per drained-outbox state (M1)", async () => {
    const fetchMock = stubFetch();
    const repository = createLocalRepository({ databaseName: `sync-provider-m1-${crypto.randomUUID()}` });
    const user = userEvent.setup();
    renderHarness(repository);

    await screen.findByText("All changes synced");

    // First commit: drains and settles back to "synced" -- the outbox is
    // fully drained (this is trigger 1's "obvious" case, already covered
    // before this fix).
    await user.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => {
      expect(mutationCallCount(fetchMock)).toBeGreaterThanOrEqual(1);
    });
    await screen.findByText("All changes synced");
    const afterFirstCommit = mutationCallCount(fetchMock);

    // Second commit, after the first has already fully drained. Before the
    // fix, `SyncProvider` only triggered on `pendingOutbox.length` *growing*
    // relative to a `previousPendingLengthRef` that the drain never
    // refreshed, so this second commit (also landing at length 1, the same
    // as the first commit's pre-drain length) never fired -- it sat queued
    // until an unrelated focus/visibility/online event.
    await user.click(screen.getByRole("button", { name: "Commit" }));
    await waitFor(() => {
      expect(mutationCallCount(fetchMock)).toBeGreaterThan(afterFirstCommit);
    });
    await screen.findByText("All changes synced");

    repository.close();
  });
});

describe("SyncProvider: triggers 3 and 4", () => {
  it("trigger 3: a window focus event drains a mutation queued while the provider was already mounted", async () => {
    const fetchMock = stubFetch();
    const repository = createLocalRepository({ databaseName: `sync-provider-trigger3-${crypto.randomUUID()}` });
    renderHarness(repository);
    await screen.findByText("All changes synced");

    // Queue a mutation directly on the repository, bypassing the commit UI
    // (and therefore trigger 1), so only trigger 3 can be responsible for
    // draining it.
    await repository.commitAction({
      actionId: "queued-outside-react",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "ex-1", name: "ex-1" } }],
    });
    const beforeFocus = mutationCallCount(fetchMock);

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(mutationCallCount(fetchMock)).toBeGreaterThan(beforeFocus);
    });
    await screen.findByText("All changes synced");

    repository.close();
  });

  it("trigger 3: a visibilitychange to visible drains a mutation queued while the provider was already mounted", async () => {
    const fetchMock = stubFetch();
    const repository = createLocalRepository({ databaseName: `sync-provider-trigger3-visibility-${crypto.randomUUID()}` });
    renderHarness(repository);
    await screen.findByText("All changes synced");

    await repository.commitAction({
      actionId: "queued-outside-react",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "ex-1", name: "ex-1" } }],
    });
    const beforeVisible = mutationCallCount(fetchMock);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => {
      expect(mutationCallCount(fetchMock)).toBeGreaterThan(beforeVisible);
    });

    repository.close();
  });

  it("trigger 4: an online event drains a mutation queued while the provider was already mounted", async () => {
    const fetchMock = stubFetch();
    const repository = createLocalRepository({ databaseName: `sync-provider-trigger4-${crypto.randomUUID()}` });
    renderHarness(repository);
    await screen.findByText("All changes synced");

    await repository.commitAction({
      actionId: "queued-outside-react",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "ex-1", name: "ex-1" } }],
    });
    const beforeOnline = mutationCallCount(fetchMock);

    window.dispatchEvent(new Event("online"));

    await waitFor(() => {
      expect(mutationCallCount(fetchMock)).toBeGreaterThan(beforeOnline);
    });

    repository.close();
  });
});

describe("SyncProvider: SyncStatus and SyncRejectionBanner states", () => {
  it("shows the blocked state ('waiting on the server') for an unsupported_store retry, and 'Sync now' still runs a cycle", async () => {
    const fetchMock = stubFetch({
      mutationResults: (mutations) =>
        mutations.map((m) => ({
          mutation_id: m.mutation_id,
          status: "retry",
          code: "unsupported_store",
          retryable: true,
          detail: "This server does not synchronize resistance_sessions yet.",
        })),
    });
    const repository = createLocalRepository({ databaseName: `sync-provider-blocked-${crypto.randomUUID()}` });
    const user = userEvent.setup();
    renderHarness(repository);
    await screen.findByText("All changes synced");

    await user.click(screen.getByRole("button", { name: "Commit" }));
    await screen.findByText("Sync paused — waiting on the server");

    const beforeSyncNow = mutationCallCount(fetchMock);
    // `findByRole` (not `getByRole`): the trigger flurry the commit produced
    // (trigger 1, plus the gate-transition effect) coalesces into one queued
    // follow-up cycle behind the first, so the state can bounce back through
    // "syncing" briefly before settling on "blocked" again -- the same
    // mutation, still unsupported, is simply resent once more.
    await user.click(await screen.findByRole("button", { name: "Sync now" }));
    await waitFor(() => {
      expect(mutationCallCount(fetchMock)).toBeGreaterThan(beforeSyncNow);
    });
    // Still blocked -- head-of-line blocking is by design (docs/data-sync.md,
    // "Unsupported stores and versions"), not something a retry clears.
    // `findByText` (not `getByText`): "Sync now" itself started another
    // cycle that must first settle back to "blocked" from its own transient
    // "syncing".
    expect(await screen.findByText("Sync paused — waiting on the server")).toBeInTheDocument();

    repository.close();
  });

  it("shows the needs-attention banner for a rejected mutation, keeping the data and never resending it", async () => {
    const fetchMock = stubFetch({
      mutationResults: (mutations) =>
        mutations.map((m) => ({
          mutation_id: m.mutation_id,
          status: "rejected",
          code: "invalid_record",
          retryable: false,
          detail: "pain_min must be between 1 and 5",
        })),
    });
    const repository = createLocalRepository({ databaseName: `sync-provider-rejected-${crypto.randomUUID()}` });
    const user = userEvent.setup();
    renderHarness(repository);
    await screen.findByText("All changes synced");

    await user.click(screen.getByRole("button", { name: "Commit" }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("1 change could not be saved to your account");
    expect(banner).toHaveTextContent("pain_min must be between 1 and 5");
    // A rejected mutation is acknowledged as "handled" (not left pending),
    // so the status strip settles to synced rather than "pending"/"retrying".
    await screen.findByText("All changes synced");

    const afterRejection = mutationCallCount(fetchMock);
    // Confirms the rejected mutation is genuinely done, not silently
    // resent by an unrelated trigger.
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mutationCallCount(fetchMock)).toBe(afterRejection);

    repository.close();
  });
});

describe("SyncProvider: hardening -- UI refresh after a pull (issue #20 review)", () => {
  it("picks up a server-side closure applied by a pull without waiting for a focus event", async () => {
    const databaseName = `sync-provider-refresh-after-pull-${crypto.randomUUID()}`;
    // Seed an ACTIVE session directly, with its mutation already
    // acknowledged (no pending outbox entry), then close this connection --
    // mirrors production, where `LocalDataProvider` and `SyncProvider` each
    // open their own independent connection to the same IndexedDB database
    // (see `App.tsx`).
    const seed = createLocalRepository({ databaseName });
    await seed.commitAction({
      actionId: "start-session",
      changes: [
        { store: "walking_sessions", operation: "put", record: { id: "session-1", status: "ACTIVE", started_at: "2026-09-14T10:00:00.000Z" } },
      ],
    });
    await seed.acknowledgeOutbox("start-session");
    seed.close();

    const localRepository = createLocalRepository({ databaseName });
    const syncRepository = createLocalRepository({ databaseName });
    stubFetch({
      changes: () =>
        Response.json({
          changes: [
            {
              store: "walking_sessions",
              entity_type: "walking_session",
              entity_id: "session-1",
              change_seq: 1,
              record: {
                id: "session-1",
                status: "COMPLETED",
                completed_at: "2026-09-14T10:30:00.000Z",
                started_at: "2026-09-14T10:00:00.000Z",
                created_at: "2026-09-14T10:00:00.000Z",
                updated_at: "2026-09-14T10:30:00.000Z",
                deleted_at: null,
              },
            },
          ],
          cursor: 1,
          has_more: false,
        }),
    });

    renderHarness(localRepository, syncRepository);

    // Before the pull lands, LocalDataProvider's own mount-time read already
    // shows the session as ACTIVE (live/resumable).
    await waitFor(() => {
      expect(screen.getByLabelText("Active session count")).toHaveTextContent("1");
    });

    // Once `SyncProvider`'s pull (on its own, separate connection) applies
    // the server's closure, the session is no longer ACTIVE, so it drops out
    // of the bounded live snapshot -- but only if something refreshes
    // `LocalDataProvider`'s React state, since nothing here ever focuses the
    // window or commits anything.
    await waitFor(
      () => {
        expect(screen.getByLabelText("Active session count")).toHaveTextContent("0");
      },
      { timeout: 3000 },
    );

    localRepository.close();
    syncRepository.close();
  });
});
