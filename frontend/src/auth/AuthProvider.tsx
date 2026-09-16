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
import {
  ApiError,
  bumpSessionGeneration,
  currentSessionGeneration,
  onUnauthenticated,
} from "../api/client";
import {
  createLocalRepository,
  type AuthMarker,
  type LocalRepository,
  type OutboxEntry,
  type OutboxOwner,
} from "../storage";

/**
 * See docs/data-sync.md's "Authentication and offline continuation" section
 * for the full contract this state machine implements.
 *
 * - "checking": startup only, while the marker read resolves and -- only when
 *   no marker exists -- while the (bounded) initial session check runs.
 * - "login-required": no marker on this device, or the user just signed out.
 *   App routes are not rendered. While offline this is "Network required": a
 *   first sign-in needs a connection. While online the sign-in form is always
 *   reachable.
 * - "server-unreachable": no marker, online, but the session check could not
 *   get a decisive answer (network failure, timeout, 5xx, non-JSON body).
 *   The sign-in form stays reachable alongside a Retry action.
 * - "unverified": a marker exists (or could not be ruled out -- see finding
 *   #7) but this reopening could not reach the server, or the marker itself
 *   could not be read. "Offline continuation": the app opens normally from
 *   local data; sync stays paused.
 * - "authenticated": the server confirmed the session is valid for the
 *   device's outbox owner (see "account-mismatch" below).
 * - "expired": a marker exists but the server said the session is gone. Local
 *   data and the outbox are preserved and the app stays usable; sync pauses
 *   until re-login.
 * - "account-mismatch": the server-authenticated user does not match this
 *   device's outbox owner while pending outbox entries exist (or ownership
 *   could not be confirmed at all). The app never adopts that session; local
 *   data and the outbox stay exactly as they are; sync pauses until the
 *   rightful owner signs out the mismatched session and signs back in.
 */
export type AuthStatus =
  | "checking"
  | "login-required"
  | "server-unreachable"
  | "unverified"
  | "authenticated"
  | "expired"
  | "account-mismatch";

export interface LoginError {
  kind:
    | "invalid_credentials"
    | "invalid_request"
    | "throttled"
    | "network"
    | "storage"
    | "different_user"
    | "unknown";
  message: string;
}

export type LogoutOutcome =
  | { ok: true }
  | { ok: false; reason: "offline" }
  | { ok: false; reason: "confirm"; pendingCount: number }
  | { ok: false; reason: "error"; message: string };

/** Renders a `LogoutOutcome` that failed into user-facing text. Shared by
 * every control that calls `logout` directly (AccountStatus, the
 * account-mismatch banner) so the wording stays consistent. */
export function describeLogoutFailure(outcome: Extract<LogoutOutcome, { ok: false }>): string {
  switch (outcome.reason) {
    case "offline":
      return "Sign-out needs a network connection.";
    case "confirm":
      return "Sign-out needs to be confirmed.";
    case "error":
      return outcome.message;
  }
}

interface AuthState {
  status: AuthStatus;
  username: string | null;
  online: boolean;
  loginPending: boolean;
  loginError: LoginError | null;
  /**
   * Non-blocking notice for when the server confirmed a sign-in, session
   * refresh, or sign-out but this device could not persist or clear the
   * corresponding local record (see finding #5). The app keeps working;
   * cleared by `dismissStorageWarning` or overwritten by the next write
   * attempt (success clears it, failure replaces it).
   */
  storageWarning: string | null;
  /** Explains the "account-mismatch" banner; only meaningful while status is
   * "account-mismatch" (see finding #2). */
  mismatchMessage: string | null;
  /** The local marker's last server-confirmed timestamp, surfaced in the
   * "unverified" state; null when unknown. */
  lastVerifiedAt: string | null;
}

export interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<boolean>;
  /** Always requires `confirmed: true` to actually sign out -- the caller
   * must show a confirmation UI first, even with nothing pending (see
   * finding #12). Without it, resolves to `{ ok: false, reason: "confirm" }`
   * carrying the pending-entry count (which may be zero). */
  logout: (confirmed?: boolean) => Promise<LogoutOutcome>;
  dismissLoginError: () => void;
  dismissStorageWarning: () => void;
  /** Re-runs the session check on demand, e.g. a "Retry" control while
   * "server-unreachable". Never rejects. */
  retry: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
  /** Repository injection for tests and to share a connection with LocalDataProvider. */
  repository?: LocalRepository | undefined;
}

/** How long a session check may run before it is treated as a network-class
 * failure (finding #3). A hung captive-portal Wi-Fi must not block startup. */
const CHECK_TIMEOUT_MS = 5000;
const INITIAL_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Statuses that auto-recheck on `online`, focus, visibility, and backoff
 * timers (finding #4): everywhere we do not yet have a decisive answer that
 * only a fresh login could change. */
const RECHECK_STATUSES: ReadonlySet<AuthStatus> = new Set([
  "checking",
  "login-required",
  "server-unreachable",
  "unverified",
]);

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function nowIso(): string {
  return new Date().toISOString();
}

function differentUserLoginMessage(owner: string): string {
  return `This device has unsynced workouts for "${owner}". Sign in as ${owner} to sync them before switching accounts.`;
}

function accountMismatchMessage(owner: string): string {
  return `This device has unsynced workouts for "${owner}". Sign out so ${owner} can sign in to sync them.`;
}

const OWNERSHIP_READ_FAILURE_LOGIN_MESSAGE =
  "This device's saved account record could not be read, so Gym HUD can't confirm it's safe to switch accounts. Try again.";
const OWNERSHIP_READ_FAILURE_MISMATCH_MESSAGE =
  "This device's saved account record could not be read, so Gym HUD can't confirm whose pending changes these are. Sign out, then sign in again to continue.";
const OWNERSHIP_READ_FAILURE_LOGOUT_MESSAGE =
  "Could not check this device for unsynced changes. Try again.";
const MARKER_WRITE_WARNING =
  "Signed in, but this device could not save its local sign-in record. You can keep using Gym HUD; you may need to sign in again next time it opens.";
const MARKER_CLEAR_WARNING =
  "Signed out, but this device's local sign-in record could not be cleared. If this device shows a stale username later, sign in again.";

/** Never surfaces a storage-write failure as a login failure (finding #5):
 * this only classifies errors from `requestLogin` itself, which -- via
 * apiFetch's own catch-all -- is always an `ApiError`. The non-ApiError
 * branch is a defensive fallback for an error `requestLogin` should not
 * actually be able to throw. */
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
  return { kind: "unknown", message: "Sign-in failed. Try again." };
}

type MarkerRead =
  | { kind: "found"; marker: AuthMarker }
  | { kind: "absent" }
  | { kind: "unreadable" };

/**
 * Reads the auth marker, retrying once on failure before giving up (finding
 * #7): a transient IndexedDB hiccup must not be indistinguishable from "this
 * device never signed in". `"unreadable"` is a distinct outcome from
 * `"absent"` -- callers must not lock the device out of its own local data
 * just because this read failed twice.
 */
async function readMarkerWithRetry(repository: LocalRepository): Promise<MarkerRead> {
  async function attempt(): Promise<MarkerRead | undefined> {
    try {
      const marker = await repository.getAuthMarker();
      return marker === undefined ? { kind: "absent" } : { kind: "found", marker };
    } catch {
      return undefined;
    }
  }
  return (await attempt()) ?? (await attempt()) ?? { kind: "unreadable" };
}

type CheckOutcome =
  | { kind: "authenticated"; username: string }
  | { kind: "anonymous" }
  | { kind: "connectivity" };

/**
 * Classifies a session check into a decisive answer ("authenticated" or
 * "anonymous", including a 401 -- the server explicitly said so) versus an
 * ambiguous connectivity-class failure (network error, an aborted/timed-out
 * request, a 5xx, or a non-JSON body from a proxy) that proves nothing either
 * way. See docs/data-sync.md and finding #13.
 */
async function checkSession(signal: AbortSignal): Promise<CheckOutcome> {
  try {
    const result = await fetchSession(signal);
    if (!result.authenticated) {
      return { kind: "anonymous" };
    }
    // The backend contract guarantees a username whenever authenticated is
    // true; a violation is treated as untrustworthy rather than either
    // accepting a blank identity or spuriously signing the device out.
    return result.username === null ? { kind: "connectivity" } : { kind: "authenticated", username: result.username };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return { kind: "anonymous" };
    }
    return { kind: "connectivity" };
  }
}

interface Resolution {
  status: AuthStatus;
  username: string | null;
}

/** Resolves the non-authenticated outcomes of a session check against what
 * the marker read found. Only ever called for a decisive "anonymous" or an
 * ambiguous "connectivity" outcome -- "authenticated" needs the ownership
 * check in `verify` first. */
function resolveStatus(
  markerRead: MarkerRead,
  outcome: Exclude<CheckOutcome, { kind: "authenticated" }>,
): Resolution {
  const knownUsername = markerRead.kind === "found" ? markerRead.marker.username : null;

  if (outcome.kind === "anonymous") {
    if (markerRead.kind === "found") {
      return { status: "expired", username: knownUsername };
    }
    if (markerRead.kind === "unreadable") {
      // A decisive "not authenticated" answer is no more trustworthy than
      // the marker read that already failed -- do not use it to lock this
      // device out of its own local data (finding #7).
      return { status: "unverified", username: null };
    }
    return { status: "login-required", username: null };
  }

  if (markerRead.kind === "absent") {
    return { status: "server-unreachable", username: null };
  }
  return { status: "unverified", username: knownUsername };
}

interface OwnershipRead {
  ok: boolean;
  owner: OutboxOwner | undefined;
  pending: OutboxEntry[];
}

/**
 * Reads the durable outbox-owner record and the pending outbox together, so
 * every different-user decision sees one consistent snapshot. Never throws: a
 * read failure reports `ok: false` so callers fail CLOSED (finding #2c)
 * instead of the previous `.catch(() => undefined)` / `.catch(() => [])`
 * fail-open pattern.
 */
async function readOwnership(repository: LocalRepository): Promise<OwnershipRead> {
  try {
    const [owner, pending] = await Promise.all([
      repository.getOutboxOwner(),
      repository.listPendingOutbox(),
    ]);
    return { ok: true, owner, pending };
  } catch {
    return { ok: false, owner: undefined, pending: [] };
  }
}

function ownerConflicts(ownership: OwnershipRead, username: string): boolean {
  return ownership.owner !== undefined && ownership.owner.username !== username && ownership.pending.length > 0;
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
    loginPending: false,
    loginError: null,
    storageWarning: null,
    mismatchMessage: null,
    lastVerifiedAt: null,
  });

  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const operationRef = useRef(0);
  const statusRef = useRef<AuthStatus>("checking");
  const verifyingRef = useRef(false);
  const pendingRecheckRef = useRef(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const verifyRef = useRef<() => Promise<void>>(() => Promise.resolve());

  useEffect(() => {
    statusRef.current = state.status;
  }, [state.status]);

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current !== undefined) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = undefined;
    }
  }, []);

  const scheduleRetry = useCallback(() => {
    clearRetryTimer();
    const delay = backoffRef.current;
    backoffRef.current = Math.min(backoffRef.current * 2, MAX_BACKOFF_MS);
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = undefined;
      if (mountedRef.current && isOnline()) {
        void verifyRef.current();
      }
    }, delay);
  }, [clearRetryTimer]);

  const verify = useCallback(async () => {
    const operation = ++operationRef.current;
    const stale = () => !mountedRef.current || operation !== operationRef.current;
    verifyingRef.current = true;
    clearRetryTimer();

    try {
      const markerRead = await readMarkerWithRetry(repository);
      if (stale()) {
        return;
      }
      const knownUsername = markerRead.kind === "found" ? markerRead.marker.username : null;

      // Render the app immediately once a marker exists (or could not be
      // ruled out): re-confirming with the server happens in the background.
      // Only "this device has never signed in" stays on the checking screen
      // while the bounded network check below runs (finding #3).
      if (markerRead.kind !== "absent") {
        setState((current) => ({
          ...current,
          status: "unverified",
          username: knownUsername,
          online: isOnline(),
          lastVerifiedAt: markerRead.kind === "found" ? markerRead.marker.lastVerifiedAt : current.lastVerifiedAt,
        }));
      }

      if (!isOnline()) {
        if (markerRead.kind === "absent" && !stale()) {
          setState((current) => ({ ...current, status: "login-required", username: null, online: false }));
        }
        backoffRef.current = INITIAL_BACKOFF_MS;
        return;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, CHECK_TIMEOUT_MS);
      let outcome: CheckOutcome;
      try {
        outcome = await checkSession(controller.signal);
      } finally {
        clearTimeout(timeout);
      }
      if (stale()) {
        return;
      }

      if (outcome.kind !== "authenticated") {
        const resolution = resolveStatus(markerRead, outcome);
        setState((current) => ({ ...current, status: resolution.status, username: resolution.username, online: true }));
        if (outcome.kind === "connectivity") {
          scheduleRetry();
        } else {
          backoffRef.current = INITIAL_BACKOFF_MS;
        }
        return;
      }

      // Decisive: the server confirms `outcome.username` is authenticated.
      // Before adopting it, confirm it agrees with whoever owns this
      // device's pending outbox (finding #2).
      const ownership = await readOwnership(repository);
      if (stale()) {
        return;
      }

      if (!ownership.ok) {
        setState((current) => ({
          ...current,
          status: "account-mismatch",
          username: knownUsername,
          online: true,
          mismatchMessage: OWNERSHIP_READ_FAILURE_MISMATCH_MESSAGE,
        }));
        backoffRef.current = INITIAL_BACKOFF_MS;
        return;
      }

      if (ownerConflicts(ownership, outcome.username)) {
        const ownerUsername = ownership.owner?.username ?? outcome.username;
        setState((current) => ({
          ...current,
          status: "account-mismatch",
          username: ownerUsername,
          online: true,
          mismatchMessage: accountMismatchMessage(ownerUsername),
        }));
        backoffRef.current = INITIAL_BACKOFF_MS;
        return;
      }

      const nowIsoValue = nowIso();
      const writes: Promise<void>[] = [
        repository.setAuthMarker({ username: outcome.username, lastVerifiedAt: nowIsoValue }),
      ];
      if (ownership.owner === undefined || ownership.pending.length === 0) {
        writes.push(repository.setOutboxOwner({ username: outcome.username }));
      }
      let storageWarning: string | null = null;
      try {
        await Promise.all(writes);
      } catch {
        storageWarning = MARKER_WRITE_WARNING;
      }
      if (stale()) {
        return;
      }
      bumpSessionGeneration();
      setState((current) => ({
        ...current,
        status: "authenticated",
        username: outcome.username,
        online: true,
        storageWarning,
        mismatchMessage: null,
        lastVerifiedAt: storageWarning === null ? nowIsoValue : current.lastVerifiedAt,
      }));
      backoffRef.current = INITIAL_BACKOFF_MS;
    } finally {
      verifyingRef.current = false;
      if (pendingRecheckRef.current && mountedRef.current) {
        pendingRecheckRef.current = false;
        void verifyRef.current();
      }
    }
  }, [repository, clearRetryTimer, scheduleRetry]);

  verifyRef.current = verify;

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
    void verifyRef.current();

    function maybeRecheck() {
      if (!isOnline() || !RECHECK_STATUSES.has(statusRef.current)) {
        return;
      }
      if (verifyingRef.current) {
        // A check is already in flight -- queue a follow-up instead of
        // starting a second, overlapping one (finding #4).
        pendingRecheckRef.current = true;
        return;
      }
      backoffRef.current = INITIAL_BACKOFF_MS;
      void verifyRef.current();
    }

    const handleOnline = () => {
      setState((current) => ({ ...current, online: true }));
      maybeRecheck();
    };
    const handleOffline = () => {
      setState((current) => ({ ...current, online: false }));
      clearRetryTimer();
    };
    const handleFocus = () => {
      maybeRecheck();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        maybeRecheck();
      }
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const unsubscribe = onUnauthenticated((generation) => {
      if (!mountedRef.current || generation !== currentSessionGeneration()) {
        // Either unmounted, or this 401 belongs to a session that has since
        // been superseded by a newer login/verify (finding #17) -- ignore it
        // rather than resurrecting-as-expired a session that is fine.
        return;
      }
      setState((current) =>
        current.status === "authenticated" || current.status === "unverified"
          ? { ...current, status: "expired" }
          : current,
      );
    });

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      unsubscribe();
      clearRetryTimer();
      cancelPendingOperations();
      closeAfterUnmount(lifecycle);
    };
  }, [cancelPendingOperations, closeAfterUnmount, clearRetryTimer]);

  const login = useCallback(
    async (username: string, password: string): Promise<boolean> => {
      const operation = ++operationRef.current;
      const stale = () => !mountedRef.current || operation !== operationRef.current;
      const trimmedUsername = username.trim();
      if (mountedRef.current) {
        setState((current) => ({ ...current, loginPending: true, loginError: null }));
      }

      const ownership = await readOwnership(repository);
      if (stale()) {
        return false;
      }
      if (!ownership.ok) {
        setState((current) => ({
          ...current,
          loginPending: false,
          loginError: { kind: "storage", message: OWNERSHIP_READ_FAILURE_LOGIN_MESSAGE },
        }));
        return false;
      }
      // Cheap pre-check against the *typed* username, before spending a
      // request: the authoritative check below uses the server's answer
      // instead (finding #9).
      if (ownerConflicts(ownership, trimmedUsername)) {
        const ownerUsername = ownership.owner?.username ?? trimmedUsername;
        setState((current) => ({
          ...current,
          loginPending: false,
          loginError: { kind: "different_user", message: differentUserLoginMessage(ownerUsername) },
        }));
        return false;
      }

      let result;
      try {
        result = await requestLogin(trimmedUsername, password);
      } catch (error) {
        if (!stale()) {
          setState((current) => ({ ...current, loginPending: false, loginError: classifyLoginError(error) }));
        }
        return false;
      }
      if (stale()) {
        return false;
      }
      if (!result.authenticated || result.username === null) {
        setState((current) => ({
          ...current,
          loginPending: false,
          loginError: { kind: "unknown", message: "Sign-in did not complete. Try again." },
        }));
        return false;
      }

      // Authoritative recheck against the server-returned username: the
      // typed one was only good enough for the pre-check above (finding #9).
      if (ownerConflicts(ownership, result.username)) {
        // The server has already created a session for the wrong account --
        // simplest correct behavior is to log it back out immediately rather
        // than leave the device holding a server session it will never
        // adopt (best-effort: a failure here just means that session lingers
        // until its own expiry, since nothing local ever treats it as ours).
        await requestLogout().catch(() => undefined);
        const ownerUsername = ownership.owner?.username ?? result.username;
        if (!stale()) {
          setState((current) => ({
            ...current,
            loginPending: false,
            loginError: { kind: "different_user", message: differentUserLoginMessage(ownerUsername) },
          }));
        }
        return false;
      }

      const nowIsoValue = nowIso();
      const writes: Promise<void>[] = [
        repository.setAuthMarker({ username: result.username, lastVerifiedAt: nowIsoValue }),
      ];
      if (ownership.owner === undefined || ownership.pending.length === 0) {
        writes.push(repository.setOutboxOwner({ username: result.username }));
      }
      let storageWarning: string | null = null;
      try {
        await Promise.all(writes);
      } catch {
        // The server session is valid -- proceed as authenticated for this
        // app run rather than claiming a network problem (finding #5).
        storageWarning = MARKER_WRITE_WARNING;
      }
      if (stale()) {
        return false;
      }

      bumpSessionGeneration();
      setState((current) => ({
        ...current,
        status: "authenticated",
        username: result.username,
        online: true,
        loginPending: false,
        loginError: null,
        storageWarning,
        mismatchMessage: null,
        lastVerifiedAt: storageWarning === null ? nowIsoValue : current.lastVerifiedAt,
      }));
      return true;
    },
    [repository],
  );

  const logout = useCallback(
    async (confirmed = false): Promise<LogoutOutcome> => {
      // Bumped up front, like `login` (finding #6): a `logout` that overlaps
      // an in-flight `verify` invalidates it, and a `logout` itself may be
      // superseded (e.g. a fresh login lands while a slow logout is still
      // resolving) -- `stale()` below stops it from clobbering newer state.
      const operation = ++operationRef.current;
      const stale = () => !mountedRef.current || operation !== operationRef.current;
      if (!isOnline()) {
        return { ok: false, reason: "offline" };
      }
      const ownership = await readOwnership(repository);
      if (!ownership.ok) {
        return { ok: false, reason: "error", message: OWNERSHIP_READ_FAILURE_LOGOUT_MESSAGE };
      }
      // Always require explicit confirmation, even with nothing pending: a
      // full-width, top-of-screen control is an easy accidental tap while
      // mid-workout (finding #12). The caller shows the pending-entry
      // warning only when `pendingCount` is nonzero.
      if (!confirmed) {
        return { ok: false, reason: "confirm", pendingCount: ownership.pending.length };
      }
      try {
        await requestLogout();
      } catch (error) {
        const message = error instanceof ApiError && error.message.length > 0
          ? error.message
          : "Sign-out failed. Try again.";
        return { ok: false, reason: "error", message };
      }
      // The server session is gone regardless of what happens next: report
      // success even if clearing the local marker fails, with a storage
      // warning instead of silently pretending sign-out did not happen
      // (finding #5). The outbox owner is deliberately left untouched --
      // see the `OutboxOwner` JSDoc.
      let storageWarning: string | null = null;
      try {
        await repository.clearAuthMarker();
      } catch {
        storageWarning = MARKER_CLEAR_WARNING;
      }
      if (!stale()) {
        setState((current) => ({
          ...current,
          status: "login-required",
          username: null,
          loginError: null,
          storageWarning,
          mismatchMessage: null,
        }));
      }
      return { ok: true };
    },
    [repository],
  );

  const dismissLoginError = useCallback(() => {
    setState((current) => ({ ...current, loginError: null }));
  }, []);

  const dismissStorageWarning = useCallback(() => {
    setState((current) => ({ ...current, storageWarning: null }));
  }, []);

  const retry = useCallback(() => verifyRef.current(), []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, login, logout, dismissLoginError, dismissStorageWarning, retry }),
    [state, login, logout, dismissLoginError, dismissStorageWarning, retry],
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
