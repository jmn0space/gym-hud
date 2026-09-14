import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type {
  CommitReceipt,
  DomainStore,
  LocalAction,
  LocalRecord,
  LocalRepository,
  OutboxEntry,
  RecoverySnapshot,
} from "../storage";
vi.mock("../storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../storage")>();
  return { ...actual, createLocalRepository: vi.fn(actual.createLocalRepository) };
});

import { createLocalRepository } from "../storage";
import { LocalDataProvider, useLocalData } from "./LocalDataProvider";

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

function snapshot(pendingOutbox: OutboxEntry[] = []): RecoverySnapshot {
  const records = Object.fromEntries(stores.map((store) => [store, []])) as unknown as Record<
      DomainStore,
      LocalRecord[]
    >;
  return { records, pendingOutbox };
}

const action: LocalAction = {
  actionId: "action-1",
  changes: [
    {
      store: "walking_sessions",
      operation: "put",
      record: { id: "session-1", status: "ACTIVE", started_at: "2026-09-14T10:00:00.000Z" },
    },
  ],
};

const receipt: CommitReceipt = {
  actionId: action.actionId,
  sequence: 1,
  committedAt: "2026-09-14T10:00:01.000Z",
};

const outboxEntry: OutboxEntry = {
  version: 1,
  mutation_id: action.actionId,
  sequence: 1,
  created_at: receipt.committedAt,
  changes: [
    {
      store: "walking_sessions",
      entity_type: "walking_session",
      entity_id: "session-1",
      operation: "put",
      record: {
        id: "session-1",
        status: "ACTIVE",
        started_at: "2026-09-14T10:00:00.000Z",
      },
    },
  ],
};

function mockRepository(
  readSnapshot: LocalRepository["readSnapshot"],
  commitAction: LocalRepository["commitAction"],
): LocalRepository {
  return {
    readSnapshot,
    commitAction,
    close: vi.fn(),
  } as unknown as LocalRepository;
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function Probe() {
  const { commitAction, error, retry, snapshot: currentSnapshot, status } = useLocalData();
  const [lastReceipt, setLastReceipt] = useState<string>("");
  return (
    <>
      <output aria-label="Storage status">{status}</output>
      <output aria-label="Pending count">{currentSnapshot?.pendingOutbox.length ?? "unavailable"}</output>
      <output aria-label="Error kind">{error?.kind ?? "none"}</output>
      <output aria-label="Error message">{error?.message ?? "none"}</output>
      <output aria-label="Receipt">{lastReceipt}</output>
      <button
        type="button"
        onClick={() => {
          void commitAction(action)
            .then((result) => {
              setLastReceipt(result.actionId);
            })
            .catch(() => undefined);
        }}
      >
        Commit
      </button>
      <button type="button" onClick={() => void retry().catch(() => undefined)}>
        Retry
      </button>
    </>
  );
}

describe("LocalDataProvider", () => {
  it("publishes a new snapshot only after the transaction commits and the refresh completes", async () => {
    const commit = deferred<CommitReceipt>();
    const readSnapshot = vi
      .fn<LocalRepository["readSnapshot"]>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot([outboxEntry]));
    const repository = mockRepository(readSnapshot, vi.fn(() => commit.promise));
    const user = userEvent.setup();

    render(
      <LocalDataProvider repository={repository}>
        <Probe />
      </LocalDataProvider>,
    );
    await screen.findByText("ready", { selector: "output" });

    await user.click(screen.getByRole("button", { name: "Commit" }));
    expect(screen.getByLabelText("Storage status")).toHaveTextContent("saving");
    expect(screen.getByLabelText("Pending count")).toHaveTextContent("0");

    await act(async () => {
      commit.resolve(receipt);
      await commit.promise;
    });
    await waitFor(() => expect(screen.getByLabelText("Pending count")).toHaveTextContent("1"));
    expect(screen.getByLabelText("Storage status")).toHaveTextContent("ready");
    expect(screen.getByLabelText("Receipt")).toHaveTextContent(action.actionId);
  });

  it("retries a failed write with the same action ID", async () => {
    const commitAction = vi
      .fn<LocalRepository["commitAction"]>()
      .mockRejectedValueOnce(new Error("quota exceeded"))
      .mockResolvedValueOnce(receipt);
    const readSnapshot = vi
      .fn<LocalRepository["readSnapshot"]>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot([outboxEntry]));
    const repository = mockRepository(readSnapshot, commitAction);
    const user = userEvent.setup();

    render(
      <LocalDataProvider repository={repository}>
        <Probe />
      </LocalDataProvider>,
    );
    await screen.findByText("ready", { selector: "output" });
    await user.click(screen.getByRole("button", { name: "Commit" }));

    await screen.findByText("write", { selector: "output" });
    expect(screen.getByLabelText("Pending count")).toHaveTextContent("0");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByLabelText("Pending count")).toHaveTextContent("1"));
    expect(commitAction).toHaveBeenCalledTimes(2);
    expect(commitAction.mock.calls[0]?.[0].actionId).toBe(action.actionId);
    expect(commitAction.mock.calls[1]?.[0].actionId).toBe(action.actionId);
  });

  it("returns the commit receipt and reports an honest refresh error after a successful write", async () => {
    const readSnapshot = vi
      .fn<LocalRepository["readSnapshot"]>()
      .mockResolvedValueOnce(snapshot())
      .mockRejectedValueOnce(new Error("read failed"))
      .mockResolvedValueOnce(snapshot([outboxEntry]));
    const repository = mockRepository(readSnapshot, vi.fn(() => Promise.resolve(receipt)));
    const user = userEvent.setup();

    render(
      <LocalDataProvider repository={repository}>
        <Probe />
      </LocalDataProvider>,
    );
    await screen.findByText("ready", { selector: "output" });
    await user.click(screen.getByRole("button", { name: "Commit" }));

    await screen.findByText("refresh", { selector: "output" });
    expect(screen.getByLabelText("Error message")).toHaveTextContent(
      "Your change was saved, but the latest workout data could not be displayed.",
    );
    expect(screen.getByLabelText("Receipt")).toHaveTextContent(action.actionId);
    expect(screen.getByLabelText("Pending count")).toHaveTextContent("0");

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByLabelText("Pending count")).toHaveTextContent("1"));
  });

  it("keeps an initial read failure labelled as an open failure across retries", async () => {
    const readSnapshot = vi
      .fn<LocalRepository["readSnapshot"]>()
      .mockRejectedValueOnce(new Error("blocked"))
      .mockRejectedValueOnce(new Error("still blocked"))
      .mockResolvedValueOnce(snapshot());
    const repository = mockRepository(readSnapshot, vi.fn(() => Promise.resolve(receipt)));
    const user = userEvent.setup();

    render(
      <LocalDataProvider repository={repository}>
        <Probe />
      </LocalDataProvider>,
    );
    await screen.findByText("read", { selector: "output" });

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("read", { selector: "output" });
    expect(screen.getByLabelText("Error message")).toHaveTextContent(
      "Saved workout data could not be opened.",
    );

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("ready", { selector: "output" });
  });

  it("does not let a background refresh silently clear an unresolved write failure", async () => {
    const commitAction = vi
      .fn<LocalRepository["commitAction"]>()
      .mockRejectedValueOnce(new Error("quota exceeded"));
    const readSnapshot = vi
      .fn<LocalRepository["readSnapshot"]>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot());
    const repository = mockRepository(readSnapshot, commitAction);
    const user = userEvent.setup();

    render(
      <LocalDataProvider repository={repository}>
        <Probe />
      </LocalDataProvider>,
    );
    await screen.findByText("ready", { selector: "output" });
    await user.click(screen.getByRole("button", { name: "Commit" }));
    await screen.findByText("write", { selector: "output" });
    expect(readSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Storage status")).toHaveTextContent("error");
    expect(screen.getByLabelText("Error kind")).toHaveTextContent("write");
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight commit to finish before closing an owned repository on unmount", async () => {
    const commit = deferred<CommitReceipt>();
    const close = vi.fn();
    const readSnapshot = vi
      .fn<LocalRepository["readSnapshot"]>()
      .mockResolvedValueOnce(snapshot())
      .mockResolvedValueOnce(snapshot([outboxEntry]));
    const repository = {
      readSnapshot,
      commitAction: vi.fn(() => commit.promise),
      close,
    } as unknown as LocalRepository;
    vi.mocked(createLocalRepository).mockReturnValueOnce(repository);
    const user = userEvent.setup();

    const { unmount } = render(
      <LocalDataProvider>
        <Probe />
      </LocalDataProvider>,
    );
    await screen.findByText("ready", { selector: "output" });
    await user.click(screen.getByRole("button", { name: "Commit" }));
    expect(screen.getByLabelText("Storage status")).toHaveTextContent("saving");

    unmount();
    await Promise.resolve();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();

    await act(async () => {
      commit.resolve(receipt);
      await commit.promise;
    });
    await waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
  });
});
