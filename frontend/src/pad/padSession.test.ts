import { describe, expect, it } from "vitest";

import type { DomainStore, LocalRecord, RecoverySnapshot } from "../storage";
import {
  finishWalkingSessionAction,
  findPreviousWalkingSession,
  hasReachedMaximum,
  inheritedWalkingSettings,
  readPadSession,
  startWalkingBoutAction,
  startWalkingSessionAction,
  totalWalkingMs,
  walkingElapsedMs,
  DEFAULT_WALKING_SETTINGS,
  type PadSessionView,
} from "./index";
import { parseWalkingSession } from "./records";

const STORES: DomainStore[] = [
  "walking_sessions",
  "walking_bouts",
  "walking_pauses",
  "walking_rests",
  "resistance_sessions",
  "resistance_rows",
  "cardio_sessions",
  "routine_templates",
  "routine_exercises",
  "exercise_registry",
];

function snapshot(records: Partial<Record<DomainStore, LocalRecord[]>>): RecoverySnapshot {
  return {
    records: Object.fromEntries(STORES.map((store) => [store, records[store] ?? []])) as Record<
      DomainStore,
      LocalRecord[]
    >,
    pendingOutbox: [],
  };
}

const SESSION: LocalRecord = {
  id: "session-1",
  status: "ACTIVE",
  started_at: "2026-09-18T10:00:00.000Z",
  completed_at: null,
  speed_kmh: 5,
  incline_pct: 2,
  max_bout_seconds: 480,
  session_notes: null,
  created_at: "2026-09-18T10:00:00.000Z",
};

function bout(overrides: Partial<LocalRecord> & { id: string }): LocalRecord {
  return {
    walking_session_id: "session-1",
    bout_number: 1,
    started_at: "2026-09-18T10:01:00.000Z",
    ended_at: null,
    pain_min: null,
    pain_max: null,
    stop_reason: null,
    notes: null,
    ...overrides,
  };
}

/** `now` for every derivation below: eleven minutes into the session. */
const NOW = Date.parse("2026-09-18T10:11:00.000Z");

function elapsedOfFirstBout(padSession: PadSessionView): number {
  const [first] = padSession.bouts;
  if (first === undefined) {
    throw new Error("Expected at least one bout");
  }
  return walkingElapsedMs(first, padSession.pauses, NOW);
}

function view(records: Partial<Record<DomainStore, LocalRecord[]>>): PadSessionView {
  const result = readPadSession(snapshot({ walking_sessions: [SESSION], ...records }));
  if (result === null) {
    throw new Error("Expected an active PAD session");
  }
  return result;
}

describe("PAD state machine", () => {
  it("is READY for an active session with no bout yet", () => {
    const padSession = view({});

    expect(padSession.state).toBe("READY");
    expect(padSession.currentBoutNumber).toBe(1);
    expect(padSession.currentBout).toBeNull();
  });

  it("is WALKING while a bout is open, and numbers the next bout after the last one", () => {
    const padSession = view({
      walking_bouts: [
        bout({ id: "bout-1", bout_number: 1, ended_at: "2026-09-18T10:09:00.000Z" }),
        bout({ id: "bout-2", bout_number: 2, started_at: "2026-09-18T10:10:00.000Z" }),
      ],
    });

    expect(padSession.state).toBe("WALKING");
    expect(padSession.currentBout?.id).toBe("bout-2");
    expect(padSession.currentBoutNumber).toBe(2);
  });

  it("is PAUSED while the open bout has an open pause", () => {
    const padSession = view({
      walking_bouts: [bout({ id: "bout-1" })],
      walking_pauses: [
        {
          id: "pause-1",
          walking_bout_id: "bout-1",
          started_at: "2026-09-18T10:09:00.000Z",
          ended_at: null,
        },
      ],
    });

    expect(padSession.state).toBe("PAUSED");
    expect(padSession.currentPause?.id).toBe("pause-1");
  });

  it("is RESTING once the bout is closed and its rest is open", () => {
    const padSession = view({
      walking_bouts: [bout({ id: "bout-1", ended_at: "2026-09-18T10:09:00.000Z" })],
      walking_rests: [
        {
          id: "rest-1",
          walking_bout_id: "bout-1",
          started_at: "2026-09-18T10:09:00.000Z",
          ended_at: null,
        },
      ],
    });

    expect(padSession.state).toBe("RESTING");
    expect(padSession.currentBout?.id).toBe("bout-1");
    expect(padSession.currentBoutNumber).toBe(2);
  });

  it("reports no active session once the session is no longer ACTIVE", () => {
    expect(readPadSession(snapshot({ walking_sessions: [{ ...SESSION, status: "COMPLETED" }] })))
      .toBeNull();
  });
});

describe("PAD elapsed time", () => {
  it("derives bout time from stored timestamps, net of pauses", () => {
    const padSession = view({
      walking_bouts: [bout({ id: "bout-1" })],
      walking_pauses: [
        {
          id: "pause-1",
          walking_bout_id: "bout-1",
          started_at: "2026-09-18T10:03:00.000Z",
          ended_at: "2026-09-18T10:05:00.000Z",
        },
      ],
    });

    // 10:01 -> 10:11 is ten minutes, of which two were paused.
    expect(elapsedOfFirstBout(padSession)).toBe(8 * 60_000);
  });

  it("counts an open pause up to now, so walking time stops while paused", () => {
    const padSession = view({
      walking_bouts: [bout({ id: "bout-1" })],
      walking_pauses: [
        {
          id: "pause-1",
          walking_bout_id: "bout-1",
          started_at: "2026-09-18T10:06:00.000Z",
          ended_at: null,
        },
      ],
    });

    expect(elapsedOfFirstBout(padSession)).toBe(5 * 60_000);
  });

  it("flags the configured maximum without ending the bout", () => {
    const short = view({
      walking_sessions: [{ ...SESSION, max_bout_seconds: 900 }],
      walking_bouts: [bout({ id: "bout-1" })],
    });
    const reached = view({
      walking_sessions: [{ ...SESSION, max_bout_seconds: 300 }],
      walking_bouts: [bout({ id: "bout-1" })],
    });

    expect(hasReachedMaximum(short, NOW)).toBe(false);
    expect(hasReachedMaximum(reached, NOW)).toBe(true);
    expect(reached.state).toBe("WALKING");
  });

  it("totals effective walking time across bouts", () => {
    const padSession = view({
      walking_bouts: [
        bout({
          id: "bout-1",
          started_at: "2026-09-18T10:01:00.000Z",
          ended_at: "2026-09-18T10:05:00.000Z",
        }),
        bout({
          id: "bout-2",
          bout_number: 2,
          started_at: "2026-09-18T10:08:00.000Z",
          ended_at: "2026-09-18T10:10:00.000Z",
        }),
      ],
    });

    expect(totalWalkingMs(padSession, NOW)).toBe(6 * 60_000);
  });
});

describe("PAD record parsing", () => {
  it("keeps a session resumable when only display fields are malformed", () => {
    const parsed = parseWalkingSession({
      ...SESSION,
      speed_kmh: "fast",
      incline_pct: null,
      max_bout_seconds: -1,
    });

    expect(parsed).toEqual(
      expect.objectContaining({
        id: "session-1",
        speed_kmh: DEFAULT_WALKING_SETTINGS.speed_kmh,
        incline_pct: DEFAULT_WALKING_SETTINGS.incline_pct,
        max_bout_seconds: DEFAULT_WALKING_SETTINGS.max_bout_seconds,
      }),
    );
  });

  it("falls back to the repository's created_at when started_at is unusable", () => {
    expect(parseWalkingSession({ ...SESSION, started_at: "not a date" })?.started_at).toBe(
      SESSION.created_at,
    );
  });

  it("drops rows whose identity or interval is untrustworthy instead of throwing", () => {
    const padSession = view({
      walking_bouts: [
        bout({ id: "bout-1", ended_at: "2026-09-18T10:05:00.000Z" }),
        // A corrupt end time must not be read as "still open": that would show a
        // phantom running bout.
        bout({ id: "bout-corrupt", bout_number: 2, ended_at: "yesterday" }),
        // Another session's bout.
        bout({ id: "bout-other", walking_session_id: "session-2" }),
      ],
      walking_pauses: [
        { id: "pause-orphan", walking_bout_id: "missing-bout", started_at: "2026-09-18T10:02:00.000Z" },
      ],
    });

    expect(padSession.bouts.map((item) => item.id)).toEqual(["bout-1"]);
    expect(padSession.pauses).toEqual([]);
    expect(padSession.state).toBe("READY");
  });

  it("numbers bouts by start order when the stored number is missing", () => {
    const padSession = view({
      walking_bouts: [
        bout({ id: "bout-late", bout_number: null, started_at: "2026-09-18T10:06:00.000Z", ended_at: "2026-09-18T10:07:00.000Z" }),
        bout({ id: "bout-early", bout_number: null, started_at: "2026-09-18T10:01:00.000Z", ended_at: "2026-09-18T10:02:00.000Z" }),
      ],
    });

    expect(padSession.bouts.map((item) => [item.id, item.bout_number])).toEqual([
      ["bout-early", 1],
      ["bout-late", 2],
    ]);
    expect(padSession.currentBoutNumber).toBe(3);
  });
});

describe("PAD settings inheritance", () => {
  const completed: LocalRecord = {
    ...SESSION,
    id: "session-old",
    status: "COMPLETED",
    started_at: "2026-09-16T09:00:00.000Z",
    completed_at: "2026-09-16T09:40:00.000Z",
    speed_kmh: 5.6,
    incline_pct: 3.5,
    max_bout_seconds: 300,
  };

  it("uses the application defaults when no completed session exists", () => {
    const previous = findPreviousWalkingSession({
      sessions: [SESSION, { ...completed, status: "DISCARDED" }],
      bouts: [],
      pauses: [],
    });

    expect(previous).toBeNull();
    expect(inheritedWalkingSettings(previous)).toEqual(DEFAULT_WALKING_SETTINGS);
  });

  it("inherits from the most recently completed session and summarizes it", () => {
    const previous = findPreviousWalkingSession({
      sessions: [
        { ...completed, id: "session-older", completed_at: "2026-09-10T09:40:00.000Z", speed_kmh: 4 },
        completed,
      ],
      bouts: [
        {
          id: "bout-1",
          walking_session_id: "session-old",
          bout_number: 1,
          started_at: "2026-09-16T09:05:00.000Z",
          ended_at: "2026-09-16T09:13:00.000Z",
        },
        {
          id: "bout-2",
          walking_session_id: "session-old",
          bout_number: 2,
          started_at: "2026-09-16T09:20:00.000Z",
          ended_at: "2026-09-16T09:26:00.000Z",
        },
      ],
      pauses: [
        {
          id: "pause-1",
          walking_bout_id: "bout-1",
          started_at: "2026-09-16T09:07:00.000Z",
          ended_at: "2026-09-16T09:08:00.000Z",
        },
      ],
    });

    expect(previous?.settings).toEqual({ speed_kmh: 5.6, incline_pct: 3.5, max_bout_seconds: 300 });
    expect(previous?.boutCount).toBe(2);
    expect(previous?.walkingMs).toBe(13 * 60_000);
    expect(inheritedWalkingSettings(previous)).toEqual(previous?.settings);
  });
});

describe("PAD actions", () => {
  const now = new Date("2026-09-18T10:11:00.000Z");

  it("starts a session as one action guarded by the record's absence", () => {
    const action = startWalkingSessionAction({
      actionId: "action-1",
      sessionId: "session-1",
      settings: DEFAULT_WALKING_SETTINGS,
      now,
    });

    expect(action.changes).toHaveLength(1);
    expect(action.changes[0]).toEqual({
      store: "walking_sessions",
      operation: "put",
      record: {
        id: "session-1",
        status: "ACTIVE",
        started_at: now.toISOString(),
        completed_at: null,
        session_notes: null,
        ...DEFAULT_WALKING_SETTINGS,
      },
    });
    expect(action.preconditions).toEqual([
      { store: "walking_sessions", id: "session-1", expected: null },
    ]);
  });

  it("starts the next bout only while its session is still ACTIVE", () => {
    const action = startWalkingBoutAction({
      actionId: "action-2",
      boutId: "bout-2",
      view: view({ walking_bouts: [bout({ id: "bout-1", ended_at: "2026-09-18T10:05:00.000Z" })] }),
      now,
    });

    expect(action.changes[0]).toEqual({
      store: "walking_bouts",
      operation: "put",
      record: expect.objectContaining({
        id: "bout-2",
        walking_session_id: "session-1",
        bout_number: 2,
        started_at: now.toISOString(),
        ended_at: null,
        stop_reason: null,
      }) as unknown,
    });
    expect(action.preconditions).toContainEqual({
      store: "walking_sessions",
      id: "session-1",
      expected: { status: "ACTIVE" },
    });
  });

  it("finishes a session by closing every open interval in one action", () => {
    const action = finishWalkingSessionAction({
      actionId: "action-3",
      view: view({
        walking_bouts: [bout({ id: "bout-1" })],
        walking_pauses: [
          {
            id: "pause-1",
            walking_bout_id: "bout-1",
            started_at: "2026-09-18T10:09:00.000Z",
            ended_at: null,
          },
        ],
      }),
      now,
    });

    expect(action.changes).toEqual([
      expect.objectContaining({
        store: "walking_pauses",
        record: expect.objectContaining({ id: "pause-1", ended_at: now.toISOString() }) as unknown,
      }),
      expect.objectContaining({
        store: "walking_bouts",
        record: expect.objectContaining({ id: "bout-1", ended_at: now.toISOString() }) as unknown,
      }),
      expect.objectContaining({
        store: "walking_sessions",
        record: expect.objectContaining({
          id: "session-1",
          status: "COMPLETED",
          completed_at: now.toISOString(),
        }) as unknown,
      }),
    ]);
  });

  it("closes an open rest when the session is finished from RESTING", () => {
    const action = finishWalkingSessionAction({
      actionId: "action-4",
      view: view({
        walking_bouts: [bout({ id: "bout-1", ended_at: "2026-09-18T10:05:00.000Z" })],
        walking_rests: [
          {
            id: "rest-1",
            walking_bout_id: "bout-1",
            started_at: "2026-09-18T10:05:00.000Z",
            ended_at: null,
          },
        ],
      }),
      now,
    });

    expect(action.changes.map((change) => change.store)).toEqual([
      "walking_rests",
      "walking_sessions",
    ]);
  });
});
