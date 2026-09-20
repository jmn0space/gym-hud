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
import {
  WALKING_STOP_REASONS,
  type WalkingBout,
  type WalkingBoutPause,
  type WalkingRest,
  type WalkingSession,
  type WalkingSessionSettings,
  type WalkingStopReason,
} from "./types";

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

/*
 * Corrections, undo and delete (issue #22). These extend the same one-action-
 * per-operation contract as everything above: a correction, an undo or a
 * delete is exactly one `LocalAction`, so the repository writes it as one
 * transaction and one outbox envelope.
 */

function isValidTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/**
 * Session-wide containment and ordering rules a correction, undo or delete
 * must leave true of the RESULTING state -- judged as a whole, exactly as the
 * server judges the finished state of a mutation (docs/data-sync.md, "Settle
 * the finished state" and "PAD validation"):
 *
 * - a bout starts at or after its session started;
 * - an interval's end is not before its own start;
 * - a pause lies within its bout, and cannot stay open once the bout has
 *   ended;
 * - pauses of the same bout do not overlap;
 * - a rest belongs to a bout that has ended, and starts at or after that end;
 * - PAD-06: the session never has an open bout while one of its rests is
 *   open.
 *
 * Deliberately not checked, because neither the server nor a normal workflow
 * checks it either: two bouts of the same session overlapping each other.
 * `settle_session_tree` (`backend/apps/pad/sync.py`) clamps each interval
 * into its own parent independently, never against its siblings, so adding
 * that rule here would make the client stricter than the server it mirrors.
 *
 * A user-chosen correction is validated, never clamped (unlike a clock
 * stamp): `InvalidActionError` refuses an edit that would break one of these
 * rules rather than silently moving a value the user did not choose
 * (docs/data-sync.md, "Clock steps are clamped" describes the server's
 * separate, clock-only clamp).
 */
function assertContainedWalkingSession(
  session: WalkingSession,
  bouts: readonly WalkingBout[],
  pauses: readonly WalkingBoutPause[],
  rests: readonly WalkingRest[],
): void {
  const sessionStart = Date.parse(session.started_at);
  for (const bout of bouts) {
    if (Date.parse(bout.started_at) < sessionStart) {
      throw new InvalidActionError(`Bout ${bout.bout_number.toString()} cannot start before the session started`);
    }
    if (bout.ended_at !== null && Date.parse(bout.ended_at) < Date.parse(bout.started_at)) {
      throw new InvalidActionError(`Bout ${bout.bout_number.toString()} cannot end before it started`);
    }
  }

  const boutById = new Map(bouts.map((bout) => [bout.id, bout] as const));
  const pausesByBout = new Map<string, WalkingBoutPause[]>();
  for (const pause of pauses) {
    const bout = boutById.get(pause.walking_bout_id);
    if (bout === undefined) {
      continue;
    }
    if (pause.ended_at !== null && Date.parse(pause.ended_at) < Date.parse(pause.started_at)) {
      throw new InvalidActionError("A pause cannot end before it started");
    }
    if (Date.parse(pause.started_at) < Date.parse(bout.started_at)) {
      throw new InvalidActionError(`A pause cannot start before bout ${bout.bout_number.toString()} started`);
    }
    if (bout.ended_at !== null) {
      if (pause.ended_at === null) {
        throw new InvalidActionError(`A pause cannot stay open once bout ${bout.bout_number.toString()} has ended`);
      }
      if (Date.parse(pause.ended_at) > Date.parse(bout.ended_at)) {
        throw new InvalidActionError(`A pause cannot end after bout ${bout.bout_number.toString()} ended`);
      }
    }
    const list = pausesByBout.get(pause.walking_bout_id) ?? [];
    list.push(pause);
    pausesByBout.set(pause.walking_bout_id, list);
  }
  for (const list of pausesByBout.values()) {
    const ordered = [...list].sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at));
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const current = ordered[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      if (previous.ended_at === null || Date.parse(current.started_at) < Date.parse(previous.ended_at)) {
        throw new InvalidActionError("Pauses of the same bout cannot overlap");
      }
    }
  }

  for (const rest of rests) {
    const bout = boutById.get(rest.walking_bout_id);
    if (bout === undefined) {
      continue;
    }
    if (bout.ended_at === null) {
      throw new InvalidActionError(`A rest cannot exist while bout ${bout.bout_number.toString()} is still open`);
    }
    if (Date.parse(rest.started_at) < Date.parse(bout.ended_at)) {
      throw new InvalidActionError(`A rest cannot start before bout ${bout.bout_number.toString()} ended`);
    }
    if (rest.ended_at !== null && Date.parse(rest.ended_at) < Date.parse(rest.started_at)) {
      throw new InvalidActionError("A rest cannot end before it started");
    }
  }

  const hasOpenBout = bouts.some((bout) => bout.ended_at === null);
  const hasOpenRest = rests.some((rest) => rest.ended_at === null);
  if (hasOpenBout && hasOpenRest) {
    throw new InvalidActionError(
      "A bout cannot be open while a rest is open in the same session (PAD-06)",
    );
  }
}

export interface CorrectWalkingBoutTimesInput {
  actionId: string;
  view: PadSessionView;
  boutId: string;
  startedAt?: string;
  endedAt?: string;
}

/**
 * Correct a bout's recorded `started_at` and/or `ended_at` (docs/pad-walking.md,
 * "Editing, undo, and delete"; PAD-09).
 *
 * `ended_at` may only be corrected once the bout has actually finished: a
 * correction changes an already-recorded value, it does not open or close an
 * interval -- that stays the job of PAUSE/RESUME/FINISH BOUT.
 *
 * A bout's `ended_at` and its rest's `started_at` are the same instant when
 * `FINISH BOUT` creates them (docs/pad-walking.md, "Rest handling"), but a
 * correction does not force them to move together: it is validated against
 * the rest's current, unmoved value and refused if that would break
 * containment (the rest would then start before the bout ended). Matches the
 * server's own behaviour for the same correction
 * (`test_a_time_correction_is_judged_on_the_finished_state`,
 * `backend/apps/sync/tests/test_mutations_api.py`, which corrects a bout's end
 * without touching its rest and only checks the result still holds). Moving a
 * bout's end past its rest's current start requires a second correction of
 * the rest's own `started_at` first.
 */
export function correctWalkingBoutTimesAction(input: CorrectWalkingBoutTimesInput): LocalAction {
  const { actionId, view, boutId, startedAt, endedAt } = input;
  if (view.session.status !== "ACTIVE") throw new InvalidActionError("Session is no longer active");
  const bout = view.bouts.find((item) => item.id === boutId);
  if (bout === undefined) throw new InvalidActionError("Bout does not belong to session");
  if (startedAt === undefined && endedAt === undefined) {
    throw new InvalidActionError("Bout time correction has no changes");
  }
  if (startedAt !== undefined && !isValidTimestamp(startedAt)) {
    throw new InvalidActionError("Corrected start time is not a valid timestamp");
  }
  if (endedAt !== undefined) {
    if (bout.ended_at === null) {
      throw new InvalidActionError("Cannot correct the end time of a bout that has not finished");
    }
    if (!isValidTimestamp(endedAt)) {
      throw new InvalidActionError("Corrected end time is not a valid timestamp");
    }
  }

  const correctedBout: WalkingBout = {
    ...bout,
    started_at: startedAt ?? bout.started_at,
    ended_at: endedAt ?? bout.ended_at,
  };
  const bouts = view.bouts.map((item) => (item.id === boutId ? correctedBout : item));
  assertContainedWalkingSession(view.session, bouts, view.pauses, view.rests);

  const rawBout = rawById(view.boutRecords, boutId);
  return {
    actionId,
    changes: [
      { store: "walking_bouts", operation: "put", record: {
        ...carriedFields(rawBout), started_at: correctedBout.started_at, ended_at: correctedBout.ended_at,
      } },
      workflowChange(view),
    ],
    preconditions: [workflowPrecondition(view), unchangedRecordPrecondition("walking_bouts", rawBout)],
  };
}

export interface CorrectWalkingPauseTimesInput {
  actionId: string;
  view: PadSessionView;
  pauseId: string;
  startedAt?: string;
  endedAt?: string;
}

/** Correct a pause's recorded `started_at` and/or `ended_at`. See `correctWalkingBoutTimesAction`. */
export function correctWalkingPauseTimesAction(input: CorrectWalkingPauseTimesInput): LocalAction {
  const { actionId, view, pauseId, startedAt, endedAt } = input;
  if (view.session.status !== "ACTIVE") throw new InvalidActionError("Session is no longer active");
  const pause = view.pauses.find((item) => item.id === pauseId);
  if (pause === undefined) throw new InvalidActionError("Pause does not belong to session");
  if (startedAt === undefined && endedAt === undefined) {
    throw new InvalidActionError("Pause time correction has no changes");
  }
  if (startedAt !== undefined && !isValidTimestamp(startedAt)) {
    throw new InvalidActionError("Corrected start time is not a valid timestamp");
  }
  if (endedAt !== undefined) {
    if (pause.ended_at === null) {
      throw new InvalidActionError("Cannot correct the end time of a pause that has not finished");
    }
    if (!isValidTimestamp(endedAt)) {
      throw new InvalidActionError("Corrected end time is not a valid timestamp");
    }
  }

  const correctedPause: WalkingBoutPause = {
    ...pause,
    started_at: startedAt ?? pause.started_at,
    ended_at: endedAt ?? pause.ended_at,
  };
  const pauses = view.pauses.map((item) => (item.id === pauseId ? correctedPause : item));
  assertContainedWalkingSession(view.session, view.bouts, pauses, view.rests);

  const rawPause = rawById(view.pauseRecords, pauseId);
  return {
    actionId,
    changes: [
      { store: "walking_pauses", operation: "put", record: {
        ...carriedFields(rawPause), started_at: correctedPause.started_at, ended_at: correctedPause.ended_at,
      } },
      workflowChange(view),
    ],
    preconditions: [workflowPrecondition(view), unchangedRecordPrecondition("walking_pauses", rawPause)],
  };
}

export interface CorrectWalkingRestTimesInput {
  actionId: string;
  view: PadSessionView;
  restId: string;
  startedAt?: string;
  endedAt?: string;
}

/** Correct a rest's recorded `started_at` and/or `ended_at`. See `correctWalkingBoutTimesAction`. */
export function correctWalkingRestTimesAction(input: CorrectWalkingRestTimesInput): LocalAction {
  const { actionId, view, restId, startedAt, endedAt } = input;
  if (view.session.status !== "ACTIVE") throw new InvalidActionError("Session is no longer active");
  const rest = view.rests.find((item) => item.id === restId);
  if (rest === undefined) throw new InvalidActionError("Rest does not belong to session");
  if (startedAt === undefined && endedAt === undefined) {
    throw new InvalidActionError("Rest time correction has no changes");
  }
  if (startedAt !== undefined && !isValidTimestamp(startedAt)) {
    throw new InvalidActionError("Corrected start time is not a valid timestamp");
  }
  if (endedAt !== undefined) {
    if (rest.ended_at === null) {
      throw new InvalidActionError("Cannot correct the end time of a rest that has not finished");
    }
    if (!isValidTimestamp(endedAt)) {
      throw new InvalidActionError("Corrected end time is not a valid timestamp");
    }
  }

  const correctedRest: WalkingRest = {
    ...rest,
    started_at: startedAt ?? rest.started_at,
    ended_at: endedAt ?? rest.ended_at,
  };
  const rests = view.rests.map((item) => (item.id === restId ? correctedRest : item));
  assertContainedWalkingSession(view.session, view.bouts, view.pauses, rests);

  const rawRest = rawById(view.restRecords, restId);
  return {
    actionId,
    changes: [
      { store: "walking_rests", operation: "put", record: {
        ...carriedFields(rawRest), started_at: correctedRest.started_at, ended_at: correctedRest.ended_at,
      } },
      workflowChange(view),
    ],
    preconditions: [workflowPrecondition(view), unchangedRecordPrecondition("walking_rests", rawRest)],
  };
}

/**
 * The five state-changing transitions `docs/pad-walking.md` ("Editing, undo,
 * and delete") allows undoing, plus the ids `undoLastWalkingTransitionAction`
 * needs to reverse each one.
 */
export type UndoableWalkingTransition =
  | { type: "bout_started"; boutId: string }
  | { type: "bout_paused"; pauseId: string }
  | { type: "bout_resumed"; pauseId: string }
  | { type: "bout_finished"; boutId: string; restId: string; pauseId: string | null }
  | { type: "next_bout_started"; boutId: string; restId: string };

/**
 * The most recent undoable transition of this session, or `null` when nothing
 * of the five listed above is currently reversible (a correction has moved
 * one side of a coupled pair since, the session has no history yet, or the
 * session is not `ACTIVE`).
 *
 * Derived purely from the persisted records, never a separate undo stack or
 * store (owner decision, issue #22), so it survives a reload and a second
 * tab. It deliberately does not use the repository's own `updated_at`
 * bookkeeping to find "the last write": that timestamp comes from the
 * injected wall clock (`commitAction`'s `now()`), which some tests -- and in
 * principle a real device with a broken or stepped-back clock -- hold fixed
 * or non-monotonic on purpose (`frontend/src/pad/padWorkflow.test.ts`, "A
 * fixed repository clock deliberately makes every updated_at identical").
 * Instead this reads the same *domain* coupling every transition itself
 * establishes -- a bout and the rest it closed share one `started_at`/
 * `ended_at` instant by construction (`startNextWalkingBoutAction`,
 * `finishWalkingBoutAction`) -- which stays correct however the wall clock
 * behaves, because those values come from `monotonicNow`, guaranteed
 * non-decreasing within one session.
 *
 * Each of the three states with a running interval maps to exactly one kind
 * of undo, using the view's own `current*` fields (already unambiguous: the
 * repository's cardinality rules allow at most one open bout, pause and rest
 * per session/bout):
 *
 * - WALKING with pauses already recorded against the open bout: the bout was
 *   resumed -- reopen its most recently closed pause.
 * - WALKING with no pauses yet: the bout was just started. If some rest in
 *   the session closed at exactly this bout's `started_at`, it was the one
 *   `START NEXT BOUT` closed to open this bout (`next_bout_started`);
 *   otherwise this is a fresh start from READY (`bout_started`).
 * - PAUSED: the bout was just paused -- delete the open pause.
 * - RESTING, and the rest still starts exactly where the bout ended (no
 *   correction has moved either since): the bout was just finished -- reopen
 *   it, delete the rest, and reopen whichever pause (if any) closed at the
 *   same instant the bout did.
 */
export function detectUndoableWalkingTransition(view: PadSessionView): UndoableWalkingTransition | null {
  const { state, currentBout, currentPause, currentRest, pauses, rests } = view;
  switch (state) {
    case "WALKING": {
      if (currentBout === null) {
        return null;
      }
      const closedBoutPauses = pauses.filter(
        (pause) => pause.walking_bout_id === currentBout.id && pause.ended_at !== null,
      );
      if (closedBoutPauses.length > 0) {
        const latestPause = closedBoutPauses.reduce((latest, pause) =>
          Date.parse(pause.ended_at ?? "") > Date.parse(latest.ended_at ?? "") ? pause : latest);
        return { type: "bout_resumed", pauseId: latestPause.id };
      }
      const coupledRest = rests.find(
        (rest) => rest.walking_bout_id !== currentBout.id && rest.ended_at === currentBout.started_at,
      );
      return coupledRest === undefined
        ? { type: "bout_started", boutId: currentBout.id }
        : { type: "next_bout_started", boutId: currentBout.id, restId: coupledRest.id };
    }
    case "PAUSED": {
      if (currentPause === null) {
        return null;
      }
      return { type: "bout_paused", pauseId: currentPause.id };
    }
    case "RESTING": {
      if (currentBout === null || currentRest === null) {
        return null;
      }
      if (currentRest.started_at !== currentBout.ended_at) {
        return null;
      }
      const closedPause = pauses.find(
        (pause) => pause.walking_bout_id === currentBout.id && pause.ended_at === currentBout.ended_at,
      );
      return {
        type: "bout_finished",
        boutId: currentBout.id,
        restId: currentRest.id,
        pauseId: closedPause?.id ?? null,
      };
    }
    case "READY":
    case "COMPLETED":
      return null;
  }
}

export interface UndoLastWalkingTransitionInput {
  actionId: string;
  view: PadSessionView;
}

/**
 * Undo the most recent supported state-changing action, as a forward
 * compensating mutation (owner decision, issue #22): this commits a NEW
 * `LocalAction` with a higher sequence that reverses the last transition's
 * effect. Nothing is ever removed from or rewritten in the outbox -- the
 * original action's envelope stays exactly as it was, pushed or not; undo
 * works identically either way, because the server applies this action's
 * tombstones and reopenings the same way it applies any other put/delete.
 *
 * Reviving a just-tombstoned bout is only legal for the device that deleted
 * it (docs/data-sync.md, "A tombstone wins"), which undo always is: it runs
 * on the same device, immediately after, before any other device could have
 * touched the record.
 */
export function undoLastWalkingTransitionAction({ actionId, view }: UndoLastWalkingTransitionInput): LocalAction {
  if (view.session.status !== "ACTIVE") throw new InvalidActionError("Session is no longer active");
  const transition = detectUndoableWalkingTransition(view);
  if (transition === null) {
    throw new InvalidActionError("There is nothing to undo");
  }

  const changes: LocalAction["changes"] = [];
  const preconditions: RecordPrecondition[] = [workflowPrecondition(view)];

  switch (transition.type) {
    case "bout_started": {
      const rawBout = rawById(view.boutRecords, transition.boutId);
      changes.push({ store: "walking_bouts", operation: "delete", id: transition.boutId });
      preconditions.push(
        { store: "walking_bouts", id: transition.boutId, expected: { ended_at: null } },
        unchangedRecordPrecondition("walking_bouts", rawBout),
      );
      break;
    }
    case "bout_paused": {
      const rawPause = rawById(view.pauseRecords, transition.pauseId);
      changes.push({ store: "walking_pauses", operation: "delete", id: transition.pauseId });
      preconditions.push(
        { store: "walking_pauses", id: transition.pauseId, expected: { ended_at: null } },
        unchangedRecordPrecondition("walking_pauses", rawPause),
      );
      break;
    }
    case "bout_resumed": {
      const rawPause = rawById(view.pauseRecords, transition.pauseId);
      changes.push({ store: "walking_pauses", operation: "put", record: { ...carriedFields(rawPause), ended_at: null } });
      preconditions.push(unchangedRecordPrecondition("walking_pauses", rawPause));
      break;
    }
    case "bout_finished": {
      const rawBout = rawById(view.boutRecords, transition.boutId);
      const rawRest = rawById(view.restRecords, transition.restId);
      changes.push({ store: "walking_bouts", operation: "put", record: { ...carriedFields(rawBout), ended_at: null } });
      changes.push({ store: "walking_rests", operation: "delete", id: transition.restId });
      preconditions.push(
        unchangedRecordPrecondition("walking_bouts", rawBout),
        { store: "walking_rests", id: transition.restId, expected: { ended_at: null } },
        unchangedRecordPrecondition("walking_rests", rawRest),
      );
      if (transition.pauseId !== null) {
        const rawPause = rawById(view.pauseRecords, transition.pauseId);
        changes.push({ store: "walking_pauses", operation: "put", record: { ...carriedFields(rawPause), ended_at: null } });
        preconditions.push(unchangedRecordPrecondition("walking_pauses", rawPause));
      }
      break;
    }
    case "next_bout_started": {
      const rawBout = rawById(view.boutRecords, transition.boutId);
      const rawRest = rawById(view.restRecords, transition.restId);
      changes.push({ store: "walking_bouts", operation: "delete", id: transition.boutId });
      changes.push({ store: "walking_rests", operation: "put", record: { ...carriedFields(rawRest), ended_at: null } });
      preconditions.push(
        { store: "walking_bouts", id: transition.boutId, expected: { ended_at: null } },
        unchangedRecordPrecondition("walking_bouts", rawBout),
        unchangedRecordPrecondition("walking_rests", rawRest),
      );
      break;
    }
  }

  changes.push(workflowChange(view));
  return { actionId, changes, preconditions };
}

export interface DeleteWalkingBoutInput {
  actionId: string;
  view: PadSessionView;
  boutId: string;
}

/**
 * Delete a finished bout and its pauses and rest, and renumber the surviving
 * bouts of the session contiguously in start order -- all in one action, one
 * transaction, one outbox envelope (owner decision, issue #22). UUIDs never
 * change; only `bout_number` (a display field, not identity -- see
 * `backend/apps/pad/models.py`'s `WalkingBout.bout_number` docstring) moves.
 *
 * Restricted to a bout that has already finished: an in-progress bout is
 * removed through undo (if it was just started) or finished first, not
 * deleted out from under a running timer. The server's own delete cascades
 * to any live child this action does not list (another device's late pause,
 * say -- docs/data-sync.md, "A delete cascades"), but this device deletes
 * every pause and rest it currently knows about explicitly: unlike the
 * server, the local repository's `commitAction` does not cascade a delete on
 * its own (docs/data-sync.md, "The frontend mirrors these rules": "delete
 * children with their parent").
 */
export function deleteWalkingBoutAction({ actionId, view, boutId }: DeleteWalkingBoutInput): LocalAction {
  if (view.session.status !== "ACTIVE") throw new InvalidActionError("Session is no longer active");
  const bout = view.bouts.find((item) => item.id === boutId);
  if (bout === undefined) throw new InvalidActionError("Bout does not belong to session");
  if (bout.ended_at === null) throw new InvalidActionError("Cannot delete a bout that has not finished");

  const rawBout = rawById(view.boutRecords, boutId);
  const changes: LocalAction["changes"] = [];
  const preconditions: RecordPrecondition[] = [workflowPrecondition(view), unchangedRecordPrecondition("walking_bouts", rawBout)];

  for (const pause of view.pauseRecords) {
    if (recordText(pause, "walking_bout_id") === boutId) {
      changes.push({ store: "walking_pauses", operation: "delete", id: pause.id });
      preconditions.push(unchangedRecordPrecondition("walking_pauses", pause));
    }
  }
  for (const rest of view.restRecords) {
    if (recordText(rest, "walking_bout_id") === boutId) {
      changes.push({ store: "walking_rests", operation: "delete", id: rest.id });
      preconditions.push(unchangedRecordPrecondition("walking_rests", rest));
    }
  }
  changes.push({ store: "walking_bouts", operation: "delete", id: boutId });

  const survivors = view.bouts
    .filter((item) => item.id !== boutId)
    .slice()
    .sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at));
  survivors.forEach((survivor, index) => {
    const nextNumber = index + 1;
    if (survivor.bout_number !== nextNumber) {
      const rawSurvivor = rawById(view.boutRecords, survivor.id);
      changes.push({ store: "walking_bouts", operation: "put", record: { ...carriedFields(rawSurvivor), bout_number: nextNumber } });
      preconditions.push(unchangedRecordPrecondition("walking_bouts", rawSurvivor));
    }
  });

  changes.push(workflowChange(view));
  return { actionId, changes, preconditions };
}
