import { useId } from "react";
import { Link } from "react-router";

import { TimerDisplay } from "./TimerDisplay";

/** Compact summary of one active session, as shown on the Home screen. */
export interface ActiveSessionSummary {
  id: string;
  /** Session type, e.g. "PAD Walking" or "Day 3". */
  title: string;
  /** Current state, e.g. "Resting" or "4 / 7 exercises complete". */
  status: string;
  /** Elapsed time in the current state, derived from persisted timestamps. */
  elapsedMs?: number;
  href: string;
}

export function ResumeCard({ session }: { session: ActiveSessionSummary }) {
  const headingId = useId();

  return (
    <article className="card card--highlight" aria-labelledby={headingId}>
      <h3 id={headingId} className="card__title">
        {session.title}
      </h3>
      <p className="resume-card__status">
        <span>{session.status}</span>
        {session.elapsedMs !== undefined && (
          <TimerDisplay durationMs={session.elapsedMs} size="compact" />
        )}
      </p>
      <Link className="button button--primary" to={session.href}>
        Resume <span className="visually-hidden">{session.title}</span>
      </Link>
    </article>
  );
}
