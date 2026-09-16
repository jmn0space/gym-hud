import { API_BASE_URL, apiUrl } from "./config";

export type ApiErrorCode =
  | "not_authenticated"
  | "csrf_failed"
  | "permission_denied"
  | "invalid_credentials"
  | "invalid_request"
  | "throttled"
  | "not_found"
  | "server_error"
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

/**
 * Called with the session generation the failing request captured when it was
 * sent (see `bumpSessionGeneration`).
 */
type UnauthenticatedListener = (generation: number) => void;
const unauthenticatedListeners = new Set<UnauthenticatedListener>();

/**
 * Lets the auth provider learn about a 401 from any `apiFetch` call, anywhere
 * in the app, without every call site having to report it individually. The
 * only current subscriber flips authenticated/unverified -> expired.
 */
export function onUnauthenticated(listener: UnauthenticatedListener): () => void {
  unauthenticatedListeners.add(listener);
  return () => {
    unauthenticatedListeners.delete(listener);
  };
}

function notifyUnauthenticated(generation: number): void {
  for (const listener of unauthenticatedListeners) {
    listener(generation);
  }
}

/**
 * Bumped by the auth provider whenever it establishes a session (a
 * successful login, or a startup/background check confirming one). A request
 * captures the current generation when it is sent; if its 401 response
 * arrives after a *newer* session has since been established, the generation
 * comparison lets the listener recognize the 401 as stale and ignore it,
 * instead of flipping the new session back to "expired" (see finding #17 of
 * the session-auth review and docs/data-sync.md).
 */
let sessionGeneration = 0;

export function bumpSessionGeneration(): number {
  sessionGeneration += 1;
  return sessionGeneration;
}

export function currentSessionGeneration(): number {
  return sessionGeneration;
}

// Dev uses a same-origin Vite proxy and production is a same-origin deployment,
// so cookies just work with "same-origin". A cross-origin API base (a non-empty
// API_BASE_URL) needs "include" instead, or the browser will not send/accept them.
// Note this does not make cross-origin authenticated calls work end to end: the
// page can only ever read a `csrftoken` cookie set for *its own* origin, so a
// cross-origin API_BASE_URL leaves this browser unable to read the API's CSRF
// cookie at all (see `readCsrfCookie`) and unsafe requests will fail CSRF
// checks. Supporting that properly (e.g. a CSRF token delivered some other
// way) is out of scope here; same-origin (dev proxy or production) is the
// supported deployment shape.
const CREDENTIALS: RequestCredentials = API_BASE_URL === "" ? "same-origin" : "include";

const CSRF_COOKIE_NAME = "csrftoken";
const CSRF_HEADER_NAME = "X-CSRFToken";
export const SESSION_PATH = "/api/v1/auth/session/" as const;

/**
 * Reads the `csrftoken` cookie. When a name appears more than once (distinct
 * paths), Django's own cookie parsing (`http.cookies.SimpleCookie`) keeps the
 * *last* occurrence, so this does the same for consistency with what the
 * server would parse back. A malformed percent-encoding is treated as "no
 * cookie" rather than thrown -- this is a CSRF token, not something that
 * should ever surface as a network-class failure (see finding #18).
 */
function readCsrfCookie(): string | undefined {
  const prefix = `${CSRF_COOKIE_NAME}=`;
  let raw: string | undefined;
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(prefix)) {
      raw = part.slice(prefix.length);
    }
  }
  if (raw === undefined) {
    return undefined;
  }
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
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
    code === "permission_denied" ||
    code === "invalid_credentials" ||
    code === "invalid_request" ||
    code === "throttled" ||
    code === "not_found" ||
    code === "server_error" ||
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
  // Captured up front so a 401 this request eventually produces is reported
  // against the session that was active when the request was *sent*, not
  // whatever is active by the time the response arrives (see finding #17).
  const requestGeneration = currentSessionGeneration();
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
    notifyUnauthenticated(requestGeneration);
    const payload = await safeJson(response);
    throw new ApiError(401, codeFromPayload(payload) ?? "not_authenticated", detailFromPayload(payload));
  }

  if (response.status === 403 && !retried) {
    const payload = await safeJson(response);
    const code = codeFromPayload(payload);
    if (code === "csrf_failed") {
      await primeCsrfCookie();
      return performFetch<T>(path, options, true);
    }
    // Only an explicit csrf_failed code triggers the retry/label above -- any
    // other 403 (permission_denied, or an unparseable proxy/WAF page with no
    // JSON body at all) must not be mislabeled as csrf_failed (finding #8).
    throw new ApiError(403, code ?? "unknown", detailFromPayload(payload));
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
