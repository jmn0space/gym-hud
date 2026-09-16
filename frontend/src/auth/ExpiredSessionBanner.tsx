import { useState } from "react";

import { useAuth } from "./AuthProvider";
import { LoginForm } from "./LoginForm";

/**
 * Persistent, non-dismissable banner shown on every screen while authStatus is
 * "expired": the server no longer recognizes the session, but local data and
 * the pending outbox stay exactly as they were and the app remains usable.
 * Disappears on its own once re-login succeeds (status leaves "expired").
 */
export function ExpiredSessionBanner() {
  const { status } = useAuth();
  const [showForm, setShowForm] = useState(false);
  // Tracks the previously-rendered status purely to detect the transition
  // below; this component stays mounted even while it renders null, so
  // `showForm` would otherwise survive from one "expired" episode to the
  // next. Adjusted during render (React's supported pattern for resetting
  // state in response to a prop/derived-value change) rather than in a
  // `useEffect`, so a later expiry starts back on the "Sign in" button
  // instead of the open form without an extra render round-trip (finding
  // #15).
  const [trackedStatus, setTrackedStatus] = useState(status);
  if (status !== trackedStatus) {
    setTrackedStatus(status);
    if (status !== "expired") {
      setShowForm(false);
    }
  }

  if (status !== "expired") {
    return null;
  }

  return (
    // "status", not "alert": the form below has its own role="alert" for a
    // sign-in error, and a live region should not nest inside another one
    // (finding #15). This banner's own presence is announced once when it
    // appears; it does not need to keep re-asserting itself as an alert.
    <aside className="storage-error" role="status">
      <p>Session expired — sign in to sync</p>
      {showForm ? (
        <LoginForm />
      ) : (
        <button
          className="button button--quiet"
          type="button"
          onClick={() => {
            setShowForm(true);
          }}
        >
          Sign in
        </button>
      )}
    </aside>
  );
}
