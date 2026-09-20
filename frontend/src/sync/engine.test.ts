import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client";
import { createLocalRepository, SYNC_CURSOR_KEY, type LocalRepository, type OutboxEntry } from "../storage";
import { createSyncEngine } from "./engine";
import type { BootstrapResponse, ChangesResponse, MutationAck } from "./protocol";

let databaseNumber = 0;
const openRepositories: LocalRepository[] = [];

function repo(): LocalRepository {
  const result = createLocalRepository({
    databaseName: `sync-engine-test-${(databaseNumber++).toString()}`,
    indexedDB: new IDBFactory(),
  });
  openRepositories.push(result);
  return result;
}

afterEach(() => {
  for (const openRepo of openRepositories.splice(0)) {
    openRepo.close();
  }
});

function emptyBootstrap(): BootstrapResponse {
  return {
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
  };
}

function emptyChanges(): ChangesResponse {
  return { changes: [], cursor: 0, has_more: false };
}

function applied(mutationId: string): MutationAck {
  return { mutation_id: mutationId, status: "applied" };
}

function duplicate(mutationId: string): MutationAck {
  return { mutation_id: mutationId, status: "duplicate" };
}

function rejected(mutationId: string, code: string, detail: string): MutationAck {
  return { mutation_id: mutationId, status: "rejected", code, retryable: false, detail };
}

function retry(mutationId: string, code: string, detail: string): MutationAck {
  return { mutation_id: mutationId, status: "retry", code, retryable: true, detail };
}

async function putExercise(repository: LocalRepository, actionId: string, id: string): Promise<void> {
  await repository.commitAction({
    actionId,
    changes: [{ store: "exercise_registry", operation: "put", record: { id, name: id } }],
  });
}

/**
 * Waits out a fire-and-forget `trigger()` call's whole async chain.
 * `fake-indexeddb` settles its requests on a real macrotask, not merely a
 * microtask, so a plain `await Promise.resolve()` loop never lets one fire;
 * yielding through a real zero-delay timer on each turn does.
 */
async function flushAsync(turns = 50): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

describe("sync engine: outbox drain", () => {
  it("sends queued mutations in ascending sequence once the gate turns true (PAD-03 -> PAD-04)", async () => {
    const repository = repo();
    await putExercise(repository, "m1", "e1");
    await putExercise(repository, "m2", "e2");
    await putExercise(repository, "m3", "e3");

    let gate = false;
    const pushMutations = vi.fn((_clientId: string, mutations: readonly OutboxEntry[]) =>
      Promise.resolve(mutations.map((m) => applied(m.mutation_id))),
    );
    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => gate,
    });

    await engine.syncNow();
    expect(pushMutations).not.toHaveBeenCalled();
    expect(engine.getSnapshot().state).toBe("paused");
    await expect(repository.listPendingOutbox()).resolves.toHaveLength(3);

    gate = true;
    await engine.syncNow();

    expect(pushMutations).toHaveBeenCalledTimes(1);
    const [, sentMutations] = pushMutations.mock.calls[0] ?? [];
    expect(sentMutations?.map((m) => m.mutation_id)).toEqual(["m1", "m2", "m3"]);
    expect(sentMutations?.map((m) => m.sequence)).toEqual([1, 2, 3]);
    await expect(repository.listPendingOutbox()).resolves.toEqual([]);
    expect(engine.getSnapshot().state).toBe("synced");
  });

  it("resends a batch whose acknowledgement was lost; the resend comes back duplicate and is acknowledged exactly once (PAD-05)", async () => {
    const repository = repo();
    await putExercise(repository, "m1", "e1");

    let attempts = 0;
    const pushMutations = vi.fn((_clientId: string, mutations: readonly OutboxEntry[]) => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(new ApiError(0, "network", "lost response"));
      }
      return Promise.resolve(mutations.map((m) => duplicate(m.mutation_id)));
    });
    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
    });

    await engine.syncNow();
    expect(engine.getSnapshot().state).toBe("retrying");
    await expect(repository.listPendingOutbox()).resolves.toHaveLength(1);

    await engine.syncNow();
    expect(pushMutations).toHaveBeenCalledTimes(2);
    await expect(repository.listPendingOutbox()).resolves.toEqual([]);
    expect(engine.getSnapshot().state).toBe("synced");
  });

  it("coalesces overlapping triggers into exactly one in-flight drain and one queued follow-up", async () => {
    const repository = repo();
    await putExercise(repository, "m1", "e1");

    let releaseFirst: (() => void) | undefined;
    let concurrent = 0;
    let maxConcurrent = 0;
    const pushMutations = vi.fn(async (_clientId: string, mutations: readonly OutboxEntry[]) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      if (pushMutations.mock.calls.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      concurrent -= 1;
      return mutations.map((m) => applied(m.mutation_id));
    });
    const fetchBootstrap = vi.fn(() => Promise.resolve(emptyBootstrap()));
    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap,
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
    });

    engine.trigger();
    await flushAsync();
    expect(pushMutations).toHaveBeenCalledTimes(1);

    // Several more triggers arrive while the first drain is still in flight.
    engine.trigger();
    engine.trigger();
    engine.trigger();
    await flushAsync();
    // None of them started a second concurrent push.
    expect(pushMutations).toHaveBeenCalledTimes(1);

    releaseFirst?.();
    await flushAsync();

    // Exactly one coalesced follow-up ran (not three): the outbox was already
    // empty by then, so its own drain sent nothing, but its pull phase still
    // ran, proving a second *cycle* happened -- once, not "however many
    // triggers fired".
    expect(fetchBootstrap).toHaveBeenCalledTimes(2);
    expect(pushMutations).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);
  });

  it("a retry result stops the batch: it and everything after it stay queued, and the next attempt resumes from it", async () => {
    const repository = repo();
    await putExercise(repository, "m1", "e1");
    await putExercise(repository, "m2", "e2");
    await putExercise(repository, "m3", "e3");

    let attempt = 0;
    const pushMutations = vi.fn((_clientId: string, mutations: readonly OutboxEntry[]) => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve([applied("m1"), retry("m2", "temporarily_unavailable", "lock not granted")]);
      }
      return Promise.resolve(mutations.map((m) => applied(m.mutation_id)));
    });
    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
    });

    await engine.syncNow();
    await expect(repository.listPendingOutbox()).resolves.toEqual([
      expect.objectContaining({ mutation_id: "m2" }),
      expect.objectContaining({ mutation_id: "m3" }),
    ]);

    await engine.syncNow();
    const [, secondBatch] = pushMutations.mock.calls[1] ?? [];
    expect(secondBatch?.map((m) => m.mutation_id)).toEqual(["m2", "m3"]);
    await expect(repository.listPendingOutbox()).resolves.toEqual([]);
  });

  it("a rejected result keeps the data, marks attention, does not stop the batch, and is never retried", async () => {
    const repository = repo();
    await putExercise(repository, "m1", "e1");
    await putExercise(repository, "m2", "e2");

    const pushMutations = vi.fn(() =>
      Promise.resolve([rejected("m1", "invalid_record", "e1 is unusable"), applied("m2")]),
    );
    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
    });

    await engine.syncNow();

    // m2 applied, m1 excluded because it is rejected -- neither is "pending".
    await expect(repository.listPendingOutbox()).resolves.toEqual([]);
    const rejectedEntries = await repository.listRejectedOutbox();
    expect(rejectedEntries).toMatchObject([
      { mutation_id: "m1", rejection: { code: "invalid_record", detail: "e1 is unusable" } },
    ]);
    expect(engine.getSnapshot().rejectedCount).toBe(1);
    await expect(repository.getRecord("exercise_registry", "e1")).resolves.toMatchObject({ id: "e1" });

    // A later attempt must never resend m1: nothing is pending any more, so
    // no push happens at all.
    await engine.syncNow();
    expect(pushMutations).toHaveBeenCalledTimes(1);
  });

  it("a rejected parent's dependent mutation is rejected in turn, losing neither record", async () => {
    const repository = repo();
    await repository.commitAction({
      actionId: "create-session",
      changes: [{ store: "walking_sessions", operation: "put", record: { id: "session-1", status: "ACTIVE" } }],
    });
    await repository.commitAction({
      actionId: "create-bout",
      changes: [
        {
          store: "walking_bouts",
          operation: "put",
          record: { id: "bout-1", walking_session_id: "session-1", started_at: "2026-09-14T10:00:00.000Z" },
        },
      ],
    });

    const pushMutations = vi.fn(() =>
      Promise.resolve([
        rejected("create-session", "invalid_record", "bad session"),
        rejected("create-bout", "parent_not_found", "session-1 not found"),
      ]),
    );
    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
    });

    await engine.syncNow();

    const rejectedIds = (await repository.listRejectedOutbox()).map((entry) => entry.mutation_id).sort();
    expect(rejectedIds).toEqual(["create-bout", "create-session"]);
    await expect(repository.getRecord("walking_sessions", "session-1")).resolves.toBeDefined();
    await expect(repository.getRecord("walking_bouts", "bout-1")).resolves.toBeDefined();
  });

  it("stops and stays paused on a 401 mid-drain, acknowledging nothing, and resumes once re-authenticated", async () => {
    const repository = repo();
    await putExercise(repository, "m1", "e1");
    await putExercise(repository, "m2", "e2");

    let attempt = 0;
    const pushMutations = vi.fn((_clientId: string, mutations: readonly OutboxEntry[]) => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(new ApiError(401, "not_authenticated"));
      }
      return Promise.resolve(mutations.map((m) => applied(m.mutation_id)));
    });
    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
    });

    await engine.syncNow();
    expect(engine.getSnapshot().state).toBe("paused");
    await expect(repository.listPendingOutbox()).resolves.toHaveLength(2);

    // Re-login: the next attempt (trigger 4, auth becoming authenticated)
    // resumes and drains everything queued.
    await engine.syncNow();
    expect(pushMutations).toHaveBeenCalledTimes(2);
    await expect(repository.listPendingOutbox()).resolves.toEqual([]);
    expect(engine.getSnapshot().state).toBe("synced");
  });
});

describe("sync engine: backoff", () => {
  // Deterministic by construction, not by racing real (or faked) timers
  // against `fake-indexeddb`'s own scheduling (the previous version of this
  // test read `Date.now()` against a real elapsed interval and asserted
  // within a +/-500ms window -- the most plausible CI flake in the suite).
  // Two changes fix that:
  //  - An injected `clock` that never advances: `nextRetryAt` is computed
  //    from it (`scheduleRetry` -> `nowIso(clock.now() + delay)`), so
  //    comparing the two is an exact integer subtraction, never a race
  //    against real elapsed time.
  //  - The engine's *own* real `setTimeout` is still what advances it to the
  //    next cycle (this deliberately does not call `engine.dispose()`
  //    mid-test to skip it -- `dispose()` is now terminal, see the M5 fix in
  //    `engine.ts`, and disposing then re-triggering would make `runCycle`
  //    a permanent no-op). Backoff bounds are kept small (tens of ms) purely
  //    so waiting the real delay out stays fast, not because it changes what
  //    is being proven; production values are 5s/5min.
  it("backs off exponentially on repeated transient failures, capped, and resets on success", async () => {
    const repository = repo();
    await putExercise(repository, "m1", "e1");

    let succeed = false;
    const pushMutations = vi.fn((_clientId: string, mutations: readonly OutboxEntry[]) => {
      if (!succeed) {
        return Promise.reject(new ApiError(0, "network", "down"));
      }
      return Promise.resolve(mutations.map((m) => applied(m.mutation_id)));
    });
    const FIXED_NOW = Date.UTC(2026, 0, 1);
    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
      random: () => 0.5, // neutralizes jitter: factor 1
      clock: { now: () => FIXED_NOW },
      initialBackoffMs: 100,
      maxBackoffMs: 400,
    });

    function nextDelayMs(): number {
      const nextRetryAt = engine.getSnapshot().nextRetryAt;
      expect(nextRetryAt).not.toBeNull();
      return Date.parse(nextRetryAt ?? "") - FIXED_NOW;
    }

    // Waits out the currently-scheduled real retry timer (a generous margin
    // over its known delay, never a race: the wait is a lower bound, so a
    // slow CI host makes this slower, not flaky) and lets the cycle it
    // triggers settle (fake-indexeddb resolves its requests on real
    // macrotasks, not merely microtasks -- see `flushAsync`).
    async function waitOutScheduledRetry(): Promise<void> {
      const delay = nextDelayMs();
      await new Promise((resolve) => setTimeout(resolve, delay + 40));
      await flushAsync(20);
    }

    await engine.syncNow();
    expect(engine.getSnapshot().state).toBe("retrying");
    expect(nextDelayMs()).toBe(100);

    await waitOutScheduledRetry();
    expect(nextDelayMs()).toBe(200);

    await waitOutScheduledRetry();
    expect(nextDelayMs()).toBe(400); // capped: would be 400 uncapped too, next proves the cap actually held

    await waitOutScheduledRetry();
    expect(nextDelayMs()).toBe(400); // still capped, not 800

    succeed = true;
    await waitOutScheduledRetry();
    expect(engine.getSnapshot().state).toBe("synced");
    expect(engine.getSnapshot().nextRetryAt).toBeNull();

    // Reset: the next failure starts back at ~40ms, not the 160ms cap.
    succeed = false;
    await putExercise(repository, "m2", "e2");
    engine.trigger();
    await flushAsync();
    expect(nextDelayMs()).toBe(100);

    engine.dispose();
  });

  it("does not reset the backoff on a partial drain (a retry/unsupported-store result), so repeated blocked cycles climb toward the cap (M4)", async () => {
    // Reproduces the bug this fix closes: resetting backoff unconditionally
    // before every pull -- regardless of whether the drain actually cleared
    // -- made a blocked queue retry at a flat ~initialBackoffMs forever
    // (measured in production: [1000, 1000, 1000, 1000], a push + a
    // bootstrap + a changes request every 5s indefinitely).
    const repository = repo();
    await putExercise(repository, "m1", "e1");

    // Every push comes back `retry`/`unsupported_store`: the batch never
    // clears, so `drainOutbox` always returns `kind: "partial"`.
    const pushMutations = vi.fn((_clientId: string, mutations: readonly OutboxEntry[]) =>
      Promise.resolve(mutations.map((m) => retry(m.mutation_id, "unsupported_store", "not yet"))),
    );
    const FIXED_NOW = Date.UTC(2026, 0, 1);
    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
      random: () => 0.5,
      clock: { now: () => FIXED_NOW },
      initialBackoffMs: 100,
      maxBackoffMs: 400,
    });

    function nextDelayMs(): number {
      const nextRetryAt = engine.getSnapshot().nextRetryAt;
      expect(nextRetryAt).not.toBeNull();
      return Date.parse(nextRetryAt ?? "") - FIXED_NOW;
    }

    async function waitOutScheduledRetry(): Promise<void> {
      const delay = nextDelayMs();
      await new Promise((resolve) => setTimeout(resolve, delay + 40));
      await flushAsync(20);
    }

    await engine.syncNow();
    expect(engine.getSnapshot().state).toBe("blocked");
    expect(nextDelayMs()).toBe(100);

    await waitOutScheduledRetry();
    expect(engine.getSnapshot().state).toBe("blocked");
    // Before the fix this was 40 again every time (backoff reset before the
    // pull on every cycle, partial or not); it must now have doubled.
    expect(nextDelayMs()).toBe(200);

    await waitOutScheduledRetry();
    expect(nextDelayMs()).toBe(400); // capped

    engine.dispose();
  });

  it("does not reset the backoff when the outbox is empty but the pull keeps failing, so repeated cycles climb toward the cap (M4 completion)", async () => {
    // The other half of M4: `drainOutbox` returns `kind: "clear"` trivially
    // whenever nothing is queued, so resetting backoff before attempting the
    // pull reset it on *every* cycle regardless of whether the pull itself
    // was succeeding -- the same flat ~5s retry loop the partial-drain case
    // above reproduces, just reached through the pull path instead of the
    // drain path (a bootstrap + a changes request every ~5s indefinitely on
    // a phone against a 120/min throttle).
    const repository = repo(); // nothing committed: the outbox is empty

    const fetchChanges = vi.fn(() => Promise.reject(new ApiError(0, "network", "down")));
    const FIXED_NOW = Date.UTC(2026, 0, 1);
    const engine = createSyncEngine({
      repository,
      pushMutations: () => Promise.resolve([]),
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges,
      canSync: () => true,
      random: () => 0.5,
      clock: { now: () => FIXED_NOW },
      initialBackoffMs: 40,
      maxBackoffMs: 160,
    });

    function nextDelayMs(): number {
      const nextRetryAt = engine.getSnapshot().nextRetryAt;
      expect(nextRetryAt).not.toBeNull();
      return Date.parse(nextRetryAt ?? "") - FIXED_NOW;
    }

    async function waitOutScheduledRetry(): Promise<void> {
      const delay = nextDelayMs();
      await new Promise((resolve) => setTimeout(resolve, delay + 40));
      await flushAsync(20);
    }

    await engine.syncNow();
    expect(engine.getSnapshot().state).toBe("retrying");
    expect(nextDelayMs()).toBe(40);

    await waitOutScheduledRetry();
    // Before this fix, `drainOutbox` trivially returning `kind: "clear"`
    // (nothing queued) reset the backoff before every pull attempt, so this
    // stayed 40 forever no matter how many times the pull itself failed.
    expect(nextDelayMs()).toBe(80);

    await waitOutScheduledRetry();
    expect(nextDelayMs()).toBe(160); // capped

    engine.dispose();
  });
});

describe("sync engine: changes feed", () => {
  it("pulls the feed in pages, applies a child before its parent, and durably resumes an interrupted pull without skipping", async () => {
    const factory = new IDBFactory();
    const databaseName = `sync-engine-pages-${(databaseNumber++).toString()}`;
    const repository = createLocalRepository({ indexedDB: factory, databaseName });
    openRepositories.push(repository);

    const childBout = {
      store: "walking_bouts" as const,
      entity_type: "walking_bout",
      entity_id: "bout-1",
      change_seq: 1,
      record: {
        id: "bout-1",
        walking_session_id: "session-1",
        started_at: "2026-09-14T10:00:00.000Z",
        ended_at: null,
        created_at: "2026-09-14T10:00:00.000Z",
        updated_at: "2026-09-14T10:00:00.000Z",
        deleted_at: null,
      },
    };
    const parentSession = {
      store: "walking_sessions" as const,
      entity_type: "walking_session",
      entity_id: "session-1",
      change_seq: 2,
      record: {
        id: "session-1",
        status: "COMPLETED",
        completed_at: "2026-09-14T10:30:00.000Z",
        created_at: "2026-09-14T09:00:00.000Z",
        updated_at: "2026-09-14T10:30:00.000Z",
        deleted_at: null,
      },
    };

    let call = 0;
    const fetchChanges = vi.fn((since: number) => {
      call += 1;
      if (call === 1) {
        expect(since).toBe(0);
        return Promise.resolve({ changes: [childBout], cursor: 1, has_more: true });
      }
      if (call === 2) {
        expect(since).toBe(1);
        return Promise.reject(new ApiError(0, "network", "dropped mid-pull"));
      }
      expect(since).toBe(1); // resumed from the same page, not skipped ahead
      return Promise.resolve({ changes: [parentSession], cursor: 2, has_more: false });
    });

    const engine = createSyncEngine({
      repository,
      pushMutations: () => Promise.resolve([]),
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges,
      canSync: () => true,
    });

    await engine.syncNow();
    expect(engine.getSnapshot().state).toBe("retrying");
    await expect(repository.getRecord("walking_bouts", "bout-1")).resolves.toBeDefined();
    await expect(repository.getSyncMetadata(SYNC_CURSOR_KEY)).resolves.toBe(1);

    await engine.syncNow();
    expect(call).toBe(3);
    await expect(repository.getRecord("walking_sessions", "session-1")).resolves.toMatchObject({
      status: "COMPLETED",
    });
    await expect(repository.getSyncMetadata(SYNC_CURSOR_KEY)).resolves.toBe(2);

    repository.close();
    const reopened = createLocalRepository({ indexedDB: factory, databaseName });
    openRepositories.push(reopened);
    await expect(reopened.getSyncMetadata(SYNC_CURSOR_KEY)).resolves.toBe(2);
  });

  it("protects a record with a pending mutation from the feed except a server-side closure, and preserves local-only fields elsewhere", async () => {
    const repository = repo();
    await repository.commitAction({
      actionId: "local-pending",
      changes: [
        { store: "walking_sessions", operation: "put", record: { id: "session-1", status: "ACTIVE", speed_kmh: 5 } },
      ],
    });
    await repository.commitAction({
      actionId: "synced-earlier",
      changes: [
        {
          store: "walking_bouts",
          operation: "put",
          record: {
            id: "bout-2",
            walking_session_id: "session-2",
            started_at: "2026-09-14T09:00:00.000Z",
            local_only_hint: "keep-me",
          },
        },
      ],
    });
    await repository.acknowledgeOutbox("synced-earlier");

    const pushMutations = vi.fn((_clientId: string, mutations: readonly OutboxEntry[]) =>
      Promise.resolve(mutations.map((m) => retry(m.mutation_id, "temporarily_unavailable", "db hiccup"))),
    );
    const fetchChanges = vi.fn(() =>
      Promise.resolve({
        changes: [
          {
            store: "walking_sessions" as const,
            entity_type: "walking_session",
            entity_id: "session-1",
            change_seq: 1,
            record: {
              id: "session-1",
              status: "COMPLETED",
              completed_at: "2026-09-14T10:30:00.000Z",
              speed_kmh: 999,
              created_at: "2026-09-14T09:00:00.000Z",
              updated_at: "2026-09-14T10:30:00.000Z",
              deleted_at: null,
            },
          },
          {
            store: "walking_bouts" as const,
            entity_type: "walking_bout",
            entity_id: "bout-2",
            change_seq: 1,
            record: {
              id: "bout-2",
              walking_session_id: "session-2",
              started_at: "2026-09-14T09:00:00.000Z",
              ended_at: "2026-09-14T09:30:00.000Z",
              created_at: "2026-09-14T09:00:00.000Z",
              updated_at: "2026-09-14T09:30:00.000Z",
              deleted_at: null,
            },
          },
        ],
        cursor: 1,
        has_more: false,
      }),
    );

    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges,
      canSync: () => true,
    });
    await engine.syncNow();

    const session1 = await repository.getRecord("walking_sessions", "session-1");
    expect(session1).toMatchObject({ status: "COMPLETED", completed_at: "2026-09-14T10:30:00.000Z" });
    // The pending mutation's own value wins over the feed's stale 999.
    expect(session1?.speed_kmh).toBe(5);

    const bout2 = await repository.getRecord("walking_bouts", "bout-2");
    expect(bout2).toMatchObject({ ended_at: "2026-09-14T09:30:00.000Z", local_only_hint: "keep-me" });

    await expect(repository.listPendingOutbox()).resolves.toEqual([
      expect.objectContaining({ mutation_id: "local-pending" }),
    ]);
  });

  it("replaces cached PAD defaults from bootstrap while local work is pending, without touching the pending mutation", async () => {
    const repository = repo();
    await repository.commitAction({
      actionId: "local-pending",
      changes: [{ store: "walking_sessions", operation: "put", record: { id: "session-1", status: "ACTIVE" } }],
    });
    await repository.writeReferenceCache("pad_defaults", { speed_kmh: 4, incline_pct: 1, max_bout_seconds: 300 });

    const pushMutations = vi.fn((_clientId: string, mutations: readonly OutboxEntry[]) =>
      Promise.resolve(mutations.map((m) => retry(m.mutation_id, "temporarily_unavailable", "db hiccup"))),
    );
    const fetchBootstrap = vi.fn(() =>
      Promise.resolve({
        cursor: 0,
        limits: { max_mutations_per_request: 50, max_changes_per_mutation: 500 },
        pad: {
          defaults: { speed_kmh: 6, incline_pct: 3, max_bout_seconds: 600 },
          next_session_settings: {
            source: "defaults" as const,
            walking_session_id: null,
            speed_kmh: 6,
            incline_pct: 3,
            max_bout_seconds: 600,
          },
        },
      }),
    );

    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap,
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
    });
    await engine.syncNow();

    await expect(repository.readReferenceCache("pad_defaults")).resolves.toEqual({
      speed_kmh: 6,
      incline_pct: 3,
      max_bout_seconds: 600,
    });
    await expect(repository.listPendingOutbox()).resolves.toEqual([
      expect.objectContaining({ mutation_id: "local-pending" }),
    ]);
  });
});

describe("sync engine: hardening (issue #20 review)", () => {
  it("dispose() stops a cycle already in flight from scheduling a further retry or running again (M5)", async () => {
    const repository = repo();
    await putExercise(repository, "m1", "e1");

    let releasePush!: () => void;
    const pushGate = new Promise<void>((resolve) => {
      releasePush = resolve;
    });
    const pushMutations = vi.fn(async () => {
      await pushGate;
      throw new ApiError(0, "network", "down");
    });

    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
    });

    engine.trigger(); // starts a cycle; pushMutations is now awaiting `pushGate`.
    await flushAsync(10);
    expect(pushMutations).toHaveBeenCalledTimes(1);

    // Dispose while the network call is still in flight -- exactly the
    // "unmount with work in flight" scenario the review reproduced (14
    // further pushes observed 300ms after dispose).
    engine.dispose();
    releasePush();
    await flushAsync(20);

    // Before the fix, `scheduleRetry()` had no `disposed` guard: the in-
    // flight cycle would still arm a real timer here.
    expect(engine.getSnapshot().nextRetryAt).toBeNull();

    // And no further cycle ever runs after dispose -- not from a (never-
    // armed) timer, and not from a stray `trigger()` either, since
    // `runCycle` itself is now a no-op once disposed.
    engine.trigger();
    await flushAsync(20);
    expect(pushMutations).toHaveBeenCalledTimes(1);
  });

  it("bails out of the changes-feed loop as a failure instead of spinning forever when a page's cursor does not advance (M6)", async () => {
    const repository = repo();
    const fetchChanges = vi.fn(() => Promise.resolve({ changes: [], cursor: 0, has_more: true }));
    const engine = createSyncEngine({
      repository,
      pushMutations: () => Promise.resolve([]),
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges,
      canSync: () => true,
    });

    await engine.syncNow();

    expect(engine.getSnapshot().state).toBe("retrying");
    // Exactly one request, not the 2000+ a broken response spinning on a
    // stuck cursor produced before this guard, holding the device lock
    // throughout.
    expect(fetchChanges).toHaveBeenCalledTimes(1);
  });

  it("does not treat a legitimate 'nothing new' page (cursor unchanged, has_more false) as a failure (M6 guard scoping)", async () => {
    const repository = repo();
    const engine = createSyncEngine({
      repository,
      pushMutations: () => Promise.resolve([]),
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve({ changes: [], cursor: 0, has_more: false }),
      canSync: () => true,
    });

    await engine.syncNow();

    expect(engine.getSnapshot().state).toBe("synced");
  });

  it("clamps a malformed max_mutations_per_request from bootstrap so the batch is never empty (M7)", async () => {
    const repository = repo();
    await putExercise(repository, "m1", "e1");
    await putExercise(repository, "m2", "e2");

    const pushMutations = vi.fn((_clientId: string, mutations: readonly OutboxEntry[]) => {
      if (mutations.length === 0) {
        // Mirrors the real API: an empty mutations array is a 400
        // `invalid_request` (docs/data-sync.md, "Request-level errors").
        return Promise.reject(new ApiError(400, "invalid_request", "mutations empty"));
      }
      return Promise.resolve(mutations.map((m) => applied(m.mutation_id)));
    });
    // Malformed: 0 is `Number.isFinite`, so it passes `isSyncLimits`, but
    // must not be allowed to shrink the next batch to nothing.
    const fetchBootstrap = () =>
      Promise.resolve({
        ...emptyBootstrap(),
        limits: { max_mutations_per_request: 0, max_changes_per_mutation: 500 },
      });

    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap,
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
    });

    // First cycle: drain runs before the pull that learns the bad limit, so
    // it still uses the default (50) and clears both mutations normally.
    await engine.syncNow();
    expect(pushMutations.mock.calls[0]?.[1]).toHaveLength(2);
    expect(engine.getSnapshot().state).toBe("synced");

    // Second cycle: the bad limit is now in effect. Without the clamp,
    // `maxMutationsPerRequest` would be 0, the batch would be `[]`, and the
    // mock above (mirroring the real API) would reject it, wedging the
    // outbox on this same empty batch forever.
    await putExercise(repository, "m3", "e3");
    await engine.syncNow();
    expect(pushMutations.mock.calls[1]?.[1].length).toBeGreaterThan(0);
    expect(engine.getSnapshot().state).toBe("synced");
  });

  it("halves the batch size on a 413 request_too_large instead of resending the identical too-large batch forever (suspected hardening)", async () => {
    const repository = repo();
    for (let i = 0; i < 30; i += 1) {
      await putExercise(repository, `m${i.toString()}`, `e${i.toString()}`);
    }

    let calls = 0;
    const pushMutations = vi.fn((_clientId: string, mutations: readonly OutboxEntry[]) => {
      calls += 1;
      if (calls === 1) {
        // The client's `ApiErrorCode` union does not model every server code
        // (see `frontend/src/api/client.ts`'s `isKnownCode`); a real 413
        // maps to `"unknown"` there. The engine's own 413 handling keys off
        // `error.status`, not `error.code`, so this still exercises it.
        return Promise.reject(new ApiError(413, "unknown", "send fewer per request"));
      }
      return Promise.resolve(mutations.map((m) => applied(m.mutation_id)));
    });

    const engine = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
      initialBackoffMs: 5,
      maxBackoffMs: 20,
    });

    await engine.syncNow();
    expect(pushMutations.mock.calls[0]?.[1]).toHaveLength(30); // the default cap (50) never limited this batch
    expect(engine.getSnapshot().state).toBe("retrying");
    await expect(repository.listPendingOutbox()).resolves.toHaveLength(30); // nothing acknowledged on a 413

    await engine.syncNow();
    // Halved from the default 50 to 25 by the 413 handler, so the retried
    // batch is smaller than the full 30 still queued -- not identical to the
    // one the server just rejected as too large.
    expect(pushMutations.mock.calls[1]?.[1]).toHaveLength(25);

    engine.dispose();
  });

  it("serializes drains across two engines in one tab when navigator.locks is unavailable (suspected hardening: fallbackChain hoisted to module scope)", async () => {
    // jsdom does not implement the Web Locks API (see the file's own note in
    // `docs/plans/issue-20-outbox-drain.md`, "Known limitations"), so both
    // engines below go through the in-process fallback chain -- which must
    // now be shared module-wide, not per-engine, for this to hold.
    expect(typeof (globalThis.navigator as { locks?: unknown }).locks).toBe("undefined");

    const repositoryA = repo();
    const repositoryB = repo();
    await putExercise(repositoryA, "a1", "ea1");
    await putExercise(repositoryB, "b1", "eb1");

    let concurrent = 0;
    let maxConcurrent = 0;
    function makePush() {
      return vi.fn(async (_clientId: string, mutations: readonly OutboxEntry[]) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
        return mutations.map((m) => applied(m.mutation_id));
      });
    }

    const engineA = createSyncEngine({
      repository: repositoryA,
      pushMutations: makePush(),
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
    });
    const engineB = createSyncEngine({
      repository: repositoryB,
      pushMutations: makePush(),
      fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
      fetchChanges: () => Promise.resolve(emptyChanges()),
      canSync: () => true,
    });

    await Promise.all([engineA.syncNow(), engineB.syncNow()]);

    // Before the fix, `fallbackChain` was a variable inside `createSyncEngine`
    // (per-engine), so these two engines' pushes could overlap.
    expect(maxConcurrent).toBe(1);

    engineA.dispose();
    engineB.dispose();
  });

  it("trigger() never produces an unhandled rejection when the Web Locks API throws synchronously (suspected hardening)", async () => {
    const repository = repo();
    // Adds a `locks` property directly to the real `navigator` (a class
    // instance in jsdom -- spreading it would lose its prototype), rather
    // than replacing the whole object.
    Object.defineProperty(globalThis.navigator, "locks", {
      value: {
        request: () => {
          throw new Error("locks unavailable");
        },
      },
      configurable: true,
    });

    try {
      const engine = createSyncEngine({
        repository,
        pushMutations: () => Promise.resolve([]),
        fetchBootstrap: () => Promise.resolve(emptyBootstrap()),
        fetchChanges: () => Promise.resolve(emptyChanges()),
        canSync: () => true,
      });

      // `trigger()` is fire-and-forget; the assertion here is really that
      // this test finishes without vitest reporting an unhandled rejection
      // (it would, without the `.catch(() => undefined)` this hardens).
      expect(() => {
        engine.trigger();
      }).not.toThrow();
      await flushAsync(5);

      engine.dispose();
    } finally {
      delete (globalThis.navigator as { locks?: unknown }).locks;
    }
  });
});
