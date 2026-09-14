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
  createLocalRepository,
  type CommitReceipt,
  type LocalAction,
  type LocalRepository,
  type RecoverySnapshot,
} from "../storage";

export type LocalDataStatus = "loading" | "ready" | "saving" | "error";
export type LocalDataErrorKind = "read" | "write" | "refresh";

export interface LocalDataError {
  kind: LocalDataErrorKind;
  message: string;
  cause: unknown;
}

interface LocalDataState {
  status: LocalDataStatus;
  snapshot: RecoverySnapshot | null;
  error: LocalDataError | null;
}

export interface LocalDataContextValue extends LocalDataState {
  commitAction: (action: LocalAction) => Promise<CommitReceipt>;
  retry: () => Promise<void>;
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
    case "refresh":
      return "Your change was saved, but the latest workout data could not be displayed.";
  }
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
  const failedReadKindRef = useRef<"read" | "refresh">("read");

  const publishError = useCallback((kind: LocalDataErrorKind, cause: unknown) => {
    setState((current) => ({
      status: "error",
      snapshot: current.snapshot,
      error: { kind, message: errorMessage(kind), cause },
    }));
  }, []);

  const readSnapshot = useCallback(
    async (kind: "read" | "refresh" = "read") => {
      const operation = ++operationRef.current;
      if (mountedRef.current) {
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

  const runCommit = useCallback(
    async (action: LocalAction): Promise<CommitReceipt> => {
      const operation = ++operationRef.current;
      failedActionRef.current = null;
      if (mountedRef.current) {
        setState((current) => ({ ...current, status: "saving", error: null }));
      }

      let receipt: CommitReceipt;
      try {
        receipt = await repository.commitAction(action);
      } catch (error: unknown) {
        failedActionRef.current = action;
        if (mountedRef.current && operation === operationRef.current) {
          publishError("write", error);
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
          failedReadKindRef.current = "refresh";
          publishError("refresh", error);
        }
        // The transaction completed. Callers must receive the receipt even when
        // refreshing the view fails, otherwise they may falsely treat it as a rollback.
      }
      return receipt;
    },
    [publishError, repository],
  );

  const enqueue = useCallback(<Result,>(operation: () => Promise<Result>): Promise<Result> => {
    const scheduled = queueRef.current.then(operation, operation);
    queueRef.current = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  }, []);

  const commitAction = useCallback(
    (action: LocalAction) => enqueue(() => runCommit(action)),
    [enqueue, runCommit],
  );

  const retry = useCallback(async () => {
    const failedAction = failedActionRef.current;
    if (failedAction !== null) {
      await enqueue(() => runCommit(failedAction));
      return;
    }
    await enqueue(() => readSnapshot(failedReadKindRef.current));
  }, [enqueue, readSnapshot, runCommit]);

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
        // A write failure is still unresolved: a background refresh that happens
        // to succeed must not silently clear it, or the user would never learn
        // the save failed.
        return;
      }
      void enqueue(() => readSnapshot("refresh")).catch(() => undefined);
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
  }, [cancelPendingOperations, closeAfterUnmount, enqueue, readSnapshot]);

  const value = useMemo<LocalDataContextValue>(
    () => ({ ...state, commitAction, retry }),
    [commitAction, retry, state],
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
