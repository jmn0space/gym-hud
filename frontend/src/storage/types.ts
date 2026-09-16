export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export const DOMAIN_STORES = [
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
] as const;

export type DomainStore = (typeof DOMAIN_STORES)[number];

/**
 * A local domain record. Timestamp metadata may be omitted when submitting a put;
 * the repository always generates it for the persisted record.
 */
export interface LocalRecord {
  id: string;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  [key: string]: JsonValue | undefined;
}

export interface PutDomainChange {
  store: DomainStore;
  operation: "put";
  record: LocalRecord;
}

export interface DeleteDomainChange {
  store: DomainStore;
  operation: "delete";
  id: string;
}

export type DomainChange = PutDomainChange | DeleteDomainChange;

export interface RecordPrecondition {
  store: DomainStore;
  id: string;
  expected: Record<string, JsonValue> | null;
}

export interface LocalAction {
  actionId: string;
  changes: DomainChange[];
  preconditions?: RecordPrecondition[];
}

export interface CommitReceipt {
  actionId: string;
  sequence: number;
  committedAt: string;
}

interface OutboxChangeIdentity {
  store: DomainStore;
  entity_type: string;
  entity_id: string;
}

export interface OutboxPutChange extends OutboxChangeIdentity {
  operation: "put";
  record: LocalRecord;
}

export interface OutboxDeleteChange extends OutboxChangeIdentity {
  operation: "delete";
  id: string;
  /** The durable tombstone created by this deletion. */
  record: LocalRecord;
}

export type OutboxChange = OutboxPutChange | OutboxDeleteChange;

export interface OutboxEntry {
  version: 1;
  mutation_id: string;
  sequence: number;
  created_at: string;
  changes: OutboxChange[];
}

/**
 * The startup recovery read. Bounded to live state so its cost does not grow with
 * all-time history:
 *
 * - `walking_sessions`, `resistance_sessions`, `cardio_sessions`: at most one live
 *   (non-tombstoned) ACTIVE record each, since only one session per type may be
 *   active at a time.
 * - `walking_bouts`, `walking_pauses`, `walking_rests`: only the live descendants
 *   of an active walking session (bouts of that session, pauses/rests of those
 *   bouts) — not full history, and not limited to open intervals.
 * - `resistance_rows`: only the live rows of an active resistance session.
 * - `routine_templates`, `routine_exercises`, `exercise_registry`: returned in
 *   full, since they are small reference/config data rather than workout history.
 * - `pendingOutbox`: unchanged, the full ordered pending queue.
 *
 * Use `listRecords`/`getRecord` for full-history access (e.g. History screens).
 */
export interface RecoverySnapshot {
  records: Record<DomainStore, LocalRecord[]>;
  pendingOutbox: OutboxEntry[];
}

export interface LocalRepositoryOptions {
  databaseName?: string;
  indexedDB?: IDBFactory;
  now?: () => Date;
  uuid?: () => string;
}

/**
 * The only device-local record of "this browser has signed in before". Never
 * holds a password, session id, or token -- see docs/data-sync.md's
 * "Authentication and offline continuation" section. Stored in the
 * repository-internal `internal_metadata` store under a dedicated key, so it
 * shares that store's atomic single-key writes without affecting the
 * commit-action sequence/client-id keys the repository also keeps there.
 */
export interface AuthMarker {
  username: string;
  lastVerifiedAt: string;
  [key: string]: JsonValue;
}

/**
 * The durable record of which locally-authenticated user's data (in
 * particular, the pending outbox) is on this device. Unlike `AuthMarker`,
 * this is never cleared by logout -- see docs/data-sync.md's "Different-user
 * protection" note and finding #2 of the session-auth review. Set whenever
 * authentication succeeds (login or verify) and either it is absent yet, or
 * there are no pending outbox entries to protect.
 */
export interface OutboxOwner {
  username: string;
  [key: string]: JsonValue;
}

export interface LocalRepository {
  commitAction(action: LocalAction): Promise<CommitReceipt>;
  readSnapshot(): Promise<RecoverySnapshot>;
  getRecord(
    store: DomainStore,
    id: string,
    includeDeleted?: boolean,
  ): Promise<LocalRecord | undefined>;
  listRecords(
    store: DomainStore,
    includeDeleted?: boolean,
  ): Promise<LocalRecord[]>;
  listPendingOutbox(): Promise<OutboxEntry[]>;
  acknowledgeOutbox(mutationId: string): Promise<void>;
  getSyncMetadata(key: string): Promise<JsonValue | undefined>;
  setSyncMetadata(key: string, value: JsonValue): Promise<void>;
  readReferenceCache(key: string): Promise<JsonValue | undefined>;
  writeReferenceCache(key: string, value: JsonValue): Promise<void>;
  getAuthMarker(): Promise<AuthMarker | undefined>;
  setAuthMarker(marker: AuthMarker): Promise<void>;
  clearAuthMarker(): Promise<void>;
  getOutboxOwner(): Promise<OutboxOwner | undefined>;
  setOutboxOwner(owner: OutboxOwner): Promise<void>;
  close(): void;
}
