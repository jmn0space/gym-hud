import { describe, expect, it } from "vitest";

import type { DomainStore, LocalRecord, RecoverySnapshot } from "../storage";
import { deriveActiveSessionSummaries } from "./activeSessions";

const stores: DomainStore[] = [
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

function recovery(recordsByStore: Partial<Record<DomainStore, LocalRecord[]>>): RecoverySnapshot {
  const records = Object.fromEntries(
    stores.map((store) => [store, recordsByStore[store] ?? []]),
  ) as Record<DomainStore, LocalRecord[]>;
  return { records, pendingOutbox: [] };
}

const now = Date.parse("2026-09-14T12:10:00.000Z");

describe("deriveActiveSessionSummaries", () => {
  it("derives effective walking time from the open bout and persisted pauses", () => {
    const summaries = deriveActiveSessionSummaries(
      recovery({
        walking_sessions: [
          { id: "session-1", status: "ACTIVE", started_at: "2026-09-14T11:45:00.000Z" },
        ],
        walking_bouts: [
          {
            id: "bout-1",
            walking_session_id: "session-1",
            started_at: "2026-09-14T12:00:00.000Z",
            ended_at: null,
          },
        ],
        walking_pauses: [
          {
            id: "pause-1",
            walking_bout_id: "bout-1",
            started_at: "2026-09-14T12:02:00.000Z",
            ended_at: "2026-09-14T12:03:00.000Z",
          },
        ],
      }),
      now,
    );

    expect(summaries).toEqual([
      expect.objectContaining({ status: "Walking · Bout 1", elapsedMs: 9 * 60_000 }),
    ]);
  });

  it("derives paused and resting timers from their own open intervals", () => {
    const paused = deriveActiveSessionSummaries(
      recovery({
        walking_sessions: [
          { id: "session-1", status: "ACTIVE", started_at: "2026-09-14T11:45:00.000Z" },
        ],
        walking_bouts: [
          {
            id: "bout-1",
            walking_session_id: "session-1",
            started_at: "2026-09-14T12:00:00.000Z",
            ended_at: null,
          },
        ],
        walking_pauses: [
          {
            id: "pause-1",
            walking_bout_id: "bout-1",
            started_at: "2026-09-14T12:08:00.000Z",
            ended_at: null,
          },
        ],
      }),
      now,
    );
    const resting = deriveActiveSessionSummaries(
      recovery({
        walking_sessions: [
          { id: "session-1", status: "ACTIVE", started_at: "2026-09-14T11:45:00.000Z" },
        ],
        walking_bouts: [
          {
            id: "bout-1",
            walking_session_id: "session-1",
            started_at: "2026-09-14T11:50:00.000Z",
            ended_at: "2026-09-14T12:09:00.000Z",
          },
        ],
        walking_rests: [
          {
            id: "rest-1",
            walking_bout_id: "bout-1",
            started_at: "2026-09-14T12:09:00.000Z",
            ended_at: null,
          },
        ],
      }),
      now,
    );

    expect(paused[0]).toEqual(
      expect.objectContaining({ status: "Paused · Bout 1", elapsedMs: 120_000 }),
    );
    expect(resting[0]).toEqual(
      expect.objectContaining({ status: "Resting after bout 1", elapsedMs: 60_000 }),
    );
  });

  it("returns one persisted resume card for each simultaneously active workout type", () => {
    const summaries = deriveActiveSessionSummaries(
      recovery({
        walking_sessions: [{ id: "pad", status: "ACTIVE", started_at: "2026-09-14T12:00:00.000Z" }],
        resistance_sessions: [{ id: "weights", status: "ACTIVE", title: "Day 3" }],
        resistance_rows: [
          { id: "row-1", resistance_session_id: "weights", completed: true },
          { id: "row-2", resistance_session_id: "weights", completed: false },
        ],
        cardio_sessions: [
          {
            id: "cardio",
            status: "ACTIVE",
            machine_name: "Arm crank",
            started_at: "2026-09-14T12:05:00.000Z",
          },
          { id: "old-cardio", status: "COMPLETED" },
        ],
      }),
      now,
    );

    expect(summaries).toHaveLength(3);
    expect(summaries).toEqual([
      expect.objectContaining({ title: "PAD Walking", status: "Ready to start bout 1" }),
      expect.objectContaining({ title: "Day 3", status: "1 / 2 exercises complete" }),
      expect.objectContaining({ title: "Cardio · Arm crank", elapsedMs: 300_000 }),
    ]);
  });
});
