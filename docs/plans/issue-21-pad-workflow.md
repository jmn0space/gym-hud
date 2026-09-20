# Issue #21 PAD workflow replay evidence

Source: https://github.com/jmn0space/gym-hud/issues/21

## Scope and automated proof

`frontend/src/padWorkflowReplay.test.ts` drives the actual PAD action builders
through `createLocalRepository`, using a deterministic clock and IDs. It starts
READY, starts a bout, pauses and resumes twice, pauses a third time, then finishes
the still-paused bout in one action. It records pain 3–4, overrides the stop reason
to claudication, saves bout and session notes, starts the next bout from RESTING,
finishes that bout, then completes the session from RESTING. The test closes and
reopens the IndexedDB repository during the active pause and again after session
completion. It checks that all 13 pending mutations survive in sequence and that
the locally persisted records yield three effective walking minutes in bout one
and five minutes across both bouts.

The test compares the **real outbox envelopes** to
`backend/apps/sync/tests/fixtures/pad_workflow_outbox.json`. An intentional change
to the action or envelope format updates the fixture only with
`UPDATE_PAD_REPLAY_FIXTURE=1 npm test -- --run src/padWorkflowReplay.test.ts`
from `frontend/`; a normal test run requires exact equality. The fixture is a
cross-language contract, not a hand-written approximation of the payload.

`backend/apps/sync/tests/test_pad_workflow_replay.py` submits that fixture as a
single authenticated request to the existing
`POST /api/v1/sync/mutations/` endpoint. It requires all 13 acknowledgements to
be `applied`, checks the complete server record tree, notes, interval endpoints,
effective timing, and that no interval remains open. A repeat of the same request
must return 13 `duplicate` acknowledgements without changing any record, ledger
count, or sync cursor. This proves the persisted frontend outbox can be replayed
through the real server path. It does **not** prove an automatic client drain on
reconnection; that is issue #20.

Run the paired checks from the repository root:

```sh
cd frontend && npm test -- --run src/padWorkflowReplay.test.ts
cd .. && .venv/bin/pytest backend/apps/sync/tests/test_pad_workflow_replay.py
```

Use `TEST_DATABASE_URL` for the PostgreSQL test database when validating against
the production database engine. The backend test also runs with the default
SQLite test configuration.

## Android device check still needed

No Android device was available for this implementation. The following device
check is pending, and should be recorded with the device model, Android/Chrome
versions, app build, backend build, and observed server mutation responses.

1. Install and open the PWA on an Android device, sign in while online, and start
   a PAD session. Confirm the configured speed, incline, and maximum bout.
2. Disconnect the device. Start a bout, pause/resume twice, pause again, and finish
   the bout while paused. Record pain 3–4, change the stop reason, and save bout
   and session notes. Start the next bout from rest, finish it, and complete the
   session from rest. Kill and reopen the PWA during the paused state and after
   completion; verify the paused state, notes, timers, completed-session summary,
   and persisted records survive the reopens.
3. While still offline, use remote Chrome DevTools to inspect the PWA origin's
   `gym-hud-local` IndexedDB database. Save the `internal_metadata` row keyed
   `client_id` and the ordered `outbox` entries. Confirm that each control action
   produced one envelope and that their `sequence` values increase. Preserve the
   outbox and a copy of its JSON; the app does not yet drain it automatically.
4. Reconnect and sign in as the same account. Submit the captured `{client_id,
   mutations}` as an authenticated JSON request, in outbox sequence order, to
   `/api/v1/sync/mutations/` with the session cookie and CSRF token. Check every
   acknowledgement and inspect the server PAD records. Repeat the **identical**
   request to verify duplicate acknowledgements and unchanged records. Do not
   acknowledge or remove the local outbox as part of this manual replay check.

Step 4 is an explicit one-shot protocol test while issue #20 remains open. The
automated fixture already proves the same endpoint with production-shaped
payloads; the device procedure separately checks real PWA persistence and browser
conditions, which fake IndexedDB cannot establish.

## Desktop browser observations

On 2026-09-19, the in-app browser on localhost used the frontend dev build with
the Django/PostgreSQL backend. A paused bout survived a reload with its timer
frozen at 25 seconds. Resume continued the bout; the 30-second maximum appeared
at 39 seconds while walking continued. A second pause followed by Finish bout
entered RESTING. The inferred maximum stop reason was changed to Other, and bout
and session notes survived another reload with their editors collapsed by default.

On 2026-09-20, the same browser recovered the prior day's rest, notes, and pain
after about 18 hours. Start next bout closed the prior rest and opened bout two.
Pain 3 followed by an early Finish bout inferred Claudication. Finish session
from RESTING showed a two-bout, 00:47 walking summary (44 and 3 seconds); a
reload retained that summary and inherited the 30-second maximum. These are
browser observations, not Android device or automatic sync-drain evidence.
