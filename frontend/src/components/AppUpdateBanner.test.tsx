import { IDBFactory } from "fake-indexeddb";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalDataProvider } from "../local/LocalDataProvider";
import type { ServiceWorkerUpdates } from "../pwa/registerServiceWorker";
import { createLocalRepository, type LocalAction, type LocalRepository } from "../storage";
import { AppUpdateBanner } from "./AppUpdateBanner";

let databaseNumber = 0;
const openRepositories: LocalRepository[] = [];

afterEach(() => {
  for (const repository of openRepositories.splice(0)) {
    repository.close();
  }
});

function freshRepository(): LocalRepository {
  const repository = createLocalRepository({
    databaseName: `app-update-banner-${(databaseNumber++).toString()}`,
    indexedDB: new IDBFactory(),
    uuid: () => "client-uuid",
  });
  openRepositories.push(repository);
  return repository;
}

/** A stand-in for the module-level registration; nothing here touches navigator. */
function fakeUpdates(updateReady: boolean): ServiceWorkerUpdates & { applyUpdate: ReturnType<typeof vi.fn> } {
  const applyUpdate = vi.fn();
  return {
    subscribe: () => () => undefined,
    isUpdateReady: () => updateReady,
    applyUpdate,
    register: () => Promise.resolve(null),
  };
}

const START_PAD: LocalAction = {
  actionId: "start-pad",
  changes: [
    {
      store: "walking_sessions",
      operation: "put",
      record: { id: "pad-1", status: "ACTIVE", started_at: "2026-09-16T09:00:00.000Z" },
    },
  ],
};

async function renderBanner(repository: LocalRepository, updates: ServiceWorkerUpdates) {
  render(
    <LocalDataProvider repository={repository}>
      <AppUpdateBanner updates={updates} />
    </LocalDataProvider>,
  );
  // The provider starts with a null snapshot; wait for the first read to land so the
  // safety gate is deciding on real data rather than on "unknown".
  await waitFor(() => {
    expect(screen.queryByText("Loading saved workout data…")).not.toBeInTheDocument();
  });
}

describe("AppUpdateBanner", () => {
  it("renders nothing until a newer worker is waiting", async () => {
    const updates = fakeUpdates(false);
    await renderBanner(freshRepository(), updates);

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(updates.applyUpdate).not.toHaveBeenCalled();
  });

  it("applies the update when there is no active session and nothing pending", async () => {
    const updates = fakeUpdates(true);
    const user = userEvent.setup();
    await renderBanner(freshRepository(), updates);

    expect(await screen.findByText("A new version of Gym HUD is ready.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Update now" }));

    await waitFor(() => {
      expect(updates.applyUpdate).toHaveBeenCalledTimes(1);
    });
  });

  it("does not apply the update while a session is active", async () => {
    const repository = freshRepository();
    await repository.commitAction(START_PAD);
    // Sync has already drained the queue: the active session alone must block.
    await repository.acknowledgeOutbox(START_PAD.actionId);

    const updates = fakeUpdates(true);
    const user = userEvent.setup();
    await renderBanner(repository, updates);

    await user.click(await screen.findByRole("button", { name: "Update now" }));

    expect(
      await screen.findByText(
        "Gym HUD will update as soon as your current session is finished and your changes are saved.",
      ),
    ).toBeInTheDocument();
    expect(updates.applyUpdate).not.toHaveBeenCalled();
  });

  it("does not apply the update while the outbox still has pending entries", async () => {
    const repository = freshRepository();
    // A reference-data write: nothing is active, but the mutation is unsynchronised.
    await repository.commitAction({
      actionId: "record-working-weight",
      changes: [
        {
          store: "exercise_registry",
          operation: "put",
          record: { id: "back-squat", working_weight: 60 },
        },
      ],
    });

    const updates = fakeUpdates(true);
    const user = userEvent.setup();
    await renderBanner(repository, updates);

    await user.click(await screen.findByRole("button", { name: "Update now" }));

    expect(
      await screen.findByText(
        "Gym HUD will update as soon as your current session is finished and your changes are saved.",
      ),
    ).toBeInTheDocument();
    expect(updates.applyUpdate).not.toHaveBeenCalled();
  });

  it("re-reads the outbox instead of trusting a stale snapshot", async () => {
    const repository = freshRepository();
    const stale: LocalRepository = {
      ...repository,
      // The snapshot says the queue is empty; the live queue says otherwise.
      listPendingOutbox: () =>
        Promise.resolve([
          { version: 1, mutation_id: "in-flight", sequence: 1, created_at: "2026-09-16T09:00:00.000Z", changes: [] },
        ]),
    };

    const updates = fakeUpdates(true);
    const user = userEvent.setup();
    await renderBanner(stale, updates);

    await user.click(await screen.findByRole("button", { name: "Update now" }));

    expect(
      await screen.findByText(
        "Gym HUD will update as soon as your current session is finished and your changes are saved.",
      ),
    ).toBeInTheDocument();
    expect(updates.applyUpdate).not.toHaveBeenCalled();
  });

  it("refuses to apply the update when another tab's live session is invisible to this tab's cached snapshot", async () => {
    // Two independent `createLocalRepository` connections to the *same* database,
    // simulating two open tabs the way `upgradeContinuity.test.ts` does for schema
    // upgrades.
    const sharedIndexedDB = new IDBFactory();
    const databaseName = `app-update-banner-shared-${(databaseNumber++).toString()}`;
    const tabA = createLocalRepository({
      databaseName,
      indexedDB: sharedIndexedDB,
      uuid: () => "tab-a",
    });
    const tabB = createLocalRepository({
      databaseName,
      indexedDB: sharedIndexedDB,
      uuid: () => "tab-b",
    });
    openRepositories.push(tabA, tabB);

    const updates = fakeUpdates(true);
    const user = userEvent.setup();
    // Tab A renders first, against an empty database: its cached snapshot has no
    // active session and an empty outbox.
    await renderBanner(tabA, updates);

    // Tab B starts a session on its own connection and the mutation is immediately
    // acknowledged, exactly as if sync had already drained it -- so the outbox is
    // empty by the time Tab A looks, and only the active session distinguishes this
    // from "nothing is happening".
    await tabB.commitAction(START_PAD);
    await tabB.acknowledgeOutbox(START_PAD.actionId);

    // Tab A never received a `focus`/`visibilitychange` event, so its cached
    // `snapshot` still shows no active session. Clicking "Update now" must still
    // see Tab B's live session by re-reading the database at decision time, not by
    // trusting that stale cache.
    await user.click(await screen.findByRole("button", { name: "Update now" }));

    expect(
      await screen.findByText(
        "Gym HUD will update as soon as your current session is finished and your changes are saved.",
      ),
    ).toBeInTheDocument();
    expect(updates.applyUpdate).not.toHaveBeenCalled();
  });

  it("keeps its promise and applies the deferred update once the session is finished", async () => {
    const repository = freshRepository();
    await repository.commitAction(START_PAD);
    await repository.acknowledgeOutbox(START_PAD.actionId);

    const updates = fakeUpdates(true);
    const user = userEvent.setup();
    await renderBanner(repository, updates);
    await user.click(await screen.findByRole("button", { name: "Update now" }));
    expect(updates.applyUpdate).not.toHaveBeenCalled();

    await repository.commitAction({
      actionId: "finish-pad",
      changes: [
        {
          store: "walking_sessions",
          operation: "put",
          record: { id: "pad-1", status: "ENDED", ended_at: "2026-09-16T09:30:00.000Z" },
        },
      ],
    });
    await repository.acknowledgeOutbox("finish-pad");
    // The provider re-reads its snapshot when the window regains focus.
    fireEvent(window, new Event("focus"));

    await waitFor(() => {
      expect(updates.applyUpdate).toHaveBeenCalledTimes(1);
    });
  });
});
