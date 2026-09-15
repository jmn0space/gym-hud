import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  ActiveSessionConflictError,
  createLocalRepository,
  DATABASE_STORES,
  DATABASE_VERSION,
  DOMAIN_STORES,
  LocalStorageError,
  OUTBOX_SEQUENCE_INDEX,
  type DomainStore,
  type OutboxEntry,
} from "./index";

function openLegacyDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onerror = () => {
      reject(request.error ?? new Error("Opening the legacy database failed"));
    };
    request.onupgradeneeded = () => {
      const database = request.result;
      const sessions = database.createObjectStore("walking_sessions", { keyPath: "id" });
      const outbox = database.createObjectStore(DATABASE_STORES.outbox, {
        keyPath: "mutation_id",
      });
      database.createObjectStore(DATABASE_STORES.actionReceipts, { keyPath: "actionId" });

      const persistedRecord = {
        id: "legacy-session",
        status: "COMPLETED",
        created_at: "2026-09-01T10:00:00.000Z",
        updated_at: "2026-09-01T10:00:00.000Z",
        deleted_at: null,
      };
      sessions.add(persistedRecord);
      outbox.add({
        version: 1,
        mutation_id: "legacy-action",
        sequence: 7,
        created_at: "2026-09-01T10:00:00.000Z",
        changes: [
          {
            store: "walking_sessions",
            entity_type: "walking_session",
            entity_id: "legacy-session",
            operation: "put",
            record: persistedRecord,
          },
        ],
      });
      request.transaction?.objectStore(DATABASE_STORES.actionReceipts).add({
        actionId: "legacy-action",
        sequence: 7,
        committedAt: "2026-09-01T10:00:00.000Z",
        fingerprint:
          '{"changes":[{"operation":"put","record":{"id":"legacy-session","status":"COMPLETED"},"store":"walking_sessions"}],"preconditions":[]}',
      });
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

/** Builds a v2 database (pre-active-markers, pre-parent-indexes) directly. */
function openV2Database(
  factory: IDBFactory,
  name: string,
  seed: {
    sessions?: { id: string; status: string; updated_at?: string }[];
    bouts?: { id: string; walking_session_id: string; ended_at: string | null }[];
    outbox?: OutboxEntry[];
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 2);
    request.onerror = () => {
      reject(request.error ?? new Error("Opening the v2 database failed"));
    };
    request.onupgradeneeded = () => {
      const database = request.result;
      const domainStores = [
        "walking_sessions",
        "walking_bouts",
        "walking_pauses",
        "walking_rests",
        "resistance_sessions",
        "resistance_rows",
        "cardio_sessions",
        "routine_templates",
        "routine_exercises",
        "exercise_registry",
      ] as const satisfies readonly DomainStore[];
      for (const store of domainStores) {
        database.createObjectStore(store, { keyPath: "id" });
      }
      const outbox = database.createObjectStore(DATABASE_STORES.outbox, { keyPath: "mutation_id" });
      outbox.createIndex(OUTBOX_SEQUENCE_INDEX, "sequence", { unique: true });
      database.createObjectStore(DATABASE_STORES.actionReceipts, { keyPath: "actionId" });
      database.createObjectStore(DATABASE_STORES.internalMetadata, { keyPath: "key" });
      database.createObjectStore(DATABASE_STORES.syncMetadata, { keyPath: "key" });
      database.createObjectStore(DATABASE_STORES.referenceData, { keyPath: "key" });

      const transaction = request.transaction;
      if (transaction === null) {
        return;
      }
      const timestamp = "2026-09-01T10:00:00.000Z";
      for (const session of seed.sessions ?? []) {
        transaction.objectStore("walking_sessions").add({
          ...session,
          created_at: timestamp,
          updated_at: session.updated_at ?? timestamp,
          deleted_at: null,
        });
      }
      for (const bout of seed.bouts ?? []) {
        transaction.objectStore("walking_bouts").add({
          ...bout,
          created_at: timestamp,
          updated_at: timestamp,
          deleted_at: null,
        });
      }
      for (const entry of seed.outbox ?? []) {
        transaction.objectStore(DATABASE_STORES.outbox).add(entry);
      }
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
}

function inspectDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onerror = () => {
      reject(request.error ?? new Error("Opening the migrated database failed"));
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

function openDatabaseAtVersion(
  factory: IDBFactory,
  name: string,
  version: number,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, version);
    request.onerror = () => {
      reject(request.error ?? new Error("Opening the database failed"));
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
  });
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onerror = () => {
      reject(request.error ?? new Error("Deleting the database failed"));
    };
    request.onblocked = () => {
      reject(new Error("Deleting the database was blocked by a leaked connection"));
    };
    request.onsuccess = () => {
      resolve();
    };
  });
}

describe("IndexedDB schema migration", () => {
  it("upgrades v1 non-destructively and continues sequence and receipt deduplication", async () => {
    const factory = new IDBFactory();
    const databaseName = "migration-v1-to-current";
    await openLegacyDatabase(factory, databaseName);

    const repo = createLocalRepository({
      databaseName,
      indexedDB: factory,
      now: () => new Date("2026-09-14T10:00:00.000Z"),
      uuid: () => "migrated-client",
    });
    const snapshot = await repo.readSnapshot();
    // The bounded v3 snapshot only returns live ACTIVE sessions; the legacy
    // session is COMPLETED, so it is outside snapshot scope even though it is
    // still fully persisted (verified below through the full-history accessor).
    expect(snapshot.records.walking_sessions).toEqual([]);
    expect(snapshot.pendingOutbox).toEqual([
      expect.objectContaining({ mutation_id: "legacy-action", sequence: 7 }),
    ]);
    await expect(repo.listRecords("walking_sessions")).resolves.toEqual([
      expect.objectContaining({ id: "legacy-session", status: "COMPLETED" }),
    ]);

    await expect(
      repo.commitAction({
        actionId: "legacy-action",
        changes: [
          {
            store: "walking_sessions",
            operation: "put",
            record: { id: "legacy-session", status: "COMPLETED" },
          },
        ],
      }),
    ).resolves.toEqual({
      actionId: "legacy-action",
      sequence: 7,
      committedAt: "2026-09-01T10:00:00.000Z",
    });
    await expect(
      repo.commitAction({
        actionId: "post-migration-action",
        changes: [
          {
            store: "exercise_registry",
            operation: "put",
            record: { id: "post-migration-exercise", name: "Arm Crank" },
          },
        ],
      }),
    ).resolves.toMatchObject({ sequence: 8 });

    repo.close();
    await Promise.resolve();
    const database = await inspectDatabase(factory, databaseName);
    expect(database.version).toBe(DATABASE_VERSION);
    expect([...database.objectStoreNames].sort()).toEqual(
      [...DOMAIN_STORES, ...Object.values(DATABASE_STORES)].sort(),
    );
    const transaction = database.transaction(DATABASE_STORES.outbox, "readonly");
    expect(
      transaction.objectStore(DATABASE_STORES.outbox).indexNames.contains(OUTBOX_SEQUENCE_INDEX),
    ).toBe(true);
    database.close();
  });

  it("upgrades v2 non-destructively, backfilling active markers and parent indexes", async () => {
    const factory = new IDBFactory();
    const databaseName = "migration-v2-to-current";
    await openV2Database(factory, databaseName, {
      sessions: [{ id: "pad-1", status: "ACTIVE" }],
      bouts: [{ id: "bout-1", walking_session_id: "pad-1", ended_at: null }],
      outbox: [
        {
          version: 1,
          mutation_id: "seed-outbox-entry",
          sequence: 3,
          created_at: "2026-09-01T10:00:00.000Z",
          changes: [
            {
              store: "walking_sessions",
              entity_type: "walking_session",
              entity_id: "pad-1",
              operation: "put",
              record: { id: "pad-1", status: "ACTIVE" },
            },
          ],
        },
      ],
    });

    const repo = createLocalRepository({
      databaseName,
      indexedDB: factory,
      now: () => new Date("2026-09-14T10:00:00.000Z"),
    });

    // The active session and its open bout must still be reachable, and the
    // pending outbox entry must survive the upgrade.
    const snapshot = await repo.readSnapshot();
    expect(snapshot.records.walking_sessions).toEqual([
      expect.objectContaining({ id: "pad-1", status: "ACTIVE" }),
    ]);
    expect(snapshot.records.walking_bouts).toEqual([
      expect.objectContaining({ id: "bout-1", walking_session_id: "pad-1" }),
    ]);
    expect(snapshot.pendingOutbox).toEqual([
      expect.objectContaining({ mutation_id: "seed-outbox-entry", sequence: 3 }),
    ]);

    // The active-session and open-bout constraints must still hold: the
    // backfilled marker rejects a second active walking session and a second
    // open bout under the same session.
    await expect(
      repo.commitAction({
        actionId: "second-active-session",
        preconditions: [{ store: "walking_sessions", id: "pad-2", expected: null }],
        changes: [
          { store: "walking_sessions", operation: "put", record: { id: "pad-2", status: "ACTIVE" } },
        ],
      }),
    ).rejects.toBeInstanceOf(ActiveSessionConflictError);

    await expect(
      repo.commitAction({
        actionId: "second-open-bout",
        preconditions: [{ store: "walking_bouts", id: "bout-2", expected: null }],
        changes: [
          {
            store: "walking_bouts",
            operation: "put",
            record: { id: "bout-2", walking_session_id: "pad-1", ended_at: null },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ActiveSessionConflictError);

    const database = await inspectDatabase(factory, databaseName);
    expect(database.objectStoreNames.contains(DATABASE_STORES.activeMarkers)).toBe(true);
    const indexTransaction = database.transaction("walking_bouts", "readonly");
    expect(
      indexTransaction.objectStore("walking_bouts").indexNames.contains("by_walking_session_id"),
    ).toBe(true);
    database.close();
    repo.close();
  });

  it("backfills only the most recently updated session when legacy data has two ACTIVE walking sessions", async () => {
    const factory = new IDBFactory();
    const databaseName = "migration-v2-duplicate-active-sessions";
    // Legacy data predating the one-active-session invariant: two ACTIVE
    // walking sessions of the same type, with distinct updated_at values so
    // the winner is deterministic.
    await openV2Database(factory, databaseName, {
      sessions: [
        { id: "pad-older", status: "ACTIVE", updated_at: "2026-08-01T10:00:00.000Z" },
        { id: "pad-newer", status: "ACTIVE", updated_at: "2026-08-15T10:00:00.000Z" },
      ],
    });

    const repo = createLocalRepository({
      databaseName,
      indexedDB: factory,
      now: () => new Date("2026-09-14T10:00:00.000Z"),
    });

    // The backfill must not crash or leave two markers for one scope: the
    // snapshot's bounded walking_sessions must contain exactly the more
    // recently updated session.
    const snapshot = await repo.readSnapshot();
    expect(snapshot.records.walking_sessions).toEqual([
      expect.objectContaining({ id: "pad-newer" }),
    ]);

    // Both legacy records remain fully persisted (non-destructive migration);
    // only the bounded snapshot/marker picks one winner.
    await expect(repo.listRecords("walking_sessions")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "pad-older" }),
        expect.objectContaining({ id: "pad-newer" }),
      ]),
    );

    // The invariant is enforced going forward: starting a third active
    // session is still rejected.
    await expect(
      repo.commitAction({
        actionId: "third-active-session",
        preconditions: [{ store: "walking_sessions", id: "pad-third", expected: null }],
        changes: [
          { store: "walking_sessions", operation: "put", record: { id: "pad-third", status: "ACTIVE" } },
        ],
      }),
    ).rejects.toBeInstanceOf(ActiveSessionConflictError);

    repo.close();
  });

  it("closes an upgrade connection that succeeds after its open request was blocked", async () => {
    const factory = new IDBFactory();
    const databaseName = "blocked-upgrade-cleanup";
    const blocker = await openDatabaseAtVersion(factory, databaseName, 1);
    const repo = createLocalRepository({ databaseName, indexedDB: factory });

    await expect(repo.readSnapshot()).rejects.toBeInstanceOf(LocalStorageError);
    blocker.close();
    await deleteDatabase(factory, databaseName);
    repo.close();
  });

  it("invalidates its cached connection when a version change closes it", async () => {
    const factory = new IDBFactory();
    const databaseName = "version-change-cache";
    const repo = createLocalRepository({ databaseName, indexedDB: factory });
    await repo.readSnapshot();

    await deleteDatabase(factory, databaseName);
    await expect(repo.readSnapshot()).resolves.toMatchObject({ pendingOutbox: [] });
    repo.close();
  });
});
