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

This is a versioned **local contract**. Its v1 outbox envelope is, unchanged, the
payload of the server protocol: see [Server synchronization
protocol](#server-synchronization-protocol) for the acknowledgement, idempotency,
validation and conflict rules the server applies to it.

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
strings for elapsed-time reconstruction and display. PAD actions never stamp a
domain time (`started_at`, `ended_at`, `completed_at`) earlier than the latest one
already recorded in that session (`monotonicNow` in `frontend/src/pad/actions.ts`):
after a clock step back they reuse that latest moment, so a device never records an
end before its start or a child outside its parent. An `action UUID` is stable
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

**Settled 2026-09-19.** At most one `ACTIVE` session per type; see [Product
overview: Active-session cardinality and Home Resume
cards](product-overview.md#active-session-cardinality-and-home-resume-cards)
for the full combination table and canonical wording. The server enforces the
same rule for PAD today (at most one live `ACTIVE` walking session per
account, as a database constraint), resolving a stuck one by superseding it
(see [Stuck ACTIVE sessions](#stuck-active-sessions)); resistance and cardio
don't sync yet (see [Unsupported stores and
versions](#unsupported-stores-and-versions)).

The rule is enforced per device: an offline cross-device start can briefly
leave two same-type `ACTIVE` sessions until synchronization reaches the
server and supersedes one (PAD today) -- draining the outbox is issue #20.

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

**Since issue #20**, `outbox` rows may also carry a `rejection` field
(`{code, detail, rejectedAt}`), written by `markOutboxRejected` when the
server permanently refuses a mutation (see [Client
obligations](#client-obligations)). The row and its domain data are never
deleted -- only `acknowledgeOutbox` removes an outbox row, for a confirmed
`applied`/`duplicate`. `listPendingOutbox()` and `readSnapshot()`'s
`pendingOutbox` field both **exclude** rejected rows: they are never retried,
so leaving them in the drain queue would block every entry behind them
forever, and -- because `hasLiveWork` in `pwa/updateSafety.ts` treats a
non-empty pending outbox as live work -- would also wedge service-worker
updates permanently. `listRejectedOutbox()` is the needs-attention view the
sync engine's UI reads instead. `sync_metadata` additionally holds the changes-
feed cursor under `SYNC_CURSOR_KEY`, written atomically with each page's
records by `applyServerRecords`.

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

Synchronization is therefore **idempotent** (see [Idempotency and the
processed-mutation ledger](#idempotency-and-the-processed-mutation-ledger)).

## Synchronization triggers

Attempt synchronization:

1. immediately after a local mutation when online;
2. when the application opens;
3. when the PWA returns to the foreground;
4. when connectivity returns;
5. optionally through service-worker background synchronization.

The application must never depend on step 5, and does not implement it:
`frontend/src/sync/SyncProvider.tsx` drives triggers 1-4 only (owner decision,
issue #20). Trigger 1 is a `useEffect` on `LocalDataProvider`'s own
post-commit snapshot: it compares the pending outbox's mutation ids against
the set this provider already accounted for on its previous read, and fires
whenever the current set holds one it has not seen pending before -- not a
hook into `commitAction` itself, since a commit must never await the
network. This is deliberately not "the pending count grew since last time":
the sync engine acknowledges mutations on its own, usually separate,
repository connection (see [Active-session
recovery](#active-session-recovery) and `App.tsx`), which never refreshes
this provider's own snapshot, so a length comparison alone can land on the
same count across two genuinely different commits and miss the second one
(reproduced and fixed by issue #20's review, finding M1). Trigger 3 is
`visibilitychange` (to `visible`) plus window `focus`. Trigger 4 is the
`online` event and the sync gate (below) transitioning to true (in particular,
authentication succeeding). Overlapping triggers coalesce into at most one
queued follow-up drain, never a second concurrent one (see [Client
obligations](#client-obligations)).

A successfully acknowledged mutation is removed from the pending local outbox.
Its action receipt remains durable for retry deduplication. Failed mutations remain
queued, and permanently rejected ones are kept for attention rather than discarded
(see [Client obligations](#client-obligations)). The acknowledgement exchange is
defined under [Server synchronization protocol](#server-synchronization-protocol);
the client engine that performs it is `frontend/src/sync/engine.ts` (issue #20).

## Server synchronization protocol

**Status: agreed v1 server contract** (issue #19), as revised by the owner after
code review: clock-step timing inversions are clamped rather than rejected, a stuck
`ACTIVE` session is superseded (or discarded by an administrator), a delete cascades
to live children, a tombstone wins over other devices' puts, and same-device
ordering is the client's obligation. It settles the acknowledgement, idempotency,
conflict and validation parts of issue #13 for PAD. The server side is
implemented in `backend/apps/sync` (ledger, envelope parsing, engine, endpoints) and
`backend/apps/pad` (PAD models and rules); the client engine that drains the outbox
through it is issue #20. Resistance, cardio and routine stores are not synchronized
yet (see [Unsupported stores and versions](#unsupported-stores-and-versions)).

### Endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/v1/sync/mutations/` | POST | Push pending outbox entries; one acknowledgement per processed mutation. |
| `/api/v1/sync/bootstrap/` | GET | PAD defaults, the settings a new session inherits, the change cursor, request limits. |
| `/api/v1/sync/changes/` | GET | The account's records changed after a cursor, tombstones included, paged. |

All three require the Django session (anonymous: `401 not_authenticated`), are
never cached (`Cache-Control: no-store`), and share one per-user rate limit (the
`sync` throttle scope, `DJANGO_SYNC_THROTTLE_RATE`, default `120/min`). The POST is
CSRF-protected like every unsafe API request (`X-CSRFToken`; failure is
`403 csrf_failed`).

### Push request

```json
{
  "client_id": "b0c9e5a4-3f2d-4e1c-9a8b-7c6d5e4f3a21",
  "mutations": [
    {
      "version": 1,
      "mutation_id": "0d8e5c4a-6b1f-4f7e-9a2d-3c4b5a697881",
      "sequence": 41,
      "created_at": "2026-09-14T10:10:30.000Z",
      "changes": [
        {
          "store": "walking_bouts",
          "entity_type": "walking_bout",
          "entity_id": "5e1d2c3b-4a59-4687-b7c6-d5e4f3a2b1c0",
          "operation": "put",
          "record": {
            "id": "5e1d2c3b-4a59-4687-b7c6-d5e4f3a2b1c0",
            "walking_session_id": "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
            "bout_number": 1,
            "started_at": "2026-09-14T10:02:00.000Z",
            "ended_at": "2026-09-14T10:10:30.000Z",
            "pain_min": 2,
            "pain_max": 3,
            "stop_reason": "MAX_DURATION",
            "notes": null,
            "created_at": "2026-09-14T10:02:00.000Z",
            "updated_at": "2026-09-14T10:10:30.000Z",
            "deleted_at": null
          }
        },
        {
          "store": "walking_rests",
          "entity_type": "walking_rest",
          "entity_id": "7a6b5c4d-3e2f-4012-9345-6789abcdef01",
          "operation": "put",
          "record": {
            "id": "7a6b5c4d-3e2f-4012-9345-6789abcdef01",
            "walking_bout_id": "5e1d2c3b-4a59-4687-b7c6-d5e4f3a2b1c0",
            "started_at": "2026-09-14T10:10:30.000Z",
            "ended_at": null,
            "created_at": "2026-09-14T10:10:30.000Z",
            "updated_at": "2026-09-14T10:10:30.000Z",
            "deleted_at": null
          }
        }
      ]
    }
  ]
}
```

- `client_id` is the device's repository client id (`internal_metadata`); the
  envelope itself carries none.
- `mutations` are pending outbox entries **verbatim**, in ascending `sequence`
  order, 1 to 50 per request. The request body may be at most Django's
  `DATA_UPLOAD_MAX_MEMORY_SIZE` (2.5 MiB by default); one mutation may hold at most
  500 changes. Both limits are also reported by the bootstrap read.

### Push response

`200` with one entry per **processed** mutation, in request order:

```json
{
  "results": [
    { "mutation_id": "0d8e5c4a-…", "status": "applied" },
    { "mutation_id": "1f2e3d4c-…", "status": "duplicate" },
    {
      "mutation_id": "2a3b4c5d-…",
      "status": "rejected",
      "code": "invalid_transition",
      "retryable": false,
      "detail": "walking_bouts/5e1d… cannot be walking while walking_rests/7a6b… is still open (PAD-06); …"
    },
    {
      "mutation_id": "3b4c5d6e-…",
      "status": "retry",
      "code": "unsupported_store",
      "retryable": true,
      "detail": "This server does not synchronize resistance_sessions yet; keep the mutation queued."
    }
  ]
}
```

| `status` | Meaning | Client action (issue #20) |
| --- | --- | --- |
| `applied` | Applied now, in one transaction with its ledger row -- possibly with stale changes skipped or timestamps clamped (the ledger's `detail` says which). | Remove from the outbox (the receipt stays). |
| `duplicate` | Already applied earlier with an identical payload; nothing was applied again. | Same as `applied`. |
| `rejected` | Permanent; nothing of the mutation was applied. Recorded, so every retry of the same mutation gets this identical entry. | See [Client obligations](#client-obligations). |
| `retry` | Retryable; nothing of it was applied or recorded. | Keep it queued and resend it, and everything after it, later. |

**Batch rule.** Mutations are processed in order, each in its own transaction.
Processing **stops at the first `retry`**: the mutations after it are neither
processed nor listed, so nothing is applied ahead of a mutation that will be sent
again. A `rejected` mutation does **not** stop the batch. A later mutation that
depended on it -- one that references a record the rejected mutation would have
created, say -- fails its own validation (`parent_not_found`, `active_conflict`,
`invalid_transition`, ...) and is rejected in turn. A later put that carries the
full record itself does not depend on the rejected mutation and can still apply.

### Request-level errors

These use the uniform `{"code", "detail"}` error shape and process nothing:

| Situation | Status | `code` |
| --- | --- | --- |
| Body not an object; `client_id` not a lowercase UUID; `mutations` empty, not a list, over 50, or not in strictly ascending `sequence` order | 400 | `invalid_request` |
| Body is not valid JSON | 400 | `parse_error` |
| Body is not `application/json` | 415 | `unsupported_media_type` |
| Body larger than `DATA_UPLOAD_MAX_MEMORY_SIZE` | 413 | `request_too_large` |
| No session / CSRF failure | 401 / 403 | `not_authenticated` / `csrf_failed` |
| Rate limit | 429 | `throttled` |

A lost response (or a `5xx` from outside the engine, such as a proxy) may leave
earlier mutations of the request committed. Resending the whole request is always
safe: they come back as `duplicate`. An unexpected failure while processing one
mutation is not a `5xx`: it is that mutation's `retry` / `server_error`, and the
results before it are returned as usual.

A single mutation that is unusable as a unit -- its entry is not an object, or its
`sequence` is not a positive integer -- is that mutation's own `rejected` entry
rather than a `400`, so one corrupt outbox entry cannot block the queue behind it.

### Codes

| `code` | `retryable` | Recorded | Meaning |
| --- | --- | --- | --- |
| `invalid_envelope` | no | yes (no, if `mutation_id` itself is not a UUID) | The envelope's own shape: `version`, `sequence`, `created_at`, `changes` (1–500), a change's `store`/`entity_type`/`entity_id`/`operation`, `record.id` (and a delete's `id`) equal to `entity_id`, one change per record. |
| `invalid_record` | no | yes | A field of one record: types, lowercase UUIDs, timestamps with a time zone that are representable in UTC (years 1–9999), `status`, `pain_min`/`pain_max`, `stop_reason`, the treadmill settings (finite numbers), `completed_at` versus `status`, `deleted_at` null on a put, a tombstone `deleted_at` on a delete, text fields that are strings. |
| `invalid_transition` | no | yes | A state rule: a `COMPLETED` session turned `DISCARDED` or back (unless the server wrote the closure), a parent reference changed, a rest under a bout that has not ended, or a bout open while a rest is open (PAD-06). |
| `active_conflict` | no | yes | A "one at a time" rule broken within one mutation: two `ACTIVE` sessions, a second open bout per session, open pause per bout, or rest per bout. (A second `ACTIVE` session in a *later* mutation supersedes the first instead; see [Stuck ACTIVE sessions](#stuck-active-sessions).) |
| `parent_not_found` | no | yes | The parent a record references is missing, deleted, or not this account's. |
| `not_found` | no | yes | A put names a record id that is not available to this account. |
| `mutation_id_conflict` | no | no | This `mutation_id` was already used with a different payload (or by another account). The ledger keeps the original. |
| `unsupported_store` | yes | no | A change targets a store this server does not synchronize yet. |
| `unsupported_version` | yes | no | An envelope `version` newer than this server applies (1). |
| `temporarily_unavailable` | yes | no | A database error (lost connection, deadlock, serialization failure, a lock not granted within 5 s); retry later. |
| `server_error` | yes | no | An unexpected server failure on this mutation (logged with its stack trace); retry later. Never recorded: it may be a server bug on valid data, so it must not become a permanent rejection. |

### Idempotency and the processed-mutation ledger

Every final outcome is written to the ledger (`ProcessedMutation`) in the same
transaction as the mutation: `mutation_id` (unique in the database), the owning
account, `client_id`, `sequence`, the outcome (`applied` or `rejected`, with `code`
and `detail`), and the envelope's canonical JSON text with its SHA-256
**fingerprint** (sorted keys, no whitespace; `client_id` is not part of it). The
fingerprint always covers the whole envelope; the ledger keeps only the first
64 KiB of its text (`envelope_truncated` says when it was cut), so a record stuffed
with unknown fields cannot make the ledger grow without bound. A real PAD mutation
is a few kilobytes.

- Same `mutation_id`, same payload → `duplicate` if it was applied, or the recorded
  rejection repeated verbatim. Nothing is applied twice.
- Same `mutation_id`, different payload, or another account's `mutation_id` →
  `rejected` / `mutation_id_conflict`. The first account's outcome is never revealed.
- `retry` outcomes are never recorded: retrying them is the point.
- An applied mutation's `detail` lists everything the server did beyond applying it
  as sent: stale-skipped changes, clamped timestamps, a superseded session, records
  deleted by cascade (see below).

Each mutation first locks the account's `SyncState` row (`SELECT … FOR UPDATE`), so
one account's mutations commit strictly one after another: a second, concurrent
delivery of the same mutation waits, then finds the ledger row and is answered
`duplicate`. The unique index on `mutation_id` is the last line of defense between
accounts. On PostgreSQL the transaction waits at most 5 seconds for a lock
(`SET LOCAL lock_timeout`); a mutation that times out is `retry` /
`temporarily_unavailable`, never a `500`. PostgreSQL tests in
`apps/sync/tests/test_concurrency_pg.py` prove all three with real concurrent
connections; in CI (`CI` set) that module fails instead of skipping when the test
database is not PostgreSQL.

The server does **not** enforce that a device's sequences arrive contiguous or
ascending across requests (within one request they must ascend, or the request is
a `400`). That is a client obligation (see [Client obligations](#client-obligations));
the server logs a warning when a new mutation arrives with a sequence below the
highest one already processed for that account and `client_id`.

### Transactions and validation

For each mutation, inside one database transaction:

1. **Parse everything first.** The envelope and every record are validated before
   anything is written; any failure rejects the mutation untouched. A record whose
   end precedes its own start is not a failure: the end is clamped up to the start
   (see [Clock steps are clamped](#clock-steps-are-clamped)).
2. **Write in dependency order.** The server does not rely on the envelope's change
   order. It writes deletes deepest-first, then puts parent-first, and within one
   depth puts that close a record before puts that open one. Every change targets a
   different record, so the order cannot change the result; it only keeps each
   intermediate state inside the database's one-open-record indexes. Stale puts are
   skipped here ([Conflict rule](#conflict-rule-latest-explicit-edit-wins)); a delete
   also tombstones the live children it did not list; a put that makes a session
   `ACTIVE` first closes any other, stuck, `ACTIVE` session of the account.
3. **Settle the finished state** of everything the mutation touched: parents live
   and owned, and for PAD the whole tree of every walking session touched -- clamping
   timestamps into their parents, then checking the rules clamping cannot fix (see
   [PAD validation](#pad-validation)). A multi-record operation -- finish bout +
   start rest, close rest + start next bout, a time correction moving several
   timestamps -- is judged only as a whole.
4. **Record** the outcome in the ledger and advance the account's change counter.
   Every row the mutation wrote *or the server changed on its behalf* (a clamp, a
   supersede, a cascade) carries the new counter value, so the changes feed carries
   all of it to every device.

A failure in steps 2–3 rolls back every write of the mutation: a rejected or retried
mutation leaves nothing behind. An applied mutation is applied as one unit, but not
necessarily *verbatim*: individual changes may be skipped as stale (their records
already hold something newer), and timestamps may be clamped -- each such deviation
is named in the ledger's `detail`. The finish-bout/start-rest and close-rest/start-next
operations are therefore all-or-nothing on the server exactly as they are locally.

An unexpected, non-database exception while one mutation is processed rolls that
mutation back, is logged with its stack trace, and answers it `retry` /
`server_error`; the batch ends there, and the results of the mutations before it are
returned in a normal `200`. It is never recorded as a rejection, because it may be a
server bug on valid workout data. Database errors keep their own classification
(`temporarily_unavailable`, or a constraint named as a rejection).

Records may carry fields the server does not model (the repository carries unknown
fields forward on every put); they are ignored, not rejected. Every field the
current frontend writes is accepted with its exact value -- speed and incline are
stored as double precision, so an inherited `5.65` km/h is neither rounded nor
refused.

### Conflict rule (latest explicit edit wins)

- **Within one device** (`client_id`), the outbox `sequence` decides. Every server
  row remembers the device and sequence that last wrote it. A change from the same
  device with a *lower* sequence than that is **stale** and is skipped, even if the
  device clock said it was later. A stale-skipped change is **not** a rejection:
  its mutation is acknowledged `applied` (the ledger's `detail` names the skipped
  records), because the record already holds that device's newer edit.
- **Across devices**, the mutation the server commits last wins, record by record --
  except over a tombstone.
- **Deletes** are tombstones (`deleted_at`), never removed. Deleting a record that
  is already deleted, never reached the server, or belongs to another account
  changes nothing and is acknowledged `applied`. Tombstones count toward none of the
  "one at a time" rules.
- **A delete cascades.** Deleting a session or bout also tombstones every live
  descendant the mutation did not list -- a bout and pause another device added
  meanwhile, say -- with the same `deleted_at`, the deleting device as writer, and
  the mutation's counter value.
- **A tombstone wins.** Only the device that deleted a record can bring it back, with
  a later mutation that puts it again (an explicit undo). A put from any other device
  onto a tombstone -- or of a new record under a tombstoned parent -- is skipped like
  a stale change (`applied`, noted in the ledger); a stale replay from the deleting
  device itself is skipped by the sequence rule.
- A record's parent reference (`walking_session_id`, `walking_bout_id`) is fixed
  once the record exists; ids are never reused for another record.
- **Rows the server changed on its own** -- a supersede, an administrator's discard --
  record the server (the nil UUID, never a device id) as their last writer, so a
  device's next put to them is never judged stale: the device's own account replaces
  the server's stand-in.

### PAD validation

Per record (`invalid_record`):

- ids and parent ids are lowercase UUIDs; timestamps are ISO 8601 with a time zone
  and representable in UTC (so not `0001-01-01T00:00:00+01:00`);
- a session's `status` is `ACTIVE`, `COMPLETED` or `DISCARDED`; `completed_at` is
  null exactly while `ACTIVE`;
- `speed_kmh > 0`, `incline_pct >= 0` (finite numbers), `max_bout_seconds` a
  positive integer;
- `bout_number` a positive integer; `stop_reason` null or one of the five reasons;
- pain is null/null, or one value or two adjacent values from 1 to 5
  (`pain_min <= pain_max <= pain_min + 1`);
- free text (`session_notes`, `notes`) is a string or null. It is made storable
  rather than refused: NUL characters are removed (PostgreSQL text cannot hold them)
  and a lone UTF-16 surrogate becomes U+FFFD. Identity fields stay strict.

#### Clock steps are clamped

A timestamp inversion only ever comes from a device clock stepping back between two
stamps, and refusing it would strand real workout data on the device (and block
nothing but the user). So the server moves the offending timestamp to the nearest
boundary instead, deterministically, and notes each move in the ledger (`applied`):

- an end before its own start (`ended_at < started_at`, `completed_at < started_at`)
  moves up to the start;
- on the finished state of each touched session, parents first: a bout lies within
  its session (it starts at or after the session started; once the session is
  `COMPLETED`/`DISCARDED` it has ended, at or before `completed_at`); a pause lies
  within its bout (and has ended once the bout has); a rest starts at or after its
  bout ended and, once the session is closed, has ended by `completed_at`. A start
  outside the range moves to the nearer bound, an end past it moves back to it, an
  open child of a closed parent is closed at the parent's end, and an end left
  before a raised start moves up to it.

Every clamp lands inside the database's constraints, and the same input always
gives the same stored result. Rows the mutation did not itself write can move too (a
correction that moves a session's start past an existing bout's start, say); they
get the mutation's counter value like everything else it changed. There is no
magnitude limit: any limit would turn a large clock error back into a permanent
rejection of real workout data, and a clamp never moves a time outside the
boundaries the session itself recorded, so it cannot invent time.

#### What is still refused

On the finished state of each touched session:

- a rest belongs to a bout that has not ended (`invalid_transition`);
- **PAD-06**: a session never has an open bout while one of its rests is open
  (`invalid_transition`). `START NEXT BOUT` closes the rest in the same mutation;
- at most one `ACTIVE` session per account, one open bout per session, one open
  pause per bout, and one live rest per bout (`active_conflict`, database
  constraints), within one mutation;
- `ACTIVE` may become `COMPLETED` or `DISCARDED`; those do not turn into each other
  (`invalid_transition`), unless the server wrote the closure (a supersede or an
  administrator's discard), in which case the device's own final status wins. A put
  that still says `ACTIVE` for a finished session -- another device, or the server,
  closed it meanwhile -- keeps the closure (`status`, `completed_at`) and applies
  the rest of the record, noted in the ledger: a finished session is never reopened,
  and the edit is not lost.

#### Stuck ACTIVE sessions

A session stays `ACTIVE` on the server until its device syncs the finish. When that
device is offline, lost or reset, the account would otherwise be unable to start
another session anywhere. Two mechanisms resolve it:

- **Supersede.** When a mutation would create or activate a walking session while
  the account already has a *different* live `ACTIVE` one that the mutation does not
  itself name, the server first closes the older one: `COMPLETED`, `completed_at` =
  the latest timestamp the session records (its own `started_at` if nothing later),
  and every open bout, pause and rest closed at that same moment. Then it applies the
  new mutation, all in one transaction and one counter value, with the supersede
  noted in the ledger. If the older session's device syncs its real finish later,
  that replaces the server's closure. Two `ACTIVE` sessions within one mutation are
  that mutation's own contradiction and remain `active_conflict`, as does any other
  "one at a time" violation within one mutation.
- **"Discard stuck session"** in Django Admin (the walking-session list, for users
  with the `change` permission on walking sessions). It is offered for any selection
  but acts only on live `ACTIVE` sessions (others are reported and left alone). It
  runs through the same engine path as a mutation -- the account lock, one
  transaction, a counter bump the changes feed carries to every device, and a ledger
  row (`code` `admin_discard`, `client_id` the nil UUID, the acting administrator in
  its `detail` and envelope) plus Django's own admin log entry -- and marks the
  session `DISCARDED` with its open children closed, at its latest recorded moment.

**Known v1 limitation, not a defect (issue #20's review, finding M3):** a
device whose feed carries another device's live `ACTIVE` session installs
that session's local active marker exactly as a locally-committed one would
(so it shows as a Resume card from `readSnapshot()`, the same escape as any
other active session -- see [Active-session
recovery](#active-session-recovery)) and cannot start its own session of
that type until the feed's session is resumed, finished, or discarded by an
administrator; a local supersede is deliberately not implemented (owner
decision, issue #13: at most one `ACTIVE` session per type locally), and the
multi-device case is explicitly out of v1 scope (see [Conflict
strategy](#conflict-strategy)).

**The frontend mirrors these rules** in its write transaction, so that it never
queues a mutation the server has to repair or refuse: close every open pause when a
bout ends and every open bout, pause and rest when the session ends; stamp times
monotonically within a session (done: `monotonicNow`); refuse a new bout while a
rest is open; tombstone a rest when undoing the bout finish that created it; delete
children with their parent; never reopen a finished session; keep pain, stop reason
and text within the rules above. Today's local repository enforces the one-at-a-time
rules and the monotonic clock, but not containment or PAD-06; the PAD controls
(#21, #22) and the sync engine (#20) must add them.

### Unsupported stores and versions

A mutation with any change to a store the server does not synchronize yet
(`resistance_sessions`, `resistance_rows`, `cardio_sessions`, `routine_templates`,
`routine_exercises`, `exercise_registry`, or any unknown name) is answered `retry` /
`unsupported_store` before its records are judged, and is not recorded. Like every
`retry`, it ends the batch. The client keeps it -- and everything queued after it --
until the server supports the store, so nothing is lost and nothing is applied out
of order. The consequence is head-of-line blocking: such a mutation holds back later
PAD mutations too, so a store's server support must ship before the frontend
produces mutations for it (it produces none today). The server logs a warning for
every such deferral, so a queue stuck behind one is visible in the server logs. An
envelope `version` newer than 1 is handled the same way (`unsupported_version`).

### Client obligations

Implemented by the sync engine, `frontend/src/sync/engine.ts` (issue #20):

- **One drainer per device, in ascending sequence.** Only one tab or worker at a time
  may send a device's outbox (for example under a Web Locks API lock), and it sends
  pending entries in ascending `sequence`, never skipping ahead of one still queued.
  The server relies on this for the same-device staleness rule and does not enforce
  it; it only logs a lapse. Implemented with `navigator.locks.request("gym-hud-sync",
  ...)` when available, an in-process promise chain otherwise (jsdom, older
  browsers); overlapping triggers coalesce into at most one queued follow-up
  drain rather than a second concurrent one.
- On `applied` or `duplicate`, acknowledge the outbox entry (the action receipt
  stays).
- On `retry` (including `server_error`), keep the mutation and every later one
  queued, and resend them later starting from that mutation. Mutations not listed in
  the response were not processed.
- On `rejected`, **keep the mutation and its local data**, mark it as needing
  attention, and stop retrying it. Never silently discard it: a rejection means the
  user's workout data did not reach the server, and the user (or the owner, through
  the ledger's `detail` in Django Admin) has to decide what happens next. Resending
  the same mutation always returns the same rejection; a corrected version is a new
  mutation with a new `mutation_id`. `markOutboxRejected` (see [IndexedDB
  stores](#indexeddb-stores)) records it locally; the app shell's
  needs-attention banner (`SyncRejectionBanner`) surfaces it.
- On a request-level error, a network failure or a lost response, keep everything
  queued and resend later with bounded exponential backoff (jittered, ~5s initial,
  capped ~5 minutes). The backoff resets only when a drain reaches the server
  and finds nothing left blocked -- the whole outbox cleared, not merely
  stopped partway on a `retry`/`unsupported_store` result -- or on an explicit
  "Sync now"; a drain that stops partway keeps climbing toward the cap on
  each subsequent blocked cycle instead of retrying at the initial delay
  forever (issue #20's review, finding M4, fixed a bug where the delay reset
  unconditionally before every pull regardless of whether anything was still
  blocked). Duplicates are answered `duplicate`. A `401` specifically stops
  the drain and leaves it paused -- `apiFetch` has already flipped auth to
  `expired` -- with nothing acknowledged.
- **Apply changes-feed records as server-authoritative**, without the local parent
  and precondition checks an action goes through (or buffer them until the whole
  feed is read): a parent can arrive on a later page than its child. The server may
  also have changed records the device holds -- clamped them, closed a superseded
  session, cascaded a delete -- and the feed is how the device learns it.
  Exception: for a record with a pending outbox mutation, this does not
  replace that record's device-writable fields (see [Server-admin
  configuration precedence](#server-admin-configuration-precedence)) -- the
  pending mutation commits later and wins, **except** a server-side closure
  (a tombstone, a session closed by supersede/admin-discard, a child closed
  because its parent closed) it must not lose, so `active_markers` stays
  consistent with what the feed writes. Implemented by
  `applyServerClosureOnly` in `frontend/src/storage/repository.ts`.
- **Merge, do not overwrite, local-only fields.** A feed record carries exactly the
  fields the server models (see [Pull: changes feed](#pull-changes-feed)); fields a
  device keeps locally beyond those must be carried forward when it stores the
  record, not dropped.
- **Drain before pull.** A pull (bootstrap and the changes feed) is only
  attempted once the drain has genuinely reached the server for this cycle
  (fully drained, or stopped on a `rejected`/`retry` result) -- never after a
  request-level failure, which skips the pull entirely and backs off instead.

### Pull: bootstrap

`GET /api/v1/sync/bootstrap/`:

```json
{
  "cursor": 42,
  "limits": { "max_mutations_per_request": 50, "max_changes_per_mutation": 500 },
  "pad": {
    "defaults": { "speed_kmh": 5.0, "incline_pct": 2.0, "max_bout_seconds": 480 },
    "next_session_settings": {
      "source": "previous_session",
      "walking_session_id": "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a",
      "speed_kmh": 5.65,
      "incline_pct": 2.0,
      "max_bout_seconds": 445
    }
  }
}
```

`pad.defaults` are the `PadDefaults` saved in Django Admin, or the application
defaults (5.0 km/h, 2.0 %, 480 s) until someone saves them: server configuration
wins. `next_session_settings` are the most recently completed live session's
settings (`source: "previous_session"`), else the defaults (`source: "defaults"`,
`walking_session_id: null`); `DISCARDED` and deleted sessions are never inherited
from. `cursor` is the account's current change counter.

### Pull: changes feed

`GET /api/v1/sync/changes/?since=<cursor>&limit=<n>` (`since` defaults to 0,
`limit` to 200, at most 500; anything else is `400 invalid_request`):

```json
{
  "changes": [
    {
      "store": "walking_bouts",
      "entity_type": "walking_bout",
      "entity_id": "5e1d2c3b-4a59-4687-b7c6-d5e4f3a2b1c0",
      "change_seq": 41,
      "record": { "id": "5e1d2c3b-…", "walking_session_id": "9f8e…", "…": "…", "deleted_at": null }
    }
  ],
  "cursor": 41,
  "has_more": true
}
```

- Every applied mutation (and every administrator action) advances the account's
  change counter by one and stamps every row it changed with the new value --
  including rows the server changed on its own: clamped, superseded or deleted by
  cascade. The feed returns the account's rows with `change_seq` above `since`.
- Each record appears once, at its latest version, in exactly the local record shape
  (timestamps in `Date.toISOString()` form, tombstones included). It carries only
  the fields the server models -- the ones listed in [PAD validation](#pad-validation)
  plus `id`, `created_at`, `updated_at`, `deleted_at` -- so a device merges it into
  its local record rather than replacing fields the server does not know. Server
  changes leave the device-owned `created_at`/`updated_at` as they were.
- A page is every row with `change_seq` in `(since, cursor]`: rows are chosen in
  change order, and a page ends on a mutation boundary (it can exceed `limit` by at
  most one mutation's changes). Within a page, records are listed **parents first**
  (sessions, then bouts, then pauses and rests; each in change order). Pass the
  returned `cursor` as the next `since` while `has_more` is true. A parent whose
  latest change is newer than the page's cursor is on a later page than its child,
  so a device applies feed records without parent checks, or buffers them (see
  [Client obligations](#client-obligations)).
- The feed never skips a change that commits while it is being read: it reads the
  counter first and leaves anything above it for the next request.
- Only the signed-in account's records are ever returned.

### Server model and administration

`WalkingSession`, `WalkingBout`, `WalkingBoutPause` and `WalkingRest` mirror the
local records: the client's UUID is the primary key, `created_at`/`updated_at`/
`deleted_at` are the repository's own timestamps, and every row belongs to one
account. Single-row and single-table rules are database constraints (check
constraints and partial unique indexes that ignore tombstones); cross-record rules
are enforced by the engine as above. Django Admin edits `PadDefaults` (a singleton)
and shows walking sessions (with their bouts), bouts (with their pauses and rest)
and the processed-mutation ledger **read-only**: an admin edit would bypass the
ledger and the change counter, and the device's next edit would overwrite it. The
one write is the "Discard stuck session" action, which goes through the engine (see
[Stuck ACTIVE sessions](#stuck-active-sessions)).

**Specified design for `Exercise` and `RoutineExercise` (not yet implemented
-- the `exercise_registry` and `routine_exercises` stores don't sync yet, see
[Unsupported stores and versions](#unsupported-stores-and-versions)).** The
same pattern generalizes once they do: the generic Django Admin change form
stays read-only for these synced records too, for the same reason -- editing
them directly would bypass the ledger and the change counter. An
administrator changes one of the shared fields (see [Server-admin
configuration precedence](#server-admin-configuration-precedence)) through a
dedicated admin action, not the change form, exactly like "Discard stuck
session": the account lock, one transaction, a change-counter bump the
changes feed carries to every device, a ledger row, and the server (the nil
UUID, never a device id) recorded as that field's last writer. An admin
*delete* of a synced record (a `RoutineExercise`, say) is a tombstone through
that same engine path, never a row removal -- consistent with [the conflict
rule's tombstones](#conflict-rule-latest-explicit-edit-wins).

## Service-worker updates and the outbox

The application must never depend on background sync (step 5 above) to flush
the outbox. The service-worker update policy is the complementary half of
that same carefulness applied to the *code* the app runs, not just its
queued mutations: a new service-worker version never forces a reload while
there is local work it could interrupt.

Concretely, a new worker version reaching `installed` while an existing
controller is already active does not take over automatically. The page
surfaces a non-blocking "update ready" notice and defers actually applying
it — sending the worker `SKIP_WAITING` and reloading once the new one takes
control — until both of the following hold:

- no session is currently `ACTIVE` (as read from the same local repository
  snapshot described under [Active-session recovery](#active-session-recovery));
- the mutation outbox (`listPendingOutbox()`) is empty.

While either is non-empty, the banner stays visible and explains that the
update applies once the current session finishes, and the app keeps running
on the previous worker version indefinitely — there is no timeout that
forces the swap regardless. This means a long-running PAD session, or a
mutation still waiting on triggers 1–4 above (particularly "restore
connectivity" after an offline stretch), is never interrupted by a deploy:
the update and the pending sync work wait for the same condition, for the
same reason background sync itself is never load-bearing — the app's own
foreground triggers, not anything running behind its back, are what the user
can see and trust to eventually finish the job.

This also means an update can sit pending indefinitely if the outbox is
never drained (e.g. synchronization stays paused because `canSync` is false —
see the sync gate below). That is intentional: an indefinitely-deferred
*code* update is recoverable (the next reload picks up the new version
regardless, once nothing is left to protect), while a forced reload that
silently drops an in-progress bout or a queued mutation is not.

## Authentication and offline continuation

**Status: confirmed 2026-09-19** (originated in #16/#36). The policy below is
unchanged; this section is the settled answer to issue #13's offline-auth
criterion. See [Product overview: Authenticated,
offline-tolerant](product-overview.md#authenticated-offline-tolerant) for the
cross-link into this section.

Summary of the five lifecycle cases, plus local-data retention and the
always-authenticated rule for server access:

| Case | `authStatus` | Local data & outbox | Server access |
| --- | --- | --- | --- |
| First online login (no marker on this device yet) | `login-required` / `server-unreachable` while unresolved, then `authenticated` | App routes, and any data already on this device (for example after a logout), stay hidden until sign-in succeeds; nothing is deleted | Login itself needs the server; app routes do not render before it succeeds |
| Offline reopen of a previously authenticated device | `unverified` | Opens local (IndexedDB) data immediately; outbox stays queued, nothing discarded | Sync paused (`canSync` false) until a decisive verify |
| Server-session expiry (marker exists, server says anonymous or any call gets `401`) | `expired` | Local data and outbox preserved; app stays usable | Sync paused; user must sign in again to resume |
| Explicit logout | `login-required` (auth marker cleared; outbox owner deliberately kept) | Outbox and local data stay on this device | Requires network and confirmation; no further server access until the next sign-in |
| Different-user protection (server-confirmed user != this device's outbox owner, with pending entries) | `account-mismatch` | Local data and outbox untouched; the mismatched session is never adopted | Sign-in is blocked until the rightful owner signs the mismatched session out and back in |

In every case, any protected `/api/v1/` endpoint still requires a currently
authenticated session -- `401 {"code": "not_authenticated"}` otherwise, see
[Acceptance criteria: AUTH-01(a)](acceptance-tests.md#auth-01--unauthenticated-access-and-offline-continuation)
-- only previously-persisted local data can ever be shown without one.

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

The client sync engine, `frontend/src/sync/engine.ts` (issue #20), consults
one gate (`frontend/src/auth/syncGate.ts`) before attempting network
synchronization, every time it checks -- at the start of a drain, again before
a pull, and again before each page of the changes feed -- never a value
captured once:

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

Precisely (see [Conflict rule](#conflict-rule-latest-explicit-edit-wins)): within
one device the outbox `sequence` decides, whatever the wall clock said; across
devices the mutation the server commits last wins; a tombstone wins -- only the
device that deleted a record can restore it, with a newer mutation.

For admin-only configuration edited through Django Admin: server configuration
wins. Fields both sides write follow [Server-admin configuration
precedence](#server-admin-configuration-precedence) below.

For PAD that configuration is the `PadDefaults` singleton, served by
[`GET /api/v1/sync/bootstrap/`](#pull-bootstrap).

Pending local workout mutations must remain safely represented in the outbox before cached server reference data is replaced.

### Server-admin configuration precedence

**Settled 2026-09-19.** Referenced from [Resistance & cardio: Admin-managed
configuration](training.md#admin-managed-configuration) and [Resistance &
cardio: Session edits vs routine edits](training.md#session-edits-vs-routine-edits).
This is the specified design; admin edits to shared fields reach synced
records through the sync engine (see [Server model and
administration](#server-model-and-administration)), but the
`exercise_registry`/`routine_exercises` stores don't sync yet (see
[Unsupported stores and versions](#unsupported-stores-and-versions)), so none
of this is implemented today.

**Admin-only / server-owned fields.** Server wins outright; the device treats
these as cached reference data it never writes to, only replaces wholesale
once its own pending mutations are safely in the outbox (the rule above):

- muscle-group progression percentages;
- `Exercise.machine_increment_kg`;
- allowed starting 1RM percentages and the automatic starting-percentage ceiling;
- the cardio-machine list and each machine's active state;
- PAD defaults (`PadDefaults`);
- `Exercise.name`, `Exercise.muscle_group_id`, `Exercise.machine_notes`, and
  `Exercise.is_archived` -- admin-only *after creation*: the local
  `exercise_registry` store exists, so a device put can technically carry a
  full `Exercise` record, but nothing in the spec has a device create or
  rename an exercise, only Django Admin does;
- `RoutineTemplate.name`, `sequence_number`, and `is_active`;
- `RoutineExercise.notes`.

**Fields both the device and an administrator can write.**
`Exercise.current_working_weight_kg` (set on the device when a resistance
exercise row is completed, when a progression suggestion is accepted, or when
the initial load setup value is chosen), `Exercise.estimated_1rm_kg` (set on
the device by the [Initial 10RM setup](training.md#initial-10rm-setup); an
administrator can also correct it), and `RoutineExercise.default_sets` /
`default_reps` and structure -- order, and which exercises belong to a
routine day -- (via `SAVE TO ROUTINE` / `SAVE CHANGES TO DAY N`, see
[training.md](training.md#session-edits-vs-routine-edits)). These follow the
same settled "latest explicit edit wins" rule as any other cross-writer field
(see [Conflict rule](#conflict-rule-latest-explicit-edit-wins)): whichever
write commits to the server last stands, whether that commit is a device
mutation reaching the server or an administrator's direct edit -- except over
a tombstone: once a `RoutineExercise` is deleted, only the writer that
deleted it can restore it (see [Conflict
rule](#conflict-rule-latest-explicit-edit-wins)); later puts from other
devices or the administrator are skipped and noted in the ledger. A pending
device mutation that syncs *after* an admin edit overwrites it; an admin edit
made *after* the device's mutation already committed stands.

**Field-level ownership on mixed records.** `Exercise` carries both
admin-only and device-writable fields on the same row. A device put still
carries the whole local record (see [Local action
contract](#local-action-contract)), but the server applies only the
device-writable fields (`current_working_weight_kg`, `estimated_1rm_kg`) from
it and keeps its own stored values for the admin-only fields above -- this is
not a rejection, and the mutation is acknowledged normally. "Latest explicit
edit wins, record by record" then applies only to the device-writable
fields; an admin-only field changes only through Django Admin. The same
split applies to `RoutineExercise`: a device put carries the whole record,
including `default_sets`/`default_reps` even when only one changed, but the
server only lets the device move the device-writable fields and keeps its
own `notes` value.

**While a device has a pending mutation for one of these records, a
changes-feed or bootstrap value does not replace that record's
device-writable fields locally**; the pending mutation commits later and
wins once it reaches the server (see the matching exception under [Client
obligations](#client-obligations)).

Worked examples:

```text
09:00  Admin sets Exercise("Chest Press").current_working_weight_kg = 45 kg
09:05  Device completes the Chest Press row offline; a mutation is queued
       locally with current_working_weight_kg = 42.5 kg
09:30  Device reconnects; its queued mutation commits at 09:30

Result: 42.5 kg (the device's commit is later than the admin's edit)
```

```text
09:00  Device completes the Chest Press row offline; mutation queued
09:05  Device reconnects; the mutation commits at 09:05 -> 42.5 kg
09:10  Admin edits current_working_weight_kg = 45 kg in Django Admin

Result: 45 kg (the admin's edit commits after the device's mutation)
```

```text
14:00  Device selects SAVE TO ROUTINE for Day 3 / Chest Press: 3x10 -> 3x12
       (queued while offline; the put carries the whole RoutineExercise
       record, default_sets included even though only default_reps changed)
14:20  Admin edits the same RoutineExercise's default_reps to 8
14:45  Device reconnects; its queued mutation commits at 14:45

Result: default_reps = 12 (the device's later commit wins)
```

**What must be preserved, regardless of the above:**

- Pending session edits sitting in the outbox are never dropped or rewritten
  when bootstrap/cached reference data is refreshed.
- `ResistanceSessionExercise` snapshots (target weight/sets/reps copied from
  the routine when an `ACTIVE` session starts) and historical sessions are
  **never** changed by an admin edit made after the snapshot was taken --
  see [Historical truth](product-overview.md#historical-truth) and
  [Resistance routine model](training.md#resistance-routine-model).
- Completed-exercise weight memory, an explicit `SAVE TO ROUTINE` change, and
  an accepted load-setup/progression suggestion are explicit user edits:
  each one enqueues a mutation and stands or is replaced purely by commit
  order, whole and never partially; a replaced edit is not flagged to
  either side in v1.
- Replacing cached server reference data on a device only happens once that
  device's pending local mutations are safely represented in its outbox (the
  existing rule, unchanged).

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
