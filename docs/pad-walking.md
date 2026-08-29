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

Recorded times can be tapped and corrected. Changing an endpoint recalculates all derived durations.

The most recent state-changing action may be undone, including:

```text
Bout started
Bout paused
Bout resumed
Bout finished
Rest finished / next bout started
```

Undo requires confirmation.

A bout may also be deleted with confirmation. Display numbering is then recomputed, but internal UUIDs never change.

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
