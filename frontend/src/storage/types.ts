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
  close(): void;
}
