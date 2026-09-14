import { Link } from "react-router";

import { HealthStatus } from "../components/HealthStatus";
import { Page } from "../components/Page";
import { type ActiveSessionSummary, ResumeCard } from "../components/ResumeCard";
import { routes } from "../routes";

interface HomePageProps {
  /** Supplied by the local session store once sessions can be recorded. */
  activeSessions?: readonly ActiveSessionSummary[];
}

export function HomePage({ activeSessions = [] }: HomePageProps) {
  return (
    <Page heading="Gym HUD" documentTitle="Gym HUD">
      <section className="stack" aria-labelledby="resume-heading">
        <h2 id="resume-heading" className="eyebrow">
          Resume
        </h2>
        {activeSessions.length === 0 ? (
          <p className="muted">No active session.</p>
        ) : (
          activeSessions.map((session) => <ResumeCard key={session.id} session={session} />)
        )}
      </section>

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
