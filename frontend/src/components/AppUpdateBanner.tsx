import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { useLocalData } from "../local/LocalDataProvider";
import { serviceWorkerUpdates, type ServiceWorkerUpdates } from "../pwa/registerServiceWorker";
import { hasLiveWork } from "../pwa/updateSafety";

const READY_MESSAGE = "A new version of Gym HUD is ready.";
const DEFERRED_MESSAGE =
  "Gym HUD will update as soon as your current session is finished and your changes are saved.";

interface AppUpdateBannerProps {
  /** Injection point for tests; the app uses the module-level registration. */
  updates?: ServiceWorkerUpdates | undefined;
}

/**
 * Non-blocking "update ready" affordance.
 *
 * Applying an update means telling the waiting worker to take over and reloading, so
 * it is gated on there being no active session and nothing pending in the outbox
 * (decision D3 / acceptance criterion 4). When the user asks while work is live the
 * banner stays, promises the update for later, and re-tries by itself as soon as the
 * session is finished and the queue has drained -- so the promise is actually kept
 * without anyone having to come back and press the button again.
 */
export function AppUpdateBanner({ updates = serviceWorkerUpdates }: AppUpdateBannerProps) {
  const { listPendingOutbox, snapshot } = useLocalData();
  const updateReady = useSyncExternalStore(updates.subscribe, updates.isUpdateReady);
  const [deferred, setDeferred] = useState(false);

  // Derived from the last snapshot, which is refreshed after every commit and on
  // focus. It only decides when to re-try below; the decision itself re-reads the
  // outbox, so a snapshot another view has moved past can never wave a reload through.
  const liveWorkInSnapshot = hasLiveWork(snapshot, snapshot?.pendingOutbox ?? []);

  const isSafeToApply = useCallback(async () => {
    // Straight from the provider's repository -- the same IndexedDB connection every
    // other read uses, not a second one.
    const pendingOutbox = await listPendingOutbox();
    return !hasLiveWork(snapshot, pendingOutbox);
  }, [listPendingOutbox, snapshot]);

  const requestUpdate = useCallback(async () => {
    const safe = await isSafeToApply();
    setDeferred(!safe);
    if (safe) {
      updates.applyUpdate();
    }
  }, [isSafeToApply, updates]);

  useEffect(() => {
    if (!updateReady || !deferred || liveWorkInSnapshot) {
      return;
    }
    // The user already asked, and the session they were protecting has finished.
    let cancelled = false;
    void isSafeToApply()
      .then((safe) => {
        if (safe && !cancelled) {
          updates.applyUpdate();
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [deferred, isSafeToApply, liveWorkInSnapshot, updateReady, updates]);

  if (!updateReady) {
    return null;
  }

  return (
    <aside className="app-update" role="status">
      <p>{deferred ? DEFERRED_MESSAGE : READY_MESSAGE}</p>
      <button
        className="button button--quiet"
        type="button"
        onClick={() => void requestUpdate().catch(() => undefined)}
      >
        Update now
      </button>
    </aside>
  );
}
