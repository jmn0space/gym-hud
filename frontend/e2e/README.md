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
  PAD-xx/AUTH-xx identifier; acceptance-test specs are separate files owned by
  other work on this same issue.
- `playwright.config.ts` (at `frontend/` root, not in this directory, since that
  is where Playwright's CLI looks for it by default) -- Chromium only, headless,
  serial (`fullyParallel: false`, `workers: 1`), zero retries. The config's own
  comments explain each choice.

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
