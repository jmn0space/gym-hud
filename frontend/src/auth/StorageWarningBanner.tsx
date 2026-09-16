import { useAuth } from "./AuthProvider";

/**
 * Non-blocking notice for when the server confirmed a sign-in, session
 * refresh, or sign-out but this device could not persist or clear the
 * corresponding local record (finding #5) -- e.g. a logout that succeeded on
 * the server while IndexedDB refused the write that clears the local marker.
 * The app keeps working either way; this is informational, not an error the
 * user must act on. Rendered both above the login screen and above the app
 * shell, since the underlying failure can happen on either side of a status
 * transition (e.g. signing out lands back on the login screen).
 */
export function StorageWarningBanner() {
  const { dismissStorageWarning, storageWarning } = useAuth();

  if (storageWarning === null) {
    return null;
  }

  return (
    <aside className="storage-warning" role="status">
      <p>{storageWarning}</p>
      <button className="button button--quiet" type="button" onClick={dismissStorageWarning}>
        Dismiss
      </button>
    </aside>
  );
}
