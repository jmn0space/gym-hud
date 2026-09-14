import { LocalStorageError } from "./errors";
import {
  DATABASE_VERSION,
  DEFAULT_DATABASE_NAME,
  upgradeDatabase,
} from "./schema";

export function openLocalDatabase(
  factory: IDBFactory,
  databaseName = DEFAULT_DATABASE_NAME,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let rejected = false;

    try {
      request = factory.open(databaseName, DATABASE_VERSION);
    } catch (error) {
      reject(new LocalStorageError(`Unable to open local database "${databaseName}"`, { cause: error }));
      return;
    }

    request.onupgradeneeded = () => {
      const transaction = request.transaction;
      if (transaction === null) {
        throw new LocalStorageError("IndexedDB upgrade transaction is unavailable");
      }
      upgradeDatabase(request.result, transaction);
    };
    request.onerror = () => {
      rejected = true;
      reject(new LocalStorageError(`Unable to open local database "${databaseName}"`, {
        cause: request.error,
      }));
    };
    request.onblocked = () => {
      rejected = true;
      reject(new LocalStorageError(
        `Opening local database "${databaseName}" is blocked by another connection`,
      ));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (rejected) {
        database.close();
        return;
      }
      database.onversionchange = () => {
        database.close();
      };
      resolve(database);
    };
  });
}

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
