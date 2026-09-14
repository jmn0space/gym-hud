import { apiUrl } from "./config";

export type HealthState = "ok" | "degraded" | "unreachable";

interface HealthPayload {
  status: string;
  database: { connected: boolean };
}

function isHealthPayload(value: unknown): value is HealthPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { status, database } = value as Record<string, unknown>;
  return (
    typeof status === "string" &&
    typeof database === "object" &&
    database !== null &&
    typeof (database as Record<string, unknown>).connected === "boolean"
  );
}

/**
 * Probe the backend health endpoint. Never throws: any network, abort, or
 * contract failure is reported as "unreachable".
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthState> {
  try {
    const response = await fetch(apiUrl("/api/v1/health/"), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: signal ?? null,
    });
    // The endpoint answers 503 with a JSON body when the database is down.
    if (response.status !== 200 && response.status !== 503) {
      return "unreachable";
    }
    const payload: unknown = await response.json();
    if (!isHealthPayload(payload)) {
      return "unreachable";
    }
    return payload.status === "ok" && payload.database.connected ? "ok" : "degraded";
  } catch {
    return "unreachable";
  }
}
