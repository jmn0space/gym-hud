# Issue #18 implementation plan

Source: https://github.com/jmn0space/gym-hud/issues/18
Base: main at d23085e (installable offline PWA from #17 merged).

## Goal and boundaries

Prove the core product promise end to end on one device: Home → Start PAD →
Start Walking → close or force-stop the app → Resume, with the elapsed time
still correct. That means a typed local PAD domain (walking session, bout,
pause, rest), editable session settings that inherit from the previous
completed session, starting a session and a bout through the existing
local-write/outbox boundary, and reconstructing WALKING / PAUSED / RESTING
state from persisted records alone.

Everything is built on the shared persistence foundation from issue #15 --
`frontend/src/storage`'s `commitAction`, its in-transaction preconditions, and
its active-marker cardinality rules -- and on the recovery snapshot Home
already reads. No new IndexedDB store, no schema-version bump (still 3), no new
runtime dependency, and no change to the service worker or to
[`docs/pad-walking.md`](../pad-walking.md)'s domain decisions.

This issue deliberately does **not**:

- add the pause/resume, pain selector, stop-reason picker, finish-bout, rest,
  start-next-bout, add-bout, time-editing or undo controls -- the full
  pause/rest/pain/completion flow is a separate story;
- add backend synchronization or replay (issue #13 remains open; phase 2);
- touch resistance or cardio screens, `backend/`, or `deploy/`.

Pause and rest *are* modelled, persisted and derived here even though nothing
in this slice can create them: the Resume card and the state machine must read
PAUSED and RESTING correctly for data that already exists (seeded, written by a
later story, or arriving from another device), and a recovery path that only
understands the states this slice can produce would be a recovery path that
breaks on the first real session.

### Why `FINISH SESSION` is in scope

It is the one completion control this slice ships, and it is not optional:

- the repository allows at most one `ACTIVE` walking session per device. With
  no way to close one, the first session started would wedge the PAD screen --
  and the app's one-active-session rule -- permanently;
- acceptance criterion 2 (inherit settings from the *previous completed*
  session) is unreachable if no session can ever reach `COMPLETED`;
- it is the honest counterpart to starting something: a user who starts a
  session in this build must be able to end it.

It closes any open pause, open bout and open rest (`ended_at`) and sets the
session to `COMPLETED` with `completed_at` in a single `commitAction`, so the
open-interval markers can never outlive the session that owns them. It
deliberately records no `stop_reason`: inferring one belongs with the
stop-reason picker, which is deferred, and the value stays editable later.

## Implementation sequence

1. **Typed domain (`frontend/src/pad/`).** `types.ts` mirrors the field lists
   in [PAD walking](../pad-walking.md) exactly, including the nullable fields,
   `pain_min`/`pain_max`, `bout_number` and the five stop reasons, plus the
   application defaults (`5.0 km/h`, `2.0 %`, `480 s`). `records.ts` narrows
   untyped `LocalRecord` rows into those types and serializes them back as full
   record replacements. `session.ts` derives the operational state machine
   (`READY | WALKING | PAUSED | RESTING | COMPLETED`) and every elapsed value
   from stored timestamps. `actions.ts` builds the three local actions. Ids
   come from `createUuid`; timestamps are always passed in by the caller, never
   read from a clock inside the domain layer.
2. **Tolerant parsing.** Recovery must survive one bad row, so parsing never
   throws. The rule is narrow: fields that only affect *display* (settings,
   notes, pain, stop reason) fall back to a safe value, while fields that
   decide *identity or state* (ids, parent ids, `started_at`, `ended_at`) must
   be trustworthy or the row is ignored. A start time falls back to the
   repository-stamped `created_at`; a corrupt `ended_at` drops the row rather
   than being read as "still open", which would otherwise resurrect a finished
   bout as a phantom WALKING state.
3. **Settings inheritance.** The recovery snapshot is bounded to live `ACTIVE`
   state, so completed sessions are simply not in it. The provider gained one
   read -- `listRecords` -- so the start screen reads history through the same
   repository connection instead of opening a second one. A new session
   pre-fills from the most recent `COMPLETED` session (`DISCARDED` is skipped)
   and otherwise from the application defaults; the values stay editable until
   the session is saved.
4. **Controls.** `PadPage` renders either the start screen (settings form, a
   "last session" summary, `START`) or the active HUD (settings, bout number,
   the derived timer, `START WALKING` when READY, a read-only PAUSED/RESTING
   state, `FINISH SESSION`, and the completed bouts so far). Every control is a
   full-width `--touch-target` button; inputs are numeric with labels.
5. **Transaction boundary and duplicate starts.** One logical operation is
   exactly one `commitAction`. Each operation's `actionId`, record UUID *and*
   timestamp are minted once per attempt and reused until it succeeds, so a
   double tap or a retry submits a byte-identical action that the repository's
   durable receipt answers instead of writing a second session or bout. A
   synchronous in-flight ref rejects the second tap before React has even
   re-rendered the disabled button. The absence/`status: ACTIVE` preconditions
   and the one-active-session rule stay where they belong -- inside the write
   transaction. Failures surface through `LocalDataProvider`'s existing error
   surface, which can resubmit the same failed action.
6. **Recovery.** `deriveActiveSessionSummaries` now derives the PAD card
   through the same `readPadSession` the page uses (no parallel derivation),
   and its status names the bout -- "Walking · Bout 3" -- because "Walking"
   alone does not tell you what you are resuming. `useNow` resynchronizes the
   clock on focus and on becoming visible as well as ticking, since a locked
   phone stops delivering ticks entirely; Home uses it too.

## Verification

`cd frontend && npm run check` (typecheck, ESLint with `--max-warnings 0`, the
full test suite, production build) passes clean.

Automated coverage added:

- `frontend/src/pad/padSession.test.ts` -- state machine, elapsed derivation
  (including effective walking time net of pauses and an open pause counted up
  to now), the maximum-reached flag, parsing tolerance, bout numbering,
  settings inheritance and defaults, and the three action builders. All with an
  explicit `now`, no wall clock.
- `frontend/src/pages/PadPage.test.tsx` -- start screen defaults and
  inheritance, editing, start session/bout, duplicate-start prevention,
  receipt-answered resubmission plus `ActiveSessionConflictError` on a second
  session, finish-session, the error surface, and the two named acceptance
  tests below. The repository-backed cases freeze only `Date`
  (`vi.useFakeTimers({ toFake: ["Date"] })`), so IndexedDB and `waitFor` keep
  real timers while asserted durations stay exact.
- **PAD-01** (`PAD-01 — lock-screen recovery`): with *all* timers faked, the
  clock advances five minutes while not a single interval callback is
  delivered; the display stays stale, and a `visibilitychange` alone brings it
  to the exact timestamp-derived duration. A tick-accumulating timer cannot
  pass this.
- `frontend/src/App.test.tsx` -- the headline path through the real shell:
  Home → PAD walking → `Start` → `Start walking` → Home shows a
  `Resume PAD Walking` card reading "Walking · Bout 1" → Resume returns to the
  running bout.
- **PAD-02** (`PAD-02 — application termination`): a session and bout are
  started through the UI, the view is unmounted and the repository connection
  closed, and a brand-new connection and provider over the same database
  reconstruct WALKING, the bout number, the elapsed duration and the Resume
  card's summary -- from persisted records alone.

Not verified here: anything on real hardware. PAD-01 and PAD-02 also have a
device procedure in [`docs/device-smoke-tests.md`](../device-smoke-tests.md),
recorded as pending a run; automated coverage is not a device run, and the
manual checklist boxes in [`docs/acceptance-tests.md`](../acceptance-tests.md)
stay unticked.

## Deliberately deferred

| Deferred | Where it belongs |
|---|---|
| `PAUSE`/`RESUME`, `FINISH BOUT`, rest, `START NEXT BOUT`, `+ ADD BOUT` | the pause/rest/pain/completion story (data model and derivation already exist here) |
| Pain selector, stop-reason picker and inference, notes | same story |
| Editing recorded times, undo, delete | same story |
| Maximum-bout vibration and audible alert | same story; this slice only emphasizes the HUD text (PAD-07's "alerts but does not stop") |
| PAD history and charts | History screen; v1 needs no PAD charts |
| Outbox replay to the server | issue #13, phase 2 |
