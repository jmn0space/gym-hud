/**
 * A same-origin mock of the Gym HUD Django backend, for the real-browser Playwright
 * suite (issue #23).
 *
 * Everything the app's own service worker (`src/sw/runtime.ts`) never intercepts --
 * `/api/**` -- is implemented here well enough to drive a real login, a real PAD
 * mutation push, and a real bootstrap/changes read. Everything the worker *does*
 * intercept (the static shell) is served straight off disk from `frontend/dist`, the
 * real `npm run build` output, so the worker's precache/cache-first/navigation-
 * fallback logic runs against real files with real hashed names -- not a stub.
 *
 * One origin, deliberately: the worker's scope, the app's own fetches, and this
 * server's cookies must all agree the app is same-origin with its API (see
 * `src/api/client.ts`'s `CREDENTIALS` comment), exactly like the production
 * deployment and the dev proxy both are.
 *
 * What this mock does NOT do, on purpose:
 *  - No PAD business-rule validation (state transitions, one-active-session,
 *    cascades, clock-step clamping -- docs/data-sync.md's "Conflict rule" and
 *    "PAD validation" sections). It only implements the acknowledgement/idempotency
 *    *contract*: a `mutation_id` is `applied` once and `duplicate` forever after.
 *    A spec that needs a `rejected`/`retry` outcome, or PAD semantics, has to arrange
 *    it itself (there is no hook here to force one) or extend this file.
 *  - No multi-account support: one configured username/password, one session at a
 *    time. Good enough for a device-validation gate; not a stand-in for the real
 *    backend's test suite.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

// --- Wire-level types, mirrored from frontend/src/sync/protocol.ts and ------------
// backend/apps/sync/protocol.py (docs/data-sync.md, "Server synchronization
// protocol"). Duplicated rather than imported: this file has to stay honest about
// exactly what it validates, and importing the real types would silently imply the
// same runtime guarantees the real parser makes, which this mock does not provide.

interface MockOutboxChange {
  store: string;
  entity_type: string;
  entity_id: string;
  operation: "put" | "delete";
  record: Record<string, unknown>;
}

interface MockOutboxEntry {
  version: number;
  mutation_id: string;
  sequence: number;
  created_at: string;
  changes: MockOutboxChange[];
}

interface MockPushRequestBody {
  client_id: string;
  mutations: MockOutboxEntry[];
}

/** One entry of the accumulating change feed `GET /sync/changes/` pages through. */
interface ChangeFeedEntry {
  store: string;
  entity_type: string;
  entity_id: string;
  change_seq: number;
  record: Record<string, unknown>;
}

/** What a spec reads back through `appliedMutations()`. */
export interface AppliedMutationRecord {
  readonly mutationId: string;
  readonly clientId: string;
  readonly body: MockOutboxEntry;
  readonly appliedAt: number;
}

/** What a spec reads back through `pushRequests()` -- every delivery, duplicates included. */
export interface PushRequestRecord {
  readonly receivedAt: number;
  readonly body: MockPushRequestBody;
}

export interface MockServer {
  /** `http://127.0.0.1:<port>`, assigned by the OS (port 0). */
  readonly origin: string;
  /**
   * Invalidates the current session server-side, so the next API call this device
   * makes answers `401`, without touching anything client-side. This is what lets a
   * spec exercise "the session expired while a workout was in progress offline" --
   * the local auth marker and IndexedDB are the client's own concern and this
   * function does not (and could not, from here) touch them.
   */
  expireSession(): void;
  /** The inverse of `expireSession`: the next API call succeeds again. */
  restoreSession(): void;
  /** Mutations answered `applied`, in the order they were first applied. */
  appliedMutations(): readonly AppliedMutationRecord[];
  /** Every push request this server received, including retries and duplicates. */
  pushRequests(): readonly PushRequestRecord[];
  /**
   * Serves a byte-different `/sw.js` from now on, without touching anything on
   * disk: it rewrites the `self.__GYM_HUD_BUILD__` version string the real Vite
   * plugin (`vite.config.ts`'s `serviceWorkerPrecachePlugin`) already injected,
   * leaving the precache manifest's asset *entries* untouched.
   *
   * Why that is faithful to a real deploy: the browser's Update algorithm decides
   * "is this a new worker?" with a **byte comparison of the script**, nothing else
   * (https://w3c.github.io/ServiceWorker/#update-algorithm) -- so any change to the
   * script's bytes is indistinguishable, to the browser, from a real new deploy.
   * The precache manifest listing the same asset paths/hashes is exactly what a
   * real deploy that only touched the worker's own source (a bug fix in
   * `runtime.ts`, say) would also produce: the assets did not change, only the
   * worker did, which is precisely the case `vite.config.ts`'s own header comment
   * calls out as the reason the version hash folds in the worker's code too.
   *
   * Where it is NOT faithful: a real new deploy can also change *which* assets are
   * precached (a new hashed bundle, an added icon). This never happens here -- the
   * files on disk are untouched -- so a spec cannot use `stageNewBuild()` to test
   * precache-failure or asset-list-changed scenarios, only the plain
   * install/waiting/skipWaiting/activate lifecycle.
   */
  stageNewBuild(): void;
  close(): Promise<void>;
}

export interface StartMockServerOptions {
  /** Defaults to the real `npm run build` output, `frontend/dist`. */
  distDir?: string;
  username?: string;
  password?: string;
}

/** Matches the real server's default (`backend/apps/sync/protocol.py`). */
const MAX_MUTATIONS_PER_REQUEST = 50;
const MAX_CHANGES_PER_MUTATION = 500;

export const DEFAULT_USERNAME = "e2e-harness-user";
export const DEFAULT_PASSWORD = "e2e-harness-password";

/** Django's own cookie names (`src/api/client.ts` reads these back). */
const SESSION_COOKIE_NAME = "sessionid";
const CSRF_COOKIE_NAME = "csrftoken";
const CSRF_HEADER_NAME = "x-csrftoken";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function defaultDistDir(): string {
  // frontend/e2e/support/server.ts -> frontend/dist.
  return fileURLToPath(new URL("../../dist", import.meta.url));
}

/** `Secure` is deliberately never set: this server is plain `http://127.0.0.1`,
 * and a `Secure` cookie is dropped by the browser outright over http. The real
 * server sets it (`SESSION_COOKIE_SECURE`/`CSRF_COOKIE_SECURE` = True in
 * `backend/config/settings/base.py`) because it is only ever deployed over https;
 * `SameSite=Lax` and the session cookie's `HttpOnly` are kept faithful. */
function cookie(name: string, value: string, options: { httpOnly: boolean }): string {
  const attributes = ["Path=/", "SameSite=Lax"];
  if (options.httpOnly) {
    attributes.push("HttpOnly");
  }
  return `${name}=${encodeURIComponent(value)}; ${attributes.join("; ")}`;
}

function isNavigationRequest(req: IncomingMessage): boolean {
  // Real Chromium sends this on every top-level navigation; it is the same signal
  // `src/sw/runtime.ts` itself does not need to check (it uses `request.mode`
  // instead, which only exists inside the worker). A bare `accept: text/html`
  // fallback covers tooling that does not set `Sec-Fetch-Mode`.
  const secFetchMode = req.headers["sec-fetch-mode"];
  if (typeof secFetchMode === "string") {
    return secFetchMode === "navigate";
  }
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

/** True for a path whose last segment names a real file extension -- `/foo.js`,
 * `/icons/x.png` -- as opposed to a client-side route like `/pad`. Only paths
 * *without* one fall back to `index.html`; a missing `.js`/`.png`/etc. must stay a
 * real 404, because the service worker's offline behaviour is tested against that
 * (`handlePrecachedAsset` in `src/sw/runtime.ts` only ever caches a storable
 * response, and a 404 masquerading as the SPA shell would defeat that entirely). */
function hasRealExtension(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return lastSegment.includes(".");
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown, setCookies?: string[]): void {
  const headers: Record<string, string | string[]> = {
    "Content-Type": "application/json; charset=utf-8",
    // Every sync/auth endpoint answers this way on the real server too
    // (`@cache_control(no_cache=True, no_store=True, must_revalidate=True)`).
    "Cache-Control": "no-store",
  };
  if (setCookies !== undefined && setCookies.length > 0) {
    headers["Set-Cookie"] = setCookies;
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

export async function startMockServer(options: StartMockServerOptions = {}): Promise<MockServer> {
  const distDir = options.distDir ?? defaultDistDir();
  const username = options.username ?? DEFAULT_USERNAME;
  const password = options.password ?? DEFAULT_PASSWORD;

  if (!existsSync(join(distDir, "index.html"))) {
    throw new Error(
      `${distDir} has no index.html -- run \`npm run build\` before starting the e2e server.`,
    );
  }
  const originalSwText = readFileSync(join(distDir, "sw.js"), "utf8");
  let currentSwText = originalSwText;
  let stagedBuildCount = 0;

  // --- Session / CSRF state --------------------------------------------------
  //
  // One session at a time, exactly like a single signed-in device: `sessionId` is
  // undefined until login, and `sessionValid` is the knob `expireSession`/
  // `restoreSession` flip without disturbing anything else. Because there is at
  // most one session, this never has to read the browser's own `Cookie` header
  // back to look one up -- unlike Django, which keys off the `sessionid` value
  // sent on each request -- and `expireSession()` can invalidate "the" session
  // without a spec having to tell it which one.
  //
  // `sessionId` itself is still handed to the browser as a real cookie value
  // (`handleLogin` below), so a spec inspecting cookies sees a realistic one; it
  // is just never read back on the way in.
  let sessionId: string | undefined;
  let sessionValid = false;
  // Django rotates the CSRF token on login and on logout; a token issued before
  // either must stop working, exactly like `rotate_token()` in `backend/core/views.py`.
  let csrfToken = randomBytes(16).toString("hex");

  // --- Mutation ledger --------------------------------------------------------
  const ledger = new Map<string, AppliedMutationRecord>();
  const appliedOrder: string[] = [];
  const pushLog: PushRequestRecord[] = [];

  // --- Change feed --------------------------------------------------------
  // Accumulates one entry per change of every *applied* (first-delivery) mutation,
  // so `GET /sync/changes/` is a genuine read of what this server has recorded,
  // not a canned empty page -- useful to a future pull-sync spec even though this
  // harness's own smoke spec never reads it.
  const changeFeed: ChangeFeedEntry[] = [];

  function isAuthenticated(): boolean {
    return sessionValid && sessionId !== undefined;
  }

  function currentUsername(): string | null {
    return isAuthenticated() ? username : null;
  }

  function hasValidCsrf(req: IncomingMessage): boolean {
    const header = req.headers[CSRF_HEADER_NAME];
    const token = Array.isArray(header) ? header[0] : header;
    return token !== undefined && token === csrfToken;
  }

  function isUnsafeMethod(method: string | undefined): boolean {
    return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
  }

  // --- Static file serving (the built SPA shell) ------------------------------

  function resolveWithinDist(relativePath: string): string | null {
    const resolved = join(distDir, relativePath);
    if (resolved !== distDir && !resolved.startsWith(distDir + sep)) {
      return null; // Path traversal attempt (`..`); refuse rather than serve it.
    }
    return resolved;
  }

  function serveFile(res: ServerResponse, filePath: string): void {
    const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      // Hashed bundle names are technically immutable, but this is a test server:
      // determinism (never serving a stale cross-test byte from the HTTP cache)
      // matters far more here than realistic long-lived caching.
      "Cache-Control": "no-store",
    });
    res.end(readFileSync(filePath));
  }

  function handleStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }

    if (pathname === "/sw.js") {
      // Content-Type/Cache-Control called out explicitly (issue #23): the app's own
      // registration (`src/pwa/registerServiceWorker.ts`) requests this as
      // `type: "module"`, and a cached 304 here would defeat every update test.
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      res.end(currentSwText);
      return;
    }

    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = resolveWithinDist(relativePath);
    if (filePath !== null && existsSync(filePath) && statSync(filePath).isFile()) {
      serveFile(res, filePath);
      return;
    }

    if (!hasRealExtension(pathname) && isNavigationRequest(req)) {
      // SPA fallback: `/pad`, `/history`, etc. are client-side routes with no file
      // on disk. A real 404 under a genuine extension (a missing asset) must NOT
      // take this branch -- see `hasRealExtension`'s own comment.
      serveFile(res, join(distDir, "index.html"));
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }

  // --- API -----------------------------------------------------------------

  function handleSession(_req: IncomingMessage, res: ServerResponse): void {
    // `ensure_csrf_cookie` on the real endpoint: always (re)issue the token, even
    // before the first login, so the client can always attach `X-CSRFToken`.
    sendJson(
      res,
      200,
      { authenticated: isAuthenticated(), username: currentUsername() },
      [cookie(CSRF_COOKIE_NAME, csrfToken, { httpOnly: false })],
    );
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // `csrf_protect` wraps the whole view in the real server (`core/views.py`), so
    // this is checked before anything else -- including for a request that carries
    // no session at all. Session validity and CSRF validity never substitute for
    // each other (docs/acceptance-tests.md, AUTH-01(a)).
    if (!hasValidCsrf(req)) {
      sendJson(res, 403, { code: "csrf_failed", detail: "CSRF verification failed. Request aborted." });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(req));
    } catch {
      sendJson(res, 400, { code: "invalid_request", detail: "Malformed JSON body." });
      return;
    }
    const { username: givenUsername, password: givenPassword } =
      typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    if (typeof givenUsername !== "string" || givenUsername.length === 0 || typeof givenPassword !== "string" || givenPassword.length === 0) {
      sendJson(res, 400, { code: "invalid_request", detail: "Username and password are required." });
      return;
    }
    if (givenUsername !== username || givenPassword !== password) {
      sendJson(res, 400, { code: "invalid_credentials", detail: "Incorrect username or password." });
      return;
    }
    sessionId = randomUUID();
    sessionValid = true;
    csrfToken = randomBytes(16).toString("hex"); // Django rotates the CSRF token on login.
    sendJson(res, 200, { authenticated: true, username }, [
      cookie(SESSION_COOKIE_NAME, sessionId, { httpOnly: true }),
      cookie(CSRF_COOKIE_NAME, csrfToken, { httpOnly: false }),
    ]);
  }

  function handleLogout(req: IncomingMessage, res: ServerResponse): void {
    // Same unconditional-CSRF-first shape as login, and idempotent either way,
    // mirroring `LogoutView` exactly (see `backend/core/views.py`).
    if (!hasValidCsrf(req)) {
      sendJson(res, 403, { code: "csrf_failed", detail: "CSRF verification failed. Request aborted." });
      return;
    }
    sessionValid = false;
    sessionId = undefined;
    csrfToken = randomBytes(16).toString("hex");
    res.writeHead(204, { "Set-Cookie": [cookie(CSRF_COOKIE_NAME, csrfToken, { httpOnly: false })] });
    res.end();
  }

  /** Every non-public endpoint's shared gate: 401 wins outright over a CSRF
   * failure (the real `SessionAuthentication.enforce_csrf` -- `backend/core/
   * authentication.py` -- only ever runs once a session has already
   * authenticated the request), and only then, for an unsafe method, does an
   * invalid CSRF token turn into a 403. Returns whether the caller may proceed. */
  function guardProtectedEndpoint(req: IncomingMessage, res: ServerResponse): boolean {
    if (!isAuthenticated()) {
      sendJson(res, 401, { code: "not_authenticated", detail: "Authentication credentials were not provided." });
      return false;
    }
    if (isUnsafeMethod(req.method) && !hasValidCsrf(req)) {
      sendJson(res, 403, { code: "csrf_failed", detail: "CSRF verification failed. Request aborted." });
      return false;
    }
    return true;
  }

  async function handleMutations(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!guardProtectedEndpoint(req, res)) {
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(req));
    } catch {
      sendJson(res, 400, { code: "invalid_request", detail: "Malformed JSON body." });
      return;
    }
    if (typeof payload !== "object" || payload === null) {
      sendJson(res, 400, { code: "invalid_request", detail: "Body must be an object." });
      return;
    }
    const body = payload as Partial<MockPushRequestBody>;
    const { client_id: clientId, mutations } = body;
    if (typeof clientId !== "string" || !Array.isArray(mutations) || mutations.length === 0) {
      sendJson(res, 400, { code: "invalid_request", detail: "client_id and a non-empty mutations array are required." });
      return;
    }
    if (mutations.length > MAX_MUTATIONS_PER_REQUEST) {
      sendJson(res, 400, {
        code: "invalid_request",
        detail: `mutations may hold at most ${MAX_MUTATIONS_PER_REQUEST.toString()} entries per request.`,
      });
      return;
    }

    // Recorded before processing, verbatim -- a spec must be able to tell "sent
    // twice" (two entries here, same mutation ids) from "applied twice" (which
    // this mock never does; see `ledger`).
    pushLog.push({ receivedAt: Date.now(), body: { client_id: clientId, mutations } });

    const results = mutations.map((mutation) => {
      const existing = ledger.get(mutation.mutation_id);
      if (existing !== undefined) {
        return { mutation_id: mutation.mutation_id, status: "duplicate" as const };
      }
      const record: AppliedMutationRecord = {
        mutationId: mutation.mutation_id,
        clientId,
        body: mutation,
        appliedAt: Date.now(),
      };
      ledger.set(mutation.mutation_id, record);
      appliedOrder.push(mutation.mutation_id);
      for (const change of mutation.changes) {
        changeFeed.push({
          store: change.store,
          entity_type: change.entity_type,
          entity_id: change.entity_id,
          change_seq: changeFeed.length + 1,
          record: change.record,
        });
      }
      return { mutation_id: mutation.mutation_id, status: "applied" as const };
    });
    sendJson(res, 200, { results });
  }

  function handleBootstrap(req: IncomingMessage, res: ServerResponse): void {
    if (!guardProtectedEndpoint(req, res)) {
      return;
    }
    const defaults = { speed_kmh: 2.5, incline_pct: 0, max_bout_seconds: 480 };
    sendJson(res, 200, {
      cursor: changeFeed.length,
      limits: {
        max_mutations_per_request: MAX_MUTATIONS_PER_REQUEST,
        max_changes_per_mutation: MAX_CHANGES_PER_MUTATION,
      },
      pad: {
        defaults,
        next_session_settings: { ...defaults, source: "defaults", walking_session_id: null },
      },
    });
  }

  function handleChanges(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!guardProtectedEndpoint(req, res)) {
      return;
    }
    const since = Number(url.searchParams.get("since") ?? "0");
    const limitParam = url.searchParams.get("limit");
    const limit = limitParam === null ? 200 : Number(limitParam);
    const matching = changeFeed.filter((entry) => entry.change_seq > since);
    const page = matching.slice(0, limit);
    const lastReturned = page.at(-1);
    sendJson(res, 200, {
      changes: page,
      cursor: lastReturned === undefined ? since : lastReturned.change_seq,
      has_more: matching.length > page.length,
    });
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
    if (pathname === "/api/v1/health/" && req.method === "GET") {
      sendJson(res, 200, { status: "ok", database: { connected: true } });
      return;
    }
    if (pathname === "/api/v1/auth/session/" && req.method === "GET") {
      handleSession(req, res);
      return;
    }
    if (pathname === "/api/v1/auth/login/" && req.method === "POST") {
      await handleLogin(req, res);
      return;
    }
    if (pathname === "/api/v1/auth/logout/" && req.method === "POST") {
      handleLogout(req, res);
      return;
    }
    if (pathname === "/api/v1/sync/mutations/" && req.method === "POST") {
      await handleMutations(req, res);
      return;
    }
    if (pathname === "/api/v1/sync/bootstrap/" && req.method === "GET") {
      handleBootstrap(req, res);
      return;
    }
    if (pathname === "/api/v1/sync/changes/" && req.method === "GET") {
      handleChanges(req, res, url);
      return;
    }
    sendJson(res, 404, { code: "not_found", detail: `No such endpoint: ${req.method ?? "GET"} ${pathname}` });
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://internal.invalid");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith("/api/")) {
      handleApi(req, res, pathname, url).catch((error: unknown) => {
        sendJson(res, 500, { code: "server_error", detail: String(error) });
      });
      return;
    }
    handleStatic(req, res, pathname);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port.toString()}`;

  return {
    origin,
    expireSession() {
      sessionValid = false;
    },
    restoreSession() {
      if (sessionId !== undefined) {
        sessionValid = true;
      }
    },
    appliedMutations: () => appliedOrder.map((id) => ledger.get(id)).filter((entry): entry is AppliedMutationRecord => entry !== undefined),
    pushRequests: () => pushLog,
    stageNewBuild() {
      stagedBuildCount += 1;
      const newVersion = `e2e-staged-${stagedBuildCount.toString()}-${randomBytes(4).toString("hex")}`;
      const patched = originalSwText.replace(/"version":"[^"]*"/, `"version":"${newVersion}"`);
      if (patched === originalSwText) {
        throw new Error(
          "stageNewBuild(): the built sw.js does not contain a \"version\":\"...\" field to rewrite -- " +
            "has vite.config.ts's serviceWorkerPrecachePlugin output format changed?",
        );
      }
      currentSwText = patched;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}
