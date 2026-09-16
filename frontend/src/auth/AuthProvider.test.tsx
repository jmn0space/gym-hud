import { IDBFactory } from "fake-indexeddb";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../api/client";
import {
  createLocalRepository,
  DATABASE_STORES,
  StorageCorruptionError,
  type AuthMarker,
  type LocalRepository,
} from "../storage";
import { AccountMismatchBanner } from "./AccountMismatchBanner";
import { AuthProvider, useAuth, type LogoutOutcome } from "./AuthProvider";
import { LoginForm } from "./LoginForm";
import { LoginPage } from "./LoginPage";
import { StorageWarningBanner } from "./StorageWarningBanner";

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

/**
 * A dependency-free repository double for tests that only care about auth
 * bookkeeping (marker/owner/outbox) and want deterministic, instantly-settling
 * promises -- in particular the fake-timer tests below, where a real
 * fake-indexeddb round trip would add its own scheduling to reason about.
 */
function instantRepository(marker: AuthMarker | undefined): LocalRepository {
  let currentMarker = marker;
  return {
    commitAction: () => Promise.reject(new Error("not implemented")),
    readSnapshot: () => Promise.reject(new Error("not implemented")),
    getRecord: () => Promise.resolve(undefined),
    listRecords: () => Promise.resolve([]),
    listPendingOutbox: () => Promise.resolve([]),
    acknowledgeOutbox: () => Promise.resolve(),
    getSyncMetadata: () => Promise.resolve(undefined),
    setSyncMetadata: () => Promise.resolve(),
    readReferenceCache: () => Promise.resolve(undefined),
    writeReferenceCache: () => Promise.resolve(),
    getAuthMarker: () => Promise.resolve(currentMarker),
    setAuthMarker: (next) => {
      currentMarker = next;
      return Promise.resolve();
    },
    clearAuthMarker: () => {
      currentMarker = undefined;
      return Promise.resolve();
    },
    getOutboxOwner: () => Promise.resolve(undefined),
    setOutboxOwner: () => Promise.resolve(),
    close: () => undefined,
  };
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, value: online });
}

function stubFetch(implementation: (url: string, init?: RequestInit) => Promise<Response> | Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      return Promise.resolve(implementation(url, init));
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
      <dt>online</dt>
      <dd data-testid="online">{auth.online ? "yes" : "no"}</dd>
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
    expect(screen.getByTestId("online")).toHaveTextContent("yes");
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
    expect(screen.getByTestId("online")).toHaveTextContent("no");
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

  it("retries an unreadable marker once, then opens unverified with an unknown user rather than locking the device out (finding #7)", async () => {
    const repository = freshRepository();
    await repository.commitAction({
      actionId: "pending-workout",
      changes: [{ store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } }],
    });
    const spy = vi.spyOn(repository, "getAuthMarker").mockRejectedValue(new StorageCorruptionError("bad marker"));
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
    expect(screen.getByTestId("username")).toHaveTextContent("");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("also opens unverified with an unknown user when the marker is unreadable while online and the server reports anonymous (finding #7)", async () => {
    const repository = freshRepository();
    vi.spyOn(repository, "getAuthMarker").mockRejectedValue(new StorageCorruptionError("bad marker"));
    stubFetch(() => anonymousSession());

    render(
      <AuthProvider repository={repository}>
        <Probe />
      </AuthProvider>,
    );

    // A decisive "anonymous" answer is no more trustworthy than the marker
    // read that already failed -- it must not be treated as proof this
    // device never signed in (which would render as "login-required" and
    // hide local data behind a sign-in screen it does not actually need).
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("unverified");
    });
    expect(screen.getByTestId("username")).toHaveTextContent("");
  });

  it("renders an existing marker as unverified immediately, without waiting on a hung network check (finding #3)", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    stubFetch(() => new Promise<Response>(() => undefined));

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

  it("aborts a session check that never resolves after ~5s and treats it as connectivity ambiguity (finding #3)", async () => {
    vi.useFakeTimers();
    const repository = instantRepository(undefined);
    let aborted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        });
      }),
    );

    render(
      <AuthProvider repository={repository}>
        <Probe />
      </AuthProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(aborted).toBe(true);
    expect(screen.getByTestId("status")).toHaveTextContent("server-unreachable");
  });
});

describe("AuthProvider first-login and server-unreachable screens (finding #1)", () => {
  it("shows Network required with no form while offline, and recovers on its own once connectivity returns", async () => {
    setOnline(false);
    const fetchMock = vi.fn(() => Promise.resolve(anonymousSession()));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AuthProvider repository={freshRepository()}>
        <LoginPage />
      </AuthProvider>,
    );

    expect(await screen.findByText("Network required")).toBeInTheDocument();
    expect(screen.queryByLabelText("Username")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });

    expect(await screen.findByLabelText("Username")).toBeInTheDocument();
    expect(screen.queryByText("Network required")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("shows Server unreachable with the sign-in form still reachable, and Retry re-checks", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        return Promise.resolve(calls === 1 ? new Response("<html>502</html>", { status: 502 }) : anonymousSession());
      }),
    );

    render(
      <AuthProvider repository={freshRepository()}>
        <LoginPage />
      </AuthProvider>,
    );

    expect(await screen.findByText("Server unreachable")).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.queryByText("Server unreachable")).not.toBeInTheDocument();
    });
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("AuthProvider background re-checking (finding #4)", () => {
  it("re-checks on focus/visibilitychange while unverified and recovers once the server responds", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    let calls = 0;
    stubFetch(() => {
      calls += 1;
      return calls === 1 ? new Response("x", { status: 502 }) : authenticatedSession("juan");
    });

    render(
      <AuthProvider repository={repository}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("unverified");
    });

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("queues a follow-up check when 'online' fires while a check is already in flight, instead of dropping it", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    let rejectFirst: ((error: unknown) => void) | undefined;
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          return new Promise<Response>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        return Promise.resolve(authenticatedSession("juan"));
      }),
    );

    render(
      <AuthProvider repository={repository}>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("unverified");
    });
    await waitFor(() => {
      expect(rejectFirst).toBeDefined();
    });

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    act(() => {
      rejectFirst?.(new TypeError("Failed to fetch"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });
    expect(calls).toBe(2);
  });

  it("retries a connectivity failure with exponential backoff while online, doubling up to the cap", async () => {
    vi.useFakeTimers();
    const repository = instantRepository({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        calls += 1;
        return Promise.reject(new TypeError("Failed to fetch"));
      }),
    );

    render(
      <AuthProvider repository={repository}>
        <Probe />
      </AuthProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(calls).toBe(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(calls).toBe(4);
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

  it("also flips unverified -> expired on a 401 from any apiFetch call (finding #17)", async () => {
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

    setOnline(true);
    stubFetch(() => Response.json({ code: "not_authenticated" }, { status: 401 }));
    await expect(apiFetch("/api/v1/some-protected-endpoint/")).rejects.toMatchObject({
      code: "not_authenticated",
    });

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("expired");
    });
  });

  it("ignores a stale 401 whose request predates a newer login, instead of resurrecting it as expired (finding #17)", async () => {
    const repository = freshRepository();
    let resolveProtected: ((response: Response) => void) | undefined;
    stubFetch((url) => {
      if (url.includes("/some-protected-endpoint/")) {
        return new Promise<Response>((resolve) => {
          resolveProtected = resolve;
        });
      }
      if (url.includes("/auth/login/")) {
        return authenticatedSession("juan");
      }
      return anonymousSession();
    });

    render(
      <AuthProvider repository={repository}>
        <Probe />
        <LoginForm />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("login-required");
    });

    const stalePending = apiFetch("/api/v1/some-protected-endpoint/").catch((error: unknown) => error);
    await waitFor(() => {
      expect(resolveProtected).toBeDefined();
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "juan");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });

    await act(async () => {
      resolveProtected?.(Response.json({ code: "not_authenticated" }, { status: 401 }));
      await stalePending;
    });

    expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
  });
});

describe("AuthProvider login", () => {
  it("logs in, stores only a non-secret marker, and never touches localStorage", async () => {
    const password = "hunter2";
    stubFetch((url) => (url.includes("/auth/session/") ? anonymousSession() : authenticatedSession("juan")));
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    const factory = new IDBFactory();
    const databaseName = "auth-provider-test-non-secret-marker";
    const repository = createLocalRepository({ databaseName, indexedDB: factory });
    openRepositories.push(repository);

    render(
      <AuthProvider repository={repository}>
        <Probe />
        <LoginForm />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("login-required");
    });

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "juan");
    await user.type(screen.getByLabelText("Password"), password);
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });
    expect(screen.getByTestId("username")).toHaveTextContent("juan");
    expect(setItemSpy).not.toHaveBeenCalled();

    // Read the raw IndexedDB contents directly -- not just through the typed
    // AuthMarker accessor -- so a bug that leaked the password onto the
    // stored record would still be caught (finding #14).
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName);
      request.addEventListener("success", () => {
        resolve(request.result);
      });
      request.addEventListener("error", () => {
        reject(new Error("open failed"));
      });
    });
    const allEntries = await new Promise<unknown[]>((resolve, reject) => {
      const transaction = database.transaction(DATABASE_STORES.internalMetadata, "readonly");
      const getAllRequest = transaction.objectStore(DATABASE_STORES.internalMetadata).getAll();
      getAllRequest.addEventListener("success", () => {
        resolve(getAllRequest.result as unknown[]);
      });
      getAllRequest.addEventListener("error", () => {
        reject(new Error("read failed"));
      });
    });
    database.close();
    expect(allEntries.length).toBeGreaterThan(0);
    expect(JSON.stringify(allEntries)).not.toContain(password);

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
    // Finding #16: a failed attempt clears the password, not only a
    // successful one.
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("blocks signing in as a different user while pending outbox entries exist, naming the device's owner", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    // The outbox owner is set explicitly here, as `login`/`verify` would in
    // real usage; the fetch stub below always reports anonymous, so no
    // startup verify ever gets the chance to establish it on its own.
    await repository.setOutboxOwner({ username: "juan" });
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
    expect(screen.getByLabelText("Password")).toHaveValue("");
    await expect(repository.getAuthMarker()).resolves.toMatchObject({ username: "juan" });
    await expect(repository.getOutboxOwner()).resolves.toEqual({ username: "juan" });
  });

  it("checks the server-returned username, not just the typed one, before adopting a session (finding #9)", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    await repository.setOutboxOwner({ username: "juan" });
    await repository.commitAction({
      actionId: "pending-workout",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } },
      ],
    });
    // The typed username matches the owner, so the cheap pre-check passes;
    // the server nonetheless authenticates a different account (e.g. an
    // account mix-up), which the authoritative post-check must still catch.
    stubFetch((url) => (url.includes("/auth/login/") ? authenticatedSession("impostor") : anonymousSession()));

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
    await user.type(screen.getByLabelText("Username"), "juan");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/unsynced workouts for "juan"/);
    expect(screen.getByTestId("status")).toHaveTextContent("expired");
    await expect(repository.getOutboxOwner()).resolves.toEqual({ username: "juan" });
  });

  it("fails closed (blocks sign-in) when the outbox cannot be read, rather than failing open (finding #2)", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    await repository.setOutboxOwner({ username: "juan" });
    await repository.commitAction({
      actionId: "pending-workout",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } },
      ],
    });
    vi.spyOn(repository, "listPendingOutbox").mockRejectedValue(new Error("IDB blocked"));
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
    await user.type(screen.getByLabelText("Username"), "other");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/can't confirm it's safe to switch accounts/);
    expect(screen.getByTestId("status")).toHaveTextContent("expired");
  });

  it("adopts a fresh session and claims ownership when no owner record exists yet, even with pending entries (first-run/migration case)", async () => {
    // No `setOutboxOwner` call anywhere in this test: this is the shape of a
    // device whose local data predates the outbox-owner record, or one where
    // pending entries were written before any login ever completed. Finding
    // #2's design sets ownership whenever it is absent, not only when
    // nothing is pending, so the rightful, only-ever user of this device is
    // never accidentally locked out of their own pending workouts.
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    await repository.commitAction({
      actionId: "pending-workout",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } },
      ],
    });
    stubFetch((url) => (url.includes("/auth/login/") ? authenticatedSession("juan") : anonymousSession()));

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
    await user.type(screen.getByLabelText("Username"), "juan");
    await user.type(screen.getByLabelText("Password"), "hunter2");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });
    await expect(repository.getOutboxOwner()).resolves.toEqual({ username: "juan" });
  });

  it("signs in successfully with a storage warning when the marker cannot be saved (finding #5)", async () => {
    const repository = freshRepository();
    vi.spyOn(repository, "setAuthMarker").mockRejectedValue(new Error("quota exceeded"));
    stubFetch((url) => (url.includes("/auth/login/") ? authenticatedSession("juan") : anonymousSession()));

    render(
      <AuthProvider repository={repository}>
        <Probe />
        <StorageWarningBanner />
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

    // The server-confirmed sign-in wins: authenticated, not blocked, and
    // definitely not reported as a network problem.
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated");
    });
    expect(screen.getByRole("status")).toHaveTextContent(/could not save its local sign-in record/);
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
    // ...and neither is the outbox owner (finding #2): it is what lets the
    // different-user protection survive this very sign-out.
    await expect(repository.getOutboxOwner()).resolves.toEqual({ username: "juan" });
  });

  it("clears the marker after confirmation even when nothing is pending (finding #12: logout always confirms)", async () => {
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
    // An unconfirmed "Sign out" must not sign out immediately, even with
    // nothing pending -- confirmation is unconditional now.
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => {
      expect(screen.getByTestId("logout-outcome")).toHaveTextContent('"reason":"confirm"');
    });
    expect(screen.getByTestId("logout-outcome")).toHaveTextContent('"pendingCount":0');
    expect(screen.getByTestId("status")).toHaveTextContent("authenticated");

    await user.click(screen.getByRole("button", { name: "Sign out anyway" }));
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("login-required");
    });
    await expect(repository.getAuthMarker()).resolves.toBeUndefined();
  });

  it("signs the user out even when clearing the local marker fails, with a storage warning instead of a failure (finding #5)", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    vi.spyOn(repository, "clearAuthMarker").mockRejectedValue(new Error("write blocked"));
    stubFetch((url) => (url.includes("/auth/logout/") ? new Response(null, { status: 204 }) : authenticatedSession("juan")));

    render(
      <AuthProvider repository={repository}>
        <Probe />
        <LogoutControls />
        <StorageWarningBanner />
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
    await user.click(screen.getByRole("button", { name: "Sign out anyway" }));

    // The server session is gone -- the user is signed out regardless of the
    // local write failure, which surfaces only as a non-blocking warning.
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("login-required");
    });
    expect(screen.getByTestId("logout-outcome")).toHaveTextContent('"ok":true');
    expect(screen.getByRole("status")).toHaveTextContent(/local sign-in record could not be cleared/);
  });

  it("does not resurrect a logged-out session when a stale in-flight verify resolves late (finding #6)", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    setOnline(false);
    let resolveSession: ((response: Response) => void) | undefined;
    let sessionCalls = 0;
    stubFetch((url) => {
      if (url.includes("/auth/logout/")) {
        return new Response(null, { status: 204 });
      }
      // The session endpoint is hit both by the in-flight verify this test
      // sets up below AND by apiFetch's own CSRF-token priming for the
      // logout POST -- only the FIRST call (the verify) should hang; the
      // second (CSRF priming) must resolve, or logout itself would never
      // get a chance to run.
      sessionCalls += 1;
      if (sessionCalls === 1) {
        return new Promise<Response>((resolve) => {
          resolveSession = resolve;
        });
      }
      return anonymousSession();
    });

    render(
      <AuthProvider repository={repository}>
        <Probe />
        <LogoutControls />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("unverified");
    });

    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => {
      expect(resolveSession).toBeDefined();
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign out anyway" }));
    await waitFor(() => {
      expect(screen.getByTestId("logout-outcome")).toHaveTextContent('"ok":true');
    });
    expect(screen.getByTestId("status")).toHaveTextContent("login-required");

    // The in-flight session check from before the sign-out finally resolves
    // as authenticated -- it must not resurrect the session it raced with.
    act(() => {
      resolveSession?.(authenticatedSession("juan"));
    });

    expect(screen.getByTestId("status")).toHaveTextContent("login-required");
    await expect(repository.getAuthMarker()).resolves.toBeUndefined();
  });
});

describe("AuthProvider account-mismatch (finding #2)", () => {
  it("moves to account-mismatch when a background verify's server-confirmed user differs from the owner, without adopting it", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    await repository.setOutboxOwner({ username: "juan" });
    await repository.commitAction({
      actionId: "pending-workout",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } },
      ],
    });
    // Nothing here goes through `login` -- this is the server simply
    // reporting a different signed-in user on a routine background check
    // (e.g. someone else's browser session cookie), not a sign-in attempt.
    stubFetch(() => authenticatedSession("admin"));

    render(
      <AuthProvider repository={repository}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("account-mismatch");
    });
    // The device's own record of who it belongs to to is what is shown/named,
    // not the mismatched server session.
    expect(screen.getByTestId("username")).toHaveTextContent("juan");
    await expect(repository.getAuthMarker()).resolves.toMatchObject({ username: "juan" });
    await expect(repository.getOutboxOwner()).resolves.toEqual({ username: "juan" });
  });

  it("moves to account-mismatch, failing closed, when the ownership record cannot be read during a decisive authenticated verify", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    vi.spyOn(repository, "getOutboxOwner").mockRejectedValue(new Error("IDB blocked"));
    stubFetch(() => authenticatedSession("juan"));

    render(
      <AuthProvider repository={repository}>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("account-mismatch");
    });
  });

  it("shows the AccountMismatchBanner naming the owner and signs out on confirmation, leaving the outbox intact", async () => {
    const repository = freshRepository();
    await repository.setAuthMarker({ username: "juan", lastVerifiedAt: "2026-09-01T00:00:00.000Z" });
    await repository.setOutboxOwner({ username: "juan" });
    await repository.commitAction({
      actionId: "pending-workout",
      changes: [
        { store: "exercise_registry", operation: "put", record: { id: "exercise-1", name: "Row" } },
      ],
    });
    stubFetch((url) => (url.includes("/auth/logout/") ? new Response(null, { status: 204 }) : authenticatedSession("admin")));

    render(
      <AuthProvider repository={repository}>
        <Probe />
        <AccountMismatchBanner />
      </AuthProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("account-mismatch");
    });
    expect(screen.getByText(/unsynced workouts for "juan"/)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    await user.click(await screen.findByRole("button", { name: "Sign out anyway" }));

    await waitFor(() => {
      expect(screen.getByTestId("status")).toHaveTextContent("login-required");
    });
    // Signing out of the mismatched session never adopted it, so the
    // rightful owner's pending entries and ownership record are untouched.
    await expect(repository.listPendingOutbox()).resolves.toHaveLength(1);
    await expect(repository.getOutboxOwner()).resolves.toEqual({ username: "juan" });
  });
});
