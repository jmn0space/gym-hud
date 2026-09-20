import { forceCloseDatabase, IDBDatabase, IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ActionConflictError,
  ActiveSessionConflictError,
  createLocalRepository,
  DATABASE_STORES,
  InvalidActionError,
  LocalStorageError,
  type LocalAction,
  type LocalRecord,
  type LocalRepository,
  PreconditionFailedError,
  StorageQuotaExceededError,
  SYNC_CURSOR_KEY,
} from "./index";

const openRepositories: LocalRepository[] = [];
let databaseNumber = 0;

function repository(
  factory: IDBFactory,
  options: {
    databaseName?: string;
    now?: () => Date;
    uuid?: () => string;
  } = {},
): LocalRepository {
  const result = createLocalRepository({
    databaseName: options.databaseName ?? `repository-test-${(databaseNumber++).toString()}`,
    indexedDB: factory,
    ...(options.now === undefined ? {} : { now: options.now }),
    uuid: options.uuid ?? (() => "client-uuid"),
  });
  openRepositories.push(result);
  return result;
}

afterEach(() => {
  for (const repo of openRepositories.splice(0)) {
    repo.close();
  }
});

describe("LocalRepository atomic actions", () => {
  it("opens lazily and reports missing IndexedDB through the requested operation", async () => {
    vi.stubGlobal("indexedDB", undefined);
    let repo: LocalRepository | undefined;
    expect(() => {
      repo = createLocalRepository();
    }).not.toThrow();
    await expect(repo?.readSnapshot()).rejects.toBeInstanceOf(LocalStorageError);
  });

  it("commits domain records, metadata, and one dependency-ordered outbox entry atomically", async () => {
    const repo = repository(new IDBFactory(), {
      now: () => new Date("2026-09-14T10:15:30.000Z"),
    });

    const receipt = await repo.commitAction({
      actionId: "start-pad",
      changes: [
        {
          store: "walking_bouts",
          operation: "put",
          record: {
            id: "bout-1",
            walking_session_id: "session-1",
            started_at: "2026-09-14T10:15:30.000Z",
          },
        },
        {
          store: "walking_sessions",
          operation: "put",
          record: { id: "session-1", status: "ACTIVE" },
        },
      ],
    });

    expect(receipt).toEqual({
      actionId: "start-pad",
      sequence: 1,
      committedAt: "2026-09-14T10:15:30.000Z",
    });
    await expect(repo.getRecord("walking_sessions", "session-1")).resolves.toMatchObject({
      id: "session-1",
      status: "ACTIVE",
      created_at: receipt.committedAt,
      updated_at: receipt.committedAt,
      deleted_at: null,
    });

    const pending = await repo.listPendingOutbox();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      version: 1,
      mutation_id: "start-pad",
      sequence: 1,
      created_at: receipt.committedAt,
    });
    expect(pending[0]?.changes.map((change) => change.store)).toEqual([
      "walking_sessions",
      "walking_bouts",
    ]);
    expect(pending[0]?.changes.every((change) => change.entity_id.length > 0)).toBe(true);
  });

  it("rolls back earlier writes when a later IndexedDB request cannot clone its value", async () => {
    const factory = new IDBFactory();
    const repo = repository(factory);
    const uncloneable = {
      id: "bout-uncloneable",
      walking_session_id: "session-written-first",
      ended_at: "2026-09-14T10:00:00.000Z",
      callback: () => undefined,
    } as unknown as LocalRecord;

    const commit = repo.commitAction({
      actionId: "late-request-failure",
      changes: [
        {
          store: "walking_sessions",
          operation: "put",
          record: { id: "session-written-first", status: "COMPLETED" },
        },
        { store: "walking_bouts", operation: "put", record: uncloneable },
      ],
    });

    await expect(commit).rejects.toMatchObject({ name: "DataCloneError" });
    await expect(repo.getRecord("walking_sessions", "session-written-first")).resolves.toBeUndefined();
    await expect(repo.getRecord("walking_bouts", "bout-uncloneable")).resolves.toBeUndefined();
    await expect(repo.listPendingOutbox()).resolves.toEqual([]);

    await expect(
      repo.commitAction({
        actionId: "after-rollback",
        changes: [
          {
            store: "cardio_sessions",
            operation: "put",
            record: { id: "cardio-1", status: "COMPLETED" },
          },
        ],
      }),
    ).resolves.toMatchObject({ sequence: 1 });
  });

  it("snapshots caller input before awaiting IndexedDB", async () => {
    const repo = repository(new IDBFactory());
    const action: LocalAction = {
      actionId: "immutable-input",
      changes: [
        {
          store: "cardio_sessions",
          operation: "put",
          record: { id: "cardio-snapshot", status: "ACTIVE", machine_name: "Arm Crank" },
        },
      ],
    };

    const committing = repo.commitAction(action);
    const submitted = action.changes[0];
    if (submitted?.operation === "put") {
      submitted.record.status = "COMPLETED";
      submitted.record.machine_name = "Rowing Machine";
    }
    await committing;

    await expect(repo.getRecord("cardio_sessions", "cardio-snapshot")).resolves.toMatchObject({
      status: "ACTIVE",
      machine_name: "Arm Crank",
    });
    await expect(
      repo.commitAction({
        actionId: "immutable-input",
        changes: [
          {
            store: "cardio_sessions",
            operation: "put",
            record: { id: "cardio-snapshot", status: "ACTIVE", machine_name: "Arm Crank" },
          },
        ],
      }),
    ).resolves.toMatchObject({ sequence: 1 });
  });
});

describe("LocalRepository recovery and logical actions", () => {
  it("recovers committed records and pending actions through close and reopen", async () => {
    const factory = new IDBFactory();
    const databaseName = "close-reopen";
    const first = repository(factory, { databaseName });
    await first.commitAction({
      actionId: "persist-before-close",
      changes: [
        {
          store: "resistance_sessions",
          operation: "put",
          record: { id: "resistance-1", status: "ACTIVE", title: "Day 3" },
        },
      ],
    });
    first.close();
    await Promise.resolve();

    const reopened = repository(factory, { databaseName });
    const snapshot = await reopened.readSnapshot();
    expect(snapshot.records.resistance_sessions).toEqual([
      expect.objectContaining({ id: "resistance-1", status: "ACTIVE", title: "Day 3" }),
    ]);
    expect(snapshot.pendingOutbox).toEqual([
      expect.objectContaining({ mutation_id: "persist-before-close", sequence: 1 }),
    ]);
  });

  it("persists both records for finish/rest and rest/next-bout PAD transitions", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({
      actionId: "start-first-bout",
      changes: [
        {
          store: "walking_sessions",
          operation: "put",
          record: { id: "pad-1", status: "ACTIVE" },
        },
        {
          store: "walking_bouts",
          operation: "put",
          record: {
            id: "bout-1",
            walking_session_id: "pad-1",
            started_at: "2026-09-14T10:00:00.000Z",
            ended_at: null,
          },
        },
      ],
    });

    await repo.commitAction({
      actionId: "finish-bout-start-rest",
      preconditions: [
        { store: "walking_bouts", id: "bout-1", expected: { ended_at: null } },
      ],
      changes: [
        {
          store: "walking_bouts",
          operation: "put",
          record: {
            id: "bout-1",
            walking_session_id: "pad-1",
            started_at: "2026-09-14T10:00:00.000Z",
            ended_at: "2026-09-14T10:05:00.000Z",
            pain_score: 4,
          },
        },
        {
          store: "walking_rests",
          operation: "put",
          record: {
            id: "rest-1",
            walking_bout_id: "bout-1",
            started_at: "2026-09-14T10:05:00.000Z",
            ended_at: null,
          },
        },
      ],
    });

    await repo.commitAction({
      actionId: "finish-rest-start-next-bout",
      preconditions: [
        { store: "walking_rests", id: "rest-1", expected: { ended_at: null } },
      ],
      changes: [
        {
          store: "walking_rests",
          operation: "put",
          record: {
            id: "rest-1",
            walking_bout_id: "bout-1",
            started_at: "2026-09-14T10:05:00.000Z",
            ended_at: "2026-09-14T10:08:00.000Z",
          },
        },
        {
          store: "walking_bouts",
          operation: "put",
          record: {
            id: "bout-2",
            walking_session_id: "pad-1",
            started_at: "2026-09-14T10:08:00.000Z",
            ended_at: null,
          },
        },
      ],
    });

    await expect(repo.getRecord("walking_rests", "rest-1")).resolves.toMatchObject({
      ended_at: "2026-09-14T10:08:00.000Z",
    });
    await expect(repo.getRecord("walking_bouts", "bout-2")).resolves.toMatchObject({
      walking_session_id: "pad-1",
      ended_at: null,
    });
    const pending = await repo.listPendingOutbox();
    expect(pending.map((entry) => entry.changes.map((change) => change.entity_id))).toEqual([
      ["pad-1", "bout-1"],
      ["bout-1", "rest-1"],
      ["bout-2", "rest-1"],
    ]);
  });

  it("uses durable tombstones and orders child deletes before parent deletes", async () => {
    const times = [
      new Date("2026-09-14T10:00:00.000Z"),
      new Date("2026-09-14T10:10:00.000Z"),
    ];
    const repo = repository(new IDBFactory(), { now: () => times.shift() ?? new Date(0) });
    await repo.commitAction({
      actionId: "create-pad-tree",
      changes: [
        {
          store: "walking_sessions",
          operation: "put",
          record: { id: "delete-session", status: "COMPLETED" },
        },
        {
          store: "walking_bouts",
          operation: "put",
          record: { id: "delete-bout", walking_session_id: "delete-session" },
        },
        {
          store: "walking_pauses",
          operation: "put",
          record: { id: "delete-pause", walking_bout_id: "delete-bout" },
        },
      ],
    });

    await repo.commitAction({
      actionId: "delete-pad-tree",
      changes: [
        { store: "walking_sessions", operation: "delete", id: "delete-session" },
        { store: "walking_bouts", operation: "delete", id: "delete-bout" },
        { store: "walking_pauses", operation: "delete", id: "delete-pause" },
      ],
    });

    await expect(repo.listRecords("walking_sessions")).resolves.toEqual([]);
    await expect(repo.getRecord("walking_sessions", "delete-session")).resolves.toBeUndefined();
    await expect(repo.getRecord("walking_sessions", "delete-session", true)).resolves.toMatchObject({
      id: "delete-session",
      created_at: "2026-09-14T10:00:00.000Z",
      updated_at: "2026-09-14T10:10:00.000Z",
      deleted_at: "2026-09-14T10:10:00.000Z",
    });

    const pending = await repo.listPendingOutbox();
    expect(pending[1]?.changes.map((change) => change.store)).toEqual([
      "walking_pauses",
      "walking_bouts",
      "walking_sessions",
    ]);
    expect(pending[1]?.changes.every((change) => change.operation === "delete")).toBe(true);
  });

  it("treats a tombstoned record as absent for precondition checks", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({
      actionId: "create-then-delete",
      changes: [
        {
          store: "cardio_sessions",
          operation: "put",
          record: { id: "cardio-tombstoned", status: "ACTIVE" },
        },
      ],
    });
    await repo.commitAction({
      actionId: "delete-cardio",
      changes: [{ store: "cardio_sessions", operation: "delete", id: "cardio-tombstoned" }],
    });

    // A null (absence) precondition must succeed against a tombstoned record,
    // consistent with delete/isOpen/isActive treating tombstones as logically gone.
    await expect(
      repo.commitAction({
        actionId: "recreate-cardio",
        preconditions: [{ store: "cardio_sessions", id: "cardio-tombstoned", expected: null }],
        changes: [
          {
            store: "cardio_sessions",
            operation: "put",
            record: { id: "cardio-tombstoned", status: "ACTIVE" },
          },
        ],
      }),
    ).resolves.toMatchObject({ sequence: 3 });

    // An existence precondition must fail against a tombstoned record.
    await repo.commitAction({
      actionId: "delete-cardio-again",
      changes: [{ store: "cardio_sessions", operation: "delete", id: "cardio-tombstoned" }],
    });
    await expect(
      repo.commitAction({
        actionId: "expect-existing-but-tombstoned",
        preconditions: [
          { store: "cardio_sessions", id: "cardio-tombstoned", expected: { status: "ACTIVE" } },
        ],
        changes: [
          {
            store: "exercise_registry",
            operation: "put",
            record: { id: "unrelated-exercise", name: "Unrelated" },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(PreconditionFailedError);
  });
});

describe("LocalRepository retry, concurrency, and ordering", () => {
  it("rejects a stale legacy workflow when an upgraded write has the same timestamp", async () => {
    const at = new Date("2026-09-18T10:00:00.000Z");
    const repo = repository(new IDBFactory(), { now: () => at });
    await repo.commitAction({ actionId: "legacy", changes: [
      { store: "walking_sessions", operation: "put", record: { id: "pad", status: "ACTIVE", session_notes: null } },
    ] });
    const legacy = await repo.getRecord("walking_sessions", "pad");
    expect(legacy?.workflow_revision).toBeUndefined();
    await repo.commitAction({ actionId: "upgrade-note", preconditions: [
      { store: "walking_sessions", id: "pad", expected: { status: "ACTIVE", updated_at: at.toISOString() }, absentFields: ["workflow_revision"] },
    ], changes: [
      { store: "walking_sessions", operation: "put", record: { id: "pad", status: "ACTIVE", session_notes: "Keep this", workflow_revision: 1 } },
    ] });
    await expect(repo.commitAction({ actionId: "stale-start", preconditions: [
      { store: "walking_sessions", id: "pad", expected: { status: "ACTIVE", updated_at: at.toISOString() }, absentFields: ["workflow_revision"] },
    ], changes: [
      { store: "walking_bouts", operation: "put", record: { id: "bout-1", walking_session_id: "pad", ended_at: null } },
      { store: "walking_sessions", operation: "put", record: { id: "pad", status: "ACTIVE", session_notes: null, workflow_revision: 1 } },
    ] })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(await repo.getRecord("walking_sessions", "pad")).toEqual(expect.objectContaining({ session_notes: "Keep this" }));
    expect(await repo.listRecords("walking_bouts")).toHaveLength(0);
  });

  it("rejects a rest opened alongside the next bout and reopening a bout during rest", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({ actionId: "first-bout", changes: [
      { store: "walking_bouts", operation: "put", record: { id: "bout-1", walking_session_id: "pad", ended_at: null } },
    ] });
    await expect(repo.commitAction({ actionId: "overlap-in-one-action", changes: [
      { store: "walking_bouts", operation: "put", record: { id: "bout-1", walking_session_id: "pad", ended_at: "2026-09-18T10:01:00.000Z" } },
      { store: "walking_rests", operation: "put", record: { id: "rest-1", walking_bout_id: "bout-1", ended_at: null } },
      { store: "walking_bouts", operation: "put", record: { id: "bout-2", walking_session_id: "pad", ended_at: null } },
    ] })).rejects.toBeInstanceOf(InvalidActionError);
    expect(await repo.listRecords("walking_rests")).toHaveLength(0);
    expect(await repo.getRecord("walking_bouts", "bout-1")).toEqual(expect.objectContaining({ ended_at: null }));

    await repo.commitAction({ actionId: "begin-rest", changes: [
      { store: "walking_bouts", operation: "put", record: { id: "bout-1", walking_session_id: "pad", ended_at: "2026-09-18T10:01:00.000Z" } },
      { store: "walking_rests", operation: "put", record: { id: "rest-1", walking_bout_id: "bout-1", ended_at: null } },
    ] });
    await expect(repo.commitAction({ actionId: "reopen", changes: [
      { store: "walking_bouts", operation: "put", record: { id: "bout-1", walking_session_id: "pad", ended_at: null } },
    ] })).rejects.toBeInstanceOf(InvalidActionError);
    // Put metadata is replaced by the repository. A caller-supplied tombstone
    // cannot make an open bout invisible to this guard.
    await expect(repo.commitAction({ actionId: "forged-deleted-at", changes: [
      { store: "walking_bouts", operation: "put", record: { id: "bout-2", walking_session_id: "pad", ended_at: null, deleted_at: "2026-09-18T10:00:00.000Z" } },
    ] })).rejects.toBeInstanceOf(InvalidActionError);
    await repo.commitAction({ actionId: "closed-bout-2", changes: [
      { store: "walking_bouts", operation: "put", record: { id: "bout-2", walking_session_id: "pad", ended_at: "2026-09-18T10:01:00.000Z" } },
    ] });
    await repo.commitAction({ actionId: "delete-bout-2", changes: [
      { store: "walking_bouts", operation: "delete", id: "bout-2" },
    ] });
    await expect(repo.commitAction({ actionId: "restore-during-rest", changes: [
      { store: "walking_bouts", operation: "put", record: { id: "bout-2", walking_session_id: "pad", ended_at: null, deleted_at: "2026-09-18T10:00:00.000Z" } },
    ] })).rejects.toBeInstanceOf(InvalidActionError);
    await expect(repo.commitAction({ actionId: "next-bout", changes: [
      { store: "walking_rests", operation: "put", record: { id: "rest-1", walking_bout_id: "bout-1", ended_at: "2026-09-18T10:02:00.000Z" } },
      { store: "walking_bouts", operation: "put", record: { id: "bout-2", walking_session_id: "pad", ended_at: null } },
    ] })).resolves.toBeDefined();
    await expect(repo.commitAction({ actionId: "rest-while-walking", changes: [
      { store: "walking_rests", operation: "put", record: { id: "rest-2", walking_bout_id: "bout-1", ended_at: null } },
    ] })).rejects.toBeInstanceOf(InvalidActionError);
  });

  it("deduplicates the same action after acknowledgement and rejects ID reuse", async () => {
    const repo = repository(new IDBFactory());
    const action: LocalAction = {
      actionId: "stable-action-id",
      changes: [
        {
          store: "exercise_registry",
          operation: "put",
          record: { id: "chest-press", name: "Chest Press" },
        },
      ],
    };

    const first = await repo.commitAction(action);
    await repo.acknowledgeOutbox(action.actionId);
    await expect(repo.listPendingOutbox()).resolves.toEqual([]);
    await expect(repo.commitAction(action)).resolves.toEqual(first);
    await expect(repo.listPendingOutbox()).resolves.toEqual([]);

    await expect(
      repo.commitAction({
        ...action,
        changes: [
          {
            store: "exercise_registry",
            operation: "put",
            record: { id: "chest-press", name: "Changed exercise" },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ActionConflictError);
  });

  it("evaluates stale-value preconditions inside serialized transactions", async () => {
    const factory = new IDBFactory();
    const databaseName = "concurrent-preconditions";
    const first = repository(factory, { databaseName });
    const second = repository(factory, { databaseName });
    await first.commitAction({
      actionId: "create-template",
      changes: [
        {
          store: "routine_templates",
          operation: "put",
          record: { id: "day-1", status: "DRAFT", name: "Day 1" },
        },
      ],
    });

    const attempts = await Promise.allSettled([
      first.commitAction({
        actionId: "publish-template",
        preconditions: [
          { store: "routine_templates", id: "day-1", expected: { status: "DRAFT" } },
        ],
        changes: [
          {
            store: "routine_templates",
            operation: "put",
            record: { id: "day-1", status: "PUBLISHED", name: "Day 1" },
          },
        ],
      }),
      second.commitAction({
        actionId: "archive-template",
        preconditions: [
          { store: "routine_templates", id: "day-1", expected: { status: "DRAFT" } },
        ],
        changes: [
          {
            store: "routine_templates",
            operation: "put",
            record: { id: "day-1", status: "ARCHIVED", name: "Day 1" },
          },
        ],
      }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(PreconditionFailedError);
    }
    const finalRecord = await first.getRecord("routine_templates", "day-1");
    expect(["PUBLISHED", "ARCHIVED"]).toContain(finalRecord?.status);
  });

  it("permits concurrent different session types but rejects two active sessions of one type", async () => {
    const factory = new IDBFactory();
    const databaseName = "concurrent-active-sessions";
    const first = repository(factory, { databaseName });
    const second = repository(factory, { databaseName });

    await expect(
      Promise.all([
        first.commitAction({
          actionId: "start-pad",
          preconditions: [
            { store: "walking_sessions", id: "pad-active", expected: null },
          ],
          changes: [
            {
              store: "walking_sessions",
              operation: "put",
              record: { id: "pad-active", status: "ACTIVE" },
            },
          ],
        }),
        second.commitAction({
          actionId: "start-resistance",
          preconditions: [
            { store: "resistance_sessions", id: "resistance-active", expected: null },
          ],
          changes: [
            {
              store: "resistance_sessions",
              operation: "put",
              record: { id: "resistance-active", status: "ACTIVE" },
            },
          ],
        }),
      ]),
    ).resolves.toHaveLength(2);

    const sameType = await Promise.allSettled([
      first.commitAction({
        actionId: "start-cardio-a",
        preconditions: [{ store: "cardio_sessions", id: "cardio-a", expected: null }],
        changes: [
          {
            store: "cardio_sessions",
            operation: "put",
            record: { id: "cardio-a", status: "ACTIVE" },
          },
        ],
      }),
      second.commitAction({
        actionId: "start-cardio-b",
        preconditions: [{ store: "cardio_sessions", id: "cardio-b", expected: null }],
        changes: [
          {
            store: "cardio_sessions",
            operation: "put",
            record: { id: "cardio-b", status: "ACTIVE" },
          },
        ],
      }),
    ]);

    expect(sameType.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = sameType.find((attempt) => attempt.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(ActiveSessionConflictError);
    }
    await expect(first.listRecords("cardio_sessions")).resolves.toHaveLength(1);
  });

  it("serializes double-taps that create open PAD bouts and pauses", async () => {
    const factory = new IDBFactory();
    const databaseName = "concurrent-pad-intervals";
    const first = repository(factory, { databaseName });
    const second = repository(factory, { databaseName });
    await first.commitAction({
      actionId: "create-pad-parent",
      changes: [
        {
          store: "walking_sessions",
          operation: "put",
          record: { id: "pad-parent", status: "ACTIVE" },
        },
      ],
    });

    const boutAttempts = await Promise.allSettled([
      first.commitAction({
        actionId: "start-bout-a",
        preconditions: [{ store: "walking_bouts", id: "bout-a", expected: null }],
        changes: [
          {
            store: "walking_bouts",
            operation: "put",
            record: { id: "bout-a", walking_session_id: "pad-parent", ended_at: null },
          },
        ],
      }),
      second.commitAction({
        actionId: "start-bout-b",
        preconditions: [{ store: "walking_bouts", id: "bout-b", expected: null }],
        changes: [
          {
            store: "walking_bouts",
            operation: "put",
            record: { id: "bout-b", walking_session_id: "pad-parent", ended_at: null },
          },
        ],
      }),
    ]);
    expect(boutAttempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejectedBout = boutAttempts.find((attempt) => attempt.status === "rejected");
    expect(rejectedBout).toBeDefined();
    if (rejectedBout?.status === "rejected") {
      expect(rejectedBout.reason).toBeInstanceOf(ActiveSessionConflictError);
    }

    const [openBout] = await first.listRecords("walking_bouts");
    expect(openBout).toBeDefined();
    const pauseAttempts = await Promise.allSettled([
      first.commitAction({
        actionId: "pause-a",
        preconditions: [{ store: "walking_pauses", id: "pause-a", expected: null }],
        changes: [
          {
            store: "walking_pauses",
            operation: "put",
            record: { id: "pause-a", walking_bout_id: openBout?.id ?? "", ended_at: null },
          },
        ],
      }),
      second.commitAction({
        actionId: "pause-b",
        preconditions: [{ store: "walking_pauses", id: "pause-b", expected: null }],
        changes: [
          {
            store: "walking_pauses",
            operation: "put",
            record: { id: "pause-b", walking_bout_id: openBout?.id ?? "", ended_at: null },
          },
        ],
      }),
    ]);
    expect(pauseAttempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejectedPause = pauseAttempts.find((attempt) => attempt.status === "rejected");
    expect(rejectedPause).toBeDefined();
    if (rejectedPause?.status === "rejected") {
      expect(rejectedPause.reason).toBeInstanceOf(ActiveSessionConflictError);
    }
    await expect(first.listRecords("walking_pauses")).resolves.toHaveLength(1);
  });

  it("uses a monotonic transaction sequence when the UTC wall clock moves backwards", async () => {
    const times = [
      new Date("2026-09-14T12:00:00.000Z"),
      new Date("2026-09-14T11:00:00.000Z"),
    ];
    const repo = repository(new IDBFactory(), { now: () => times.shift() ?? new Date(0) });

    const laterClock = await repo.commitAction({
      actionId: "clock-one",
      changes: [
        {
          store: "exercise_registry",
          operation: "put",
          record: { id: "exercise-1", name: "First" },
        },
      ],
    });
    const rolledBackClock = await repo.commitAction({
      actionId: "clock-two",
      changes: [
        {
          store: "exercise_registry",
          operation: "put",
          record: { id: "exercise-2", name: "Second" },
        },
      ],
    });

    expect(laterClock).toMatchObject({ sequence: 1, committedAt: "2026-09-14T12:00:00.000Z" });
    expect(rolledBackClock).toMatchObject({
      sequence: 2,
      committedAt: "2026-09-14T11:00:00.000Z",
    });
    expect((await repo.listPendingOutbox()).map((entry) => entry.sequence)).toEqual([1, 2]);
  });

  it("persists caller metadata and reference caches without colliding with internal metadata", async () => {
    const factory = new IDBFactory();
    const databaseName = "metadata-and-cache";
    const first = repository(factory, { databaseName });
    await first.setSyncMetadata("last_sequence", { cursor: "server-17" });
    await first.writeReferenceCache("pad-defaults", { max_bout_seconds: 300 });
    await expect(first.listPendingOutbox()).resolves.toEqual([]);
    first.close();
    await Promise.resolve();

    const reopened = repository(factory, { databaseName });
    await expect(reopened.getSyncMetadata("last_sequence")).resolves.toEqual({
      cursor: "server-17",
    });
    await expect(reopened.readReferenceCache("pad-defaults")).resolves.toEqual({
      max_bout_seconds: 300,
    });
    await expect(
      reopened.commitAction({
        actionId: "first-domain-action",
        changes: [
          {
            store: "exercise_registry",
            operation: "put",
            record: { id: "exercise-after-metadata", name: "Arm Crank" },
          },
        ],
      }),
    ).resolves.toMatchObject({ sequence: 1 });
  });

  it("persists the auth marker independently of domain records and metadata, and clears it on logout", async () => {
    const factory = new IDBFactory();
    const databaseName = "auth-marker-roundtrip";
    const first = repository(factory, { databaseName });
    await expect(first.getAuthMarker()).resolves.toBeUndefined();

    await first.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-14T10:00:00.000Z" });
    await expect(first.getAuthMarker()).resolves.toEqual({
      username: "juan",
      lastVerifiedAt: "2026-09-14T10:00:00.000Z",
    });
    // Re-verifying (e.g. app reopened online) overwrites in place rather than
    // accumulating separate records.
    await first.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-14T11:00:00.000Z" });
    await expect(first.getAuthMarker()).resolves.toEqual({
      username: "juan",
      lastVerifiedAt: "2026-09-14T11:00:00.000Z",
    });
    first.close();
    await Promise.resolve();

    const reopened = repository(factory, { databaseName });
    await expect(reopened.getAuthMarker()).resolves.toEqual({
      username: "juan",
      lastVerifiedAt: "2026-09-14T11:00:00.000Z",
    });

    // Logout clears the marker but must never touch domain data or the outbox.
    await reopened.commitAction({
      actionId: "domain-action-alongside-marker",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } },
      ],
    });
    await reopened.clearAuthMarker();
    await expect(reopened.getAuthMarker()).resolves.toBeUndefined();
    await expect(reopened.listRecords("exercise_registry")).resolves.toEqual([
      expect.objectContaining({ id: "exercise-1" }),
    ]);
    await expect(reopened.listPendingOutbox()).resolves.toHaveLength(1);
  });

  it("persists the outbox owner independently of the auth marker, surviving logout", async () => {
    const factory = new IDBFactory();
    const databaseName = "outbox-owner-roundtrip";
    const repo = repository(factory, { databaseName });
    await expect(repo.getOutboxOwner()).resolves.toBeUndefined();

    await repo.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-14T10:00:00.000Z" });
    await repo.setOutboxOwner({ username: "juan" });
    await repo.commitAction({
      actionId: "outbox-owner-pending-action",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } },
      ],
    });

    // Logout (clearAuthMarker) must never clear the outbox owner: it is the
    // durable record of whose pending outbox entries are on this device (see
    // the `OutboxOwner` JSDoc and docs/data-sync.md's different-user note).
    await repo.clearAuthMarker();
    await expect(repo.getAuthMarker()).resolves.toBeUndefined();
    await expect(repo.getOutboxOwner()).resolves.toEqual({ username: "juan" });
    await expect(repo.listPendingOutbox()).resolves.toHaveLength(1);
  });

  it("rejects a corrupted persisted auth marker instead of trusting it", async () => {
    const factory = new IDBFactory();
    const databaseName = "corrupted-auth-marker";
    const repo = repository(factory, { databaseName });
    // Force the schema (including internal_metadata) to exist before opening
    // a second, raw connection below to corrupt it.
    await repo.getAuthMarker();
    repo.close();
    await Promise.resolve();

    // Bypass the public API to write a value that does not satisfy AuthMarker.
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName);
      request.addEventListener("success", () => {
        resolve(request.result);
      });
      request.addEventListener("error", () => {
        reject(new Error("open failed"));
      });
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DATABASE_STORES.internalMetadata, "readwrite");
      transaction.objectStore(DATABASE_STORES.internalMetadata).put({ key: "auth_marker", value: "not-an-object" });
      transaction.addEventListener("complete", () => {
        resolve();
      });
      transaction.addEventListener("error", () => {
        reject(new Error("write failed"));
      });
    });
    database.close();

    const reopened = repository(factory, { databaseName });
    await expect(reopened.getAuthMarker()).rejects.toThrow(/auth marker/i);
  });

  it("rejects a corrupted persisted outbox owner instead of trusting it", async () => {
    const factory = new IDBFactory();
    const databaseName = "corrupted-outbox-owner";
    const repo = repository(factory, { databaseName });
    await repo.getOutboxOwner();
    repo.close();
    await Promise.resolve();

    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName);
      request.addEventListener("success", () => {
        resolve(request.result);
      });
      request.addEventListener("error", () => {
        reject(new Error("open failed"));
      });
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DATABASE_STORES.internalMetadata, "readwrite");
      transaction.objectStore(DATABASE_STORES.internalMetadata).put({ key: "outbox_owner", value: 42 });
      transaction.addEventListener("complete", () => {
        resolve();
      });
      transaction.addEventListener("error", () => {
        reject(new Error("write failed"));
      });
    });
    database.close();

    const reopened = repository(factory, { databaseName });
    await expect(reopened.getOutboxOwner()).rejects.toThrow(/outbox owner/i);
  });

  it("normalizes a synchronous db.transaction failure in acknowledgeOutbox and writeKeyValue", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({
      actionId: "seed-for-transaction-failure",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "seed", name: "Seed" } },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- reference is restored, never invoked unbound
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (): never {
      throw new DOMException("Connection is closing", "InvalidStateError");
    };
    try {
      await expect(repo.acknowledgeOutbox("seed-for-transaction-failure")).rejects.toBeInstanceOf(
        LocalStorageError,
      );
      await expect(repo.setSyncMetadata("cursor", "server-1")).rejects.toBeInstanceOf(
        LocalStorageError,
      );
    } finally {
      IDBDatabase.prototype.transaction = original;
    }
  });
});

/** Wraps an IDBFactory so `open()` results can be captured for direct manipulation. */
function capturingFactory(factory: IDBFactory): {
  factory: IDBFactory;
  connections: IDBDatabase[];
} {
  const connections: IDBDatabase[] = [];
  const open = factory.open.bind(factory);
  const wrapped: IDBFactory = Object.create(factory) as IDBFactory;
  wrapped.open = (...args: Parameters<IDBFactory["open"]>) => {
    const request = open(...args);
    request.addEventListener("success", () => {
      connections.push(request.result);
    });
    return request;
  };
  return { factory: wrapped, connections };
}

describe("LocalRepository connection recovery", () => {
  it("reopens after the underlying connection is forcibly closed", async () => {
    const { factory: wrapped, connections } = capturingFactory(new IDBFactory());
    const repo = repository(wrapped);
    await repo.commitAction({
      actionId: "before-forced-close",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "before-close", name: "Before" } },
      ],
    });
    expect(connections).toHaveLength(1);

    // Simulate the browser force-closing the connection (Safari/iOS storage
    // eviction, the IDB server process dying, the user clearing site data):
    // this fires `close` on the IDBDatabase without going through
    // `onversionchange`.
    // fake-indexeddb's type declares this parameter as the class rather than an
    // instance (a typo upstream); the runtime function takes an IDBDatabase.
    forceCloseDatabase(connections[0] as unknown as typeof IDBDatabase);

    // Every read and write must recover by reopening, not stay stuck on the
    // dead cached connection.
    await expect(repo.readSnapshot()).resolves.toBeDefined();
    await expect(
      repo.commitAction({
        actionId: "after-forced-close",
        changes: [
          { store: "exercise_registry", operation: "put", record: { id: "after-close", name: "After" } },
        ],
      }),
    ).resolves.toMatchObject({ sequence: 2 });
    expect(connections.length).toBeGreaterThanOrEqual(2);
  });

  it("reopens after db.transaction() throws InvalidStateError", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({
      actionId: "before-invalid-state",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "before", name: "Before" } },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- reference is restored, never invoked unbound
    const original = IDBDatabase.prototype.transaction;
    let thrown = false;
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      ...args: Parameters<IDBDatabase["transaction"]>
    ) {
      if (!thrown) {
        thrown = true;
        throw new DOMException("Connection is closing", "InvalidStateError");
      }
      return original.apply(this, args);
    };
    try {
      await expect(repo.commitAction({
        actionId: "during-invalid-state",
        changes: [
          { store: "exercise_registry", operation: "put", record: { id: "during", name: "During" } },
        ],
      })).rejects.toBeInstanceOf(LocalStorageError);

      // The next call must not reuse the dead cached connection.
      await expect(
        repo.commitAction({
          actionId: "after-invalid-state",
          changes: [
            { store: "exercise_registry", operation: "put", record: { id: "after", name: "After" } },
          ],
        }),
      ).resolves.toMatchObject({ sequence: 2 });
    } finally {
      IDBDatabase.prototype.transaction = original;
    }
  });

  it("still allows an explicit close() to stop the repository", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({
      actionId: "before-explicit-close",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "seed", name: "Seed" } },
      ],
    });
    repo.close();
    // close() itself must not be treated as a failure requiring reopen; a
    // subsequent operation reopens a fresh connection and finds the data.
    await expect(repo.getRecord("exercise_registry", "seed")).resolves.toMatchObject({
      id: "seed",
      name: "Seed",
    });
  });
});

describe("LocalRepository durability", () => {
  it("requests strict durability for commits, outbox acknowledgement, and metadata/cache writes", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({
      actionId: "seed-for-durability",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "seed", name: "Seed" } },
      ],
    });

    // eslint-disable-next-line @typescript-eslint/unbound-method -- spy restored in finally
    const original = IDBDatabase.prototype.transaction;
    const durabilities: (IDBTransactionOptions | undefined)[] = [];
    IDBDatabase.prototype.transaction = function (
      this: IDBDatabase,
      storeNames: string | string[],
      mode?: IDBTransactionMode,
      options?: IDBTransactionOptions,
    ) {
      if (mode === "readwrite") {
        durabilities.push(options);
      }
      return original.call(this, storeNames, mode, options);
    };
    try {
      await repo.commitAction({
        actionId: "durable-commit",
        changes: [
          { store: "exercise_registry", operation: "put", record: { id: "durable", name: "Durable" } },
        ],
      });
      await repo.acknowledgeOutbox("durable-commit");
      await repo.setSyncMetadata("cursor", "server-1");
      await repo.writeReferenceCache("pad-defaults", { max_bout_seconds: 300 });
    } finally {
      IDBDatabase.prototype.transaction = original;
    }

    expect(durabilities).toHaveLength(4);
    for (const options of durabilities) {
      expect(options?.durability).toBe("strict");
    }
  });
});

describe("LocalRepository quota errors", () => {
  it("wraps a QuotaExceededError from a failing write request as StorageQuotaExceededError", async () => {
    const repo = repository(new IDBFactory());

    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored in finally
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (): never {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    };
    try {
      const commit = repo.commitAction({
        actionId: "quota-exceeded",
        changes: [
          { store: "exercise_registry", operation: "put", record: { id: "quota", name: "Quota" } },
        ],
      });
      await expect(commit).rejects.toBeInstanceOf(StorageQuotaExceededError);
      const rejection = await commit.catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(StorageQuotaExceededError);
      const cause = rejection instanceof Error ? rejection.cause : undefined;
      expect(cause).toBeInstanceOf(DOMException);
      expect((cause as DOMException).name).toBe("QuotaExceededError");
    } finally {
      IDBObjectStore.prototype.add = original;
    }
  });

  it("wraps a QuotaExceededError surfaced through transaction.error as StorageQuotaExceededError", async () => {
    const repo = repository(new IDBFactory());

    // Simulate the transaction itself failing (not just one request) with a
    // QuotaExceededError, e.g. the final commit flush hitting the device quota.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored in finally
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (this.name === "internal_metadata") {
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      }
      return original.call(this, value, key);
    };
    try {
      const commit = repo.commitAction({
        actionId: "quota-exceeded-metadata",
        changes: [
          { store: "exercise_registry", operation: "put", record: { id: "quota-2", name: "Quota 2" } },
        ],
      });
      await expect(commit).rejects.toBeInstanceOf(StorageQuotaExceededError);
      const rejection = await commit.catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(StorageQuotaExceededError);
      const cause = rejection instanceof Error ? rejection.cause : undefined;
      expect(cause).toBeInstanceOf(DOMException);
      expect((cause as DOMException).name).toBe("QuotaExceededError");
    } finally {
      IDBObjectStore.prototype.put = original;
    }
  });
});

/** The internal marker id format: `${store}\0${scopeKey}` (see `repository.ts`). */
function markerRecordId(store: string, scopeKey: string): string {
  return `${store}${String.fromCharCode(0)}${scopeKey}`;
}

/** Writes an active-marker row directly, bypassing `commitAction`, to simulate drift. */
function writeMarker(
  factory: IDBFactory,
  databaseName: string,
  marker: { store: string; scopeKey: string; recordId: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName);
    request.onerror = () => {
      reject(request.error ?? new Error("Opening the database to corrupt a marker failed"));
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(DATABASE_STORES.activeMarkers, "readwrite");
      transaction.objectStore(DATABASE_STORES.activeMarkers).put({
        id: markerRecordId(marker.store, marker.scopeKey),
        store: marker.store,
        scopeKey: marker.scopeKey,
        recordId: marker.recordId,
      });
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error ?? new Error("Writing the corrupted marker failed"));
      };
    };
  });
}

/** Reads an active-marker row directly, bypassing the bounded repository API. */
function readMarker(
  factory: IDBFactory,
  databaseName: string,
  store: string,
  scopeKey: string,
): Promise<{ recordId: string } | undefined> {
  return new Promise((resolve, reject) => {
    const request = factory.open(databaseName);
    request.onerror = () => {
      reject(request.error ?? new Error("Opening the database to read a marker failed"));
    };
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(DATABASE_STORES.activeMarkers, "readonly");
      const readRequest = transaction.objectStore(DATABASE_STORES.activeMarkers).get(
        markerRecordId(store, scopeKey),
      ) as IDBRequest<{ recordId: string } | undefined>;
      transaction.oncomplete = () => {
        db.close();
        resolve(readRequest.result);
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error ?? new Error("Reading the marker failed"));
      };
    };
  });
}

describe("LocalRepository active-marker scope changes", () => {
  it("releases the previous-scope marker when a bout's parent session changes", async () => {
    const factory = new IDBFactory();
    const databaseName = "release-old-scope-on-reassign";
    const repo = repository(factory, { databaseName });
    await repo.commitAction({
      actionId: "open-bout-in-session-a",
      changes: [
        {
          store: "walking_bouts",
          operation: "put",
          record: { id: "bout-1", walking_session_id: "session-a", ended_at: null },
        },
      ],
    });

    // Reassign bout-1 from session-a to session-b while it stays open. Before
    // the fix, the session-a marker kept pointing at bout-1, so a genuinely new
    // open bout under session-a would be falsely rejected below.
    await repo.commitAction({
      actionId: "reassign-bout-to-session-b",
      changes: [
        {
          store: "walking_bouts",
          operation: "put",
          record: { id: "bout-1", walking_session_id: "session-b", ended_at: null },
        },
      ],
    });

    // Assert the internal marker store directly: the old scope must be
    // released eagerly by the commit itself, not merely left for a future
    // conflict to self-heal (that is fix #2's job, and a separate concern).
    await expect(readMarker(factory, databaseName, "walking_bouts", "session-a")).resolves.toBeUndefined();
    await expect(readMarker(factory, databaseName, "walking_bouts", "session-b")).resolves.toMatchObject({
      recordId: "bout-1",
    });

    await expect(
      repo.commitAction({
        actionId: "open-bout-in-freed-session-a",
        preconditions: [{ store: "walking_bouts", id: "bout-2", expected: null }],
        changes: [
          {
            store: "walking_bouts",
            operation: "put",
            record: { id: "bout-2", walking_session_id: "session-a", ended_at: null },
          },
        ],
      }),
    ).resolves.toMatchObject({ sequence: 3 });

    // session-b now genuinely holds bout-1 as its open marker: a second open
    // bout there must still be rejected as a real conflict.
    await expect(
      repo.commitAction({
        actionId: "second-open-bout-in-session-b",
        preconditions: [{ store: "walking_bouts", id: "bout-3", expected: null }],
        changes: [
          {
            store: "walking_bouts",
            operation: "put",
            record: { id: "bout-3", walking_session_id: "session-b", ended_at: null },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ActiveSessionConflictError);
  });

  it("releases the previous-scope marker when a pause's parent bout changes", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({
      actionId: "open-pause-in-bout-a",
      changes: [
        {
          store: "walking_pauses",
          operation: "put",
          record: { id: "pause-1", walking_bout_id: "bout-a", ended_at: null },
        },
      ],
    });

    await repo.commitAction({
      actionId: "reassign-pause-to-bout-b",
      changes: [
        {
          store: "walking_pauses",
          operation: "put",
          record: { id: "pause-1", walking_bout_id: "bout-b", ended_at: null },
        },
      ],
    });

    await expect(
      repo.commitAction({
        actionId: "open-pause-in-freed-bout-a",
        preconditions: [{ store: "walking_pauses", id: "pause-2", expected: null }],
        changes: [
          {
            store: "walking_pauses",
            operation: "put",
            record: { id: "pause-2", walking_bout_id: "bout-a", ended_at: null },
          },
        ],
      }),
    ).resolves.toMatchObject({ sequence: 3 });
  });
});

describe("LocalRepository active-marker self-healing", () => {
  it("self-heals a stale active-session marker instead of throwing a false conflict", async () => {
    const factory = new IDBFactory();
    const databaseName = "self-heal-stale-session-marker";
    const repo = repository(factory, { databaseName });
    // Force the schema (including active_markers) to exist before corrupting it.
    await repo.readSnapshot();

    // Simulate drift: a marker claims a walking session is ACTIVE, but no such
    // record actually exists (it could equally be tombstoned or COMPLETED).
    await writeMarker(factory, databaseName, {
      store: "walking_sessions",
      scopeKey: "walking_sessions",
      recordId: "phantom-session",
    });

    await expect(
      repo.commitAction({
        actionId: "start-pad-after-stale-marker",
        preconditions: [{ store: "walking_sessions", id: "pad-1", expected: null }],
        changes: [
          { store: "walking_sessions", operation: "put", record: { id: "pad-1", status: "ACTIVE" } },
        ],
      }),
    ).resolves.toMatchObject({ sequence: 1 });

    // The marker must now point at the real session, and further genuine
    // conflicts must still be rejected.
    await expect(
      repo.commitAction({
        actionId: "start-second-pad-after-heal",
        preconditions: [{ store: "walking_sessions", id: "pad-2", expected: null }],
        changes: [
          { store: "walking_sessions", operation: "put", record: { id: "pad-2", status: "ACTIVE" } },
        ],
      }),
    ).rejects.toBeInstanceOf(ActiveSessionConflictError);
  });

  it("self-heals a stale open-bout marker whose record moved to a different session", async () => {
    const factory = new IDBFactory();
    const databaseName = "self-heal-stale-bout-marker";
    const repo = repository(factory, { databaseName });
    await repo.commitAction({
      actionId: "open-bout-elsewhere",
      changes: [
        {
          store: "walking_bouts",
          operation: "put",
          record: { id: "bout-real", walking_session_id: "session-real", ended_at: null },
        },
      ],
    });

    // Corrupt the session-fake scope to falsely claim bout-real is open there
    // too (bout-real's actual record belongs to session-real).
    await writeMarker(factory, databaseName, {
      store: "walking_bouts",
      scopeKey: "session-fake",
      recordId: "bout-real",
    });

    await expect(
      repo.commitAction({
        actionId: "open-bout-in-session-fake",
        preconditions: [{ store: "walking_bouts", id: "bout-new", expected: null }],
        changes: [
          {
            store: "walking_bouts",
            operation: "put",
            record: { id: "bout-new", walking_session_id: "session-fake", ended_at: null },
          },
        ],
      }),
    ).resolves.toMatchObject({ sequence: 2 });
  });
});

describe("LocalRepository sync-engine support (issue #20)", () => {
  it("creates a client id on first call, persists it, and never changes it", async () => {
    let calls = 0;
    const repo = repository(new IDBFactory(), { uuid: () => `generated-${(calls++).toString()}` });

    const first = await repo.getClientId();
    const second = await repo.getClientId();
    expect(first).toBe("generated-0");
    expect(second).toBe(first);

    // A commit's own client-id bootstrap (see `commitAction`) must see the
    // same value `getClientId` already created, not mint a second one.
    await repo.commitAction({
      actionId: "after-get-client-id",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "ex-1" } }],
    });
    await expect(repo.getClientId()).resolves.toBe(first);
  });

  it("commitAction's own client-id bootstrap is seen by a later getClientId call", async () => {
    let calls = 0;
    const repo = repository(new IDBFactory(), { uuid: () => `generated-${(calls++).toString()}` });

    await repo.commitAction({
      actionId: "creates-client-id",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "ex-1" } }],
    });
    await expect(repo.getClientId()).resolves.toBe("generated-0");
    await expect(repo.getClientId()).resolves.toBe("generated-0");
  });

  it("markOutboxRejected excludes the entry from listPendingOutbox and readSnapshot, without removing it", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({
      actionId: "mutation-a",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "ex-a" } }],
    });
    await repo.commitAction({
      actionId: "mutation-b",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "ex-b" } }],
    });

    const rejection = { code: "invalid_record", detail: "ex-a is unusable", rejectedAt: "2026-09-20T00:00:00.000Z" };
    await repo.markOutboxRejected("mutation-a", rejection);

    await expect(repo.listPendingOutbox()).resolves.toEqual([
      expect.objectContaining({ mutation_id: "mutation-b" }),
    ]);
    const snapshot = await repo.readSnapshot();
    expect(snapshot.pendingOutbox).toEqual([expect.objectContaining({ mutation_id: "mutation-b" })]);

    const rejected = await repo.listRejectedOutbox();
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ mutation_id: "mutation-a", rejection });
    // The domain data itself is untouched -- a rejection never deletes anything.
    await expect(repo.getRecord("exercise_registry", "ex-a")).resolves.toMatchObject({ id: "ex-a" });
  });

  it("markOutboxRejected is a no-op once the entry is already acknowledged", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({
      actionId: "mutation-a",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "ex-a" } }],
    });
    await repo.acknowledgeOutbox("mutation-a");

    await expect(
      repo.markOutboxRejected("mutation-a", { code: "invalid_record", detail: "late", rejectedAt: "2026-09-20T00:00:00.000Z" }),
    ).resolves.toBeUndefined();
    await expect(repo.listRejectedOutbox()).resolves.toEqual([]);
  });

  it("rejected and unacknowledged outbox entries both survive closing and reopening the repository", async () => {
    const factory = new IDBFactory();
    const databaseName = "outbox-restart-durability";
    const first = repository(factory, { databaseName });
    await first.commitAction({
      actionId: "mutation-a",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "ex-a" } }],
    });
    await first.commitAction({
      actionId: "mutation-b",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "ex-b" } }],
    });
    await first.markOutboxRejected("mutation-a", {
      code: "invalid_record",
      detail: "bad",
      rejectedAt: "2026-09-20T00:00:00.000Z",
    });
    first.close();

    const second = repository(factory, { databaseName });
    await expect(second.listPendingOutbox()).resolves.toEqual([
      expect.objectContaining({ mutation_id: "mutation-b" }),
    ]);
    await expect(second.listRejectedOutbox()).resolves.toEqual([
      expect.objectContaining({ mutation_id: "mutation-a" }),
    ]);
  });

  it("applyServerRecords creates a record with no local history from the feed alone", async () => {
    const repo = repository(new IDBFactory());
    await repo.applyServerRecords(
      [
        {
          store: "walking_sessions",
          entity_id: "session-1",
          record: { id: "session-1", status: "COMPLETED", started_at: "2026-09-14T10:00:00.000Z", completed_at: "2026-09-14T11:00:00.000Z", created_at: "2026-09-14T10:00:00.000Z", updated_at: "2026-09-14T11:00:00.000Z", deleted_at: null },
        },
      ],
      41,
    );
    await expect(repo.getRecord("walking_sessions", "session-1")).resolves.toMatchObject({
      id: "session-1",
      status: "COMPLETED",
    });
    await expect(repo.getSyncMetadata(SYNC_CURSOR_KEY)).resolves.toBe(41);
  });

  it("applyServerRecords merges feed fields into an existing record without dropping local-only fields", async () => {
    const repo = repository(new IDBFactory());
    // A field the server does not model (per docs/data-sync.md, "Pull: changes
    // feed" the feed only carries the fields it validates) -- must survive the merge.
    await repo.commitAction({
      actionId: "local-only-field",
      changes: [
        {
          store: "walking_bouts",
          operation: "put",
          record: { id: "bout-1", walking_session_id: "session-1", started_at: "2026-09-14T10:00:00.000Z", local_only_hint: "keep-me" },
        },
      ],
    });
    await repo.acknowledgeOutbox("local-only-field");

    await repo.applyServerRecords(
      [
        {
          store: "walking_bouts",
          entity_id: "bout-1",
          record: {
            id: "bout-1",
            walking_session_id: "session-1",
            started_at: "2026-09-14T10:00:00.000Z",
            ended_at: "2026-09-14T10:30:00.000Z",
            created_at: "2026-09-14T10:00:00.000Z",
            updated_at: "2026-09-14T10:30:00.000Z",
            deleted_at: null,
          },
        },
      ],
      1,
    );

    await expect(repo.getRecord("walking_bouts", "bout-1")).resolves.toMatchObject({
      ended_at: "2026-09-14T10:30:00.000Z",
      local_only_hint: "keep-me",
    });
  });

  it("applyServerRecords leaves a record with a pending outbox mutation alone except for a server-side closure", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({
      actionId: "start-session",
      changes: [
        {
          store: "walking_sessions",
          operation: "put",
          record: { id: "session-1", status: "ACTIVE", started_at: "2026-09-14T10:00:00.000Z", speed_kmh: 5 },
        },
      ],
    });
    // The mutation is still pending (never acknowledged): the feed must not
    // clobber its device-writable fields with a stale value...
    await repo.applyServerRecords(
      [
        {
          store: "walking_sessions",
          entity_id: "session-1",
          record: {
            id: "session-1",
            status: "COMPLETED",
            started_at: "2026-09-14T10:00:00.000Z",
            completed_at: "2026-09-14T10:45:00.000Z",
            speed_kmh: 999,
            created_at: "2026-09-14T10:00:00.000Z",
            updated_at: "2026-09-14T10:45:00.000Z",
            deleted_at: null,
          },
        },
      ],
      1,
    );

    const record = await repo.getRecord("walking_sessions", "session-1");
    // ...but a server-side closure (here: a supersede) must not be lost, so
    // the device does not keep believing the session is still ACTIVE.
    expect(record).toMatchObject({ status: "COMPLETED", completed_at: "2026-09-14T10:45:00.000Z" });
    // The pending mutation's own field value wins over the feed's.
    expect(record?.speed_kmh).toBe(5);
  });

  it("applyServerRecords keeps active_markers consistent so a later local commit is not falsely blocked", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({
      actionId: "start-session",
      changes: [
        { store: "walking_sessions", operation: "put", record: { id: "session-1", status: "ACTIVE" } },
      ],
    });
    await repo.acknowledgeOutbox("start-session");

    // Another device's session superseded this one; the feed reports it closed.
    await repo.applyServerRecords(
      [
        {
          store: "walking_sessions",
          entity_id: "session-1",
          record: { id: "session-1", status: "COMPLETED", completed_at: "2026-09-14T10:45:00.000Z" },
        },
      ],
      2,
    );

    // A new local ACTIVE session must not be rejected as a conflict against a
    // now-stale marker still pointing at session-1.
    await expect(
      repo.commitAction({
        actionId: "start-new-session",
        preconditions: [{ store: "walking_sessions", id: "session-2", expected: null }],
        changes: [
          { store: "walking_sessions", operation: "put", record: { id: "session-2", status: "ACTIVE" } },
        ],
      }),
    ).resolves.toBeDefined();
  });

  it("applyServerRecords rejects a non-integer or negative cursor", async () => {
    const repo = repository(new IDBFactory());
    await expect(repo.applyServerRecords([], -1)).rejects.toThrow();
    await expect(repo.applyServerRecords([], 1.5)).rejects.toThrow();
  });

  it("applyServerRecords persists the cursor durably, resuming an interrupted pull after a restart", async () => {
    const factory = new IDBFactory();
    const databaseName = "cursor-restart-durability";
    const first = repository(factory, { databaseName });
    await first.applyServerRecords(
      [{ store: "walking_sessions", entity_id: "session-1", record: { id: "session-1", status: "ACTIVE" } }],
      7,
    );
    first.close();

    const second = repository(factory, { databaseName });
    await expect(second.getSyncMetadata(SYNC_CURSOR_KEY)).resolves.toBe(7);
  });

  // --- Issue #20 review, M2: a rejected mutation's local data must not be
  // silently reverted by the changes feed. ---

  it("applyServerRecords does not revert a rejected mutation's local data (M2)", async () => {
    const repo = repository(new IDBFactory());
    // A bout already synced at pain 2 (no pending mutation).
    await repo.applyServerRecords(
      [
        {
          store: "walking_bouts",
          entity_id: "bout-1",
          record: {
            id: "bout-1",
            walking_session_id: "session-1",
            pain_min: 2,
            pain_max: 2,
            started_at: "2026-09-14T10:00:00.000Z",
            created_at: "2026-09-14T10:00:00.000Z",
            updated_at: "2026-09-14T10:00:00.000Z",
            deleted_at: null,
          },
        },
      ],
      1,
    );

    // The user edits pain to 4; the mutation is queued, then permanently rejected.
    await repo.commitAction({
      actionId: "edit-pain",
      changes: [
        {
          store: "walking_bouts",
          operation: "put",
          record: {
            id: "bout-1",
            walking_session_id: "session-1",
            pain_min: 4,
            pain_max: 4,
            started_at: "2026-09-14T10:00:00.000Z",
          },
        },
      ],
    });
    await repo.markOutboxRejected("edit-pain", {
      code: "invalid_record",
      detail: "pain out of range",
      rejectedAt: "2026-09-20T00:00:00.000Z",
    });

    // The next feed page still carries the server's own (never-updated) value.
    await repo.applyServerRecords(
      [
        {
          store: "walking_bouts",
          entity_id: "bout-1",
          record: {
            id: "bout-1",
            walking_session_id: "session-1",
            pain_min: 2,
            pain_max: 2,
            started_at: "2026-09-14T10:00:00.000Z",
            created_at: "2026-09-14T10:00:00.000Z",
            updated_at: "2026-09-14T10:05:00.000Z",
            deleted_at: null,
          },
        },
      ],
      2,
    );

    const record = await repo.getRecord("walking_bouts", "bout-1");
    // The user's edit must survive the feed page: this is what the "needs
    // attention" banner's "The data is still on this device" claims.
    expect(record?.pain_min).toBe(4);
    expect(record?.pain_max).toBe(4);
  });

  it("applyServerRecords does not reinstall the active marker from a rejected 'finish session' mutation (M2, sharper variant)", async () => {
    const repo = repository(new IDBFactory());
    await repo.commitAction({
      actionId: "start-session",
      changes: [
        { store: "walking_sessions", operation: "put", record: { id: "session-1", status: "ACTIVE", started_at: "2026-09-14T10:00:00.000Z" } },
      ],
    });
    await repo.acknowledgeOutbox("start-session");

    // The user finishes the session locally; the mutation is queued, then rejected.
    await repo.commitAction({
      actionId: "finish-session",
      changes: [
        {
          store: "walking_sessions",
          operation: "put",
          record: {
            id: "session-1",
            status: "COMPLETED",
            started_at: "2026-09-14T10:00:00.000Z",
            completed_at: "2026-09-14T10:30:00.000Z",
          },
        },
      ],
    });
    await repo.markOutboxRejected("finish-session", {
      code: "invalid_transition",
      detail: "already closed",
      rejectedAt: "2026-09-20T00:00:00.000Z",
    });

    // The feed still reports the server's own (stale) ACTIVE state.
    await repo.applyServerRecords(
      [
        {
          store: "walking_sessions",
          entity_id: "session-1",
          record: {
            id: "session-1",
            status: "ACTIVE",
            started_at: "2026-09-14T10:00:00.000Z",
            created_at: "2026-09-14T10:00:00.000Z",
            updated_at: "2026-09-14T10:00:00.000Z",
            deleted_at: null,
          },
        },
      ],
      1,
    );

    const record = await repo.getRecord("walking_sessions", "session-1");
    expect(record?.status).toBe("COMPLETED");

    // The active marker must not be reinstalled either -- otherwise the
    // finished session would reappear as a Resume card, and a new local
    // session of the same type would be falsely rejected as a conflict.
    await expect(
      repo.commitAction({
        actionId: "start-new-session",
        preconditions: [{ store: "walking_sessions", id: "session-2", expected: null }],
        changes: [{ store: "walking_sessions", operation: "put", record: { id: "session-2", status: "ACTIVE" } }],
      }),
    ).resolves.toBeDefined();
  });

  // --- Issue #20 review, M3: the feed-installed active-marker escape (resume
  // the session the feed carries) must actually work end to end, and the
  // feed *installing* a fresh marker (not only clearing a stale one) needs
  // its own coverage. No local supersede is implemented here -- by design,
  // see docs/data-sync.md, "Stuck ACTIVE sessions" and issue #13. ---

  it("readSnapshot resolves a feed-only ACTIVE walking session as resumable, with no outbox entry at all (M3)", async () => {
    const repo = repository(new IDBFactory());
    // Arrives only through the feed -- e.g. another device started it -- and
    // is never committed locally, so there is no outbox entry for it.
    await repo.applyServerRecords(
      [
        {
          store: "walking_sessions",
          entity_id: "session-1",
          record: {
            id: "session-1",
            status: "ACTIVE",
            started_at: "2026-09-14T10:00:00.000Z",
            created_at: "2026-09-14T10:00:00.000Z",
            updated_at: "2026-09-14T10:00:00.000Z",
            deleted_at: null,
          },
        },
      ],
      1,
    );

    const snapshot = await repo.readSnapshot();
    // This is the Resume-card escape docs/data-sync.md names for a device
    // whose feed carries another device's live ACTIVE session: HomePage
    // derives its Resume cards straight from this field
    // (`local/activeSessions.ts`), with no dependency on how the ACTIVE
    // record got here.
    expect(snapshot.records.walking_sessions).toEqual([
      expect.objectContaining({ id: "session-1", status: "ACTIVE" }),
    ]);
    expect(snapshot.pendingOutbox).toEqual([]);
  });

  it("applyServerRecords installs the active marker for a brand-new feed ACTIVE session, not only clears a stale one (M3)", async () => {
    const repo = repository(new IDBFactory());
    await repo.applyServerRecords(
      [
        {
          store: "walking_sessions",
          entity_id: "session-1",
          record: {
            id: "session-1",
            status: "ACTIVE",
            started_at: "2026-09-14T10:00:00.000Z",
            created_at: "2026-09-14T10:00:00.000Z",
            updated_at: "2026-09-14T10:00:00.000Z",
            deleted_at: null,
          },
        },
      ],
      1,
    );

    // By design (owner decision, issue #13): at most one ACTIVE session per
    // type locally. A feed-installed marker must block a new local one
    // exactly like a locally-committed one would -- resume/finish the
    // existing session is the intended escape, not a local supersede.
    await expect(
      repo.commitAction({
        actionId: "start-new-session",
        preconditions: [{ store: "walking_sessions", id: "session-2", expected: null }],
        changes: [{ store: "walking_sessions", operation: "put", record: { id: "session-2", status: "ACTIVE" } }],
      }),
    ).rejects.toThrow(ActiveSessionConflictError);
  });
});
