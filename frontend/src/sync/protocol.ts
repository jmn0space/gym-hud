/**
 * Wire-level types for the three synchronization endpoints, mirrored from the
 * server's own vocabulary (`backend/apps/sync/protocol.py`,
 * `backend/apps/sync/views.py`) and documented in docs/data-sync.md, "Server
 * synchronization protocol". Keep the three in step.
 */

import type { DomainStore, LocalRecord, OutboxEntry } from "../storage";

/** `max_mutations_per_request` before the first bootstrap read learns the
 * server's real value (docs/data-sync.md, "Push request"). */
export const DEFAULT_MAX_MUTATIONS_PER_REQUEST = 50;

// --- Push: POST /api/v1/sync/mutations/ ----------------------------------

export interface PushRequestBody {
  client_id: string;
  mutations: OutboxEntry[];
}

export type MutationAckStatus = "applied" | "duplicate" | "rejected" | "retry";

interface MutationAckBase {
  mutation_id: string;
}

export interface AppliedAck extends MutationAckBase {
  status: "applied";
}

export interface DuplicateAck extends MutationAckBase {
  status: "duplicate";
}

export interface RejectedAck extends MutationAckBase {
  status: "rejected";
  code: string;
  retryable: false;
  detail: string;
}

export interface RetryAck extends MutationAckBase {
  status: "retry";
  code: string;
  retryable: true;
  detail: string;
}

/** One entry of the push response's `results` (docs/data-sync.md, "Push response"). */
export type MutationAck = AppliedAck | DuplicateAck | RejectedAck | RetryAck;

function isMutationAck(value: unknown): value is MutationAck {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { mutation_id: mutationId, status } = value as Record<string, unknown>;
  if (typeof mutationId !== "string") {
    return false;
  }
  if (status === "applied" || status === "duplicate") {
    return true;
  }
  if (status === "rejected" || status === "retry") {
    const { code, detail, retryable } = value as Record<string, unknown>;
    return typeof code === "string" && typeof detail === "string" && typeof retryable === "boolean";
  }
  return false;
}

/**
 * Parses `POST /api/v1/sync/mutations/`'s response body. An unrecognised
 * `status`, a malformed entry, or a body that is not even shaped like `{
 * results: [...] }` is never thrown away as a parse error: it is treated the
 * same as an entry the server did not list at all -- "not processed, keep it
 * queued" -- so a server bug or a proxy's mangled body can never make the
 * drain acknowledge (and thereby lose) a mutation it is not sure about. See
 * docs/data-sync.md, "Client obligations".
 */
export function parsePushResponse(body: unknown): MutationAck[] {
  if (typeof body !== "object" || body === null) {
    return [];
  }
  const { results } = body as Record<string, unknown>;
  if (!Array.isArray(results)) {
    return [];
  }
  return results.filter(isMutationAck);
}

// --- Bootstrap: GET /api/v1/sync/bootstrap/ -------------------------------

export interface SyncLimits {
  max_mutations_per_request: number;
  max_changes_per_mutation: number;
}

export interface PadDefaultsPayload {
  speed_kmh: number;
  incline_pct: number;
  max_bout_seconds: number;
}

export interface NextSessionSettingsPayload extends PadDefaultsPayload {
  source: "previous_session" | "defaults";
  walking_session_id: string | null;
}

export interface PadBootstrapPayload {
  defaults: PadDefaultsPayload;
  next_session_settings: NextSessionSettingsPayload;
}

export interface BootstrapResponse {
  cursor: number;
  limits: SyncLimits;
  pad: PadBootstrapPayload;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPadDefaultsPayload(value: unknown): value is PadDefaultsPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { speed_kmh: speed, incline_pct: incline, max_bout_seconds: maxBoutSeconds } =
    value as Record<string, unknown>;
  return isFiniteNumber(speed) && isFiniteNumber(incline) && isFiniteNumber(maxBoutSeconds);
}

function isNextSessionSettingsPayload(value: unknown): value is NextSessionSettingsPayload {
  if (typeof value !== "object" || value === null || !isPadDefaultsPayload(value)) {
    return false;
  }
  const { source, walking_session_id: walkingSessionId } = value as unknown as Record<string, unknown>;
  return (
    (source === "previous_session" || source === "defaults") &&
    (walkingSessionId === null || typeof walkingSessionId === "string")
  );
}

function isSyncLimits(value: unknown): value is SyncLimits {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { max_mutations_per_request: maxMutations, max_changes_per_mutation: maxChanges } =
    value as Record<string, unknown>;
  return isFiniteNumber(maxMutations) && isFiniteNumber(maxChanges);
}

/** Runtime shape guard for the bootstrap response; a mismatch is treated as a
 * failed pull (see `parsePushResponse`'s reasoning) rather than thrown as a
 * distinct error type. */
export function isBootstrapResponse(value: unknown): value is BootstrapResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { cursor, limits, pad } = value as Record<string, unknown>;
  if (!isFiniteNumber(cursor) || !isSyncLimits(limits)) {
    return false;
  }
  if (typeof pad !== "object" || pad === null) {
    return false;
  }
  const { defaults, next_session_settings: nextSessionSettings } = pad as Record<string, unknown>;
  return isPadDefaultsPayload(defaults) && isNextSessionSettingsPayload(nextSessionSettings);
}

// --- Changes feed: GET /api/v1/sync/changes/ ------------------------------

export interface ChangeFeedEntry {
  store: DomainStore;
  entity_type: string;
  entity_id: string;
  change_seq: number;
  record: LocalRecord;
}

export interface ChangesResponse {
  changes: ChangeFeedEntry[];
  cursor: number;
  has_more: boolean;
}

const KNOWN_DOMAIN_STORES = new Set<string>([
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
]);

function isChangeFeedEntry(value: unknown): value is ChangeFeedEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { store, entity_type: entityType, entity_id: entityId, change_seq: changeSeq, record } =
    value as Record<string, unknown>;
  return (
    typeof store === "string" &&
    KNOWN_DOMAIN_STORES.has(store) &&
    typeof entityType === "string" &&
    typeof entityId === "string" &&
    isFiniteNumber(changeSeq) &&
    typeof record === "object" &&
    record !== null &&
    typeof (record as Record<string, unknown>).id === "string"
  );
}

/** Runtime shape guard for the changes-feed response; see `isBootstrapResponse`. */
export function isChangesResponse(value: unknown): value is ChangesResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { changes, cursor, has_more: hasMore } = value as Record<string, unknown>;
  return (
    Array.isArray(changes) &&
    changes.every(isChangeFeedEntry) &&
    isFiniteNumber(cursor) &&
    typeof hasMore === "boolean"
  );
}
