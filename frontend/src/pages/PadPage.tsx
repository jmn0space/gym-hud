import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { Page } from "../components/Page";
import { formatDuration, TimerDisplay } from "../components/TimerDisplay";
import { isRetryableWriteError, useLocalData } from "../local/LocalDataProvider";
import {
  buildPadSessionView,
  DEFAULT_WALKING_SETTINGS,
  derivePadElapsedMs,
  discardWalkingSessionAction,
  findActiveWalkingSessionRecord,
  findPreviousWalkingSession,
  finishWalkingSessionAction,
  hasReachedMaximum,
  hasUnreadableOpenRecords,
  inheritedWalkingSettings,
  parseWalkingSessionSummary,
  PREVIOUS_WALKING_SESSION_KEY,
  readPadSession,
  startWalkingBoutAction,
  startWalkingSessionAction,
  summarizeWalkingSession,
  useNow,
  walkingElapsedMs,
  walkingSessionSummaryValue,
  type PadSessionView,
  type PreviousWalkingSession,
  type WalkingSessionSettings,
  type WalkingState,
} from "../pad";
import { createUuid, type LocalAction } from "../storage";

/**
 * One attempt at a logical operation: the identifiers the action writes with, and
 * the timestamp the domain records.
 */
interface CommitAttempt {
  actionId: string;
  recordId: string;
  now: Date;
}

/**
 * How long an attempt stays pinned. Inside this window a resubmission is the same
 * tap arriving twice, so reusing everything is right; beyond it, it is a retry of
 * something that never happened.
 */
const ATTEMPT_LIFETIME_MS = 5_000;

/**
 * The identifiers and timestamp one submission writes with.
 *
 * Within `ATTEMPT_LIFETIME_MS` they are reused verbatim, so a double tap submits a
 * byte-identical action that the repository's durable receipt answers instead of
 * writing a second session or bout. Beyond it -- a Retry tapped minutes after the
 * failure banner appeared -- a whole new attempt is minted, because the timestamp
 * is not "when the user pressed the control": it is when walking actually started,
 * and the first press started nothing. Reusing it would persist a start time from
 * before the failure and have the HUD count time nobody walked, which is the one
 * way a derived-from-timestamps timer can still be wrong.
 *
 * Minting fresh identifiers cannot duplicate anything: a failed commit aborts its
 * transaction, so it leaves neither record nor receipt, and a genuine duplicate is
 * still refused by the repository's one-active-session and one-open-bout markers.
 */
function attemptFor(attempts: Map<string, CommitAttempt>, key: string): CommitAttempt {
  const now = new Date();
  const previous = attempts.get(key);
  if (previous !== undefined && now.getTime() - previous.now.getTime() <= ATTEMPT_LIFETIME_MS) {
    return previous;
  }
  const attempt: CommitAttempt = { actionId: createUuid(), recordId: createUuid(), now };
  attempts.set(key, attempt);
  return attempt;
}

function useCommitAttempt() {
  const { commitAction } = useLocalData();
  const [inFlightCount, setInFlightCount] = useState(0);
  // Refs, not the count above: a second tap in the same tick must be rejected
  // before React has re-rendered with the disabled button. Keyed per control, so a
  // commit of one operation never silently swallows a tap on another.
  const inFlight = useRef(new Set<string>());
  const attempts = useRef(new Map<string, CommitAttempt>());

  const run = useCallback(
    (
      key: string,
      build: (attempt: CommitAttempt) => LocalAction | Promise<LocalAction>,
      committed?: () => void,
    ) => {
      if (inFlight.current.has(key)) {
        return;
      }
      inFlight.current.add(key);
      setInFlightCount((count) => count + 1);
      // The builder runs inside the provider's commit queue, so it is the queue --
      // not this tap -- that decides the moment the action is built, and a Retry
      // rebuilds rather than resubmitting a stale payload. Anything it throws is
      // surfaced through the same error path as a rejected write, which is why the
      // flag is released in `finally` rather than around `build`.
      void commitAction(() => build(attemptFor(attempts.current, key)))
        .then(() => {
          attempts.current.delete(key);
          committed?.();
        })
        .catch((error: unknown) => {
          // LocalDataProvider owns the error surface (LocalDataStatus renders it and
          // can resubmit through this very builder). An attempt that may still
          // succeed keeps its identifiers; one that never can is dropped, so the
          // next tap is a new logical action rather than a resubmission of a
          // permanently rejected one.
          if (!isRetryableWriteError(error)) {
            attempts.current.delete(key);
          }
        })
        .finally(() => {
          inFlight.current.delete(key);
          setInFlightCount((count) => count - 1);
        });
    },
    [commitAction],
  );

  return { run, submitting: inFlightCount > 0 };
}

const STATE_LABELS: Record<WalkingState, string> = {
  READY: "Ready",
  WALKING: "Walking",
  PAUSED: "Paused",
  RESTING: "Resting",
  COMPLETED: "Finished",
};

/** Which screen PAD is on, and what that screen needs. */
type PadScreen =
  | { kind: "loading" }
  | { kind: "hud"; view: PadSessionView; unreadable: boolean }
  | { kind: "unreadable" }
  | { kind: "start" };

export function PadPage() {
  const { readLiveSnapshot, setSyncMetadata, snapshot, status } = useLocalData();
  // The raw ACTIVE row is kept alongside the parsed view: a row the parser drops
  // still holds the repository's active marker, and the screen has to offer a way
  // out of that rather than a start button every tap refuses.
  const activeRecord = useMemo(
    () => (snapshot === null ? null : findActiveWalkingSessionRecord(snapshot)),
    [snapshot],
  );
  const view = useMemo(
    () =>
      snapshot === null || activeRecord === null
        ? null
        : buildPadSessionView(
            activeRecord,
            snapshot.records.walking_bouts,
            snapshot.records.walking_pauses,
            snapshot.records.walking_rests,
          ),
    [activeRecord, snapshot],
  );
  const { run, submitting } = useCommitAttempt();
  const busy = submitting || status === "saving";
  // Only a state with a running interval needs a ticking re-render.
  const now = useNow(view !== null && view.state !== "READY");

  const startSession = useCallback(
    (settings: WalkingSessionSettings) => {
      run("start-session", (attempt) =>
        startWalkingSessionAction({
          actionId: attempt.actionId,
          sessionId: attempt.recordId,
          settings,
          now: attempt.now,
        }),
      );
    },
    [run],
  );

  const startBout = useCallback(() => {
    if (view === null) {
      return;
    }
    run(`start-bout-${view.session.id}-${view.currentBoutNumber.toString()}`, (attempt) =>
      startWalkingBoutAction({
        actionId: attempt.actionId,
        boutId: attempt.recordId,
        view,
        now: attempt.now,
      }),
    );
  }, [run, view]);

  const finishSession = useCallback(() => {
    if (view === null) {
      return;
    }
    const sessionId = view.session.id;
    // Summarized from the same live snapshot the action closes, then written once
    // the commit lands, so the next start screen reads three numbers from one key
    // instead of deserializing all-time history to find them.
    let summary: PreviousWalkingSession | null = null;
    run(
      `finish-session-${sessionId}`,
      async (attempt) => {
        const live = await readLiveSnapshot();
        const action = finishWalkingSessionAction({
          actionId: attempt.actionId,
          snapshot: live,
          sessionId,
          now: attempt.now,
        });
        const liveView = readPadSession(live);
        summary =
          liveView === null ? null : summarizeWalkingSession(liveView, attempt.now.getTime());
        return action;
      },
      () => {
        if (summary !== null) {
          // Best effort: the start screen falls back to a history scan when the key
          // is missing, so a failed write costs a slower mount, never a wrong value.
          void setSyncMetadata(
            PREVIOUS_WALKING_SESSION_KEY,
            walkingSessionSummaryValue(summary),
          ).catch(() => undefined);
        }
      },
    );
  }, [readLiveSnapshot, run, setSyncMetadata, view]);

  const discardSession = useCallback(() => {
    if (activeRecord === null) {
      return;
    }
    const sessionId = activeRecord.id;
    run(`discard-session-${sessionId}`, async (attempt) => {
      const live = await readLiveSnapshot();
      return discardWalkingSessionAction({
        actionId: attempt.actionId,
        snapshot: live,
        sessionId,
        now: attempt.now,
      });
    });
  }, [activeRecord, readLiveSnapshot, run]);

  const screen = useMemo<PadScreen>(() => {
    if (snapshot === null) {
      return { kind: "loading" };
    }
    if (view !== null) {
      return { kind: "hud", view, unreadable: hasUnreadableOpenRecords(snapshot, view) };
    }
    return activeRecord === null ? { kind: "start" } : { kind: "unreadable" };
  }, [activeRecord, snapshot, view]);

  // Start and Finish swap the whole screen without navigating, so the button the
  // user just pressed is unmounted and focus would fall to <body>. `focusKey` moves
  // it to the page heading instead, the same way AppLayout does after navigation.
  return (
    <Page
      heading="PAD walking"
      focusKey={screen.kind === "loading" ? undefined : screen.kind}
    >
      {screen.kind === "loading" ? (
        <p className="muted">
          {status === "loading"
            ? "Checking this device for an active session…"
            : "Saved sessions are unavailable on this device."}
        </p>
      ) : screen.kind === "hud" ? (
        <WalkingHud
          busy={busy}
          now={now}
          onFinishSession={finishSession}
          onStartBout={startBout}
          unreadable={screen.unreadable}
          view={screen.view}
        />
      ) : screen.kind === "unreadable" ? (
        <UnreadableSession busy={busy} onDiscard={discardSession} />
      ) : (
        <WalkingStartScreen busy={busy} onStart={startSession} />
      )}
    </Page>
  );
}

interface SettingsDraft {
  speed: string;
  incline: string;
  maxBoutMinutes: string;
}

/**
 * The shortest decimal that still reads back as the stored value. Inheritance has
 * to be a faithful carry-forward: `toFixed(1)` presents a stored 5.65 km/h as
 * "5.7" and then *persists* 5.7 on Start, quietly rewriting a setting the user
 * only meant to carry over. One decimal stays the normal rendering ("5.0"),
 * because for the values that reach it, it round-trips.
 */
function decimalText(value: number): string {
  const oneDecimal = value.toFixed(1);
  return Number(oneDecimal) === value ? oneDecimal : value.toString();
}

/**
 * The maximum is stored in seconds but edited in minutes: "8" is what the user
 * thinks in, and it keeps the control a single short numeric field. Two decimals
 * round-trip through `Math.round(minutes * 60)` for any whole number of seconds,
 * so an inherited 445 s shows as "7.42" and is stored back as 445 s -- where the
 * exact quotient would render 7.416666666666667.
 */
function minutesDraft(seconds: number): string {
  const minutes = seconds / 60;
  const rounded = Number(minutes.toFixed(2));
  return Math.round(rounded * 60) === seconds ? rounded.toString() : minutes.toString();
}

function draftFrom(settings: WalkingSessionSettings): SettingsDraft {
  return {
    speed: decimalText(settings.speed_kmh),
    incline: decimalText(settings.incline_pct),
    maxBoutMinutes: minutesDraft(settings.max_bout_seconds),
  };
}

/** Each field's value, or `null` when it is blank or out of range. */
interface ParsedDraft {
  speed: number | null;
  incline: number | null;
  minutes: number | null;
}

function fieldValue(raw: string, accepts: (value: number) => boolean): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && accepts(value) ? value : null;
}

function parseDraft(draft: SettingsDraft): ParsedDraft {
  return {
    speed: fieldValue(draft.speed, (value) => value > 0),
    incline: fieldValue(draft.incline, (value) => value >= 0),
    minutes: fieldValue(draft.maxBoutMinutes, (value) => value > 0),
  };
}

function draftSettings(parsed: ParsedDraft): WalkingSessionSettings | null {
  if (parsed.speed === null || parsed.incline === null || parsed.minutes === null) {
    return null;
  }
  return {
    speed_kmh: parsed.speed,
    incline_pct: parsed.incline,
    max_bout_seconds: Math.round(parsed.minutes * 60),
  };
}

type PreviousState =
  | { kind: "loading" }
  | { kind: "ready"; session: PreviousWalkingSession | null }
  | { kind: "unavailable" };

interface WalkingStartScreenProps {
  busy: boolean;
  onStart: (settings: WalkingSessionSettings) => void;
}

function WalkingStartScreen({ busy, onStart }: WalkingStartScreenProps) {
  // Read through the provider's repository rather than through props: the reads
  // below are this screen's own, and routing three of them through PadPage would
  // say nothing extra about where the data comes from.
  const { getSyncMetadata, listRecords, setSyncMetadata } = useLocalData();
  const settingsHeadingId = useId();
  const lastSessionHeadingId = useId();
  const speedId = useId();
  const inclineId = useId();
  const maxBoutId = useId();
  const validationId = useId();
  const [previous, setPrevious] = useState<PreviousState>({ kind: "loading" });
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFrom(DEFAULT_WALKING_SETTINGS));
  // Never overwrite what the user has already typed with the inherited values.
  const edited = useRef(false);

  // Completed sessions are outside the recovery snapshot (it is bounded to live
  // ACTIVE state), so the summary written when a session completes is what
  // inheritance reads. Scanning history is the fallback for data that predates
  // that summary, and the result is written back so it happens at most once.
  useEffect(() => {
    const live = { current: true };
    // Read through a call so each resumption point genuinely re-checks it: the
    // effect may be torn down during either of the awaits below.
    const cancelled = () => !live.current;
    const apply = (session: PreviousWalkingSession | null) => {
      setPrevious({ kind: "ready", session });
      if (!edited.current) {
        setDraft(draftFrom(inheritedWalkingSettings(session)));
      }
    };
    void (async () => {
      try {
        const stored = parseWalkingSessionSummary(
          await getSyncMetadata(PREVIOUS_WALKING_SESSION_KEY),
        );
        if (cancelled()) {
          return;
        }
        if (stored !== null) {
          apply(stored);
          return;
        }
        const [sessions, bouts, pauses] = await Promise.all([
          listRecords("walking_sessions"),
          listRecords("walking_bouts"),
          listRecords("walking_pauses"),
        ]);
        if (cancelled()) {
          return;
        }
        const scanned = findPreviousWalkingSession({ sessions, bouts, pauses });
        apply(scanned);
        if (scanned !== null) {
          void setSyncMetadata(
            PREVIOUS_WALKING_SESSION_KEY,
            walkingSessionSummaryValue(scanned),
          ).catch(() => undefined);
        }
      } catch {
        if (!cancelled()) {
          setPrevious({ kind: "unavailable" });
        }
      }
    })();

    return () => {
      live.current = false;
    };
  }, [getSyncMetadata, listRecords, setSyncMetadata]);

  const parsed = parseDraft(draft);
  const settings = draftSettings(parsed);
  // The message says why Start is disabled, so the fields point at it: a screen
  // reader user otherwise meets a disabled control with no stated reason.
  const describedBy = settings === null ? validationId : undefined;
  const update = (field: keyof SettingsDraft) => (value: string) => {
    edited.current = true;
    setDraft((current) => ({ ...current, [field]: value }));
  };

  return (
    <>
      <form
        className="stack"
        aria-labelledby={settingsHeadingId}
        onSubmit={(event) => {
          event.preventDefault();
          if (settings !== null && !busy) {
            onStart(settings);
          }
        }}
      >
        <h2 className="eyebrow" id={settingsHeadingId}>
          Treadmill settings
        </h2>
        {/* `step="any"`: a value inherited from the previous session is carried
            forward exactly, and a stepped control would refuse to submit one that
            does not land on its increment (5.65 km/h against a 0.1 step). */}
        <div className="field">
          <label htmlFor={speedId}>Speed (km/h)</label>
          <input
            aria-describedby={describedBy}
            aria-invalid={parsed.speed === null}
            className="text-input"
            id={speedId}
            inputMode="decimal"
            min="0.1"
            onChange={(event) => {
              update("speed")(event.target.value);
            }}
            step="any"
            type="number"
            value={draft.speed}
          />
        </div>
        <div className="field">
          <label htmlFor={inclineId}>Incline (%)</label>
          <input
            aria-describedby={describedBy}
            aria-invalid={parsed.incline === null}
            className="text-input"
            id={inclineId}
            inputMode="decimal"
            min="0"
            onChange={(event) => {
              update("incline")(event.target.value);
            }}
            step="any"
            type="number"
            value={draft.incline}
          />
        </div>
        <div className="field">
          <label htmlFor={maxBoutId}>Maximum bout (minutes)</label>
          <input
            aria-describedby={describedBy}
            aria-invalid={parsed.minutes === null}
            className="text-input"
            id={maxBoutId}
            inputMode="decimal"
            min="0.5"
            onChange={(event) => {
              update("maxBoutMinutes")(event.target.value);
            }}
            step="any"
            type="number"
            value={draft.maxBoutMinutes}
          />
        </div>
        {settings === null && (
          <p className="muted" id={validationId}>
            Enter a speed, an incline and a maximum bout to start.
          </p>
        )}
        <button className="button button--primary" disabled={settings === null || busy} type="submit">
          Start
        </button>
      </form>

      <section className="card" aria-labelledby={lastSessionHeadingId}>
        <h2 className="eyebrow" id={lastSessionHeadingId}>
          Last session
        </h2>
        {previous.kind === "loading" ? (
          <p className="muted">Checking this device for a previous session…</p>
        ) : previous.kind === "unavailable" ? (
          <p className="muted">
            Previous sessions could not be read on this device, so the application defaults are
            shown above.
          </p>
        ) : previous.session === null ? (
          <p className="muted">
            No completed walking session yet, so the application defaults are shown above.
          </p>
        ) : (
          <>
            <p>
              {previous.session.boutCount.toString()}{" "}
              {previous.session.boutCount === 1 ? "bout" : "bouts"} ·{" "}
              {formatDuration(previous.session.walkingMs)} walking
            </p>
            <p className="muted">
              {decimalText(previous.session.settings.speed_kmh)} km/h · Incline{" "}
              {decimalText(previous.session.settings.incline_pct)}% · Maximum bout{" "}
              {formatDuration(previous.session.settings.max_bout_seconds * 1000)}
            </p>
          </>
        )}
      </section>
    </>
  );
}

interface UnreadableSessionProps {
  busy: boolean;
  onDiscard: () => void;
}

/**
 * The escape from a saved session this build cannot read.
 *
 * The repository still counts such a session as the device's one ACTIVE walking
 * session, so starting another is refused inside the write transaction. Without
 * this screen the refusal is all the user ever sees -- the HUD that owns FINISH
 * SESSION never renders -- and PAD stays dead for the life of the install.
 */
function UnreadableSession({ busy, onDiscard }: UnreadableSessionProps) {
  const headingId = useId();

  return (
    <section className="card" aria-labelledby={headingId}>
      <h2 className="eyebrow" id={headingId}>
        Unreadable session
      </h2>
      <p>
        A walking session is saved on this device, but its record cannot be read, so it cannot be
        shown or resumed.
      </p>
      <p className="muted">
        Discarding it releases this device to start a new session. The record is kept, marked as
        discarded; nothing is deleted.
      </p>
      <button className="button button--primary" disabled={busy} onClick={onDiscard} type="button">
        Discard session
      </button>
    </section>
  );
}

interface WalkingHudProps {
  busy: boolean;
  now: number;
  onFinishSession: () => void;
  onStartBout: () => void;
  /** Whether this session has open records the parser dropped. */
  unreadable: boolean;
  view: PadSessionView;
}

function WalkingHud({
  busy,
  now,
  onFinishSession,
  onStartBout,
  unreadable,
  view,
}: WalkingHudProps) {
  const hudHeadingId = useId();
  const boutsHeadingId = useId();
  const elapsedMs = derivePadElapsedMs(view, now);
  const maximumReached = hasReachedMaximum(view, now);
  const finishedBouts = view.bouts.filter((bout) => bout.ended_at !== null);

  return (
    <>
      <section className="pad-hud" aria-labelledby={hudHeadingId}>
        <h2 className="eyebrow" id={hudHeadingId}>
          Walking session
        </h2>
        <p className="muted">
          {decimalText(view.session.speed_kmh)} km/h · Incline{" "}
          {decimalText(view.session.incline_pct)}% · Maximum bout{" "}
          {formatDuration(view.session.max_bout_seconds * 1000)}
        </p>
        <p className="pad-hud__bout">Bout {view.currentBoutNumber.toString()}</p>
        {/* Announced on transition; the timer below it is not a live region, or it
            would be read out every second. */}
        <p className="pad-hud__state" role="status">
          {STATE_LABELS[view.state]}
          {maximumReached && <span className="pad-hud__alert"> · Maximum reached</span>}
        </p>
        {elapsedMs !== null && <TimerDisplay durationMs={elapsedMs} />}
        {view.state === "PAUSED" && view.currentBout !== null && (
          <p className="muted">
            Walking {formatDuration(walkingElapsedMs(view.currentBout, view.pauses, now))}
          </p>
        )}
        {/* Said here rather than left to a conflict message: the device still
            counts the unreadable interval, so starting another bout can only be
            refused until the session that owns it is finished. */}
        {unreadable && (
          <p className="muted">
            Part of this session was saved in a form this device cannot read, so it is not shown
            here and another bout may be refused. Finish the session to close it.
          </p>
        )}

        {view.state === "READY" ? (
          <button className="button button--primary" disabled={busy} onClick={onStartBout} type="button">
            Start walking
          </button>
        ) : (
          <p className="muted">
            {view.state === "WALKING"
              ? "Pausing, pain and finishing a bout arrive in a later update. Finish the session to close this bout."
              : "Resuming and starting the next bout arrive in a later update. Finish the session to close this interval."}
          </p>
        )}
        <button className="button" disabled={busy} onClick={onFinishSession} type="button">
          Finish session
        </button>
      </section>

      {finishedBouts.length > 0 && (
        <section className="stack" aria-labelledby={boutsHeadingId}>
          <h2 className="eyebrow" id={boutsHeadingId}>
            Completed bouts
          </h2>
          <ul className="pad-bouts">
            {finishedBouts.map((bout) => (
              <li key={bout.id}>
                <span>Bout {bout.bout_number.toString()}</span>
                <span className="timer timer--inline">
                  {formatDuration(walkingElapsedMs(bout, view.pauses, now))}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
