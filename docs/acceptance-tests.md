# Acceptance Criteria

[← Documentation index](README.md) · [PAD walking](pad-walking.md) · [Resistance & cardio](training.md) · [Architecture](architecture.md) · [Data & sync](data-sync.md)

These tests define the minimum behaviour required for v1.

## PAD

### PAD-01 — Lock-screen recovery

1. Start a bout.
2. Lock the phone.
3. Leave it locked for several minutes.
4. Unlock.
5. Resume the PWA.

Expected: displayed duration matches timestamp-derived duration.

### PAD-02 — Application termination

1. Start a bout.
2. Fully terminate the PWA/browser process.
3. Reopen the application.

Expected: the home screen exposes `Resume PAD Walking` and reconstructs the correct state and elapsed duration.

### PAD-03 — Offline session

1. Disable connectivity.
2. Start a bout.
3. Finish it.
4. Record pain 3–4.
5. Rest.
6. Start the next bout.

Expected: all operations work locally.

### PAD-04 — Reconnection

After PAD-03, restore connectivity.

Expected: queued data synchronizes without manual re-entry.

### PAD-05 — Duplicate mutation

Transmit the same mutation twice.

Expected: only one logical server-side event exists.

### PAD-06 — Rest integrity

While resting, attempt to start another bout outside the normal control.

Expected: a new walking bout cannot start until the existing rest is closed. `START NEXT BOUT` closes the rest and starts the next bout atomically.

### PAD-07 — Maximum timer

Allow a bout to reach and exceed its configured maximum.

Expected: the HUD alerts the user but does not automatically terminate the bout.

### PAD-08 — Pause

1. Start a bout.
2. Pause for two minutes.
3. Resume.
4. Finish.

Expected: effective walking duration excludes the paused interval.

### PAD-09 — Manual time correction

1. Allow a bout to continue accidentally beyond its intended end.
2. Finish it.
3. Edit the displayed end time.

Expected: bout duration and related derived values are recalculated correctly.

## Resistance training

### GYM-01 — Routine sequence

Complete Day 1.

Expected: `Suggested next: Day 2`.

### GYM-02 — Manual routine selection

After Day 1, manually complete Day 3.

Expected: `Suggested next: Day 4`.

### GYM-03 — Incomplete routine

Finish Day 2 with 5 of 7 exercises checked.

Expected:

- the session is completed;
- five exercises remain historically completed;
- two remain historically incomplete;
- the main routine pointer advances.

### GYM-04 — Weight memory

Existing working weight: `Chest Press = 40 kg`.

During the session change it to `42.5 kg` and mark Chest Press complete.

Expected next appearance: `42.5 kg`.

### GYM-05 — Incomplete weight change

Existing working weight: `Chest Press = 40 kg`.

Change today's target to `42.5 kg` but do not complete the exercise.

Expected next appearance: `40 kg`.

### GYM-06 — Temporary rep scheme

Routine target: `3×10`.

Change today's session to `3×8` without selecting Save to Routine.

Expected next main session: `3×10`.

### GYM-07 — Permanent routine change

Change `3×10 → 3×12` and select `SAVE TO ROUTINE`.

Expected: future routine instances use `3×12`; historical sessions remain unchanged.

## Load setup and progression

### LOAD-01 — Initial 1RM calculation

Enter assessment weight and assessment repetitions.

Expected: estimated 1RM is calculated and stored on `Exercise.estimated_1rm_kg`. No `StrengthAssessment` row is created.

### LOAD-02 — Initial ceiling

Configure maximum automatic starting percentage to `80%`.

Expected: the normal starting-load selector does not automatically offer a value above 80%.

### LOAD-03 — Post-assessment progression

After a working weight is established, request a progression suggestion.

Expected: the calculation uses `current_working_weight_kg` and muscle-group progression percentage, not `estimated_1rm_kg`.

## Cardio

### CARDIO-01 — Machine selection

Create a cardio session and choose `Arm Crank`.

Expected: the session is associated with the configured `CardioMachine`.

### CARDIO-02 — Persistence

Record `Duration: 10 min` and `Level: 4`, then finish.

Expected: values appear correctly in history.

### CARDIO-03 — Offline cardio

Disable connectivity and create/finish a cardio-machine session.

Expected: the session persists locally and synchronizes after connectivity returns.

## Deployment and authentication

### DEPLOY-01 — No public Django port

Run the production Docker Compose deployment.

Expected: Django is reachable from `cloudflared` through `http://web:8000`, but port 8000 is not published directly to the VPS host.

### AUTH-01 — Unauthenticated access

Open the application hostname without a valid Django session.

Expected: protected application/API routes are inaccessible until authentication succeeds.

## Overall v1 continuity criterion

After closing and reopening the app, it must correctly restore:

- active-session presence;
- current PAD walking/pause/rest state;
- next suggested resistance routine;
- remembered working weights;
- pending unsynchronized mutations.
