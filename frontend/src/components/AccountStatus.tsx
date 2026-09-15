import { useState } from "react";

import { useAuth } from "../auth/AuthProvider";

/**
 * Minimal account row: current username and a Sign out control. Logout
 * requires network; if pending outbox entries exist it confirms first,
 * explaining they stay on this device and sync after the next sign-in.
 */
export function AccountStatus() {
  const { logout, status, username } = useAuth();
  const [pendingConfirm, setPendingConfirm] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === "checking" || status === "login-required") {
    return null;
  }

  async function handleSignOut(confirmed: boolean) {
    if (busy) {
      return;
    }
    setBusy(true);
    setMessage(null);
    const outcome = await logout(confirmed);
    setBusy(false);
    if (outcome.ok) {
      setPendingConfirm(null);
      return;
    }
    if (outcome.reason === "confirm") {
      setPendingConfirm(outcome.pendingCount);
      return;
    }
    setPendingConfirm(null);
    setMessage(outcome.reason === "offline" ? "Sign-out needs a network connection." : outcome.message);
  }

  return (
    <div className="account-status">
      {username !== null && <span className="muted">{username}</span>}
      {pendingConfirm !== null ? (
        <div className="stack" role="alertdialog" aria-label="Confirm sign out">
          <p className="muted">
            {pendingConfirm.toString()} unsynced {pendingConfirm === 1 ? "change stays" : "changes stay"}{" "}
            on this device and will sync after you sign in again. Sign out now?
          </p>
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
              setPendingConfirm(null);
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
      {message !== null && (
        <p className="muted" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
