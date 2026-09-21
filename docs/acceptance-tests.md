# Acceptance Criteria

[← Documentation index](README.md) · [PAD walking](pad-walking.md) · [Resistance & cardio](training.md) · [Architecture](architecture.md) · [Data & sync](data-sync.md) · [Device smoke tests](device-smoke-tests.md) · [PAD pilot validation](pad-pilot-validation.md)

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
protocol](data-sync.md#server-synchronization-protocol)). Issue #20 delivered the
client sync engine that drains the outbox and pulls reference data (see [Data &
synchronization: client obligations](data-sync.md#client-obligations)). Issue
#21 then delivered the pause, finish-bout, and start-next-bout controls
(`Pause`/`Resume`, `Finish bout`, `Start next bout` in
`frontend/src/pages/PadPage.tsx`), which unblocks the PAUSED and RESTING items
below; each item is annotated with exactly what it is still waiting on, if
anything. Issue #23 is the validation pass across all of this: its evidence
record is [`docs/pad-pilot-validation.md`](pad-pilot-validation.md), which
tracks device and automated coverage per acceptance ID and is the place to
check the current pass/fail status rather than this checklist's own item-level
notes.

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
  `Resume PAD Walking` with the correct READY, WALKING, PAUSED, or RESTING state.
  **Fully runnable; not yet run.** The "installed," "force-stop," and
  "cold-start reopen while offline" mechanics are a concrete procedure in
  [`docs/device-smoke-tests.md`](device-smoke-tests.md). Issue #18's controls
  make the WALKING case runnable (Part B, PAD-02 below); issue #21's `Pause`
  and `Finish bout` controls make PAUSED and RESTING runnable too — see Part C,
  steps C3–C4 (PAUSED) and C6 (RESTING). The application reconstructs and
  displays all three states when the records exist, and automated tests cover
  that, but no device run has been performed. See
  [`docs/pad-pilot-validation.md`](pad-pilot-validation.md) for the issue #23
  evidence record.
- [ ] Complete a multi-record transition offline, reload, and confirm its pending
  synchronization action is still present exactly once.
  **Fully unblocked; not yet run.** `FINISH SESSION` with a bout still open is
  one such multi-record transition (it closes the bout and completes the
  session together). The specific transition LOCAL-03 names — finishing a bout
  and starting its rest — is issue #21's `Finish bout` control, exercised
  offline end to end in Part C, steps C7–C11 of
  [`docs/device-smoke-tests.md`](device-smoke-tests.md) (PAD-03). See
  [`docs/pad-pilot-validation.md`](pad-pilot-validation.md) for the issue #23
  evidence record.
- [ ] Restore connectivity and confirm a failed synchronization attempt remains
  pending for retry.
  **No longer blocked; not yet run.** The client sync engine (issue #20,
  `frontend/src/sync/engine.ts`) now drains the outbox and retries with
  bounded backoff; see PAD-04 below for the automated coverage of the same
  offline-queue-then-drain behaviour and [Data & synchronization: sync
  gate](data-sync.md#sync-gate). This box is the real-device run: a genuine
  network toggle, not a mocked one, has not been performed. See Part C, steps
  C12–C14 of [`docs/device-smoke-tests.md`](device-smoke-tests.md) and
  [`docs/pad-pilot-validation.md`](pad-pilot-validation.md) for the issue #23
  evidence record.

These boxes record manual device work only. Automated browser and repository tests
do not mark them complete. See the Overall v1 continuity criterion at the end of
this document for the acceptance-level statement these checks, PAD-02, and
`docs/device-smoke-tests.md` all serve.

## Home screen and session cardinality

See [Product overview: Active-session cardinality and Home Resume
cards](product-overview.md#active-session-cardinality-and-home-resume-cards)
for the settled combination table this section exercises.

### HOME-01 — Resume cards per combination of active types

For each combination of active session types (PAD, resistance, cardio — all
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

Expected: the PAD start action is not offered; its Resume card is the only
PAD action available, and it must be used to resume, finish, or discard the
existing session before another PAD session can start (and similarly for
resistance and cardio). Starting resistance or cardio from the same screen
remains unaffected.

Target behaviour; the Home start gating is not implemented yet.
`frontend/src/pages/HomePage.tsx` always links to PAD, resistance, and
cardio regardless of which types are already active (per its own comment,
this becomes "Start new" gating once those screens can actually start a
session), so this test cannot pass against the app as it stands today.

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
performed. See [`docs/pad-pilot-validation.md`](pad-pilot-validation.md) for
the issue #23 evidence record and current status.

Real-browser coverage (issue #23): `PAD-01 — lock-screen recovery: displayed
duration resyncs after a visibility/focus recovery signal, and ONLY via that
resync path` in `frontend/e2e/pad-walking.spec.ts` installs Playwright's
`page.clock` before navigation and pauses it, so `useNow`'s `setInterval`
(`frontend/src/pad/useNow.ts`) provably cannot tick even once while fake time
advances 10s; the displayed duration can only catch up through the
`visibilitychange`/`focus` resync listeners. This test is genuinely
fail-sensitive to that resync path specifically, not merely to "does the
duration eventually update": deleting those two listeners from `useNow.ts`
makes it fail (a stale 10000ms reading against a 1100ms tolerance), and
restoring them makes it pass again. Still a real desktop-Chromium browser,
not the target Android device — see
[`docs/pad-pilot-validation.md`](pad-pilot-validation.md#what-automated-evidence-can-and-cannot-establish)
for exactly what a paused fake clock cannot establish about a real locked
phone.

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
performed. See [`docs/pad-pilot-validation.md`](pad-pilot-validation.md) for
the issue #23 evidence record and current status.

Real-browser coverage (issue #23): `PAD-02 — application termination: Home
reconstructs the WALKING state and elapsed duration after a cold reopen, and
resuming shows the same in the PAD HUD` in `frontend/e2e/pad-walking.spec.ts`
covers the WALKING case, and `PAD-02 — application termination: Home
reconstructs the RESTING state after a cold reopen while resting, and
resuming offers Start next bout` in `frontend/e2e/pad-offline.spec.ts` covers
RESTING; the PAUSED case is exercised by `PAD-08 — pause: the PAUSED state
and its excluded-pause elapsed time restore after a cold reopen`
(`pad-walking.spec.ts`). All three use `coldReopen`
(`frontend/e2e/support/fixtures.ts`), which closes a real Playwright `Page`
and opens a fresh one in the same browser context — a genuine service-worker
and IndexedDB-connection teardown/re-establishment, which is closer to a
real termination than unmounting a React tree, but it is still one `Page`
closing inside a process Playwright itself keeps alive throughout, not an
Android force-stop killing the whole application process. See
[`docs/pad-pilot-validation.md`](pad-pilot-validation.md#what-automated-evidence-can-and-cannot-establish)
for why that distinction still matters.

### PAD-03 — Offline session

1. Disable connectivity.
2. Start a bout.
3. Finish it.
4. Record pain 3–4.
5. Rest.
6. Start the next bout.

Expected: all operations work locally.

Every step of this sequence is available through the UI as of issue #21
(`Start walking`, `Finish bout`, the pain selector, `Start next bout` in
`frontend/src/pages/PadPage.tsx`), so this is now a runnable device
procedure — see Part C, steps C7–C11 of
[`docs/device-smoke-tests.md`](device-smoke-tests.md) — but no device run
has been performed. See [`docs/pad-pilot-validation.md`](pad-pilot-validation.md)
for the issue #23 evidence record.

Real-browser coverage (issue #23): `PAD-03 — offline session: bout, finish,
pain, rest and next bout all work while offline` in
`frontend/e2e/pad-offline.spec.ts` runs this exact sequence — start, finish,
pain 3–4, start next bout — under a genuine `context.setOffline(true)`
network cut (not a mocked `fetch` failure), and confirms zero requests
reached the mock server at any point. Real desktop-Chromium networking, not
a real device's radio, DNS, or captive-portal behaviour.

### PAD-04 — Reconnection

After PAD-03, restore connectivity.

Expected: queued data synchronizes without manual re-entry.

Automated coverage (issue #20): `"sends queued mutations in ascending sequence
once the gate turns true (PAD-03 -> PAD-04)"` in
`frontend/src/sync/engine.test.ts` queues mutations against a `canSync` gate
held false, confirms nothing is sent while it is false, then flips it true and
asserts the whole queue is sent in one batch in ascending `sequence`,
acknowledged, and the pending outbox ends empty -- with no manual re-entry,
against a real `createLocalRepository`. The whole path is also exercised
end-to-end (real `fetch`, real `SyncProvider`) in `"drains a pending mutation
through the real sync engine once authenticated and online"` in
`frontend/src/App.test.tsx`. That covers the drain itself, not the device:
the real airplane-mode-then-restore run is the checklist box above and Part B
of [`docs/device-smoke-tests.md`](device-smoke-tests.md), neither of which has
been performed. The full offline-then-reconnect sequence, including a
concrete server-side check for "one server record per logical action," is
Part C, steps C12–C14 of the same document. See
[`docs/pad-pilot-validation.md`](pad-pilot-validation.md) for the issue #23
evidence record.

Real-browser coverage (issue #23): `PAD-04 — reconnection drains the whole
offline queue with no manual re-entry, in order, one applied server record
per logical action` in `frontend/e2e/auth-sync.spec.ts` queues six distinct
logical PAD actions under a genuine `context.setOffline(true)`, then flips
connectivity back on and polls the mock server's own ledger for exactly six
applied mutations, in ascending sequence, with a per-mutation signature
distinguishing "finish bout 1" from "start bout 2" — no manual "Sync now" or
re-entry involved, matching Trigger 4 (the browser's own `online` event).
Real desktop-Chromium networking and a real mock HTTP server, not the target
device's radio.

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
them.

Automated coverage (issue #20), client side: `"resends a batch whose
acknowledgement was lost; the resend comes back duplicate and is acknowledged
exactly once (PAD-05)"` in `frontend/src/sync/engine.test.ts` makes the first
push fail at the network level (an indistinguishable-from-lost-response
failure), confirms the mutation is still queued and untouched, then lets the
resend succeed and come back `duplicate`, asserting it is acknowledged exactly
once and the pending outbox ends empty. Together with the server-side coverage
above this proves "only one logical server-side event exists" end to end
through the client's own retry path. Not verified here: the
transmit-twice-from-the-phone real-device run (radio toggled mid-request,
genuine duplicate delivery) — see
[`docs/device-smoke-tests.md`](device-smoke-tests.md). No device procedure
for that specific real-device scenario has been written yet; see
[`docs/pad-pilot-validation.md`](pad-pilot-validation.md) for the issue #23
evidence record and why it is out of scope for the current device
procedure.

Real-browser coverage (issue #23): `PAD-05 — a mutation delivered twice
because its first acknowledgement was lost is applied exactly once` in
`frontend/e2e/auth-sync.spec.ts` intercepts the first push with
`route.fetch()` (letting the mock server genuinely apply and ledger the
mutation) followed by `route.abort("failed")` (throwing the response away
before the client sees it) — deliberately indistinguishable, from the
client's point of view, from a real lost acknowledgement. The client's own
retry path (`syncNow`) then resends, gets back `duplicate`, and the test
confirms exactly one applied mutation on the server despite two-or-more
deliveries. This proves the client's real retry code and the mock server's
real ledger agree end to end in a real browser; it is not, and does not
claim to be, the genuine radio-toggle duplicate-delivery device scenario
above.

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

The device side -- the RESTING state and the `START NEXT BOUT` control -- shipped
in issue #21 (`frontend/src/pages/PadPage.tsx`); the local rule that refuses an
out-of-band start before it is even queued (`checkNewWalkingBoutsAgainstRests` in
`frontend/src/storage/repository.ts`) is exercised by `"rejects an out-of-band
bout while resting, including a race from another connection"` in
`frontend/src/pad/padWorkflow.test.ts`, including a second, independent
repository connection racing the legal `START NEXT BOUT` against an illegal bare
put.

**Automated coverage (issue #22):** correction, undo and delete must never
produce the state PAD-06 forbids either. `frontend/src/pad/padCorrections.test.ts`
("undoes the rest-finished/next-bout-started transition, restoring RESTING
(PAD-06)") undoes a `START NEXT BOUT` and asserts the session lands on exactly
one open interval -- never an open bout alongside an open rest -- by reading
every bout and rest back from the repository; the same file's correction tests
prove that `correctWalkingBoutTimesAction`/`correctWalkingPauseTimesAction`/
`correctWalkingRestTimesAction` can only change the *value* of an endpoint that
is already recorded (never re-open a closed one), so a correction cannot create
this state by construction; `deleteWalkingBoutAction`'s test deletes a bout that
is currently being rested after and confirms the session returns to READY, not
to a dangling open rest.

This is now a runnable device procedure -- see Part C, step C6 of
[`docs/device-smoke-tests.md`](device-smoke-tests.md) -- but no device run has
been performed. See [`docs/pad-pilot-validation.md`](pad-pilot-validation.md)
for the issue #23 evidence record.

Real-browser coverage (issue #23): `PAD-06 — rest integrity: Start walking
is not offered while RESTING, and Start next bout closes the rest and
starts the next bout atomically` in `frontend/e2e/pad-offline.spec.ts` runs
this offline, on purpose: it strengthens the claim that the restriction is a
local UI/state-machine rule (`requireState(view, "RESTING")` in
`frontend/src/pad/actions.ts`) rather than something only a reachable server
enforces. It confirms `Start walking` does not exist in the DOM at all while
RESTING (not merely hidden or disabled) and that `Start next bout` closes
the rest and opens the next bout in one tap with nothing pushed to the
server throughout. This is UI-level coverage of the local rule; the
server-side rejection path above remains the server-side evidence.

### PAD-07 — Maximum timer

Allow a bout to reach and exceed its configured maximum.

Expected: the HUD alerts the user but does not automatically terminate the bout.

This is a runnable device procedure — `WalkingHud` grows a `· Maximum
reached` alert once `hasReachedMaximum` is true and never stops the bout on
its own (`frontend/src/pages/PadPage.tsx`, `frontend/src/pad/session.ts`) —
see Part C, steps C15–C16 of [`docs/device-smoke-tests.md`](device-smoke-tests.md),
which has not been run. See [`docs/pad-pilot-validation.md`](pad-pilot-validation.md)
for the issue #23 evidence record.

Real-browser coverage (issue #23): `PAD-07 — maximum timer: the HUD alerts
once the maximum bout is reached but does not auto-terminate the bout` in
`frontend/e2e/pad-walking.spec.ts` sets `Maximum bout (minutes)` to `0.5`
(the smallest legal value) and genuinely waits out the full 30 real
wall-clock seconds — not a faked clock, since `useNow`'s interval is already
running against the page's real timers before this test could install one —
confirming the `· Maximum reached` alert appears, the bout stays WALKING
with `Pause`/`Finish bout` still offered, `Start next bout` never appears,
and no `walking_rests` mutation was ever pushed to the server.

### PAD-08 — Pause

1. Start a bout.
2. Pause for two minutes.
3. Resume.
4. Finish.

Expected: effective walking duration excludes the paused interval.

Runnable since issue #21 added the `Pause`/`Resume` controls
(`pauseWalkingBoutAction`/`resumeWalkingBoutAction` in
`frontend/src/pad/actions.ts`, whose derivation is
`walkingElapsedMs`/`pausedMs` in `frontend/src/pad/session.ts`) — see Part C,
steps C1–C5 of [`docs/device-smoke-tests.md`](device-smoke-tests.md), which
also covers this state surviving a force-stop and offline cold-reopen. No
device run has been performed. See
[`docs/pad-pilot-validation.md`](pad-pilot-validation.md) for the issue #23
evidence record.

Real-browser coverage (issue #23): `PAD-08 — pause: effective walking
duration excludes the paused interval` in `frontend/e2e/pad-walking.spec.ts`
walks a real ~3s, pauses a real ~3s, walks a further real ~2s, then finishes
the bout and asserts the recorded duration matches the two measured walk
spans (not the raw total) within an 800ms tolerance — measured against
`Date.now()` at each click rather than nominal wait constants, so the only
slack is the commit round-trip. `PAD-08 — pause: the PAUSED state and its
excluded-pause elapsed time restore after a cold reopen` covers the pause
surviving a `coldReopen`: the excluded-pause figure reconstructs to the
pre-pause walking time immediately after reopening and does not keep
growing while the pause stays open through more real waiting afterwards.

### PAD-09 — Manual time correction

1. Allow a bout to continue accidentally beyond its intended end.
2. Finish it.
3. Edit the displayed end time.

Expected: bout duration and related derived values are recalculated correctly.

Automated coverage (issue #22): `"recalculates bout duration, effective walking
time, rest duration and session totals after correcting a late finish"` in
`frontend/src/pad/padCorrections.test.ts` runs exactly this scenario -- a bout
that runs to 30 minutes instead of the intended ~8, with a pause in it, finished,
then its end time corrected back to minute 8 -- against a real
`createLocalRepository`, and asserts `walkingElapsedMs` (the pause-adjusted
effective walking time) and `totalWalkingMs` (the session total) both
recalculate from the corrected stored timestamps alone, with no separate
recomputation step. `"corrects a completed bout's recorded end time and
recalculates the displayed duration (PAD-09)"` in
`frontend/src/pages/PadPage.test.tsx` runs the same scenario through the actual
HUD controls -- tapping "Edit times for bout 1", typing a corrected end time, and
Save -- and asserts the displayed duration updates from "20:00" to "08:00".
`frontend/src/padCorrectionsReplay.test.ts` /
`backend/apps/sync/tests/test_pad_corrections_replay.py` replay the same kind of
correction, generated by the real action builder, through the real
`POST /api/v1/sync/mutations/` endpoint and check the server's stored bout
matches. Invalid corrections (an end before its own start, a bout starting
before its session, a pause left open past its now-closed bout, overlapping
pauses, a rest starting before its bout ended) are each refused with their own
test in `padCorrections.test.ts`.

This is now a runnable device procedure -- see Part C, steps C27–C32 of
[`docs/device-smoke-tests.md`](device-smoke-tests.md) -- but no device run has
been performed. See [`docs/pad-pilot-validation.md`](pad-pilot-validation.md)
for the issue #23 evidence record.

Real-browser coverage (issue #23): `PAD-09 — manual time correction:
correcting an overrun bout's recorded end time recalculates the displayed
duration and effective walking time, and reaches the server as one applied
mutation` in `frontend/e2e/pad-corrections.spec.ts` runs the acceptance
scenario itself in a real browser -- a real walk, pause and resume, a
deliberate real-time overrun, `Finish bout`, then a correction entered through
the actual "Edit times for bout 1" control and `Save` -- and asserts the
displayed duration recalculates to the corrected, pause-excluded value (not
the overrun one) and that the correction reaches the mock server as exactly
one applied mutation, matched on the corrected timestamp itself so it cannot
be confused with the bout's earlier start/pause/resume/finish mutations. `PAD-09
— manual time correction: the corrected end time, not the pre-correction
overrun, is what survives a cold reopen and feeds the next session's total`
confirms the corrected value, not the overrun one, is what a `coldReopen`
restores and what the next "Last session" summary card reads back once the
session is finished -- the two things neither `padCorrections.test.ts` nor
`PadPage.test.tsx`'s jsdom coverage can reach on their own.

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
| 0 | refused, nothing stored |
| 1 | accepted |
| 12 | accepted |
| 13 | refused, plain message, nothing stored |
| 10.5 | refused, nothing stored |
| empty or non-numeric | refused, nothing stored |

Boundary values for assessment weight (kg):

| Input | Expected |
| --- | --- |
| 0 | refused (must be > 0), nothing stored |
| 0.5 | accepted |
| 500 | accepted |
| 500.5 | refused (must be <= 500), nothing stored |
| 50.25 | refused (not a 0.5 kg step), nothing stored |

Expected rounding: `50 kg` × `10 reps` → `estimated_1rm_kg = 66.7` (one
decimal place; see the worked example in training.md). At `estimated_1rm_kg
= 66.7`, the 65% preview asserts `43.4` (`66.7 × 0.65 = 43.355`, rounded
half up to one decimal; see [Resistance & cardio: Starting-load
preview](training.md#starting-load-preview)).

## Server-admin configuration precedence

See [Data & synchronization: Server-admin configuration
precedence](data-sync.md#server-admin-configuration-precedence). These run
once the `exercise_registry` and `routine_exercises` stores sync; until then
those mutations stay queued (`retry`).

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

Expected: the admin's value is stored; the device's earlier committed value
is replaced, and the device receives the admin's value through the changes
feed.

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
(confirmed 2026-09-19), local-data retention, and the always-authenticated
rule for server access. Cases (a)–(c) below cover unauthenticated and
offline access to the API and to local data. The remaining two lifecycle
cases from that section's summary table — explicit logout and
different-user protection — are covered by automated tests in
`frontend/src/auth/AuthProvider.test.tsx` (the `AuthProvider logout` and
`AuthProvider account-mismatch (finding #2)` describe blocks) rather than
restated here.

Case (c)'s device evidence — invalidating a real session server-side while
the phone holds a pending offline workout, then reconnecting and
re-authenticating — is Part C, steps C17–C21 of
[`docs/device-smoke-tests.md`](device-smoke-tests.md); no device run has
been performed. See [`docs/pad-pilot-validation.md`](pad-pilot-validation.md)
for the issue #23 evidence record.

Real-browser coverage (issue #23) for case (c): `AUTH-01(c) — session expiry
during a pending offline workout keeps local data and the outbox untouched,
and drains once with no duplicates after re-authenticating` in
`frontend/e2e/auth-sync.spec.ts` queues three mutations offline, invalidates
the session server-side while still offline (so the device genuinely cannot
know yet), then reconnects — the resulting 401 on the drain attempt, not the
offline gap itself, is what flips `authStatus` to `expired`. It confirms the
PAD screen stays live and usable throughout (never unmounted), the outbox
and applied-mutation count stay untouched until re-authentication, and the
whole three-mutation queue then drains once, in order, with no duplicates,
through the expired-session banner's own inline sign-in form — no
sign-out/sign-in round trip. This is a real session invalidation against
the mock server and a real client-side `authStatus` transition, not a
mocked 401; it is still desktop Chromium against a mock server, not the
target device against the real backend, which is what Part C's device run
above still needs to prove.

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

Real-browser suite (issue #23), mock-fidelity guard only: `AUTH-01(a) mock-fidelity guard — the
harness's guardProtectedEndpoint reproduces the real server's 401-before-403
ordering` in `frontend/e2e/auth-sync.spec.ts` is **not** acceptance evidence
for case (a) — every assertion in it targets the harness's own mock
(`support/server.ts`'s `guardProtectedEndpoint`), never the real Django
server, so it cannot fail if the real `SessionAuthentication.enforce_csrf`
ordering in `backend/core/authentication.py` regressed. It stays useful as a
guard that the mock keeps reproducing the documented 401-before-403 ordering
faithfully, so `AUTH-01(b)`/`(c)` below are not misled by a mock that has
drifted from the real contract. The genuine, real-server evidence for case
(a) remains `backend/core/tests/test_auth.py` and the backend guard test
below.

**(b) Device that has never signed in**

Open the application on a device that has never completed a successful
login.

Expected: only the login screen is shown. No local workout data exists yet
to expose, and none is fetched.

Real-browser coverage (issue #23): `AUTH-01(b) — a device that has never
signed in shows only the login screen and fetches no workout data` in
`frontend/e2e/auth-sync.spec.ts` is genuine product coverage: it asserts the
login form (`Username`/`Password`/`Sign in`) is shown, primary navigation
and PAD links do not exist, and — read from the mock server's own request
log, captured from the very first byte the browser sent this origin, not
from a route installed mid-test — zero `/api/v1/sync/` requests, zero
pushes, zero applied mutations.

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
- current PAD ready/walking/pause/rest state;
- next suggested resistance routine;
- remembered working weights;
- pending unsynchronized mutations.
