import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { createLocalRepository, type LocalRepository } from "./storage";

// StrictMode matches the dev entry point and double-invokes effects.
function renderApp(initialPath = "/", repository?: LocalRepository) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[initialPath]}>
        <App repository={repository} />
      </MemoryRouter>
    </StrictMode>,
  );
}

function primaryNav() {
  return within(screen.getByRole("navigation", { name: "Primary" }));
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(Response.json({ status: "ok", database: { connected: true } }))),
  );
});

describe("navigation smoke test", () => {
  it("starts on Home with an honest empty resume state", async () => {
    renderApp();

    expect(screen.getByRole("heading", { level: 1, name: "Gym HUD" })).toBeInTheDocument();
    expect(await screen.findByText("No active session.")).toBeInTheDocument();
    expect(screen.getByText("No saved changes waiting to sync.")).toBeInTheDocument();
    expect(primaryNav().getByRole("link", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await screen.findByText("Server online")).toBeInTheDocument();
  });

  it.each([
    ["PAD", "PAD walking", "Not available yet"],
    ["Resistance", "Resistance training", "Not available yet"],
    ["Cardio", "Cardio machines", "Not available yet"],
    ["History", "History", "No history yet"],
  ])("navigates to %s and shows its unavailable state", async (label, heading, stateTitle) => {
    const user = userEvent.setup();
    renderApp();

    await user.click(primaryNav().getByRole("link", { name: label }));

    const pageHeading = screen.getByRole("heading", { level: 1, name: heading });
    expect(screen.getByText(stateTitle)).toBeInTheDocument();
    expect(primaryNav().getByRole("link", { name: label })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(primaryNav().getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
    await waitFor(() => {
      expect(pageHeading).toHaveFocus();
    });
    expect(document.title).toBe(`${heading} · Gym HUD`);
  });

  it("leaves focus alone on first load", () => {
    renderApp("/pad");

    expect(screen.getByRole("heading", { level: 1, name: "PAD walking" })).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it("returns Home from a domain screen", async () => {
    const user = userEvent.setup();
    renderApp("/history");

    await user.click(primaryNav().getByRole("link", { name: "Home" }));

    expect(screen.getByRole("heading", { level: 1, name: "Gym HUD" })).toBeInTheDocument();
  });

  it("opens a domain screen from the Home workout buttons", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("link", { name: "PAD walking" }));

    expect(screen.getByRole("heading", { level: 1, name: "PAD walking" })).toBeInTheDocument();
  });

  it("shows a not-found screen for unknown routes", () => {
    renderApp("/nope");

    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Home" })).toHaveAttribute("href", "/");
  });

  it("recovers a paused PAD session and pending change from IndexedDB", async () => {
    const pauseStartedAt = new Date(Date.now() - 120_000).toISOString();
    const repository = createLocalRepository({
      databaseName: `gym-hud-app-recovery-${crypto.randomUUID()}`,
    });
    await repository.commitAction({
      actionId: crypto.randomUUID(),
      changes: [
        {
          store: "walking_sessions",
          operation: "put",
          record: {
            id: "session-1",
            status: "ACTIVE",
            started_at: new Date(Date.now() - 600_000).toISOString(),
          },
        },
        {
          store: "walking_bouts",
          operation: "put",
          record: {
            id: "bout-1",
            walking_session_id: "session-1",
            started_at: new Date(Date.now() - 480_000).toISOString(),
            ended_at: null,
          },
        },
        {
          store: "walking_pauses",
          operation: "put",
          record: {
            id: "pause-1",
            walking_bout_id: "bout-1",
            started_at: pauseStartedAt,
            ended_at: null,
          },
        },
      ],
    });

    const view = renderApp("/", repository);

    expect(await screen.findByRole("link", { name: "Resume PAD Walking" })).toHaveAttribute(
      "href",
      "/pad",
    );
    expect(screen.getByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("02:00")).toBeInTheDocument();
    expect(screen.getByText("1 saved change waiting to sync. Server sync is not available yet."))
      .toBeInTheDocument();

    view.unmount();
    repository.close();
  });

  it("shows a retryable open error without claiming there is no active session", async () => {
    const repository = {
      readSnapshot: vi.fn(() => Promise.reject(new Error("IndexedDB blocked"))),
      close: vi.fn(),
    } as unknown as LocalRepository;
    renderApp("/", repository);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Saved workout data could not be opened.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText("Saved sessions are unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("No active session.")).not.toBeInTheDocument();
  });
});
