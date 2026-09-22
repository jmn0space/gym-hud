/**
 * The PAD walking domain, mirroring the field lists in docs/pad-walking.md.
 *
 * `created_at`, `updated_at` and `deleted_at` are deliberately absent from these
 * types: the local repository owns that metadata and stamps it inside the commit
 * transaction (docs/data-sync.md, "Local action contract"), so the domain layer
 * never invents it.
 */

export type WalkingSessionStatus = "ACTIVE" | "COMPLETED" | "DISCARDED";

export const WALKING_STOP_REASONS = [
  "MAX_DURATION",
  "CLAUDICATION",
  "FOOT_NUMBNESS",
  "SUDDEN_SWELLING",
  "OTHER",
] as const;

export type WalkingStopReason = (typeof WALKING_STOP_REASONS)[number];

/** The treadmill settings every bout of one session shares. */
export interface WalkingSessionSettings {
  speed_kmh: number;
  incline_pct: number;
  max_bout_seconds: number;
}

export interface WalkingSession extends WalkingSessionSettings {
  id: string;
  status: WalkingSessionStatus;
  started_at: string;
  completed_at: string | null;
  session_notes: string | null;
}

export interface WalkingBout {
  id: string;
  walking_session_id: string;
  bout_number: number;
  started_at: string;
  ended_at: string | null;
  pain_min: number | null;
  pain_max: number | null;
  /**
   * When pain started during this bout (docs/pad-walking.md, "Pain onset"), or
   * null while none has been recorded. A moment inside the bout, not a duration:
   * the pain-free walking time every screen shows is derived from it and the
   * bout's own timestamps, never stored.
   */
  pain_onset_at: string | null;
  stop_reason: WalkingStopReason | null;
  notes: string | null;
}

export interface WalkingBoutPause {
  id: string;
  walking_bout_id: string;
  started_at: string;
  ended_at: string | null;
}

export interface WalkingRest {
  id: string;
  walking_bout_id: string;
  started_at: string;
  ended_at: string | null;
}

/**
 * Operational state, derived purely from persisted records and their timestamps.
 * `COMPLETED` covers both terminal session statuses: a discarded session is as
 * finished as a completed one as far as the HUD is concerned.
 */
export type WalkingState = "READY" | "WALKING" | "PAUSED" | "RESTING" | "COMPLETED";

/**
 * Application defaults, used when no completed walking session exists to inherit
 * from. The values are the worked example in docs/pad-walking.md ("Settings
 * inheritance" plus "Maximum bout duration").
 */
export const DEFAULT_WALKING_SETTINGS: WalkingSessionSettings = {
  speed_kmh: 5,
  incline_pct: 2,
  max_bout_seconds: 480,
};
