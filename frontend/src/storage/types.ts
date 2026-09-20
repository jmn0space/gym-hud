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
 * A permanent server rejection recorded against an outbox entry by
 * `markOutboxRejected`. Mirrors the `rejected` acknowledgement's fields (see
 * docs/data-sync.md, "Push response"): `code`/`detail` are the server's own,
 * and `rejectedAt` is when this device recorded them (not a server timestamp).
 */
export interface OutboxRejection {
  code: string;
  detail: string;
  rejectedAt: string;
}

/** An outbox entry the server has permanently rejected. See `markOutboxRejected`. */
export interface RejectedOutboxEntry extends OutboxEntry {
  rejection: OutboxRejection;
}

/**
 * One record of the server's changes feed (`GET /api/v1/sync/changes/`), as
 * `applyServerRecords` consumes it. `record` carries only the fields the
 * server models (docs/data-sync.md, "Pull: changes feed") -- a subset of the
 * local record shape -- so applying it is always a merge, never a replace.
 */
export interface ServerChangeRecord {
  store: DomainStore;
  entity_id: string;
  record: LocalRecord;
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
 * - `pendingOutbox`: the full ordered pending queue, in the same sense as
 *   `listPendingOutbox` -- since issue #20, a permanently rejected entry
 *   (`markOutboxRejected`) is excluded here too; see `listRejectedOutbox` for
 *   the needs-attention set.
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
  /**
   * The queue the sync engine drains, in ascending `sequence`. Since issue
   * #20, this **excludes permanently rejected entries** (see
   * `markOutboxRejected`): they are never retried, so leaving them here would
   * block every entry behind them forever, and -- because `hasLiveWork` in
   * `pwa/updateSafety.ts` treats a non-empty pending outbox as live work --
   * would also wedge service-worker updates permanently. Use
   * `listRejectedOutbox` for the needs-attention set.
   */
  listPendingOutbox(): Promise<OutboxEntry[]>;
  acknowledgeOutbox(mutationId: string): Promise<void>;
  /**
   * Records a permanent server rejection (`applied`/`duplicate`/`rejected`/
   * `retry` -- see docs/data-sync.md, "Push response") against a still-stored
   * outbox entry, without removing it: the mutation and the domain data it
   * describes stay on the device for the user (or the owner, through Django
   * Admin) to see. A no-op if the entry is no longer present (already
   * acknowledged by a concurrent drain, or never existed). Once marked,
   * `listPendingOutbox` excludes it -- it is never retried.
   */
  markOutboxRejected(mutationId: string, rejection: OutboxRejection): Promise<void>;
  /** The needs-attention set: every outbox entry `markOutboxRejected` has recorded. */
  listRejectedOutbox(): Promise<RejectedOutboxEntry[]>;
  /**
   * The device id sent as `client_id` on every push (docs/data-sync.md,
   * "Push request"). Created on first call exactly the way `commitAction`
   * creates it -- the same `internal_metadata` key -- if a commit has not
   * already done so, and never changes once set.
   */
  getClientId(): Promise<string>;
  /**
   * Applies one page of the server's changes feed as server-authoritative
   * data, in one transaction with the `cursor` write (`{ durability: "strict"
   * }`) so an interrupted pull re-reads rather than skips (docs/data-sync.md,
   * "Pull: changes feed" and "Client obligations"). No outbox entry, sequence,
   * or action receipt is produced, and none of `commitAction`'s local
   * precondition/cardinality/parent checks run -- a parent may legitimately
   * arrive on a later page than its child.
   *
   * Each change is merged into the existing record, never replaces it
   * wholesale: local-only fields the record holds beyond what the feed models
   * are carried forward. For a record a still-pending (non-rejected) outbox
   * mutation touches, device-writable fields are left as the pending mutation
   * left them -- it commits later and wins -- except a server-side closure
   * (a superseded session, a cascaded tombstone, a parent closing an open
   * child) that record does not yet reflect, which is still applied so
   * `active_markers` stays consistent with what the feed writes; see
   * docs/data-sync.md, "Server-admin configuration precedence".
   */
  applyServerRecords(changes: readonly ServerChangeRecord[], cursor: number): Promise<void>;
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
