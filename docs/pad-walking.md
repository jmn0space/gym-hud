# PAD Walking

[← Documentation index](README.md) · [Product overview](product-overview.md) · [Data & sync](data-sync.md) · [Acceptance criteria](acceptance-tests.md)

## Walking session

`WalkingSession` represents one PAD walking session.

```text
id                  UUID
status              ACTIVE | COMPLETED | DISCARDED
started_at          datetime UTC
completed_at        datetime UTC nullable
speed_kmh           decimal
incline_pct         decimal
max_bout_seconds    integer
session_notes       text nullable
created_at
updated_at
```

Example:

```text
speed_kmh        = 5.0
incline_pct      = 2.0
max_bout_seconds = 480
```

All bouts in one walking session use the same treadmill settings. There are no per-bout speed or incline overrides in v1.

## Settings inheritance

A new walking session inherits the previous completed session's:

```text
speed_kmh
incline_pct
max_bout_seconds
```

If no completed walking session exists, application defaults are used.

The values remain editable. Once saved, they naturally become the values inherited by the next session.

## Walking bout

`WalkingBout`:

```text
id                  UUID
walking_session_id  FK
bout_number         integer
started_at          datetime
ended_at            datetime nullable
pain_min            integer nullable
pain_max            integer nullable
stop_reason         enum nullable
notes               text nullable
created_at
updated_at
```

Stop reasons:

```text
MAX_DURATION
CLAUDICATION
FOOT_NUMBNESS
SUDDEN_SWELLING
OTHER
```

These values are descriptive only. The application does not infer diagnoses or treatment decisions from them.

## Pain input

The pain selector remains visible during an active bout:

```text
Pain

[ 1 ] [ 2 ] [ 3 ] [ 4 ] [ 5 ]
```

The user may select either one value or two adjacent values.

Examples:

```text
2
3
2–3
3–4
```

Storage:

```text
pain_min
pain_max
```

Examples:

```text
Pain 2
pain_min = 2
pain_max = 2
```

```text
Pain 2–3
pain_min = 2
pain_max = 3
```

The UI rejects non-adjacent combinations such as `1 + 4`. Pain values remain editable after the bout.

## Stop-reason behaviour

The app should minimize input friction. It may preselect an obvious reason:

```text
Bout ended at or after configured maximum
→ MAX_DURATION
```

```text
Bout ended early with claudication pain selected
→ CLAUDICATION
```

The user may always override the inferred value.

Special reasons remain explicitly selectable:

```text
Foot numbness
Sudden swelling
Other
```

If `OTHER` is selected, a note may optionally be entered.

## State machine

Operational states:

```text
READY
WALKING
PAUSED
RESTING
COMPLETED
```

Normal transition:

```text
READY
  │ Start
  ▼
WALKING
  │
  ├── Pause ──► PAUSED ──► Resume
  │
  │ Finish Bout
  ▼
RESTING
  │ Start Next Bout
  ▼
WALKING
```

A walking session may be finished from a non-walking state.

## Starting and timing a bout

`Start Walking` stores an authoritative timestamp:

```text
started_at = current device timestamp
```

Displayed elapsed time is always derived from persisted timestamps. JavaScript timer ticks are never the source of truth.

This rule is part of the broader recovery strategy described in [Data & synchronization](data-sync.md).

## Maximum bout duration

Current default:

```text
8 minutes
```

The maximum is configurable per walking session.

The application does **not** automatically stop the bout at the maximum. At the threshold it may:

- visually emphasize the timer;
- vibrate;
- produce an optional audible alert.

Example:

```text
08:00
MAXIMUM REACHED
```

Walking continues until the user presses `FINISH BOUT`.

If the user accidentally continues too long, the end time can be corrected afterward.

## Pause handling

`WalkingBoutPause`:

```text
id
walking_bout_id
started_at
ended_at nullable
```

Multiple pauses are supported.

Effective walking duration:

```text
bout ended_at
− bout started_at
− total pause duration
```

Example paused HUD:

```text
BOUT 3

Walking: 04:16
PAUSED: 00:37

[ RESUME ]
```

`Finish Bout` remains available while paused.

## Rest handling

Pressing `FINISH BOUT` atomically:

```text
1. sets bout.ended_at
2. starts the recovery interval
```

Rest counts upward and has no predefined duration.

Example:

```text
REST

02:43

[ START NEXT BOUT ]
```

`WalkingRest`:

```text
id
walking_bout_id
started_at
ended_at nullable
```

A completed bout may have one rest interval.

If the session is finished immediately after the bout, the open rest may be closed at session completion without creating another bout.

## Starting the next bout

`Start Next Bout` is one logical operation:

```text
current_rest.ended_at = now
create next bout
next_bout.started_at = now
```

A new bout cannot start while the previous bout has an unfinished rest interval.

## Adding bouts

There is no fixed number of bouts.

```text
Bout 1
Bout 2
Bout 3
...
Bout N
```

The UI includes `+ ADD BOUT`.

Behaviour depends on current state:

- with no active bout and no open rest, it creates the next ready bout;
- while resting, the primary action is `START NEXT BOUT`;
- while walking, another bout cannot be added.

Only one bout can be operationally active at a time.

## Editing, undo, and delete

**Settled 2026-09-20 (issue #22).** Corrections, undo and delete apply only to
the active session -- History remains a placeholder (see [Product
overview](product-overview.md)), so a completed session's records are not
editable in v1.

### Corrections

Recorded times can be tapped and corrected: a bout's `started_at`/`ended_at`,
a pause's `started_at`/`ended_at`, and a rest's `started_at`/`ended_at`. Pain,
stop reason and notes were already editable (see [Pain input](#pain-input)
and [Stop-reason behaviour](#stop-reason-behaviour) above); a time correction
is the same kind of edit, applied to a timestamp field instead.

A correction changes the *value* of an endpoint that is already recorded; it
does not open or close an interval. Concretely: `ended_at` may only be
corrected once the record has actually finished (a still-open bout, pause or
rest is closed by `FINISH BOUT`/`RESUME`/`START NEXT BOUT`, never by editing a
time field to a non-null value), and a correction never sets an endpoint back
to null. `started_at` may be corrected at any time, open or closed.

Changing an endpoint recalculates every derived duration that reads it --
walking time, the pause-adjusted effective walking time, rest duration, and
the session's totals -- automatically, because those are always computed from
the stored timestamps rather than cached (see [Starting and timing a
bout](#starting-and-timing-a-bout) and [Data & synchronization: Active-session
recovery](data-sync.md#active-session-recovery)).

A correction is judged on the *resulting* state of the whole session, not the
edited field alone -- the same rule the server applies (see [Data &
synchronization: PAD validation](data-sync.md#pad-validation)). It is refused,
with a clear message, if it would break containment: a bout starting before
its session; an interval ending before its own start; a pause outside its
bout, or left open once the bout has closed; two pauses of the same bout
overlapping; a rest starting before its bout ended; or PAD-06 (the session
never has an open bout while one of its rests is open). Two bouts of the same
session overlapping *each other* is deliberately not checked: the server does
not check it either (`settle_session_tree` in `backend/apps/pad/sync.py`
clamps each interval into its own parent, never against its siblings), so the
client stays exactly as strict as the server it mirrors, no stricter.

A bout's `ended_at` and its rest's `started_at` share one instant when
`FINISH BOUT` creates them. A correction does not keep forcing them to move
together: correcting the bout's end is validated against the rest's
*current*, unmoved start (and correcting the rest's start is validated
against the bout's current, unmoved end), and refused if that breaks
containment, rather than silently dragging the other value along. Moving a
bout's end past its rest's recorded start therefore takes two corrections --
move the rest's start forward first, then the bout's end -- each individually
valid on its own. This matches how the server itself judges the same edit
(`test_a_time_correction_is_judged_on_the_finished_state`,
`backend/apps/sync/tests/test_mutations_api.py`, which corrects a bout's end
without touching its rest and checks only that the result still holds).

A correction is validated and refused when invalid, never clamped: unlike a
clock stamp (see [Clock steps are
clamped](data-sync.md#clock-steps-are-clamped)), the user is deliberately
choosing this value, so the client does not silently move it to something
else on their behalf.

### Undo

The most recent state-changing action may be undone, including:

```text
Bout started
Bout paused
Bout resumed
Bout finished
Rest finished / next bout started
```

Undo requires confirmation.

**Settled 2026-09-20 (issue #22).** Undo commits a new, forward action that
reverses the effect of the transition above -- it never deletes or rewrites
anything already in the outbox; only `acknowledgeOutbox` ever removes an
outbox row (see [Data & synchronization: Local action
contract](data-sync.md#local-action-contract)). Concretely:

- Bout started -> tombstone the bout.
- Bout paused -> tombstone the pause.
- Bout resumed -> reopen the pause (`ended_at` back to null).
- Bout finished -> reopen the bout (`ended_at` back to null), tombstone the
  rest it created, and reopen whichever pause (if any) `FINISH BOUT` closed
  at the same instant.
- Rest finished / next bout started -> tombstone the bout `START NEXT BOUT`
  created, and reopen the rest it closed (`ended_at` back to null).

Undo works identically whether or not the action it reverses has already
reached the server: reviving a tombstone with a later put is legal for the
device that deleted it (see [Data & synchronization: Conflict
rule](data-sync.md#conflict-rule-latest-explicit-edit-wins), "A tombstone
wins"), which the undoing device always is.

What is undoable is derived from the session's own persisted records, not a
separate undo stack or store: the three states with a running interval
(WALKING, PAUSED, RESTING) each identify at most one reversible transition
purely from the shape of the session's current bouts, pauses and rests --
which interval is open, and which closed pair of timestamps share the exact
instant one of the transitions above produces. This is why undo survives a
reload and a second tab, and why a correction that has since moved one side
of a coupled pair -- a bout's end, or its rest's start -- makes that
particular undo unavailable rather than reversing it inexactly: once
corrected, that value is the user's deliberate, newer edit, not the one the
original transition wrote. An unrelated edit on top (a pain value, a note)
does not block undoing the transition underneath it.

### Delete

A bout may also be deleted with confirmation. Display numbering is then recomputed, but internal UUIDs never change.

**Settled 2026-09-20 (issue #22).** Deleting a bout tombstones it and its
pauses and rest, and puts every surviving bout of the session with a
recomputed, contiguous `bout_number` in start order -- all in one action, one
transaction, one outbox envelope (see [Data & synchronization: Local action
contract](data-sync.md#local-action-contract)). Only a finished bout may be
deleted; an in-progress one is removed through undo (if it was only just
started) or finished first, never deleted out from under a running timer.
`bout_number` is a display field, not identity (see
`backend/apps/pad/models.py`'s `WalkingBout.bout_number` docstring): a record
set with gaps in it still renders with sensible numbers regardless, because
display numbering is also independently derivable from start order
(`parseWalkingBouts` in `frontend/src/pad/records.ts`).

## Active HUD

Example:

```text
PAD WALKING

5.0 km/h       Incline 2.0%
Maximum bout   08:00

Bout 4

       05:43

Pain
[ 1 ] [ 2 ] [ 3 ] [ 4 ] [ 5 ]

[ PAUSE ]
[ FINISH BOUT ]

----------------------------

Bout 1   08:07   Pain 2–3
Rest     02:41

Bout 2   06:32   Pain 4
Rest     03:18

Bout 3   08:04   Pain 3
Rest     02:55

[ + ADD BOUT ]

Notes

[ FINISH SESSION ]
```

Primary controls should use touch targets of roughly 48 × 48 px or larger. Keyboard input should be avoided during normal operation.

## Start screen

Example:

```text
PAD WALKING

5.0 km/h
Incline 2.0%
Max bout 8:00

Last session
5 bouts
34:22 walking

[ START ]
```

No PAD charts are required in v1.
