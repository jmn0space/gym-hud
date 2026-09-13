import { useEffect, useState } from "react";

import { fetchHealth, type HealthState } from "../api/health";

const HEALTH_TIMEOUT_MS = 5000;

type DisplayState = HealthState | "checking";

const messages: Record<DisplayState, string> = {
  checking: "Checking server…",
  ok: "Server online",
  degraded: "Server reachable, database unavailable",
  unreachable: "Server unreachable",
};

export function HealthStatus() {
  const [state, setState] = useState<DisplayState>("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      controller.abort();
    }, HEALTH_TIMEOUT_MS);
    let current = true;

    void fetchHealth(controller.signal).then((result) => {
      if (current) {
        setState(result);
      }
    });

    return () => {
      current = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  function recheck() {
    setState("checking");
    setAttempt((value) => value + 1);
  }

  return (
    <section className="health" aria-labelledby="health-heading">
      <h2 id="health-heading" className="eyebrow">
        Server
      </h2>
      <p className={`health__status health__status--${state}`} role="status">
        {messages[state]}
      </p>
      <button
        type="button"
        className="button button--quiet"
        onClick={recheck}
        disabled={state === "checking"}
      >
        Check again
      </button>
    </section>
  );
}
