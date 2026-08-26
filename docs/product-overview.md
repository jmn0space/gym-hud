# Product Overview

[← Documentation index](README.md)

## Objective

Gym HUD is a private, mobile-first Progressive Web Application for tracking:

1. PAD walking bouts and recovery intervals.
2. A rotating five-day resistance-training routine.
3. Current working weights, sets, and repetitions per exercise.
4. A one-time 10RM-based starting-load assessment.
5. Cardio-machine sessions such as arm crank, stationary bike, step climber, or rowing machine.
6. Historical sessions and incomplete exercises.

The application is primarily a **training notebook and session HUD**, not an automated coach.

It must:

- show what the user should perform next;
- remember previous settings automatically;
- require very little typing during exercise;
- survive screen locking, page reloads, temporary loss of connectivity, and browser/PWA termination;
- allow manual correction of recorded values;
- never automatically change training parameters;
- make suggestions where configured, but require explicit user acceptance.

## Product principles

### Local first

Every meaningful interaction is committed locally before network synchronization.

```text
User action
    ↓
IndexedDB transaction
    ↓
UI immediately reflects saved state
    ↓
Mutation added to sync outbox
    ↓
Server synchronization when available
```

Background synchronization is an optimization only. Correct operation must not depend on Android allowing background execution.

See [Data & synchronization](data-sync.md).

### User-controlled progression

The application does not independently prescribe treadmill speed/incline, machine weight, sets, repetitions, or exercise substitutions.

It may calculate suggestions from configured rules. A suggestion becomes active only after the user accepts it or manually enters another value.

### Historical truth

A workout record represents what happened that day. Changing a routine template later must not retroactively alter previous sessions.

```text
Routine Template
      ↓ copied when session begins
Workout Session Snapshot
```

See [Resistance & cardio](training.md) for routine snapshot behaviour.

## Main application domains

V1 contains five domains:

```text
PAD Walking
Resistance Training
Cardio Machines
Exercise Configuration
Application Configuration
```

PAD, resistance, and cardio sessions are independent. There is no `GymVisit` entity.

This allows multiple sessions on the same date without forcing them into a parent visit.

## Primary home-screen behaviour

The home screen prioritizes resumable work.

If an active session exists, expose a clear `RESUME` action with a compact state summary, for example:

```text
RESUME

PAD Walking
Resting 03:12

[ RESUME ]
```

or:

```text
RESUME

Day 3
4 / 7 exercises complete

[ RESUME ]
```

Below that, offer:

```text
START NEW

[ PAD WALKING ]

Suggested resistance:
[ DAY 4 ]

[ CHOOSE ANOTHER DAY ]

[ CARDIO MACHINE ]

[ HISTORY ]
```

Starting a new session while another session of the same type remains active should require resumption, discard, or explicit confirmation.

## V1 non-goals

The following are explicitly out of scope for v1:

- automatic medical decisions;
- automatic treadmill progression;
- automatic resistance progression;
- RPE tracking;
- individual resistance-set tracking;
- actual repetition tracking;
- elbow pain or swelling scoring;
- heatmaps and trend charts;
- longitudinal estimated-1RM analysis;
- heart-rate monitoring;
- wearable integration;
- machine photos or manufacturer integrations;
- multi-user support;
- social features;
- notification campaigns;
- external OAuth identity providers;
- AI recommendations.

## V1 success criterion

Version 1 is successful if this workflow is reliable:

```text
Open PWA

→ Resume active session
or
→ Start PAD session

→ Walk
→ Finish bout
→ Rest
→ Start next bout
→ Repeat
→ Finish PAD session

→ Open suggested resistance day
→ See exercises, weights and targets
→ Check exercises off
→ Adjust weight / sets / repetitions when needed
→ Optionally save structural changes to routine
→ Finish resistance session

→ Optionally record a cardio-machine session
→ Close application
```

On next launch, the application must know:

- whether a session is still active;
- the current PAD bout/rest state;
- the next suggested resistance routine;
- remembered working weights;
- pending unsynchronized changes.

For domain behaviour see [PAD walking](pad-walking.md) and [Resistance & cardio](training.md). For implementation constraints see [Architecture & deployment](architecture.md) and [Data & synchronization](data-sync.md).
