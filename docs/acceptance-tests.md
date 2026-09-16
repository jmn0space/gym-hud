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
remain release checks for the complete features and have not been performed as
part of issue #15:

- [ ] Start a PAD bout while offline and confirm the saved state is visible.
- [ ] Lock the phone long enough for the timer display to become stale, then unlock
  and confirm elapsed time is recomputed from stored UTC timestamps.
- [ ] Force-stop the installed PWA/browser process, reopen it, and confirm Home shows
  `Resume PAD Walking` with the correct WALKING, PAUSED, or RESTING state.
- [ ] Complete a multi-record transition offline, reload, and confirm its pending
  synchronization action is still present exactly once.
- [ ] Restore connectivity and confirm a failed synchronization attempt remains
  pending for retry.

These boxes record manual device work only. Automated browser and repository tests
do not mark them complete.

## PAD

### PAD-01 — Lock-screen recovery

1. Start a bout.
2. Lock the phone.
3. Leave it locked for several minutes.
4. Unlock.
5. Resume the PWA.

Expected: displayed duration matches timestamp-derived duration.

### PAD-02 — Application termination

1. Start a bout.
2. Fully terminate the PWA/browser process.
3. Reopen the application.

Expected: the home screen exposes `Resume PAD Walking` and reconstructs the correct state and elapsed duration.

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

### PAD-05 — Duplicate mutation

Transmit the same mutation twice.

Expected: only one logical server-side event exists.

### PAD-06 — Rest integrity

While resting, attempt to start another bout outside the normal control.

Expected: a new walking bout cannot start until the existing rest is closed. `START NEXT BOUT` closes the rest and starts the next bout atomically.

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
[Architecture: rolling session expiry](architecture.md#cookies-and-csrf-settings).

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
