/// <reference types="node" />

/**
 * Cross-language replay contract for issue #21. Every mutation in the checked-in
 * fixture is produced by a real PAD action and the real IndexedDB repository.
 * The Django test posts those envelopes through POST /api/v1/sync/mutations/.
 *
 * To refresh the fixture after an intentional protocol/action change:
 * UPDATE_PAD_REPLAY_FIXTURE=1 npm test -- --run src/padWorkflowReplay.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  finishWalkingBoutAction,
  finishWalkingSessionAction,
  pauseWalkingBoutAction,
  resumeWalkingBoutAction,
  startNextWalkingBoutAction,
  startWalkingBoutAction,
  startWalkingSessionAction,
  updateWalkingBoutAction,
  updateWalkingSessionNotesAction,
} from "./pad/actions";
import {
  buildPadSessionView,
  readPadSession,
  totalWalkingMs,
  walkingElapsedMs,
  type PadSessionView,
} from "./pad/session";
import { createLocalRepository, type LocalAction, type LocalRepository } from "./storage";

const FIXTURE_PATH = resolve(
  process.cwd(),
  "../backend/apps/sync/tests/fixtures/pad_workflow_outbox.json",
);
const CLIENT_ID = "00000000-0000-4000-8000-000000000001";
const SESSION_ID = "00000000-0000-4000-8000-000000000201";
const BOUT_1_ID = "00000000-0000-4000-8000-000000000202";
const BOUT_2_ID = "00000000-0000-4000-8000-000000000203";
const REST_1_ID = "00000000-0000-4000-8000-000000000204";
const REST_2_ID = "00000000-0000-4000-8000-000000000205";
const PAUSE_IDS = [
  "00000000-0000-4000-8000-000000000206",
  "00000000-0000-4000-8000-000000000207",
  "00000000-0000-4000-8000-000000000208",
] as const;
const ACTION_PREFIX = "00000000-0000-4000-8000-0000000001";
const BASE_TIME = Date.parse("2026-09-19T10:00:00.000Z");

function at(minute: number): Date {
  return new Date(BASE_TIME + minute * 60_000);
}

function actionId(sequence: number): string {
  return `${ACTION_PREFIX}${sequence.toString().padStart(2, "0")}`;
}

describe("PAD workflow replay contract", () => {
  it("retains real action envelopes after offline close/reopen for server replay", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "pad-workflow-replay";
    let clock = at(0);
    const open = (): LocalRepository =>
      createLocalRepository({ databaseName, indexedDB, now: () => clock, uuid: () => CLIENT_ID });
    let repository = open();
    let sequence = 0;
    const commit = async (minute: number, build: (id: string, now: Date) => LocalAction) => {
      clock = at(minute);
      sequence += 1;
      const receipt = await repository.commitAction(build(actionId(sequence), clock));
      expect(receipt.sequence).toBe(sequence);
    };
    const active = async () => {
      const view = readPadSession(await repository.readSnapshot());
      if (view === null) throw new Error("Expected an active PAD session");
      return view;
    };
    // Keep each action tied to a fresh persisted snapshot, including after reopen.
    const act = async (
      minute: number,
      build: (id: string, now: Date, view: PadSessionView) => LocalAction,
    ) => {
      const view = await active();
      await commit(minute, (id, now) => build(id, now, view));
    };

    try {
      await commit(0, (id, now) =>
        startWalkingSessionAction({
          actionId: id,
          sessionId: SESSION_ID,
          settings: { speed_kmh: 5.65, incline_pct: 2.5, max_bout_seconds: 445 },
          now,
        }),
      );
      expect((await active()).state).toBe("READY");
      await act(1, (id, now, view) =>
        startWalkingBoutAction({ actionId: id, boutId: BOUT_1_ID, view, now }),
      );
      await act(2, (id, now, view) =>
        pauseWalkingBoutAction({ actionId: id, pauseId: PAUSE_IDS[0], view, now }),
      );

      // The network stays unavailable; closing and reopening only touches IDB.
      const beforeReopen = await repository.listPendingOutbox();
      expect(beforeReopen).toHaveLength(3);
      repository.close();
      repository = open();
      expect((await active()).state).toBe("PAUSED");
      expect(await repository.listPendingOutbox()).toEqual(beforeReopen);

      await act(3, (id, now, view) => resumeWalkingBoutAction({ actionId: id, view, now }));
      await act(4, (id, now, view) =>
        pauseWalkingBoutAction({ actionId: id, pauseId: PAUSE_IDS[1], view, now }),
      );
      await act(5, (id, now, view) => resumeWalkingBoutAction({ actionId: id, view, now }));
      await act(6, (id, now, view) =>
        pauseWalkingBoutAction({ actionId: id, pauseId: PAUSE_IDS[2], view, now }),
      );
      expect((await active()).state).toBe("PAUSED");
      await act(7, (id, now, view) =>
        finishWalkingBoutAction({ actionId: id, restId: REST_1_ID, view, now }),
      );
      expect((await active()).state).toBe("RESTING");
      await act(8, (id, _now, view) =>
        updateWalkingBoutAction({
          actionId: id,
          view,
          boutId: BOUT_1_ID,
          painMin: 3,
          painMax: 4,
          stopReason: "CLAUDICATION",
          notes: "Calf pain after third pause",
        }),
      );
      await act(9, (id, _now, view) =>
        updateWalkingSessionNotesAction({ actionId: id, view, notes: "Recovered before bout two" }),
      );
      await act(10, (id, now, view) =>
        startNextWalkingBoutAction({ actionId: id, boutId: BOUT_2_ID, view, now }),
      );
      expect((await active()).state).toBe("WALKING");
      await act(12, (id, now, view) =>
        finishWalkingBoutAction({ actionId: id, restId: REST_2_ID, view, now }),
      );
      expect((await active()).state).toBe("RESTING");
      clock = at(15);
      sequence += 1;
      await repository.commitAction(
        finishWalkingSessionAction({
          actionId: actionId(sequence),
          sessionId: SESSION_ID,
          snapshot: await repository.readSnapshot(),
          now: clock,
        }),
      );
      expect(readPadSession(await repository.readSnapshot())).toBeNull();

      repository.close();
      repository = open();
      const pending = await repository.listPendingOutbox();
      expect(pending).toHaveLength(sequence);
      expect(pending.map((entry) => entry.sequence)).toEqual(
        Array.from({ length: sequence }, (_, index) => index + 1),
      );
      expect(pending[7]?.changes.map((change) => change.store)).toEqual([
        "walking_sessions",
        "walking_bouts",
        "walking_pauses",
        "walking_rests",
      ]);
      expect(pending[10]?.changes.map((change) => change.store)).toEqual([
        "walking_sessions",
        "walking_bouts",
        "walking_rests",
      ]);
      expect(pending[12]?.changes.map((change) => change.store)).toEqual([
        "walking_sessions",
        "walking_rests",
      ]);

      const session = await repository.getRecord("walking_sessions", SESSION_ID);
      const first = await repository.getRecord("walking_bouts", BOUT_1_ID);
      const second = await repository.getRecord("walking_bouts", BOUT_2_ID);
      const firstRest = await repository.getRecord("walking_rests", REST_1_ID);
      const secondRest = await repository.getRecord("walking_rests", REST_2_ID);
      expect(session).toMatchObject({
        status: "COMPLETED",
        completed_at: at(15).toISOString(),
        session_notes: "Recovered before bout two",
      });
      expect(first).toMatchObject({
        ended_at: at(7).toISOString(),
        pain_min: 3,
        pain_max: 4,
        stop_reason: "CLAUDICATION",
        notes: "Calf pain after third pause",
      });
      expect(second).toMatchObject({ ended_at: at(12).toISOString(), bout_number: 2 });
      expect(firstRest).toMatchObject({ ended_at: at(10).toISOString() });
      expect(secondRest).toMatchObject({ ended_at: at(15).toISOString() });
      const pauses = await repository.listRecords("walking_pauses");
      expect(pauses).toHaveLength(3);
      expect(pauses.every((pause) => pause.ended_at !== null)).toBe(true);
      if (session === undefined) throw new Error("Session missing after reopen");
      const completed = buildPadSessionView(
        session,
        await repository.listRecords("walking_bouts"),
        pauses,
        await repository.listRecords("walking_rests"),
      );
      if (completed === null) throw new Error("Completed session could not be parsed");
      const firstBout = completed.bouts[0];
      if (firstBout === undefined) throw new Error("First bout missing after reopen");
      expect(walkingElapsedMs(firstBout, completed.pauses, at(15).getTime())).toBe(3 * 60_000);
      expect(totalWalkingMs(completed, at(15).getTime())).toBe(5 * 60_000);

      const fixture = { client_id: CLIENT_ID, mutations: pending };
      if (process.env.UPDATE_PAD_REPLAY_FIXTURE === "1") {
        writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
      }
      expect(fixture).toEqual(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
    } finally {
      repository.close();
    }
  });
});
