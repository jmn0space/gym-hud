import { useLocalData } from "../local/LocalDataProvider";

export function LocalDataStatus() {
  const { error, retry, snapshot, status } = useLocalData();

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

  if (status !== "error" || error === null) {
    return null;
  }

  return (
    <aside className="storage-error" role="alert">
      <p>{error.message}</p>
      <button
        className="button button--quiet"
        type="button"
        onClick={() => void retry().catch(() => undefined)}
      >
        Retry
      </button>
    </aside>
  );
}
