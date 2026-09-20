import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it } from "vitest";

import { createLocalRepository, InvalidActionError, PreconditionFailedError, type LocalRepository } from "../storage";
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
} from "./actions";
import { readPadSession, walkingElapsedMs, type PadSessionView } from "./session";
import { DEFAULT_WALKING_SETTINGS } from "./types";

const factory = new IDBFactory();
const repositories: LocalRepository[] = [];
let database = 0;
const at = (minutes: number) => new Date(Date.parse("2026-09-18T10:00:00.000Z") + minutes * 60_000);

function open(name = `pad-workflow-${(database++).toString()}`): LocalRepository {
  // A fixed repository clock deliberately makes every updated_at identical.
  // Workflow conflicts must still be detected by the revision precondition.
  const repo = createLocalRepository({ databaseName: name, indexedDB: factory, now: () => at(0), uuid: () => "client" });
  repositories.push(repo);
  return repo;
}

async function live(repo: LocalRepository): Promise<PadSessionView> {
  const view = readPadSession(await repo.readSnapshot());
  if (view === null) throw new Error("Expected active PAD session");
  return view;
}

async function start(repo: LocalRepository): Promise<void> {
  await repo.commitAction(startWalkingSessionAction({
    actionId: "start-session", sessionId: "session", settings: DEFAULT_WALKING_SETTINGS, now: at(0),
  }));
}

afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
});

describe("durable PAD workflow", () => {
  it("survives reopen with multiple pauses, atomic rests, editable symptoms and a completed session", async () => {
    const name = `pad-workflow-${(database++).toString()}`;
    let repo = open(name);
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: "bout-1-start", boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: "pause-1-start", pauseId: "pause-1", view: await live(repo), now: at(3) }));
    await repo.commitAction(resumeWalkingBoutAction({ actionId: "pause-1-end", view: await live(repo), now: at(5) }));
    await repo.commitAction(pauseWalkingBoutAction({ actionId: "pause-2-start", pauseId: "pause-2", view: await live(repo), now: at(8) }));
    await repo.commitAction(updateWalkingBoutAction({
      actionId: "pain-early", view: await live(repo), boutId: "bout-1", painMin: 3, painMax: 4,
    }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: "bout-1-end", restId: "rest-1", view: await live(repo), now: at(10) }));

    let view = await live(repo);
    expect(view.state).toBe("RESTING");
    expect(view.bouts[0]).toMatchObject({ ended_at: at(10).toISOString(), stop_reason: "CLAUDICATION", pain_min: 3, pain_max: 4 });
    expect(view.pauses.map((pause) => pause.ended_at)).toEqual([at(5).toISOString(), at(10).toISOString()]);
    const firstBout = view.bouts[0];
    if (firstBout === undefined) throw new Error("Expected first bout");
    expect(walkingElapsedMs(firstBout, view.pauses, at(20).getTime())).toBe(5 * 60_000);

    // A later bout can be opened only by the one transaction that ends rest.
    expect(() => startWalkingBoutAction({ actionId: "bypass", boutId: "illegal", view, now: at(11) })).toThrow(InvalidActionError);
    await repo.commitAction(updateWalkingBoutAction({
      actionId: "override-reason", view, boutId: "bout-1", stopReason: "FOOT_NUMBNESS", notes: "left foot",
    }));
    await repo.commitAction(updateWalkingSessionNotesAction({ actionId: "session-notes", view: await live(repo), notes: "steady pace" }));
    await repo.commitAction(startNextWalkingBoutAction({ actionId: "bout-2-start", boutId: "bout-2", view: await live(repo), now: at(12) }));
    view = await live(repo);
    expect(view.state).toBe("WALKING");
    expect(view.rests[0]?.ended_at).toBe(at(12).toISOString());
    expect(view.currentBout?.bout_number).toBe(2);

    // A clock correction backwards cannot place a new pause before bout 2.
    await repo.commitAction(pauseWalkingBoutAction({ actionId: "pause-3-start", pauseId: "pause-3", view, now: at(11) }));
    view = await live(repo);
    expect(view.currentPause?.started_at).toBe(at(12).toISOString());
    await repo.commitAction(finishWalkingSessionAction({
      actionId: "finish-session", snapshot: await repo.readSnapshot(), sessionId: "session", now: at(14),
    }));
    repo.close();
    repo = open(name);
    expect(readPadSession(await repo.readSnapshot())).toBeNull();
    const savedSession = await repo.getRecord("walking_sessions", "session");
    expect(savedSession).toMatchObject({ status: "COMPLETED", completed_at: at(14).toISOString(), session_notes: "steady pace" });
    expect(await repo.getRecord("walking_bouts", "bout-1")).toMatchObject({ stop_reason: "FOOT_NUMBNESS", notes: "left foot" });
    expect(await repo.getRecord("walking_bouts", "bout-2")).toMatchObject({ ended_at: at(14).toISOString() });
    expect(await repo.getRecord("walking_pauses", "pause-3")).toMatchObject({ ended_at: at(14).toISOString() });
    expect((await repo.listPendingOutbox()).length).toBe(12);
  });

  it("rejects stale tabs even when the repository clock has not ticked", async () => {
    const repo = open();
    await start(repo);
    const staleReady = await live(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: "bout-start", boutId: "bout-1", view: staleReady, now: at(1) }));
    const staleWalking = await live(repo);
    await repo.commitAction(finishWalkingBoutAction({ actionId: "bout-end", restId: "rest-1", view: staleWalking, now: at(2) }));
    await expect(repo.commitAction(startWalkingBoutAction({
      actionId: "stale-ready", boutId: "bout-2", view: staleReady, now: at(3),
    }))).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(repo.commitAction(pauseWalkingBoutAction({
      actionId: "stale-pause", pauseId: "pause", view: staleWalking, now: at(3),
    }))).rejects.toBeInstanceOf(PreconditionFailedError);
    expect((await live(repo)).state).toBe("RESTING");
    expect((await repo.listPendingOutbox()).length).toBe(3);
  });

  it("rolls back both sides of start-next when a record ID already exists", async () => {
    const repo = open();
    await start(repo);
    await repo.commitAction(startWalkingBoutAction({ actionId: "bout-start", boutId: "bout-1", view: await live(repo), now: at(1) }));
    await repo.commitAction(finishWalkingBoutAction({ actionId: "bout-end", restId: "rest-1", view: await live(repo), now: at(2) }));
    const resting = await live(repo);
    await expect(repo.commitAction(startNextWalkingBoutAction({
      actionId: "bad-next", boutId: "bout-1", view: resting, now: at(3),
    }))).rejects.toBeInstanceOf(PreconditionFailedError);
    expect((await live(repo)).currentRest?.ended_at).toBeNull();
    expect((await repo.listPendingOutbox()).length).toBe(3);
  });

  it("rejects an out-of-band bout while resting, including a race from another connection", async () => {
    const name = `pad-workflow-${(database++).toString()}`;
    const first = open(name);
    const second = open(name);
    await start(first);
    await first.commitAction(startWalkingBoutAction({ actionId: "bout-start", boutId: "bout-1", view: await live(first), now: at(1) }));
    await first.commitAction(finishWalkingBoutAction({ actionId: "bout-end", restId: "rest-1", view: await live(first), now: at(2) }));
    const bypass = { actionId: "out-of-band", changes: [{
      store: "walking_bouts" as const, operation: "put" as const,
      record: { id: "illegal", walking_session_id: "session", bout_number: 2, started_at: at(3).toISOString(), ended_at: null },
    }] };
    await expect(second.commitAction(bypass)).rejects.toBeInstanceOf(InvalidActionError);
    expect((await live(first)).currentRest?.ended_at).toBeNull();

    const legal = startNextWalkingBoutAction({ actionId: "legal-next", boutId: "bout-2", view: await live(first), now: at(4) });
    const raced = await Promise.allSettled([first.commitAction(legal), second.commitAction({ ...bypass, actionId: "raced-bypass" })]);
    expect(raced.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect((await live(second)).state).toBe("WALKING");
    expect((await second.getRecord("walking_bouts", "illegal"))).toBeUndefined();
    expect((await second.listPendingOutbox()).length).toBe(4);
  });
});
