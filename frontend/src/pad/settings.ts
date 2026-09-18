import type { LocalRecord } from "../storage";
import { buildPadSessionView, totalWalkingMs, type PadSessionView } from "./session";
import { DEFAULT_WALKING_SETTINGS, type WalkingSessionSettings } from "./types";

/** What the start screen knows about the session a new one inherits from. */
export interface PreviousWalkingSession {
  view: PadSessionView;
  settings: WalkingSessionSettings;
  boutCount: number;
  /** Effective walking time across the session's bouts. */
  walkingMs: number;
  /** Completion time, falling back to the start for a session that stored none. */
  finishedAt: string;
}

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
 * The most recent COMPLETED walking session, which a new session inherits its
 * treadmill settings from (docs/pad-walking.md, "Settings inheritance").
 *
 * Completed sessions are outside the recovery snapshot -- it is bounded to live
 * ACTIVE state -- so callers read this from `listRecords` history instead.
 * `DISCARDED` sessions are skipped: the spec inherits from the previous
 * *completed* session only.
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
    return {
      view,
      settings: {
        speed_kmh: view.session.speed_kmh,
        incline_pct: view.session.incline_pct,
        max_bout_seconds: view.session.max_bout_seconds,
      },
      boutCount: view.bouts.length,
      walkingMs: totalWalkingMs(view, Date.parse(finishedAt)),
      finishedAt,
    };
  }
  return null;
}

/** The previous completed session's settings, or the application defaults. */
export function inheritedWalkingSettings(
  previous: PreviousWalkingSession | null,
): WalkingSessionSettings {
  return previous?.settings ?? DEFAULT_WALKING_SETTINGS;
}
