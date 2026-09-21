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
- No Playwright evidence exists yet either. `frontend/e2e/` did not exist at
  the time this document was written; the "automated evidence" column below
  is a placeholder for a later pass to fill in with real test names once
  those specs land, not a claim that they exist now.

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
  branch into `main` — i.e. whatever `main` points to once this PR (the
  issue #23 documentation half) lands. `NOT YET RUN` / not yet applicable:
  no automated evidence has been recorded against a specific commit yet.

## Coverage matrix

| ID | What it asserts | Automated evidence | Device evidence | Status |
| --- | --- | --- | --- | --- |
| PAD-01 | Lock-screen recovery: displayed duration matches timestamp-derived duration after the phone is locked and unlocked. | TO BE FILLED (Playwright spec name, once one exists) | Part B, steps B1–B4 (`docs/device-smoke-tests.md`) | NOT YET RUN |
| PAD-02 | Application termination: Home shows `Resume PAD Walking` and reconstructs the correct WALKING state and elapsed duration after a real process termination. | TO BE FILLED | Part B, steps B5–B9 | NOT YET RUN |
| PAD-03 | Offline session: bout → finish → pain 3–4 → rest → next bout, all while offline, all working locally. | TO BE FILLED | Part C, steps C7–C11 | NOT YET RUN |
| PAD-04 | Reconnection: queued data synchronizes with no manual re-entry, one server record per logical action. | TO BE FILLED | Part C, steps C12–C14 | NOT YET RUN |
| PAD-05 | Duplicate mutation: transmitting the same mutation twice leaves only one logical server-side event. | TO BE FILLED (a genuine radio-toggle, duplicate-delivery device run has no procedure yet — see note below) | No device procedure written yet; not covered by Part C | NOT YET RUN |
| PAD-06 | Rest integrity: a new bout cannot start while a rest is open; `START NEXT BOUT` closes the rest and starts the next bout atomically. | TO BE FILLED | Part C, step C6 | NOT YET RUN |
| PAD-07 | Maximum timer: the HUD alerts at the configured maximum but does not auto-terminate the bout. | TO BE FILLED | Part C, steps C15–C16 | NOT YET RUN |
| PAD-08 | Pause: effective walking duration excludes the paused interval. | TO BE FILLED | Part C, steps C1–C5 | NOT YET RUN |
| PAD-09 | Manual time correction: editing a bout's end time recalculates duration and derived values correctly. | TO BE FILLED (cannot be written until issue #22 merges) | No device procedure written; genuinely blocked | BLOCKED (issue #22 / PR #43) |
| AUTH-01 | Unauthenticated access and offline continuation, including (c) session expiry/re-authentication with pending offline data preserved and re-drained without duplication. | TO BE FILLED | Part C, steps C17–C21 (case (c) specifically; cases (a)/(b) are server/first-run behaviour with existing coverage — see `docs/acceptance-tests.md`) | NOT YET RUN |

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

## What automated evidence can and cannot establish

Every automated test cited from `docs/acceptance-tests.md` — the existing
Vitest/jsdom unit and integration suites, and any future Playwright specs —
runs in a desktop or emulated environment. That is valuable and real
evidence: it proves the derivation logic, the state machine, and the sync
protocol are each correct in isolation, and issue #23's own coverage matrix
above cites it wherever it exists. It is not, and cannot be, a substitute
for the device rows in `docs/device-smoke-tests.md`, and issue #23's
acceptance criterion 5 says so explicitly: **do not close this gate based
only on desktop/browser emulation.** Concretely:

- **Desktop Chromium is not Android.** A desktop browser's process model,
  background-tab throttling, memory-pressure eviction, and service-worker
  lifecycle all differ from Android Chrome's. A test that passes in jsdom or
  desktop Chromium says nothing about whether Android actually evicts the
  tab, throttles its timers, or keeps its service worker alive the way the
  app depends on.
- **Closing and reopening a browser page is not an Android force-stop.**
  `PadPage.test.tsx`'s "application termination" coverage unmounts a React
  tree and opens a fresh IndexedDB connection in the same test process. A
  real Android force-stop kills the whole process, discards everything not
  already durably committed, and exercises cold-start service-worker
  activation from scratch — none of which a component test can trigger.
- **`setOffline` is not airplane mode.** Faking a failed `fetch` or flipping
  a mocked `navigator.onLine` proves the client's retry and queuing logic
  handles a failure; it does not prove the device's actual radio, DNS, and
  captive-portal behavior interact correctly with that logic, nor that
  Android's own connectivity-change events fire the way the code assumes.
- **A faked clock is not a locked phone with a throttled timer.** PAD-01's
  automated coverage fakes every timer so no tick fires while time
  "advances," which proves the duration is genuinely timestamp-derived and
  not tick-accumulated. It does not prove a real locked Android screen
  produces the same JavaScript execution pattern (Chrome's own background
  throttling, Doze mode, or a killed renderer are all real possibilities a
  fake timer cannot model).

Where this document says a device row is `NOT YET RUN`, that is the accurate
status regardless of how much automated coverage exists for the same
acceptance ID — the two columns in the coverage matrix are deliberately
separate and neither one is allowed to backfill the other.

## Reproduction steps

For each acceptance ID, "automated" reproduction re-runs the cited
suite; "device" reproduction is the named step range in
`docs/device-smoke-tests.md`.

- **PAD-01.** Automated: run the frontend test suite and look for
  `PAD-01 — lock-screen recovery` in `frontend/src/pages/PadPage.test.tsx`
  (see `docs/acceptance-tests.md#pad-01--lock-screen-recovery` for how to
  invoke it). Device: Part B, steps B1–B4.
- **PAD-02.** Automated: `PAD-02 — application termination` in the same
  file. Device: Part B, steps B5–B9.
- **PAD-03.** Automated: none cited yet beyond the individual action-builder
  unit tests in `frontend/src/pad/padWorkflow.test.ts` and
  `frontend/src/padWorkflowReplay.test.ts`. Device: Part C, steps C7–C11.
- **PAD-04.** Automated: the sync-engine tests named in
  `docs/acceptance-tests.md#pad-04--reconnection`
  (`frontend/src/sync/engine.test.ts`, `frontend/src/App.test.tsx`). Device:
  Part C, steps C12–C14, including the `manage.py shell` server-side check
  in step C14.
- **PAD-05.** Automated: the tests named in
  `docs/acceptance-tests.md#pad-05--duplicate-mutation`
  (`backend/apps/sync/tests/test_mutations_api.py`,
  `backend/apps/sync/tests/test_concurrency_pg.py`,
  `frontend/src/sync/engine.test.ts`). Device: none written; see the
  coverage matrix note above.
- **PAD-06.** Automated: `test_pad06_a_bout_cannot_start_while_a_rest_is_open`
  and related tests in `backend/apps/sync/tests/test_mutations_api.py`.
  Device: Part C, step C6.
- **PAD-07.** Automated: none cited yet. Device: Part C, steps C15–C16.
- **PAD-08.** Automated: none cited yet beyond the pause/resume
  action-builder unit tests. Device: Part C, steps C1–C5.
- **PAD-09.** Neither exists; see [Blocking issues](#blocking-issues).
- **AUTH-01.** Automated: cases (a)/(b)/logout/account-mismatch are covered
  as described in `docs/acceptance-tests.md#auth-01--unauthenticated-access-and-offline-continuation`.
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
