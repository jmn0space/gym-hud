import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalRepository, InvalidActionError, type LocalRepository } from "../storage";
import {
  correctWalkingBoutTimesAction,
  correctWalkingPauseTimesAction,
  correctWalkingRestTimesAction,
  deleteWalkingBoutAction,
  detectUndoableWalkingTransition,
  finishWalkingBoutAction,
  pauseWalkingBoutAction,
  resumeWalkingBoutAction,
  startNextWalkingBoutAction,
  startWalkingBoutAction,
  startWalkingSessionAction,
  undoLastWalkingTransitionAction,
  updateWalkingBoutAction,
} from "./actions";
import { readPadSession, totalWalkingMs, walkingElapsedMs, type PadSessionView } from "./session";
import { DEFAULT_WALKING_SETTINGS } from "./types";

const factory = new IDBFactory();
const repositories: LocalRepository[] = [];
let database = 0;
// A genuinely advancing clock: every commit gets its own moment, which is what a
// real device does (`utcNow`) and is what lets `detectUndoableWalkingTransition`'s
// domain-coupling reasoning -- and every precondition in this file -- be exercised
// the way production actually behaves.
const at = (minutes: number) => new Date(Date.parse("2026-09-20T09:00:00.000Z") + minutes * 60_000);

function open(): LocalRepository {
  const name = `pad-corrections-${(database++).toString()}`;
  const repo = createLocalRepository({ databaseName: name, indexedDB: factory, now: () => new Date(), uuid: () => "client" });
  repositories.push(repo);
  return repo;
}

async function live(repo: LocalRepository): Promise<PadSessionView> {
  const view = readPadSession(await repo.readSnapshot());
  if (view === null) throw new Error("Expected active PAD session");
  return view;
}

let actionCounter = 0;
function nextActionId(): string {
  actionCounter += 1;
  return `action-${actionCounter.toString()}`;
}

async function start(repo: LocalRepository): Promise<void> {
  await repo.commitAction(startWalkingSessionAction({
    actionId: nextActionId(), sessionId: "session", settings: DEFAULT_WALKING_SETTINGS, now: at(0),
  }));
}

afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
});

describe("PAD time corrections (PAD-09)", () => {
  it("recalculates bout duration, effective walking time, rest duration and session totals after correcting a late finish", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(0) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: nextActionId(), pauseId: "pause-1", view: await live(repo), now: at(2) }));
    await repo.commitAction(resumeWalkingBoutAction({ actionId: nextActionId(), view: await live(repo), now: at(3) }));
    // The bout accidentally runs on to minute 30 instead of the intended ~8.
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(30) }));

    let view = await live(repo);
    const beforeBout = view.bouts[0];
    if (beforeBout === undefined) throw new Error("Expected bout 1");
    expect(walkingElapsedMs(beforeBout, view.pauses, at(40).getTime())).toBe(29 * 60_000);

    // Edit the displayed end time back to what it should have been: minute 8.
    await repo.commitAction(correctWalkingBoutTimesAction({
      actionId: nextActionId(), view, boutId: "bout-1", endedAt: at(8).toISOString(),
    }));

    view = await live(repo);
    const correctedBout = view.bouts[0];
    if (correctedBout === undefined) throw new Error("Expected bout 1 after correction");
    expect(correctedBout.ended_at).toBe(at(8).toISOString());
    // Effective walking time: 8 minutes elapsed minus the 1-minute pause.
    expect(walkingElapsedMs(correctedBout, view.pauses, at(40).getTime())).toBe(7 * 60_000);
    expect(totalWalkingMs(view, at(40).getTime())).toBe(7 * 60_000);
    // The rest kept its own recorded start (minute 30): the correction does not
    // silently move it, and it still satisfies "starts at or after the bout ended".
    const rest = view.rests.find((item) => item.walking_bout_id === "bout-1");
    expect(rest?.started_at).toBe(at(30).toISOString());
  });

  it("rejects a bout end correction that would start its rest before the bout now ends", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(0) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    const view = await live(repo);

    expect(() => correctWalkingBoutTimesAction({
      actionId: nextActionId(), view, boutId: "bout-1", endedAt: at(9).toISOString(),
    })).toThrow(InvalidActionError);
  });

  it("rejects a bout start correction before the session started", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    const view = await live(repo);

    expect(() => correctWalkingBoutTimesAction({
      actionId: nextActionId(), view, boutId: "bout-1", startedAt: at(-5).toISOString(),
    })).toThrow(InvalidActionError);
  });

  it("rejects a bout end before its own start", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    const view = await live(repo);

    expect(() => correctWalkingBoutTimesAction({
      actionId: nextActionId(), view, boutId: "bout-1", endedAt: at(0.5).toISOString(),
    })).toThrow(InvalidActionError);
  });

  it("refuses to correct the end of a bout that has not finished", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    const view = await live(repo);

    expect(() => correctWalkingBoutTimesAction({
      actionId: nextActionId(), view, boutId: "bout-1", endedAt: at(5).toISOString(),
    })).toThrow(InvalidActionError);
  });

  it("refuses a correction with no changes and an invalid timestamp", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    const view = await live(repo);

    expect(() => correctWalkingBoutTimesAction({ actionId: nextActionId(), view, boutId: "bout-1" })).toThrow(InvalidActionError);
    expect(() => correctWalkingBoutTimesAction({
      actionId: nextActionId(), view, boutId: "bout-1", startedAt: "not-a-timestamp",
    })).toThrow(InvalidActionError);
  });

  it("rejects a pause correction that would start before its bout started", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: nextActionId(), pauseId: "pause-1", view: await live(repo), now: at(2) }));
    await repo.commitAction(resumeWalkingBoutAction({ actionId: nextActionId(), view: await live(repo), now: at(3) }));
    const view = await live(repo);

    expect(() => correctWalkingPauseTimesAction({
      actionId: nextActionId(), view, pauseId: "pause-1", startedAt: at(0.5).toISOString(),
    })).toThrow(InvalidActionError);
  });

  it("rejects a pause correction that would end after its (now closed) bout ended", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: nextActionId(), pauseId: "pause-1", view: await live(repo), now: at(2) }));
    await repo.commitAction(resumeWalkingBoutAction({ actionId: nextActionId(), view: await live(repo), now: at(3) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    const view = await live(repo);

    expect(() => correctWalkingPauseTimesAction({
      actionId: nextActionId(), view, pauseId: "pause-1", endedAt: at(9).toISOString(),
    })).toThrow(InvalidActionError);
  });

  it("rejects overlapping pauses of the same bout", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: nextActionId(), pauseId: "pause-1", view: await live(repo), now: at(2) }));
    await repo.commitAction(resumeWalkingBoutAction({ actionId: nextActionId(), view: await live(repo), now: at(3) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: nextActionId(), pauseId: "pause-2", view: await live(repo), now: at(4) }));
    await repo.commitAction(resumeWalkingBoutAction({ actionId: nextActionId(), view: await live(repo), now: at(5) }));
    const view = await live(repo);

    // Push pause-1 forward so it now overlaps pause-2 (4-5).
    expect(() => correctWalkingPauseTimesAction({
      actionId: nextActionId(), view, pauseId: "pause-1", endedAt: at(4.5).toISOString(),
    })).toThrow(InvalidActionError);
  });

  it("rejects an end before its own start, for a pause and a rest", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: nextActionId(), pauseId: "pause-1", view: await live(repo), now: at(2) }));
    await repo.commitAction(resumeWalkingBoutAction({ actionId: nextActionId(), view: await live(repo), now: at(3) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    await repo.commitAction(startNextWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-2", view: await live(repo), now: at(10) }));
    const view = await live(repo);

    expect(() => correctWalkingPauseTimesAction({
      actionId: nextActionId(), view, pauseId: "pause-1", endedAt: at(1.5).toISOString(),
    })).toThrow(InvalidActionError);
    expect(() => correctWalkingRestTimesAction({
      actionId: nextActionId(), view, restId: "rest-1", endedAt: at(7.5).toISOString(),
    })).toThrow(InvalidActionError);
  });

  it("rejects a rest correction that would start before its bout ended, and one belonging to an unfinished bout", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    const view = await live(repo);

    expect(() => correctWalkingRestTimesAction({
      actionId: nextActionId(), view, restId: "rest-1", startedAt: at(7).toISOString(),
    })).toThrow(InvalidActionError);
  });

  it("refuses to correct the end of a rest that has not finished, and a pause/rest with no changes", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    const view = await live(repo);

    expect(() => correctWalkingRestTimesAction({
      actionId: nextActionId(), view, restId: "rest-1", endedAt: at(9).toISOString(),
    })).toThrow(InvalidActionError);
    expect(() => correctWalkingRestTimesAction({ actionId: nextActionId(), view, restId: "rest-1" })).toThrow(InvalidActionError);
  });

  it("refuses a correction on a bout, pause or rest that does not belong to the session, or once the session is no longer active", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    const view = await live(repo);

    expect(() => correctWalkingBoutTimesAction({
      actionId: nextActionId(), view, boutId: "missing", startedAt: at(1).toISOString(),
    })).toThrow(InvalidActionError);
  });

  it("re-derives an inferred MAX_DURATION stop reason when a correction moves the bout under the maximum again (issue #22 finding 6)", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(0) }));
    // Runs to 30 minutes, well past the default 8-minute maximum: MAX_DURATION is inferred.
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(30) }));
    expect((await live(repo)).bouts[0]?.stop_reason).toBe("MAX_DURATION");

    // Corrected back under the maximum: the inferred reason no longer applies.
    await repo.commitAction(correctWalkingBoutTimesAction({
      actionId: nextActionId(), view: await live(repo), boutId: "bout-1", endedAt: at(5).toISOString(),
    }));
    expect((await live(repo)).bouts[0]?.stop_reason).toBeNull();
  });

  it("never overwrites a stop reason the user chose explicitly, even if a correction would change what inference now says", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(0) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(30) }));
    // The user overrides the inferred MAX_DURATION with what actually happened.
    await repo.commitAction(updateWalkingBoutAction({
      actionId: nextActionId(), view: await live(repo), boutId: "bout-1", stopReason: "FOOT_NUMBNESS",
    }));
    expect((await live(repo)).bouts[0]?.stop_reason).toBe("FOOT_NUMBNESS");

    await repo.commitAction(correctWalkingBoutTimesAction({
      actionId: nextActionId(), view: await live(repo), boutId: "bout-1", endedAt: at(5).toISOString(),
    }));
    // The user's own choice survives the correction untouched.
    expect((await live(repo)).bouts[0]?.stop_reason).toBe("FOOT_NUMBNESS");
  });
});

describe("PAD undo (confirmed, forward compensating mutation)", () => {
  it("undoes a bout that was just started", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    let view = await live(repo);
    expect(detectUndoableWalkingTransition(view)).toEqual({ type: "bout_started", boutId: "bout-1" });

    await repo.commitAction(undoLastWalkingTransitionAction({ actionId: nextActionId(), view }));
    expect(readPadSession(await repo.readSnapshot())?.state).toBe("READY");
    expect(await repo.getRecord("walking_bouts", "bout-1")).toBeUndefined();
    view = readPadSession(await repo.readSnapshot()) ?? (await live(repo));
  });

  it("undoes a pause", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: nextActionId(), pauseId: "pause-1", view: await live(repo), now: at(2) }));
    const view = await live(repo);
    expect(detectUndoableWalkingTransition(view)).toEqual({ type: "bout_paused", pauseId: "pause-1" });

    await repo.commitAction(undoLastWalkingTransitionAction({ actionId: nextActionId(), view }));
    expect((await live(repo)).state).toBe("WALKING");
    expect(await repo.getRecord("walking_pauses", "pause-1")).toBeUndefined();
  });

  it("undoes a resume, reopening the most recently closed pause", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: nextActionId(), pauseId: "pause-1", view: await live(repo), now: at(2) }));
    await repo.commitAction(resumeWalkingBoutAction({ actionId: nextActionId(), view: await live(repo), now: at(3) }));
    const view = await live(repo);
    expect(detectUndoableWalkingTransition(view)).toEqual({ type: "bout_resumed", pauseId: "pause-1" });

    await repo.commitAction(undoLastWalkingTransitionAction({ actionId: nextActionId(), view }));
    const after = await live(repo);
    expect(after.state).toBe("PAUSED");
    expect(after.currentPause?.id).toBe("pause-1");
    expect(after.currentPause?.ended_at).toBeNull();
  });

  it("undoes a bout finish while walking, deleting the rest it opened", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    const view = await live(repo);
    expect(detectUndoableWalkingTransition(view)).toEqual({
      type: "bout_finished", boutId: "bout-1", restId: "rest-1", pauseId: null,
    });

    await repo.commitAction(undoLastWalkingTransitionAction({ actionId: nextActionId(), view }));
    const after = await live(repo);
    expect(after.state).toBe("WALKING");
    expect(after.currentBout?.id).toBe("bout-1");
    expect(after.currentBout?.ended_at).toBeNull();
    expect(await repo.getRecord("walking_rests", "rest-1")).toBeUndefined();
  });

  it("undoes a bout finish while paused, reopening both the bout and its pause", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: nextActionId(), pauseId: "pause-1", view: await live(repo), now: at(2) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    const view = await live(repo);
    expect(detectUndoableWalkingTransition(view)).toEqual({
      type: "bout_finished", boutId: "bout-1", restId: "rest-1", pauseId: "pause-1",
    });

    await repo.commitAction(undoLastWalkingTransitionAction({ actionId: nextActionId(), view }));
    const after = await live(repo);
    expect(after.state).toBe("PAUSED");
    expect(after.currentPause?.id).toBe("pause-1");
    expect(after.currentBout?.ended_at).toBeNull();
    expect(await repo.getRecord("walking_rests", "rest-1")).toBeUndefined();
  });

  it("undoes the rest-finished/next-bout-started transition, restoring RESTING (PAD-06)", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    await repo.commitAction(startNextWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-2", view: await live(repo), now: at(10) }));
    const view = await live(repo);
    expect(detectUndoableWalkingTransition(view)).toEqual({
      type: "next_bout_started", boutId: "bout-2", restId: "rest-1",
    });

    await repo.commitAction(undoLastWalkingTransitionAction({ actionId: nextActionId(), view }));
    const after = await live(repo);
    // Never both at once: exactly one open interval survives the undo, never an
    // open bout alongside an open rest (PAD-06).
    expect(after.state).toBe("RESTING");
    expect(after.currentBout?.id).toBe("bout-1"); // the bout being rested after, still closed
    expect(after.currentRest?.id).toBe("rest-1");
    expect(after.currentRest?.ended_at).toBeNull();
    expect(await repo.getRecord("walking_bouts", "bout-2")).toBeUndefined();
    const bouts = await repo.listRecords("walking_bouts");
    const rests = await repo.listRecords("walking_rests");
    expect(bouts.some((bout) => bout.ended_at === null)).toBe(false);
    expect(rests.filter((rest) => rest.ended_at === null)).toHaveLength(1);
  });

  it("has nothing to undo in a fresh READY session", async () => {
    const repo = open();
    await start(repo);
    const view = await live(repo);
    expect(detectUndoableWalkingTransition(view)).toBeNull();
    expect(() => undoLastWalkingTransitionAction({ actionId: nextActionId(), view })).toThrow(InvalidActionError);
  });

  it("still finds the underlying transition undoable after an unrelated pain/notes edit on top of it", async () => {
    // "Most recent SUPPORTED state-changing action" (acceptance criterion 3):
    // a pain or notes edit is a real committed action, but not one of the five
    // undoable transitions, so it does not block undoing the one underneath it.
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    await repo.commitAction(updateWalkingBoutAction({
      actionId: nextActionId(), view: await live(repo), boutId: "bout-1", painMin: 2, painMax: 3,
    }));
    const view = await live(repo);
    expect(detectUndoableWalkingTransition(view)).toEqual({
      type: "bout_finished", boutId: "bout-1", restId: "rest-1", pauseId: null,
    });

    await repo.commitAction(undoLastWalkingTransitionAction({ actionId: nextActionId(), view }));
    const after = await live(repo);
    expect(after.state).toBe("WALKING");
    // The pain edit itself is untouched by the undo of the transition below it.
    expect(after.currentBout?.pain_min).toBe(2);
  });

  it("stops offering undo once a correction has moved one side of the bout/rest coupling", async () => {
    // Once the bout's own end has been explicitly corrected, "undo the finish"
    // is no longer an exact reversal (docs/pad-walking.md, "Editing, undo, and
    // delete"): the correction is the user's deliberate, newer edit.
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    await repo.commitAction(correctWalkingRestTimesAction({
      actionId: nextActionId(), view: await live(repo), restId: "rest-1", startedAt: at(8.5).toISOString(),
    }));
    const view = await live(repo);
    expect(detectUndoableWalkingTransition(view)).toBeNull();
    expect(() => undoLastWalkingTransitionAction({ actionId: nextActionId(), view })).toThrow(InvalidActionError);
  });

  it("survives close/reopen: undo works identically before and after this device's own action was synchronized", async () => {
    const name = `pad-corrections-persist-${(database++).toString()}`;
    let repo = createLocalRepository({ databaseName: name, indexedDB: factory, now: () => new Date(), uuid: () => "client" });
    repositories.push(repo);
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    // Simulate the mutation for "finish bout" already having been pushed and
    // acknowledged by the server: the compensating undo below must work exactly
    // the same whether or not the action it reverses is still queued locally
    // (owner decision, issue #22 -- undo does not depend on outbox state).
    const pending = await repo.listPendingOutbox();
    const finishEntry = pending.at(-1);
    if (finishEntry === undefined) throw new Error("Expected the finish-bout mutation to be queued");
    await repo.acknowledgeOutbox(finishEntry.mutation_id);

    repo.close();
    repo = createLocalRepository({ databaseName: name, indexedDB: factory, now: () => new Date(), uuid: () => "client" });
    repositories.push(repo);

    const view = await live(repo);
    expect(detectUndoableWalkingTransition(view)).toEqual({
      type: "bout_finished", boutId: "bout-1", restId: "rest-1", pauseId: null,
    });
    await repo.commitAction(undoLastWalkingTransitionAction({ actionId: nextActionId(), view }));

    repo.close();
    repo = createLocalRepository({ databaseName: name, indexedDB: factory, now: () => new Date(), uuid: () => "client" });
    repositories.push(repo);
    const after = await live(repo);
    expect(after.state).toBe("WALKING");
    expect(after.currentBout?.ended_at).toBeNull();
    expect(await repo.getRecord("walking_rests", "rest-1")).toBeUndefined();
  });
});

describe("PAD undo targets the stamped record, not a same-instant collision (issue #22 finding 1)", () => {
  it("reopens the rest START NEXT BOUT actually closed, when an earlier rest shares its ended_at after a clock step", async () => {
    // The reviewer's exact repro: a device clock steps back mid-session, so
    // `monotonicNow` collapses every later stamp to the same already-recorded
    // instant. Two different rests end up sharing one `ended_at`, which a
    // `rests.find(rest => rest.ended_at === currentBout.started_at)` (the old
    // implementation) cannot tell apart -- `find` returns whichever comes
    // first in `view.rests`' storage order, not time order.
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(20) }));
    // The clock steps back: every following commit's `now` is earlier than
    // minute 20, the latest instant already recorded, so all of it collapses
    // to exactly that same instant.
    await repo.commitAction(startNextWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-2", view: await live(repo), now: at(15) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-2", view: await live(repo), now: at(16) }));
    await repo.commitAction(startNextWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-3", view: await live(repo), now: at(17) }));

    const view = await live(repo);
    // The collision this finding fixes: rest-1 and rest-2 both now end
    // exactly when bout-3 started.
    expect(view.rests.filter((rest) => rest.ended_at === view.currentBout?.started_at)).toHaveLength(2);

    // The correct target is rest-2 -- the rest START NEXT BOUT for bout-3
    // actually closed -- never rest-1, which just happens to share the instant.
    expect(detectUndoableWalkingTransition(view)).toEqual({
      type: "next_bout_started", boutId: "bout-3", restId: "rest-2",
    });

    await repo.commitAction(undoLastWalkingTransitionAction({ actionId: nextActionId(), view }));
    const after = await live(repo);
    expect(after.state).toBe("RESTING");
    expect(after.currentRest?.id).toBe("rest-2");
    expect(after.currentRest?.ended_at).toBeNull();
    expect(await repo.getRecord("walking_bouts", "bout-3")).toBeUndefined();
    // rest-1's own recorded end is untouched: it was never part of this undo.
    expect((await repo.getRecord("walking_rests", "rest-1"))?.ended_at).toBe(at(20).toISOString());
  });

  it("reopens the pause a bout finish actually closed, not an earlier resumed pause sharing the same instant", async () => {
    // The second instance the reviewer flagged: `pauses.find(p => p.ended_at
    // === currentBout.ended_at)` cannot distinguish a pause the user
    // explicitly RESUMED from the one FINISH BOUT force-closed, once a clock
    // step makes both land on the same instant.
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: nextActionId(), pauseId: "pause-a", view: await live(repo), now: at(2) }));
    await repo.commitAction(resumeWalkingBoutAction({ actionId: nextActionId(), view: await live(repo), now: at(50) }));
    // The clock steps back before the bout is paused again and finished:
    // both collapse to the same instant as the resume above.
    await repo.commitAction(pauseWalkingBoutAction({ actionId: nextActionId(), pauseId: "pause-b", view: await live(repo), now: at(10) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(5) }));

    const view = await live(repo);
    const pauseA = await repo.getRecord("walking_pauses", "pause-a");
    const pauseB = await repo.getRecord("walking_pauses", "pause-b");
    // The collision: both pauses, and the bout itself, now end at minute 50.
    expect(pauseA?.ended_at).toBe(at(50).toISOString());
    expect(pauseB?.ended_at).toBe(at(50).toISOString());
    expect(view.bouts[0]?.ended_at).toBe(at(50).toISOString());

    expect(detectUndoableWalkingTransition(view)).toEqual({
      type: "bout_finished", boutId: "bout-1", restId: "rest-1", pauseId: "pause-b",
    });

    await repo.commitAction(undoLastWalkingTransitionAction({ actionId: nextActionId(), view }));
    const after = await live(repo);
    expect(after.state).toBe("PAUSED");
    expect(after.currentPause?.id).toBe("pause-b");
    // pause-a, the one the user actually resumed, is untouched.
    expect((await repo.getRecord("walking_pauses", "pause-a"))?.ended_at).toBe(at(50).toISOString());
  });
});

describe("PAD corrections, undo and delete after synchronization (issue #22 finding 8)", () => {
  it("corrects, undoes and deletes against records that have round-tripped through applyServerRecords", async () => {
    // Every other "after synchronization" test in this file simulates sync by
    // acknowledging the outbox only. That never runs a correction, undo or
    // delete against a record the server's own serialization has actually
    // produced -- the one path where the server could in principle hand back
    // a differently-formatted timestamp string.
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(0) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    await repo.commitAction(startNextWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-2", view: await live(repo), now: at(10) }));
    for (const entry of await repo.listPendingOutbox()) {
      await repo.acknowledgeOutbox(entry.mutation_id);
    }

    const session = await repo.getRecord("walking_sessions", "session");
    const bout1 = await repo.getRecord("walking_bouts", "bout-1");
    const bout2 = await repo.getRecord("walking_bouts", "bout-2");
    const rest1 = await repo.getRecord("walking_rests", "rest-1");
    if (session === undefined || bout1 === undefined || bout2 === undefined || rest1 === undefined) {
      throw new Error("Expected every record to exist before the server round-trip");
    }
    // The server's own serialization, round-tripped byte-identically for a
    // `Date.toISOString()`-shaped timestamp (`backend/apps/sync/protocol.py`,
    // `format_timestamp`) -- exactly what `applyServerRecords` merges in.
    await repo.applyServerRecords(
      [
        { store: "walking_sessions", entity_id: "session", record: session },
        { store: "walking_bouts", entity_id: "bout-1", record: bout1 },
        { store: "walking_bouts", entity_id: "bout-2", record: bout2 },
        { store: "walking_rests", entity_id: "rest-1", record: rest1 },
      ],
      1,
    );

    let view = await live(repo);
    await repo.commitAction(correctWalkingBoutTimesAction({
      actionId: nextActionId(), view, boutId: "bout-1", endedAt: at(7).toISOString(),
    }));
    view = await live(repo);
    expect(view.bouts[0]?.ended_at).toBe(at(7).toISOString());

    expect(detectUndoableWalkingTransition(view)).toEqual({
      type: "next_bout_started", boutId: "bout-2", restId: "rest-1",
    });
    await repo.commitAction(undoLastWalkingTransitionAction({ actionId: nextActionId(), view }));
    view = await live(repo);
    expect(view.state).toBe("RESTING");
    expect(await repo.getRecord("walking_bouts", "bout-2")).toBeUndefined();

    await repo.commitAction(deleteWalkingBoutAction({ actionId: nextActionId(), view, boutId: "bout-1" }));
    const after = await live(repo);
    expect(after.bouts).toHaveLength(0);
    expect(after.state).toBe("READY");
  });
});

describe("PAD bout deletion", () => {
  it("deletes a finished bout with its pause and rest, and renumbers the surviving bouts contiguously", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(0) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: nextActionId(), pauseId: "pause-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(resumeWalkingBoutAction({ actionId: nextActionId(), view: await live(repo), now: at(2) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(3) }));
    await repo.commitAction(startNextWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-2", view: await live(repo), now: at(4) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-2", view: await live(repo), now: at(5) }));
    await repo.commitAction(startNextWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-3", view: await live(repo), now: at(6) }));

    let view = await live(repo);
    expect(view.currentBoutNumber).toBe(3);
    // Delete bout 1 (the middle one in display terms is number 2, but delete
    // the earliest here): bout 2 and bout 3 both shift down by one.
    await repo.commitAction(deleteWalkingBoutAction({ actionId: nextActionId(), view, boutId: "bout-1" }));

    view = await live(repo);
    expect(view.bouts.map((bout) => [bout.id, bout.bout_number])).toEqual([
      ["bout-2", 1],
      ["bout-3", 2],
    ]);
    expect(view.currentBoutNumber).toBe(2); // the still-open bout 3 renumbered too
    expect(view.currentBout?.id).toBe("bout-3");
    expect(await repo.getRecord("walking_bouts", "bout-1")).toBeUndefined();
    expect(await repo.getRecord("walking_pauses", "pause-1")).toBeUndefined();
    expect(await repo.getRecord("walking_rests", "rest-1")).toBeUndefined();
    // Untouched siblings keep their own UUIDs (owner decision: UUIDs never change).
    expect(await repo.getRecord("walking_bouts", "bout-2")).toBeDefined();
    expect(await repo.getRecord("walking_bouts", "bout-3")).toBeDefined();
  });

  it("deletes a finished bout that is currently being rested after, leaving the session READY", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(0) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    const view = await live(repo);
    expect(view.state).toBe("RESTING");

    await repo.commitAction(deleteWalkingBoutAction({ actionId: nextActionId(), view, boutId: "bout-1" }));
    const after = await live(repo);
    expect(after.state).toBe("READY");
    expect(after.bouts).toHaveLength(0);
    expect(after.currentBoutNumber).toBe(1);
    const rests = await repo.listRecords("walking_rests");
    expect(rests).toHaveLength(0);
  });

  it("refuses to delete a bout that has not finished, or one from another session", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(0) }));
    const view = await live(repo);

    expect(() => deleteWalkingBoutAction({ actionId: nextActionId(), view, boutId: "bout-1" })).toThrow(InvalidActionError);
    expect(() => deleteWalkingBoutAction({ actionId: nextActionId(), view, boutId: "missing" })).toThrow(InvalidActionError);
  });

  it("renumbers from raw bout rows, so a sibling row the tolerant parser dropped cannot collide with a survivor's new number (issue #22 finding 7)", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(0) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(startNextWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-2", view: await live(repo), now: at(2) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-2", view: await live(repo), now: at(3) }));

    // A sibling bout row the tolerant parser drops (an unparseable `ended_at`,
    // per `records.ts`'s "corrupt end time must not be read as still open"),
    // holding `bout_number: 1` -- the number bout-2 is about to be renumbered
    // to once bout-1 is deleted.
    await repo.commitAction({
      actionId: "inject-unparseable-sibling",
      changes: [{
        store: "walking_bouts",
        operation: "put",
        record: {
          id: "bout-unreadable", walking_session_id: "session", bout_number: 1,
          started_at: at(0.5).toISOString(), ended_at: "not-a-timestamp",
        },
      }],
    });

    const view = await live(repo);
    // The unreadable row is invisible to the parsed view...
    expect(view.bouts.map((bout) => bout.id)).toEqual(["bout-1", "bout-2"]);
    await repo.commitAction(deleteWalkingBoutAction({ actionId: nextActionId(), view, boutId: "bout-1" }));

    // ...but its own stored bout_number was still bumped along with every
    // other raw sibling row, so it never again collides with bout-2's.
    const survivor = await repo.getRecord("walking_bouts", "bout-2");
    const unreadable = await repo.getRecord("walking_bouts", "bout-unreadable");
    expect(survivor?.bout_number).toBe(2);
    expect(unreadable?.bout_number).toBe(1);
  });

  it("survives close/reopen: a deletion commits identically whether or not it has been pushed yet", async () => {
    const name = `pad-corrections-delete-persist-${(database++).toString()}`;
    let repo = createLocalRepository({ databaseName: name, indexedDB: factory, now: () => new Date(), uuid: () => "client" });
    repositories.push(repo);
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-1", view: await live(repo), now: at(0) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-1", view: await live(repo), now: at(8) }));
    await repo.commitAction(startNextWalkingBoutAction({ actionId: nextActionId(), boutId: "bout-2", view: await live(repo), now: at(10) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: nextActionId(), restId: "rest-2", view: await live(repo), now: at(18) }));

    // Acknowledge everything so far, as if already synchronized.
    for (const entry of await repo.listPendingOutbox()) {
      await repo.acknowledgeOutbox(entry.mutation_id);
    }

    repo.close();
    repo = createLocalRepository({ databaseName: name, indexedDB: factory, now: () => new Date(), uuid: () => "client" });
    repositories.push(repo);

    const view = await live(repo);
    await repo.commitAction(deleteWalkingBoutAction({ actionId: nextActionId(), view, boutId: "bout-1" }));

    repo.close();
    repo = createLocalRepository({ databaseName: name, indexedDB: factory, now: () => new Date(), uuid: () => "client" });
    repositories.push(repo);

    const after = await live(repo);
    expect(after.bouts.map((bout) => [bout.id, bout.bout_number])).toEqual([["bout-2", 1]]);
    expect(await repo.getRecord("walking_bouts", "bout-1")).toBeUndefined();
    expect(await repo.getRecord("walking_rests", "rest-1")).toBeUndefined();

    // The bout is gone from the live view, so building a second, independent
    // delete action against it (as a stale retry of the same tap might) is
    // refused up front rather than silently no-opping or double-tombstoning.
    const second = await live(repo);
    expect(() => deleteWalkingBoutAction({ actionId: nextActionId(), view: second, boutId: "bout-1" })).toThrow(InvalidActionError);
  });
});
