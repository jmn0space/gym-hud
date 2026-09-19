import type { LocalRecord } from "../storage";
import {
  DEFAULT_WALKING_SETTINGS,
  WALKING_STOP_REASONS,
  type WalkingBout,
  type WalkingBoutPause,
  type WalkingRest,
  type WalkingSession,
  type WalkingSessionStatus,
  type WalkingStopReason,
} from "./types";

/**
 * Narrowing between the untyped `LocalRecord` rows the repository stores and the
 * typed domain above.
 *
 * Parsing is deliberately tolerant rather than throwing: these rows come back from
 * a recovery snapshot on startup, and a single malformed row must never be able to
 * take down the screen that is supposed to recover an in-progress workout. The rule
 * is narrow, though -- "tolerate" means "ignore a row we cannot trust", never
 * "guess a timestamp". Fields that only affect *display* (the treadmill settings,
 * notes, pain, stop reason) fall back to a safe value; fields that decide
 * *identity or state* (ids, parents, `started_at`, `ended_at`) must be trustworthy
 * or the row is dropped.
 */

/** A non-empty string field of a raw row, exported for callers that work on rows. */
export function recordText(record: LocalRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * The repository's own reading of "this interval is still open" (see `isOpen` in
 * storage/repository.ts): an absent `ended_at` counts as open, exactly like an
 * explicit null. Callers that close raw rows must agree with the store about what
 * is open, or they leave behind a row the active markers still count.
 */
export function isOpenRow(record: LocalRecord): boolean {
  return record.ended_at === null || record.ended_at === undefined;
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/**
 * A start timestamp, falling back to the repository-stamped `created_at` when the
 * domain field is missing or unparseable. Every record the repository persists has
 * `created_at`, so the fallback is what keeps a partially corrupted row resumable
 * instead of invisible.
 */
function startTimestamp(record: LocalRecord): string | undefined {
  const started = recordText(record, "started_at");
  if (started !== undefined && isTimestamp(started)) {
    return started;
  }
  const created = recordText(record, "created_at");
  return created !== undefined && isTimestamp(created) ? created : undefined;
}

/**
 * An end timestamp: `null` for a genuinely open interval, `undefined` for a value
 * that is present but unusable. A corrupt end time must not be read as "still
 * open" -- that would resurrect a finished bout into a phantom WALKING state and
 * fight the repository's one-open-bout rule -- so callers drop such a row instead.
 */
function endTimestamp(record: LocalRecord): string | null | undefined {
  const value = record.ended_at;
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" && isTimestamp(value) ? value : undefined;
}

function finiteNumber(record: LocalRecord, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(record: LocalRecord, field: string): number | undefined {
  const value = finiteNumber(record, field);
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function painValue(record: LocalRecord, field: string): number | null {
  const value = positiveInteger(record, field);
  return value !== undefined && value <= 5 ? value : null;
}

function optionalText(record: LocalRecord, field: string): string | null {
  return recordText(record, field) ?? null;
}

function sessionStatus(record: LocalRecord): WalkingSessionStatus | undefined {
  const value = record.status;
  return value === "ACTIVE" || value === "COMPLETED" || value === "DISCARDED" ? value : undefined;
}

function stopReason(record: LocalRecord): WalkingStopReason | null {
  const value = record.stop_reason;
  return (WALKING_STOP_REASONS as readonly string[]).includes(value as string)
    ? (value as WalkingStopReason)
    : null;
}

export function parseWalkingSession(record: LocalRecord): WalkingSession | undefined {
  const id = recordText(record, "id");
  const status = sessionStatus(record);
  const startedAt = startTimestamp(record);
  if (id === undefined || status === undefined || startedAt === undefined) {
    return undefined;
  }
  const completedAt = recordText(record, "completed_at");
  return {
    id,
    status,
    started_at: startedAt,
    completed_at: completedAt !== undefined && isTimestamp(completedAt) ? completedAt : null,
    speed_kmh: finiteNumber(record, "speed_kmh") ?? DEFAULT_WALKING_SETTINGS.speed_kmh,
    incline_pct: finiteNumber(record, "incline_pct") ?? DEFAULT_WALKING_SETTINGS.incline_pct,
    max_bout_seconds:
      positiveInteger(record, "max_bout_seconds") ?? DEFAULT_WALKING_SETTINGS.max_bout_seconds,
    session_notes: optionalText(record, "session_notes"),
  };
}

/**
 * Bouts of one session, ordered as they were walked.
 *
 * `bout_number` is stored, but a row missing it is numbered by its position in
 * start order rather than dropped: display numbering is recomputed anyway (see
 * docs/pad-walking.md, "Editing, undo, and delete"), and identity lives in the
 * UUID, so an absent number costs nothing to reconstruct.
 */
export function parseWalkingBouts(
  records: readonly LocalRecord[],
  sessionId: string,
): WalkingBout[] {
  const parsed = records.flatMap((record) => {
    const id = recordText(record, "id");
    const startedAt = startTimestamp(record);
    const endedAt = endTimestamp(record);
    if (
      id === undefined ||
      startedAt === undefined ||
      endedAt === undefined ||
      recordText(record, "walking_session_id") !== sessionId
    ) {
      return [];
    }
    return [
      {
        record,
        started: Date.parse(startedAt),
        bout: {
          id,
          walking_session_id: sessionId,
          bout_number: 0,
          started_at: startedAt,
          ended_at: endedAt,
          pain_min: painValue(record, "pain_min"),
          pain_max: painValue(record, "pain_max"),
          stop_reason: stopReason(record),
          notes: optionalText(record, "notes"),
        } satisfies WalkingBout,
      },
    ];
  });

  return parsed
    .sort((left, right) => left.started - right.started || left.bout.id.localeCompare(right.bout.id))
    .map(({ bout, record }, index) => ({
      ...bout,
      bout_number: positiveInteger(record, "bout_number") ?? index + 1,
    }));
}

function parseInterval(
  record: LocalRecord,
  boutIds: ReadonlySet<string>,
): { id: string; walking_bout_id: string; started_at: string; ended_at: string | null } | undefined {
  const id = recordText(record, "id");
  const boutId = recordText(record, "walking_bout_id");
  const startedAt = startTimestamp(record);
  const endedAt = endTimestamp(record);
  if (
    id === undefined ||
    boutId === undefined ||
    startedAt === undefined ||
    endedAt === undefined ||
    !boutIds.has(boutId)
  ) {
    return undefined;
  }
  return { id, walking_bout_id: boutId, started_at: startedAt, ended_at: endedAt };
}

export function parseWalkingPauses(
  records: readonly LocalRecord[],
  boutIds: ReadonlySet<string>,
): WalkingBoutPause[] {
  return records.flatMap((record) => {
    const interval = parseInterval(record, boutIds);
    return interval === undefined ? [] : [interval satisfies WalkingBoutPause];
  });
}

export function parseWalkingRests(
  records: readonly LocalRecord[],
  boutIds: ReadonlySet<string>,
): WalkingRest[] {
  return records.flatMap((record) => {
    const interval = parseInterval(record, boutIds);
    return interval === undefined ? [] : [interval satisfies WalkingRest];
  });
}

/*
 * Serialization back to `LocalRecord`. Every put is a full record replacement (see
 * the `DomainChange` contract in docs/plans/issue-15-atomic-local-persistence.md),
 * so these write every domain field explicitly rather than spreading a partial.
 */

export function walkingSessionRecord(session: WalkingSession): LocalRecord {
  return {
    id: session.id,
    status: session.status,
    started_at: session.started_at,
    completed_at: session.completed_at,
    speed_kmh: session.speed_kmh,
    incline_pct: session.incline_pct,
    max_bout_seconds: session.max_bout_seconds,
    session_notes: session.session_notes,
  };
}

export function walkingBoutRecord(bout: WalkingBout): LocalRecord {
  return {
    id: bout.id,
    walking_session_id: bout.walking_session_id,
    bout_number: bout.bout_number,
    started_at: bout.started_at,
    ended_at: bout.ended_at,
    pain_min: bout.pain_min,
    pain_max: bout.pain_max,
    stop_reason: bout.stop_reason,
    notes: bout.notes,
  };
}
