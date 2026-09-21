/**
 * Playwright fixtures and helpers shared by every real-browser spec (issue #23).
 *
 * `server` and `app` are genuine Playwright fixtures (injected via the test's
 * argument object). `signIn`, `startWalkingBout`, `coldReopen` and
 * `readShellCacheName` are plain functions instead: each spec calls them with the
 * `Page` it already has, at the point in its own scenario where it needs them --
 * turning them into fixtures would either run them unconditionally for every test
 * (most specs do not want a bout started before they can set up their own scenario)
 * or need a second layer of opt-in fixtures for no real benefit.
 */

import { expect, test as base, type Page } from "@playwright/test";

import { startMockServer, DEFAULT_PASSWORD, DEFAULT_USERNAME, type MockServer } from "./server";

interface GymHudFixtures {
  server: MockServer;
  app: Page;
}

/**
 * `server` is started fresh **per test**, not per file: every test gets an empty
 * mutation ledger, a logged-out session and a pristine CSRF token. `playwright.
 * config.ts` already forces `workers: 1` and `fullyParallel: false`, but for a
 * different reason (see that file's own comment: several specs' timing
 * tolerances, not a shared worker/cache-storage registration -- Playwright gives
 * every test its own `BrowserContext`, so that state was never actually shared
 * between tests to begin with) -- per-test isolation here does not cost extra
 * parallelism on top of that, and it means a spec never has to reason about
 * another test's leftover state (an outbox mutation, an expired session) when
 * reading `server.appliedMutations()` or asserting on auth state. The tradeoff is
 * one extra `http.Server` start/stop per test (sub-millisecond; it serves files
 * already built to disk) -- cheap enough that isolation wins outright.
 */
export const test = base.extend<GymHudFixtures>({
  // Playwright inspects this function's source text to work out which fixtures
  // it depends on, so the first parameter must literally be an (empty, since
  // this fixture has no dependencies) destructuring pattern -- not just an
  // unused identifier. `no-empty-pattern` exists to catch a *different*
  // mistake, so it is disabled for this one required pattern rather than
  // weakened project-wide.
  // eslint-disable-next-line no-empty-pattern
  server: async ({}, use) => {
    const server = await startMockServer();
    try {
      await use(server);
    } finally {
      await server.close();
    }
  },

  /**
   * A page already navigated to the mock origin, with its service worker
   * registered *and activated* -- never just "registration resolved", which can
   * still be `installing`. A spec that starts from `app` never has to add its own
   * wait for this, and never races the worker the way a bare `page.goto` would.
   */
  app: async ({ page, server }, use) => {
    await page.goto(server.origin);
    await waitForServiceWorkerActive(page);
    await use(page);
  },
});

export { expect };

/**
 * Parses a `TimerDisplay`'s `datetime="PT<seconds>S"` attribute back into
 * milliseconds (see `frontend/src/components/TimerDisplay.tsx`). Reading this
 * instead of the rendered "MM:SS" text avoids re-deriving hour/minute/second parsing
 * in the test and gets whole-second precision directly from the same value the
 * component computed.
 */
export function parseTimerDatetimeMs(datetime: string | null): number {
  const match = datetime === null ? null : /^PT(\d+)S$/.exec(datetime);
  if (match === null) {
    throw new Error(`Expected a "PT<seconds>S" timer datetime, got: ${String(datetime)}`);
  }
  return Number(match[1]) * 1000;
}

/** Parses a rendered "MM:SS" or "H:MM:SS" duration (`formatDuration`'s own format). */
export function parseFormattedDurationMs(text: string): number {
  const parts = text.trim().split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Expected a formatted MM:SS or H:MM:SS duration, got: ${text}`);
  }
  const padded = parts.length === 3 ? parts : [0, ...parts];
  const [hours, minutes, seconds] = padded as [number, number, number];
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/** Polls the page for an activated, controlling service worker. `navigator.
 * serviceWorker.ready` alone is not enough: it resolves once a worker is active
 * for the scope, but a *first* install only starts controlling the page once
 * `clients.claim()` runs in `activate` (see `src/sw/runtime.ts`) -- checking
 * `controller` too is what keeps a spec from acting on a page the worker cannot
 * actually answer fetches for yet.
 *
 * Exported (not just used internally by the `app` fixture) for a spec that
 * needs to control navigation itself -- e.g. installing `page.clock` before
 * `page.goto`, which the `app` fixture's own `page.goto` would otherwise beat
 * it to. */
export async function waitForServiceWorkerActive(page: Page): Promise<void> {
  await page.waitForFunction(async () => {
    if (!("serviceWorker" in navigator)) {
      return false;
    }
    const registration = await navigator.serviceWorker.ready;
    return registration.active !== null && navigator.serviceWorker.controller !== null;
  });
}

/**
 * Signs in through the real UI (`src/auth/LoginForm.tsx`), not the API directly --
 * this harness exists to validate the PWA end to end, and a login endpoint call
 * would skip the exact form the pilot device actually uses. Resolves once the
 * signed-in app shell (`Gym HUD` heading) is showing.
 */
export async function signIn(
  page: Page,
  credentials: { username: string; password: string } = {
    username: DEFAULT_USERNAME,
    password: DEFAULT_PASSWORD,
  },
): Promise<void> {
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Gym HUD" })).toBeVisible();
}

/**
 * PAD screen -> Start (accepts the default treadmill settings) -> Start walking.
 * Returns the wall-clock time (`Date.now()`, milliseconds) this helper clicked
 * "Start walking" -- an approximation of when the bout started, good enough for a
 * coarse elapsed-time assertion. It is **not** the timestamp the app itself
 * records: that is generated inside `PadPage.tsx`'s own commit attempt, a few
 * milliseconds later than this click, so do not assert exact equality against a
 * persisted `started_at`.
 */
export async function startWalkingBout(page: Page): Promise<number> {
  await page.getByRole("link", { name: "PAD walking" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "PAD walking" })).toBeVisible();

  // The start screen's default draft is always valid (DEFAULT_WALKING_SETTINGS),
  // so "Start" needs no field edits here.
  await page.getByRole("button", { name: "Start" }).click();

  const startWalkingButton = page.getByRole("button", { name: "Start walking" });
  await expect(startWalkingButton).toBeVisible();
  const startedAt = Date.now();
  await startWalkingButton.click();
  // The HUD's own `role="status"` line is not the only one on the page
  // (LocalDataStatus's save banner is another), so it needs disambiguating --
  // but `getByRole("status", { name })` matches the *accessible* name, and
  // ARIA's "status" role only takes one from `aria-label`/`aria-labelledby`,
  // never from content, so it would never match this plain-text element no
  // matter how long it waited. `.filter({ hasText })` matches rendered text
  // instead, which is what this element actually has.
  await expect(page.getByRole("status").filter({ hasText: "Walking" })).toBeVisible();
  return startedAt;
}

/**
 * Simulates process termination and a cold start: closes `page` and opens a new
 * one in the *same* browser context (so the same origin, IndexedDB database and
 * service worker registration are reused), navigated back to `page`'s own URL.
 *
 * This is the closest a desktop browser gets to what issue #23 actually needs
 * evidence for -- an Android force-stop of the PWA -- and it is not the same
 * thing. A real force-stop also discards the process's in-memory state in ways a
 * new `Page` in the same Chromium context does not necessarily replicate exactly
 * (e.g. Cache Storage / IndexedDB durability under OS memory pressure). Do not
 * record a `coldReopen` run as device evidence for issue #23; device evidence
 * belongs in docs/device-smoke-tests.md.
 */
export async function coldReopen(page: Page): Promise<Page> {
  const context = page.context();
  const url = page.url();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(url);
  await waitForServiceWorkerActive(reopened);
  return reopened;
}

/**
 * The active shell cache's name (`gym-hud-shell-<build version>`, `src/sw/
 * runtime.ts`'s `CACHE_PREFIX`) -- this app's only build identifier, and the
 * thing issue #23 means by "evidence tied to one identified build". `null` if no
 * such cache exists yet (the worker has not finished precaching).
 */
export async function readShellCacheName(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const keys = await caches.keys();
    return keys.find((key) => key.startsWith("gym-hud-shell-")) ?? null;
  });
}
