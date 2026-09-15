import { apiFetch, SESSION_PATH } from "./client";

export interface SessionStatus {
  authenticated: boolean;
  username: string | null;
}

function isSessionStatus(value: unknown): value is SessionStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { authenticated, username } = value as Record<string, unknown>;
  return typeof authenticated === "boolean" && (username === null || typeof username === "string");
}

/**
 * Public endpoint: also (re)issues the `csrftoken` cookie as a side effect, so
 * this is the endpoint the CSRF-retry path in api/client.ts re-fetches too.
 */
export async function fetchSession(signal?: AbortSignal): Promise<SessionStatus> {
  const result = await apiFetch<SessionStatus>(SESSION_PATH, { signal });
  if (!isSessionStatus(result)) {
    throw new Error("Session endpoint returned an unexpected payload");
  }
  return result;
}

export async function login(username: string, password: string): Promise<SessionStatus> {
  const result = await apiFetch<SessionStatus>("/api/v1/auth/login/", {
    method: "POST",
    body: { username, password },
    csrf: true,
  });
  if (!isSessionStatus(result)) {
    throw new Error("Login endpoint returned an unexpected payload");
  }
  return result;
}

export async function logout(): Promise<void> {
  await apiFetch<undefined>("/api/v1/auth/logout/", { method: "POST", csrf: true });
}
