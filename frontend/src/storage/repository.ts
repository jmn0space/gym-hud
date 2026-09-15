import {
  ActionConflictError,
  ActiveSessionConflictError,
  InvalidActionError,
  LocalStorageError,
  PreconditionFailedError,
  RecordNotFoundError,
  StorageCorruptionError,
  StorageQuotaExceededError,
} from "./errors";
import { createUuid, utcNow } from "./helpers";
import { openLocalDatabase, requestResult, transactionComplete } from "./idb";
import {
  DATABASE_STORES,
  DEFAULT_DATABASE_NAME,
  OUTBOX_SEQUENCE_INDEX,
  PARENT_INDEXES,
} from "./schema";
import {
  DOMAIN_STORES,
  type AuthMarker,
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

/**
 * A durable marker recording the currently ACTIVE session (scoped by store name)
 * or open bout/pause/rest (scoped by parent id). Its existence and uniqueness
 * *is* the one-active/one-open invariant: `commitAction` only ever has to look up
 * the marker(s) for the scopes an action actually touches, instead of scanning
 * whole stores. Never returned to callers or embedded in outbox payloads.
 */
interface ActiveMarkerRecord {
  id: string;
  store: DomainStore;
  scopeKey: string;
  recordId: string;
}

const LAST_SEQUENCE_KEY = "last_sequence";
const CLIENT_ID_KEY = "client_id";
/**
 * Key for the `AuthMarker` in `internal_metadata`, distinct from the sequence
 * and client-id keys above so `getAuthMarker`/`setAuthMarker`/`clearAuthMarker`
 * can never collide with the repository's own bookkeeping.
 */
const AUTH_MARKER_KEY = "auth_marker";
const ACTIVE_SESSION_STORES = [
  "walking_sessions",
  "resistance_sessions",
  "cardio_sessions",
] as const satisfies readonly DomainStore[];
const OPEN_PARENT_FIELD_BY_STORE: Partial<Record<DomainStore, string>> = {
  walking_bouts: "walking_session_id",
  walking_pauses: "walking_bout_id",
  walking_rests: "walking_bout_id",
};
const CARDINALITY_STORES = [
  ...ACTIVE_SESSION_STORES,
  ...(Object.keys(OPEN_PARENT_FIELD_BY_STORE) as DomainStore[]),
] as const satisfies readonly DomainStore[];

function isActiveSessionStore(store: DomainStore): boolean {
  return (ACTIVE_SESSION_STORES as readonly DomainStore[]).includes(store);
}

function isCardinalityStore(store: DomainStore): boolean {
  return (CARDINALITY_STORES as readonly DomainStore[]).includes(store);
}

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
  DATABASE_STORES.activeMarkers,
];

/** Reference/config stores returned in full by `readSnapshot` (small, not history). */
const REFERENCE_DOMAIN_STORES = [
  "routine_templates",
  "routine_exercises",
  "exercise_registry",
] as const satisfies readonly DomainStore[];

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

function isQuotaExceeded(error: unknown): error is DOMException {
  return (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "QuotaExceededError"
  );
}

function normalizeError(error: unknown, context: string): Error {
  if (isQuotaExceeded(error)) {
    return new StorageQuotaExceededError(context, { cause: error });
  }
  if (error instanceof Error) {
    return error;
  }
  return new LocalStorageError(context, { cause: error });
}

function isInvalidState(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "InvalidStateError") ||
    (error instanceof Error && error.name === "InvalidStateError")
  );
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

function isAuthMarker(value: JsonValue): value is AuthMarker {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const { username, lastVerifiedAt } = value as Record<string, JsonValue>;
  return typeof username === "string" && typeof lastVerifiedAt === "string";
}

function isActive(record: LocalRecord): boolean {
  return !isDeleted(record) && record.status === "ACTIVE";
}

function isOpen(record: LocalRecord): boolean {
  return !isDeleted(record) && (record.ended_at === null || record.ended_at === undefined);
}

function markerId(store: DomainStore, scopeKey: string): string {
  return `${store}\u0000${scopeKey}`;
}

interface ScopeEvent {
  /** Index into the action's `changes` array. */
  changeIndex: number;
  /**
   * True for the synthetic "release" event added when a bout/pause/rest's
   * parent id changed: the record must be treated as no longer active/open in
   * its *previous* scope, regardless of what `persistedByTarget` says about its
   * (new) state, so that scope's marker does not keep pointing at it.
   */
  forceInactive: boolean;
}

interface CardinalityScope {
  store: DomainStore;
  scopeKey: string;
  /** Events for this scope, in original change-submission order. */
  events: ScopeEvent[];
}

/**
 * Groups the action's changes by the (store, scope) pairs that need a cardinality
 * check: the store itself for ACTIVE_SESSION_STORES (only one active session of a
 * given type at a time), or the parent id for open-interval stores (only one open
 * bout per session, one open pause/rest per bout). Only scopes actually touched by
 * this action are collected, so the check stays bounded regardless of history size.
 *
 * A change to a bout/pause/rest's parent id (e.g. reassigning a bout to a
 * different session) touches *two* scopes: the new one (a normal event) and the
 * old one (a forced "release" event, derived from the previous persisted
 * record), so the old scope's marker does not keep pointing at a record that
 * has moved away from it.
 */
function collectCardinalityScopes(
  changes: readonly DomainChange[],
  existing: readonly (LocalRecord | undefined)[],
  persistedByTarget: ReadonlyMap<string, LocalRecord>,
): CardinalityScope[] {
  const scopes = new Map<string, CardinalityScope>();

  function addEvent(store: DomainStore, scopeKey: string, changeIndex: number, forceInactive: boolean): void {
    const key = markerId(store, scopeKey);
    let scope = scopes.get(key);
    if (scope === undefined) {
      scope = { store, scopeKey, events: [] };
      scopes.set(key, scope);
    }
    scope.events.push({ changeIndex, forceInactive });
  }

  changes.forEach((change, index) => {
    if (!isCardinalityStore(change.store)) {
      return;
    }
    const id = changeIdentifier(change);
    const persisted = persistedByTarget.get(`${change.store}\u0000${id}`);
    if (persisted === undefined) {
      return;
    }

    if (isActiveSessionStore(change.store)) {
      // Scope is the store name itself, so it never "moves" between scopes.
      addEvent(change.store, change.store, index, false);
      return;
    }

    const parentField = OPEN_PARENT_FIELD_BY_STORE[change.store];
    if (parentField === undefined) {
      return;
    }

    const newParentValue = persisted[parentField];
    const hasNewParent = typeof newParentValue === "string" && newParentValue.trim().length > 0;
    if (!hasNewParent && isOpen(persisted)) {
      throw new InvalidActionError(`Open ${change.store} record ${id} requires ${parentField}`);
    }
    if (hasNewParent) {
      addEvent(change.store, newParentValue, index, false);
    }

    // Release the OLD scope when the parent id changed (or was cleared): a
    // stale marker would otherwise keep pointing at this record there.
    const previous = existing[index];
    if (previous !== undefined) {
      const previousParentValue = previous[parentField];
      const hadOldParent = typeof previousParentValue === "string" && previousParentValue.trim().length > 0;
      if (hadOldParent && (!hasNewParent || previousParentValue !== newParentValue)) {
        addEvent(change.store, previousParentValue, index, true);
      }
    }
  });

  return [...scopes.values()];
}

/**
 * Verifies that a marker's holder is still genuinely active/open in that scope,
 * by reading it directly (one extra `get`, only on the conflict path). Guards
 * against marker drift from any source: if the holder record is missing,
 * tombstoned, no longer active/open, or has since moved to a different scope,
 * the marker is stale and the scope should be treated as free rather than
 * raising a false `ActiveSessionConflictError`.
 */
async function holderStillValid(
  transaction: IDBTransaction,
  scope: CardinalityScope,
  holderId: string,
): Promise<boolean> {
  const holderRecord = await requestResult(
    transaction.objectStore(scope.store).get(holderId) as IDBRequest<LocalRecord | undefined>,
  );
  if (holderRecord === undefined || isDeleted(holderRecord)) {
    return false;
  }
  if (isActiveSessionStore(scope.store)) {
    return isActive(holderRecord);
  }
  const parentField = OPEN_PARENT_FIELD_BY_STORE[scope.store];
  if (parentField === undefined) {
    return false;
  }
  return isOpen(holderRecord) && holderRecord[parentField] === scope.scopeKey;
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
    // Captured so the version-change and forced-close handlers below only clear
    // the cache if it still points at *this* opening attempt: a later call may
    // already have reopened (e.g. after an earlier InvalidStateError), and an
    // event arriving from this stale connection must not clobber that new cache.
    const cachedOpening = databasePromise;
    void opening.then(
      (db) => {
        const invalidateCache = () => {
          if (databasePromise === cachedOpening) {
            databasePromise = undefined;
          }
        };
        db.onversionchange = () => {
          db.close();
          invalidateCache();
        };
        // A forced close (Safari/iOS storage eviction, the IDB server process
        // being killed, the user clearing site data, ...) fires `close` without
        // going through `onversionchange`. Without this, the cached connection
        // stays around forever and every subsequent read/write keeps failing.
        db.onclose = invalidateCache;
      },
      () => undefined,
    );
    return databasePromise;
  }

  /**
   * Opens a transaction, dropping the cached connection when `db.transaction()`
   * throws `InvalidStateError` (the connection died without an `onclose` event
   * reaching us yet, e.g. it fires synchronously on some browsers). This does not
   * retry inside the same call: the next operation, or the UI's Retry button,
   * will see a cleared cache and reopen. An explicit `close()` clears the cache
   * itself first, so it is unaffected by this.
   */
  async function openTransaction(
    stores: string | string[],
    mode: IDBTransactionMode,
    durability?: IDBTransactionDurability,
  ): Promise<IDBTransaction> {
    const dbPromise = database();
    const db = await dbPromise;
    try {
      return durability === undefined
        ? db.transaction(stores, mode)
        : db.transaction(stores, mode, { durability });
    } catch (error) {
      if (isInvalidState(error) && databasePromise === dbPromise) {
        databasePromise = undefined;
      }
      throw new LocalStorageError(
        `Unable to start local ${mode === "readonly" ? "read" : "write"}`,
        { cause: error },
      );
    }
  }

  async function withReadonlyTransaction<T>(
    stores: string | string[],
    read: (transaction: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction = await openTransaction(stores, "readonly");
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
    const transaction = await openTransaction(COMMIT_STORES, "readwrite", "strict");
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

      const [, existing] = await Promise.all([
        Promise.all(preconditionReads),
        Promise.all(existingReads),
      ]);

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

      // Bounded cardinality check: only the (store, scope) pairs this action
      // actually touches are read, via the active-marker store, instead of
      // scanning whole domain stores. See `collectCardinalityScopes`.
      const markerStore = transaction.objectStore(DATABASE_STORES.activeMarkers);
      const cardinalityScopes = collectCardinalityScopes(actionSnapshot.changes, existing, persistedByTarget);
      for (const scope of cardinalityScopes) {
        const id = markerId(scope.store, scope.scopeKey);
        const existingMarker = await requestResult(
          markerStore.get(id) as IDBRequest<ActiveMarkerRecord | undefined>,
        );
        let holder = existingMarker?.recordId;
        // True once `holder` refers to a record this same action has already
        // validated as active/open in this scope (so a later conflict against
        // it is real). False for the original marker holder, which may be
        // stale and worth self-healing before treating it as a real conflict.
        let holderVerifiedThisAction = false;

        for (const event of scope.events) {
          const change = actionSnapshot.changes[event.changeIndex];
          if (change === undefined) {
            continue;
          }
          const recordId = changeIdentifier(change);
          let activeNow: boolean;
          if (event.forceInactive) {
            activeNow = false;
          } else {
            const persisted = persistedByTarget.get(`${scope.store}\u0000${recordId}`);
            if (persisted === undefined) {
              continue;
            }
            activeNow = isActiveSessionStore(scope.store) ? isActive(persisted) : isOpen(persisted);
          }

          if (recordId === holder) {
            holder = activeNow ? recordId : undefined;
            holderVerifiedThisAction = activeNow;
          } else if (activeNow) {
            if (holder !== undefined) {
              const stillConflicts = holderVerifiedThisAction || (await holderStillValid(transaction, scope, holder));
              if (stillConflicts) {
                throw new ActiveSessionConflictError(
                  isActiveSessionStore(scope.store)
                    ? `Only one active session is allowed in ${scope.store}`
                    : `Only one open ${scope.store} record is allowed for scope ${scope.scopeKey}`,
                );
              }
              // The marker was stale (holder missing, tombstoned, no longer
              // active/open, or moved to a different scope): self-heal by
              // treating the scope as free instead of failing the commit.
            }
            holder = recordId;
            holderVerifiedThisAction = true;
          }
        }

        if (holder === undefined) {
          markerStore.delete(id);
        } else {
          markerStore.put({
            id,
            store: scope.store,
            scopeKey: scope.scopeKey,
            recordId: holder,
          } satisfies ActiveMarkerRecord);
        }
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

  async function readActiveSession(
    transaction: IDBTransaction,
    store: (typeof ACTIVE_SESSION_STORES)[number],
  ): Promise<LocalRecord | undefined> {
    const markerStore = transaction.objectStore(DATABASE_STORES.activeMarkers);
    const marker = await requestResult(
      markerStore.get(markerId(store, store)) as IDBRequest<ActiveMarkerRecord | undefined>,
    );
    if (marker === undefined) {
      return undefined;
    }
    const record = await requestResult(
      transaction.objectStore(store).get(marker.recordId) as IDBRequest<LocalRecord | undefined>,
    );
    return record !== undefined && !isDeleted(record) ? record : undefined;
  }

  async function readLiveChildren(
    transaction: IDBTransaction,
    store: DomainStore,
    parentIds: readonly string[],
  ): Promise<LocalRecord[]> {
    const index = PARENT_INDEXES[store];
    if (index === undefined || parentIds.length === 0) {
      return [];
    }
    const objectStore = transaction.objectStore(store).index(index.name);
    const lists = await Promise.all(
      parentIds.map((parentId) =>
        requestResult(objectStore.getAll(parentId) as IDBRequest<LocalRecord[]>),
      ),
    );
    return lists.flat().filter((record) => !isDeleted(record));
  }

  /**
   * Bounded startup snapshot. See the `RecoverySnapshot` JSDoc for exactly what
   * scope each store returns. Cost is independent of closed/tombstoned history:
   * it looks up the active-session markers directly and walks only the live
   * descendants of whatever is actually active, via the v3 parent-id indexes.
   */
  async function readSnapshot(): Promise<RecoverySnapshot> {
    return withReadonlyTransaction(
      [...DOMAIN_STORES, DATABASE_STORES.outbox, DATABASE_STORES.activeMarkers],
      async (transaction) => {
        const [walkingSession, resistanceSession, cardioSession] = await Promise.all([
          readActiveSession(transaction, "walking_sessions"),
          readActiveSession(transaction, "resistance_sessions"),
          readActiveSession(transaction, "cardio_sessions"),
        ]);

        const walkingBouts = walkingSession !== undefined
          ? await readLiveChildren(transaction, "walking_bouts", [walkingSession.id])
          : [];
        const boutIds = walkingBouts.map((bout) => bout.id);
        const [walkingPauses, walkingRests, resistanceRows] = await Promise.all([
          readLiveChildren(transaction, "walking_pauses", boutIds),
          readLiveChildren(transaction, "walking_rests", boutIds),
          resistanceSession !== undefined
            ? readLiveChildren(transaction, "resistance_rows", [resistanceSession.id])
            : Promise.resolve([]),
        ]);

        const referenceEntries = await Promise.all(
          REFERENCE_DOMAIN_STORES.map(async (store) => {
            const records = await requestResult(
              transaction.objectStore(store).getAll() as IDBRequest<LocalRecord[]>,
            );
            return [store, records.filter((record) => !isDeleted(record))] as const;
          }),
        );

        const records: Record<DomainStore, LocalRecord[]> = {
          walking_sessions: walkingSession !== undefined ? [walkingSession] : [],
          walking_bouts: walkingBouts,
          walking_pauses: walkingPauses,
          walking_rests: walkingRests,
          resistance_sessions: resistanceSession !== undefined ? [resistanceSession] : [],
          resistance_rows: resistanceRows,
          cardio_sessions: cardioSession !== undefined ? [cardioSession] : [],
          ...(Object.fromEntries(referenceEntries) as Record<
            (typeof REFERENCE_DOMAIN_STORES)[number],
            LocalRecord[]
          >),
        };

        const pendingOutbox = await requestResult(
          transaction
            .objectStore(DATABASE_STORES.outbox)
            .index(OUTBOX_SEQUENCE_INDEX)
            .getAll() as IDBRequest<OutboxEntry[]>,
        );
        return { records, pendingOutbox };
      },
    );
  }

  async function acknowledgeOutbox(mutationId: string): Promise<void> {
    validateIdentifier(mutationId, "Mutation ID");
    const transaction = await openTransaction(DATABASE_STORES.outbox, "readwrite", "strict");
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
    const transaction = await openTransaction(storeName, "readwrite", "strict");
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

  async function deleteKeyValue(storeName: string, key: string): Promise<void> {
    validateIdentifier(key, "Metadata key");
    const transaction = await openTransaction(storeName, "readwrite", "strict");
    const complete = transactionComplete(transaction);
    void complete.catch(() => undefined);
    try {
      transaction.objectStore(storeName).delete(key);
      await complete;
    } catch (error) {
      abortQuietly(transaction);
      await complete.catch(() => undefined);
      throw normalizeError(error, "Unable to delete local metadata");
    }
  }

  async function getAuthMarker(): Promise<AuthMarker | undefined> {
    const value = await readKeyValue(DATABASE_STORES.internalMetadata, AUTH_MARKER_KEY);
    if (value === undefined) {
      return undefined;
    }
    if (!isAuthMarker(value)) {
      throw new StorageCorruptionError("Persisted auth marker is invalid");
    }
    return value;
  }

  async function setAuthMarker(marker: AuthMarker): Promise<void> {
    await writeKeyValue(DATABASE_STORES.internalMetadata, AUTH_MARKER_KEY, marker);
  }

  async function clearAuthMarker(): Promise<void> {
    await deleteKeyValue(DATABASE_STORES.internalMetadata, AUTH_MARKER_KEY);
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
    getAuthMarker,
    setAuthMarker,
    clearAuthMarker,
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
