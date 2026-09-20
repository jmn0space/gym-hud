import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { useAuth } from "../auth/AuthProvider";
import { canSync } from "../auth/syncGate";
import { useLocalData } from "../local/LocalDataProvider";
import { createLocalRepository, type LocalRepository } from "../storage";
import { fetchBootstrap, fetchChanges, pushMutations } from "./api";
import { createSyncEngine, type SyncEngine, type SyncEngineSnapshot } from "./engine";

export interface SyncContextValue extends SyncEngineSnapshot {
  syncNow: () => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

interface SyncProviderProps {
  children: ReactNode;
  /** Repository injection for tests and to share a connection with the other
   * providers (see `App.tsx`'s own `authRepository`/`repository` split). */
  repository?: LocalRepository | undefined;
}

const INITIAL_SNAPSHOT: SyncEngineSnapshot = {
  state: "synced",
  pendingCount: 0,
  rejectedCount: 0,
  rejections: [],
  lastSyncedAt: null,
  nextRetryAt: null,
};

/**
 * Drives the sync engine from the app shell: triggers 1-4 of
 * docs/data-sync.md's "Synchronization triggers" (background sync, trigger 5,
 * is deliberately never implemented -- see docs/data-sync.md, "Service-worker
 * updates and the outbox"). Sits inside `LocalDataProvider` and below
 * `AuthProvider` (see `App.tsx`) so it can read the gate and the local data
 * this device already has.
 */
export function SyncProvider({ children, repository: suppliedRepository }: SyncProviderProps) {
  const [{ ownsRepository, repository }] = useState(() => ({
    ownsRepository: suppliedRepository === undefined,
    repository: suppliedRepository ?? createLocalRepository(),
  }));

  const { status, online } = useAuth();
  const { snapshot: localSnapshot } = useLocalData();

  // Read fresh by the engine on every check, never captured once (the sync
  // gate can flip between one trigger and the next).
  const gate = canSync(status, online);
  const gateRef = useRef(gate);
  useEffect(() => {
    gateRef.current = gate;
  }, [gate]);

  // Built inside an effect, not `useState`'s lazy initializer: that
  // initializer runs during render, where reading a ref (even indirectly,
  // through a closure the engine will only call later) is never allowed --
  // see `AppUpdateBanner`'s `liveWorkRef`/`setReloadGuard` for the same
  // "construct/read refs only outside render" split applied to a comparable
  // case. `engine` is null for one tick on mount; every effect below no-ops
  // until it exists.
  const [engine, setEngine] = useState<SyncEngine | null>(null);
  useEffect(() => {
    const created = createSyncEngine({
      repository,
      pushMutations,
      fetchBootstrap,
      fetchChanges,
      canSync: () => gateRef.current,
    });
    setEngine(created);
    // Trigger 2: startup.
    created.trigger();
    return () => {
      created.dispose();
    };
  }, [repository]);

  const snapshot = useSyncExternalStore(
    engine?.subscribe ?? (() => () => undefined),
    () => engine?.getSnapshot() ?? INITIAL_SNAPSHOT,
  );

  // Trigger 3: PWA foreground return (visibility + window focus).
  useEffect(() => {
    if (engine === null) {
      return;
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        engine.trigger();
      }
    };
    const onFocus = () => {
      engine.trigger();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [engine]);

  // Trigger 4: connectivity returns, or auth status becomes authenticated.
  useEffect(() => {
    if (engine === null) {
      return;
    }
    const onOnline = () => {
      engine.trigger();
    };
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
    };
  }, [engine]);

  const previousGateRef = useRef(gate);
  useEffect(() => {
    if (engine !== null && gate && !previousGateRef.current) {
      engine.trigger();
    }
    previousGateRef.current = gate;
  }, [gate, engine]);

  // Trigger 1: after a local commit. `commitAction` must never await the
  // network, so this watches LocalDataProvider's own post-commit snapshot
  // refresh instead of hooking the commit path directly (see
  // docs/data-sync.md, "Synchronization triggers"): a growing pending-outbox
  // length is what a just-committed mutation looks like from here.
  const previousPendingLengthRef = useRef<number | null>(null);
  useEffect(() => {
    const length = localSnapshot?.pendingOutbox.length ?? null;
    const previous = previousPendingLengthRef.current;
    previousPendingLengthRef.current = length;
    if (engine !== null && length !== null && previous !== null && length > previous) {
      engine.trigger();
    }
  }, [localSnapshot, engine]);

  const mountedRef = useRef(false);
  const lifecycleRef = useRef(0);

  // React StrictMode immediately remounts after this cleanup in dev; delay
  // closing so that remount keeps a usable connection (mirrors
  // AuthProvider/LocalDataProvider, including this same helper-function split
  // -- reading `lifecycleRef.current` back out of a plain `useEffect` cleanup
  // closure, rather than through a separate callback like this one, is a
  // stale-ref footgun `react-hooks/exhaustive-deps` warns about).
  const closeAfterUnmount = useCallback(
    (lifecycle: number) => {
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
    return () => {
      mountedRef.current = false;
      closeAfterUnmount(lifecycle);
    };
  }, [closeAfterUnmount]);

  const value = useMemo<SyncContextValue>(
    () => ({
      ...snapshot,
      syncNow: engine?.syncNow ?? (() => Promise.resolve()),
    }),
    [snapshot, engine],
  );

  return <SyncContext value={value}>{children}</SyncContext>;
}

export function useSync(): SyncContextValue {
  const value = useContext(SyncContext);
  if (value === null) {
    throw new Error("useSync must be used within SyncProvider.");
  }
  return value;
}
