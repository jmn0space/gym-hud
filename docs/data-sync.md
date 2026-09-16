# Data & Synchronization

[← Documentation index](README.md) · [Architecture](architecture.md) · [PAD walking](pad-walking.md) · [Resistance & cardio](training.md) · [Acceptance criteria](acceptance-tests.md)

## Entity summary

```text
User

WalkingSession
└── WalkingBout
    ├── WalkingBoutPause
    └── WalkingRest

ResistanceSession
└── ResistanceSessionExercise

RoutineTemplate
└── RoutineExercise
    └── Exercise
        └── MuscleGroup

CardioMachine
└── CardioMachineSession
```

`Exercise` stores:

```text
current_working_weight_kg
estimated_1rm_kg
machine_increment_kg
```

There is no `ResistanceSet`, `StrengthAssessment`, `ArmCrankSession`, or `GymVisit` model in v1.

## Local-first rule

Every meaningful user action must be saved locally before the UI reports success.

```text
User action
    ↓
Validate the action structure
    ↓
One IndexedDB read/write transaction
├── check record preconditions and active-session rules
├── domain record changes
├── durable action receipt and monotonic sequence
└── one ordered outbox envelope
    ↓
Transaction completes
    ↓
UI reports success from persisted state
    ↓
Server synchronization when available
```

This rule applies to PAD, resistance, and cardio sessions. A failed request anywhere
in the transaction aborts the whole action, so domain records cannot be committed
without their synchronization work. The application does not await the network
inside an IndexedDB transaction.

Commits, outbox acknowledgement, and metadata/reference-cache writes all open
their transaction with `{ durability: "strict" }`, so a committed action is
intended to survive process termination, not just a relaxed OS-page-cache write
that a battery-dying power loss could still lose. Browsers that do not support
the option ignore it.

If the underlying IndexedDB connection is force-closed by the browser (storage
eviction, the IDB server process dying, the user clearing site data) or a
transaction cannot start because it went stale (`InvalidStateError`), the
repository drops its cached connection so the next call reopens automatically,
rather than failing every read and write until the page is reloaded.

This is a versioned **local contract**. Its outbox envelope and ordering rules are
provisional until the backend synchronization contract in issue #13 is agreed. It
does not define server conflict resolution or an acknowledgement API.

## Local action contract

A logical user action may update several records, but it produces one commit receipt
and one outbox envelope. The envelope captures immutable, full record changes in
dependency order: parent creates precede children, while child deletes precede
parents. Deletes are stored as tombstones with stable identity and timestamps so a
later synchronization attempt can represent the deletion.

```json
{
  "version": 1,
  "mutation_id": "action UUID",
  "sequence": 42,
  "created_at": "2026-09-14T10:15:30.000Z",
  "changes": [
    {
      "store": "walking_bouts",
      "entity_type": "walking_bout",
      "entity_id": "next bout UUID",
      "operation": "put",
      "record": {
        "id": "next bout UUID",
        "walking_session_id": "session UUID",
        "started_at": "2026-09-14T10:15:30.000Z",
        "ended_at": null,
        "created_at": "2026-09-14T10:15:30.000Z",
        "updated_at": "2026-09-14T10:15:30.000Z",
        "deleted_at": null
      }
    },
    {
      "store": "walking_rests",
      "entity_type": "walking_rest",
      "entity_id": "finished rest UUID",
      "operation": "put",
      "record": {
        "id": "finished rest UUID",
        "walking_bout_id": "finished bout UUID",
        "started_at": "2026-09-14T10:10:30.000Z",
        "ended_at": "2026-09-14T10:15:30.000Z",
        "created_at": "2026-09-14T10:10:30.000Z",
        "updated_at": "2026-09-14T10:15:30.000Z",
        "deleted_at": null
      }
    }
  ]
}
```

The repository allocates `sequence` inside the same transaction. It is the local
edit order even if the wall clock moves backwards; timestamps remain UTC ISO
strings for elapsed-time reconstruction and display. An `action UUID` is stable
across retries. Its durable receipt remains after the corresponding pending outbox
entry is acknowledged, preventing a retry from creating a second logical action.

Callers may supply record preconditions. The repository evaluates them inside the
write transaction, which prevents two tabs or independent connections from both
successfully applying changes based on the same stale state.

## Active-session recovery

Active state must be reconstructable from persisted data rather than in-memory timers.

Example:

```text
started_at = 18:42:00
current time = 18:47:32

display = 05:32
```

The same timestamp-derived approach applies to:

- walking bouts;
- pauses;
- rest periods;
- timed cardio sessions.

After screen lock, reload, PWA termination, or browser-process termination, the application reconstructs state from IndexedDB and timestamps.

The current local baseline allows at most one `ACTIVE` session per type: one PAD,
one resistance, and one cardio session. Different session types may be active at
the same time, and Home exposes one Resume card for each. This baseline is pending
the final backend model and synchronization decisions in issue #13.

Within a PAD session, the transaction also prevents two live open bouts for the
same session and two live open pauses or rests for the same bout. This protects
double-taps and concurrent tabs without relying on in-memory button state.

## IndexedDB stores

The current local schema version is 3. It uses these stores:

```text
walking_sessions
walking_bouts
walking_pauses
walking_rests

resistance_sessions
resistance_rows

cardio_sessions

routine_templates
routine_exercises
exercise_registry
reference_data

outbox
action_receipts
sync_metadata
internal_metadata
active_markers
```

`action_receipts` retains committed action IDs after pending outbox entries are
acknowledged. `internal_metadata` owns the local sequence and client identity;
caller synchronization metadata cannot overwrite those values. `active_markers`
is described below. These three stores are repository internals rather than
domain data exposed to the UI.

### Indexes

`outbox` has a unique `by_sequence` index for ordered replay. Since v3, these
parent-id indexes support bounded reads of an active session's live descendants
without scanning a whole store:

```text
walking_bouts.by_walking_session_id      (walking_session_id)
walking_pauses.by_walking_bout_id        (walking_bout_id)
walking_rests.by_walking_bout_id         (walking_bout_id)
resistance_rows.by_resistance_session_id (resistance_session_id)
```

### `active_markers` (schema v3)

A commit's cardinality checks (at most one ACTIVE session per type; at most one
open bout per session; at most one open pause and one open rest per bout) used to
require reading every record in the affected stores, so their cost grew with all
of a device's history rather than its live state. `active_markers` replaces that
with one record per currently-active scope, keyed by `store` plus a `scopeKey`
(the store name for a session type, or the parent id for a bout/pause/rest):

```text
{ id: "<store>\u0000<scopeKey>", store, scopeKey, recordId }
```

`commitAction` maintains it inside the same transaction as the domain writes: it
looks up and updates only the marker(s) for the scopes an action actually
touches, instead of scanning whole stores, so commit cost no longer scales with
closed history. The marker fields never appear on records returned to callers or
in outbox `record` payloads — they live only in this internal store. The v2→v3
upgrade backfills `active_markers` from existing data inside the same
non-destructive upgrade transaction that adds the store and indexes above.

### Recovery snapshot scope

`readSnapshot()` (used for startup/focus recovery) is bounded to live state, not
full history: at most one live ACTIVE session per type plus its live descendants
(a walking session's bouts and their pauses/rests; a resistance session's rows),
found through `active_markers` and the parent-id indexes above. Reference/config
stores (`routine_templates`, `routine_exercises`, `exercise_registry`) are still
returned in full, since they are small. `pendingOutbox` is unchanged. Full
history remains available through `listRecords`/`getRecord` for screens such as
History.

Reference data includes what the HUD needs offline, such as:

- routine definitions;
- exercise names;
- working weights;
- muscle-group progression configuration required for suggestions;
- cardio-machine names;
- PAD defaults.

## Mutation outbox

Every locally persisted server-side action creates one outbox mutation in the same
transaction as its domain changes. The versioned envelope shape is shown in the
local action contract above.

Possible mutable domain stores include:

```text
walking_sessions
walking_bouts
walking_pauses
walking_rests
resistance_sessions
resistance_rows
cardio_sessions
routine_templates
routine_exercises
exercise_registry
```

The server records processed mutation IDs. Replaying the same mutation must not duplicate logical events.

Synchronization is therefore **idempotent**.

## Synchronization triggers

Attempt synchronization:

1. immediately after a local mutation when online;
2. when the application opens;
3. when the PWA returns to the foreground;
4. when connectivity returns;
5. optionally through service-worker background synchronization.

The application must never depend on step 5.

A successfully acknowledged mutation is removed from the pending local outbox.
Its action receipt remains durable for retry deduplication. Failed mutations remain
queued. The server acknowledgement exchange itself remains part of issue #13.

## Authentication and offline continuation

The frontend uses Django session authentication (see [Architecture](architecture.md)).
Credentials, session ids, and tokens are never stored client-side; the session
cookie is `HttpOnly` and managed entirely by the browser. A second cookie,
`csrftoken`, is deliberately *not* `HttpOnly` -- Django's CSRF protection
requires JavaScript to read it and echo it back in an `X-CSRFToken` header, so
this cookie being script-readable is by design. It is a CSRF token, not an
auth credential: it proves the request came from this site's own page, not
that the caller is signed in, and holding it grants no access on its own.
Reading it (and the unsafe-request retry after a rotated token) requires the
frontend and API to be same-origin -- the dev Vite proxy, or a same-origin
production deployment; a cross-origin `VITE_API_BASE_URL` would leave the
browser unable to read the API's own `csrftoken` cookie at all.

The only things this app persists locally about authentication are two
non-secret records in the `internal_metadata` store, through the local
repository's API:

- The **auth marker**, `{ username, lastVerifiedAt }`
  (`getAuthMarker`/`setAuthMarker`/`clearAuthMarker`). Records "this device
  has signed in before, as whom, and when that was last confirmed with the
  server." Cleared on logout. `lastVerifiedAt` is shown to the user directly:
  the account row names when the session was last confirmed while
  `authStatus` is `unverified`.
- The **outbox owner**, `{ username }` (`getOutboxOwner`/`setOutboxOwner`).
  Records which locally-authenticated user's pending outbox entries are on
  this device. Set whenever authentication succeeds (login or a background
  verify) and either it was absent yet or nothing was pending at that moment.
  Logout deliberately does **not** clear it -- see "Different-user
  protection" below.

Both share `internal_metadata`'s existing atomic single-key writes without
affecting the repository's own sequence/client-id bookkeeping there or the
outbox/domain commit transaction.

### Auth status state machine

The frontend tracks one `authStatus`:

```text
checking            -- startup only: the marker read is resolving, or (only
                        when no marker exists yet) the initial session check
                        is still running
login-required      -- no marker on this device, or the user just signed out;
                        app routes are not rendered. While offline this reads
                        as "Network required" and shows no form -- a first
                        sign-in needs a connection. While online the sign-in
                        form is always reachable
server-unreachable  -- no marker, online, but the session check could not get
                        a decisive answer; app routes are not rendered, but
                        the sign-in form stays reachable next to a Retry
                        action
unverified          -- a marker exists (or could not be ruled out) but this
                        reopening could not decisively reach the server, or
                        the marker itself could not be read: "offline
                        continuation" -- the app opens normally from local
                        data and sync stays paused
authenticated       -- the server confirmed the session is valid for this
                        device's outbox owner
expired             -- a marker exists but the server reported no session (or
                        any request got a 401); local data and the outbox are
                        preserved and the app stays usable
account-mismatch    -- the server-authenticated user does not match this
                        device's outbox owner while pending outbox entries
                        exist (or ownership could not be confirmed at all);
                        the app never adopts that session
```

Behavior by scenario:

- **First login.** No marker: show the sign-in screen; app routes do not
  render. Offline: "Network required," no form -- reconnecting re-checks
  automatically and clears it on its own, with no manual retry needed since
  there is nothing to retry yet. Online but the check itself is inconclusive
  (network failure, timeout, a 5xx, a non-JSON body from a proxy):
  `server-unreachable` -- the form stays reachable next to a Retry action, so
  an online user is never told to "connect to the internet" when the real
  problem is the server.
- **Reopen with a marker.** The app renders immediately as `unverified` from
  local data without waiting on the network -- a hung captive-portal Wi-Fi
  must never block resuming an active workout -- while a bounded (~5s
  timeout) session check runs in the background. Offline, or the check comes
  back inconclusive, it stays `unverified`; a decisive `authenticated` or
  anonymous answer moves it to `authenticated` (after the ownership check
  below) or `expired`. If the marker itself cannot be read, it is retried
  once; if it still fails, the device opens `unverified` with an unknown
  username rather than locking the user out of their own local data --
  `canSync` stays false until a successful verify or login.
- **Re-checking while not yet confirmed.** `checking`, `login-required`,
  `server-unreachable`, `unverified`, and `account-mismatch` all re-check
  automatically: when the `online` event fires, when the page becomes visible
  again, and on window focus -- unless a sign-in is currently submitting, in
  which case these all stand down rather than race it (a submitted sign-in
  always resolves to its own outcome regardless of what a background check
  finds meanwhile). Triggered this way, a check already in flight queues one
  follow-up instead of starting a second, overlapping one; the background
  backoff retry below and the manual Retry action instead call the check
  directly and can still overlap an existing one, but only the most recently
  started check may report "no longer checking" or launch a queued follow-up
  once it finishes, so a superseded check finishing first can never be
  mistaken for "nothing in flight" or launch a redundant follow-up on a newer
  check's behalf. While online and getting inconclusive answers, a background
  retry also runs on its own with exponential backoff (~5s, 10s, ... capped at
  5 minutes, likewise skipped while a sign-in is submitting), reset by any
  decisive answer or explicit re-check trigger.
- **Different-user protection.** A device's outbox owner is compared against
  the *server-confirmed* username (not merely the typed one) both before
  attempting sign-in (a cheap pre-check against the typed username) and after
  the server responds (the authoritative check). If they differ while pending
  outbox entries exist, sign-in is blocked with an explanation naming the
  device's owner (single-user app; local data is never silently mixed between
  accounts). This also covers a background verify: it never silently re-owns
  a device with pending entries to whoever the server now says is signed in
  -- it moves to `account-mismatch` instead, with a persistent banner naming
  the owner and offering sign-out, until the rightful owner signs the
  mismatched session out and back in. A failure reading the owner/outbox
  record fails *closed* (blocks the change) rather than open, both for
  sign-in and for sign-out.
- **Logout.** Requires network and always asks for confirmation first, even
  with nothing pending -- the control is intentionally small and secondary
  rather than a full-width, top-of-screen button, but confirmation is a
  second line of defense against an accidental tap. If pending outbox entries
  exist, the confirmation states they stay on this device and sync after the
  next sign-in. The server session is treated as gone -- and the login screen
  shown -- as soon as the server confirms sign-out, even if clearing the
  local marker then fails; that failure surfaces as a separate, non-blocking
  storage warning rather than "sign-out failed." The outbox owner is
  deliberately left untouched by logout, which is what makes the
  different-user protection above survive a sign-out with pending entries.
- **Error classification.** A session check's outcome is either decisive or
  ambiguous, never guessed: a `401` or an explicit `{authenticated: false}`
  from the server is decisive -- anonymous -- and (with a marker on this
  device) moves the status to `expired`. A network failure, an aborted/timed
  out request, a 5xx, or a non-JSON response body proves nothing either way
  and is treated as connectivity-class ambiguity -- `unverified` when a
  marker exists, `server-unreachable`/`login-required` when none does --
  never as a decisive sign-out. Any `401` from *any* API call, not just the
  session check, expires the session from `authenticated` or `unverified` the
  same way, through the frontend's central fetch wrapper. A stale response
  cannot resurrect or expire a session it no longer applies to: a session
  generation counter, bumped on every login/logout/background verify, is
  captured by each request when it is sent, so a slow request's late `401`
  is ignored once a newer sign-in has superseded it.
- **Storage failures are distinct from network/server failures.** A marker
  that cannot be written after a successful server login or verify, or
  cannot be cleared after a successful logout, is never reported as a
  network problem or a failed sign-in/sign-out -- the server-confirmed
  outcome always wins, surfaced separately through a dismissable storage
  warning banner.

### Sync gate

There is no sync engine yet (issue #13). The frontend exposes one gate a future
sync engine must consult before attempting network synchronization:

```text
canSync(authStatus, online) := authStatus == "authenticated" AND online
```

Every other status -- including `unverified`, `expired`, and
`account-mismatch` -- pauses synchronization while leaving pending outbox
entries queued, consistent with the local-first rule above: nothing is
discarded, sync simply waits for a confirmed, reachable session owned by
this device.

## Conflict strategy

The Android phone is the primary workout-entry device, so complex multi-device merging is outside v1 scope.

For editable session data:

```text
latest explicit edit wins
```

For configuration edited through Django Admin:

```text
server configuration wins
```

Pending local workout mutations must remain safely represented in the outbox before cached server reference data is replaced.

## Offline requirements

### PAD

The following must work offline:

- start or resume a walking session;
- start a bout;
- pause/resume;
- select pain;
- finish a bout;
- begin rest;
- start the next bout;
- add a bout;
- edit timestamps;
- edit stop reason;
- finish the walking session.

### Resistance

The following must work offline:

- open a cached routine;
- start a resistance session;
- edit weight;
- edit target sets/repetitions;
- mark exercises complete;
- finish a resistance session.

### Cardio

The following must work offline:

- start a cached cardio-machine session;
- record/edit duration;
- record/edit resistance level;
- finish the session.

All mutations synchronize later.

## Notes

Notes exist at two practical levels.

### Session notes

Optional notes attached to PAD, resistance, or cardio sessions.

### Item notes

Optional notes attached to an individual PAD bout or resistance-session exercise.

Notes remain collapsed by default to keep the active HUD uncluttered.

## History

V1 history is a simple reverse-chronological list.

Example:

```text
22 Aug

PAD
5 bouts · 34:22 walking

Day 3
6 / 7 exercises

Arm Crank
10 min · Level 4
```

Selecting an item opens its recorded detail.

History supports PAD sessions, resistance sessions, and cardio-machine sessions. No charts are required in v1.

## Backups and export

PostgreSQL is the authoritative synchronized database.

Provide:

```text
Export all data → JSON
Export session history → CSV
```

The JSON export should contain enough information to reconstruct all user-owned application data.

Maintain a scheduled logical PostgreSQL backup independently of the live Neon database so one provider does not hold the only long-term copy.

## Deferred configuration

The following do not block core development:

- exact Day 1–5 resistance routines;
- exact muscle-group progression percentages;
- complete Technogym exercise registry;
- additional cardio-machine types.

These can be populated progressively through Django Admin or a later frontend management screen.
