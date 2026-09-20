/**
 * What the rest of the application consumes from the PAD domain. Modules inside
 * `pad/` import each other directly, and so do the tests, so this barrel stays
 * narrowed to the surface screens actually use.
 */
export {
  correctWalkingBoutTimesAction,
  correctWalkingPauseTimesAction,
  correctWalkingRestTimesAction,
  deleteWalkingBoutAction,
  detectUndoableWalkingTransition,
  discardWalkingSessionAction,
  finishWalkingSessionAction,
  finishWalkingBoutAction,
  inferWalkingStopReason,
  pauseWalkingBoutAction,
  resumeWalkingBoutAction,
  startWalkingBoutAction,
  startNextWalkingBoutAction,
  startWalkingSessionAction,
  undoLastWalkingTransitionAction,
  updateWalkingBoutAction,
  updateWalkingSessionNotesAction,
} from "./actions";
export {
  buildPadSessionView,
  derivePadElapsedMs,
  findActiveWalkingSessionRecord,
  hasReachedMaximum,
  hasUnreadableOpenRecords,
  readPadSession,
  walkingElapsedMs,
} from "./session";
export {
  findPreviousWalkingSession,
  inheritedWalkingSettings,
  parseWalkingSessionSummary,
  summarizeWalkingSession,
  walkingSessionSummaryValue,
  PREVIOUS_WALKING_SESSION_KEY,
} from "./settings";
export { useNow } from "./useNow";
export { DEFAULT_WALKING_SETTINGS } from "./types";
export type {
  CloseWalkingSessionInput,
  CorrectWalkingBoutTimesInput,
  CorrectWalkingPauseTimesInput,
  CorrectWalkingRestTimesInput,
  DeleteWalkingBoutInput,
  UndoableWalkingTransition,
  UndoLastWalkingTransitionInput,
} from "./actions";
export type { PadSessionView } from "./session";
export type { PreviousWalkingSession } from "./settings";
export type { WalkingBout, WalkingBoutPause, WalkingRest, WalkingSessionSettings, WalkingState, WalkingStopReason } from "./types";
