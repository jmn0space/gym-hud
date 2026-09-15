import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { createLocalRepository, type LocalRepository } from "./storage";

// StrictMode matches the dev entry point and double-invokes effects.
function renderApp(initialPath = "/", repository?: LocalRepository, authRepository?: LocalRepository) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[initialPath]}>
        <App repository={repository} authRepository={authRepository} />
      </MemoryRouter>
    </StrictMode>,
  );
}

// The auth gate starts on "checking" while the marker read and session check
// resolve, so callers must wait for the app shell (nav) to actually appear.
async function primaryNav() {
  return within(await screen.findByRole("navigation", { name: "Primary" }));
}

function stubAuthenticatedFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/session/")) {
        return Promise.resolve(Response.json({ authenticated: true, username: "tester" }));
      }
      return Promise.resolve(Response.json({ status: "ok", database: { connected: true } }));
    }),
  );
}

beforeEach(() => {
  stubAuthenticatedFetch();
});

describe("navigation smoke test", () => {
  it("starts on Home with an honest empty resume state", async () => {
    renderApp();

    expect(await screen.findByRole("heading", { level: 1, name: "Gym HUD" })).toBeInTheDocument();
    expect(await screen.findByText("No active session.")).toBeInTheDocument();
    expect(screen.getByText("No saved changes waiting to sync.")).toBeInTheDocument();
    expect((await primaryNav()).getByRole("link", { name: "Home" })).toHaveAttribute(
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

    await user.click((await primaryNav()).getByRole("link", { name: label }));

    const pageHeading = screen.getByRole("heading", { level: 1, name: heading });
    expect(screen.getByText(stateTitle)).toBeInTheDocument();
    expect((await primaryNav()).getByRole("link", { name: label })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect((await primaryNav()).getByRole("link", { name: "Home" })).not.toHaveAttribute(
      "aria-current",
    );
    await waitFor(() => {
      expect(pageHeading).toHaveFocus();
    });
    expect(document.title).toBe(`${heading} · Gym HUD`);
  });

  it("leaves focus alone on first load", async () => {
    renderApp("/pad");

    expect(await screen.findByRole("heading", { level: 1, name: "PAD walking" })).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it("returns Home from a domain screen", async () => {
    const user = userEvent.setup();
    renderApp("/history");

    await user.click((await primaryNav()).getByRole("link", { name: "Home" }));

    expect(screen.getByRole("heading", { level: 1, name: "Gym HUD" })).toBeInTheDocument();
  });

  it("opens a domain screen from the Home workout buttons", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("link", { name: "PAD walking" }));

    expect(screen.getByRole("heading", { level: 1, name: "PAD walking" })).toBeInTheDocument();
  });

  it("shows a not-found screen for unknown routes", async () => {
    renderApp("/nope");

    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
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

describe("authentication gate", () => {
  it("shows the sign-in screen instead of any app route when this device has never signed in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ authenticated: false, username: null }))),
    );
    const authRepository = createLocalRepository({
      databaseName: `gym-hud-auth-first-login-${crypto.randomUUID()}`,
    });

    renderApp("/", undefined, authRepository);

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();

    authRepository.close();
  });

  it("opens the app from local data when reopened offline with an existing marker (offline continuation)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    Object.defineProperty(window.navigator, "onLine", { configurable: true, value: false });
    const authRepository = createLocalRepository({
      databaseName: `gym-hud-auth-offline-reopen-${crypto.randomUUID()}`,
    });
    await authRepository.setAuthMarker({ username: "tester", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });

    try {
      renderApp("/", undefined, authRepository);

      expect(await screen.findByRole("heading", { level: 1, name: "Gym HUD" })).toBeInTheDocument();
      expect(await screen.findByText("No active session.")).toBeInTheDocument();
    } finally {
      authRepository.close();
      // Restore for later tests in this file, which assume the device is online.
      Object.defineProperty(window.navigator, "onLine", { configurable: true, value: true });
    }
  });

  it("shows a persistent expired-session banner and resumes on re-login", async () => {
    let sessionCallCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/login/")) {
          return Promise.resolve(Response.json({ authenticated: true, username: "tester" }));
        }
        if (url.includes("/auth/session/")) {
          sessionCallCount += 1;
          return Promise.resolve(Response.json({ authenticated: false, username: null }));
        }
        return Promise.resolve(Response.json({ status: "ok", database: { connected: true } }));
      }),
    );
    const authRepository = createLocalRepository({
      databaseName: `gym-hud-auth-expired-${crypto.randomUUID()}`,
    });
    await authRepository.setAuthMarker({ username: "tester", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });

    renderApp("/", undefined, authRepository);

    expect(await screen.findByText("Session expired — sign in to sync")).toBeInTheDocument();
    expect(sessionCallCount).toBeGreaterThan(0);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(screen.getByLabelText("Username"), "tester");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.queryByText("Session expired — sign in to sync")).not.toBeInTheDocument();
    });

    authRepository.close();
  });
});
