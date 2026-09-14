import {
  ActionConflictError,
  ActiveSessionConflictError,
  InvalidActionError,
  LocalStorageError,
  PreconditionFailedError,
  RecordNotFoundError,
  StorageCorruptionError,
} from "./errors";
import { createUuid, utcNow } from "./helpers";
import { openLocalDatabase, requestResult, transactionComplete } from "./idb";
import { DATABASE_STORES, DEFAULT_DATABASE_NAME, OUTBOX_SEQUENCE_INDEX } from "./schema";
import {
  DOMAIN_STORES,
  type CommitReceipt,
  type DomainChange,
  type DomainStore,
  type JsonValue,
  type LocalAction,
  type LocalRecord,
  type LocalRepository,
  type LocalRepositoryOptions,
  type OutboxChange,
  type OutboxEntry,
  type RecordPrecondition,
  type RecoverySnapshot,
} from "./types";

interface StoredReceipt extends CommitReceipt {
  fingerprint: string;
}

interface MetadataRecord {
  key: string;
  value: JsonValue;
}

const LAST_SEQUENCE_KEY = "last_sequence";
const CLIENT_ID_KEY = "client_id";
const ACTIVE_SESSION_STORES = [
  "walking_sessions",
  "resistance_sessions",
  "cardio_sessions",
] as const satisfies readonly DomainStore[];
const CARDINALITY_STORES = [
  ...ACTIVE_SESSION_STORES,
  "walking_bouts",
  "walking_pauses",
  "walking_rests",
] as const satisfies readonly DomainStore[];

const ENTITY_TYPES: Record<DomainStore, string> = {
  walking_sessions: "walking_session",
  walking_bouts: "walking_bout",
  walking_pauses: "walking_pause",
  walking_rests: "walking_rest",
  resistance_sessions: "resistance_session",
  resistance_rows: "resistance_session_exercise",
  cardio_sessions: "cardio_machine_session",
  routine_templates: "routine_template",
  routine_exercises: "routine_exercise",
  exercise_registry: "exercise",
};

const DEPENDENCY_DEPTH: Record<DomainStore, number> = {
  walking_sessions: 0,
  walking_bouts: 1,
  walking_pauses: 2,
  walking_rests: 2,
  resistance_sessions: 0,
  resistance_rows: 1,
  cardio_sessions: 0,
  routine_templates: 0,
  routine_exercises: 1,
  exercise_registry: 0,
};

const COMMIT_STORES = [
  ...DOMAIN_STORES,
  DATABASE_STORES.outbox,
  DATABASE_STORES.actionReceipts,
  DATABASE_STORES.internalMetadata,
];

function isDeleted(record: LocalRecord): boolean {
  return typeof record.deleted_at === "string";
}

function abortQuietly(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // The transaction has already completed or aborted.
  }
}

function validateIdentifier(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new InvalidActionError(`${label} must not be empty`);
  }
}

function validateAction(action: LocalAction): void {
  validateIdentifier(action.actionId, "Action ID");
  if (action.changes.length === 0) {
    throw new InvalidActionError("An action must contain at least one change");
  }

  const targets = new Set<string>();
  for (const change of action.changes) {
    const id = change.operation === "put" ? change.record.id : change.id;
    validateIdentifier(id, "Record ID");
    const target = `${change.store}\u0000${id}`;
    if (targets.has(target)) {
      throw new InvalidActionError(`Action contains multiple changes for ${change.store}/${id}`);
    }
    targets.add(target);
  }

  for (const precondition of action.preconditions ?? []) {
    validateIdentifier(precondition.id, "Precondition record ID");
  }
}

function canonicalValue(value: unknown, ancestors: Set<object>): unknown {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (ancestors.has(value)) {
    throw new InvalidActionError("Actions must not contain circular values");
  }

  ancestors.add(value);
  let normalized: unknown;
  if (Array.isArray(value)) {
    normalized = value.map((item) => {
      const itemType = typeof item;
      return itemType === "undefined" || itemType === "function" || itemType === "symbol"
        ? null
        : canonicalValue(item, ancestors);
    });
  } else {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => {
        const itemType = typeof item;
        return itemType !== "undefined" && itemType !== "function" && itemType !== "symbol";
      })
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item, ancestors)]);
    normalized = Object.fromEntries(entries);
  }
  ancestors.delete(value);
  return normalized;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new Set<object>()));
}

function snapshotValue<T>(value: T, copies = new WeakMap<object, unknown>()): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const prior = copies.get(value);
  if (prior !== undefined) {
    return prior as T;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    copies.set(value, clone);
    for (const item of value) {
      clone.push(snapshotValue(item, copies));
    }
    return clone as T;
  }

  const clone: Record<string, unknown> = {};
  copies.set(value, clone);
  for (const [key, item] of Object.entries(value)) {
    clone[key] = snapshotValue(item, copies);
  }
  return clone as T;
}

function actionFingerprint(action: LocalAction): string {
  return canonicalJson({
    changes: action.changes,
    preconditions: action.preconditions ?? [],
  });
}

function valuesEqual(left: JsonValue | undefined, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function checkPrecondition(
  precondition: RecordPrecondition,
  actual: LocalRecord | undefined,
): void {
  // A tombstoned record is logically absent, consistent with how deletes,
  // isOpen, and isActive already treat soft-deleted records.
  const record = actual !== undefined && !isDeleted(actual) ? actual : undefined;

  if (precondition.expected === null) {
    if (record !== undefined) {
      throw new PreconditionFailedError(
        `Expected ${precondition.store}/${precondition.id} to be absent`,
      );
    }
    return;
  }

  if (record === undefined) {
    throw new PreconditionFailedError(
      `Expected ${precondition.store}/${precondition.id} to exist`,
    );
  }

  for (const [field, expected] of Object.entries(precondition.expected)) {
    if (!Object.prototype.hasOwnProperty.call(record, field) || !valuesEqual(record[field], expected)) {
      throw new PreconditionFailedError(
        `Precondition failed for ${precondition.store}/${precondition.id} field "${field}"`,
      );
    }
  }
}

function makePersistedPut(
  submitted: LocalRecord,
  existing: LocalRecord | undefined,
  timestamp: string,
): LocalRecord {
  const persisted: LocalRecord = { id: submitted.id };
  for (const [key, value] of Object.entries(submitted)) {
    if (key !== "id" && key !== "created_at" && key !== "updated_at" && key !== "deleted_at") {
      persisted[key] = value;
    }
  }
  persisted.created_at = existing?.created_at ?? timestamp;
  persisted.updated_at = timestamp;
  persisted.deleted_at = null;
  return persisted;
}

function makeTombstone(existing: LocalRecord, timestamp: string): LocalRecord {
  return {
    ...existing,
    id: existing.id,
    created_at: existing.created_at ?? timestamp,
    updated_at: timestamp,
    deleted_at: timestamp,
  };
}

function changeIdentifier(change: DomainChange): string {
  return change.operation === "put" ? change.record.id : change.id;
}

function orderChanges(changes: OutboxChange[]): OutboxChange[] {
  return changes
    .map((change, index) => ({ change, index }))
    .sort((left, right) => {
      if (left.change.operation !== right.change.operation) {
        return left.change.operation === "put" ? -1 : 1;
      }
      const direction = left.change.operation === "delete" ? -1 : 1;
      const depthDifference = DEPENDENCY_DEPTH[left.change.store] - DEPENDENCY_DEPTH[right.change.store];
      return depthDifference === 0 ? left.index - right.index : depthDifference * direction;
    })
    .map(({ change }) => change);
}

function normalizeError(error: unknown, context: string): Error {
  if (error instanceof Error) {
    return error;
  }
  return new LocalStorageError(context, { cause: error });
}

function validSequence(value: JsonValue | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new StorageCorruptionError("Persisted local action sequence is invalid");
  }
  return value;
}

function isActive(record: LocalRecord): boolean {
  return !isDeleted(record) && record.status === "ACTIVE";
}

function isOpen(record: LocalRecord): boolean {
  return !isDeleted(record) && (record.ended_at === null || record.ended_at === undefined);
}

function assertOneOpenPerParent(
  store: DomainStore,
  records: Iterable<LocalRecord>,
  parentField: string,
): void {
  const openParents = new Set<string>();
  for (const record of records) {
    if (!isOpen(record)) {
      continue;
    }
    const parentId = record[parentField];
    if (typeof parentId !== "string" || parentId.trim().length === 0) {
      throw new InvalidActionError(`Open ${store} record ${record.id} requires ${parentField}`);
    }
    if (openParents.has(parentId)) {
      throw new ActiveSessionConflictError(
        `Only one open ${store} record is allowed for ${parentField} ${parentId}`,
      );
    }
    openParents.add(parentId);
  }
}

function maximumPersistedSequence(
  receipts: StoredReceipt[],
  outboxEntries: OutboxEntry[],
): number {
  let maximum = 0;
  for (const item of [...receipts, ...outboxEntries]) {
    if (!Number.isSafeInteger(item.sequence) || item.sequence < 0) {
      throw new StorageCorruptionError("Persisted local action sequence is invalid");
    }
    maximum = Math.max(maximum, item.sequence);
  }
  return maximum;
}

export function createLocalRepository(options: LocalRepositoryOptions = {}): LocalRepository {
  const factory: IDBFactory | undefined = options.indexedDB
    ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
  const now = options.now ?? utcNow;
  const uuid = options.uuid ?? createUuid;
  let databasePromise: Promise<IDBDatabase> | undefined;

  function database(): Promise<IDBDatabase> {
    if (factory === undefined) {
      return Promise.reject(new LocalStorageError("IndexedDB is unavailable in this environment"));
    }
    if (databasePromise !== undefined) {
      return databasePromise;
    }

    const opening = openLocalDatabase(factory, databaseName);
    databasePromise = opening.catch((error: unknown) => {
      databasePromise = undefined;
      throw error;
    });
    const cachedOpening = databasePromise;
    void opening.then(
      (db) => {
        db.onversionchange = () => {
          db.close();
          if (databasePromise === cachedOpening) {
            databasePromise = undefined;
          }
        };
      },
      () => undefined,
    );
    return databasePromise;
  }

  async function withReadonlyTransaction<T>(
    stores: string | string[],
    read: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const db = await database();
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(stores, "readonly");
    } catch (error) {
      throw new LocalStorageError("Unable to start local read", { cause: error });
    }
    const complete = transactionComplete(transaction);
    void complete.catch(() => undefined);
    try {
      const result = await read(transaction);
      await complete;
      return result;
    } catch (error) {
      await complete.catch(() => undefined);
      throw normalizeError(error, "Unable to read local data");
    }
  }

  async function commitAction(action: LocalAction): Promise<CommitReceipt> {
    const actionSnapshot = snapshotValue(action);
    validateAction(actionSnapshot);
    const fingerprint = actionFingerprint(actionSnapshot);
    const db = await database();
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(COMMIT_STORES, "readwrite");
    } catch (error) {
      throw new LocalStorageError("Unable to start local write", { cause: error });
    }
    const complete = transactionComplete(transaction);
    void complete.catch(() => undefined);

    try {
      const receiptStore = transaction.objectStore(DATABASE_STORES.actionReceipts);
      const priorReceipt = await requestResult(
        receiptStore.get(actionSnapshot.actionId) as IDBRequest<StoredReceipt | undefined>,
      );
      if (priorReceipt !== undefined) {
        if (priorReceipt.fingerprint !== fingerprint) {
          throw new ActionConflictError(
            `Action ID "${actionSnapshot.actionId}" was already used with a different payload`,
          );
        }
        await complete;
        return {
          actionId: priorReceipt.actionId,
          sequence: priorReceipt.sequence,
          committedAt: priorReceipt.committedAt,
        };
      }

      const preconditionReads = (actionSnapshot.preconditions ?? []).map(async (precondition) => {
        const actual = await requestResult(
          transaction.objectStore(precondition.store).get(precondition.id) as IDBRequest<
            LocalRecord | undefined
          >,
        );
        checkPrecondition(precondition, actual);
      });

      const existingReads = actionSnapshot.changes.map((change) =>
        requestResult(
          transaction.objectStore(change.store).get(changeIdentifier(change)) as IDBRequest<
            LocalRecord | undefined
          >,
        ),
      );

      const cardinalityReads = CARDINALITY_STORES.map((store) =>
        requestResult(
          transaction.objectStore(store).getAll() as IDBRequest<LocalRecord[]>,
        ).then((records) => [store, records] as const),
      );

      const allReads = Promise.all([
        Promise.all(preconditionReads),
        Promise.all(existingReads),
        Promise.all(cardinalityReads),
      ]);
      const [, existing, cardinalityEntries] = await allReads;
      const recordsByStore = new Map<DomainStore, LocalRecord[]>(cardinalityEntries);

      const timestampDate = now();
      if (Number.isNaN(timestampDate.getTime())) {
        throw new InvalidActionError("The repository clock returned an invalid date");
      }
      const timestamp = timestampDate.toISOString();

      const persistedByTarget = new Map<string, LocalRecord>();
      const outboxChanges: OutboxChange[] = actionSnapshot.changes.map((change, index) => {
        const previous = existing[index];
        if (change.operation === "delete") {
          if (previous === undefined || isDeleted(previous)) {
            throw new RecordNotFoundError(`Cannot delete missing ${change.store}/${change.id}`);
          }
          const record = makeTombstone(previous, timestamp);
          persistedByTarget.set(`${change.store}\u0000${change.id}`, record);
          return {
            store: change.store,
            entity_type: ENTITY_TYPES[change.store],
            entity_id: change.id,
            operation: "delete",
            id: change.id,
            record,
          };
        }

        const record = makePersistedPut(change.record, previous, timestamp);
        persistedByTarget.set(`${change.store}\u0000${change.record.id}`, record);
        return {
          store: change.store,
          entity_type: ENTITY_TYPES[change.store],
          entity_id: change.record.id,
          operation: "put",
          record,
        };
      });

      for (const store of ACTIVE_SESSION_STORES) {
        const prospective = new Map(
          (recordsByStore.get(store) ?? []).map((record) => [record.id, record]),
        );
        for (const change of actionSnapshot.changes) {
          if (change.store === store) {
            const id = changeIdentifier(change);
            const persisted = persistedByTarget.get(`${store}\u0000${id}`);
            if (persisted !== undefined) {
              prospective.set(id, persisted);
            }
          }
        }
        if ([...prospective.values()].filter(isActive).length > 1) {
          throw new ActiveSessionConflictError(
            `Only one active session is allowed in ${store}`,
          );
        }
      }

      for (const [store, parentField] of [
        ["walking_bouts", "walking_session_id"],
        ["walking_pauses", "walking_bout_id"],
        ["walking_rests", "walking_bout_id"],
      ] as const) {
        const prospective = new Map(
          (recordsByStore.get(store) ?? []).map((record) => [record.id, record]),
        );
        for (const change of actionSnapshot.changes) {
          if (change.store === store) {
            const id = changeIdentifier(change);
            const persisted = persistedByTarget.get(`${store}\u0000${id}`);
            if (persisted !== undefined) {
              prospective.set(id, persisted);
            }
          }
        }
        assertOneOpenPerParent(store, prospective.values(), parentField);
      }

      const internalStore = transaction.objectStore(DATABASE_STORES.internalMetadata);
      const [sequenceRecord, clientRecord] = await Promise.all([
        requestResult(
          internalStore.get(LAST_SEQUENCE_KEY) as IDBRequest<MetadataRecord | undefined>,
        ),
        requestResult(
          internalStore.get(CLIENT_ID_KEY) as IDBRequest<MetadataRecord | undefined>,
        ),
      ]);
      let lastSequence = validSequence(sequenceRecord?.value);
      if (sequenceRecord === undefined) {
        const [allReceipts, allOutboxEntries] = await Promise.all([
          requestResult(receiptStore.getAll() as IDBRequest<StoredReceipt[]>),
          requestResult(
            transaction.objectStore(DATABASE_STORES.outbox).getAll() as IDBRequest<OutboxEntry[]>,
          ),
        ]);
        lastSequence = maximumPersistedSequence(allReceipts, allOutboxEntries);
      }
      const sequence = lastSequence + 1;

      for (const change of outboxChanges) {
        transaction.objectStore(change.store).put(change.record);
      }

      internalStore.put({ key: LAST_SEQUENCE_KEY, value: sequence } satisfies MetadataRecord);
      if (clientRecord === undefined) {
        internalStore.put({ key: CLIENT_ID_KEY, value: uuid() } satisfies MetadataRecord);
      }

      const receipt: StoredReceipt = {
        actionId: actionSnapshot.actionId,
        sequence,
        committedAt: timestamp,
        fingerprint,
      };
      receiptStore.add(receipt);

      const outbox: OutboxEntry = {
        version: 1,
        mutation_id: actionSnapshot.actionId,
        sequence,
        created_at: timestamp,
        changes: orderChanges(outboxChanges),
      };
      transaction.objectStore(DATABASE_STORES.outbox).add(outbox);

      await complete;
      return { actionId: receipt.actionId, sequence, committedAt: receipt.committedAt };
    } catch (error) {
      abortQuietly(transaction);
      await complete.catch(() => undefined);
      throw normalizeError(error, "Unable to commit local action");
    }
  }

  async function getRecord(
    store: DomainStore,
    id: string,
    includeDeleted = false,
  ): Promise<LocalRecord | undefined> {
    return withReadonlyTransaction(store, async (transaction) => {
      const record = await requestResult(
        transaction.objectStore(store).get(id) as IDBRequest<LocalRecord | undefined>,
      );
      return record !== undefined && (includeDeleted || !isDeleted(record)) ? record : undefined;
    });
  }

  async function listRecords(store: DomainStore, includeDeleted = false): Promise<LocalRecord[]> {
    return withReadonlyTransaction(store, async (transaction) => {
      const records = await requestResult(
        transaction.objectStore(store).getAll() as IDBRequest<LocalRecord[]>,
      );
      return includeDeleted ? records : records.filter((record) => !isDeleted(record));
    });
  }

  async function listPendingOutbox(): Promise<OutboxEntry[]> {
    return withReadonlyTransaction(DATABASE_STORES.outbox, async (transaction) => {
      const store = transaction.objectStore(DATABASE_STORES.outbox);
      return requestResult(store.index(OUTBOX_SEQUENCE_INDEX).getAll() as IDBRequest<OutboxEntry[]>);
    });
  }

  async function readSnapshot(): Promise<RecoverySnapshot> {
    return withReadonlyTransaction(
      [...DOMAIN_STORES, DATABASE_STORES.outbox],
      async (transaction) => {
        const recordEntries = await Promise.all(
          DOMAIN_STORES.map(async (store) => {
            const records = await requestResult(
              transaction.objectStore(store).getAll() as IDBRequest<LocalRecord[]>,
            );
            return [store, records.filter((record) => !isDeleted(record))] as const;
          }),
        );
        const pendingOutbox = await requestResult(
          transaction
            .objectStore(DATABASE_STORES.outbox)
            .index(OUTBOX_SEQUENCE_INDEX)
            .getAll() as IDBRequest<OutboxEntry[]>,
        );
        return {
          records: Object.fromEntries(recordEntries) as Record<DomainStore, LocalRecord[]>,
          pendingOutbox,
        };
      },
    );
  }

  async function acknowledgeOutbox(mutationId: string): Promise<void> {
    validateIdentifier(mutationId, "Mutation ID");
    const db = await database();
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(DATABASE_STORES.outbox, "readwrite");
    } catch (error) {
      throw new LocalStorageError("Unable to start local write", { cause: error });
    }
    const complete = transactionComplete(transaction);
    void complete.catch(() => undefined);
    try {
      transaction.objectStore(DATABASE_STORES.outbox).delete(mutationId);
      await complete;
    } catch (error) {
      abortQuietly(transaction);
      await complete.catch(() => undefined);
      throw normalizeError(error, "Unable to acknowledge local outbox entry");
    }
  }

  async function readKeyValue(storeName: string, key: string): Promise<JsonValue | undefined> {
    validateIdentifier(key, "Metadata key");
    return withReadonlyTransaction(storeName, async (transaction) => {
      const record = await requestResult(
        transaction.objectStore(storeName).get(key) as IDBRequest<MetadataRecord | undefined>,
      );
      return record?.value;
    });
  }

  async function writeKeyValue(storeName: string, key: string, value: JsonValue): Promise<void> {
    validateIdentifier(key, "Metadata key");
    const db = await database();
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(storeName, "readwrite");
    } catch (error) {
      throw new LocalStorageError("Unable to start local write", { cause: error });
    }
    const complete = transactionComplete(transaction);
    void complete.catch(() => undefined);
    try {
      transaction.objectStore(storeName).put({ key, value } satisfies MetadataRecord);
      await complete;
    } catch (error) {
      abortQuietly(transaction);
      await complete.catch(() => undefined);
      throw normalizeError(error, "Unable to write local metadata");
    }
  }

  return {
    commitAction,
    readSnapshot,
    getRecord,
    listRecords,
    listPendingOutbox,
    acknowledgeOutbox,
    getSyncMetadata: (key) => readKeyValue(DATABASE_STORES.syncMetadata, key),
    setSyncMetadata: (key, value) => writeKeyValue(DATABASE_STORES.syncMetadata, key, value),
    readReferenceCache: (key) => readKeyValue(DATABASE_STORES.referenceData, key),
    writeReferenceCache: (key, value) => writeKeyValue(DATABASE_STORES.referenceData, key, value),
    close: () => {
      const opening = databasePromise;
      databasePromise = undefined;
      void opening?.then(
        (db) => {
          db.close();
        },
        () => undefined,
      );
    },
  };
}
