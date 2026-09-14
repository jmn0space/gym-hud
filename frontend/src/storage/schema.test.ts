import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  createLocalRepository,
  DATABASE_STORES,
  DATABASE_VERSION,
  DOMAIN_STORES,
  LocalStorageError,
  OUTBOX_SEQUENCE_INDEX,
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
    expect(snapshot.records.walking_sessions).toEqual([
      expect.objectContaining({ id: "legacy-session", status: "COMPLETED" }),
    ]);
    expect(snapshot.pendingOutbox).toEqual([
      expect.objectContaining({ mutation_id: "legacy-action", sequence: 7 }),
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
