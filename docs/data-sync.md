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

The current local schema version is 2. It uses these stores:

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
```

`action_receipts` retains committed action IDs after pending outbox entries are
acknowledged. `internal_metadata` owns the local sequence and client identity;
caller synchronization metadata cannot overwrite those values. These two stores
are repository internals rather than domain data exposed to the UI.

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
