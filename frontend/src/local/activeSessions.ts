import type { LocalRecord, RecoverySnapshot } from "../storage";
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

function isOpen(record: LocalRecord, endField = "ended_at"): boolean {
  return record[endField] === null || record[endField] === undefined;
}

function elapsedSince(start: number | undefined, now: number): number | undefined {
  return start === undefined ? undefined : Math.max(0, now - start);
}

function latest(records: readonly LocalRecord[], field: string): LocalRecord | undefined {
  return records.reduce<LocalRecord | undefined>((selected, record) => {
    if (selected === undefined) {
      return record;
    }
    return (timestamp(record, field) ?? 0) >= (timestamp(selected, field) ?? 0)
      ? record
      : selected;
  }, undefined);
}

function padSummary(snapshot: RecoverySnapshot, session: LocalRecord, now: number): ActiveSessionSummary {
  const bouts = snapshot.records.walking_bouts.filter(
    (bout) => text(bout, "walking_session_id") === session.id,
  );
  const boutIds = new Set(bouts.map((bout) => bout.id));
  const openBout = latest(
    bouts.filter((bout) => isOpen(bout) && timestamp(bout, "started_at") !== undefined),
    "started_at",
  );
  const openPause = latest(
    snapshot.records.walking_pauses.filter(
      (pause) =>
        openBout !== undefined &&
        text(pause, "walking_bout_id") === openBout.id &&
        isOpen(pause),
    ),
    "started_at",
  );

  if (openPause !== undefined) {
    const summary: ActiveSessionSummary = {
      id: session.id,
      title: "PAD Walking",
      status: "Paused",
      href: routes.pad,
    };
    const elapsedMs = elapsedSince(timestamp(openPause, "started_at"), now);
    return elapsedMs === undefined ? summary : { ...summary, elapsedMs };
  }

  if (openBout !== undefined) {
    const boutStart = timestamp(openBout, "started_at");
    const pausedMs = snapshot.records.walking_pauses
      .filter((pause) => text(pause, "walking_bout_id") === openBout.id)
      .reduce((total, pause) => {
        const pauseStart = timestamp(pause, "started_at");
        if (pauseStart === undefined) {
          return total;
        }
        const pauseEnd = timestamp(pause, "ended_at") ?? now;
        return total + Math.max(0, pauseEnd - pauseStart);
      }, 0);
    const rawElapsed = elapsedSince(boutStart, now);
    const summary: ActiveSessionSummary = {
      id: session.id,
      title: "PAD Walking",
      status: "Walking",
      href: routes.pad,
    };
    return rawElapsed === undefined
      ? summary
      : { ...summary, elapsedMs: Math.max(0, rawElapsed - pausedMs) };
  }

  const openRest = latest(
    snapshot.records.walking_rests.filter(
      (rest) => boutIds.has(text(rest, "walking_bout_id") ?? "") && isOpen(rest),
    ),
    "started_at",
  );
  if (openRest !== undefined) {
    const summary: ActiveSessionSummary = {
      id: session.id,
      title: "PAD Walking",
      status: "Resting",
      href: routes.pad,
    };
    const elapsedMs = elapsedSince(timestamp(openRest, "started_at"), now);
    return elapsedMs === undefined ? summary : { ...summary, elapsedMs };
  }

  return { id: session.id, title: "PAD Walking", status: "Ready", href: routes.pad };
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
  return [
    ...snapshot.records.walking_sessions.filter(active).map((session) => padSummary(snapshot, session, now)),
    ...snapshot.records.resistance_sessions
      .filter(active)
      .map((session) => resistanceSummary(snapshot, session)),
    ...snapshot.records.cardio_sessions.filter(active).map((session) => cardioSummary(session, now)),
  ];
}
