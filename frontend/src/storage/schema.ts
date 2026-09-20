import { requestResult } from "./idb-requests";
import { DOMAIN_STORES, type DomainStore, type LocalRecord } from "./types";

export const DATABASE_VERSION = 3;
export const DEFAULT_DATABASE_NAME = "gym-hud-local";

export const DATABASE_STORES = {
  actionReceipts: "action_receipts",
  activeMarkers: "active_markers",
  internalMetadata: "internal_metadata",
  outbox: "outbox",
  referenceData: "reference_data",
  syncMetadata: "sync_metadata",
} as const;

export const OUTBOX_SEQUENCE_INDEX = "by_sequence";

/**
 * `sync_metadata` key under which the sync engine (issue #20) persists the
 * changes-feed cursor (`GET /api/v1/sync/changes/`'s `since`/`cursor`).
 * `applyServerRecords` writes it in the same transaction as the page's domain
 * records, so an interrupted pull re-reads the same page rather than skipping
 * it (docs/data-sync.md, "Pull: changes feed").
 */
export const SYNC_CURSOR_KEY = "sync_changes_cursor";

/**
 * Parent-id indexes added in schema v3. `readSnapshot` uses these to fetch the
 * live descendants of an active session (bouts of a walking session, pauses/rests
 * of a bout, rows of a resistance session) with `index.getAll(parentId)` instead
 * of scanning the whole store.
 */
export const PARENT_INDEXES: Partial<Record<DomainStore, { name: string; field: string }>> = {
  walking_bouts: { name: "by_walking_session_id", field: "walking_session_id" },
  walking_pauses: { name: "by_walking_bout_id", field: "walking_bout_id" },
  walking_rests: { name: "by_walking_bout_id", field: "walking_bout_id" },
  resistance_rows: { name: "by_resistance_session_id", field: "resistance_session_id" },
};

/** Stores that track at most one globally ACTIVE record, scoped by store name. */
const ACTIVE_SESSION_STORES = [
  "walking_sessions",
  "resistance_sessions",
  "cardio_sessions",
] as const satisfies readonly DomainStore[];

/** Stores that track at most one open (unended, non-tombstoned) record per parent. */
const OPEN_PARENT_FIELD: Record<string, string> = {
  walking_bouts: "walking_session_id",
  walking_pauses: "walking_bout_id",
  walking_rests: "walking_bout_id",
};

function ensureStore(
  database: IDBDatabase,
  transaction: IDBTransaction,
  name: string,
  options: IDBObjectStoreParameters,
): IDBObjectStore {
  if (database.objectStoreNames.contains(name)) {
    return transaction.objectStore(name);
  }

  return database.createObjectStore(name, options);
}

function isTombstoned(record: LocalRecord): boolean {
  return typeof record.deleted_at === "string";
}

function markerId(store: string, scopeKey: string): string {
  return `${store}\u0000${scopeKey}`;
}

/**
 * Deterministic tie-break for "which record wins a scope" when backfilling from
 * data that predates the one-active/one-open invariant being enforced (so it may
 * legitimately contain more than one candidate for a scope, e.g. two ACTIVE
 * walking sessions from before this constraint existed). The record with the
 * greatest `updated_at` wins; ties break on `id` so the choice never depends on
 * store iteration order.
 */
function isMoreRecent(candidate: LocalRecord, current: LocalRecord): boolean {
  const candidateKey = typeof candidate.updated_at === "string" ? candidate.updated_at : "";
  const currentKey = typeof current.updated_at === "string" ? current.updated_at : "";
  if (candidateKey !== currentKey) {
    return candidateKey > currentKey;
  }
  return candidate.id > current.id;
}

/**
 * Recomputes `active_markers` from the current contents of the domain stores. This
 * is the v3 backfill: it derives the same "currently ACTIVE session" / "currently
 * open bout, pause, or rest" markers that `commitAction` would have maintained
 * incrementally, from whatever v2 (or earlier) data is already persisted.
 *
 * It always clears and rebuilds the whole store rather than only running once on
 * the v2->v3 transition. This is intentional: it is idempotent and cheap (an
 * empty no-op on a database already past v3, since `onupgradeneeded` only fires
 * when the requested version differs from the stored one), so gating it on the
 * database's prior version would add complexity for no benefit -- including for
 * a future v3->v4 bump, which would otherwise need to remember to keep this
 * backfill logic reachable.
 *
 * Legacy data may violate the one-active/one-open invariant this store exists to
 * enforce (e.g. two ACTIVE sessions of one type, predating that constraint), so
 * candidates are deduplicated per scope, keeping only the most recently updated
 * one (see `isMoreRecent`) rather than writing every candidate and letting the
 * last `put` win by store iteration order.
 *
 * Must run inside the same versionchange transaction as the store/index creation
 * so the upgrade stays a single atomic, non-destructive step.
 */
function backfillActiveMarkers(transaction: IDBTransaction): void {
  const activeMarkers = transaction.objectStore(DATABASE_STORES.activeMarkers);

  void (async () => {
    try {
      await requestResult(activeMarkers.clear());

      for (const store of ACTIVE_SESSION_STORES) {
        const records = await requestResult(
          transaction.objectStore(store).getAll() as IDBRequest<LocalRecord[]>,
        );
        let winner: LocalRecord | undefined;
        for (const record of records) {
          if (isTombstoned(record) || record.status !== "ACTIVE") {
            continue;
          }
          if (winner === undefined || isMoreRecent(record, winner)) {
            winner = record;
          }
        }
        if (winner !== undefined) {
          activeMarkers.put({
            id: markerId(store, store),
            store,
            scopeKey: store,
            recordId: winner.id,
          });
        }
      }

      for (const [store, parentField] of Object.entries(OPEN_PARENT_FIELD)) {
        const records = await requestResult(
          transaction.objectStore(store).getAll() as IDBRequest<LocalRecord[]>,
        );
        const winners = new Map<string, LocalRecord>();
        for (const record of records) {
          if (isTombstoned(record)) {
            continue;
          }
          if (record.ended_at !== null && record.ended_at !== undefined) {
            continue;
          }
          const parentValue = record[parentField];
          if (typeof parentValue !== "string" || parentValue.trim().length === 0) {
            continue;
          }
          const current = winners.get(parentValue);
          if (current === undefined || isMoreRecent(record, current)) {
            winners.set(parentValue, record);
          }
        }
        for (const [parentValue, record] of winners) {
          activeMarkers.put({
            id: markerId(store, parentValue),
            store,
            scopeKey: parentValue,
            recordId: record.id,
          });
        }
      }
    } catch {
      // Abort the whole upgrade rather than leave a partially backfilled index;
      // the open request's `onerror` surfaces this to the caller.
      try {
        transaction.abort();
      } catch {
        // The transaction has already completed or aborted.
      }
    }
  })();
}

export function upgradeDatabase(
  database: IDBDatabase,
  transaction: IDBTransaction,
): void {
  for (const store of DOMAIN_STORES) {
    ensureStore(database, transaction, store, { keyPath: "id" });
  }

  const outbox = ensureStore(database, transaction, DATABASE_STORES.outbox, {
    keyPath: "mutation_id",
  });
  if (!outbox.indexNames.contains(OUTBOX_SEQUENCE_INDEX)) {
    outbox.createIndex(OUTBOX_SEQUENCE_INDEX, "sequence", { unique: true });
  }

  ensureStore(database, transaction, DATABASE_STORES.actionReceipts, {
    keyPath: "actionId",
  });
  ensureStore(database, transaction, DATABASE_STORES.internalMetadata, {
    keyPath: "key",
  });
  ensureStore(database, transaction, DATABASE_STORES.syncMetadata, {
    keyPath: "key",
  });
  ensureStore(database, transaction, DATABASE_STORES.referenceData, {
    keyPath: "key",
  });
  ensureStore(database, transaction, DATABASE_STORES.activeMarkers, {
    keyPath: "id",
  });

  for (const [store, index] of Object.entries(PARENT_INDEXES)) {
    const objectStore = transaction.objectStore(store);
    if (!objectStore.indexNames.contains(index.name)) {
      objectStore.createIndex(index.name, index.field);
    }
  }

  backfillActiveMarkers(transaction);
}
