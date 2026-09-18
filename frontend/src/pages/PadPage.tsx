import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { Page } from "../components/Page";
import { formatDuration, TimerDisplay } from "../components/TimerDisplay";
import { useLocalData } from "../local/LocalDataProvider";
import {
  DEFAULT_WALKING_SETTINGS,
  derivePadElapsedMs,
  findPreviousWalkingSession,
  finishWalkingSessionAction,
  hasReachedMaximum,
  inheritedWalkingSettings,
  readPadSession,
  startWalkingBoutAction,
  startWalkingSessionAction,
  useNow,
  walkingElapsedMs,
  type PadSessionView,
  type PreviousWalkingSession,
  type WalkingSessionSettings,
  type WalkingState,
} from "../pad";
import { createUuid, type LocalAction } from "../storage";

/**
 * One attempt at a logical operation. The identifiers and the timestamp are minted
 * once and reused until that attempt succeeds, so a double tap or a retry submits
 * a byte-identical action: the repository then answers from its durable receipt
 * instead of creating a second session or bout. Reusing the timestamp is also the
 * honest reading of it -- it records when the user pressed the control, not when a
 * retried write eventually landed.
 */
interface CommitAttempt {
  actionId: string;
  recordId: string;
  now: Date;
}

function useCommitAttempt() {
  const { commitAction } = useLocalData();
  const [submitting, setSubmitting] = useState(false);
  // A ref, not the state above: a second tap in the same tick must be rejected
  // before React has re-rendered with the disabled button.
  const inFlight = useRef(false);
  const attempts = useRef(new Map<string, CommitAttempt>());

  const run = useCallback(
    (key: string, build: (attempt: CommitAttempt) => LocalAction) => {
      if (inFlight.current) {
        return;
      }
      let attempt = attempts.current.get(key);
      if (attempt === undefined) {
        attempt = { actionId: createUuid(), recordId: createUuid(), now: new Date() };
        attempts.current.set(key, attempt);
      }
      inFlight.current = true;
      setSubmitting(true);
      void commitAction(build(attempt))
        .then(() => {
          attempts.current.delete(key);
        })
        .catch(() => {
          // LocalDataProvider owns the error surface (LocalDataStatus renders it and
          // can resubmit the very same action). Keeping this attempt's identifiers
          // means that resubmission stays the same logical action.
        })
        .finally(() => {
          inFlight.current = false;
          setSubmitting(false);
        });
    },
    [commitAction],
  );

  return { run, submitting };
}

const STATE_LABELS: Record<WalkingState, string> = {
  READY: "Ready",
  WALKING: "Walking",
  PAUSED: "Paused",
  RESTING: "Resting",
  COMPLETED: "Finished",
};

export function PadPage() {
  const { listRecords, snapshot, status } = useLocalData();
  const view = useMemo(() => (snapshot === null ? null : readPadSession(snapshot)), [snapshot]);
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
    run(`finish-session-${view.session.id}`, (attempt) =>
      finishWalkingSessionAction({ actionId: attempt.actionId, view, now: attempt.now }),
    );
  }, [run, view]);

  if (snapshot === null) {
    return (
      <Page heading="PAD walking">
        <p className="muted">
          {status === "loading"
            ? "Checking this device for an active session…"
            : "Saved sessions are unavailable on this device."}
        </p>
      </Page>
    );
  }

  return (
    <Page heading="PAD walking">
      {view === null ? (
        <WalkingStartScreen busy={busy} listRecords={listRecords} onStart={startSession} />
      ) : (
        <WalkingHud
          busy={busy}
          now={now}
          onFinishSession={finishSession}
          onStartBout={startBout}
          view={view}
        />
      )}
    </Page>
  );
}

interface SettingsDraft {
  speed: string;
  incline: string;
  maxBoutMinutes: string;
}

function draftFrom(settings: WalkingSessionSettings): SettingsDraft {
  return {
    speed: settings.speed_kmh.toFixed(1),
    incline: settings.incline_pct.toFixed(1),
    maxBoutMinutes: (settings.max_bout_seconds / 60).toString(),
  };
}

/**
 * The maximum is stored in seconds but edited in minutes: "8" is what the user
 * thinks in, and it keeps the control a single short numeric field.
 */
function parseDraft(draft: SettingsDraft): WalkingSessionSettings | null {
  const speed = Number(draft.speed.trim());
  const incline = Number(draft.incline.trim());
  const minutes = Number(draft.maxBoutMinutes.trim());
  if (draft.speed.trim() === "" || draft.incline.trim() === "" || draft.maxBoutMinutes.trim() === "") {
    return null;
  }
  if (!Number.isFinite(speed) || speed <= 0) {
    return null;
  }
  if (!Number.isFinite(incline) || incline < 0) {
    return null;
  }
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  return {
    speed_kmh: speed,
    incline_pct: incline,
    max_bout_seconds: Math.round(minutes * 60),
  };
}

type PreviousState =
  | { kind: "loading" }
  | { kind: "ready"; session: PreviousWalkingSession | null }
  | { kind: "unavailable" };

interface WalkingStartScreenProps {
  busy: boolean;
  listRecords: ReturnType<typeof useLocalData>["listRecords"];
  onStart: (settings: WalkingSessionSettings) => void;
}

function WalkingStartScreen({ busy, listRecords, onStart }: WalkingStartScreenProps) {
  const settingsHeadingId = useId();
  const lastSessionHeadingId = useId();
  const speedId = useId();
  const inclineId = useId();
  const maxBoutId = useId();
  const [previous, setPrevious] = useState<PreviousState>({ kind: "loading" });
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFrom(DEFAULT_WALKING_SETTINGS));
  // Never overwrite what the user has already typed with the inherited values.
  const edited = useRef(false);

  // Completed sessions are outside the recovery snapshot (it is bounded to live
  // ACTIVE state), so inheritance reads history through the provider's repository.
  useEffect(() => {
    const live = { current: true };
    void (async () => {
      try {
        const [sessions, bouts, pauses] = await Promise.all([
          listRecords("walking_sessions"),
          listRecords("walking_bouts"),
          listRecords("walking_pauses"),
        ]);
        if (!live.current) {
          return;
        }
        const session = findPreviousWalkingSession({ sessions, bouts, pauses });
        setPrevious({ kind: "ready", session });
        if (!edited.current) {
          setDraft(draftFrom(inheritedWalkingSettings(session)));
        }
      } catch {
        if (live.current) {
          setPrevious({ kind: "unavailable" });
        }
      }
    })();
    return () => {
      live.current = false;
    };
  }, [listRecords]);

  const settings = parseDraft(draft);
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
        <div className="field">
          <label htmlFor={speedId}>Speed (km/h)</label>
          <input
            className="text-input"
            id={speedId}
            inputMode="decimal"
            min="0.1"
            onChange={(event) => {
              update("speed")(event.target.value);
            }}
            step="0.1"
            type="number"
            value={draft.speed}
          />
        </div>
        <div className="field">
          <label htmlFor={inclineId}>Incline (%)</label>
          <input
            className="text-input"
            id={inclineId}
            inputMode="decimal"
            min="0"
            onChange={(event) => {
              update("incline")(event.target.value);
            }}
            step="0.1"
            type="number"
            value={draft.incline}
          />
        </div>
        <div className="field">
          <label htmlFor={maxBoutId}>Maximum bout (minutes)</label>
          <input
            className="text-input"
            id={maxBoutId}
            inputMode="decimal"
            min="0.5"
            onChange={(event) => {
              update("maxBoutMinutes")(event.target.value);
            }}
            step="0.5"
            type="number"
            value={draft.maxBoutMinutes}
          />
        </div>
        {settings === null && (
          <p className="muted">Enter a speed, an incline and a maximum bout to start.</p>
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
              {previous.session.settings.speed_kmh.toFixed(1)} km/h · Incline{" "}
              {previous.session.settings.incline_pct.toFixed(1)}% · Maximum bout{" "}
              {formatDuration(previous.session.settings.max_bout_seconds * 1000)}
            </p>
          </>
        )}
      </section>
    </>
  );
}

interface WalkingHudProps {
  busy: boolean;
  now: number;
  onFinishSession: () => void;
  onStartBout: () => void;
  view: PadSessionView;
}

function WalkingHud({ busy, now, onFinishSession, onStartBout, view }: WalkingHudProps) {
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
          {view.session.speed_kmh.toFixed(1)} km/h · Incline{" "}
          {view.session.incline_pct.toFixed(1)}% · Maximum bout{" "}
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
