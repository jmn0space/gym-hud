import { act, render, screen, waitFor, within } from "@testing-library/react";
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

/** A well-formed, empty bootstrap/changes pair so the sync engine settles
 * cleanly (no pending mutations, no dangling retry timers) instead of
 * treating this suite's unrelated `fetch` stub as a malformed response. */
function stubAuthenticatedFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/auth/session/")) {
        return Promise.resolve(Response.json({ authenticated: true, username: "tester" }));
      }
      if (url.includes("/sync/bootstrap/")) {
        return Promise.resolve(
          Response.json({
            cursor: 0,
            limits: { max_mutations_per_request: 50, max_changes_per_mutation: 500 },
            pad: {
              defaults: { speed_kmh: 5, incline_pct: 2, max_bout_seconds: 480 },
              next_session_settings: {
                source: "defaults",
                walking_session_id: null,
                speed_kmh: 5,
                incline_pct: 2,
                max_bout_seconds: 480,
              },
            },
          }),
        );
      }
      if (url.includes("/sync/changes/")) {
        return Promise.resolve(Response.json({ changes: [], cursor: 0, has_more: false }));
      }
      if (url.includes("/sync/mutations/")) {
        // Echoes back "applied" for whatever was actually sent, so the drain
        // settles instead of leaving a mutation queued against this stub.
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
        const mutations = Array.isArray((body as { mutations?: unknown }).mutations)
          ? ((body as { mutations: { mutation_id: string }[] }).mutations)
          : [];
        return Promise.resolve(
          Response.json({
            results: mutations.map((mutation) => ({ mutation_id: mutation.mutation_id, status: "applied" })),
          }),
        );
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

  it("navigates to PAD and offers the start screen", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click((await primaryNav()).getByRole("link", { name: "PAD" }));

    const pageHeading = screen.getByRole("heading", { level: 1, name: "PAD walking" });
    expect(await screen.findByLabelText("Speed (km/h)")).toHaveValue(5);
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
    expect((await primaryNav()).getByRole("link", { name: "PAD" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await waitFor(() => {
      expect(pageHeading).toHaveFocus();
    });
    expect(document.title).toBe("PAD walking · Gym HUD");
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

  it("walks Home → Start PAD → Start walking → Home and offers a Resume card", async () => {
    const user = userEvent.setup();
    const repository = createLocalRepository({
      databaseName: `gym-hud-pad-end-to-end-${crypto.randomUUID()}`,
    });
    renderApp("/", repository);

    await user.click(await screen.findByRole("link", { name: "PAD walking" }));
    await user.click(await screen.findByRole("button", { name: "Start" }));
    await user.click(await screen.findByRole("button", { name: "Start walking" }));
    expect(await screen.findByText("Walking")).toBeInTheDocument();

    await user.click((await primaryNav()).getByRole("link", { name: "Home" }));

    expect(await screen.findByText("Walking · Bout 1")).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Resume PAD Walking" }));
    expect(await screen.findByText("Bout 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Finish session" })).toBeInTheDocument();

    repository.close();
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
    expect(screen.getByText("Paused · Bout 1")).toBeInTheDocument();
    expect(screen.getByText("02:00")).toBeInTheDocument();
    // Was "...Server sync is not available yet." before issue #20 built the
    // client sync engine; that claim is no longer true, so the copy (and this
    // assertion) dropped it.
    expect(screen.getByText("1 saved change waiting to sync.")).toBeInTheDocument();

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

    // The banner is persistent: it must still be there after navigating to
    // another screen, not just on the one it first appeared on (finding #14).
    const user = userEvent.setup();
    await user.click((await primaryNav()).getByRole("link", { name: "History" }));
    expect(await screen.findByRole("heading", { level: 1, name: "History" })).toBeInTheDocument();
    expect(screen.getByText("Session expired — sign in to sync")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(screen.getByLabelText("Username"), "tester");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.queryByText("Session expired — sign in to sync")).not.toBeInTheDocument();
    });

    authRepository.close();
  });

  it("recovers automatically once the network returns after a genuinely-online check failure, not just navigator.onLine=false (finding #14)", async () => {
    let sessionCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/session/")) {
          sessionCalls += 1;
          return sessionCalls === 1
            ? Promise.reject(new TypeError("Failed to fetch"))
            : Promise.resolve(Response.json({ authenticated: true, username: "tester" }));
        }
        return Promise.resolve(Response.json({ status: "ok", database: { connected: true } }));
      }),
    );
    const authRepository = createLocalRepository({
      databaseName: `gym-hud-auth-online-recovery-${crypto.randomUUID()}`,
    });
    await authRepository.setAuthMarker({ username: "tester", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });

    renderApp("/", undefined, authRepository);

    // navigator.onLine is true the whole time here (unlike the offline test
    // above) -- the check itself failed over what is genuinely an online
    // connection, and the app must still open from local data.
    expect(await screen.findByRole("heading", { level: 1, name: "Gym HUD" })).toBeInTheDocument();
    expect(await screen.findByText(/Last verified/)).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => {
      expect(screen.queryByText(/Last verified/)).not.toBeInTheDocument();
    });
    expect(screen.getByText("tester")).toBeInTheDocument();
    authRepository.close();
  });

  it("shows Server unreachable with the sign-in form reachable when the startup check hits a 5xx (finding #1)", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("<html>Bad Gateway</html>", { status: 502 }))));
    const authRepository = createLocalRepository({
      databaseName: `gym-hud-auth-5xx-${crypto.randomUUID()}`,
    });

    renderApp("/", undefined, authRepository);

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("Server unreachable")).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    authRepository.close();
  });

  it("still opens the app, usable but unverified, when the local auth marker is corrupted/unreadable (finding #7)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(Response.json({ authenticated: false, username: null }))),
    );
    const authRepository = createLocalRepository({
      databaseName: `gym-hud-auth-corrupt-marker-${crypto.randomUUID()}`,
    });
    vi.spyOn(authRepository, "getAuthMarker").mockRejectedValue(new Error("corrupt marker"));

    renderApp("/", undefined, authRepository);

    expect(await screen.findByRole("heading", { level: 1, name: "Gym HUD" })).toBeInTheDocument();
    expect(await screen.findByText("No active session.")).toBeInTheDocument();
    authRepository.close();
  });

  it("blocks signing in as a different user after logging out with pending entries still on the device (finding #2)", async () => {
    let sessionAuthenticated = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/logout/")) {
          sessionAuthenticated = false;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url.includes("/auth/login/")) {
          sessionAuthenticated = true;
          return Promise.resolve(Response.json({ authenticated: true, username: "juan" }));
        }
        if (url.includes("/auth/session/")) {
          return Promise.resolve(
            Response.json({ authenticated: sessionAuthenticated, username: sessionAuthenticated ? "juan" : null }),
          );
        }
        return Promise.resolve(Response.json({ status: "ok", database: { connected: true } }));
      }),
    );
    // A single repository shared by both providers (no separate
    // `authRepository`) so App.tsx's finding-#19 fix is exercised too: the
    // logout confirmation and different-user guard must see the same
    // outbox as the one the pending action below is committed to.
    const repository = createLocalRepository({ databaseName: `gym-hud-shared-owner-${crypto.randomUUID()}` });
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    await repository.setOutboxOwner({ username: "juan" });
    await repository.commitAction({
      actionId: "pending-workout",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } }],
    });

    renderApp("/", repository);

    expect(await screen.findByRole("heading", { level: 1, name: "Gym HUD" })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Sign out" }));
    await user.click(await screen.findByRole("button", { name: "Sign out anyway" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();

    await user.type(screen.getByLabelText("Username"), "someone-else");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/unsynced workouts for "juan"/);
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    repository.close();
  });
});

describe("sync engine (issue #20)", () => {
  it("drains a pending mutation through the real sync engine once authenticated and online", async () => {
    const repository = createLocalRepository({
      databaseName: `gym-hud-sync-drain-${crypto.randomUUID()}`,
    });
    await repository.commitAction({
      actionId: "pending-drain",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } }],
    });

    const view = renderApp("/", repository);

    expect(await screen.findByText("All changes synced")).toBeInTheDocument();
    await waitFor(async () => {
      await expect(repository.listPendingOutbox()).resolves.toEqual([]);
    });

    view.unmount();
    repository.close();
  });

  it("shows the rejection banner when the server permanently rejects a mutation, and keeps the data on the device", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/session/")) {
          return Promise.resolve(Response.json({ authenticated: true, username: "tester" }));
        }
        if (url.includes("/sync/bootstrap/")) {
          return Promise.resolve(
            Response.json({
              cursor: 0,
              limits: { max_mutations_per_request: 50, max_changes_per_mutation: 500 },
              pad: {
                defaults: { speed_kmh: 5, incline_pct: 2, max_bout_seconds: 480 },
                next_session_settings: {
                  source: "defaults",
                  walking_session_id: null,
                  speed_kmh: 5,
                  incline_pct: 2,
                  max_bout_seconds: 480,
                },
              },
            }),
          );
        }
        if (url.includes("/sync/changes/")) {
          return Promise.resolve(Response.json({ changes: [], cursor: 0, has_more: false }));
        }
        if (url.includes("/sync/mutations/")) {
          const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : {};
          const mutations = Array.isArray((body as { mutations?: unknown }).mutations)
            ? ((body as { mutations: { mutation_id: string }[] }).mutations)
            : [];
          return Promise.resolve(
            Response.json({
              results: mutations.map((mutation) => ({
                mutation_id: mutation.mutation_id,
                status: "rejected",
                code: "invalid_record",
                retryable: false,
                detail: "exercise-1 is unusable",
              })),
            }),
          );
        }
        return Promise.resolve(Response.json({ status: "ok", database: { connected: true } }));
      }),
    );

    const repository = createLocalRepository({
      databaseName: `gym-hud-sync-rejected-${crypto.randomUUID()}`,
    });
    await repository.commitAction({
      actionId: "will-be-rejected",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } }],
    });

    const view = renderApp("/", repository);

    expect(await screen.findByText(/could not be saved to your account/)).toBeInTheDocument();
    expect(await screen.findByText("exercise-1 is unusable")).toBeInTheDocument();
    await expect(repository.getRecord("exercise_registry", "exercise-1")).resolves.toMatchObject({
      id: "exercise-1",
    });

    view.unmount();
    repository.close();
  });
});
