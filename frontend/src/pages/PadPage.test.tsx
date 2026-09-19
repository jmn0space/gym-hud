import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalDataStatus } from "../components/LocalDataStatus";
import { deriveActiveSessionSummaries } from "../local/activeSessions";
import { LocalDataProvider } from "../local/LocalDataProvider";
import {
  discardWalkingSessionAction,
  startWalkingSessionAction,
  DEFAULT_WALKING_SETTINGS,
  PREVIOUS_WALKING_SESSION_KEY,
} from "../pad";
import {
  ActiveSessionConflictError,
  createLocalRepository,
  type CommitReceipt,
  type DomainStore,
  type LocalAction,
  type LocalRecord,
  type LocalRepository,
  type RecoverySnapshot,
} from "../storage";
import { PadPage } from "./PadPage";

const openRepositories: LocalRepository[] = [];

function repositoryOver(databaseName: string): LocalRepository {
  const repository = createLocalRepository({ databaseName });
  openRepositories.push(repository);
  return repository;
}

function freshRepository(): LocalRepository {
  return repositoryOver(`pad-page-${crypto.randomUUID()}`);
}

// StrictMode matches the dev entry point and double-invokes effects.
function renderPad(repository: LocalRepository) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={["/pad"]}>
        <LocalDataProvider repository={repository}>
          <LocalDataStatus />
          <PadPage />
        </LocalDataProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

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

function snapshotOf(records: Partial<Record<DomainStore, LocalRecord[]>>): RecoverySnapshot {
  return {
    records: Object.fromEntries(STORES.map((store) => [store, records[store] ?? []])) as Record<
      DomainStore,
      LocalRecord[]
    >,
    pendingOutbox: [],
  };
}

/**
 * A repository that only answers what a PAD screen reads, so a test can put the
 * stored state -- including state no real write could produce -- exactly where it
 * needs it. `snapshot` is read on every call, so a test can move the stored state
 * on between renders the way another tab would.
 */
function fakeRepository(
  snapshot: () => RecoverySnapshot,
  commitAction: (action: LocalAction) => Promise<CommitReceipt> = (action) =>
    Promise.resolve({ actionId: action.actionId, sequence: 1, committedAt: "2026-09-18T10:00:00.000Z" }),
): LocalRepository {
  return {
    readSnapshot: () => Promise.resolve(snapshot()),
    listRecords: () => Promise.resolve([]),
    getSyncMetadata: () => Promise.resolve(undefined),
    setSyncMetadata: () => Promise.resolve(),
    commitAction,
    close: vi.fn(),
  } as unknown as LocalRepository;
}

const ACTIVE_SESSION: LocalRecord = {
  id: "session-1",
  status: "ACTIVE",
  started_at: "2026-09-18T09:59:00.000Z",
  completed_at: null,
  speed_kmh: 5,
  incline_pct: 2,
  max_bout_seconds: 480,
  session_notes: null,
};

/**
 * Only `Date` is faked in the repository-backed tests below: IndexedDB, `waitFor`
 * and event delivery all keep running on real timers, while the clock every
 * derivation reads stays exactly where `vi.setSystemTime` puts it. That makes an
 * asserted timer value exact rather than "within a second".
 */
function useFrozenClock(at: string): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse(at));
}

afterEach(() => {
  for (const repository of openRepositories.splice(0)) {
    repository.close();
  }
});

describe("PAD start screen", () => {
  it("offers the application defaults when no walking session has been completed", async () => {
    renderPad(freshRepository());

    expect(await screen.findByLabelText("Speed (km/h)")).toHaveValue(5);
    expect(screen.getByLabelText("Incline (%)")).toHaveValue(2);
    expect(screen.getByLabelText("Maximum bout (minutes)")).toHaveValue(8);
    expect(await screen.findByText(/No completed walking session yet/)).toBeInTheDocument();
  });

  it("inherits the previous completed session's settings and summarizes it", async () => {
    const repository = freshRepository();
    await repository.commitAction({
      actionId: "seed-completed",
      changes: [
        {
          store: "walking_sessions",
          operation: "put",
          record: {
            id: "session-old",
            status: "COMPLETED",
            started_at: "2026-09-16T09:00:00.000Z",
            completed_at: "2026-09-16T09:40:00.000Z",
            speed_kmh: 5.6,
            incline_pct: 3.5,
            max_bout_seconds: 300,
            session_notes: null,
          },
        },
        {
          store: "walking_bouts",
          operation: "put",
          record: {
            id: "bout-old",
            walking_session_id: "session-old",
            bout_number: 1,
            started_at: "2026-09-16T09:05:00.000Z",
            ended_at: "2026-09-16T09:13:00.000Z",
          },
        },
      ],
    });

    renderPad(repository);

    await waitFor(() => {
      expect(screen.getByLabelText("Speed (km/h)")).toHaveValue(5.6);
    });
    expect(screen.getByLabelText("Incline (%)")).toHaveValue(3.5);
    expect(screen.getByLabelText("Maximum bout (minutes)")).toHaveValue(5);
    expect(await screen.findByText("1 bout · 08:00 walking")).toBeInTheDocument();
  });

  it("refuses a maximum bout that rounds to zero seconds, and says why", async () => {
    useFrozenClock("2026-09-18T10:00:00.000Z");
    const repository = freshRepository();
    renderPad(repository);

    const maxBout = await screen.findByLabelText("Maximum bout (minutes)");
    fireEvent.change(maxBout, { target: { value: "0.001" } });

    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(maxBout).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByText("The maximum bout must be at least 1 second (0.01 minutes)."),
    ).toBeInTheDocument();

    fireEvent.change(maxBout, { target: { value: "0.01" } });
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("keeps the settings editable and starts the session with the edited values", async () => {
    useFrozenClock("2026-09-18T10:00:00.000Z");
    const repository = freshRepository();
    renderPad(repository);

    const speed = await screen.findByLabelText("Speed (km/h)");
    fireEvent.change(speed, { target: { value: "4.2" } });
    fireEvent.change(screen.getByLabelText("Maximum bout (minutes)"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("4.2 km/h · Incline 2.0% · Maximum bout 06:00")).toBeInTheDocument();
    const [session] = await repository.listRecords("walking_sessions");
    expect(session).toEqual(
      expect.objectContaining({
        status: "ACTIVE",
        started_at: "2026-09-18T10:00:00.000Z",
        speed_kmh: 4.2,
        max_bout_seconds: 360,
      }),
    );
  });
});

describe("PAD walking controls", () => {
  it("starts a session and its first bout, one committed action each", async () => {
    useFrozenClock("2026-09-18T10:00:00.000Z");
    const repository = freshRepository();
    renderPad(repository);

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("Bout 1")).toBeInTheDocument();

    vi.setSystemTime(Date.parse("2026-09-18T10:01:00.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Start walking" }));

    expect(await screen.findByText("Walking")).toBeInTheDocument();
    expect(screen.getByText("00:00")).toBeInTheDocument();
    const [bout] = await repository.listRecords("walking_bouts");
    expect(bout).toEqual(
      expect.objectContaining({
        bout_number: 1,
        started_at: "2026-09-18T10:01:00.000Z",
        ended_at: null,
      }),
    );
    // One logical operation, one outbox envelope each.
    expect(await repository.listPendingOutbox()).toHaveLength(2);
  });

  it("ignores a second tap while the first start is still committing", async () => {
    useFrozenClock("2026-09-18T10:00:00.000Z");
    const repository = freshRepository();
    renderPad(repository);

    const start = await screen.findByRole("button", { name: "Start" });
    fireEvent.click(start);
    fireEvent.click(start);

    expect(await screen.findByText("Ready")).toBeInTheDocument();
    await waitFor(async () => {
      expect(await repository.listPendingOutbox()).toHaveLength(1);
    });
    expect(await repository.listRecords("walking_sessions")).toHaveLength(1);
  });

  it("answers a resubmitted start from its receipt and refuses a second active session", async () => {
    const repository = freshRepository();
    const action = startWalkingSessionAction({
      actionId: "start-1",
      sessionId: "session-1",
      settings: DEFAULT_WALKING_SETTINGS,
      now: new Date("2026-09-18T10:00:00.000Z"),
    });

    const receipt = await repository.commitAction(action);
    // The same logical action again (a retry, or a double submit that reached the
    // repository): the durable receipt answers it instead of writing a second session.
    expect(await repository.commitAction(action)).toEqual(receipt);
    expect(await repository.listRecords("walking_sessions")).toHaveLength(1);

    await expect(
      repository.commitAction(
        startWalkingSessionAction({
          actionId: "start-2",
          sessionId: "session-2",
          settings: DEFAULT_WALKING_SETTINGS,
          now: new Date("2026-09-18T10:00:30.000Z"),
        }),
      ),
    ).rejects.toBeInstanceOf(ActiveSessionConflictError);
  });

  it("finishes the session, closing the open bout, and inherits its settings next time", async () => {
    useFrozenClock("2026-09-18T10:00:00.000Z");
    const repository = freshRepository();
    renderPad(repository);

    fireEvent.change(await screen.findByLabelText("Speed (km/h)"), { target: { value: "6.4" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start walking" }));
    await screen.findByText("Walking");

    vi.setSystemTime(Date.parse("2026-09-18T10:08:00.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Finish session" }));

    // Back to the start screen, now inheriting from the session just completed.
    await waitFor(() => {
      expect(screen.getByLabelText("Speed (km/h)")).toHaveValue(6.4);
    });
    const [session] = await repository.listRecords("walking_sessions");
    expect(session).toEqual(
      expect.objectContaining({
        status: "COMPLETED",
        completed_at: "2026-09-18T10:08:00.000Z",
      }),
    );
    const [bout] = await repository.listRecords("walking_bouts");
    expect(bout).toEqual(expect.objectContaining({ ended_at: "2026-09-18T10:08:00.000Z" }));
  });

  it("surfaces a rejected commit through the shared storage error surface", async () => {
    const repository = fakeRepository(
      () => snapshotOf({}),
      () => Promise.reject(new ActiveSessionConflictError("already active")),
    );
    renderPad(repository);

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This change conflicts with newer saved data and was not saved.",
    );
  });
});

describe("PAD commit attempts", () => {
  it("re-stamps a delayed retry instead of backdating the session to the first tap", async () => {
    useFrozenClock("2026-09-18T10:00:00.000Z");
    const stored = freshRepository();
    let failNext = true;
    const repository: LocalRepository = {
      ...stored,
      commitAction: (action) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new DOMException("out of space", "QuotaExceededError"));
        }
        return stored.commitAction(action);
      },
    };
    renderPad(repository);

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Device storage is full");

    // Eleven minutes later the user frees up space and retries. The session starts
    // now: the first tap started nothing, so its timestamp must not be persisted.
    vi.setSystemTime(Date.parse("2026-09-18T10:11:00.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Ready")).toBeInTheDocument();
    const sessions = await stored.listRecords("walking_sessions");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(
      expect.objectContaining({ status: "ACTIVE", started_at: "2026-09-18T10:11:00.000Z" }),
    );
  });

  it("keeps one failed attempt's identifiers while a prompt retry can still succeed", async () => {
    useFrozenClock("2026-09-18T10:00:00.000Z");
    const actions: LocalAction[] = [];
    let failNext = true;
    const repository = fakeRepository(
      () => snapshotOf({}),
      (action) => {
        actions.push(action);
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("the disk hiccuped"));
        }
        return Promise.resolve({ actionId: action.actionId, sequence: 1, committedAt: "2026-09-18T10:00:00.000Z" });
      },
    );
    renderPad(repository);

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(actions).toHaveLength(2);
    });
    // Same tap, seconds apart: one logical action the repository's receipt can
    // answer, rather than a second session.
    expect(actions[1]?.actionId).toBe(actions[0]?.actionId);
    expect(actions[1]).toEqual(actions[0]);
  });

  it("starts a new logical action after a failure that can never succeed", async () => {
    useFrozenClock("2026-09-18T10:00:00.000Z");
    const actions: LocalAction[] = [];
    let failNext = true;
    const repository = fakeRepository(
      () => snapshotOf({}),
      (action) => {
        actions.push(action);
        if (failNext) {
          failNext = false;
          return Promise.reject(new ActiveSessionConflictError("already active"));
        }
        return Promise.resolve({ actionId: action.actionId, sequence: 1, committedAt: "2026-09-18T10:00:00.000Z" });
      },
    );
    renderPad(repository);

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    // The controls are still live -- a rejected build or commit must not leave an
    // in-flight flag set -- and the retained attempt was dropped with the conflict.
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(actions).toHaveLength(2);
    });
    expect(actions[1]?.actionId).not.toBe(actions[0]?.actionId);
  });

  it("moves focus to the page heading when the screen switches", async () => {
    useFrozenClock("2026-09-18T10:00:00.000Z");
    renderPad(freshRepository());

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    expect(await screen.findByText("Ready")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "PAD walking" })).toHaveFocus();
    });
  });
});

describe("PAD finishing a session", () => {
  it("closes what the live snapshot holds, not what this view last rendered", async () => {
    const actions: LocalAction[] = [];
    let stored = snapshotOf({ walking_sessions: [ACTIVE_SESSION] });
    const repository = fakeRepository(
      () => stored,
      (action) => {
        actions.push(action);
        return Promise.resolve({ actionId: action.actionId, sequence: 1, committedAt: "2026-09-18T10:05:00.000Z" });
      },
    );
    renderPad(repository);
    expect(await screen.findByText("Ready")).toBeInTheDocument();

    // Another view starts a bout. This one has not refreshed yet, so its rendered
    // state still says READY.
    stored = snapshotOf({
      walking_sessions: [ACTIVE_SESSION],
      walking_bouts: [
        {
          id: "bout-1",
          walking_session_id: "session-1",
          bout_number: 1,
          started_at: "2026-09-18T10:04:00.000Z",
          ended_at: null,
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Finish session" }));

    await waitFor(() => {
      expect(actions).toHaveLength(1);
    });
    // The bout is closed too: left open inside a COMPLETED session, no later
    // snapshot could ever reach it again.
    expect(actions[0]?.changes.map((change) => change.store)).toEqual([
      "walking_bouts",
      "walking_sessions",
    ]);
    expect(actions[0]?.preconditions).toContainEqual({
      store: "walking_bouts",
      id: "bout-1",
      expected: { ended_at: null },
    });
  });

  it("records the finished session's summary so the next start screen reads one key", async () => {
    useFrozenClock("2026-09-18T10:00:00.000Z");
    const repository = freshRepository();
    const firstRender = renderPad(repository);

    fireEvent.change(await screen.findByLabelText("Speed (km/h)"), { target: { value: "6.4" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    vi.setSystemTime(Date.parse("2026-09-18T10:01:00.000Z"));
    fireEvent.click(await screen.findByRole("button", { name: "Start walking" }));
    await screen.findByText("Walking");

    vi.setSystemTime(Date.parse("2026-09-18T10:07:00.000Z"));
    fireEvent.click(screen.getByRole("button", { name: "Finish session" }));

    await waitFor(async () => {
      expect(await repository.getSyncMetadata(PREVIOUS_WALKING_SESSION_KEY)).toEqual({
        speed_kmh: 6.4,
        incline_pct: 2,
        max_bout_seconds: 480,
        bout_count: 1,
        walking_ms: 6 * 60_000,
      });
    });

    firstRender.unmount();
    // A repository that refuses history scans: inheritance must come from the
    // summary alone, not from deserializing every session, bout and pause ever
    // recorded on the device.
    const scanFree: LocalRepository = {
      ...repository,
      listRecords: () => Promise.reject(new Error("all-time history must not be scanned")),
    };
    renderPad(scanFree);

    expect(await screen.findByText("1 bout · 06:00 walking")).toBeInTheDocument();
    expect(screen.getByLabelText("Speed (km/h)")).toHaveValue(6.4);
  });

  it("carries inherited settings forward exactly rather than rounding them", async () => {
    const repository = freshRepository();
    await repository.commitAction({
      actionId: "seed-completed",
      changes: [
        {
          store: "walking_sessions",
          operation: "put",
          record: {
            id: "session-old",
            status: "COMPLETED",
            started_at: "2026-09-16T09:00:00.000Z",
            completed_at: "2026-09-16T09:40:00.000Z",
            speed_kmh: 5.65,
            incline_pct: 2.25,
            max_bout_seconds: 445,
            session_notes: null,
          },
        },
      ],
    });
    useFrozenClock("2026-09-18T10:00:00.000Z");
    renderPad(repository);

    await waitFor(() => {
      expect(screen.getByLabelText("Speed (km/h)")).toHaveValue(5.65);
    });
    expect(screen.getByLabelText("Incline (%)")).toHaveValue(2.25);
    expect(screen.getByLabelText("Maximum bout (minutes)")).toHaveValue(7.42);

    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    expect(await screen.findByText("Ready")).toBeInTheDocument();
    const active = (await repository.listRecords("walking_sessions")).find(
      (record) => record.status === "ACTIVE",
    );
    expect(active).toEqual(
      expect.objectContaining({ speed_kmh: 5.65, incline_pct: 2.25, max_bout_seconds: 445 }),
    );
  });

  it("says why Start is disabled, on the fields themselves", async () => {
    renderPad(freshRepository());

    const speed = await screen.findByLabelText("Speed (km/h)");
    fireEvent.change(speed, { target: { value: "" } });

    expect(speed).toBeInvalid();
    expect(speed).toHaveAccessibleDescription(
      "Enter a speed, an incline and a maximum bout to start.",
    );
    expect(screen.getByLabelText("Incline (%)")).toBeValid();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });
});

describe("PAD recovery from unreadable records", () => {
  it("offers a discard for an ACTIVE session row it cannot read", async () => {
    const actions: LocalAction[] = [];
    const broken: LocalRecord = {
      id: "session-broken",
      status: "ACTIVE",
      started_at: "not a date",
      created_at: "not a date either",
    };
    const repository = fakeRepository(
      () => snapshotOf({ walking_sessions: [broken] }),
      (action) => {
        actions.push(action);
        return Promise.resolve({ actionId: action.actionId, sequence: 1, committedAt: "2026-09-18T10:00:00.000Z" });
      },
    );
    renderPad(repository);

    // Without this screen the start button would render instead, and every tap on
    // it would be refused by the marker this unreadable row still holds.
    expect(await screen.findByRole("heading", { name: "Unreadable session" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard session" }));

    await waitFor(() => {
      expect(actions).toHaveLength(1);
    });
    expect(actions[0]?.changes[0]).toEqual({
      store: "walking_sessions",
      operation: "put",
      record: expect.objectContaining({ id: "session-broken", status: "DISCARDED" }) as unknown,
    });
  });

  it("frees the device to start again once the unreadable session is discarded", async () => {
    const repository = freshRepository();
    const settings = DEFAULT_WALKING_SETTINGS;
    await repository.commitAction(
      startWalkingSessionAction({
        actionId: "start-1",
        sessionId: "session-1",
        settings,
        now: new Date("2026-09-18T10:00:00.000Z"),
      }),
    );
    await expect(
      repository.commitAction(
        startWalkingSessionAction({
          actionId: "start-2",
          sessionId: "session-2",
          settings,
          now: new Date("2026-09-18T10:01:00.000Z"),
        }),
      ),
    ).rejects.toBeInstanceOf(ActiveSessionConflictError);

    await repository.commitAction(
      discardWalkingSessionAction({
        actionId: "discard-1",
        snapshot: await repository.readSnapshot(),
        sessionId: "session-1",
        now: new Date("2026-09-18T10:02:00.000Z"),
      }),
    );

    await repository.commitAction(
      startWalkingSessionAction({
        actionId: "start-3",
        sessionId: "session-3",
        settings,
        now: new Date("2026-09-18T10:03:00.000Z"),
      }),
    );
    const snapshot = await repository.readSnapshot();
    expect(snapshot.records.walking_sessions.map((record) => record.id)).toEqual(["session-3"]);
  });

  it("explains an open record the parser dropped, and finishes the session over it", async () => {
    const actions: LocalAction[] = [];
    const unreadableBout: LocalRecord = {
      id: "bout-unreadable",
      walking_session_id: "session-1",
      started_at: "not a date",
      created_at: "not a date either",
      ended_at: null,
    };
    const repository = fakeRepository(
      () => snapshotOf({ walking_sessions: [ACTIVE_SESSION], walking_bouts: [unreadableBout] }),
      (action) => {
        actions.push(action);
        return Promise.resolve({ actionId: action.actionId, sequence: 1, committedAt: "2026-09-18T10:00:00.000Z" });
      },
    );
    renderPad(repository);

    // "This change conflicts with newer saved data" is what Start walking would
    // say here, which explains nothing; the HUD says it plainly instead.
    expect(await screen.findByText(/cannot read, so it is not shown here/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Finish session" }));

    await waitFor(() => {
      expect(actions).toHaveLength(1);
    });
    expect(actions[0]?.changes[0]).toEqual({
      store: "walking_bouts",
      operation: "put",
      record: expect.objectContaining({ id: "bout-unreadable", ended_at: expect.any(String) as unknown }) as unknown,
    });
  });
});

describe("PAD-01 — lock-screen recovery", () => {
  it("shows the timestamp-derived duration after the clock moves on with no timer ticks", async () => {
    // Everything is faked here, so not a single interval callback is delivered
    // while the "phone" is locked -- exactly the condition a tick-accumulating
    // timer would fail.
    vi.useFakeTimers();
    const boutStartedAt = "2026-09-18T10:00:00.000Z";
    const repository = {
      readSnapshot: () =>
        Promise.resolve(
          snapshotOf({
            walking_sessions: [
              {
                id: "session-1",
                status: "ACTIVE",
                started_at: "2026-09-18T09:59:00.000Z",
                speed_kmh: 5,
                incline_pct: 2,
                max_bout_seconds: 480,
              },
            ],
            walking_bouts: [
              {
                id: "bout-1",
                walking_session_id: "session-1",
                bout_number: 1,
                started_at: boutStartedAt,
                ended_at: null,
              },
            ],
          }),
        ),
      listRecords: () => Promise.resolve([]),
      commitAction: vi.fn(),
      close: vi.fn(),
    } as unknown as LocalRepository;

    vi.setSystemTime(Date.parse(boutStartedAt) + 60_000);
    renderPad(repository);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("01:00")).toBeInTheDocument();

    // The phone is locked for five minutes: the clock moves, no ticks arrive, so
    // the display is knowingly stale.
    vi.setSystemTime(Date.parse(boutStartedAt) + 6 * 60_000);
    expect(screen.getByText("01:00")).toBeInTheDocument();

    // Unlock: the app becomes visible again and re-reads the clock.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    expect(screen.getByText("06:00")).toBeInTheDocument();
    expect(screen.queryByText("01:00")).not.toBeInTheDocument();
  });
});

describe("PAD-02 — application termination", () => {
  it("reconstructs the walking state and elapsed duration from persisted records alone", async () => {
    useFrozenClock("2026-09-18T10:00:00.000Z");
    const databaseName = `pad-termination-${crypto.randomUUID()}`;
    const before = repositoryOver(databaseName);
    const firstRender = renderPad(before);

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    vi.setSystemTime(Date.parse("2026-09-18T10:01:00.000Z"));
    fireEvent.click(await screen.findByRole("button", { name: "Start walking" }));
    await screen.findByText("Walking");

    // Terminate the process: unmount everything and drop the connection.
    firstRender.unmount();
    before.close();

    // Reopen six minutes later, over the same database, with a new connection and
    // a new provider -- nothing in memory survives. Six, not eight: an elapsed
    // time below the session's maximum keeps this about recovery alone, with no
    // help from a maximum that happens to be reached at the same moment.
    vi.setSystemTime(Date.parse("2026-09-18T10:07:00.000Z"));
    const after = repositoryOver(databaseName);
    const snapshot = await after.readSnapshot();

    expect(deriveActiveSessionSummaries(snapshot, Date.now())).toEqual([
      expect.objectContaining({
        title: "PAD Walking",
        status: "Walking · Bout 1",
        elapsedMs: 6 * 60_000,
        href: "/pad",
      }),
    ]);

    renderPad(after);

    expect(await screen.findByText("Walking")).toBeInTheDocument();
    expect(screen.getByText("Bout 1")).toBeInTheDocument();
    expect(screen.getByText("06:00")).toBeInTheDocument();
    expect(screen.queryByText(/Maximum reached/)).not.toBeInTheDocument();
    expect(screen.getByText("5.0 km/h · Incline 2.0% · Maximum bout 08:00")).toBeInTheDocument();
  });
});
