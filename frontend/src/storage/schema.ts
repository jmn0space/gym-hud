import { DOMAIN_STORES } from "./types";

export const DATABASE_VERSION = 2;
export const DEFAULT_DATABASE_NAME = "gym-hud-local";

export const DATABASE_STORES = {
  actionReceipts: "action_receipts",
  internalMetadata: "internal_metadata",
  outbox: "outbox",
  referenceData: "reference_data",
  syncMetadata: "sync_metadata",
} as const;

export const OUTBOX_SEQUENCE_INDEX = "by_sequence";

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
}
