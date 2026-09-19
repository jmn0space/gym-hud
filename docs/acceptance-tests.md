# Acceptance Criteria

[← Documentation index](README.md) · [PAD walking](pad-walking.md) · [Resistance & cardio](training.md) · [Architecture](architecture.md) · [Data & sync](data-sync.md)

These tests define the minimum behaviour required for v1.

## Local persistence foundation

### LOCAL-01 — Atomic record and outbox commit

Apply one logical action containing multiple domain-record changes.

Expected: all record changes, one action receipt, the next local sequence, and one
ordered outbox envelope become durable together. Injecting an IndexedDB request
failure after an earlier write aborts every part of the action, and the UI does not
report success.

### LOCAL-02 — Reload and migration recovery

Commit a pending action, close every repository connection, and reopen the same
database. Also upgrade a database created with the previous schema version.

Expected: live records and the ordered pending outbox survive close/reopen and a
non-destructive schema upgrade.

### LOCAL-03 — Logical PAD transitions

Finish a walking bout and begin its rest in one action. In a later action, finish
that rest and start the next bout.

Expected: each transition is all-or-nothing, retains stable parent identity, and
orders parent creates before children. Deletion actions retain tombstones, with
child deletes ordered before parent deletes.

### LOCAL-04 — Retry and ordering invariants

Move the device clock backwards between actions and retry a previously committed
action ID after acknowledging its outbox entry.

Expected: persisted sequences remain strictly increasing, and the retry returns the
original receipt without recreating the action or pending outbox entry.

Related automated coverage (issue #19 review), for the timestamps rather than the
sequences: PAD actions never stamp a time earlier than the latest one already
recorded in the session ("PAD clock stepping backwards" in
`frontend/src/pad/padSession.test.ts`), and the server clamps any inversion that
still reaches it instead of rejecting the mutation
(`test_a_clock_step_back_does_not_strand_the_rest_of_the_queue` in
`backend/apps/sync/tests/test_mutations_api.py`). No device run has been performed.

### LOCAL-05 — Concurrent connections

Use independent connections to start two sessions of the same type, with an
absence precondition evaluated by each action. Then start sessions of different
types concurrently.

Expected: no more than one same-type session becomes `ACTIVE`; distinct types can
both become active. Preconditions are checked inside each write transaction.

### LOCAL-06 — Cache and sync metadata

Write reference-cache data and caller-owned synchronization metadata, close the
repository, and reopen it.

Expected: both survive independently of mutable workout records and internal action,
sequence, and client metadata.

### LOCAL-07 — Browser reload recovery

Seed persisted `ACTIVE` sessions and interval records through the local repository,
load Home, close its repository connection, and reload the browser page.

Expected: Home reads IndexedDB again and shows one Resume card per active session
type with PAD state and elapsed time derived from its stored intervals. A storage
open/read failure remains visible and offers Retry; it is not presented as an empty
database.

### Follow-up Android and synchronization checklist

These checks depend on PAD controls, installation/service-worker work, and the
backend synchronization contract outside the local persistence foundation. They
remain release checks for the complete features and had not been performed as
part of issue #15. Issue #17 delivered the installation/service-worker work,
which turns the installation and offline-reopen items below into a fully
specified, runnable device procedure — see
[`docs/device-smoke-tests.md`](device-smoke-tests.md) for the exact numbered
steps and its results table for whether it has actually been run. Issue #18
then delivered the first PAD controls — start a walking session, start a
walking bout, finish the session — which unblocks the walking half of several
items below (Part B of `docs/device-smoke-tests.md` is now a runnable
procedure). Issue #19 delivered the server side of synchronization (the push
protocol, the processed-mutation ledger and the PAD models; see [Data &
synchronization: server synchronization
protocol](data-sync.md#server-synchronization-protocol)). Pause, finish-bout and
rest controls, and the client sync engine that drains the outbox (issue #20), are
still outstanding; each item is annotated below with exactly what it is still
waiting on.

- [ ] Start a PAD bout while offline and confirm the saved state is visible.
  **No longer blocked; not yet run.** Issue #18 added the start-session and
  start-walking controls to `frontend/src/pages/PadPage.tsx`, so this is now a
  runnable device procedure — see Part B of
  [`docs/device-smoke-tests.md`](device-smoke-tests.md). This box records the
  manual device run only, which has not happened.
- [ ] Lock the phone long enough for the timer display to become stale, then unlock
  and confirm elapsed time is recomputed from stored UTC timestamps.
  **No longer blocked; not yet run.** This is PAD-01's scenario, and a bout can
  now be started to lock the phone during (Part B of
  [`docs/device-smoke-tests.md`](device-smoke-tests.md)). Automated,
  clock-controlled coverage of the same derivation exists (see PAD-01 below);
  it is not a substitute for this box, which is about a real locked phone.
- [ ] Force-stop the installed PWA/browser process, reopen it, and confirm Home shows
  `Resume PAD Walking` with the correct WALKING, PAUSED, or RESTING state.
  **Runnable for WALKING; PAUSED and RESTING still blocked; not yet run.** The
  "installed," "force-stop," and "cold-start reopen while offline" mechanics
  are a concrete procedure in
  [`docs/device-smoke-tests.md`](device-smoke-tests.md), and issue #18's
  controls can now put a real walking bout on the device before the force-stop,
  so the WALKING case (PAD-02 below) is runnable. PAUSED and RESTING cannot yet
  be produced through the UI — pause and finish-bout controls are the deferred
  story — so that part of this item stays blocked. The application reconstructs
  and displays both states when the records exist, and automated tests cover
  that, but no device run has been performed.
- [ ] Complete a multi-record transition offline, reload, and confirm its pending
  synchronization action is still present exactly once.
  **Partially unblocked; not yet run.** `FINISH SESSION` with a bout still open
  is a multi-record transition in one action (it closes the bout and completes
  the session together), so this item can now be exercised that way. The
  specific transition LOCAL-03 names — finishing a bout and starting its rest —
  still needs the deferred finish-bout control.
- [ ] Restore connectivity and confirm a failed synchronization attempt remains
  pending for retry.
  **Blocked on the client sync engine (issue #20)**: the server protocol exists
  since issue #19, and its retryable outcomes are defined (see [Data &
  synchronization: push response](data-sync.md#push-response)), but nothing on
  the device sends the outbox yet (see [Data & synchronization: sync
  gate](data-sync.md#sync-gate)), so there is still no synchronization attempt
  to fail or retry on a device.

These boxes record manual device work only. Automated browser and repository tests
do not mark them complete. See the Overall v1 continuity criterion at the end of
this document for the acceptance-level statement these checks, PAD-02, and
`docs/device-smoke-tests.md` all serve.

## Home screen and session cardinality

See [Product overview: Active-session cardinality and Home Resume
cards](product-overview.md#active-session-cardinality-and-home-resume-cards)
for the settled combination table this section exercises.

### HOME-01 — Resume cards per combination of active types

For each combination of active session types (PAD, resistance, cardio -- all
eight subsets, including none), seed the corresponding `ACTIVE` sessions
through the local repository and load Home.

Expected, per the product-overview table:

- Home shows exactly one Resume card per active type, always ordered PAD,
  then resistance, then cardio when more than one is active.
- `START NEW` is offered only for types that are *not* currently active.

This extends LOCAL-05 (concurrent connections enforcing at most one
same-type `ACTIVE` session) and LOCAL-07 (Home reads Resume cards back from
IndexedDB after a reload) to every combination, not just the single- and
all-active cases those already cover.

### HOME-02 — Starting an already-active type is blocked

With a PAD session `ACTIVE`, attempt `START NEW` for PAD from Home.

Expected: the action is unavailable (or refused with an explanation); the
existing session must be resumed, finished, or discarded first. Starting
resistance or cardio from the same screen remains unaffected.

## PAD

### PAD-01 — Lock-screen recovery

1. Start a bout.
2. Lock the phone.
3. Leave it locked for several minutes.
4. Unlock.
5. Resume the PWA.

Expected: displayed duration matches timestamp-derived duration.

Automated coverage (issue #18): `PAD-01 — lock-screen recovery` in
`frontend/src/pages/PadPage.test.tsx` runs this with every timer faked, so no
tick is delivered while the clock advances; the display only catches up when the
app becomes visible again, and then matches the timestamp-derived duration
exactly. That covers the derivation, not the device: the real locked-phone run
is the checklist box above and Part B of
[`docs/device-smoke-tests.md`](device-smoke-tests.md), neither of which has been
performed.

### PAD-02 — Application termination

1. Start a bout.
2. Fully terminate the PWA/browser process.
3. Reopen the application.

Expected: the home screen exposes `Resume PAD Walking` and reconstructs the correct state and elapsed duration.

Automated coverage (issue #18): `PAD-02 — application termination` in
`frontend/src/pages/PadPage.test.tsx` starts a session and bout through the UI,
unmounts the view and closes the repository connection, then reopens the same
database with a new connection and provider; the HUD and the Home Resume-card
summary are both reconstructed from persisted records alone, with the correct
bout number and elapsed duration. Terminating a React tree is not terminating an
Android process: the real force-stop run is Part B of
[`docs/device-smoke-tests.md`](device-smoke-tests.md) and has not been
performed.

### PAD-03 — Offline session

1. Disable connectivity.
2. Start a bout.
3. Finish it.
4. Record pain 3–4.
5. Rest.
6. Start the next bout.

Expected: all operations work locally.

### PAD-04 — Reconnection

After PAD-03, restore connectivity.

Expected: queued data synchronizes without manual re-entry.

The server accepts and acknowledges queued PAD mutations since issue #19; sending
them on reconnection is the client sync engine (issue #20), so this is not yet
runnable.

### PAD-05 — Duplicate mutation

Transmit the same mutation twice.

Expected: only one logical server-side event exists.

Automated coverage (issue #19), server side only:
`test_pad05_the_same_mutation_twice_is_one_logical_event` in
`backend/apps/sync/tests/test_mutations_api.py` sends one mutation in two requests
through the real endpoint and asserts one bout, one ledger row, an unchanged change
counter and an untouched row, with the second answered `duplicate`;
`test_retry_after_a_lost_response_applies_nothing_twice` resends a whole batch whose
response was lost. `backend/apps/sync/tests/test_concurrency_pg.py` delivers the same
mutation from six concurrent PostgreSQL connections (one `applied`, five
`duplicate`), races a retry against the original batch, and races two accounts on
one `mutation_id`. The mutations are built the way the frontend repository builds
them, but no device sends them yet: the transmit-twice-from-the-phone run needs the
client sync engine (issue #20) and has not been performed.

### PAD-06 — Rest integrity

While resting, attempt to start another bout outside the normal control.

Expected: a new walking bout cannot start until the existing rest is closed. `START NEXT BOUT` closes the rest and starts the next bout atomically.

Automated coverage (issue #19), server side only:
`test_pad06_a_bout_cannot_start_while_a_rest_is_open` in
`backend/apps/sync/tests/test_mutations_api.py` finishes a bout into a rest, then
pushes a bare "start bout" mutation (`rejected`, `invalid_transition`, nothing
written, the rest still open), then a close-rest + start-next mutation (`applied`,
both records written); `test_close_rest_and_start_next_roll_back_together` and
`test_finish_bout_and_start_rest_roll_back_together` show both multi-record
operations roll back as a whole. This is the server refusing the out-of-band start.
The device side -- the RESTING state, the `START NEXT BOUT` control, and a local
rule that refuses the start before it is queued -- belongs to the pause/rest
controls (issues #21/#22), is not built yet, and no device run has been performed.

### PAD-07 — Maximum timer

Allow a bout to reach and exceed its configured maximum.

Expected: the HUD alerts the user but does not automatically terminate the bout.

### PAD-08 — Pause

1. Start a bout.
2. Pause for two minutes.
3. Resume.
4. Finish.

Expected: effective walking duration excludes the paused interval.

### PAD-09 — Manual time correction

1. Allow a bout to continue accidentally beyond its intended end.
2. Finish it.
3. Edit the displayed end time.

Expected: bout duration and related derived values are recalculated correctly.

## Resistance training

### GYM-01 — Routine sequence

Complete Day 1.

Expected: `Suggested next: Day 2`.

### GYM-02 — Manual routine selection

After Day 1, manually complete Day 3.

Expected: `Suggested next: Day 4`.

### GYM-03 — Incomplete routine

Finish Day 2 with 5 of 7 exercises checked.

Expected:

- the session is completed;
- five exercises remain historically completed;
- two remain historically incomplete;
- the main routine pointer advances.

### GYM-04 — Weight memory

Existing working weight: `Chest Press = 40 kg`.

During the session change it to `42.5 kg` and mark Chest Press complete.

Expected next appearance: `42.5 kg`.

### GYM-05 — Incomplete weight change

Existing working weight: `Chest Press = 40 kg`.

Change today's target to `42.5 kg` but do not complete the exercise.

Expected next appearance: `40 kg`.

### GYM-06 — Temporary rep scheme

Routine target: `3×10`.

Change today's session to `3×8` without selecting Save to Routine.

Expected next main session: `3×10`.

### GYM-07 — Permanent routine change

Change `3×10 → 3×12` and select `SAVE TO ROUTINE`.

Expected: future routine instances use `3×12`; historical sessions remain unchanged.

## Load setup and progression

### LOAD-01 — Initial 1RM calculation

Enter assessment weight and assessment repetitions.

Expected: estimated 1RM is calculated and stored on `Exercise.estimated_1rm_kg`. No `StrengthAssessment` row is created.

### LOAD-02 — Initial ceiling

Configure maximum automatic starting percentage to `80%`.

Expected: the normal starting-load selector does not automatically offer a value above 80%.

### LOAD-03 — Post-assessment progression

After a working weight is established, request a progression suggestion.

Expected: the calculation uses `current_working_weight_kg` and muscle-group progression percentage, not `estimated_1rm_kg`.

### LOAD-04 — Assessment input validation

See [Resistance & cardio: Assessment input
validation](training.md#assessment-input-validation).

Boundary values for assessment repetitions:

| Input | Expected |
| --- | --- |
| 1 | accepted |
| 12 | accepted |
| 13 | refused, plain message, nothing stored |

Boundary values for assessment weight (kg):

| Input | Expected |
| --- | --- |
| 0 | refused (must be > 0), nothing stored |
| 500 | accepted |
| 500.5 | refused (must be <= 500), nothing stored |

Expected rounding: `50 kg` × `10 reps` → `estimated_1rm_kg = 66.7` (one
decimal place; see the worked example in training.md).

## Server-admin configuration precedence

See [Data & synchronization: Server-admin configuration
precedence](data-sync.md#server-admin-configuration-precedence).

### ADMIN-01 — Device commit after admin edit wins

1. An administrator sets `Exercise.current_working_weight_kg` in Django Admin.
2. A device, offline since before that edit, later completes the same
   exercise row and its queued mutation reaches the server after the admin's
   edit.

Expected: the device's value is the one stored on the server (the later
commit wins); the admin's earlier edit is not silently reapplied or merged.

### ADMIN-02 — Admin edit after device commit wins

1. A device's mutation changing `RoutineExercise` targets (`SAVE TO ROUTINE`)
   reaches the server first.
2. An administrator then edits the same `RoutineExercise` field in Django
   Admin.

Expected: the admin's value is the one stored on the server; the device is
not silently overwritten before its own commit lands, but a later admin edit
does stand once it does.

### ADMIN-03 — Snapshot and history immutability

1. Start a resistance session (its `ResistanceSessionExercise` rows snapshot
   the routine's target weight/sets/reps at that moment).
2. While the session is `ACTIVE`, an administrator edits the source
   `Exercise` or `RoutineExercise`.
3. Complete the session.

Expected: the already-taken `ResistanceSessionExercise` snapshot and the
finished historical session are unchanged by the admin edit; only the next
session copied from the routine reflects it. Pending session edits already
sitting in the device's outbox are never dropped or rewritten by a bootstrap
refresh of cached reference data.

## Cardio

### CARDIO-01 — Machine selection

Create a cardio session and choose `Arm Crank`.

Expected: the session is associated with the configured `CardioMachine`.

### CARDIO-02 — Persistence

Record `Duration: 10 min` and `Level: 4`, then finish.

Expected: values appear correctly in history.

### CARDIO-03 — Offline cardio

Disable connectivity and create/finish a cardio-machine session.

Expected: the session persists locally and synchronizes after connectivity returns.

## Deployment and authentication

### DEPLOY-01 — No public Django port

Run the production Docker Compose deployment.

Expected: Django is reachable from `cloudflared` through `http://web:8000`, but port 8000 is not published directly to the VPS host.

### AUTH-01 — Unauthenticated access and offline continuation

Covers the settled state machine in [Data & synchronization: Authentication
and offline continuation](data-sync.md#authentication-and-offline-continuation)
(confirmed 2026-09-19), including its summary table of all five lifecycle
cases, local-data retention, and the always-authenticated rule for server
access.

**(a) No valid session, protected API endpoint**

Call a protected `/api/v1/` endpoint (i.e. anything outside the public
allowlist in [Architecture: public vs. protected
endpoints](architecture.md#public-vs-protected-endpoints)) without a valid
Django session.

Expected: `401 {"code": "not_authenticated"}`. Separately, an unsafe request
(a state-changing method) without a valid CSRF token is rejected with `403
{"code": "csrf_failed"}` regardless of session state — session validity and
CSRF validity are independent checks, and neither substitutes for the
other. See [Architecture: uniform API error shape](architecture.md#uniform-api-error-shape).

**(b) Device that has never signed in**

Open the application on a device that has never completed a successful
login.

Expected: only the login screen is shown. No local workout data exists yet
to expose, and none is fetched.

**(c) Previously signed-in device without a currently valid session**

Open the application on a device that has signed in before, while offline,
or after the server-side session has expired or been invalidated (e.g. by
`ensure_app_user --reset-password`; see
[Architecture: provisioning the application account](architecture.md#provisioning-the-application-account)).

Expected: the application opens its local (IndexedDB) data immediately,
shows it read-only or with synchronization paused, and prompts for
sign-in. Pending unsynchronized mutations (see [Data &
synchronization](data-sync.md)) are preserved, never discarded, while this
state is resolved — sign-in success resumes synchronization; the user may
also continue working locally.

This case is why session expiry is rolling rather than fixed: see
[Architecture: cookies and CSRF settings](architecture.md#cookies-and-csrf-settings),
which covers rolling session expiry.

A backend guard test (`core.tests.test_url_auth_coverage`) walks every URL
pattern actually registered under `/api/v1/` and asserts that each one
outside the documented public allowlist (health, auth/session, auth/login,
auth/logout) requires authentication, so a future endpoint added without
explicit `permission_classes`/`authentication_classes` cannot silently
become case (a)'s counterexample.

## Overall v1 continuity criterion

After closing and reopening the app, it must correctly restore:

- active-session presence;
- current PAD walking/pause/rest state;
- next suggested resistance routine;
- remembered working weights;
- pending unsynchronized mutations.
