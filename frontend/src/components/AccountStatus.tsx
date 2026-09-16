import { useEffect, useId, useRef, useState } from "react";

import { describeLogoutFailure, useAuth } from "../auth/AuthProvider";

/** Renders the marker's last-server-confirmed timestamp for the "unverified" note below; falls back to the raw value if it is somehow not parseable. */
function formatLastVerified(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * Compact account row: current username and a Sign out control. The control
 * is deliberately small and secondary rather than the previous full-width,
 * top-of-screen button (finding #12) -- it still meets the >=44px touch
 * target, but an accidental brush no longer reads as a tap on it, and every
 * tap opens a confirmation first regardless of whether anything is pending.
 * Logout requires network; if pending outbox entries exist the confirmation
 * explains they stay on this device and sync after the next sign-in. While
 * "unverified" (offline continuation), also names when the session was last
 * confirmed with the server (finding #13).
 */
export function AccountStatus() {
  const { lastVerifiedAt, logout, status, username } = useAuth();
  const [pendingConfirm, setPendingConfirm] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signOutButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const explanationId = useId();
  // Tracks the previous `pendingConfirm` purely to detect the transition
  // below; the Sign out control and the confirmation occupy the same spot in
  // the tree, so each swap unmounts one button and mounts the other -- a ref
  // captured before that swap (e.g. inside a click handler) is already stale
  // by the time the new element exists. Moving focus from an effect instead
  // runs after the new element has committed, so the ref is current.
  const previousPendingConfirmRef = useRef<number | null>(null);

  useEffect(() => {
    const previous = previousPendingConfirmRef.current;
    previousPendingConfirmRef.current = pendingConfirm;
    if (previous === null && pendingConfirm !== null) {
      // The confirmation just replaced the Sign out control -- move focus
      // into it so a screen-reader or keyboard user gets a signal that their
      // tap changed the page (finding #10).
      confirmButtonRef.current?.focus();
    } else if (previous !== null && pendingConfirm === null) {
      // The confirmation just closed (Cancel, or a completed/failed sign-out
      // attempt) -- restore focus to the control that opened it instead of
      // leaving it to fall back to <body> (finding #10). A no-op if Sign out
      // itself is no longer rendered, e.g. after a successful sign-out.
      signOutButtonRef.current?.focus();
    }
  }, [pendingConfirm]);

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
    setMessage(describeLogoutFailure(outcome));
  }

  function handleCancel() {
    setPendingConfirm(null);
  }

  return (
    <div className="account-status">
      {(username !== null || status === "unverified") && (
        <span className="muted">
          {username}
          {status === "unverified" && lastVerifiedAt !== null && (
            <>
              {username !== null ? " · " : ""}
              Last verified {formatLastVerified(lastVerifiedAt)}
            </>
          )}
        </span>
      )}
      {pendingConfirm !== null ? (
        <div
          className="stack account-status__confirm"
          role="alertdialog"
          aria-label="Confirm sign out"
          aria-describedby={explanationId}
        >
          <p className="muted" id={explanationId}>
            {pendingConfirm === 0
              ? "Sign out of Gym HUD on this device?"
              : `${pendingConfirm.toString()} unsynced ${pendingConfirm === 1 ? "change stays" : "changes stay"}` +
                " on this device and will sync after you sign in again. Sign out now?"}
          </p>
          <button
            ref={confirmButtonRef}
            className="button button--quiet"
            type="button"
            aria-disabled={busy}
            onClick={() => void handleSignOut(true)}
          >
            Sign out anyway
          </button>
          <button className="button button--quiet" type="button" onClick={handleCancel}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          ref={signOutButtonRef}
          className="button button--quiet button--compact"
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
