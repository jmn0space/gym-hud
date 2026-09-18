import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { deriveActiveSessionSummaries } from "../local/activeSessions";
import { hasLiveWork } from "../pwa/updateSafety";
import {
  createLocalRepository,
  DATABASE_STORES,
  DATABASE_VERSION,
  OUTBOX_SEQUENCE_INDEX,
  type LocalRepository,
} from "./index";

/**
 * Acceptance criterion 4 / LOCAL-02: neither an IndexedDB version change nor a
 * reconnect may lose an active session or an unsynchronised outbox entry. These are
 * the regressions that guard the "no forced reload over live work" promise the
 * service-worker update gate depends on -- if continuity broke here, the gate would
 * cheerfully wave a reload through over work that had silently disappeared.
 */

const NOW = Date.parse("2026-09-16T10:00:00.000Z");
const openRepositories: LocalRepository[] = [];

afterEach(() => {
  for (const repository of openRepositories.splice(0)) {
    repository.close();
  }
});

function repository(factory: IDBFactory, databaseName: string): LocalRepository {
  const created = createLocalRepository({
    databaseName,
    indexedDB: factory,
    uuid: () => "client-uuid",
  });
  openRepositories.push(created);
  return created;
}

/**
 * Writes an active session and a pending mutation into a database one version behind
 * the current schema, bypassing the repository entirely, so that opening it through
 * `createLocalRepository` runs the real `upgradeDatabase` path over existing data.
 */
function seedPreviousSchemaVersion(factory: IDBFactory, databaseName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName, DATABASE_VERSION - 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("walking_sessions", { keyPath: "id" });
      database.createObjectStore("walking_bouts", { keyPath: "id" });
      const outbox = database.createObjectStore(DATABASE_STORES.outbox, {
        keyPath: "mutation_id",
      });
      outbox.createIndex(OUTBOX_SEQUENCE_INDEX, "sequence", { unique: true });
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Seeding the previous schema version failed"));
    };
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(
        ["walking_sessions", "walking_bouts", DATABASE_STORES.outbox],
        "readwrite",
      );
      transaction.objectStore("walking_sessions").put({
        id: "pad-1",
        status: "ACTIVE",
        started_at: "2026-09-16T09:00:00.000Z",
        created_at: "2026-09-16T09:00:00.000Z",
        updated_at: "2026-09-16T09:00:00.000Z",
        deleted_at: null,
      });
      transaction.objectStore("walking_bouts").put({
        id: "bout-1",
        walking_session_id: "pad-1",
        started_at: "2026-09-16T09:45:00.000Z",
        ended_at: null,
        created_at: "2026-09-16T09:45:00.000Z",
        updated_at: "2026-09-16T09:45:00.000Z",
        deleted_at: null,
      });
      transaction.objectStore(DATABASE_STORES.outbox).put({
        version: 1,
        mutation_id: "start-pad",
        sequence: 1,
        created_at: "2026-09-16T09:00:00.000Z",
        changes: [],
      });
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error ?? new Error("Seeding the previous schema version failed"));
      };
    };
  });
}

describe("offline continuity across reconnects and schema upgrades", () => {
  it("keeps an active session and its pending outbox through close and reopen", async () => {
    const factory = new IDBFactory();
    const databaseName = "continuity-close-reopen";
    const first = repository(factory, databaseName);
    await first.commitAction({
      actionId: "start-pad",
      changes: [
        {
          store: "walking_sessions",
          operation: "put",
          record: { id: "pad-1", status: "ACTIVE", started_at: "2026-09-16T09:00:00.000Z" },
        },
        {
          store: "walking_bouts",
          operation: "put",
          record: {
            id: "bout-1",
            walking_session_id: "pad-1",
            started_at: "2026-09-16T09:45:00.000Z",
            ended_at: null,
          },
        },
      ],
    });
    first.close();
    await Promise.resolve();

    const reopened = repository(factory, databaseName);
    const snapshot = await reopened.readSnapshot();

    expect(snapshot.pendingOutbox).toEqual([
      expect.objectContaining({ mutation_id: "start-pad", sequence: 1 }),
    ]);
    expect(deriveActiveSessionSummaries(snapshot, NOW)).toEqual([
      expect.objectContaining({ id: "pad-1", title: "PAD Walking", status: "Walking" }),
    ]);
    expect(hasLiveWork(snapshot, snapshot.pendingOutbox)).toBe(true);
  });

  it("carries an active session and pending outbox through a non-destructive upgrade", async () => {
    const factory = new IDBFactory();
    const databaseName = "continuity-schema-upgrade";
    await seedPreviousSchemaVersion(factory, databaseName);

    // Opening through the repository runs `upgradeDatabase` at the current version.
    const upgraded = repository(factory, databaseName);
    const snapshot = await upgraded.readSnapshot();

    expect(snapshot.records.walking_sessions).toEqual([
      expect.objectContaining({ id: "pad-1", status: "ACTIVE" }),
    ]);
    expect(snapshot.records.walking_bouts).toEqual([
      expect.objectContaining({ id: "bout-1", ended_at: null }),
    ]);
    expect(await upgraded.listPendingOutbox()).toEqual([
      expect.objectContaining({ mutation_id: "start-pad", sequence: 1 }),
    ]);
    // The upgrade rebuilt the active markers, so the Resume card still resolves.
    const summaries = deriveActiveSessionSummaries(snapshot, NOW);
    expect(summaries).toEqual([
      expect.objectContaining({ id: "pad-1", title: "PAD Walking", status: "Walking" }),
    ]);
    expect(summaries[0]?.elapsedMs).toBe(NOW - Date.parse("2026-09-16T09:45:00.000Z"));
    expect(hasLiveWork(snapshot, snapshot.pendingOutbox)).toBe(true);
  });

  it("keeps accepting new mutations after the upgrade, without renumbering the queue", async () => {
    const factory = new IDBFactory();
    const databaseName = "continuity-upgrade-then-write";
    await seedPreviousSchemaVersion(factory, databaseName);
    const upgraded = repository(factory, databaseName);

    await upgraded.commitAction({
      actionId: "pause-pad",
      changes: [
        {
          store: "walking_pauses",
          operation: "put",
          record: {
            id: "pause-1",
            walking_bout_id: "bout-1",
            started_at: "2026-09-16T09:50:00.000Z",
            ended_at: null,
          },
        },
      ],
    });

    expect((await upgraded.listPendingOutbox()).map((entry) => entry.mutation_id)).toEqual([
      "start-pad",
      "pause-pad",
    ]);
    const snapshot = await upgraded.readSnapshot();
    expect(deriveActiveSessionSummaries(snapshot, NOW)).toEqual([
      expect.objectContaining({ id: "pad-1", status: "Paused" }),
    ]);
  });

  it("reports no live work once the session ends and the queue drains", async () => {
    const factory = new IDBFactory();
    const databaseName = "continuity-drained";
    const repo = repository(factory, databaseName);
    await repo.commitAction({
      actionId: "log-reference-data",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "back-squat" } },
      ],
    });
    await repo.acknowledgeOutbox("log-reference-data");

    const snapshot = await repo.readSnapshot();

    expect(hasLiveWork(snapshot, snapshot.pendingOutbox)).toBe(false);
  });
});
