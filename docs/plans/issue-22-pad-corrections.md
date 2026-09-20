# Issue #22 PAD corrections, undo and delete

Source: https://github.com/jmn0space/gym-hud/issues/22

## What was built

**Frontend** (`frontend/src/pad/actions.ts`, exported through `frontend/src/pad/index.ts`):

- `correctWalkingBoutTimesAction` / `correctWalkingPauseTimesAction` /
  `correctWalkingRestTimesAction` -- correct a bout's, pause's or rest's
  `started_at`/`ended_at`. Each rebuilds the session's live bouts/pauses/rests
  with the one corrected record substituted and validates the *whole* result
  with a shared `assertContainedWalkingSession` check (never the edited field
  in isolation) before building the `LocalAction`. `ended_at` may only be
  corrected once the record has actually finished; a correction never
  reopens a closed interval or closes an open one.
- `detectUndoableWalkingTransition` -- a pure function of the current
  `PadSessionView` that identifies which of the five undoable transitions
  (bout started/paused/resumed/finished, rest finished / next bout started),
  if any, is currently reversible, using only the view's own `current*`
  fields and the domain-timestamp coupling each transition itself
  establishes (a bout and the rest it closed share one instant; a bout and
  the pause it force-closed on finish share one instant). Deliberately does
  **not** use the repository's `updated_at` bookkeeping, because that
  timestamp comes from the injected wall clock, which a test -- and in
  principle a device with a stepped-back clock -- can hold fixed or
  non-monotonic on purpose (see the comment in
  `frontend/src/pad/padWorkflow.test.ts`).
- `undoLastWalkingTransitionAction` -- builds the forward compensating
  mutation for whatever `detectUndoableWalkingTransition` found: tombstone or
  reopen exactly the records the original transition touched. Undo is a new,
  higher-sequence `LocalAction`; nothing is ever removed from or rewritten in
  the outbox.
- `deleteWalkingBoutAction` -- tombstones a finished bout and its live pauses
  and rest, and puts every surviving bout of the session with a recomputed,
  contiguous `bout_number` in start order, all in one action.

**UI** (`frontend/src/pages/PadPage.tsx`):

- Each completed bout's card gets a collapsed "Edit times" disclosure with a
  tap-to-reveal `<input type="datetime-local">` per recorded endpoint (bout
  start/end, and its rest's start/end once the rest itself has closed).
  Saving builds the correction against the latest live snapshot the same way
  the existing pain/stop-reason/notes edits already do
  (`readLiveSnapshot`/`requireDisplayedInterval`-style staleness guard), and
  a failed precondition or refused correction surfaces through the same
  `LocalDataStatus` error banner as every other PAD action.
- An "Undo" control appears in the HUD whenever
  `detectUndoableWalkingTransition` finds something, with a confirmation step
  (`role="alertdialog"`) before it commits; cancelling commits nothing.
- Each completed bout's card gets a "Delete bout N" control, also
  confirmation-gated the same way.
- New styles in `frontend/src/styles.css` (`.pad-times`, `.pad-time-field*`)
  match the existing `.pad-notes`/`.pad-pain` visual language and touch
  targets.

**Docs**: `docs/pad-walking.md` ("Editing, undo, and delete") now specifies
the correction validation rules (including the deliberate decision *not* to
auto-move a bout's end and its rest's start together -- each is validated
against the other's current value and refused if that breaks containment,
matching the server's own judgement of the same edit), the undo contract, and
the delete-with-renumber mutation shape. `docs/data-sync.md` now says
precisely which rules the local repository enforces generically (PAD-06,
the one-at-a-time rules, the monotonic clock) versus which the PAD action
layer enforces itself (containment), since that split was previously
undocumented. `docs/acceptance-tests.md` is updated for PAD-06 and PAD-09
with the coverage below.

**Backend**: no gap was found. `backend/apps/pad/sync.py`'s
`settle_session_tree` already validates a mutation's finished state as a
whole regardless of which records it touches (parents before children,
clamping or refusing exactly per docs/data-sync.md), and
`backend/apps/sync/engine.py`'s cascade-delete and tombstone-revive
mechanics are generic, not PAD-specific, and already covered by
`test_deleting_a_bout_tombstones_it_and_its_children`,
`test_an_explicit_undo_restores_a_deleted_bout`,
`test_only_the_deleting_device_can_undo_a_delete`, and
`test_a_time_correction_is_judged_on_the_finished_state` in
`backend/apps/sync/tests/test_mutations_api.py` (all pre-dating this issue).
`bout_number` was already documented as non-unique and display-only
(`backend/apps/pad/models.py`), so a delete-with-renumber mutation needs no
schema or validation change: it is simply a bout delete plus some ordinary
bout-field puts, both already-supported shapes. Only test coverage and two
documentation corrections (see above) were added; no application code in
`backend/` changed. `backend/apps/sync/tests/device.py`'s module docstring
was updated -- it was already stale about which PAD actions exist in the
frontend -- and a short note was added to `delete_bout`'s context explaining
it deliberately does not renumber (existing callers only need the generic
tombstone/cascade/undo mechanics).

## Automated proof and how to run it

1. **Frontend unit tests** for every new action builder and its validation
   refusals: `frontend/src/pad/padCorrections.test.ts` (27 tests) --
   corrections (happy path plus every containment rule listed in
   `docs/pad-walking.md`), undo (all five transitions, "nothing to undo",
   undo surviving an unrelated pain edit on top, undo becoming unavailable
   after a correction moves one side of a coupled pair, survival across
   close/reopen with the reversed action both unpushed and already
   acknowledged), and delete (mid-session, of a currently-rested-after bout,
   refusals, survival across close/reopen).

   ```sh
   cd frontend && npm test -- --run src/pad/padCorrections.test.ts
   ```

2. **PAD-09 recalculation**: the exact acceptance scenario, proved at the
   domain-record level in `padCorrections.test.ts` and at the actual HUD
   level in `frontend/src/pages/PadPage.test.tsx` ("corrects a completed
   bout's recorded end time and recalculates the displayed duration
   (PAD-09)"). See `docs/acceptance-tests.md`'s PAD-09 entry for the exact
   test names.

3. **PAD-06**: `padCorrections.test.ts`'s undo-of-`next_bout_started` test
   proves a session never lands on an open bout alongside an open rest after
   an undo; the correction tests prove a correction cannot open or close an
   interval at all (so it cannot produce that state either); the
   already-existing `checkNewWalkingBoutsAgainstRests` local refusal
   (`frontend/src/storage/repository.ts`, proved by
   `frontend/src/pad/padWorkflow.test.ts`) is unchanged by this issue and
   still holds. See `docs/acceptance-tests.md`'s PAD-06 entry.

4. **Offline reload**: `padCorrections.test.ts` closes and reopens the real
   `createLocalRepository` (fake-indexeddb) mid-flow for both undo and
   delete, in the style of `frontend/src/padWorkflowReplay.test.ts`.
   `frontend/src/padCorrectionsReplay.test.ts` additionally closes and
   reopens the repository once after a full correction/undo/delete sequence
   and re-reads the pending outbox and every touched record.

5. **Before and after synchronization**: `padCorrections.test.ts`'s two
   "survives close/reopen" tests each cover both sides explicitly --
   acknowledging (as if pushed and confirmed by the server) the action being
   undone or the bout being deleted before performing the undo/delete, so the
   compensating mutation is proved to work identically whether or not its
   target has already left the outbox.

   For the cross-language "after synchronization" proof specifically:
   `frontend/src/padCorrectionsReplay.test.ts` drives a real correction, a
   real undo, and a real delete-with-renumber through the actual action
   builders and `createLocalRepository`, and checks the resulting outbox
   envelopes against `backend/apps/sync/tests/fixtures/pad_corrections_outbox.json`.
   `backend/apps/sync/tests/test_pad_corrections_replay.py` posts that fixture
   through the real `POST /api/v1/sync/mutations/` and checks the complete
   server record tree, including that the correction's bout end stands, the
   undone rest never made it past being a tombstone (the mutation that
   created it was still pushed and applied -- undo never removes anything
   from the outbox -- but the compensating undo tombstoned it right after),
   and the deleted bout's sibling renumbered from 3 to 2 with its own UUID
   unchanged. Deliberately a second fixture/test pair rather than an
   extension of issue #21's (`pad_workflow_outbox.json` /
   `test_pad_workflow_replay.py`), so that proof stays exactly as it was.

   ```sh
   cd frontend && npm test -- --run src/padCorrectionsReplay.test.ts
   cd .. && .venv/bin/pytest backend/apps/sync/tests/test_pad_corrections_replay.py
   ```

   Refresh the fixture only with
   `UPDATE_PAD_REPLAY_FIXTURE=1 npm test -- --run src/padCorrectionsReplay.test.ts`
   from `frontend/`, after an intentional protocol/action change.

6. **Duplicate replay**: `test_frontend_pad_corrections_outbox_applies_once_and_replays_as_duplicates`
   (in the same backend test file) resends the identical 14-mutation batch --
   correction, undo and delete-with-renumber included -- and asserts every
   result comes back `duplicate` with the change counter, every model's
   `(pk, change_seq, server_updated_at, deleted_at)` tuples, and the ledger
   row count all unchanged, the same pattern as issue #21's
   `test_pad_workflow_replay.py` and `test_mutations_api.py`.

7. **`PadPage` component tests**
   (`frontend/src/pages/PadPage.test.tsx`, `describe("PAD corrections, undo
   and delete (issue #22)")`, 5 tests): the correction UI end to end (tap,
   type, Save, and a refused correction leaving the stored time and the
   displayed duration unchanged, surfaced through the shared error banner);
   Undo's confirmation (a cancelled confirmation commits nothing, proved by
   asserting the bout is still present and the state unchanged; a confirmed
   one commits); Undo finding the transition underneath an unrelated pain
   edit; and delete's confirmation (cancelled commits nothing; confirmed
   removes the bout and its rest and returns the HUD to the
   `Start walking` control once no bouts remain).

Run everything from the repository root:

```sh
cd frontend && npm run check
cd .. && ruff check backend/ scripts/ tests/ \
       && ruff format --check backend/ scripts/ tests/ \
       && mypy backend/ \
       && .venv/bin/pytest \
       && .venv/bin/python backend/manage.py check --settings=config.settings.test
```

All of the above were run for this change and passed: `npm run check`
(typecheck, eslint `--max-warnings 0`, 394 vitest tests, production build);
`ruff check`/`ruff format --check` clean; `mypy backend/` clean (67 source
files); `pytest` (357 passed, 6 skipped -- the PostgreSQL-only concurrency
tests, which require `TEST_DATABASE_URL`/a running PostgreSQL and are
unrelated to this issue); `manage.py check` clean.

## What is explicitly NOT proven

- **No Android or real-browser device run.** Every test above uses
  fake-indexeddb (frontend) or Django's test client (backend); none of it
  exercises a real IndexedDB implementation, a real touch screen, or a real
  network. See the device procedure below.
- **Pause time correction has no dedicated UI control.** The HUD does not
  currently list a bout's individual pauses anywhere (only the bout's own
  and its rest's start/end are shown), so there is nothing in the UI to tap
  to reveal a pause-time editor. `correctWalkingPauseTimesAction` and its
  validation refusals are fully implemented and unit-tested
  (`padCorrections.test.ts`), ready for a future pause-list UI; this is a
  scope interpretation, not an omission of the action layer.
- **Undo does not chain arbitrarily.** `detectUndoableWalkingTransition` is
  purely a function of the current persisted state, so undoing "bout
  resumed" leaves a state that structurally matches "bout paused" and a
  second undo is offered for it (reopening the bout further); this is a
  deliberate, tested consequence of deriving undo from records rather than a
  stack (see `padCorrections.test.ts`), not a general "undo history" feature.
  There is no redo.
- **Two corrections that coincidentally land two different rests' `ended_at`
  on the exact same instant as a bout's `started_at`** could make
  `detectUndoableWalkingTransition` couple the wrong one. This requires two
  separate, deliberate corrections to construct and is not reachable through
  normal use (a rest's `ended_at` is otherwise only ever set once, by
  `START NEXT BOUT`, always paired with the bout it opens); documented here
  rather than guarded against, given how narrow and inconsequential a
  misfire would be (the compensating action's own preconditions still catch
  a genuinely stale target).
- **Concurrent-device races on a correction/undo/delete** beyond what the
  existing generic `_is_stale`/tombstone-revive/cascade-delete server tests
  already cover (this issue added no new server code, so no new race
  surface). Issue #13's "Android phone is the primary workout-entry device"
  scoping (see `docs/data-sync.md`, "Conflict strategy") still applies.

## Android device check still needed

No Android device (and no real browser session) was used for this
implementation. The following check is pending, and should be recorded with
the device model, Android/Chrome versions, app build, backend build, and
observed server mutation responses -- in the same style as
`docs/device-smoke-tests.md` and issue #21's own device-check section in
`docs/plans/issue-21-pad-workflow.md`.

1. Install and open the PWA on an Android device, sign in while online, and
   start a PAD session. Run a bout well past its intended end (e.g. leave it
   walking for several extra minutes), then `FINISH BOUT`.
2. Open "Edit times for bout 1", tap the "ended" field, and correct it back
   to roughly the intended duration. Confirm the displayed bout duration and
   the rest duration (once a rest is showing) update immediately, with no
   app reload needed.
3. With the corrected bout still the most recent transition on screen (no
   further bout/pause/rest action taken since), confirm an "Undo" control is
   *not* offered for the correction itself (corrections are not one of the
   five undoable transitions) but tapping the primary transition controls
   (Pause, Finish bout, Start next bout) still offers Undo immediately after
   each, with a confirmation step, and that cancelling it leaves the state
   untouched.
4. Add a second and third bout (pause/resume at least once in one of them),
   finish each, then delete the middle bout from its "Delete bout 2" control
   with confirmation. Confirm the remaining bout renumbers to 2 and its own
   recorded pain/notes/times are unchanged.
5. Kill and reopen the PWA after each of the steps above (offline) and
   confirm the corrected/undone/deleted state, and its display numbering,
   survive exactly as left.
6. While still offline, use remote Chrome DevTools to inspect the PWA
   origin's `gym-hud-local` IndexedDB database and confirm the outbox holds
   one envelope per action above (correction, undo, delete), in ascending
   `sequence`, with the delete's envelope carrying the renumbering puts in
   the same entry as the bout and rest deletes.
7. Reconnect, let the app's own sync engine drain the outbox (issue #20;
   this issue adds no new sync-engine behaviour), and inspect the server's
   PAD records through Django Admin (read-only) to confirm they match what
   the device shows. Resubmit the same captured outbox once more by hand
   (as in issue #21's step 4) to verify duplicate acknowledgements and
   unchanged records.

This is a concrete, runnable procedure once a device is available; no part of
it is blocked on further implementation work.
