import type { JsonValue, LocalRecord } from "../storage";
import { buildPadSessionView, totalWalkingMs, type PadSessionView } from "./session";
import { DEFAULT_WALKING_SETTINGS, type WalkingSessionSettings } from "./types";

/** What the start screen knows about the session a new one inherits from. */
export interface PreviousWalkingSession {
  settings: WalkingSessionSettings;
  boutCount: number;
  /** Effective walking time across the session's bouts. */
  walkingMs: number;
}

/**
 * Where that summary is kept.
 *
 * Completed sessions are outside the recovery snapshot -- it is bounded to live
 * ACTIVE state -- and reading them back means deserializing every walking session,
 * bout and pause ever recorded on the device just to show three numbers. That is
 * the cost `active_markers` and the bounded snapshot exist to avoid
 * (docs/data-sync.md, "Recovery snapshot scope"), so the summary is written once,
 * when a session completes, and read from this one key afterwards.
 */
export const PREVIOUS_WALKING_SESSION_KEY = "pad_previous_walking_session";

export interface WalkingHistoryRecords {
  sessions: readonly LocalRecord[];
  bouts: readonly LocalRecord[];
  pauses: readonly LocalRecord[];
}

function finishedAtMs(record: LocalRecord): number {
  for (const field of ["completed_at", "started_at", "updated_at", "created_at"]) {
    const value = record[field];
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return 0;
}

/**
 * Summarize a session at the moment it is closed. `closedAtMs` is the closing
 * timestamp, so a bout still open at that moment counts up to it and no further:
 * the summary is a fixed record of what was walked, not something that keeps
 * growing against the current clock.
 */
export function summarizeWalkingSession(
  view: PadSessionView,
  closedAtMs: number,
): PreviousWalkingSession {
  return {
    settings: {
      speed_kmh: view.session.speed_kmh,
      incline_pct: view.session.incline_pct,
      max_bout_seconds: view.session.max_bout_seconds,
    },
    boutCount: view.bouts.length,
    walkingMs: totalWalkingMs(view, closedAtMs),
  };
}

export function walkingSessionSummaryValue(previous: PreviousWalkingSession): JsonValue {
  return {
    speed_kmh: previous.settings.speed_kmh,
    incline_pct: previous.settings.incline_pct,
    max_bout_seconds: previous.settings.max_bout_seconds,
    bout_count: previous.boutCount,
    walking_ms: previous.walkingMs,
  };
}

function finiteNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read the stored summary back, tolerantly: anything unusable is reported as "no
 * summary", which sends the caller down the history scan rather than showing
 * invented settings. Same rule as record parsing -- a value that decides what gets
 * persisted next must be trustworthy or ignored.
 */
export function parseWalkingSessionSummary(
  value: JsonValue | undefined,
): PreviousWalkingSession | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const stored = value as Record<string, JsonValue | undefined>;
  const speed = finiteNumber(stored.speed_kmh);
  const incline = finiteNumber(stored.incline_pct);
  const maximum = finiteNumber(stored.max_bout_seconds);
  const boutCount = finiteNumber(stored.bout_count);
  const walkingMs = finiteNumber(stored.walking_ms);
  if (
    speed === undefined ||
    incline === undefined ||
    maximum === undefined ||
    maximum <= 0 ||
    boutCount === undefined ||
    boutCount < 0 ||
    walkingMs === undefined ||
    walkingMs < 0
  ) {
    return null;
  }
  return {
    settings: { speed_kmh: speed, incline_pct: incline, max_bout_seconds: maximum },
    boutCount,
    walkingMs,
  };
}

/**
 * The most recent COMPLETED walking session, derived from full history.
 *
 * This is the fallback for data completed before the summary key above existed:
 * it reads all-time history, so callers use it only when the key is absent, and
 * write the summary back afterwards so the scan happens at most once per device.
 * `DISCARDED` sessions are skipped: the spec inherits from the previous
 * *completed* session only (docs/pad-walking.md, "Settings inheritance").
 */
export function findPreviousWalkingSession(
  records: WalkingHistoryRecords,
): PreviousWalkingSession | null {
  const completed = records.sessions
    .filter((record) => record.status === "COMPLETED")
    .sort((left, right) => finishedAtMs(right) - finishedAtMs(left));

  for (const record of completed) {
    const view = buildPadSessionView(record, records.bouts, records.pauses, []);
    if (view === null) {
      continue;
    }
    // A finished session has no running interval, so its totals are derived
    // against its own completion time rather than the current clock. Any interval
    // left open by a crash therefore stops counting at completion instead of
    // growing forever on the start screen.
    const finishedAt = view.session.completed_at ?? view.session.started_at;
    return summarizeWalkingSession(view, Date.parse(finishedAt));
  }
  return null;
}

/** The previous completed session's settings, or the application defaults. */
export function inheritedWalkingSettings(
  previous: PreviousWalkingSession | null,
): WalkingSessionSettings {
  return previous?.settings ?? DEFAULT_WALKING_SETTINGS;
}
