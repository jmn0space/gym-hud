import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useLocalData } from "../local/LocalDataProvider";
import { serviceWorkerUpdates, type ServiceWorkerUpdates } from "../pwa/registerServiceWorker";
import { hasLiveWork } from "../pwa/updateSafety";

const READY_MESSAGE = "A new version of Gym HUD is ready.";
const DEFERRED_MESSAGE =
  "Gym HUD will be ready to update as soon as your current session is finished and your changes are saved.";

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
 * banner stays and says so, and it re-offers itself as soon as the session is
 * finished and the queue has drained. It re-offers rather than reloading on its own:
 * `hasLiveWork` only knows about sessions and the outbox, so an unprompted reload
 * would be free to interrupt someone who is simply reading a page.
 *
 * The gate is asynchronous and the activation that follows it is asynchronous too, so
 * the same predicate is also handed to the registration as a reload guard -- see
 * `setReloadGuard` -- to cover the window between "the user asked" and "the new worker
 * took over".
 */
export function AppUpdateBanner({ updates = serviceWorkerUpdates }: AppUpdateBannerProps) {
  const { listPendingOutbox, readLiveSnapshot, snapshot } = useLocalData();
  const updateReady = useSyncExternalStore(updates.subscribe, updates.isUpdateReady);
  const [deferred, setDeferred] = useState(false);

  // Derived from the last snapshot, which is refreshed after every commit and on
  // focus. This is only a heuristic for when to retry the deferred update below --
  // it decides nothing on its own. The actual gate, `isSafeToApply` below, re-reads
  // both the outbox and the active-session snapshot live, so a tab that has not
  // received a focus/visibilitychange event since another tab changed the data can
  // never wave a reload through on this stale value.
  const liveWorkInSnapshot = hasLiveWork(snapshot, snapshot?.pendingOutbox ?? []);

  // Read by the reload guard below, which the registration calls synchronously from a
  // `controllerchange` handler and so cannot await anything.
  const liveWorkRef = useRef(liveWorkInSnapshot);
  useEffect(() => {
    liveWorkRef.current = liveWorkInSnapshot;
  }, [liveWorkInSnapshot]);

  useEffect(() => {
    // Last line of defence for acceptance criterion 4. Between `applyUpdate()` and
    // the reload sit a worker wake-up, `skipWaiting()`, cache pruning and
    // `clients.claim()`; a user who starts a session in that window must not be
    // reloaded out of it. This can only ever refuse a reload the asynchronous gate
    // already allowed, never permit one it refused.
    updates.setReloadGuard(() => !liveWorkRef.current);
    return () => {
      updates.setReloadGuard(null);
    };
  }, [updates]);

  const isSafeToApply = useCallback(async () => {
    // Both halves are read straight from the provider's repository at decision time
    // -- the same IndexedDB connection every other read uses, not a second one, and
    // never the React-state `snapshot` above, which another tab can move past (start
    // a session, finish one, drain the outbox) without this tab ever finding out.
    // Either half failing counts as live work, the same as a snapshot that has never
    // loaded: fail safe, never wave the update through. Neither `catch` may be
    // dropped -- a rejection escaping here would make the whole gate throw, and the
    // caller would then be unable to tell "not safe" from "could not tell".
    const [pendingOutbox, liveSnapshot] = await Promise.all([
      listPendingOutbox().catch(() => null),
      readLiveSnapshot().catch(() => null),
    ]);
    if (pendingOutbox === null) {
      return false;
    }
    return !hasLiveWork(liveSnapshot, pendingOutbox);
  }, [listPendingOutbox, readLiveSnapshot]);

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
    // The session the user was protecting has finished, so put the offer back in
    // front of them. Deliberately *not* `applyUpdate()`: that reloads the page, and
    // the user may well have moved on to something this gate cannot see.
    let cancelled = false;
    void isSafeToApply()
      .then((safe) => {
        if (safe && !cancelled) {
          setDeferred(false);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [deferred, isSafeToApply, liveWorkInSnapshot, updateReady]);

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
