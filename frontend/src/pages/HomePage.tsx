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

      <section className="stack" aria-labelledby="start-heading">
        <h2 id="start-heading" className="eyebrow">
          Start new
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
        <Link className="button" to={routes.history}>
          History
        </Link>
      </section>

      <HealthStatus />
    </Page>
  );
}
