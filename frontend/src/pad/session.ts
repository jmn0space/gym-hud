import type { LocalRecord, RecoverySnapshot } from "../storage";
import {
  parseWalkingBouts,
  parseWalkingPauses,
  parseWalkingRests,
  parseWalkingSession,
} from "./records";
import type {
  WalkingBout,
  WalkingBoutPause,
  WalkingRest,
  WalkingSession,
  WalkingState,
} from "./types";

/**
 * One walking session and its live intervals, plus the operational state derived
 * from them. Everything here comes from persisted records: the only input that is
 * not stored is `now`, and it is always passed in by the caller so tests (and the
 * repository's injected clock) fully control it.
 */
export interface PadSessionView {
  session: WalkingSession;
  state: WalkingState;
  /** Bouts of this session, in start order. */
  bouts: readonly WalkingBout[];
  /** The bout the current state belongs to: the open bout, or the one being rested after. */
  currentBout: WalkingBout | null;
  currentPause: WalkingBoutPause | null;
  currentRest: WalkingRest | null;
  /** The number the next bout gets; the open bout's own number while one is open. */
  currentBoutNumber: number;
  pauses: readonly WalkingBoutPause[];
  rests: readonly WalkingRest[];
}

function startedAtMs(interval: { started_at: string }): number {
  return Date.parse(interval.started_at);
}

/** The most recently started record, so a duplicate open interval resolves predictably. */
function latest<T extends { started_at: string }>(intervals: readonly T[]): T | null {
  return intervals.reduce<T | null>(
    (selected, interval) =>
      selected === null || startedAtMs(interval) >= startedAtMs(selected) ? interval : selected,
    null,
  );
}

function isOpen(interval: { ended_at: string | null }): boolean {
  return interval.ended_at === null;
}

function pausesOf(
  pauses: readonly WalkingBoutPause[],
  bout: WalkingBout,
): readonly WalkingBoutPause[] {
  return pauses.filter((pause) => pause.walking_bout_id === bout.id);
}

/**
 * Assemble a view from already-read records. Kept separate from `readPadSession`
 * so screens that read history through `listRecords` (settings inheritance, the
 * "last session" summary) derive exactly the same way as the recovery snapshot.
 */
export function buildPadSessionView(
  sessionRecord: LocalRecord,
  boutRecords: readonly LocalRecord[],
  pauseRecords: readonly LocalRecord[],
  restRecords: readonly LocalRecord[],
): PadSessionView | null {
  const session = parseWalkingSession(sessionRecord);
  if (session === undefined) {
    return null;
  }

  const bouts = parseWalkingBouts(boutRecords, session.id);
  const boutIds = new Set(bouts.map((bout) => bout.id));
  const pauses = parseWalkingPauses(pauseRecords, boutIds);
  const rests = parseWalkingRests(restRecords, boutIds);

  const openBout = latest(bouts.filter(isOpen));
  const openPause =
    openBout === null ? null : latest(pausesOf(pauses, openBout).filter(isOpen));
  const openRest = openBout !== null ? null : latest(rests.filter(isOpen));
  const restedBout =
    openRest === null
      ? null
      : (bouts.find((bout) => bout.id === openRest.walking_bout_id) ?? null);

  const currentBout = openBout ?? restedBout;
  const lastNumber = bouts.reduce((highest, bout) => Math.max(highest, bout.bout_number), 0);

  let state: WalkingState;
  if (session.status !== "ACTIVE") {
    state = "COMPLETED";
  } else if (openPause !== null) {
    state = "PAUSED";
  } else if (openBout !== null) {
    state = "WALKING";
  } else if (openRest !== null) {
    state = "RESTING";
  } else {
    state = "READY";
  }

  return {
    session,
    state,
    bouts,
    currentBout,
    currentPause: openPause,
    currentRest: openRest,
    currentBoutNumber: openBout === null ? lastNumber + 1 : openBout.bout_number,
    pauses,
    rests,
  };
}

/**
 * The active PAD session in a recovery snapshot, or `null` when none is active.
 * The snapshot holds at most one ACTIVE session per type (docs/data-sync.md,
 * "Recovery snapshot scope"), so this reconstructs the whole PAD screen after a
 * reload or process termination from stored records alone.
 */
export function readPadSession(snapshot: RecoverySnapshot): PadSessionView | null {
  for (const record of snapshot.records.walking_sessions) {
    if (record.status !== "ACTIVE") {
      continue;
    }
    const view = buildPadSessionView(
      record,
      snapshot.records.walking_bouts,
      snapshot.records.walking_pauses,
      snapshot.records.walking_rests,
    );
    if (view !== null) {
      return view;
    }
  }
  return null;
}

/**
 * Elapsed milliseconds of an interval, from its stored start to its stored end or
 * to `now` while it is still open. This is the only place elapsed time comes from:
 * timer ticks drive re-rendering, never accumulation (docs/pad-walking.md,
 * "Starting and timing a bout").
 */
export function intervalElapsedMs(
  interval: { started_at: string; ended_at: string | null },
  now: number,
): number {
  const start = Date.parse(interval.started_at);
  if (!Number.isFinite(start)) {
    return 0;
  }
  const end = interval.ended_at === null ? now : Date.parse(interval.ended_at);
  return Math.max(0, (Number.isFinite(end) ? end : now) - start);
}

/** Total paused time of a bout, counting a still-open pause up to `now`. */
export function pausedMs(
  bout: WalkingBout,
  pauses: readonly WalkingBoutPause[],
  now: number,
): number {
  return pausesOf(pauses, bout).reduce(
    (total, pause) => total + intervalElapsedMs(pause, now),
    0,
  );
}

/** Effective walking duration: bout elapsed time net of its pauses. */
export function walkingElapsedMs(
  bout: WalkingBout,
  pauses: readonly WalkingBoutPause[],
  now: number,
): number {
  return Math.max(0, intervalElapsedMs(bout, now) - pausedMs(bout, pauses, now));
}

/**
 * The duration the HUD's primary timer shows for the current state, or `null` in a
 * state that has no running interval (READY, or a finished session).
 */
export function derivePadElapsedMs(view: PadSessionView, now: number): number | null {
  switch (view.state) {
    case "WALKING":
      return view.currentBout === null ? null : walkingElapsedMs(view.currentBout, view.pauses, now);
    case "PAUSED":
      return view.currentPause === null ? null : intervalElapsedMs(view.currentPause, now);
    case "RESTING":
      return view.currentRest === null ? null : intervalElapsedMs(view.currentRest, now);
    case "READY":
    case "COMPLETED":
      return null;
  }
}

/** Whether the open bout has reached its session's configured maximum. */
export function hasReachedMaximum(view: PadSessionView, now: number): boolean {
  if (view.state !== "WALKING" && view.state !== "PAUSED") {
    return false;
  }
  if (view.currentBout === null) {
    return false;
  }
  return (
    walkingElapsedMs(view.currentBout, view.pauses, now) >= view.session.max_bout_seconds * 1000
  );
}

/** Total effective walking time across every bout of a session. */
export function totalWalkingMs(view: PadSessionView, now: number): number {
  return view.bouts.reduce((total, bout) => total + walkingElapsedMs(bout, view.pauses, now), 0);
}
