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
IndexedDB transaction
    ↓
UI updates immediately
    ↓
Mutation appended to outbox
    ↓
Server synchronization when available
```

This rule applies to PAD, resistance, and cardio sessions.

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

## IndexedDB stores

Suggested stores:

```text
walking_sessions
walking_bouts
walking_pauses
walking_rests

resistance_sessions
resistance_rows

cardio_sessions

routine_templates
exercise_registry
reference_data

outbox
sync_metadata
```

Reference data includes what the HUD needs offline, such as:

- routine definitions;
- exercise names;
- working weights;
- muscle-group progression configuration required for suggestions;
- cardio-machine names;
- PAD defaults.

## Mutation outbox

Every locally persisted server-side change creates an outbox mutation.

Example:

```json
{
  "mutation_id": "UUID",
  "entity_type": "walking_bout",
  "entity_id": "UUID",
  "operation": "update",
  "created_at": "...",
  "payload": {}
}
```

Possible `entity_type` values include:

```text
walking_session
walking_bout
walking_pause
walking_rest
resistance_session
resistance_session_exercise
cardio_machine_session
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

A successful mutation is removed from, or marked acknowledged in, the local outbox. Failed mutations remain queued.

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
