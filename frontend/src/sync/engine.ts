/**
 * The client sync engine (issue #20): drains the outbox and refreshes
 * reference data. Plain factory, no React -- `sync/SyncProvider.tsx` wires it
 * to triggers 1-4 and exposes it to the app shell. See docs/data-sync.md,
 * "Client obligations", "Sync gate" and "Conflict strategy" for the contract
 * this implements.
 */

import { ApiError } from "../api/client";
import type { LocalRepository, OutboxEntry, OutboxRejection, RejectedOutboxEntry } from "../storage";
import { SYNC_CURSOR_KEY } from "../storage";
import {
  DEFAULT_MAX_MUTATIONS_PER_REQUEST,
  type BootstrapResponse,
  type ChangesResponse,
  type MutationAck,
} from "./protocol";

/** Reference-cache keys `pullChanges` writes bootstrap data under (see
 * `LocalRepository.writeReferenceCache`). Not consumed by this issue's UI. */
export const PAD_DEFAULTS_CACHE_KEY = "pad_defaults";
export const PAD_NEXT_SESSION_SETTINGS_CACHE_KEY = "pad_next_session_settings";
export const SYNC_LIMITS_CACHE_KEY = "sync_limits";

/** Mirrors the auth provider's own background-retry backoff (see
 * `frontend/src/auth/AuthProvider.tsx`), so the two features feel consistent. */
const INITIAL_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
/** Bounded +/-10% jitter around the backoff delay, so a device that goes
 * offline alongside others does not retry in lockstep with them.
 * `jitterFactor` below is `1 + (random() - 0.5) * JITTER_RATIO`: `random()-0.5`
 * ranges over [-0.5, 0.5), so the factor ranges over [1 - JITTER_RATIO/2, 1 +
 * JITTER_RATIO/2) -- i.e. this constant is the *full width* of the jitter
 * band, not the +/- amount. Matches docs/data-sync.md's "+/-10%". */
const JITTER_RATIO = 0.2;

const LOCK_NAME = "gym-hud-sync";

// Module scope, not per-engine: when `navigator.locks` is unavailable (jsdom,
// older browsers), this is the only thing serializing drains across *all*
// engines in one tab/worker, not just within one engine instance. A
// per-engine closure variable would let two engines interleave their
// repository access whenever the Web Locks API path isn't exercised -- which
// is the entire jsdom test suite -- making the "single drainer" guarantee
// weaker there than the real browser gives it.
let fallbackChain: Promise<void> = Promise.resolve();

export type SyncEngineState = "synced" | "pending" | "syncing" | "retrying" | "blocked" | "paused";

export interface SyncEngineSnapshot {
  state: SyncEngineState;
  pendingCount: number;
  rejectedCount: number;
  /** The rejected entries themselves, for the needs-attention banner. */
  rejections: readonly RejectedOutboxEntry[];
  lastSyncedAt: string | null;
  /** ISO timestamp of the next scheduled automatic retry, or null when none is scheduled. */
  nextRetryAt: string | null;
}

/**
 * Property (not method-shorthand) signatures throughout: the factory below
 * returns plain closures with no `this`, and property typing (unlike method
 * shorthand) keeps `@typescript-eslint/unbound-method` from flagging
 * `engine.subscribe`/`engine.getSnapshot` when `useSyncExternalStore` takes
 * them unbound (mirrors `ServiceWorkerUpdates` in `pwa/registerServiceWorker.ts`).
 */
export interface SyncEngine {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => SyncEngineSnapshot;
  /** Triggers 1-4 (docs/data-sync.md, "Synchronization triggers"). Fire-and-forget:
   * overlapping calls coalesce into at most one queued follow-up run. */
  trigger: () => void;
  /** The manual "Sync now" retry: resets backoff, then runs (or joins) a cycle. */
  syncNow: () => Promise<void>;
  /** Clears any scheduled retry timer. Idempotent; safe to call more than once. */
  dispose: () => void;
}

export interface SyncEngineDeps {
  repository: LocalRepository;
  pushMutations: (clientId: string, mutations: readonly OutboxEntry[]) => Promise<MutationAck[]>;
  fetchBootstrap: () => Promise<BootstrapResponse>;
  fetchChanges: (since: number, limit?: number) => Promise<ChangesResponse>;
  /** The sync gate (docs/data-sync.md, "Sync gate"): `canSync(authStatus, online)`,
   * read fresh on every check rather than captured once. */
  canSync: () => boolean;
  clock?: { now: () => number } | undefined;
  /** Injectable for deterministic backoff tests; defaults to `Math.random`. */
  random?: (() => number) | undefined;
  /**
   * Backoff bounds, injectable so a test can prove the doubling-and-cap shape
   * in real (short) wall-clock time instead of mixing fake timers with
   * fake-indexeddb's own internal scheduling. Default to the production
   * values (~5s initial, 5 minutes capped -- mirrors the auth provider's own
   * backoff).
   */
  initialBackoffMs?: number | undefined;
  maxBackoffMs?: number | undefined;
}

function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function validCursor(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

interface LocksLike {
  request: (name: string, callback: () => Promise<unknown>) => Promise<unknown>;
}

function resolveLocks(): LocksLike | undefined {
  const nav = (globalThis as { navigator?: Partial<Navigator> }).navigator;
  const locks = (nav as { locks?: LocksLike } | undefined)?.locks;
  return locks !== undefined && typeof locks.request === "function" ? locks : undefined;
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const { repository, pushMutations, fetchBootstrap, fetchChanges, canSync } = deps;
  const clock = deps.clock ?? { now: () => Date.now() };
  const random = deps.random ?? Math.random;
  const initialBackoffMs = deps.initialBackoffMs ?? INITIAL_BACKOFF_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? MAX_BACKOFF_MS;

  const listeners = new Set<() => void>();
  let snapshot: SyncEngineSnapshot = {
    state: "synced",
    pendingCount: 0,
    rejectedCount: 0,
    rejections: [],
    lastSyncedAt: null,
    nextRetryAt: null,
  };

  function publish(next: Partial<SyncEngineSnapshot>): void {
    snapshot = { ...snapshot, ...next };
    for (const listener of [...listeners]) {
      listener();
    }
  }

  // One drainer per device (docs/data-sync.md, "Client obligations"): a Web
  // Locks request when available, so a second tab or worker genuinely queues
  // behind this one; the module-scope `fallbackChain` promise chain otherwise
  // (jsdom, older browsers), which at least keeps every repository connection
  // in this tab single-flight, not just this one engine's.
  function withDeviceLock<T>(run: () => Promise<T>): Promise<T> {
    const locks = resolveLocks();
    if (locks !== undefined) {
      return locks.request(LOCK_NAME, run) as Promise<T>;
    }
    const next = fallbackChain.then(run, run);
    fallbackChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  let maxMutationsPerRequest = DEFAULT_MAX_MUTATIONS_PER_REQUEST;
  let backoffMs = initialBackoffMs;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  // Set once by `dispose()`. A cycle already in flight when `dispose()` runs
  // cannot be aborted mid-network-call, but checking this at the top of
  // `runCycle` stops it from starting another one, and checking it in
  // `scheduleRetry` stops it from arming a timer that would resurrect the
  // engine after the caller believed it was gone (a disposed `SyncProvider`
  // unmount, or a repository `closeAfterUnmount` has since closed).
  let disposed = false;

  function resetBackoff(): void {
    backoffMs = initialBackoffMs;
  }

  function clearScheduledRetry(): void {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer);
      retryTimer = undefined;
    }
    if (snapshot.nextRetryAt !== null) {
      publish({ nextRetryAt: null });
    }
  }

  function scheduleRetry(): void {
    if (disposed || retryTimer !== undefined) {
      return;
    }
    const base = backoffMs;
    backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    const jitterFactor = 1 + (random() - 0.5) * JITTER_RATIO;
    const delay = Math.max(0, Math.round(base * jitterFactor));
    publish({ nextRetryAt: nowIso(clock.now() + delay) });
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      trigger();
    }, delay);
  }

  async function refreshCounts(): Promise<{ pendingCount: number; rejectedCount: number; rejections: readonly RejectedOutboxEntry[] }> {
    try {
      const [pending, rejected] = await Promise.all([
        repository.listPendingOutbox(),
        repository.listRejectedOutbox(),
      ]);
      return { pendingCount: pending.length, rejectedCount: rejected.length, rejections: rejected };
    } catch {
      // A broken repository read must never crash the engine (see the fake
      // repository used by App.test.tsx's read-error scenario); fall back to
      // whatever was last known rather than inventing zero.
      return {
        pendingCount: snapshot.pendingCount,
        rejectedCount: snapshot.rejectedCount,
        rejections: snapshot.rejections,
      };
    }
  }

  async function publishCounts(overrideState?: "paused" | "blocked" | "retrying"): Promise<void> {
    const counts = await refreshCounts();
    const state: SyncEngineState = overrideState ?? (counts.pendingCount > 0 ? "pending" : "synced");
    publish({ ...counts, state });
  }

  interface DrainOutcome {
    kind: "clear" | "partial" | "auth-paused" | "network-failure";
    blockedByServer: boolean;
  }

  async function drainOutbox(): Promise<DrainOutcome> {
    let blockedByServer = false;
    for (;;) {
      if (!canSync()) {
        return { kind: "auth-paused", blockedByServer };
      }
      const pending = await repository.listPendingOutbox();
      if (pending.length === 0) {
        return { kind: "clear", blockedByServer };
      }
      // Ascending sequence, verbatim, batched to the server's own limit
      // (docs/data-sync.md, "Push request"): never send out of order, and
      // never skip ahead of an entry still queued.
      const batch = [...pending].sort((left, right) => left.sequence - right.sequence).slice(0, maxMutationsPerRequest);
      const clientId = await repository.getClientId();

      let results: MutationAck[];
      try {
        results = await pushMutations(clientId, batch);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          // apiFetch has already flipped auth to "expired"; simply stop and
          // stay paused, with nothing acknowledged (docs/data-sync.md,
          // "Client obligations").
          return { kind: "auth-paused", blockedByServer };
        }
        if (error instanceof ApiError && error.status === 413) {
          // The server's own `request_too_large` detail says to send fewer:
          // halve the batch size for the rest of this session (floor 1) so
          // the next attempt, after backing off below, has a real chance of
          // fitting -- otherwise this would resend the identical
          // too-large batch forever.
          maxMutationsPerRequest = Math.max(1, Math.floor(maxMutationsPerRequest / 2));
        }
        return { kind: "network-failure", blockedByServer };
      }

      const resultById = new Map(results.map((result) => [result.mutation_id, result]));
      let processedWholeBatch = true;
      for (const mutation of batch) {
        const result = resultById.get(mutation.mutation_id);
        if (result === undefined) {
          // Not listed: either the batch stopped at an earlier `retry` (the
          // server rule) or the response parser dropped a malformed entry.
          // Either way this mutation, and everything after it, stays queued.
          processedWholeBatch = false;
          break;
        }
        if (result.status === "applied" || result.status === "duplicate") {
          await repository.acknowledgeOutbox(mutation.mutation_id);
          continue;
        }
        if (result.status === "rejected") {
          const rejection: OutboxRejection = {
            code: result.code,
            detail: result.detail,
            rejectedAt: nowIso(clock.now()),
          };
          await repository.markOutboxRejected(mutation.mutation_id, rejection);
          // A rejection never stops the batch (docs/data-sync.md, "Batch rule").
          continue;
        }
        // "retry": stop here; this mutation and everything after it stay queued.
        if (result.code === "unsupported_store" || result.code === "unsupported_version") {
          blockedByServer = true;
        }
        processedWholeBatch = false;
        break;
      }

      if (!processedWholeBatch) {
        return { kind: "partial", blockedByServer };
      }
      // The whole batch was processed; loop in case more than one batch's
      // worth of mutations is pending.
    }
  }

  type PullOutcome = "success" | "failure" | "paused";

  async function pullChanges(): Promise<PullOutcome> {
    let bootstrap: BootstrapResponse;
    try {
      bootstrap = await fetchBootstrap();
    } catch {
      return "failure";
    }
    // Clamp what the server reports: `isSyncLimits` only checks
    // `Number.isFinite`, so a server bug returning 0, a negative, or a
    // fractional value must not be allowed to shrink the batch to nothing
    // (an empty batch is a 400 `invalid_request`, which maps to
    // `network-failure` -- the outbox would never drain again) or above the
    // client's own default ceiling.
    maxMutationsPerRequest = Math.max(
      1,
      Math.min(DEFAULT_MAX_MUTATIONS_PER_REQUEST, Math.floor(bootstrap.limits.max_mutations_per_request)),
    );
    try {
      await repository.writeReferenceCache(PAD_DEFAULTS_CACHE_KEY, {
        speed_kmh: bootstrap.pad.defaults.speed_kmh,
        incline_pct: bootstrap.pad.defaults.incline_pct,
        max_bout_seconds: bootstrap.pad.defaults.max_bout_seconds,
      });
      await repository.writeReferenceCache(PAD_NEXT_SESSION_SETTINGS_CACHE_KEY, {
        source: bootstrap.pad.next_session_settings.source,
        walking_session_id: bootstrap.pad.next_session_settings.walking_session_id,
        speed_kmh: bootstrap.pad.next_session_settings.speed_kmh,
        incline_pct: bootstrap.pad.next_session_settings.incline_pct,
        max_bout_seconds: bootstrap.pad.next_session_settings.max_bout_seconds,
      });
      await repository.writeReferenceCache(SYNC_LIMITS_CACHE_KEY, {
        max_mutations_per_request: bootstrap.limits.max_mutations_per_request,
        max_changes_per_mutation: bootstrap.limits.max_changes_per_mutation,
      });
    } catch {
      return "failure";
    }

    let since: number;
    try {
      since = validCursor(await repository.getSyncMetadata(SYNC_CURSOR_KEY));
    } catch {
      return "failure";
    }

    for (;;) {
      if (!canSync()) {
        return "paused";
      }
      let page: ChangesResponse;
      try {
        page = await fetchChanges(since);
      } catch {
        return "failure";
      }
      // A well-behaved server always advances the cursor whenever it claims
      // more pages remain (see docs/data-sync.md, "Pull: changes feed"), but
      // a malformed/buggy response that doesn't would otherwise spin this
      // loop forever (re-requesting the same page), holding the device lock
      // throughout. Guarded only for `has_more`: a legitimate "nothing new"
      // response (`cursor === since`, `has_more: false`) must still succeed.
      if (page.has_more && page.cursor <= since) {
        return "failure";
      }
      try {
        await repository.applyServerRecords(
          page.changes.map((entry) => ({ store: entry.store, entity_id: entry.entity_id, record: entry.record })),
          page.cursor,
        );
      } catch {
        return "failure";
      }
      // The cursor only advances once its page is durably applied (the write
      // above is one transaction with the cursor), so an interrupted pull
      // re-reads this page next time rather than skipping it.
      since = page.cursor;
      if (!page.has_more) {
        return "success";
      }
    }
  }

  async function runCycle(): Promise<void> {
    if (disposed) {
      return;
    }
    try {
      if (!canSync()) {
        clearScheduledRetry();
        await publishCounts("paused");
        return;
      }
      publish({ state: "syncing" });

      const drain = await drainOutbox();
      if (drain.kind === "auth-paused") {
        clearScheduledRetry();
        await publishCounts("paused");
        return;
      }
      if (drain.kind === "network-failure") {
        scheduleRetry();
        await publishCounts("retrying");
        return;
      }

      // Reached the server (the whole queue drained, or stopped partway on a
      // `rejected`/`retry` result -- either way the request itself
      // succeeded), so a pull is safe: drain before pull, and a record with a
      // still-pending mutation is protected inside `applyServerRecords`
      // (docs/data-sync.md, "Conflict strategy").
      clearScheduledRetry();

      const pull = await pullChanges();
      if (pull === "paused") {
        clearScheduledRetry();
        await publishCounts("paused");
        return;
      }
      if (pull === "failure") {
        scheduleRetry();
        await publishCounts("retrying");
        return;
      }

      // Backoff resets only when the *whole cycle* succeeded -- the drain
      // genuinely cleared (`kind === "clear"`, nothing left blocked) *and*
      // the pull that followed it succeeded -- never merely because this
      // particular attempt reached the server. Two failure modes share this
      // guard:
      //  - `drain.kind === "partial"` (a `retry` ack stopped the batch, or an
      //    unsupported_store/unsupported_version deferral): resetting here
      //    unconditionally made the delay always `initialBackoffMs` on the
      //    blocked path -- a push + a bootstrap + a changes request every
      //    ~5s indefinitely instead of climbing toward the cap (the
      //    original M4 finding).
      //  - An empty outbox with a *failing* pull: `drainOutbox` returns
      //    `kind: "clear"` trivially when there is nothing queued, so
      //    resetting backoff before attempting the pull (the position this
      //    used to run in) reset it on every cycle regardless of whether the
      //    pull itself was succeeding -- the same flat ~5s retry loop, just
      //    reached through the pull path instead of the drain path. Placing
      //    the reset after a successful pull, on the success path only,
      //    closes both at once (docs/data-sync.md, "reset by any successful
      //    drain").
      if (drain.kind === "clear") {
        resetBackoff();
      }
      publish({ lastSyncedAt: nowIso(clock.now()) });

      if (drain.kind === "partial") {
        // Something is still queued behind a retry/unsupported-store result:
        // surface it distinctly (docs/data-sync.md, "Unsupported stores and
        // versions" -- head-of-line blocking is by design, not a user-fixable
        // error) and keep retrying automatically either way.
        scheduleRetry();
        await publishCounts(drain.blockedByServer ? "blocked" : "retrying");
        return;
      }

      await publishCounts();
    } catch {
      // Never let an unexpected failure (a repository method that does not
      // exist, a thrown non-ApiError, ...) escape as an unhandled rejection;
      // treat it the same as a network-level failure and try again later.
      scheduleRetry();
      await publishCounts("retrying");
    }
  }

  let running = false;
  // Bumped by `startOrJoin` whenever a trigger arrives while a cycle is
  // already running, and compared (not read as a boolean) at the bottom of
  // `runLoop`'s own iteration: a plain boolean flag set to `false` then
  // checked after an `await` in the same function reads as statically
  // always-false to TypeScript's narrowing, which cannot see that a
  // *different* closure (`startOrJoin`, called from outside while this
  // `await` is in flight) is the one flipping it. A counter compared across
  // two genuinely distinct reads has no such literal type to narrow to.
  let followUpToken = 0;
  let runPromise: Promise<void> | null = null;

  async function runLoop(): Promise<void> {
    try {
      let seenToken = followUpToken;
      for (;;) {
        await withDeviceLock(runCycle);
        if (followUpToken === seenToken) {
          return;
        }
        // Coalesce: however many triggers arrived during that cycle, they
        // collapse into exactly one more pass, not one each.
        seenToken = followUpToken;
      }
    } finally {
      running = false;
      runPromise = null;
    }
  }

  function startOrJoin(): Promise<void> {
    if (running) {
      // Coalesce: at most one queued follow-up run, never a second concurrent
      // drain (docs/data-sync.md, "Client obligations").
      followUpToken += 1;
      return runPromise ?? Promise.resolve();
    }
    running = true;
    runPromise = runLoop();
    return runPromise;
  }

  function trigger(): void {
    // Fire-and-forget by design (callers are event handlers, not awaiters).
    // `startOrJoin` itself should never reject (`runCycle` catches
    // everything), but `withDeviceLock` calling straight into
    // `navigator.locks.request` means a browser that throws synchronously
    // there (rather than rejecting) could otherwise surface as an unhandled
    // rejection.
    void startOrJoin().catch(() => undefined);
  }

  async function syncNow(): Promise<void> {
    resetBackoff();
    clearScheduledRetry();
    await startOrJoin();
  }

  function dispose(): void {
    disposed = true;
    clearScheduledRetry();
  }

  // Seed the initial snapshot from whatever is already on disk, so the UI
  // does not have to wait for the first trigger to know there is (or is not)
  // anything pending.
  void publishCounts();

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    trigger,
    syncNow,
    dispose,
  };
}
