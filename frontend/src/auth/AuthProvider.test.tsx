import { IDBFactory } from "fake-indexeddb";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../api/client";
import { createLocalRepository, type LocalRepository } from "../storage";
import { AuthProvider, useAuth, type LogoutOutcome } from "./AuthProvider";
import { LoginForm } from "./LoginForm";

let databaseNumber = 0;
const openRepositories: LocalRepository[] = [];

function freshRepository(): LocalRepository {
  const repo = createLocalRepository({
    databaseName: `auth-provider-test-${(databaseNumber++).toString()}`,
    indexedDB: new IDBFactory(),
  });
  openRepositories.push(repo);
  return repo;
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: online });
}

function stubFetch(implementation: (url: string) => Promise<Response> | Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(implementation(url));
    }),
  );
}

function anonymousSession() {
  return Response.json({ authenticated: false, username: null });
}

function authenticatedSession(username = "juan") {
  return Response.json({ authenticated: true, username });
}

function Probe() {
  const auth = useAuth();
  return (
    <dl>
      <dt>status</dt>
      <dd data-testid="status">{auth.status}</dd>
      <dt>username</dt>
      <dd data-testid="username">{auth.username ?? ""}</dd>
      <dt>firstLoginNeedsNetwork</dt>
      <dd data-testid="firstLoginNeedsNetwork">{auth.firstLoginNeedsNetwork ? "yes" : "no"}</dd>
    </dl>
  );
}

function LogoutControls() {
  const auth = useAuth();
  const [outcome, setOutcome] = useState<LogoutOutcome | null>(null);
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          void auth.logout().then(setOutcome);
        }}
      >
        Sign out
      </button>
      <button
        type="button"
        onClick={() => {
          void auth.logout(true).then(setOutcome);
        }}
      >
        Sign out anyway
      </button>
      <p data-testid="logout-outcome">{outcome === null ? "" : JSON.stringify(outcome)}</p>
    </div>
  );
}

afterEach(() => {
  for (const repo of openRepositories.splice(0)) {
    repo.close();
  }
  setOnline(true);
});

describe("AuthProvider startup verification", () => {
  it("shows the first-login screen (no marker, online, server anonymous)", async () => {
    stubFetch(() => anonymousSession());
    render(
      <AuthProvider repository={freshRepository()}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("login-required");
    });
    expect(screen.getByTestId("firstLoginNeedsNetwork")).toHaveTextContent("no");
  });

  it("explains network is required for first sign-in when offline with no marker", async () => {
    setOnline(false);
    stubFetch(() => anonymousSession());
    render(
      <AuthProvider repository={freshRepository()}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("login-required");
    });
    expect(screen.getByTestId("firstLoginNeedsNetwork")).toHaveTextContent("yes");
  });

  it("opens normally (unverified) when reopened offline with an existing marker", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    setOnline(false);
    stubFetch(() => anonymousSession());

    render(
      <AuthProvider repository={repository}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("unverified");
    });
    expect(screen.getByTestId("username")).toHaveTextContent("juan");
  });

  it("refreshes the marker and reports authenticated when the server confirms the session", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    stubFetch(() => authenticatedSession("juan"));

    render(
      <AuthProvider repository={repository}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });
    const marker = await repository.getAuthMarker();
    expect(marker?.lastVerifiedAt).not.toBe("2026-09-01T00:00:00.000Z");
  });

  it("moves to expired when a marker exists but the server reports no session (never clearing the marker)", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    stubFetch(() => anonymousSession());

    render(
      <AuthProvider repository={repository}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("expired");
    });
    await expect(repository.getAuthMarker()).resolves.toMatchObject({ username: "juan" });
  });
});

describe("AuthProvider 401 handling", () => {
  it("flips authenticated -> expired on any apiFetch 401, leaving the outbox untouched", async () => {
    const repository = freshRepository();
    await repository.commitAction({
      actionId: "pending-workout",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } },
      ],
    });
    stubFetch(() => authenticatedSession("juan"));

    render(
      <AuthProvider repository={repository}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });

    const outboxBefore = await repository.listPendingOutbox();
    expect(outboxBefore).toHaveLength(1);

    // Simulates any protected API call elsewhere in the app receiving a 401;
    // apiFetch's central 401 handling is what notifies AuthProvider.
    stubFetch(() => Response.json({ code: "not_authenticated" }, { status: 401 }));
    await expect(apiFetch("/api/v1/some-protected-endpoint/")).rejects.toMatchObject({
      code: "not_authenticated",
    });

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("expired");
    });
    const outboxAfter = await repository.listPendingOutbox();
    expect(outboxAfter).toEqual(outboxBefore);
  });
});

describe("AuthProvider login", () => {
  it("logs in, stores only a non-secret marker, and never touches localStorage", async () => {
    stubFetch((url) => (url.includes("/auth/session/") ? anonymousSession() : authenticatedSession("juan")));
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    render(
      <AuthProvider repository={freshRepository()}>
        <Probe />
        <LoginForm />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("login-required");
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "juan");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });
    expect(screen.getByTestId("username")).toHaveTextContent("juan");
    expect(setItemSpy).not.toHaveBeenCalled();

    setItemSpy.mockRestore();
  });

  it("shows an error for invalid credentials without changing status", async () => {
    stubFetch((url) =>
      url.includes("/auth/login/")
        ? Response.json({ code: "invalid_credentials", detail: "bad" }, { status: 400 })
        : anonymousSession(),
    );

    render(
      <AuthProvider repository={freshRepository()}>
        <Probe />
        <LoginForm />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("login-required");
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "juan");
    await user.type(screen.getByLabelText("Password"), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect username or password.");
    expect(screen.getByTestId("status")).toHaveTextContent("login-required");
  });

  it("blocks signing in as a different user while pending outbox entries exist", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    await repository.commitAction({
      actionId: "pending-workout",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } },
      ],
    });
    stubFetch(() => anonymousSession());

    render(
      <AuthProvider repository={repository}>
        <Probe />
        <LoginForm />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("expired");
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "someone-else");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/unsynced workouts for "juan"/);
    expect(screen.getByTestId("status")).toHaveTextContent("expired");
    await expect(repository.getAuthMarker()).resolves.toMatchObject({ username: "juan" });
  });
});

describe("AuthProvider logout", () => {
  it("requires a network connection", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    setOnline(false);
    stubFetch(() => anonymousSession());

    render(
      <AuthProvider repository={repository}>
        <Probe />
        <LogoutControls />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("unverified");
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(screen.getByTestId("logout-outcome")).toHaveTextContent('"reason":"offline"');
    });
  });

  it("asks for confirmation when pending outbox entries exist, then clears only the marker on confirm", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    await repository.commitAction({
      actionId: "pending-workout",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } },
      ],
    });
    stubFetch((url) => (url.includes("/auth/logout/") ? new Response(null, { status: 204 }) : authenticatedSession("juan")));

    render(
      <AuthProvider repository={repository}>
        <Probe />
        <LogoutControls />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => {
      expect(screen.getByTestId("logout-outcome")).toHaveTextContent('"reason":"confirm"');
    });
    expect(screen.getByTestId("logout-outcome")).toHaveTextContent('"pendingCount":1');
    // Not yet signed out: neither the marker nor the session changed.
    expect(screen.getByTestId("status")).toHaveTextContent("authenticated");

    await user.click(screen.getByRole("button", { name: "Sign out anyway" }));
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("login-required");
    });
    await expect(repository.getAuthMarker()).resolves.toBeUndefined();
    // Local data and the outbox are retained, not discarded, by sign-out.
    await expect(repository.listRecords("exercise_registry")).resolves.toEqual([
      expect.objectContaining({ id: "exercise-1" }),
    ]);
    await expect(repository.listPendingOutbox()).resolves.toHaveLength(1);
  });

  it("clears the marker directly when there is nothing pending", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    stubFetch((url) => (url.includes("/auth/logout/") ? new Response(null, { status: 204 }) : authenticatedSession("juan")));

    render(
      <AuthProvider repository={repository}>
        <Probe />
        <LogoutControls />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("login-required");
    });
    await expect(repository.getAuthMarker()).resolves.toBeUndefined();
  });
});
