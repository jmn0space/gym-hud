import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ActionConflictError,
  ActiveSessionConflictError,
  createLocalRepository,
  InvalidActionError,
  PreconditionFailedError,
  RecordNotFoundError,
  StorageCorruptionError,
  type CommitReceipt,
  type LocalAction,
  type LocalRepository,
  type OutboxEntry,
  type RecoverySnapshot,
} from "../storage";

export type LocalDataStatus = "loading" | "ready" | "saving" | "error";
export type LocalDataErrorKind =
  | "read"
  | "write"
  | "quota"
  | "refresh"
  | "postCommitRefresh"
  | "conflict"
  | "invalid"
  | "corruption";

export interface LocalDataError {
  kind: LocalDataErrorKind;
  message: string;
  cause: unknown;
  /** Whether `retry()` can plausibly succeed by resubmitting the same action/read. */
  retryable: boolean;
}

interface LocalDataState {
  status: LocalDataStatus;
  snapshot: RecoverySnapshot | null;
  error: LocalDataError | null;
}

export interface LocalDataContextValue extends LocalDataState {
  commitAction: (action: LocalAction) => Promise<CommitReceipt>;
  /**
   * The pending queue read straight from this provider's repository, i.e. the same
   * IndexedDB connection every other read here uses. Callers that must decide on
   * live data rather than on the last snapshot -- the service-worker update gate in
   * particular -- use this instead of opening a second connection.
   */
  listPendingOutbox: () => Promise<OutboxEntry[]>;
  retry: () => Promise<void>;
  /** Clears a non-retryable error (conflict/invalid/corruption) once the user has seen it. */
  dismissError: () => void;
}

interface LocalDataProviderProps {
  children: ReactNode;
  /** Repository injection is useful for isolated tests and alternate local databases. */
  repository?: LocalRepository | undefined;
}

const LocalDataContext = createContext<LocalDataContextValue | null>(null);

function errorMessage(kind: LocalDataErrorKind): string {
  switch (kind) {
    case "read":
      return "Saved workout data could not be opened.";
    case "write":
      return "Your change was not saved on this device.";
    case "quota":
      return "Device storage is full, so your change was not saved. Free up space, then try again.";
    case "refresh":
      return "Latest saved workout data could not be loaded.";
    case "postCommitRefresh":
      return "Your change was saved, but the latest workout data could not be displayed.";
    case "conflict":
      return "This change conflicts with newer saved data and was not saved.";
    case "invalid":
      return "This action is no longer valid and was not saved.";
    case "corruption":
      return "Saved workout data appears to be corrupted, so the change was not saved.";
  }
}

/**
 * Non-retryable kinds are produced by errors that the in-transaction checks raise
 * once another tab, a double tap, or corrupted data has made the action permanently
 * unapplicable. Resubmitting the same action would only fail again.
 */
function isRetryableKind(kind: LocalDataErrorKind): boolean {
  return kind !== "conflict" && kind !== "invalid" && kind !== "corruption";
}

/**
 * Walks the `cause` chain looking for a DOMException (raw or wrapped by a
 * LocalStorageError subclass) named "QuotaExceededError". This intentionally does
 * not depend on a dedicated quota error class from ../storage so it keeps working
 * whether that class exists yet or not.
 */
function isQuotaExceededError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && current !== undefined && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ((current as { name?: unknown }).name === "QuotaExceededError") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

interface WriteErrorClassification {
  kind: LocalDataErrorKind;
  message: string;
}

function classifyWriteError(error: unknown): WriteErrorClassification {
  if (
    error instanceof ActiveSessionConflictError ||
    error instanceof PreconditionFailedError ||
    error instanceof ActionConflictError ||
    error instanceof RecordNotFoundError
  ) {
    return { kind: "conflict", message: errorMessage("conflict") };
  }
  if (error instanceof InvalidActionError) {
    return { kind: "invalid", message: errorMessage("invalid") };
  }
  if (error instanceof StorageCorruptionError) {
    return { kind: "corruption", message: errorMessage("corruption") };
  }
  if (isQuotaExceededError(error)) {
    return { kind: "quota", message: errorMessage("quota") };
  }
  return { kind: "write", message: errorMessage("write") };
}

export function LocalDataProvider({ children, repository: suppliedRepository }: LocalDataProviderProps) {
  const [{ ownsRepository, repository }] = useState(() => ({
    ownsRepository: suppliedRepository === undefined,
    repository: suppliedRepository ?? createLocalRepository(),
  }));

  const [state, setState] = useState<LocalDataState>({
    status: "loading",
    snapshot: null,
    error: null,
  });
  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);
  const operationRef = useRef(0);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const failedActionRef = useRef<LocalAction | null>(null);
  const failedReadKindRef = useRef<"read" | "refresh" | "postCommitRefresh">("read");
  // Mirrors state.error whenever it holds a non-retryable (sticky) error, so a
  // background refresh can tell -- without waiting on a state update -- whether it
  // must preserve that error instead of silently clearing it.
  const stickyErrorRef = useRef<LocalDataError | null>(null);

  const publishError = useCallback(
    (kind: LocalDataErrorKind, cause: unknown, message: string = errorMessage(kind)) => {
      const error: LocalDataError = { kind, message, cause, retryable: isRetryableKind(kind) };
      if (!error.retryable) {
        stickyErrorRef.current = error;
      }
      setState((current) => ({
        status: "error",
        snapshot: current.snapshot,
        error,
      }));
    },
    [],
  );

  const readSnapshot = useCallback(
    async (kind: "read" | "refresh" | "postCommitRefresh" = "read") => {
      const operation = ++operationRef.current;
      if (mountedRef.current) {
        stickyErrorRef.current = null;
        setState((current) => ({ ...current, status: "loading", error: null }));
      }
      try {
        const snapshot = await repository.readSnapshot();
        if (mountedRef.current && operation === operationRef.current) {
          failedReadKindRef.current = "read";
          setState({ status: "ready", snapshot, error: null });
        }
      } catch (error: unknown) {
        if (mountedRef.current && operation === operationRef.current) {
          failedReadKindRef.current = kind;
          publishError(kind, error);
        }
        throw error;
      }
    },
    [publishError, repository],
  );

  // Used after a non-retryable write failure (conflict/invalid/corruption) to pick up
  // whatever another tab (or the rejected precondition) already persisted, without
  // flashing "loading" or clearing the error that is still the most relevant
  // information on screen. The error stays visible -- as status "ready" with the
  // error kept -- until the user dismisses it or a new commit supersedes it.
  const refreshPreservingStickyError = useCallback(async () => {
    const operation = ++operationRef.current;
    try {
      const snapshot = await repository.readSnapshot();
      if (mountedRef.current && operation === operationRef.current) {
        setState((current) => ({ status: "ready", snapshot, error: current.error }));
      }
    } catch {
      // Best effort: the sticky error already on screen remains the most relevant
      // information, so a failure here is swallowed rather than overwriting it.
    }
  }, [repository]);

  const enqueue = useCallback(<Result,>(operation: () => Promise<Result>): Promise<Result> => {
    const scheduled = queueRef.current.then(operation, operation);
    queueRef.current = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }, []);

  const runCommit = useCallback(
    async (action: LocalAction): Promise<CommitReceipt> => {
      const operation = ++operationRef.current;
      failedActionRef.current = null;
      stickyErrorRef.current = null;
      if (mountedRef.current) {
        setState((current) => ({ ...current, status: "saving", error: null }));
      }

      let receipt: CommitReceipt;
      try {
        receipt = await repository.commitAction(action);
      } catch (error: unknown) {
        const classification = classifyWriteError(error);
        const retryable = isRetryableKind(classification.kind);
        failedActionRef.current = retryable ? action : null;
        if (mountedRef.current && operation === operationRef.current) {
          publishError(classification.kind, error, classification.message);
        }
        if (!retryable) {
          // A conflict, invalid action, or corruption the in-transaction checks
          // caught can never succeed by retrying. Refresh in the background so a
          // stale tab picks up the latest persisted state; the error stays visible.
          void enqueue(() => refreshPreservingStickyError()).catch(() => undefined);
        }
        throw error;
      }

      try {
        const snapshot = await repository.readSnapshot();
        if (mountedRef.current && operation === operationRef.current) {
          failedReadKindRef.current = "read";
          setState({ status: "ready", snapshot, error: null });
        }
      } catch (error: unknown) {
        if (mountedRef.current && operation === operationRef.current) {
          failedReadKindRef.current = "postCommitRefresh";
          publishError("postCommitRefresh", error);
        }
        // The transaction completed. Callers must receive the receipt even when
        // refreshing the view fails, otherwise they may falsely treat it as a rollback.
      }
      return receipt;
    },
    [enqueue, publishError, repository, refreshPreservingStickyError],
  );

  const commitAction = useCallback(
    (action: LocalAction) => enqueue(() => runCommit(action)),
    [enqueue, runCommit],
  );

  const listPendingOutbox = useCallback(() => repository.listPendingOutbox(), [repository]);

  const retry = useCallback(async () => {
    const failedAction = failedActionRef.current;
    if (failedAction !== null) {
      await enqueue(() => runCommit(failedAction));
      return;
    }
    await enqueue(() => readSnapshot(failedReadKindRef.current));
  }, [enqueue, readSnapshot, runCommit]);

  const dismissError = useCallback(() => {
    stickyErrorRef.current = null;
    setState((current) => ({
      ...current,
      status: current.status === "error" ? "ready" : current.status,
      error: null,
    }));
  }, []);

  const cancelPendingOperations = useCallback(() => {
    mountedRef.current = false;
    ++operationRef.current;
  }, []);

  const closeAfterUnmount = useCallback(
    (lifecycle: number) => {
      queueMicrotask(() => {
        // React StrictMode immediately performs another setup after its development
        // cleanup. Delay ownership cleanup so that replay keeps a usable repository.
        // Also wait for any commit/read already in flight (or queued) so we never
        // close the connection mid-transaction and force a later, never-closed
        // reopen from the same queue.
        void queueRef.current.then(() => {
          if (ownsRepository && lifecycleRef.current === lifecycle && !mountedRef.current) {
            repository.close();
          }
        });
      });
    },
    [ownsRepository, repository],
  );

  useEffect(() => {
    mountedRef.current = true;
    const lifecycle = ++lifecycleRef.current;
    void readSnapshot().catch(() => undefined);
    const refreshFromAnotherView = () => {
      if (failedActionRef.current !== null) {
        // A retryable write failure is still unresolved: a background refresh that
        // happens to succeed must not silently clear it, or the user would never
        // learn the save failed and Retry needs the failed action to still exist.
        return;
      }
      const refreshOperation =
        stickyErrorRef.current !== null ? refreshPreservingStickyError : () => readSnapshot("refresh");
      void enqueue(refreshOperation).catch(() => undefined);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        refreshFromAnotherView();
      }
    };
    window.addEventListener("focus", refreshFromAnotherView);
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      window.removeEventListener("focus", refreshFromAnotherView);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      cancelPendingOperations();
      closeAfterUnmount(lifecycle);
    };
  }, [cancelPendingOperations, closeAfterUnmount, enqueue, readSnapshot, refreshPreservingStickyError]);

  const value = useMemo<LocalDataContextValue>(
    () => ({ ...state, commitAction, listPendingOutbox, retry, dismissError }),
    [commitAction, dismissError, listPendingOutbox, retry, state],
  );

  return <LocalDataContext value={value}>{children}</LocalDataContext>;
}

export function useLocalData(): LocalDataContextValue {
  const value = useContext(LocalDataContext);
  if (value === null) {
    throw new Error("useLocalData must be used within LocalDataProvider.");
  }
  return value;
}

export function useCommitLocalAction(): LocalDataContextValue["commitAction"] {
  return useLocalData().commitAction;
}
