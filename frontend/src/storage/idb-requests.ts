import { LocalStorageError } from "./errors";

/**
 * Low-level IndexedDB request/transaction promise helpers. Split out from `idb.ts`
 * so `schema.ts` (schema upgrades, including the active-marker backfill) can reuse
 * them without creating a circular import with `idb.ts`, which itself depends on
 * `schema.ts` for `upgradeDatabase`.
 */

export function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new LocalStorageError("IndexedDB request failed"));
    };
  });
}

export function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new LocalStorageError("IndexedDB transaction was aborted"));
    };
    transaction.onerror = () => {
      // The abort event is the authoritative transaction outcome.
    };
  });
}
