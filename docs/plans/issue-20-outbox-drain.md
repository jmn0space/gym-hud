# Issue #20 implementation plan

Source: https://github.com/jmn0space/gym-hud/issues/20
Base: `origin/main` at a310b68 (issue #13's field-level ownership/admin-precedence
contract merged).

## Goal and boundaries

Drain the device's PAD outbox to the server and refresh reference data, without
ever losing or reordering local work: attempt synchronization after a local write,
at startup, on PWA foreground return, and when connectivity returns; serialize
drains to one per device; respect the server's ascending-sequence and batch-stop
rules; acknowledge only confirmed mutations; retry transient failures with bounded
backoff; retain failed/unacknowledged mutations across restarts; pause for expired
authentication; pull bootstrap and the changes feed without ever letting cached
server data clobber a pending local edit.

This is the client half of the protocol issue #19 built on the server. The server
side (ledger, envelope parsing, engine, endpoints) is unchanged by this issue.

This issue deliberately does **not**:

- implement service-worker background sync (trigger 5) -- owner decision 2;
  triggers 1-4 only;
- add local PAD rule enforcement (containment clamping, PAD-06) to
  `commitAction` -- owner decision 1; issue #21 adds that in a separate,
  concurrently-worked worktree, and this issue's repository changes are
  additive and localized specifically so the two merge cleanly;
- build a dedicated sync screen or route -- owner decision 3; the UI is a
  status strip plus a rejection banner in the existing app shell;
- change anything on the server; nothing here required a backend change.

## Decisions agreed with the owner (from the brief; not revisited)

1. **No local PAD rule changes.** Repository additions are new methods and new
   `internal_metadata`/`outbox` fields only; `commitAction`'s existing
   validation paths are untouched.
2. **No service-worker Background Sync.** Triggers 1-4 only; the application
   never depends on trigger 5 (docs/data-sync.md already states this).
3. **Status UI scope.** A small `role="status"` strip (`SyncStatus`) in the app
   shell, plus a persistent `role="alert"` "needs attention" banner
   (`SyncRejectionBanner`) for permanently rejected mutations, with a manual
   "Sync now" retry on both. No new routes.

## Design

### Repository (`frontend/src/storage/`), additive only

- `getClientId()` -- reads (or, if absent, creates) the same `internal_metadata`
  key `commitAction` already bootstraps (`CLIENT_ID_KEY`), so whichever of the
  two runs first creates it and it never changes afterward.
- `markOutboxRejected(mutationId, rejection)` -- stores `{code, detail,
  rejectedAt}` on the stored outbox row (a new `StoredOutboxEntry` shape,
  private to the repository) without removing it. A no-op if the entry is
  already gone (acknowledged concurrently, or never existed).
- `listRejectedOutbox()` -- the needs-attention set.
- **`listPendingOutbox()` now excludes rejected entries**, and so does
  `readSnapshot()`'s `pendingOutbox` field (extended for the same reason: a
  rejected entry is never "pending" anywhere in the local contract). This is
  the one behavior change to an existing method; see "Tests" below for the
  existing assertion it moved.
- `applyServerRecords(changes, cursor)` -- applies one changes-feed page in one
  `{ durability: "strict" }` transaction with the cursor write, so a page is
  never re-applied nor skipped after an interruption. No outbox entry,
  sequence, or receipt is produced, and none of `commitAction`'s
  precondition/cardinality/parent checks run.
  - **Merge, never replace**: `{ ...existing, ...feedRecord }` for a record
    with no pending mutation, so local-only fields survive.
  - **A record with a still-pending (non-rejected) outbox mutation** is left
    alone by `applyServerClosureOnly`, **except** a server-side closure it must
    not lose: a tombstone, a session closed by supersede/admin-discard, or a
    bout/pause/rest closed because its parent closed (`ended_at`). This is the
    one genuinely underspecified corner of the spec -- see "Decisions I made"
    below.
  - `active_markers` is kept consistent with every write, self-healing exactly
    like `commitAction`'s own marker maintenance (put the marker when the
    merged record is active/open; clear it, only if it still points at this
    record, when it is not) -- so a later local commit is never falsely
    blocked by a marker the feed has since made stale.

### `frontend/src/sync/` (new)

- **`protocol.ts`** -- wire types for the three endpoints, mirrored from
  `backend/apps/sync/protocol.py`/`views.py`. `parsePushResponse` treats an
  unrecognised `status` or a malformed body as "not processed, keep it
  queued": it filters out anything that does not match the known shapes rather
  than throwing, so a server bug or a mangled proxy response can never make
  the engine acknowledge (and thereby lose) a mutation it is unsure about.
  `isBootstrapResponse`/`isChangesResponse` are the same kind of defensive
  guard for the two GET endpoints.
- **`api.ts`** -- thin `apiFetch` wrappers (`pushMutations` is `csrf: true`).
- **`engine.ts`** -- `createSyncEngine(deps)`: a plain factory (repository, the
  three api functions, `canSync()`, an injectable clock/random/backoff-bounds
  for tests). No React. Exposes `{ subscribe, getSnapshot, trigger, syncNow,
  dispose }`.
  - **One drainer per device**: `navigator.locks.request("gym-hud-sync", ...)`
    when available, an in-process promise chain otherwise (jsdom, older
    browsers). Overlapping `trigger()` calls coalesce: a `running` flag plus a
    token counter (not a boolean -- see the comment in `runLoop`, TypeScript's
    control-flow narrowing cannot see a *different* closure mutating a shared
    `let` across an `await`) collapse any number of triggers that arrive while
    a cycle is in flight into exactly one follow-up cycle, never a second
    concurrent drain and never one follow-up per trigger.
  - **Drain**: reads `listPendingOutbox()` (already sequence-ordered by the
    repository's index), batches up to `max_mutations_per_request` (learned
    from bootstrap, default 50), sends verbatim with `client_id` from
    `getClientId()`. Per mutation result: `applied`/`duplicate` ->
    `acknowledgeOutbox`; `rejected` -> `markOutboxRejected`, batch continues;
    `retry` (or an entry the parser dropped/never listed) -> stop, everything
    from there stays queued; a request-level failure (network/4xx/5xx, or a
    `401`) -> nothing acknowledged, back off (a `401` specifically pauses --
    apiFetch has already flipped auth to `expired`).
  - **Pull**: only attempted once the drain has genuinely reached the server
    (fully drained or stopped on a `rejected`/`retry` result -- never after a
    request-level failure), matching "drain before pull". Reads bootstrap,
    caches `pad.defaults`/`next_session_settings`/`limits` via
    `writeReferenceCache`, then pages the changes feed from the stored cursor
    while `has_more`, applying each page through `applyServerRecords`.
  - **Backoff**: exponential with jitter (`+/-10%`, injectable `random` for
    deterministic tests), initial ~5s, capped ~5 minutes (mirrors
    `AuthProvider`'s own background-retry backoff), reset on any successful
    drain or an explicit `syncNow()`.
  - **States**: `synced | pending | syncing | retrying | blocked | paused`.
    `blocked` is specifically an `unsupported_store`/`unsupported_version`
    `retry` -- head-of-line blocking by design, surfaced as "waiting on the
    server" rather than a user-fixable error.
- **`SyncProvider.tsx`** -- wires the engine to triggers 1-4 inside
  `LocalDataProvider`, below `AuthProvider` (see `App.tsx`). Trigger 1 (after a
  local commit) watches `LocalDataProvider`'s own post-commit
  `snapshot.pendingOutbox.length` growing, rather than hooking `commitAction`
  directly, so a commit never awaits the network. The engine itself is built
  inside a `useEffect`, not `useState`'s lazy initializer -- see "Decisions I
  made" below.
- **`SyncStatus.tsx`** -- the strip (`role="status"`, reuses `.storage-notice`/
  `.storage-warning`) and `SyncRejectionBanner` (`role="alert"`, reuses
  `.storage-error`), following the existing `LocalDataStatus`/
  `AppUpdateBanner` markup and `styles.css` conventions exactly (no new CSS).

## Decisions I made (the brief left them open; flagged as instructed)

1. **Which fields a server-side closure covers, for a record with a pending
   mutation.** docs/data-sync.md says only "a record with a pending outbox
   mutation is left alone apart from a server closure it must not lose" --
   without naming exactly which fields that is. I read "closure" as: a
   tombstone (`deleted_at`), a session's terminal `status`/`completed_at`
   (`ACTIVE` -> `COMPLETED`/`DISCARDED`), and a bout/pause/rest's `ended_at`
   when its own record is still open locally. This is the minimal set that
   keeps `active_markers` correct (the concern the same paragraph names
   explicitly) without touching any field the pending mutation itself might
   still be about to write. Implemented in `applyServerClosureOnly` in
   `storage/repository.ts`.
2. **Engine construction inside `SyncProvider`.** The natural React idiom --
   build the engine once via `useState(() => createSyncEngine(...))`, closing
   over a `useRef` for the live gate value -- is rejected by
   `eslint-plugin-react-hooks`'s newer `react-hooks/refs` rule: reading (or
   even just passing a closure that *could* read) a ref during render is
   flagged, because `useState`'s lazy initializer still runs during render.
   The fix was to build the engine inside a `useEffect` instead (the same
   split `AppUpdateBanner` already uses between `liveWorkRef` and
   `setReloadGuard`), accepting one extra render tick where `engine` is `null`
   and every trigger effect no-ops.
3. **`RecoverySnapshot.pendingOutbox` also excludes rejected entries.** The
   brief's instruction was scoped to `listPendingOutbox()`; `readSnapshot()`
   builds its own `pendingOutbox` field with a separate raw query. I applied
   the same filter there for consistency -- "pending" should mean the same
   thing everywhere in the local contract, and `HomePage`'s "N saved changes
   waiting to sync" reads directly from this field, so leaving rejected
   entries in it would make that count wrong in exactly the way this issue
   exists to fix. See "Tests" for the one existing test this changed.

## Tests

`frontend/src/storage/repository.test.ts` (new `describe` block, real
`createLocalRepository` + `fake-indexeddb`): `getClientId` creation/idempotency
and agreement with `commitAction`'s own bootstrap; `markOutboxRejected`
excludes an entry from `listPendingOutbox`/`readSnapshot` without deleting it,
is a no-op once acknowledged, and (with `listRejectedOutbox`) survives
close/reopen; `applyServerRecords` creating a record from nothing, merging
into an existing one while preserving a local-only field, leaving a
pending-mutation record's device-writable fields alone while still applying a
server closure, keeping `active_markers` consistent so a later local commit is
not falsely blocked, rejecting a non-integer/negative cursor, and persisting
the cursor durably across close/reopen.

`frontend/src/sync/protocol.test.ts`: `parsePushResponse`'s well-formed,
unrecognised-status, and malformed-body cases; `isBootstrapResponse`/
`isChangesResponse` accept/reject cases.

`frontend/src/sync/engine.test.ts` (real repository, mocked api functions --
this is what "a plain testable class/factory" buys): offline queue sent in
ascending sequence once the gate turns true (PAD-03 -> PAD-04); a lost
acknowledgement resent and acknowledged exactly once as `duplicate` (PAD-05);
overlapping triggers coalesced into one in-flight drain and one follow-up
(`maxConcurrent` never exceeds 1, `fetchBootstrap` called exactly twice for
four `trigger()` calls); a `retry` result stopping the batch and the next
attempt resuming from it; a `rejected` result keeping the data, marking
attention, not stopping the batch, and never being resent; a rejected
parent's dependent mutation rejected in turn without losing either record; a
`401` mid-drain pausing with nothing acknowledged, resumed by the next
attempt; bounded exponential backoff doubling to a cap and resetting on
success (deterministic via injectable `initialBackoffMs`/`maxBackoffMs` and a
dispose-then-trigger sequencing that never races a real or faked timer against
`fake-indexeddb`'s own scheduling -- see the file's own comment); a multi-page
pull applying a child before its parent and durably resuming an interrupted
page without skipping it (proven by both the exact `since` argument on retry
and a real close/reopen); a record with a pending mutation left un-clobbered
except its closure, alongside an unrelated record's local-only field being
preserved; bootstrap refresh replacing cached PAD defaults without touching a
pending mutation.

`frontend/src/App.test.tsx` (two new tests, real `fetch` stub extended to
answer bootstrap/changes/mutations): a pending mutation drains through the
whole React tree once authenticated and online, ending in "All changes
synced"; a server-rejected mutation shows the rejection banner with the
server's own `detail` while the domain record stays on the device.

**Existing test changed, as instructed when a test encodes changed
behaviour**: `App.test.tsx`'s "recovers a paused PAD session and pending
change" test asserted the literal string `"1 saved change waiting to sync.
Server sync is not available yet."` -- that claim is what this issue makes
false. The copy (`HomePage.tsx`) and the assertion both dropped the trailing
sentence; nothing else about the test changed.

Not verified here: anything on a real device (the acceptance-tests.md boxes
for PAD-04 device runs and `docs/device-smoke-tests.md` remain manual).

## Deliberately deferred

| Deferred | Where it belongs |
|---|---|
| Service-worker background sync (trigger 5) | Out of scope by owner decision 2; may never be built |
| Local containment clamping, PAD-06 local enforcement | issue #21 (separate worktree, concurrent with this issue) |
| A dedicated sync screen, manual conflict resolution UI | Not planned; owner decision 3 scopes the UI to a strip + banner |
| Consuming the cached `pad_defaults`/`pad_next_session_settings` reference-cache keys this issue writes | Whichever issue builds the PAD start screen's server-aware settings inheritance |
| Resistance/cardio/routine stores syncing | Their own issues; the engine already head-of-line-blocks on `unsupported_store` correctly today |

## Known limitations

- The Web Locks API path has no test coverage (jsdom does not implement it);
  the in-process promise-chain fallback is exercised instead, which is what a
  single-tab test can actually observe. Both paths share the same
  `withDeviceLock` call site.
- The rejection banner lists every rejected mutation's raw server `detail`
  text verbatim; there is no admin-side "release a rejection for
  re-application" affordance (matches issue #19's own known limitation --
  a corrected resend is a new `mutation_id`).
- `applyServerClosureOnly`'s exact field set (see "Decisions I made" #1) is my
  reading of an underspecified paragraph, not an owner-confirmed rule; it is
  narrow and additive (it can only ever apply a closure, never a broader
  field), so a future clarification should only need to widen it, not undo
  anything already applied.

## Review pass (commit `78ddbcb` reviewed, fixes applied as a follow-up commit)

A deep review of the initial implementation found four major defects, six
minor ones, and a set of hardening items; the test suite (319 green tests)
missed all four majors because the untested paths were exactly where they
lived. All were fixed except where noted below as disagreed-with.

**Majors:**

- **M1 (trigger 1 stops firing after the first drain).** `SyncProvider`'s
  trigger 1 inferred "new work" from `pendingOutbox.length` growing versus a
  remembered previous length, but nothing refreshes that remembered length
  when the sync engine's own (usually separate) repository connection
  acknowledges a mutation, so a second commit landing at the same length as
  the first read as "no growth" and never fired -- during a foregrounded PAD
  session, a whole session's mutations could sit queued indefinitely.
  **Fixed**: trigger 1 now compares the *set* of pending mutation ids against
  what this provider already accounted for, firing whenever the current set
  holds an id it has not seen pending before. A plain "count > 0" check was
  considered (an alternative the review explicitly allowed) but rejected
  during this fix once the "refresh after a pull" hardening item below was
  added: a persistently blocked mutation combined with every cycle's
  successful pull refreshing the snapshot would otherwise re-trigger on every
  refresh, an engine cycle triggering its own next cycle forever. The
  set-comparison does not have that failure mode. See
  `frontend/src/sync/SyncProvider.tsx` and its regression test in
  `frontend/src/sync/SyncProvider.test.tsx`.
- **M2 (the changes feed reverts local data behind a rejected mutation).**
  `applyServerRecords`'s `pendingTargets` set skipped outbox entries carrying
  a `rejection`, so a permanently-rejected mutation's record took the feed's
  full-replace merge on the next page -- silently reverting the user's edit
  (or, for a rejected "finish session", reinstalling the `ACTIVE` marker and
  making a finished session reappear as live) even though the "needs
  attention" banner claims the data is still on the device. **Fixed**:
  rejected entries are now included in `pendingTargets` exactly like pending
  ones, so the feed may only apply a server-side closure to their records,
  never a full replace. See `frontend/src/storage/repository.ts` and the two
  regression tests in `frontend/src/storage/repository.test.ts`.
- **M3 (a feed-installed ACTIVE session blocks a new local one).**
  Reviewed and found to be **working as designed**, not a defect: at most one
  `ACTIVE` session per type locally is the owner-settled rule (issue #13),
  the installed marker is also what surfaces the session as a Resume card
  (the intended escape), and a local supersede is explicitly out of scope. No
  code change. Added the two tests the review asked for (a feed-only session
  resolves as a Resume card from `readSnapshot()`; the feed *installing* a
  fresh marker, not only clearing a stale one) and documented the limitation
  as one paragraph in `docs/data-sync.md` next to "Stuck ACTIVE sessions".
- **M4 (backoff resets every cycle while a `retry` blocks the batch).**
  `runCycle` called `resetBackoff()` unconditionally before every pull,
  regardless of whether the drain actually cleared, so a blocked queue
  retried at a flat ~5s forever instead of climbing toward the cap.
  **Fixed**, in two passes: the first made the reset conditional on
  `drain.kind === "clear"`, which closed the partial-drain case but left a
  narrower sibling open -- an *empty* outbox (`drainOutbox` trivially returns
  `kind: "clear"` when nothing is queued) whose *pull* kept failing still
  reset the backoff every cycle before the pull ran, so a persistently
  failing pull never actually backed off either. The completing pass moved
  the reset to run only once the whole cycle succeeds -- `drain.kind ===
  "clear"` *and* `pull === "success"` -- by relocating it after the pull's
  own failure/paused checks, just before `lastSyncedAt` publishes. See
  `frontend/src/sync/engine.ts` and the two regression tests in
  `frontend/src/sync/engine.test.ts` (`"does not reset the backoff on a
  partial drain..."` and `"does not reset the backoff when the outbox is
  empty but the pull keeps failing..."`); both were verified to fail against
  their respective pre-fix code and pass after.

**Minors (M5-M9) and hardening**, all applied: `dispose()` now sets a
`disposed` flag checked at the top of `runCycle` and inside `scheduleRetry`
(M5); `pullChanges` bails out as a failure if a page claims `has_more` without
its cursor advancing (M6, scoped to `has_more` so a legitimate "nothing new"
page is unaffected); a malformed `max_mutations_per_request` from bootstrap is
clamped to `[1, DEFAULT_MAX_MUTATIONS_PER_REQUEST]` (M7); the jitter
comment now says +/-10%, matching the code and this doc (M8); the
`docs/data-sync.md` triggers and backoff wording were corrected (M9, above).
Hardening: a `413` halves `maxMutationsPerRequest` for the session before
backing off; `fallbackChain` moved to module scope so it serializes across
engines, not just within one; `trigger()`'s `startOrJoin()` call now has a
`.catch(() => undefined)`; `applyServerClosureOnly`'s intentional backwards
`updated_at` move is now commented; and `SyncProvider` now asks
`LocalDataProvider` to refresh its snapshot after a cycle completes a pull
(`refreshLiveData`, watching `lastSyncedAt`), since the two hold separate
repository connections to the same database in production and nothing else
would otherwise invalidate the React snapshot after `applyServerRecords`
closes a session behind the user's back.

**Test coverage added (M10):** `frontend/src/sync/SyncProvider.test.tsx` (new
-- triggers 1/3/4, and `SyncStatus`/`SyncRejectionBanner`'s blocked/rejected/
"Sync now" states); `frontend/src/sync/api.test.ts` (new -- `fetchChanges`'s
exact query string, including `since=0` and cursor advancement across pages);
`engine.test.ts`'s `"backs off exponentially..."` test now injects a fixed
`clock` instead of reading real `Date.now()` against a +/-500ms window, and
no longer uses `dispose()` mid-test to skip the real timer (which would now
be a permanent no-op post-M5) -- it waits out the real, small-scale timer
instead and asserts against the fixed clock, which is exact rather than
windowed.
