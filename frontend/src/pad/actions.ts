import { InvalidActionError } from "../storage";
import type {
  DomainStore,
  LocalAction,
  LocalRecord,
  RecordPrecondition,
  RecoverySnapshot,
} from "../storage";
import { isOpenRow, recordText, walkingBoutRecord, walkingSessionRecord } from "./records";
import { buildPadSessionView, findActiveWalkingSessionRecord, walkingElapsedMs, type PadSessionView } from "./session";
import { WALKING_STOP_REASONS, type WalkingBout, type WalkingSessionSettings, type WalkingStopReason } from "./types";

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

/**
 * Every workflow transition also advances this session revision. The repository
 * checks the previous value inside the same transaction as the writes, so a
 * stale READY screen cannot start a bout after another tab has already completed
 * one (the one-open-bout marker alone cannot detect that history).
 */
function workflowPrecondition(view: PadSessionView): RecordPrecondition {
  const revision = view.sessionRecord.workflow_revision;
  if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) {
    return { store: "walking_sessions", id: view.session.id, expected: { status: "ACTIVE", workflow_revision: revision } };
  }
  const updated = view.sessionRecord.updated_at;
  return {
    store: "walking_sessions",
    id: view.session.id,
    expected: updated === undefined ? { status: "ACTIVE" } : { status: "ACTIVE", updated_at: updated },
    absentFields: ["workflow_revision"],
  };
}

function workflowChange(view: PadSessionView): LocalAction["changes"][number] {
  const previous = view.sessionRecord.workflow_revision;
  const revision = typeof previous === "number" && Number.isSafeInteger(previous) && previous >= 0
    ? previous + 1 : 1;
  return { store: "walking_sessions", operation: "put", record: { ...carriedFields(view.sessionRecord), workflow_revision: revision } };
}

function amendedWorkflowChange(view: PadSessionView, fields: LocalRecord): LocalAction["changes"][number] {
  const change = workflowChange(view);
  if (change.operation !== "put") throw new InvalidActionError("Expected session update");
  return { ...change, record: { ...change.record, ...fields } };
}

function requireState(view: PadSessionView, ...states: PadSessionView["state"][]): void {
  if (view.session.status !== "ACTIVE" || !states.includes(view.state)) {
    throw new InvalidActionError(`PAD action requires ${states.join(" or ")} state`);
  }
}

function guardedCurrentBout(view: PadSessionView): WalkingBout {
  const bout = view.currentBout;
  if (bout === null) {
    throw new InvalidActionError("PAD action requires a current bout");
  }
  return bout;
}

function rawById(records: readonly LocalRecord[], id: string): LocalRecord {
  const record = records.find((candidate) => candidate.id === id);
  if (record === undefined) {
    throw new InvalidActionError(`PAD record ${id} is unavailable`);
  }
  return record;
}

function unchangedRecordPrecondition(store: DomainStore, record: LocalRecord): RecordPrecondition {
  const expected: Record<string, string> = {};
  if (record.updated_at !== undefined) expected.updated_at = record.updated_at;
  return { store, id: record.id, expected };
}

function sessionTimes(view: PadSessionView): unknown[] {
  return recordedTimes([view.session, ...view.bouts, ...view.pauses, ...view.rests]);
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
        record: { ...walkingSessionRecord({
          id: sessionId,
          status: "ACTIVE",
          started_at: now.toISOString(),
          completed_at: null,
          session_notes: null,
          ...settings,
        }), workflow_revision: 0 },
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
  requireState(view, "READY");
  if (view.currentRest !== null) {
    throw new InvalidActionError("Cannot start a bout while a rest is open");
  }
  const startedAt = monotonicNow(
    now,
    sessionTimes(view),
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
      workflowChange(view),
    ],
    preconditions: [
      workflowPrecondition(view),
      { store: "walking_bouts", id: boutId, expected: null },
    ],
  };
}

export interface PauseWalkingBoutInput {
  actionId: string;
  pauseId: string;
  view: PadSessionView;
  now: Date;
}

export function pauseWalkingBoutAction({ actionId, pauseId, view, now }: PauseWalkingBoutInput): LocalAction {
  requireState(view, "WALKING");
  const bout = guardedCurrentBout(view);
  const startedAt = monotonicNow(now, sessionTimes(view)).toISOString();
  return {
    actionId,
    changes: [
      { store: "walking_pauses", operation: "put", record: {
        id: pauseId, walking_bout_id: bout.id, started_at: startedAt, ended_at: null,
      } },
      workflowChange(view),
    ],
    preconditions: [
      workflowPrecondition(view),
      { store: "walking_bouts", id: bout.id, expected: { ended_at: null } },
      { store: "walking_pauses", id: pauseId, expected: null },
    ],
  };
}

export interface ResumeWalkingBoutInput {
  actionId: string;
  view: PadSessionView;
  now: Date;
}

export function resumeWalkingBoutAction({ actionId, view, now }: ResumeWalkingBoutInput): LocalAction {
  requireState(view, "PAUSED");
  const bout = guardedCurrentBout(view);
  const pause = view.currentPause;
  if (pause === null) throw new InvalidActionError("No open pause to resume");
  const rawPause = rawById(view.pauseRecords, pause.id);
  const endedAt = monotonicNow(now, sessionTimes(view)).toISOString();
  return {
    actionId,
    changes: [
      { store: "walking_pauses", operation: "put", record: { ...carriedFields(rawPause), ended_at: endedAt } },
      workflowChange(view),
    ],
    preconditions: [
      workflowPrecondition(view),
      { store: "walking_bouts", id: bout.id, expected: { ended_at: null } },
      { store: "walking_pauses", id: pause.id, expected: { ended_at: null } },
      unchangedRecordPrecondition("walking_pauses", rawPause),
    ],
  };
}

/** Inference is descriptive and can always be overridden with a later edit. */
export function inferWalkingStopReason(
  view: PadSessionView,
  bout: WalkingBout,
  at: Date,
): WalkingStopReason | null {
  if (walkingElapsedMs(bout, view.pauses, at.getTime()) >= view.session.max_bout_seconds * 1000) {
    return "MAX_DURATION";
  }
  return bout.pain_min !== null ? "CLAUDICATION" : null;
}

export interface FinishWalkingBoutInput {
  actionId: string;
  restId: string;
  view: PadSessionView;
  now: Date;
}

export function finishWalkingBoutAction({ actionId, restId, view, now }: FinishWalkingBoutInput): LocalAction {
  requireState(view, "WALKING", "PAUSED");
  if (view.currentRest !== null) throw new InvalidActionError("Cannot finish bout while another rest is open");
  const bout = guardedCurrentBout(view);
  const rawBout = rawById(view.boutRecords, bout.id);
  const ended = monotonicNow(now, sessionTimes(view));
  const endedAt = ended.toISOString();
  const changes: LocalAction["changes"] = [];
  const preconditions: RecordPrecondition[] = [
    workflowPrecondition(view),
    { store: "walking_bouts", id: bout.id, expected: { ended_at: null } },
    unchangedRecordPrecondition("walking_bouts", rawBout),
    { store: "walking_rests", id: restId, expected: null },
  ];
  if (view.currentPause !== null) {
    const rawPause = rawById(view.pauseRecords, view.currentPause.id);
    changes.push({ store: "walking_pauses", operation: "put", record: { ...carriedFields(rawPause), ended_at: endedAt } });
    preconditions.push(
      { store: "walking_pauses", id: rawPause.id, expected: { ended_at: null } },
      unchangedRecordPrecondition("walking_pauses", rawPause),
    );
  }
  changes.push({ store: "walking_bouts", operation: "put", record: {
    ...carriedFields(rawBout), ended_at: endedAt,
    stop_reason: bout.stop_reason ?? inferWalkingStopReason(view, bout, ended),
  } });
  changes.push({ store: "walking_rests", operation: "put", record: {
    id: restId, walking_bout_id: bout.id, started_at: endedAt, ended_at: null,
  } });
  changes.push(workflowChange(view));
  return { actionId, changes, preconditions };
}

export type StartNextWalkingBoutInput = StartWalkingBoutInput;

export function startNextWalkingBoutAction({ actionId, boutId, view, now }: StartNextWalkingBoutInput): LocalAction {
  requireState(view, "RESTING");
  const rest = view.currentRest;
  if (rest === null) throw new InvalidActionError("No open rest to end");
  const rawRest = rawById(view.restRecords, rest.id);
  const startedAt = monotonicNow(now, sessionTimes(view)).toISOString();
  return {
    actionId,
    changes: [
      { store: "walking_rests", operation: "put", record: { ...carriedFields(rawRest), ended_at: startedAt } },
      { store: "walking_bouts", operation: "put", record: walkingBoutRecord({
        id: boutId, walking_session_id: view.session.id, bout_number: view.currentBoutNumber,
        started_at: startedAt, ended_at: null, pain_min: null, pain_max: null,
        stop_reason: null, notes: null,
      }) },
      workflowChange(view),
    ],
    preconditions: [
      workflowPrecondition(view),
      { store: "walking_rests", id: rest.id, expected: { ended_at: null } },
      unchangedRecordPrecondition("walking_rests", rawRest),
      { store: "walking_bouts", id: boutId, expected: null },
    ],
  };
}

export interface UpdateWalkingBoutInput {
  actionId: string;
  view: PadSessionView;
  boutId: string;
  painMin?: number | null;
  painMax?: number | null;
  stopReason?: WalkingStopReason | null;
  notes?: string | null;
}

export function updateWalkingBoutAction(input: UpdateWalkingBoutInput): LocalAction {
  const { actionId, view, boutId, painMin, painMax, stopReason, notes } = input;
  if (view.session.status !== "ACTIVE") throw new InvalidActionError("Session is no longer active");
  const bout = view.bouts.find((item) => item.id === boutId);
  if (bout === undefined) throw new InvalidActionError("Bout does not belong to session");
  const nextMin = painMin === undefined ? bout.pain_min : painMin;
  const nextMax = painMax === undefined ? bout.pain_max : painMax;
  if (!((nextMin === null && nextMax === null) ||
    (Number.isInteger(nextMin) && Number.isInteger(nextMax) &&
      nextMin !== null && nextMax !== null && nextMin >= 1 && nextMax <= 5 &&
      nextMax >= nextMin && nextMax - nextMin <= 1))) {
    throw new InvalidActionError("Pain must be one value or two adjacent values from 1 to 5");
  }
  if (stopReason !== undefined && stopReason !== null &&
    !(WALKING_STOP_REASONS as readonly string[]).includes(stopReason)) {
    throw new InvalidActionError("Invalid walking stop reason");
  }
  if (painMin === undefined && painMax === undefined && stopReason === undefined && notes === undefined) {
    throw new InvalidActionError("Bout edit has no changes");
  }
  const rawBout = rawById(view.boutRecords, boutId);
  return {
    actionId,
    changes: [
      { store: "walking_bouts", operation: "put", record: {
        ...carriedFields(rawBout), pain_min: nextMin, pain_max: nextMax,
        stop_reason: stopReason === undefined ? bout.stop_reason : stopReason,
        notes: notes === undefined ? bout.notes : notes,
      } },
      workflowChange(view),
    ],
    preconditions: [workflowPrecondition(view), unchangedRecordPrecondition("walking_bouts", rawBout)],
  };
}

export interface UpdateWalkingSessionNotesInput {
  actionId: string;
  view: PadSessionView;
  notes: string | null;
}

export function updateWalkingSessionNotesAction({ actionId, view, notes }: UpdateWalkingSessionNotesInput): LocalAction {
  if (view.session.status !== "ACTIVE") throw new InvalidActionError("Session is no longer active");
  return {
    actionId,
    changes: [amendedWorkflowChange(view, { id: view.session.id, session_notes: notes })],
    preconditions: [workflowPrecondition(view)],
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
 * Guards a close against a record another view closed or edited in the meantime. A row whose
 * `ended_at` is absent altogether cannot be expressed as one -- the check requires
 * the field to be present -- so such a row is closed unguarded rather than made
 * permanently unclosable; the repository's open-interval markers still hold the
 * cardinality invariant either way.
 */
function stillOpenPreconditions(store: DomainStore, record: LocalRecord): RecordPrecondition[] {
  return [
    ...(record.ended_at === null ? [{ store, id: record.id, expected: { ended_at: null } } satisfies RecordPrecondition] : []),
    ...(record.updated_at === undefined ? [] : [unchangedRecordPrecondition(store, record)]),
  ];
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

  const view = buildPadSessionView(
    sessionRecord,
    snapshot.records.walking_bouts,
    snapshot.records.walking_pauses,
    snapshot.records.walking_rests,
  );
  if (status === "COMPLETED" && view?.state === "WALKING") {
    throw new InvalidActionError("Pause or finish the bout before finishing the session");
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
  const preconditions: RecordPrecondition[] = [
    view === null ? activeSessionPrecondition(sessionId) : workflowPrecondition(view),
    ...(view === null && sessionRecord.updated_at !== undefined
      ? [unchangedRecordPrecondition("walking_sessions", sessionRecord)] : []),
  ];
  const close = (store: DomainStore, record: LocalRecord) => {
    const parsedBout = store === "walking_bouts" ? view?.bouts.find((bout) => bout.id === record.id) : undefined;
    const inferred = status === "COMPLETED" && view !== null && parsedBout?.stop_reason === null
      ? inferWalkingStopReason(view, parsedBout, new Date(endedAt)) : undefined;
    changes.push({
      store,
      operation: "put",
      record: { ...carriedFields(record), ended_at: endedAt,
        ...(inferred === undefined ? {} : { stop_reason: inferred }) },
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
 * A paused bout gets an inferred stop reason when closed; the user can edit it later.
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
