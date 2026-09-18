import type { LocalAction, RecordPrecondition } from "../storage";
import {
  walkingBoutRecord,
  walkingPauseRecord,
  walkingRestRecord,
  walkingSessionRecord,
} from "./records";
import type { PadSessionView } from "./session";
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
          started_at: now.toISOString(),
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

export interface FinishWalkingSessionInput {
  actionId: string;
  view: PadSessionView;
  now: Date;
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
export function finishWalkingSessionAction({
  actionId,
  view,
  now,
}: FinishWalkingSessionInput): LocalAction {
  const endedAt = now.toISOString();
  const changes: LocalAction["changes"] = [];

  if (view.currentPause !== null) {
    changes.push({
      store: "walking_pauses",
      operation: "put",
      record: walkingPauseRecord({ ...view.currentPause, ended_at: endedAt }),
    });
  }
  const openBout = view.bouts.find((bout) => bout.ended_at === null);
  if (openBout !== undefined) {
    changes.push({
      store: "walking_bouts",
      operation: "put",
      record: walkingBoutRecord({ ...openBout, ended_at: endedAt }),
    });
  }
  if (view.currentRest !== null) {
    changes.push({
      store: "walking_rests",
      operation: "put",
      record: walkingRestRecord({ ...view.currentRest, ended_at: endedAt }),
    });
  }
  changes.push({
    store: "walking_sessions",
    operation: "put",
    record: walkingSessionRecord({
      ...view.session,
      status: "COMPLETED",
      completed_at: endedAt,
    }),
  });

  return { actionId, changes, preconditions: [activeSessionPrecondition(view.session.id)] };
}
