import { useLocalData } from "../local/LocalDataProvider";

export function LocalDataStatus() {
  const { dismissError, error, retry, snapshot, status } = useLocalData();

  if (status === "loading" && snapshot === null) {
    return (
      <p className="storage-notice muted" role="status">
        Loading saved workout data…
      </p>
    );
  }

  if (status === "saving") {
    return (
      <p className="storage-notice muted" role="status">
        Saving on this device…
      </p>
    );
  }

  if (error === null) {
    return null;
  }

  return (
    <aside className="storage-error" role="alert">
      <p>{error.message}</p>
      {error.retryable ? (
        <button
          className="button button--quiet"
          type="button"
          onClick={() => void retry().catch(() => undefined)}
        >
          Retry
        </button>
      ) : (
        <button className="button button--quiet" type="button" onClick={dismissError}>
          Dismiss
        </button>
      )}
    </aside>
  );
}
