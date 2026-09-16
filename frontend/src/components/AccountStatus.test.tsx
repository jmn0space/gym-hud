import { IDBFactory } from "fake-indexeddb";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AuthProvider } from "../auth/AuthProvider";
import { createLocalRepository, type LocalRepository } from "../storage";
import { AccountStatus } from "./AccountStatus";

let databaseNumber = 0;

function freshRepository(): LocalRepository {
  return createLocalRepository({
    databaseName: `account-status-test-${(databaseNumber++).toString()}`,
    indexedDB: new IDBFactory(),
  });
}

function stubAuthenticatedFetch(username = "juan") {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ authenticated: true, username }))));
}

async function renderSignedIn(repository: LocalRepository) {
  await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
  stubAuthenticatedFetch();
  render(
    <AuthProvider repository={repository}>
      <AccountStatus />
    </AuthProvider>,
  );
  return screen.findByRole("button", { name: "Sign out" });
}

describe("AccountStatus", () => {
  it("always opens a confirmation on Sign out, even with nothing pending (finding #12)", async () => {
    const repository = freshRepository();
    const user = userEvent.setup();
    const signOutButton = await renderSignedIn(repository);

    await user.click(signOutButton);

    expect(await screen.findByRole("alertdialog", { name: "Confirm sign out" })).toBeInTheDocument();
    // The compact trigger is gone while the confirmation is open.
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();

    repository.close();
  });

  it("uses a compact, non-full-width control for the everyday Sign out trigger (finding #12)", async () => {
    const repository = freshRepository();
    const signOutButton = await renderSignedIn(repository);

    expect(signOutButton.className).toContain("button--compact");

    repository.close();
  });

  it("moves focus into the confirmation when it opens, and describes it via aria-describedby (finding #10)", async () => {
    const repository = freshRepository();
    const user = userEvent.setup();
    const signOutButton = await renderSignedIn(repository);

    await user.click(signOutButton);

    const confirmButton = await screen.findByRole("button", { name: "Sign out anyway" });
    await waitFor(() => {
      expect(confirmButton).toHaveFocus();
    });

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-describedby");
    const describedBy = dialog.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    if (describedBy !== null) {
      expect(document.getElementById(describedBy)).not.toBeNull();
    }

    repository.close();
  });

  it("restores focus to the Sign out control when the confirmation is cancelled (finding #10)", async () => {
    const repository = freshRepository();
    const user = userEvent.setup();
    const signOutButton = await renderSignedIn(repository);

    await user.click(signOutButton);
    await screen.findByRole("button", { name: "Sign out anyway" });

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    const restoredButton = await screen.findByRole("button", { name: "Sign out" });
    await waitFor(() => {
      expect(restoredButton).toHaveFocus();
    });

    repository.close();
  });

  it("shows when the session was last verified while unverified (finding #13)", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });

    try {
      render(
        <AuthProvider repository={repository}>
          <AccountStatus />
        </AuthProvider>,
      );

      expect(await screen.findByText(/Last verified/)).toBeInTheDocument();
    } finally {
      Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
      repository.close();
    }
  });
});
