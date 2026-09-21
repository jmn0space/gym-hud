# PAD pilot validation (issue #23)

[← Documentation index](README.md) · [PAD walking](pad-walking.md) · [Acceptance criteria](acceptance-tests.md) · [Device smoke tests](device-smoke-tests.md) · [Data & sync](data-sync.md)

This is the single evidence record for issue #23, "Validate the complete PAD
pilot on the target Android PWA." It answers one question: **is the PAD
pilot validated?** It does not restate the acceptance test wording (see
[`docs/acceptance-tests.md`](acceptance-tests.md)) or the device procedure
itself (see [`docs/device-smoke-tests.md`](device-smoke-tests.md)); it
tracks what evidence exists against each acceptance ID, where it comes from,
and what is still missing.

## Status

**The gate is not passed.**

- No device evidence exists yet. Every PAD-01…PAD-08 and AUTH-01 row below
  needs a real run on the target device (Xiaomi Redmi Note 13 Pro+ /
  Android) against Parts A, B and C of
  [`docs/device-smoke-tests.md`](device-smoke-tests.md), and none has
  happened. This document will not be edited to show a passing device
  result until that run actually occurs; see the honesty rule this document
  inherits from `docs/device-smoke-tests.md`'s own "Honesty statement."
- PAD-09 (manual time correction) cannot be exercised at all yet: it depends
  on issue #22 (PAD timestamp corrections, confirmed undo, bout deletion),
  whose pull request, [#43](https://github.com/jmn0space/gym-hud/pull/43),
  is open and unmerged. See [Blocking issues](#blocking-issues).
- A desktop-Chromium Playwright suite now exists and runs as its own `e2e`
  CI job (`.github/workflows/ci.yml`, `frontend/playwright.config.ts`): 16
  tests across `frontend/e2e/smoke.spec.ts`, `pad-walking.spec.ts`,
  `pad-offline.spec.ts`, `auth-sync.spec.ts` and `service-worker.spec.ts`,
  taking roughly 1.0 minute. The coverage matrix below cites the specific
  test names against each acceptance ID. **This is real evidence, and it is
  explicitly not device evidence** — desktop Chromium is not the target
  Android PWA, and nothing in this bullet, or in the matrix below, changes
  the two device-evidence reasons the gate stays open (see the next two
  bullets and [What automated evidence can and cannot
  establish](#what-automated-evidence-can-and-cannot-establish)).

Issue #23's acceptance criterion 5 is explicit that this gate cannot be
closed on desktop/browser emulation alone. Automated coverage (existing unit
and integration tests, and any future Playwright specs) can retire some risk
and is recorded here as it becomes available, but it never substitutes for
the device rows below — see [What automated evidence can and cannot
establish](#what-automated-evidence-can-and-cannot-establish).

## The identified build

Issue #23 asks for evidence against "one identified build." This
application has no separate build-version string in its UI; the closest
thing to one is the service worker's own cache name,
`gym-hud-shell-<hash>` (`frontend/src/sw/runtime.ts`, `CACHE_PREFIX`),
visible on-device through DevTools → Application → Cache Storage or
`navigator.serviceWorker.getRegistrations()` in the console — exactly as
`docs/device-smoke-tests.md`'s Results section already explains for its own
"Build version" column.

- **Device run.** The identified build is the `gym-hud-shell-<hash>` value
  read from the phone during the run, recorded alongside the commit SHA of
  the frontend bundle that was actually built and deployed to the preview
  stack for that run (`git rev-parse HEAD` on the host at build time).
  `NOT YET RUN` — both values are placeholders until a run happens; see the
  device run-metadata table in `docs/device-smoke-tests.md`.
- **Automated evidence.** The identifying commit for any automated evidence
  cited from this document is the merge commit of this pull request's
  branch into `main` — i.e. whatever `main` points to once this pull
  request (which carries both the `frontend/e2e/` Playwright suite and this
  document) lands. `NOT YET RUN` / not yet applicable: no automated evidence
  has been recorded against a specific commit yet, since the commit does not
  exist until the merge happens.

## Coverage matrix

| ID | What it asserts | Automated evidence | Device evidence | Status |
| --- | --- | --- | --- | --- |
| PAD-01 | Lock-screen recovery: displayed duration matches timestamp-derived duration after the phone is locked and unlocked. | Playwright (`frontend/e2e/pad-walking.spec.ts`): `PAD-01 — lock-screen recovery: displayed duration resyncs after a visibility/focus recovery signal, and ONLY via that resync path` — genuinely fail-sensitive (see note below). Vitest (`frontend/src/pages/PadPage.test.tsx`): `PAD-01 — lock-screen recovery`, the faked-timer no-tick-delivered variant. Neither is a real locked phone. | Part B, steps B1–B4 (`docs/device-smoke-tests.md`) | NOT YET RUN |
| PAD-02 | Application termination: Home shows `Resume PAD Walking` and reconstructs the correct WALKING state and elapsed duration after a real process termination. | Playwright: `PAD-02 — application termination: Home reconstructs the WALKING state and elapsed duration after a cold reopen, and resuming shows the same in the PAD HUD` (`pad-walking.spec.ts`, WALKING case) and `PAD-02 — application termination: Home reconstructs the RESTING state after a cold reopen while resting, and resuming offers Start next bout` (`frontend/e2e/pad-offline.spec.ts`, RESTING case). The PAUSED case is exercised by `PAD-08 — pause: the PAUSED state and its excluded-pause elapsed time restore after a cold reopen` (`pad-walking.spec.ts`), filed under PAD-08 because it is that ID's pause-exclusion claim, not PAD-02's, but it covers the same cold-reopen reconstruction. Vitest: `PAD-02 — application termination` in `frontend/src/pages/PadPage.test.tsx`. `coldReopen` (`frontend/e2e/support/fixtures.ts`) is a page close/reopen in the same browser context, not an Android force-stop. | Part B, steps B5–B9 | NOT YET RUN |
| PAD-03 | Offline session: bout → finish → pain 3–4 → rest → next bout, all while offline, all working locally. | Playwright (`pad-offline.spec.ts`): `PAD-03 — offline session: bout, finish, pain, rest and next bout all work while offline` — a genuine `context.setOffline(true)` network cut, asserting zero push requests and zero applied mutations throughout. Vitest: the action-builder unit tests in `frontend/src/pad/padWorkflow.test.ts` and `frontend/src/padWorkflowReplay.test.ts`. | Part C, steps C7–C11 | NOT YET RUN |
| PAD-04 | Reconnection: queued data synchronizes with no manual re-entry, one server record per logical action. | Playwright (`frontend/e2e/auth-sync.spec.ts`): `PAD-04 — reconnection drains the whole offline queue with no manual re-entry, in order, one applied server record per logical action` — six real offline actions, then `setOffline(false)`, polling the mock server's own ledger for exactly six applied mutations in ascending sequence. Vitest: the tests named in [Reproduction steps](#reproduction-steps) (`frontend/src/sync/engine.test.ts`, `frontend/src/App.test.tsx`). | Part C, steps C12–C14 | NOT YET RUN |
| PAD-05 | Duplicate mutation: transmitting the same mutation twice leaves only one logical server-side event. | Playwright (`auth-sync.spec.ts`): `PAD-05 — a mutation delivered twice because its first acknowledgement was lost is applied exactly once` — the first push is genuinely applied server-side then its response is aborted (`route.fetch()` + `route.abort("failed")`, indistinguishable from a lost acknowledgement), and the client's own resend comes back `duplicate`. Server/client automated coverage: `backend/apps/sync/tests/test_mutations_api.py`, `backend/apps/sync/tests/test_concurrency_pg.py`, `frontend/src/sync/engine.test.ts` (see [Reproduction steps](#reproduction-steps)). A genuine radio-toggle, duplicate-delivery device run has no procedure yet — see note below. | No device procedure written yet; not covered by Part C | NOT YET RUN |
| PAD-06 | Rest integrity: a new bout cannot start while a rest is open; `START NEXT BOUT` closes the rest and starts the next bout atomically. | Playwright (`pad-offline.spec.ts`): `PAD-06 — rest integrity: Start walking is not offered while RESTING, and Start next bout closes the rest and starts the next bout atomically` — run offline, proving this is a local UI/state-machine rule (`requireState(view, "RESTING")` in `frontend/src/pad/actions.ts`), not something only a reachable server enforces. Vitest/pytest: `test_pad06_a_bout_cannot_start_while_a_rest_is_open` and related tests in `backend/apps/sync/tests/test_mutations_api.py` (the server-side rejection path). | Part C, step C6 | NOT YET RUN |
| PAD-07 | Maximum timer: the HUD alerts at the configured maximum but does not auto-terminate the bout. | Playwright (`pad-walking.spec.ts`): `PAD-07 — maximum timer: the HUD alerts once the maximum bout is reached but does not auto-terminate the bout` — a real 30-second wall-clock wait (the smallest legal "Maximum bout (minutes)" value), confirming the `· Maximum reached` alert appears, the bout stays WALKING with `Pause`/`Finish bout` still offered, and no `walking_rests` mutation was ever pushed. | Part C, steps C15–C16 | NOT YET RUN |
| PAD-08 | Pause: effective walking duration excludes the paused interval. | Playwright (`pad-walking.spec.ts`): `PAD-08 — pause: effective walking duration excludes the paused interval` (measured real walk/pause/walk intervals, asserting the recorded duration matches the two walk spans and excludes the pause) and `PAD-08 — pause: the PAUSED state and its excluded-pause elapsed time restore after a cold reopen` (the excluded-pause figure reconstructs correctly and does not keep growing while the pause stays open across a cold reopen). Vitest: the pause/resume action-builder unit tests. | Part C, steps C1–C5 | NOT YET RUN |
| PAD-09 | Manual time correction: editing a bout's end time recalculates duration and derived values correctly. | None (cannot be written until issue #22 merges). | No device procedure written; genuinely blocked | BLOCKED (issue #22 / PR #43) |
| AUTH-01 | Unauthenticated access and offline continuation, including (c) session expiry/re-authentication with pending offline data preserved and re-drained without duplication. | (a) Playwright `AUTH-01(a) mock-fidelity guard — the harness's guardProtectedEndpoint reproduces the real server's 401-before-403 ordering` (`auth-sync.spec.ts`) is **not** product coverage — every assertion targets this harness's own mock, not the real server, so it cannot catch a regression in the real `enforce_csrf` ordering; the genuine (a) coverage is `backend/core/tests/test_auth.py` and `backend/core/tests/test_url_auth_coverage.py`. (b) Playwright `AUTH-01(b) — a device that has never signed in shows only the login screen and fetches no workout data` (`auth-sync.spec.ts`) is genuine product coverage: it asserts zero `/api/v1/sync/` requests from the very first byte the browser sent. (c) Playwright `AUTH-01(c) — session expiry during a pending offline workout keeps local data and the outbox untouched, and drains once with no duplicates after re-authenticating` (`auth-sync.spec.ts`). Logout/account-mismatch: `frontend/src/auth/AuthProvider.test.tsx`. | Part C, steps C17–C21 (case (c) specifically; case (a)'s real product coverage and case (b) are covered above) | NOT YET RUN |

PAD-05's device evidence is intentionally left without a Part C reference: a
genuine "same mutation delivered twice" event on a real device means racing
the radio (toggling connectivity mid-request) or killing the app between the
request leaving the device and the response arriving, which Part C does not
attempt to stage. The existing automated coverage cited in
`docs/acceptance-tests.md#pad-05--duplicate-mutation` (server-side concurrent
delivery, client-side lost-acknowledgement retry) is the evidence that
exists; nothing here claims a device run covers it too.

A service-worker update while a session is active (Part C, steps C22–C26)
and PAD-03/PAD-04's underlying offline persistence together also satisfy
issue #23's criterion 4 beyond AUTH-01(c); they are listed under PAD-03/
PAD-04/AUTH-01 above rather than as a separate row because the acceptance
document does not give the service-worker-update scenario its own ID.
Automated coverage for that scenario now exists in
`frontend/e2e/service-worker.spec.ts`: `a service-worker update staged while
a bout is active is deferred, never reloading over live work, and applies
once the session is finished (issue #23 criterion 4)` proves the *outer*
gate — clicking `Update now` over a live WALKING bout defers (a real
`framenavigated` counter stays at zero), and the deferred update applies
itself, with a real reload, once the bout and session are finished and the
outbox is empty. `offline cold reopen serves the precached shell and
reaches the offline-continuation state, not the login screen` proves the
service worker answers a cold-reopen navigation from its precache while
offline, reaching the "unverified" (offline-continuation) state rather than
the login screen. Neither test proves the *narrower* race where
`applyUpdate()` has already been sent and live work starts before
`controllerchange` fires — that race is covered only at the unit level, in
`frontend/src/pwa/registerServiceWorker.test.ts` and
`frontend/src/components/AppUpdateBanner.test.tsx`; see [Known gaps in
automated coverage](#known-gaps-in-automated-coverage) below.

## What automated evidence can and cannot establish

Every automated test cited from `docs/acceptance-tests.md` — the existing
Vitest/jsdom unit and integration suites, and the `frontend/e2e/` Playwright
suite — runs in a desktop or emulated environment: either jsdom, or a real
desktop-Chromium browser under Playwright. Moving from jsdom to a real
browser for the Playwright half is itself real progress (a real service
worker, real IndexedDB, a real network cut via `context.setOffline`, a real
page close/reopen via `coldReopen`), and issue #23's own coverage matrix
above cites it wherever it exists. It is still not, and cannot be, a
substitute for the device rows in `docs/device-smoke-tests.md`, and issue
#23's acceptance criterion 5 says so explicitly: **do not close this gate
based only on desktop/browser emulation.** Concretely:

- **Desktop Chromium is not Android.** A desktop browser's process model,
  background-tab throttling, memory-pressure eviction, and service-worker
  lifecycle all differ from Android Chrome's. A test that passes in jsdom or
  desktop Chromium — including every test in `frontend/e2e/`, which runs
  Chromium on the CI runner's own desktop OS, not Android Chrome — says
  nothing about whether Android actually evicts the tab, throttles its
  timers, or keeps its service worker alive the way the app depends on.
- **`coldReopen` (a page close/reopen) is not an Android force-stop.**
  `PadPage.test.tsx`'s jsdom "application termination" coverage unmounts a
  React tree and opens a fresh IndexedDB connection in the same test
  process. The Playwright equivalent, `coldReopen`
  (`frontend/e2e/support/fixtures.ts`), is a real improvement — it closes
  an actual `Page` and opens a fresh one in the same `BrowserContext`, so
  the service worker and IndexedDB connection are genuinely torn down and
  re-established — but it is still one `Page` object closing inside a
  process Playwright itself keeps running. A real Android force-stop kills
  the whole application process, discards everything not already durably
  committed, and exercises cold-start service-worker activation from a
  process that did not exist a moment before — none of which a `Page`
  close/reopen, however real the browser underneath it, can trigger.
- **`setOffline` is not airplane mode.** `context.setOffline(true)`
  (`pad-offline.spec.ts`, `auth-sync.spec.ts`) genuinely severs the network
  at the browser-context level, which is a real step up from a mocked
  `fetch` rejection or a flipped `navigator.onLine` — it exercises the
  service worker's actual fetch handling and the sync engine's actual
  `online`/`offline` event listeners, not a stand-in for either. It still
  does not prove the device's actual radio, DNS, and captive-portal
  behavior interact correctly with that logic, nor that Android's own
  connectivity-change events fire the way the code assumes: a browser
  context flag is not a radio.
- **A paused fake clock is not a locked phone with a throttled timer.**
  PAD-01's Playwright coverage (`pad-walking.spec.ts`) is more rigorous than
  a plain faked timer: it installs `page.clock` before navigation, so
  `useNow`'s `setInterval` is fake from the instant React creates it, then
  calls `pauseAt()` and `setSystemTime()` so the interval provably cannot
  tick even once while time advances — the test is verified fail-sensitive
  (deleting the `visibilitychange`/`focus` listeners from
  `frontend/src/pad/useNow.ts` makes it fail, reading a stale 10000ms
  against a 1100ms tolerance; restoring them makes it pass again). That
  proves the duration is genuinely timestamp-derived through the resync
  listeners and not tick-accumulated. It still does not prove a real locked
  Android screen
  produces the same JavaScript execution pattern (Chrome's own background
  throttling, Doze mode, or a killed renderer are all real possibilities a
  fake timer cannot model).

Where this document says a device row is `NOT YET RUN`, that is the accurate
status regardless of how much automated coverage exists for the same
acceptance ID — the two columns in the coverage matrix are deliberately
separate and neither one is allowed to backfill the other.

## Known gaps in automated coverage

These are gaps the reviewer found honestly unclaimed; they are named here so
they stay visible rather than becoming invisible once the coverage matrix
above reads as "full."

- **The service-worker update race narrower than the outer gate.**
  `frontend/e2e/service-worker.spec.ts`'s criterion-4 test proves the outer
  gate — `Update now` over live work defers instead of reloading, checked
  via a real `framenavigated` counter staying at zero. It does not, and by
  its own header comment cannot honestly, prove the narrower race where
  `applyUpdate()` has already been sent and live work starts in the gap
  before `controllerchange` fires (`setReloadGuard`'s last-line-of-defence
  in `frontend/src/pwa/registerServiceWorker.ts`): staging a build that
  changes no precached asset bytes activates in a handful of milliseconds,
  too fast to race deterministically from outside the page with this
  harness. That narrower race stays covered only at the unit level, in
  `frontend/src/pwa/registerServiceWorker.test.ts` and
  `frontend/src/components/AppUpdateBanner.test.tsx`.
- **A pending outbox surviving a cold reopen, shown as pending, before it
  drains.** Nothing automated — jsdom or Playwright — asserts that a
  mutation queued offline is still visibly pending (not merely present in
  IndexedDB) immediately after a cold reopen, before the sync engine gets a
  chance to drain it. PAD-04 (`auth-sync.spec.ts`) proves the drain side:
  the whole offline queue synchronizes correctly once connectivity returns.
  Criterion 3's "restores all pending status without manual re-entry" is
  therefore only covered on the drain side, not across a restart. Device
  step C26 (`docs/device-smoke-tests.md`) covers the restart case; no
  automated test does yet.

## Reproduction steps

For each acceptance ID, "automated" reproduction re-runs the cited
suite; "device" reproduction is the named step range in
`docs/device-smoke-tests.md`.

**Playwright suite.** All `frontend/e2e/*.spec.ts` tests run together, once,
against a real production build:

```bash
cd frontend && npm ci && npm run build && npx playwright install chromium && npm run test:e2e
```

The repository requires Node 24.12.0 (`frontend/.nvmrc`) — `npm run build`
will not even complete under a Node 18 shell, so confirm the active Node
version (`node -v`) before troubleshooting a failure that might just be a
stale shell. This is a sibling CI job (`e2e` in `.github/workflows/ci.yml`)
to the existing `npm test` (Vitest/jsdom) and `pytest` jobs, not a
replacement for either — see the coverage matrix above for which suite
covers which acceptance ID, and cite individual test names with
`npm run test:e2e -- -g "<test name>"` to run just one.

- **PAD-01.** Automated: Playwright's `PAD-01 — lock-screen recovery:
  displayed duration resyncs after a visibility/focus recovery signal, and
  ONLY via that resync path` in `frontend/e2e/pad-walking.spec.ts` (see the
  coverage matrix above for why this is fail-sensitive); Vitest's
  `PAD-01 — lock-screen recovery` in `frontend/src/pages/PadPage.test.tsx`
  (see `docs/acceptance-tests.md#pad-01--lock-screen-recovery` for how to
  invoke it). Device: Part B, steps B1–B4.
- **PAD-02.** Automated: Playwright's `PAD-02 — application termination:
  Home reconstructs the WALKING state and elapsed duration after a cold
  reopen, and resuming shows the same in the PAD HUD`
  (`frontend/e2e/pad-walking.spec.ts`) and `PAD-02 — application
  termination: Home reconstructs the RESTING state after a cold reopen
  while resting, and resuming offers Start next bout`
  (`frontend/e2e/pad-offline.spec.ts`); Vitest's `PAD-02 — application
  termination` in `frontend/src/pages/PadPage.test.tsx`. Device: Part B,
  steps B5–B9.
- **PAD-03.** Automated: Playwright's `PAD-03 — offline session: bout,
  finish, pain, rest and next bout all work while offline`
  (`frontend/e2e/pad-offline.spec.ts`); the individual action-builder unit
  tests in `frontend/src/pad/padWorkflow.test.ts` and
  `frontend/src/padWorkflowReplay.test.ts`. Device: Part C, steps C7–C11.
- **PAD-04.** Automated: Playwright's `PAD-04 — reconnection drains the
  whole offline queue with no manual re-entry, in order, one applied server
  record per logical action` (`frontend/e2e/auth-sync.spec.ts`); the
  sync-engine tests named in `docs/acceptance-tests.md#pad-04--reconnection`
  (`frontend/src/sync/engine.test.ts`, `frontend/src/App.test.tsx`). Device:
  Part C, steps C12–C14, including the `manage.py shell` server-side check
  in step C14.
- **PAD-05.** Automated: Playwright's `PAD-05 — a mutation delivered twice
  because its first acknowledgement was lost is applied exactly once`
  (`frontend/e2e/auth-sync.spec.ts`); the tests named in
  `docs/acceptance-tests.md#pad-05--duplicate-mutation`
  (`backend/apps/sync/tests/test_mutations_api.py`,
  `backend/apps/sync/tests/test_concurrency_pg.py`,
  `frontend/src/sync/engine.test.ts`). Device: none written; see the
  coverage matrix note above.
- **PAD-06.** Automated: Playwright's `PAD-06 — rest integrity: Start
  walking is not offered while RESTING, and Start next bout closes the rest
  and starts the next bout atomically` (`frontend/e2e/pad-offline.spec.ts`);
  `test_pad06_a_bout_cannot_start_while_a_rest_is_open` and related tests in
  `backend/apps/sync/tests/test_mutations_api.py`. Device: Part C, step C6.
- **PAD-07.** Automated: Playwright's `PAD-07 — maximum timer: the HUD
  alerts once the maximum bout is reached but does not auto-terminate the
  bout` (`frontend/e2e/pad-walking.spec.ts`). Device: Part C, steps
  C15–C16.
- **PAD-08.** Automated: Playwright's `PAD-08 — pause: effective walking
  duration excludes the paused interval` and `PAD-08 — pause: the PAUSED
  state and its excluded-pause elapsed time restore after a cold reopen`
  (both `frontend/e2e/pad-walking.spec.ts`); the pause/resume action-builder
  unit tests. Device: Part C, steps C1–C5.
- **PAD-09.** Neither exists; see [Blocking issues](#blocking-issues).
- **AUTH-01.** Automated: Playwright's `AUTH-01(a) mock-fidelity guard —
  the harness's guardProtectedEndpoint reproduces the real server's
  401-before-403 ordering`, `AUTH-01(b) — a device that has never signed in
  shows only the login screen and fetches no workout data` and `AUTH-01(c)
  — session expiry during a pending offline workout keeps local data and
  the outbox untouched, and drains once with no duplicates after
  re-authenticating` (all `frontend/e2e/auth-sync.spec.ts` — see the
  coverage matrix above for why (a) is a mock guard, not product coverage,
  and where (a)'s real coverage lives); logout/account-mismatch are covered
  as described in
  `docs/acceptance-tests.md#auth-01--unauthenticated-access-and-offline-continuation`.
  Device: case (c) is Part C, steps C17–C21.

## Blocking issues

**PAD-09 is blocked on issue #22.** Manual time correction — editing a
bout's recorded end time and recalculating duration and derived values — has
no implementation on this branch. Issue #22 ("PAD timestamp corrections,
confirmed undo, bout deletion") is where that lands; its pull request,
[#43](https://github.com/jmn0space/gym-hud/pull/43), is open and unmerged as
of this writing. This PR deliberately branches from `main` rather than from
PR #43's branch, per the owner's decision, so PAD-09 cannot be exercised —
neither automated nor on-device — until #43 merges. Once it does, PAD-09
needs both a Playwright spec and a device procedure added to Part C of
`docs/device-smoke-tests.md`, and this document's coverage matrix updated
out of `BLOCKED`.

### Bugs found during validation

None yet. This section is for concrete, reproducible defects discovered
while actually running the Part A/B/C procedures or an automated spec
against this issue's scope — each entry should name the step or test that
found it, the observed behavior, and a link to its tracking issue. It stays
empty until a real run (device or automated) actually finds something; do
not pre-fill it with speculative or hypothetical issues.

## Exit criteria

Issue #23 can be closed once all of the following are true:

1. Parts A, B and C of `docs/device-smoke-tests.md` have been run on the
   target device (Xiaomi Redmi Note 13 Pro+ / Android) at least once, with
   every step recorded as `PASS` or `FAIL` (never left as `NOT YET RUN`),
   and the run-metadata table filled in with the actual device, OS/browser
   versions, build identifier, date and tester.
2. Every PAD-01…PAD-08 and AUTH-01 row in the [coverage
   matrix](#coverage-matrix) above shows a device result other than `NOT YET
   RUN`.
3. Any `FAIL` recorded in step 1 is either resolved (with a follow-up run
   confirming the fix) or has an explicit, linked blocking bug in [Bugs
   found during validation](#bugs-found-during-validation) — issue #23's
   acceptance criterion 5 requires one or the other, not a silently
   ignored failure.
4. PAD-09 is either exercised (issue #22 / PR #43 has merged, and both a
   device procedure and its result exist) or remains explicitly `BLOCKED`
   here with its link — issue #23 does not require PAD-09 to pass, only
   that it not be silently skipped.
5. This document's [Status](#status) section is updated to reflect the
   above, in place of its current "not passed" statement.
