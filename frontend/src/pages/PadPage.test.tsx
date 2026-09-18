import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalDataStatus } from "../components/LocalDataStatus";
import { deriveActiveSessionSummaries } from "../local/activeSessions";
import { LocalDataProvider } from "../local/LocalDataProvider";
import { DEFAULT_WALKING_SETTINGS, startWalkingSessionAction } from "../pad";
import {
  ActiveSessionConflictError,
  createLocalRepository,
  type DomainStore,
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
    const repository = {
      readSnapshot: () => Promise.resolve(snapshotOf({})),
      listRecords: () => Promise.resolve([]),
      commitAction: () => Promise.reject(new ActiveSessionConflictError("already active")),
      close: vi.fn(),
    } as unknown as LocalRepository;
    renderPad(repository);

    fireEvent.click(await screen.findByRole("button", { name: "Start" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This change conflicts with newer saved data and was not saved.",
    );
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

    // Reopen eight minutes later, over the same database, with a new connection
    // and a new provider -- nothing in memory survives.
    vi.setSystemTime(Date.parse("2026-09-18T10:09:00.000Z"));
    const after = repositoryOver(databaseName);
    const snapshot = await after.readSnapshot();

    expect(deriveActiveSessionSummaries(snapshot, Date.now())).toEqual([
      expect.objectContaining({
        title: "PAD Walking",
        status: "Walking · Bout 1",
        elapsedMs: 8 * 60_000,
        href: "/pad",
      }),
    ]);

    renderPad(after);

    expect(await screen.findByText("Walking")).toBeInTheDocument();
    expect(screen.getByText("Bout 1")).toBeInTheDocument();
    expect(screen.getByText("08:00")).toBeInTheDocument();
    expect(screen.getByText("5.0 km/h · Incline 2.0% · Maximum bout 08:00")).toBeInTheDocument();
  });
});
