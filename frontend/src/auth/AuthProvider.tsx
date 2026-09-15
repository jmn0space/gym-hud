import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { fetchSession, login as requestLogin, logout as requestLogout } from "../api/auth";
import { ApiError, onUnauthenticated } from "../api/client";
import { createLocalRepository, type LocalRepository } from "../storage";

/**
 * See docs/data-sync.md's "Authentication and offline continuation" section
 * for the full contract this state machine implements.
 *
 * - "checking": startup only, before the marker read and (if online) the
 *   session check both resolve.
 * - "login-required": no marker on this device, or the user just signed out.
 *   App routes are not rendered.
 * - "unverified": a marker exists but this reopening could not reach the
 *   server (offline, or a network failure) -- "offline continuation". The app
 *   opens normally from local data; sync stays paused.
 * - "authenticated": the server confirmed the session is valid.
 * - "expired": a marker exists but the server said the session is gone. Local
 *   data and the outbox are preserved and the app stays usable; sync pauses
 *   until re-login.
 */
export type AuthStatus = "checking" | "login-required" | "unverified" | "authenticated" | "expired";

export interface LoginError {
  kind:
    | "invalid_credentials"
    | "invalid_request"
    | "throttled"
    | "network"
    | "different_user"
    | "unknown";
  message: string;
}

export type LogoutOutcome =
  | { ok: true }
  | { ok: false; reason: "offline" }
  | { ok: false; reason: "confirm"; pendingCount: number }
  | { ok: false; reason: "error"; message: string };

interface AuthState {
  status: AuthStatus;
  username: string | null;
  online: boolean;
  /** Only meaningful in "login-required": no marker exists and we are offline. */
  firstLoginNeedsNetwork: boolean;
  loginPending: boolean;
  loginError: LoginError | null;
}

export interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<boolean>;
  /** Pass `confirmed: true` after the caller has shown the pending-outbox warning. */
  logout: (confirmed?: boolean) => Promise<LogoutOutcome>;
  dismissLoginError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
  /** Repository injection for tests and to share a connection with LocalDataProvider. */
  repository?: LocalRepository | undefined;
}

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function nowIso(): string {
  return new Date().toISOString();
}

function classifyLoginError(error: unknown): LoginError {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "invalid_credentials":
        return { kind: "invalid_credentials", message: "Incorrect username or password." };
      case "invalid_request":
        return { kind: "invalid_request", message: "Enter a username and password." };
      case "throttled":
        return { kind: "throttled", message: "Too many attempts. Wait a moment and try again." };
      case "network":
        return {
          kind: "network",
          message: "Sign-in needs a network connection. Try again once you are online.",
        };
      default:
        return { kind: "unknown", message: "Sign-in failed. Try again." };
    }
  }
  return {
    kind: "network",
    message: "Sign-in needs a network connection. Try again once you are online.",
  };
}

export function AuthProvider({ children, repository: suppliedRepository }: AuthProviderProps) {
  const [{ ownsRepository, repository }] = useState(() => ({
    ownsRepository: suppliedRepository === undefined,
    repository: suppliedRepository ?? createLocalRepository(),
  }));

  const [state, setState] = useState<AuthState>({
    status: "checking",
    username: null,
    online: isOnline(),
    firstLoginNeedsNetwork: false,
    loginPending: false,
    loginError: null,
  });

  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const operationRef = useRef(0);
  const statusRef = useRef<AuthStatus>("checking");

  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  const verify = useCallback(async () => {
    const operation = ++operationRef.current;
    let marker;
    try {
      marker = await repository.getAuthMarker();
    } catch {
      // A corrupted or unreadable marker cannot prove this device signed in
      // before, so fail safe to the login screen rather than trusting it.
      marker = undefined;
    }

    if (!isOnline()) {
      if (mountedRef.current && operation === operationRef.current) {
        setState((current) => ({
          ...current,
          status: marker === undefined ? "login-required" : "unverified",
          username: marker?.username ?? current.username,
          online: false,
          firstLoginNeedsNetwork: marker === undefined,
        }));
      }
      return;
    }

    try {
      const result = await fetchSession();
      if (!mountedRef.current || operation !== operationRef.current) {
        return;
      }
      if (result.authenticated) {
        const username = result.username ?? marker?.username ?? null;
        if (username !== null) {
          await repository.setAuthMarker({ username, lastVerifiedAt: nowIso() }).catch(() => undefined);
        }
        setState((current) => ({
          ...current,
          status: "authenticated",
          username,
          online: true,
          firstLoginNeedsNetwork: false,
        }));
      } else {
        setState((current) => ({
          ...current,
          status: marker === undefined ? "login-required" : "expired",
          username: marker?.username ?? null,
          online: true,
          firstLoginNeedsNetwork: false,
        }));
      }
    } catch {
      if (!mountedRef.current || operation !== operationRef.current) {
        return;
      }
      setState((current) => ({
        ...current,
        status: marker === undefined ? "login-required" : "unverified",
        username: marker?.username ?? current.username,
        online: true,
        firstLoginNeedsNetwork: marker === undefined,
      }));
    }
  }, [repository]);

  const cancelPendingOperations = useCallback(() => {
    mountedRef.current = false;
    ++operationRef.current;
  }, []);

  const closeAfterUnmount = useCallback(
    (lifecycle: number) => {
      // React StrictMode immediately remounts after this cleanup in dev; delay
      // closing so that remount keeps a usable connection (mirrors LocalDataProvider).
      queueMicrotask(() => {
        if (ownsRepository && lifecycleRef.current === lifecycle && !mountedRef.current) {
          repository.close();
        }
      });
    },
    [ownsRepository, repository],
  );

  useEffect(() => {
    mountedRef.current = true;
    const lifecycle = ++lifecycleRef.current;
    void verify();

    const handleOnline = () => {
      setState((current) => ({ ...current, online: true }));
      // Only "unverified" re-checks automatically on reconnect (per the
      // offline-continuation contract); "login-required" re-checks the next
      // time the user submits the form instead.
      if (statusRef.current === "unverified") {
        void verify();
      }
    };
    const handleOffline = () => {
      setState((current) => ({ ...current, online: false }));
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    const unsubscribe = onUnauthenticated(() => {
      if (!mountedRef.current) {
        return;
      }
      setState((current) =>
        current.status === "authenticated" ? { ...current, status: "expired" } : current,
      );
    });

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      unsubscribe();
      cancelPendingOperations();
      closeAfterUnmount(lifecycle);
    };
  }, [cancelPendingOperations, closeAfterUnmount, verify]);

  const login = useCallback(
    async (username: string, password: string): Promise<boolean> => {
      const trimmedUsername = username.trim();
      if (mountedRef.current) {
        setState((current) => ({ ...current, loginPending: true, loginError: null }));
      }

      const marker = await repository.getAuthMarker().catch(() => undefined);
      if (marker !== undefined && marker.username !== trimmedUsername) {
        const pending = await repository.listPendingOutbox().catch(() => []);
        if (pending.length > 0) {
          if (mountedRef.current) {
            setState((current) => ({
              ...current,
              loginPending: false,
              loginError: {
                kind: "different_user",
                message: `This device has unsynced workouts for "${marker.username}". Sign in as ${marker.username} to sync them before switching accounts.`,
              },
            }));
          }
          return false;
        }
      }

      try {
        const result = await requestLogin(trimmedUsername, password);
        if (!result.authenticated || result.username === null) {
          if (mountedRef.current) {
            setState((current) => ({
              ...current,
              loginPending: false,
              loginError: { kind: "unknown", message: "Sign-in did not complete. Try again." },
            }));
          }
          return false;
        }
        await repository.setAuthMarker({ username: result.username, lastVerifiedAt: nowIso() });
        if (mountedRef.current) {
          setState((current) => ({
            ...current,
            status: "authenticated",
            username: result.username,
            online: true,
            loginPending: false,
            loginError: null,
            firstLoginNeedsNetwork: false,
          }));
        }
        return true;
      } catch (error) {
        if (mountedRef.current) {
          setState((current) => ({
            ...current,
            loginPending: false,
            loginError: classifyLoginError(error),
          }));
        }
        return false;
      }
    },
    [repository],
  );

  const logout = useCallback(
    async (confirmed = false): Promise<LogoutOutcome> => {
      if (!isOnline()) {
        return { ok: false, reason: "offline" };
      }
      const pending = await repository.listPendingOutbox().catch(() => []);
      if (pending.length > 0 && !confirmed) {
        return { ok: false, reason: "confirm", pendingCount: pending.length };
      }
      try {
        await requestLogout();
        await repository.clearAuthMarker();
        if (mountedRef.current) {
          setState((current) => ({
            ...current,
            status: "login-required",
            username: null,
            loginError: null,
            firstLoginNeedsNetwork: false,
          }));
        }
        return { ok: true };
      } catch (error) {
        const message = error instanceof ApiError && error.message.length > 0
          ? error.message
          : "Sign-out failed. Try again.";
        return { ok: false, reason: "error", message };
      }
    },
    [repository],
  );

  const dismissLoginError = useCallback(() => {
    setState((current) => ({ ...current, loginError: null }));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, logout, dismissLoginError }),
    [state, login, logout, dismissLoginError],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error("useAuth must be used within AuthProvider.");
  }
  return value;
}
