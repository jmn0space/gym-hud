import { useSync } from "./SyncProvider";

/** Seconds until `nextRetryAt`, floored at 0; null when nothing is scheduled. */
function retrySecondsRemaining(nextRetryAt: string | null): number | null {
  if (nextRetryAt === null) {
    return null;
  }
  const remainingMs = Date.parse(nextRetryAt) - Date.now();
  return Math.max(0, Math.ceil(remainingMs / 1000));
}

function pluralize(count: number, noun: string): string {
  return `${count.toString()} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The sync status strip (owner decision 3): a small, honest, always-present
 * line in the app shell -- no dedicated sync screen. Copy matches
 * docs/data-sync.md and the issue-20 brief exactly: "N changes waiting to
 * sync", "Sync paused — signed out", "Sync paused — offline", "Retrying in
 * Ns", "All changes synced". `role="status"` (not `alert`): this updates
 * routinely and is not something that needs an interrupting announcement.
 */
export function SyncStatus() {
  const { nextRetryAt, pendingCount, state, syncNow } = useSync();

  let message: string;
  let showRetryButton = false;
  switch (state) {
    case "syncing":
      message = "Syncing…";
      break;
    case "paused":
      // The gate is authStatus === "authenticated" && online (docs/data-sync.md,
      // "Sync gate"); SyncProvider does not distinguish which half failed, so
      // this reads `online` itself to pick the accurate reason.
      message = navigator.onLine ? "Sync paused — signed out" : "Sync paused — offline";
      showRetryButton = true;
      break;
    case "blocked":
      // Deliberately not phrased as an error the user can act on
      // (docs/data-sync.md, "Unsupported stores and versions").
      message = "Sync paused — waiting on the server";
      showRetryButton = true;
      break;
    case "retrying": {
      const seconds = retrySecondsRemaining(nextRetryAt);
      message = seconds === null ? "Retrying…" : `Retrying in ${seconds.toString()}s`;
      showRetryButton = true;
      break;
    }
    case "pending":
      message = `${pluralize(pendingCount, "change")} waiting to sync`;
      showRetryButton = true;
      break;
    case "synced":
      message = "All changes synced";
      break;
  }

  if (!showRetryButton) {
    return (
      <p className="storage-notice muted" role="status">
        {message}
      </p>
    );
  }

  // Reuses `.storage-warning` (see AppUpdateBanner/ExpiredSessionBanner for
  // the same text-plus-button pattern): every state that lands here means
  // synchronization is not simply idle, and "Sync now" gives the user a
  // manual retry (owner decision 3) whatever the reason.
  return (
    <aside className="storage-warning" role="status">
      <p>{message}</p>
      <button
        className="button button--quiet"
        type="button"
        onClick={() => void syncNow().catch(() => undefined)}
      >
        Sync now
      </button>
    </aside>
  );
}

/**
 * Persistent "needs attention" banner (owner decision 3) for mutations the
 * server has permanently rejected: the data stays on this device
 * (docs/data-sync.md, "Client obligations"), so this names how many and shows
 * the server's own `detail` rather than hiding the problem.
 */
export function SyncRejectionBanner() {
  const { rejectedCount, rejections, syncNow } = useSync();

  if (rejectedCount === 0) {
    return null;
  }

  return (
    <aside className="storage-error" role="alert">
      <p>
        {pluralize(rejectedCount, "change")} could not be saved to your account and will not be
        retried automatically. The data is still on this device.
      </p>
      <ul className="storage-queue">
        {rejections.map((entry) => (
          <li key={entry.mutation_id}>{entry.rejection.detail}</li>
        ))}
      </ul>
      <button
        className="button button--quiet"
        type="button"
        onClick={() => void syncNow().catch(() => undefined)}
      >
        Sync now
      </button>
    </aside>
  );
}
