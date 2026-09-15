import { API_BASE_URL, apiUrl } from "./config";

export type ApiErrorCode =
  | "not_authenticated"
  | "csrf_failed"
  | "invalid_credentials"
  | "invalid_request"
  | "throttled"
  | "network"
  | "unknown";

/** Raised for any non-2xx API response, or when the request itself fails. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type UnauthenticatedListener = () => void;
const unauthenticatedListeners = new Set<UnauthenticatedListener>();

/**
 * Lets the auth provider learn about a 401 from any `apiFetch` call, anywhere
 * in the app, without every call site having to report it individually. The
 * only current subscriber flips authenticated -> expired.
 */
export function onUnauthenticated(listener: UnauthenticatedListener): () => void {
  unauthenticatedListeners.add(listener);
  return () => {
    unauthenticatedListeners.delete(listener);
  };
}

function notifyUnauthenticated(): void {
  for (const listener of unauthenticatedListeners) {
    listener();
  }
}

// Dev uses a same-origin Vite proxy and production is a same-origin deployment,
// so cookies just work with "same-origin". A cross-origin API base (a non-empty
// API_BASE_URL) needs "include" instead, or the browser will not send/accept them.
const CREDENTIALS: RequestCredentials = API_BASE_URL === "" ? "same-origin" : "include";

const CSRF_COOKIE_NAME = "csrftoken";
const CSRF_HEADER_NAME = "X-CSRFToken";
export const SESSION_PATH = "/api/v1/auth/session/" as const;

function readCsrfCookie(): string | undefined {
  const prefix = `${CSRF_COOKIE_NAME}=`;
  const entry = document.cookie.split("; ").find((part) => part.startsWith(prefix));
  return entry === undefined ? undefined : decodeURIComponent(entry.slice(prefix.length));
}

/**
 * GETs the public session endpoint purely to (re)issue the `csrftoken` cookie.
 * Used both to obtain a first CSRF token and, after a `csrf_failed` 403, to pick
 * up the rotated one (Django rotates the CSRF token on login).
 */
async function primeCsrfCookie(): Promise<void> {
  await fetch(apiUrl(SESSION_PATH), {
    method: "GET",
    credentials: CREDENTIALS,
    headers: { Accept: "application/json" },
  }).catch(() => undefined);
}

async function ensureCsrfToken(): Promise<string | undefined> {
  const existing = readCsrfCookie();
  if (existing !== undefined) {
    return existing;
  }
  await primeCsrfCookie();
  return readCsrfCookie();
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isKnownCode(code: string): code is ApiErrorCode {
  return (
    code === "not_authenticated" ||
    code === "csrf_failed" ||
    code === "invalid_credentials" ||
    code === "invalid_request" ||
    code === "throttled" ||
    code === "unknown"
  );
}

function codeFromPayload(payload: unknown): ApiErrorCode | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const { code } = payload as Record<string, unknown>;
  return typeof code === "string" && isKnownCode(code) ? code : undefined;
}

function detailFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const { detail } = payload as Record<string, unknown>;
  return typeof detail === "string" ? detail : undefined;
}

export interface ApiFetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Attaches X-CSRFToken, fetching the cookie first if it is not already set. */
  csrf?: boolean;
  signal?: AbortSignal | undefined;
}

/**
 * Central JSON fetch wrapper for the Django API. Always sends the session
 * cookie, attaches a CSRF header for unsafe requests, tells `onUnauthenticated`
 * subscribers about any 401 so authenticated -> expired happens no matter which
 * call triggered it, and retries once after a `csrf_failed` 403 by refetching
 * the session (Django rotates the CSRF token on login, so a stale cookie here
 * is an expected occasional case rather than a hard failure).
 */
export async function apiFetch<T>(path: `/${string}`, options: ApiFetchOptions = {}): Promise<T> {
  return performFetch<T>(path, options, false);
}

async function performFetch<T>(
  path: `/${string}`,
  options: ApiFetchOptions,
  retried: boolean,
): Promise<T> {
  const { method = "GET", body, csrf = false, signal } = options;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (csrf) {
    const token = await ensureCsrfToken();
    if (token !== undefined) {
      headers[CSRF_HEADER_NAME] = token;
    }
  }

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      credentials: CREDENTIALS,
      headers,
      signal: signal ?? null,
      // exactOptionalPropertyTypes: RequestInit.body rejects an explicit
      // `undefined`, so the key is only present when there is a body to send.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "network", "The network request failed.");
  }

  if (response.status === 401) {
    notifyUnauthenticated();
    const payload = await safeJson(response);
    throw new ApiError(401, codeFromPayload(payload) ?? "not_authenticated", detailFromPayload(payload));
  }

  if (response.status === 403 && !retried) {
    const payload = await safeJson(response);
    if (codeFromPayload(payload) === "csrf_failed") {
      await primeCsrfCookie();
      return performFetch<T>(path, options, true);
    }
    throw new ApiError(403, "csrf_failed", detailFromPayload(payload));
  }

  if (response.status === 429) {
    throw new ApiError(429, "throttled");
  }

  if (!response.ok) {
    const payload = await safeJson(response);
    throw new ApiError(response.status, codeFromPayload(payload) ?? "unknown", detailFromPayload(payload));
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
