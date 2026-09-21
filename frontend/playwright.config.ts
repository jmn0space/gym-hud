import { defineConfig, devices } from "@playwright/test";

/**
 * Real-browser E2E harness for issue #23 (validating the PAD pilot on the target
 * Android PWA). This suite runs against the actual `npm run build` output -- a
 * real service worker, real IndexedDB, real `context.setOffline` -- through the
 * mock origin server in `e2e/support/server.ts`, as a sibling CI job to the
 * existing vitest/jsdom unit suite (`npm test`), which this does not replace or
 * touch.
 *
 * Deliberately no `webServer` entry: `e2e/support/fixtures.ts`'s `server` fixture
 * owns the mock server's lifecycle (started fresh per test) so a spec can call
 * `server.expireSession()`, `server.stageNewBuild()`, etc. mid-test -- something a
 * single process Playwright starts once and treats as a black box cannot do.
 */
export default defineConfig({
  testDir: "e2e",

  // NOT because of shared service-worker/Cache-Storage/IndexedDB state: Playwright
  // gives every test its own `BrowserContext`, so that state is already isolated
  // per test and two tests never actually share a registration to fight over (the
  // reviewer confirmed order-independence by running each spec file alone). The
  // real reason is timing: PAD-01 (1.1s tolerance), PAD-02 (1.5s) and PAD-08
  // (0.8-1.5s, see its own spec) compare a displayed duration against the wall
  // clock (or a fake clock advanced against it), and parallel workers competing
  // for CPU would erode those margins directly -- a slower scheduler means more
  // real time between a click and the assertion that reads its effect, which is
  // exactly what these tolerances are trying to bound. Serial execution keeps
  // that variable out of the picture.
  fullyParallel: false,
  workers: 1,

  // A flaky acceptance gate is worse than a failing one: issue #23 exists to catch
  // exactly the kind of nondeterminism (a race between the worker and a network
  // fallback, a mutation that syncs "eventually") that a retry would paper over
  // and hide from the evidence record. Zero retries, deliberately.
  retries: 0,

  timeout: 30_000,
  expect: {
    // A commit that round-trips through the real IndexedDB repository (not a
    // mock) before the UI re-renders needs more slack than a typical DOM
    // assertion; 5s was observed to be too tight under sandboxed/CI load.
    timeout: 10_000,
  },

  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    headless: true,
    serviceWorkers: "allow",
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
