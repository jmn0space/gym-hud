# Product Overview

[← Documentation index](README.md)

## Objective

Gym HUD is a private, mobile-first Progressive Web Application for tracking:

1. PAD walking bouts and recovery intervals.
2. A rotating five-day resistance-training routine.
3. Current working weight per exercise, and target sets/reps per routine exercise.
4. A one-time, per-exercise [Initial 10RM setup](training.md#initial-10rm-setup) (assessment weight and repetitions) that establishes the starting working load.
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
One IndexedDB transaction
├── saved domain changes
└── queued synchronization envelope
    ↓
Transaction completes
    ↓
UI reflects persisted state
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

### Authenticated, offline-tolerant

Server access always requires an authenticated Django session; there is no
anonymous or public access to workout data. A device that has signed in
before still opens its local data and lets the user keep working while
offline or while the server session cannot be reached, without losing
unsynchronized work. **Settled 2026-09-19**: see [Data & synchronization:
Authentication and offline
continuation](data-sync.md#authentication-and-offline-continuation) for the
full state machine (first login, offline reopen, session expiry, explicit
logout, and different-user protection).

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

If one or more active sessions exist, expose a clear `RESUME` action for
each active type (up to three; see [Active-session
cardinality](#active-session-cardinality-and-home-resume-cards)) with a
compact state summary, for example:

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

### Active-session cardinality and Home Resume cards

**Settled 2026-09-19.** At most one `ACTIVE` session per type: PAD, resistance,
cardio. Different types may run at the same time, so Home can show up to three
Resume cards at once, always in this fixed order when more than one is active:
**PAD, then resistance, then cardio** (the order the three domains are listed
throughout this document). Starting a new session of a type that already has an
active one requires resuming or finishing/discarding the existing one first;
this holds regardless of how many *other* types are also active.

| Active types | Home Resume cards (in order) | Allowed `START NEW` actions |
| --- | --- | --- |
| none | none | PAD, resistance, cardio |
| PAD | PAD | resistance, cardio |
| resistance | resistance | PAD, cardio |
| cardio | cardio | PAD, resistance |
| PAD + resistance | PAD, resistance | cardio |
| PAD + cardio | PAD, cardio | resistance |
| resistance + cardio | resistance, cardio | PAD |
| PAD + resistance + cardio | PAD, resistance, cardio | none |

This is a local persistence rule (enforced per session-type store, per
device; see [Data & synchronization: Active-session
recovery](data-sync.md#active-session-recovery)). Because it is per device,
an offline cross-device start can briefly leave two same-type `ACTIVE`
sessions until synchronization reaches the server and supersedes one (PAD
today; see [Data & synchronization: Stuck ACTIVE
sessions](data-sync.md#stuck-active-sessions)) -- draining the outbox is
issue #20. The server enforces the same one-`ACTIVE`-per-type rule for PAD
today, as a database constraint, resolving a stuck one the same way;
resistance and cardio mutations are answered `retry` until the server
supports those stores (see [Data & synchronization: Unsupported stores and
versions](data-sync.md#unsupported-stores-and-versions)); their server-side
rule is specified when those stores ship.

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
→ See exercises, weights, and target sets/reps
→ Check exercises off
→ Adjust weight / target sets / target reps when needed
→ Optionally save structural changes to routine
→ Finish resistance session

→ Optionally record a cardio-machine session
→ Close application
```

On next launch, the application must know:

- whether a session is still active, per type (see [Active-session cardinality](#active-session-cardinality-and-home-resume-cards));
- the current PAD state (`READY`, `WALKING`, `PAUSED`, or `RESTING`; see [PAD walking: state machine](pad-walking.md#state-machine));
- the next suggested resistance routine;
- remembered working weights;
- pending unsynchronized changes.

For domain behaviour see [PAD walking](pad-walking.md) and [Resistance & cardio](training.md). For implementation constraints see [Architecture & deployment](architecture.md) and [Data & synchronization](data-sync.md).
