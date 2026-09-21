/// <reference types="node" />

/**
 * Cross-language replay contract for issue #22 -- corrections, undo and
 * delete-with-renumber -- paired with `frontend/src/padWorkflowReplay.test.ts`
 * (issue #21) rather than folded into it, so that file's own frozen fixture
 * and proof stay untouched. Every mutation below is produced by a real PAD
 * action builder and the real IndexedDB repository; the Django test posts
 * this fixture through the real `POST /api/v1/sync/mutations/`.
 *
 * To refresh the fixture after an intentional protocol/action change:
 * UPDATE_PAD_REPLAY_FIXTURE=1 npm test -- --run src/padCorrectionsReplay.test.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  correctWalkingBoutTimesAction,
  deleteWalkingBoutAction,
  finishWalkingBoutAction,
  finishWalkingSessionAction,
  pauseWalkingBoutAction,
  resumeWalkingBoutAction,
  startNextWalkingBoutAction,
  startWalkingBoutAction,
  startWalkingSessionAction,
  undoLastWalkingTransitionAction,
} from "./pad/actions";
import { readPadSession, totalWalkingMs, walkingElapsedMs, type PadSessionView } from "./pad/session";
import { createLocalRepository, type LocalAction, type LocalRepository } from "./storage";

const FIXTURE_PATH = resolve(
  process.cwd(),
  "../backend/apps/sync/tests/fixtures/pad_corrections_outbox.json",
);
const CLIENT_ID = "00000000-0000-4000-8000-000000000301";
const SESSION_ID = "00000000-0000-4000-8000-000000000302";
const BOUT_1_ID = "00000000-0000-4000-8000-000000000303";
const BOUT_2_ID = "00000000-0000-4000-8000-000000000304";
const BOUT_3_ID = "00000000-0000-4000-8000-000000000305";
const REST_1_ID = "00000000-0000-4000-8000-000000000306";
const REST_2_ID = "00000000-0000-4000-8000-000000000307";
const REST_2B_ID = "00000000-0000-4000-8000-000000000308";
const REST_3_ID = "00000000-0000-4000-8000-000000000309";
const PAUSE_1_ID = "00000000-0000-4000-8000-000000000310";
const ACTION_PREFIX = "00000000-0000-4000-8000-0000000004";
const BASE_TIME = Date.parse("2026-09-20T10:00:00.000Z");

function at(minute: number): Date {
  return new Date(BASE_TIME + minute * 60_000);
}

function actionId(sequence: number): string {
  return `${ACTION_PREFIX}${sequence.toString().padStart(2, "0")}`;
}

describe("PAD corrections/undo/delete replay contract", () => {
  it("retains real correction, undo and delete-with-renumber envelopes for server replay", async () => {
    const indexedDB = new IDBFactory();
    const databaseName = "pad-corrections-replay";
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
    const act = async (
      minute: number,
      build: (id: string, now: Date, view: PadSessionView) => LocalAction,
    ) => {
      const view = await active();
      await commit(minute, (id, now) => build(id, now, view));
    };
    // Undo and delete do not take a `now`: they read and reverse the current
    // persisted state directly. Still routed through `commit` so every
    // mutation shares the same sequencing and fixture-collection logic.
    const actNoClock = async (
      minute: number,
      build: (id: string, view: PadSessionView) => LocalAction,
    ) => {
      const view = await active();
      await commit(minute, (id) => build(id, view));
    };

    try {
      await commit(0, (id, now) =>
        startWalkingSessionAction({
          actionId: id,
          sessionId: SESSION_ID,
          settings: { speed_kmh: 5, incline_pct: 2, max_bout_seconds: 480 },
          now,
        }),
      );
      await act(1, (id, now, view) =>
        startWalkingBoutAction({ actionId: id, boutId: BOUT_1_ID, view, now }),
      );
      await act(2, (id, now, view) =>
        pauseWalkingBoutAction({ actionId: id, pauseId: PAUSE_1_ID, view, now }),
      );
      await act(3, (id, now, view) => resumeWalkingBoutAction({ actionId: id, view, now }));
      // The user leaves the treadmill running well past the intended ~8 minutes.
      await act(20, (id, now, view) =>
        finishWalkingBoutAction({ actionId: id, restId: REST_1_ID, view, now }),
      );
      expect((await active()).state).toBe("RESTING");

      // PAD-09: correct the displayed end time back to what it should have been.
      await actNoClock(21, (id, view) =>
        correctWalkingBoutTimesAction({ actionId: id, view, boutId: BOUT_1_ID, endedAt: at(8).toISOString() }),
      );
      const corrected = await active();
      const correctedBout = corrected.bouts[0];
      if (correctedBout === undefined) throw new Error("Expected bout 1 after correction");
      expect(correctedBout.ended_at).toBe(at(8).toISOString());
      // Started m1, corrected end m8: 7 minutes elapsed, minus the 1-minute
      // pause (m2-m3) = 6 minutes effective walking.
      expect(walkingElapsedMs(correctedBout, corrected.pauses, at(30).getTime())).toBe(6 * 60_000);

      await act(10, (id, now, view) =>
        startNextWalkingBoutAction({ actionId: id, boutId: BOUT_2_ID, view, now }),
      );
      await act(14, (id, now, view) =>
        finishWalkingBoutAction({ actionId: id, restId: REST_2_ID, view, now }),
      );
      expect((await active()).state).toBe("RESTING");

      // Undo the finish: back to WALKING, bout 2 reopened, its rest gone.
      await actNoClock(15, (id, view) => undoLastWalkingTransitionAction({ actionId: id, view }));
      const undone = await active();
      expect(undone.state).toBe("WALKING");
      expect(undone.currentBout?.id).toBe(BOUT_2_ID);
      expect(undone.currentBout?.ended_at).toBeNull();

      // Finish bout 2 again, for real this time.
      await act(16, (id, now, view) =>
        finishWalkingBoutAction({ actionId: id, restId: REST_2B_ID, view, now }),
      );
      await act(17, (id, now, view) =>
        startNextWalkingBoutAction({ actionId: id, boutId: BOUT_3_ID, view, now }),
      );
      await act(22, (id, now, view) =>
        finishWalkingBoutAction({ actionId: id, restId: REST_3_ID, view, now }),
      );
      const beforeDelete = await active();
      expect(beforeDelete.bouts.map((bout) => [bout.id, bout.bout_number])).toEqual([
        [BOUT_1_ID, 1],
        [BOUT_2_ID, 2],
        [BOUT_3_ID, 3],
      ]);

      // Delete bout 2: its pause-free rest goes with it, and bout 3 renumbers to 2.
      await actNoClock(23, (id, view) => deleteWalkingBoutAction({ actionId: id, view, boutId: BOUT_2_ID }));
      const afterDelete = await active();
      expect(afterDelete.bouts.map((bout) => [bout.id, bout.bout_number])).toEqual([
        [BOUT_1_ID, 1],
        [BOUT_3_ID, 2],
      ]);
      const [survivingFirst, survivingSecond] = afterDelete.bouts;
      if (survivingFirst === undefined || survivingSecond === undefined) {
        throw new Error("Expected both surviving bouts after the delete");
      }
      expect(totalWalkingMs(afterDelete, at(30).getTime())).toBe(
        walkingElapsedMs(survivingFirst, afterDelete.pauses, at(30).getTime()) +
          walkingElapsedMs(survivingSecond, afterDelete.pauses, at(30).getTime()),
      );

      clock = at(24);
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

      // Survives close/reopen with every kind of #22 mutation still queued
      // (acceptance criterion 5's offline-reload proof, at the outbox level;
      // `frontend/src/pad/padCorrections.test.ts` proves the same at the
      // domain-record level for each action individually).
      expect(await repository.getRecord("walking_bouts", BOUT_2_ID)).toBeUndefined();
      expect(await repository.getRecord("walking_rests", REST_2_ID)).toBeUndefined();
      expect(await repository.getRecord("walking_rests", REST_2B_ID)).toBeUndefined();
      const finalBout1 = await repository.getRecord("walking_bouts", BOUT_1_ID);
      expect(finalBout1).toMatchObject({ ended_at: at(8).toISOString(), bout_number: 1 });
      const finalBout3 = await repository.getRecord("walking_bouts", BOUT_3_ID);
      expect(finalBout3).toMatchObject({ bout_number: 2 });

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
