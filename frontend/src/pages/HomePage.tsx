import { useMemo } from "react";
import { Link } from "react-router";

import { HealthStatus } from "../components/HealthStatus";
import { Page } from "../components/Page";
import { ResumeCard } from "../components/ResumeCard";
import { deriveActiveSessionSummaries } from "../local/activeSessions";
import { useLocalData } from "../local/LocalDataProvider";
import { useNow } from "../pad";
import { routes } from "../routes";

export function HomePage() {
  const { snapshot, status } = useLocalData();
  // Whether any card carries a timer depends on the persisted records, not on the
  // clock, so this is derived once per snapshot with a placeholder `now` rather
  // than on every tick. A card with a timer means a session is running, and the
  // clock then has to resynchronize after the phone was locked (see `useNow`),
  // not merely tick while it happened to be awake.
  const hasRunningTimer = useMemo(
    () =>
      snapshot !== null &&
      deriveActiveSessionSummaries(snapshot, 0).some((session) => session.elapsedMs !== undefined),
    [snapshot],
  );
  const now = useNow(hasRunningTimer);
  const persistedSessions = useMemo(
    () => (snapshot === null ? [] : deriveActiveSessionSummaries(snapshot, now)),
    [now, snapshot],
  );

  return (
    <Page heading="Gym HUD" documentTitle="Gym HUD">
      <section className="stack" aria-labelledby="resume-heading">
        <h2 id="resume-heading" className="eyebrow">
          Resume
        </h2>
        {snapshot === null && status === "loading" ? (
          <p className="muted">Checking this device for active sessions…</p>
        ) : snapshot === null ? (
          <p className="muted">Saved sessions are unavailable.</p>
        ) : persistedSessions.length === 0 ? (
          <p className="muted">No active session.</p>
        ) : (
          persistedSessions.map((session) => <ResumeCard key={session.id} session={session} />)
        )}
      </section>

      {snapshot !== null && (
        <section className="storage-queue" aria-labelledby="queue-heading">
          <h2 id="queue-heading" className="eyebrow">
            Saved on this device
          </h2>
          <p className="muted">
            {snapshot.pendingOutbox.length === 0
              ? "No saved changes waiting to sync."
              : `${snapshot.pendingOutbox.length.toString()} saved ${snapshot.pendingOutbox.length === 1 ? "change" : "changes"} waiting to sync. Server sync is not available yet.`}
          </p>
        </section>
      )}

      {/* Becomes "Start new" once these screens can actually start a session. */}
      <section className="stack" aria-labelledby="workouts-heading">
        <h2 id="workouts-heading" className="eyebrow">
          Workouts
        </h2>
        <Link className="button button--primary" to={routes.pad}>
          PAD walking
        </Link>
        <Link className="button" to={routes.resistance}>
          Resistance training
        </Link>
        <Link className="button" to={routes.cardio}>
          Cardio machine
        </Link>
      </section>

      <Link className="button" to={routes.history}>
        History
      </Link>

      <HealthStatus />
    </Page>
  );
}
