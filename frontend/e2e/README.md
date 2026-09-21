# Real-browser E2E harness (issue #23)

This directory holds the Playwright suite that validates the built Gym HUD PWA in
a real Chromium browser: a real service worker, real IndexedDB, and real
`context.setOffline` network cuts. It exists alongside, not instead of, the
existing vitest/jsdom unit suite (`npm test`) -- that suite still owns fast,
component- and logic-level coverage; this one owns the things jsdom cannot
answer at all (does the worker actually install and activate, does a navigation
really fall back to the cached shell when the network is cut, does a mutation
really reach the server and come back `applied`).

## Running it locally

```sh
npm ci
npm run build
npx playwright install chromium
npm run test:e2e
```

The build step is required and not automated by the Playwright config itself
(see `playwright.config.ts`'s comment on why there is no `webServer` entry):
`e2e/support/server.ts` serves `frontend/dist` as-is, so a stale or missing build
means the suite tests the wrong thing, or fails outright, before Playwright even
notices the app.

## What's here

- `e2e/support/server.ts` -- a plain Node `http` mock of the Django backend, on
  one origin with the built static app (so the app is same-origin with its API,
  exactly like production and the dev proxy both are). Implements the real
  auth/session/CSRF contract and the sync push/bootstrap/changes endpoints'
  acknowledgement and idempotency contract, faithfully enough to drive the real
  app -- but it does **not** implement PAD business-rule validation (state
  transitions, conflict resolution, clock-step clamping). See the file's own
  header comment for the exact scope and the reasoning behind each shortcut
  (particularly `stageNewBuild()`, which stages a service-worker update by
  rewriting the build version in place rather than rebuilding).
- `e2e/support/fixtures.ts` -- the `test`/`expect` every spec imports, extended
  with two fixtures (`server`, `app`) and four helpers (`signIn`,
  `startWalkingBout`, `coldReopen`, `readShellCacheName`). Fixture and helper
  semantics are documented at each declaration; read that file before writing a
  new spec.
- `e2e/smoke.spec.ts` -- a harness self-test proving the whole chain works
  end-to-end (build served -> worker activates -> sign-in -> a bout's mutation
  syncs -> offline genuinely works -> a cold reopen resumes). It carries no
  PAD-xx/AUTH-xx identifier. It also attaches the active shell cache name
  (`gym-hud-shell-<hash>`) to the Playwright report via `testInfo.attach`, so a
  run's evidence record names the build it actually exercised.
- `e2e/pad-walking.spec.ts` -- PAD-01 (lock-screen recovery: the displayed
  duration only resyncs via a visibility/focus recovery signal), PAD-02
  (application termination: Home reconstructs the WALKING state after a cold
  reopen), PAD-07 (maximum timer: the HUD alerts but does not auto-terminate
  the bout) and PAD-08 (pause excludes the paused interval from the effective
  duration, and the PAUSED state and its excluded-pause elapsed time restore
  across a cold reopen too).
- `e2e/pad-offline.spec.ts` -- PAD-03 (the full offline sequence: bout, finish,
  pain, rest and next bout all work with the network genuinely cut), PAD-06
  (rest integrity: Start walking is withheld while RESTING, and Start next bout
  closes the rest and starts the next bout atomically) and the RESTING
  counterpart of PAD-02's cold-reopen coverage (WALKING/PAUSED are
  `pad-walking.spec.ts`'s).
- `e2e/auth-sync.spec.ts` -- PAD-04 (reconnection drains the whole offline
  queue with no manual re-entry, in order, one applied server record per
  logical action), PAD-05 (a mutation delivered twice because its first
  acknowledgement was lost is applied exactly once), AUTH-01(a) (a
  mock-fidelity guard -- it targets this harness's own mock server, not the
  real backend, and exists so later specs that depend on the mock's
  401-before-403 ordering aren't misled by a mock that drifted from the real
  contract), AUTH-01(b) (a device that has never signed in shows only the
  login screen) and AUTH-01(c) (session expiry during a pending offline
  workout keeps local data and the outbox untouched, and drains once with no
  duplicates after re-authenticating).
- `e2e/service-worker.spec.ts` -- a service-worker update staged over a live
  bout is deferred and never reloads over live work, applying only once the
  session finishes; and an offline cold reopen serves the precached shell and
  reaches the offline-continuation state, not the login screen.
- `playwright.config.ts` (at `frontend/` root, not in this directory, since that
  is where Playwright's CLI looks for it by default) -- Chromium only, headless,
  serial (`fullyParallel: false`, `workers: 1`), zero retries. The config's own
  comments explain each choice.
- `.github/workflows/ci.yml`'s `e2e` job -- runs this whole suite in CI as a
  sibling to the `frontend` (typecheck/lint/test/build) job, on the built
  production bundle, and echoes the commit SHA under test into the job log so
  a run's log names the build alongside the shell cache name `smoke.spec.ts`
  attaches to the report.

## Runtime

The whole suite currently runs in about **1.0 minute**. Of that, PAD-07 alone
accounts for roughly **31 seconds** of deliberate real wall-clock waiting: 30s
is the smallest "Maximum bout (minutes)" setting the UI accepts (`min="0.5"` on
that field in `frontend/src/pages/PadPage.tsx`), and PAD-07 needs real time to
pass up to that maximum -- see the spec's own comment on why a fake/advanced
clock was considered and rejected for this one. Nothing else in the suite
waits anywhere near that long.

## What this harness does NOT prove

Issue #23 asks for evidence against "the target Android PWA" (a Xiaomi Redmi
Note 13 Pro+). This harness runs in **desktop Chromium**, launched by Playwright
on whatever machine runs the tests (a developer's laptop, or CI's Linux
runner). It is a good, fast proxy for the worker/IndexedDB/offline logic itself,
but it is not the device, and none of the following should ever be recorded as
device evidence for issue #23:

- **Desktop Chromium is not the target device.** Different process/memory model,
  different battery/Doze behavior, different touch input, different real-world
  network flakiness. A pass here says the *logic* is sound, not that it survives
  actual Android.
- **`coldReopen` is not an Android force-stop.** It closes a Playwright `Page`
  and opens a new one in the same browser context (so the same origin,
  IndexedDB and service-worker registration carry over) -- the closest a desktop
  browser gets to "the app was not running and is opened again." It does not
  discard process memory the way Android force-stopping (or the OS killing the
  app under memory pressure) does, and it does not exercise Android's own
  service-worker/Cache-Storage persistence guarantees under those conditions.
- **`context.setOffline(true)` is not airplane mode.** It is a genuine network
  cut at the browser level (not a mocked failing fetch), which is enough to
  exercise the worker's real fallback paths -- but it does not reproduce a real
  radio being switched off, a captive portal, or the specific latency/packet-loss
  patterns of gym Wi-Fi the pilot actually has to survive.

Device evidence -- the actual PAD-01..09/AUTH-01 walkthrough on the actual
Xiaomi Redmi Note 13 Pro+ -- belongs in `docs/device-smoke-tests.md`, not here.

Two specs in this suite are also deliberately narrower than their names alone
suggest, and say so in their own comments: `service-worker.spec.ts`'s update
test proves the outer safety gate (`isSafeToApply`/`hasLiveWork` is checked
before `applyUpdate()` is ever called) but not the narrower race where
`applyUpdate()` has already fired and live work starts in the gap before
`controllerchange` -- that race is covered at the unit level instead
(`AppUpdateBanner.test.tsx`, `registerServiceWorker.test.ts`). And
`auth-sync.spec.ts`'s `AUTH-01(a)` test is a harness-fidelity guard against
this mock's own `guardProtectedEndpoint`, not AUTH-01(a) acceptance evidence;
the real product coverage for that ordering lives in
`backend/core/tests/test_auth.py`.
