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

  if (status !== "expired") {
    return null;
  }

  return (
    <aside className="storage-error" role="alert">
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
