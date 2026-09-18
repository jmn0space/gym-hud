import type { LocalRecord, RecoverySnapshot } from "../storage";
import { derivePadElapsedMs, readPadSession, type PadSessionView } from "../pad";
import { routes } from "../routes";
import type { ActiveSessionSummary } from "../components/ResumeCard";

function text(record: LocalRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

function timestamp(record: LocalRecord, field: string): number | undefined {
  const value = text(record, field);
  if (value === undefined) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function elapsedSince(start: number | undefined, now: number): number | undefined {
  return start === undefined ? undefined : Math.max(0, now - start);
}

/**
 * The PAD card's state line. It names the bout as well as the state, so the card
 * says enough to resume from: "Walking" alone does not tell you which bout the
 * phone was in the middle of when it was force-stopped.
 */
function padStatus(view: PadSessionView): string {
  const bout = view.currentBoutNumber.toString();
  switch (view.state) {
    case "WALKING":
      return `Walking · Bout ${bout}`;
    case "PAUSED":
      return `Paused · Bout ${bout}`;
    case "RESTING":
      return `Resting after bout ${view.currentBout?.bout_number.toString() ?? bout}`;
    case "READY":
    case "COMPLETED":
      return `Ready to start bout ${bout}`;
  }
}

function padSummary(view: PadSessionView, now: number): ActiveSessionSummary {
  const summary: ActiveSessionSummary = {
    id: view.session.id,
    title: "PAD Walking",
    status: padStatus(view),
    href: routes.pad,
  };
  const elapsedMs = derivePadElapsedMs(view, now);
  return elapsedMs === null ? summary : { ...summary, elapsedMs };
}

function resistanceSummary(
  snapshot: RecoverySnapshot,
  session: LocalRecord,
): ActiveSessionSummary {
  const rows = snapshot.records.resistance_rows.filter(
    (row) => text(row, "resistance_session_id") === session.id,
  );
  const completed = rows.filter((row) => row.completed === true).length;
  const storedTitle = text(session, "title") ?? text(session, "routine_name");
  return {
    id: session.id,
    title: storedTitle ?? "Resistance Training",
    status:
      rows.length > 0
        ? `${completed.toString()} / ${rows.length.toString()} exercises complete`
        : "Session in progress",
    href: routes.resistance,
  };
}

function cardioSummary(session: LocalRecord, now: number): ActiveSessionSummary {
  const machine = text(session, "machine_name");
  const summary: ActiveSessionSummary = {
    id: session.id,
    title: machine === undefined ? "Cardio Machine" : `Cardio · ${machine}`,
    status: "In progress",
    href: routes.cardio,
  };
  const elapsedMs = elapsedSince(timestamp(session, "started_at"), now);
  return elapsedMs === undefined ? summary : { ...summary, elapsedMs };
}

/** Derive resumable cards entirely from the last persisted snapshot. */
export function deriveActiveSessionSummaries(
  snapshot: RecoverySnapshot,
  now: number,
): ActiveSessionSummary[] {
  const active = (record: LocalRecord) => record.status === "ACTIVE";
  const pad = readPadSession(snapshot);
  return [
    ...(pad === null ? [] : [padSummary(pad, now)]),
    ...snapshot.records.resistance_sessions
      .filter(active)
      .map((session) => resistanceSummary(snapshot, session)),
    ...snapshot.records.cardio_sessions.filter(active).map((session) => cardioSummary(session, now)),
  ];
}
