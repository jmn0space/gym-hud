import { useState } from "react";

import { describeLogoutFailure, useAuth } from "./AuthProvider";

/**
 * Persistent, non-dismissable banner shown on every screen while authStatus is
 * "account-mismatch": the server-authenticated session belongs to a different
 * user than whoever owns this device's pending outbox entries (or ownership
 * could not be confirmed at all). The app never adopts that session -- local
 * data and the outbox stay exactly as they are, `canSync` is false -- until
 * the rightful owner signs the mismatched session out and signs back in (see
 * finding #2 of the session-auth review and docs/data-sync.md).
 */
export function AccountMismatchBanner() {
  const { logout, mismatchMessage, status } = useAuth();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (status !== "account-mismatch") {
    return null;
  }

  async function handleSignOut(confirmed: boolean) {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const outcome = await logout(confirmed);
    setBusy(false);
    if (outcome.ok) {
      setConfirming(false);
      return;
    }
    if (outcome.reason === "confirm") {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setError(describeLogoutFailure(outcome));
  }

  return (
    <aside className="storage-error" role="status">
      <p>{mismatchMessage}</p>
      {confirming ? (
        <div className="stack" role="alertdialog" aria-label="Confirm sign out">
          <button
            className="button button--quiet"
            type="button"
            aria-disabled={busy}
            onClick={() => void handleSignOut(true)}
          >
            Sign out anyway
          </button>
          <button
            className="button button--quiet"
            type="button"
            onClick={() => {
              setConfirming(false);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="button button--quiet"
          type="button"
          aria-disabled={busy}
          onClick={() => void handleSignOut(false)}
        >
          Sign out
        </button>
      )}
      {error !== null && <p role="alert">{error}</p>}
    </aside>
  );
}
