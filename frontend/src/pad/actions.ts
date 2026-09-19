import { InvalidActionError } from "../storage";
import type {
  DomainStore,
  LocalAction,
  LocalRecord,
  RecordPrecondition,
  RecoverySnapshot,
} from "../storage";
import { isOpenRow, recordText, walkingBoutRecord, walkingSessionRecord } from "./records";
import { findActiveWalkingSessionRecord, type PadSessionView } from "./session";
import type { WalkingSessionSettings } from "./types";

/**
 * Builders for the local actions this slice commits. One logical operation is
 * always exactly one `LocalAction`, so the repository writes its records, receipt
 * and outbox envelope in a single transaction (docs/data-sync.md, "Local-first
 * rule").
 *
 * Each builder takes `now` rather than reading the clock itself: the caller owns
 * the clock, which keeps the derivation and the writes testable against the same
 * injected time.
 */

/**
 * The time a PAD action stamps: `now`, unless something already recorded in the
 * session is later -- the device clock stepped back (an NTP correction, a manual
 * change) since it was written. Then the latest recorded moment is used instead,
 * so within one session recorded time only moves forward: a clock step can never
 * produce an end before its start, a bout before its session, or a rest before
 * its bout ended (docs/data-sync.md, "PAD validation"). The server clamps the
 * same inversions, but a device that never makes one needs no repair.
 *
 * Takes raw values, not parsed records: an unparseable timestamp is skipped.
 */
export function monotonicNow(now: Date, recorded: Iterable<unknown>): Date {
  let latest = now.getTime();
  for (const value of recorded) {
    const time = typeof value === "string" ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(time) && time > latest) {
      latest = time;
    }
  }
  return new Date(latest);
}

const RECORDED_TIME_FIELDS = ["started_at", "ended_at", "completed_at"] as const;

/** Every start and end a set of session records holds, for `monotonicNow`. */
function recordedTimes(records: readonly object[]): unknown[] {
  return records.flatMap((record) =>
    RECORDED_TIME_FIELDS.map((field) => (record as Readonly<Record<string, unknown>>)[field]),
  );
}

/** Guards a follow-up action against a session that another tab already finished. */
function activeSessionPrecondition(sessionId: string): RecordPrecondition {
  return { store: "walking_sessions", id: sessionId, expected: { status: "ACTIVE" } };
}

export interface StartWalkingSessionInput {
  actionId: string;
  sessionId: string;
  settings: WalkingSessionSettings;
  now: Date;
}

/**
 * Start a session. The absence precondition makes a resubmitted start fail instead
 * of overwriting the session it already created; a genuine double tap reuses the
 * same `actionId`, which the repository's receipt de-duplication answers with the
 * original receipt. The one-ACTIVE-session-per-type rule stays the repository's
 * job -- it is enforced inside the write transaction, not here.
 */
export function startWalkingSessionAction({
  actionId,
  sessionId,
  settings,
  now,
}: StartWalkingSessionInput): LocalAction {
  return {
    actionId,
    changes: [
      {
        store: "walking_sessions",
        operation: "put",
        record: walkingSessionRecord({
          id: sessionId,
          status: "ACTIVE",
          started_at: now.toISOString(),
          completed_at: null,
          session_notes: null,
          ...settings,
        }),
      },
    ],
    preconditions: [{ store: "walking_sessions", id: sessionId, expected: null }],
  };
}

export interface StartWalkingBoutInput {
  actionId: string;
  boutId: string;
  view: PadSessionView;
  now: Date;
}

/**
 * Start the next bout of the active session. Pain, stop reason and notes are left
 * null: they are recorded while and after the bout runs, which is the deferred
 * pause/pain/completion story.
 */
export function startWalkingBoutAction({
  actionId,
  boutId,
  view,
  now,
}: StartWalkingBoutInput): LocalAction {
  const startedAt = monotonicNow(
    now,
    recordedTimes([view.session, ...view.bouts, ...view.pauses, ...view.rests]),
  );
  return {
    actionId,
    changes: [
      {
        store: "walking_bouts",
        operation: "put",
        record: walkingBoutRecord({
          id: boutId,
          walking_session_id: view.session.id,
          bout_number: view.currentBoutNumber,
          started_at: startedAt.toISOString(),
          ended_at: null,
          pain_min: null,
          pain_max: null,
          stop_reason: null,
          notes: null,
        }),
      },
    ],
    preconditions: [
      activeSessionPrecondition(view.session.id),
      { store: "walking_bouts", id: boutId, expected: null },
    ],
  };
}

export interface CloseWalkingSessionInput {
  actionId: string;
  /**
   * A snapshot read at commit time, not the screen's React snapshot: whatever is
   * open *now* is what has to be closed. A snapshot that is one async refresh
   * behind -- a second tab started a bout moments ago -- would leave that bout
   * open inside a finished session, where `readSnapshot` can never reach it again
   * because it only walks the descendants of an ACTIVE session.
   */
  snapshot: RecoverySnapshot;
  /** The session the user acted on; a different active session means the tap is stale. */
  sessionId: string;
  now: Date;
}

/**
 * Fields carried over verbatim when a row is closed. A put is a full record
 * replacement, so a close rebuilt from the parsed view would silently overwrite
 * every field the view does not author (`pain_min`, `stop_reason`, `notes`, and
 * anything a later story adds) with whatever that view happened to hold. The
 * repository's own metadata is dropped: it stamps `created_at`/`updated_at`/
 * `deleted_at` inside the transaction.
 */
function carriedFields(record: LocalRecord): LocalRecord {
  const carried: LocalRecord = { id: record.id };
  for (const [field, value] of Object.entries(record)) {
    if (
      value !== undefined &&
      field !== "created_at" &&
      field !== "updated_at" &&
      field !== "deleted_at"
    ) {
      carried[field] = value;
    }
  }
  return carried;
}

/**
 * Guards a close against a record another view closed in the meantime. A row whose
 * `ended_at` is absent altogether cannot be expressed as one -- the check requires
 * the field to be present -- so such a row is closed unguarded rather than made
 * permanently unclosable; the repository's open-interval markers still hold the
 * cardinality invariant either way.
 */
function stillOpenPreconditions(store: DomainStore, record: LocalRecord): RecordPrecondition[] {
  return record.ended_at === null ? [{ store, id: record.id, expected: { ended_at: null } }] : [];
}

function closeWalkingSessionAction(
  { actionId, snapshot, sessionId, now }: CloseWalkingSessionInput,
  status: "COMPLETED" | "DISCARDED",
): LocalAction {
  const sessionRecord = findActiveWalkingSessionRecord(snapshot);
  if (sessionRecord?.id !== sessionId) {
    throw new InvalidActionError(
      `Walking session ${sessionId} is no longer the active session on this device`,
    );
  }

  // Raw rows, not parsed ones: a row the parser dropped is still open as far as
  // the repository's markers are concerned, and leaving it behind is exactly what
  // makes a session unfinishable later.
  const boutRows = snapshot.records.walking_bouts.filter(
    (record) => recordText(record, "walking_session_id") === sessionId,
  );
  const boutIds = new Set(boutRows.map((record) => record.id));
  const intervalRows: readonly (readonly [DomainStore, readonly LocalRecord[]])[] = [
    ["walking_pauses", snapshot.records.walking_pauses],
    ["walking_rests", snapshot.records.walking_rests],
  ];
  const sessionRows = [
    sessionRecord,
    ...boutRows,
    ...intervalRows.flatMap(([, records]) =>
      records.filter((record) => boutIds.has(recordText(record, "walking_bout_id") ?? "")),
    ),
  ];
  // One moment for every close, never before anything the session recorded.
  const endedAt = monotonicNow(now, recordedTimes(sessionRows)).toISOString();

  const changes: LocalAction["changes"] = [];
  const preconditions: RecordPrecondition[] = [activeSessionPrecondition(sessionId)];
  const close = (store: DomainStore, record: LocalRecord) => {
    changes.push({
      store,
      operation: "put",
      record: { ...carriedFields(record), ended_at: endedAt },
    });
    preconditions.push(...stillOpenPreconditions(store, record));
  };

  // Children first, then their bouts, then the session: closing every open
  // interval, not only the "current" one, is what keeps the open-interval markers
  // from outliving the session that owns them.
  for (const [store, records] of intervalRows) {
    for (const record of records) {
      const parent = recordText(record, "walking_bout_id");
      if (parent !== undefined && boutIds.has(parent) && isOpenRow(record)) {
        close(store, record);
      }
    }
  }
  for (const record of boutRows) {
    if (isOpenRow(record)) {
      close("walking_bouts", record);
    }
  }
  changes.push({
    store: "walking_sessions",
    operation: "put",
    record: { ...carriedFields(sessionRecord), status, completed_at: endedAt },
  });

  return { actionId, changes, preconditions };
}

/**
 * Finish the session, closing whatever is still open in one action: a session may
 * be finished from any state (docs/pad-walking.md, "State machine"), and leaving an
 * open pause, bout or rest behind would keep the repository's open-interval markers
 * pointing at a session that is no longer active.
 *
 * The closed bout gets no `stop_reason`: inferring one belongs with the stop-reason
 * picker, which this slice deliberately does not build. It stays editable later.
 */
export function finishWalkingSessionAction(input: CloseWalkingSessionInput): LocalAction {
  return closeWalkingSessionAction(input, "COMPLETED");
}

/**
 * Discard the active session, closing its open intervals the same way.
 *
 * This is the recovery escape for a session whose row the parser cannot read: it
 * needs nothing from the row but its id, so it stays available exactly when the
 * HUD -- and with it FINISH SESSION -- cannot render. `completed_at` records when
 * the session stopped; `DISCARDED` is skipped by settings inheritance, so a
 * discarded session never becomes the one a later session inherits from.
 */
export function discardWalkingSessionAction(input: CloseWalkingSessionInput): LocalAction {
  return closeWalkingSessionAction(input, "DISCARDED");
}
