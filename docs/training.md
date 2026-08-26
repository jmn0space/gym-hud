# Resistance & Cardio Training

[← Documentation index](README.md) · [Product overview](product-overview.md) · [Data & sync](data-sync.md) · [Acceptance criteria](acceptance-tests.md)

## Resistance routine model

There are five rotating resistance templates:

```text
Day 1
Day 2
Day 3
Day 4
Day 5
```

Actual exercise contents are deferred and can initially be empty.

### `RoutineTemplate`

```text
id
name
sequence_number
is_active
```

### `RoutineExercise`

```text
id
routine_template_id
exercise_id
order
default_sets
default_reps
notes nullable
```

When a resistance session starts, the current routine is copied into session rows. Later template edits never rewrite historical sessions.

## Exercise registry

### `Exercise`

```text
id
name
muscle_group_id
machine_increment_kg
current_working_weight_kg nullable
estimated_1rm_kg          nullable
machine_notes             nullable
is_archived
created_at
updated_at
```

`estimated_1rm_kg` is reference data from the initial load assessment only. Normal progression does not depend on it after the initial working load has been established.

V1 deliberately excludes machine photos, serial numbers, gym maps, and manufacturer integrations.

### `MuscleGroup`

```text
id
name
progression_pct
```

Examples include chest, back, shoulders, biceps, triceps, quadriceps, hamstrings, calves, and glutes.

Exact progression percentages are configured later through Django Admin.

## Resistance session

### `ResistanceSession`

```text
id
routine_template_id nullable
session_kind
status
started_at
completed_at nullable
notes nullable
created_at
updated_at
```

`session_kind`:

```text
MAIN_ROUTINE
CATCH_UP
AD_HOC
```

`status`:

```text
ACTIVE
COMPLETED
DISCARDED
```

### `ResistanceSessionExercise`

```text
id
resistance_session_id
exercise_id
order
target_weight_kg
target_sets
target_reps
completed boolean
notes nullable
created_at
updated_at
```

There is intentionally no individual `ResistanceSet` model in v1. Actual set-by-set repetitions are not logged.

## Resistance HUD

Example:

| Done | Exercise | Weight | Target |
|---|---|---:|---:|
| ☐ | Chest Press | 40 kg | 3×10 |
| ☐ | Seated Row | 45 kg | 3×10 |
| ☐ | Triceps Machine | 22.5 kg | 3×12 |

The user may edit weight, number of sets, and target repetitions. The entire exercise row is then marked complete.

## Session edits vs routine edits

### Weight

Changing `40 kg → 42.5 kg` changes today's session.

If that exercise is subsequently marked completed, the value becomes `Exercise.current_working_weight_kg` and is proposed next time.

If the exercise is not completed, its experimental session weight does not replace the remembered working weight.

### Sets and repetitions

Changing `3×10 → 3×8` affects today's session only by default.

The UI may offer `SAVE TO ROUTINE` to update the corresponding `RoutineExercise`.

### Exercise structure

Adding, removing, or reordering an exercise affects today's session only by default.

The UI may offer `SAVE CHANGES TO DAY N` to modify the source routine template.

Historical sessions are never modified.

## Routine rotation

The app remembers the most recently completed `MAIN_ROUTINE`.

Example:

```text
Last completed: Day 1
Suggested next: Day 2
```

The user may manually start any routine.

If Day 3 is selected and completed:

```text
Last completed: Day 3
Suggested next: Day 4
```

Skipped days are not forced back into the sequence.

The sequence wraps:

```text
Day 5 → Day 1
```

`CATCH_UP` and `AD_HOC` sessions do not alter the main routine pointer.

## Incomplete exercises

Finishing a resistance session means the workout is over.

Unchecked rows remain `completed = false`.

Example history:

```text
Day 2

✓ Chest Press
✓ Row
✗ Triceps
✗ Biceps
```

A later `CONTINUE REMAINING` action may create a new `CATCH_UP` session containing the incomplete exercises. The original session remains unchanged and the catch-up session does not alter the Day 1–5 rotation.

## Initial 10RM setup

The 10RM workflow exists only to establish a starting working load.

There is no separate `StrengthAssessment` model.

During exercise setup, the user temporarily enters:

```text
assessment weight
assessment repetitions
```

The application calculates:

```text
estimated_1RM
=
assessment_weight
/
(1.0278 - 0.0278 × assessment_reps)
```

The result is stored as `Exercise.estimated_1rm_kg`. Temporary assessment inputs do not need to persist.

### Starting-load preview

Example:

```text
Estimated 1RM: 66.7 kg

60% → 40.0 kg
65% → 43.4 kg
70% → 46.7 kg
75% → 50.0 kg
80% → 53.4 kg
```

The user selects an allowed percentage. The application then considers the machine increment and shows nearby practical loads rather than automatically choosing one.

The selected value becomes `current_working_weight_kg`.

## Initial percentage ceiling

The configured automatic starting-load range may not exceed:

```text
80% estimated 1RM
```

without an explicit configuration change.

This is an application policy boundary, not a medical-safety claim. The UI should say `Configured automatic limit: 80%` rather than presenting the threshold as universally safe.

The ceiling and allowed initial percentages are managed through Django Admin.

## Post-assessment progression

After the initial working weight is established, progression no longer uses the stored estimated 1RM.

```text
suggested raw weight
=
current_working_weight
×
(1 + muscle_group.progression_pct)
```

Example:

```text
Current chest press: 40 kg
Chest progression: 5%
Raw suggestion: 42 kg
```

With a 2.5 kg machine step, the UI can show:

```text
Calculated target: 42.0 kg
Nearby machine load: 42.5 kg

[ USE 42.5 ]
[ KEEP 40 ]
```

Nothing changes automatically.

## Progression trigger

The application does not decide when progression is deserved. It does not use RPE, actual repetitions, or time-at-weight rules.

Instead, a resistance row may expose `SUGGEST INCREASE`.

When pressed:

1. read `current_working_weight_kg`;
2. read the exercise's muscle-group progression percentage;
3. calculate the raw target;
4. show the nearest practical machine load;
5. wait for explicit user confirmation.

## Cardio machines

Cardio tracking is generic rather than arm-crank-specific.

Examples:

- Arm Crank
- Stationary Bike
- Step Climber
- Rowing Machine
- other manually configured machine types

### `CardioMachine`

```text
id
name
is_active
created_at
updated_at
```

Additional machine types can be created through Django Admin.

### `CardioMachineSession`

```text
id
machine_id
status
started_at
completed_at nullable
duration_seconds
resistance_level
notes nullable
created_at
updated_at
```

`status`:

```text
ACTIVE
COMPLETED
DISCARDED
```

V1 records only machine, duration, resistance level, and optional notes.

No RPM, power, distance, speed, heart rate, or other telemetry is required.

The most recently used machine and resistance level may be offered as defaults for the next cardio session.

## Admin-managed configuration

The following training configuration belongs in Django Admin rather than a dedicated v1 settings UI:

- muscle-group progression percentages;
- exercise name, muscle group, machine increment, current working weight, estimated initial 1RM, notes, and archived state;
- allowed starting 1RM percentages and maximum automatic starting percentage;
- cardio-machine names and active/inactive state.

See [Architecture & deployment](architecture.md) for the Django/Admin stack and [Data & synchronization](data-sync.md) for offline persistence.
