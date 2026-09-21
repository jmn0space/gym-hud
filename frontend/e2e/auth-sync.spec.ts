/**
 * Synchronization and authentication acceptance specs for issue #23: PAD-04,
 * PAD-05 and AUTH-01(a)/(b)/(c). See `docs/acceptance-tests.md` for the exact
 * wording each test proves and `docs/data-sync.md`'s "Server synchronization
 * protocol", "Client obligations", "Sync gate" and "Authentication and
 * offline continuation" sections for the contract behind it.
 *
 * These specs run against the mock server in `support/server.ts` and the real
 * built app through `support/fixtures.ts` -- see both files' own header
 * comments for exactly what is, and is not, faithfully reproduced (in
 * particular: this is desktop Chromium, not the target Android device; see
 * `docs/pad-pilot-validation.md` for why that distinction matters and what
 * still needs a real device run).
 */

import type { APIResponse } from "@playwright/test";

import { expect, test } from "./support/fixtures";
import { signIn, startWalkingBout } from "./support/fixtures";
import { DEFAULT_PASSWORD, DEFAULT_USERNAME } from "./support/server";

/**
 * Identifies which PAD action produced one mutation, from the mutation's own
 * `changes` array -- precise enough to distinguish "finish bout" from "start
 * next bout" even though both touch the same three stores (the repository's
 * `orderChanges`, `frontend/src/storage/repository.ts`, always sorts a
 * mutation's changes parents-first -- sessions, then bouts, then pauses/rests
 * -- regardless of which one the action builder is actually opening or
 * closing, so the store list alone is not quite enough on its own).
 * `ended_at: null` means "just opened," a timestamp means "just closed";
 * fields with no `ended_at` at all (a plain session workflow bump) contribute
 * just their store name.
 */
function changeDescriptor(change: { store: string; record: Record<string, unknown> }): string {
  const endedAt = change.record.ended_at;
  if (endedAt === undefined) {
    return change.store;
  }
  return `${change.store}:${endedAt === null ? "open" : "closed"}`;
}

function mutationSignature(mutation: { changes: readonly { store: string; record: Record<string, unknown> }[] }): string {
  return mutation.changes.map(changeDescriptor).join(",");
}

/**
 * Pulls the `csrftoken` cookie value out of a response's own `Set-Cookie`
 * headers (there may be several, for different cookies) -- not out of the
 * request context's cookie jar, so this works identically whether or not the
 * jar already had a stale token to replace.
 */
function readCsrfCookie(response: APIResponse): string | undefined {
  for (const header of response.headersArray()) {
    if (header.name.toLowerCase() !== "set-cookie") {
      continue;
    }
    const match = /^csrftoken=([^;]*)/.exec(header.value);
    const value = match?.[1];
    if (value !== undefined) {
      return decodeURIComponent(value);
    }
  }
  return undefined;
}

test(
  "PAD-04 — reconnection drains the whole offline queue with no manual re-entry, in order, one applied server record per logical action",
  async ({ app, server }) => {
    await signIn(app);

    // A genuine network cut (see `support/fixtures.ts`'s own header comment
    // on `app`), not a mocked fetch failure -- this is what actually
    // exercises the worker/engine's offline path rather than merely
    // asserting on code that never ran.
    await app.context().setOffline(true);

    // Six distinct logical PAD actions -- every one the UI allows while
    // offline short of ending the session -- each committed as exactly one
    // `LocalAction` (see `frontend/src/pad/actions.ts`'s own header comment:
    // "one logical operation is always exactly one LocalAction"), so each
    // produces exactly one outbox mutation. That 1:1 mapping is what "one
    // server record per logical action" below actually checks.
    await startWalkingBout(app); // #1 start session, #2 start bout 1
    await app.getByRole("button", { name: "Pause" }).click(); // #3
    // Anchored, not a plain substring: the sync-status strip mounted
    // alongside the HUD (`AppLayout`) can simultaneously read "Sync paused —
    // offline" while this device is offline, and a case-insensitive
    // substring match on "Paused" would then match *both* elements and blow
    // up `toBeVisible()`'s strict-mode requirement. The HUD's own state line
    // always starts with the state name, so anchoring to the start of the
    // element's text is enough to pick it out uniquely.
    await expect(app.getByRole("status").filter({ hasText: /^Paused/ })).toBeVisible();
    await app.getByRole("button", { name: "Resume" }).click(); // #4
    await expect(app.getByRole("status").filter({ hasText: /^Walking/ })).toBeVisible();
    // Finishing a bout opens its rest atomically, in the same mutation
    // (`finishWalkingBoutAction`'s own changes array) -- there is no separate
    // UI control for "open a rest."
    await app.getByRole("button", { name: "Finish bout" }).click(); // #5
    await expect(app.getByRole("status").filter({ hasText: /^Resting/ })).toBeVisible();
    // Symmetrically, starting the next bout closes the rest atomically.
    await app.getByRole("button", { name: "Start next bout" }).click(); // #6
    await expect(app.getByRole("status").filter({ hasText: /^Walking/ })).toBeVisible();

    // PAD-03's own guarantee (owned by the concurrent pad-offline.spec.ts),
    // checked here only as PAD-04's precondition: nothing reaches the server
    // while offline.
    expect(server.appliedMutations()).toHaveLength(0);
    expect(server.pushRequests()).toHaveLength(0);

    await app.context().setOffline(false);

    // Trigger 4 (docs/data-sync.md, "Synchronization triggers") fires on the
    // browser's own `online` event -- no manual re-entry, no "Sync now"
    // click. Polled against the server's own ledger, not a fixed sleep: the
    // engine's cycle, plus the mock server's own near-instant response, is
    // comfortably inside this window, but is not something to hard-code a
    // delay for.
    await expect.poll(() => server.appliedMutations().length, { timeout: 15_000 }).toBe(6);

    const applied = server.appliedMutations();

    // Ascending sequence, verbatim -- exactly how `drainOutbox` sorts and
    // sends them (frontend/src/sync/engine.ts) -- and no two mutations
    // sharing one.
    const sequences = applied.map((mutation) => mutation.body.sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));
    expect(new Set(sequences).size).toBe(6);

    // Per-mutation identity, in the exact order the UI above performed them
    // -- a precise check, not "more than zero." #5 and #6 both touch
    // sessions/bouts/rests, in the same parent-first order, so it is the
    // open/closed detail on each that actually tells "finish bout 1" apart
    // from "start bout 2."
    expect(applied.map((mutation) => mutationSignature(mutation.body))).toEqual([
      "walking_sessions", // #1 start session
      "walking_sessions,walking_bouts:open", // #2 start bout 1
      "walking_sessions,walking_pauses:open", // #3 pause
      "walking_sessions,walking_pauses:closed", // #4 resume
      "walking_sessions,walking_bouts:closed,walking_rests:open", // #5 finish bout 1 (+ open rest)
      "walking_sessions,walking_bouts:open,walking_rests:closed", // #6 start bout 2 (+ close rest)
    ]);

    // Exactly one applied server record per logical action: six distinct
    // mutation_ids, every one applied, none of them a resend yet (PAD-05,
    // below, exercises the duplicate-delivery path on its own).
    expect(new Set(applied.map((mutation) => mutation.mutationId)).size).toBe(6);
    expect(server.pushRequests().flatMap((request) => request.body.mutations)).toHaveLength(6);

    // The pending outbox ends empty -- read through the UI's own sync-status
    // strip (`SyncStatus`, mounted on every screen via `AppLayout`) rather
    // than reaching into IndexedDB: it already surfaces exactly this state
    // ("All changes synced" once `pendingCount` is 0), which is the more
    // honest thing for an acceptance spec to assert on than a storage
    // implementation detail.
    await expect(app.getByRole("status").filter({ hasText: "All changes synced" })).toBeVisible();
  },
);

test(
  "PAD-05 — a mutation delivered twice because its first acknowledgement was lost is applied exactly once",
  async ({ app, server }) => {
    await signIn(app);

    // Intercept *before* the mutation is even queued, so the very first push
    // this test produces is guaranteed to be the one that gets swallowed --
    // not a race against the engine's own post-commit trigger.
    let interceptedFirstPush = false;
    await app.route("**/api/v1/sync/mutations/", async (route) => {
      if (interceptedFirstPush) {
        // The resend, and anything after it, goes through untouched.
        await route.continue();
        return;
      }
      interceptedFirstPush = true;
      // `route.fetch()` lets the request actually reach the mock server --
      // it genuinely applies the mutation and records it in the ledger --
      // and then `route.abort()` throws the response away before it gets
      // back to the page. This is deliberately indistinguishable, from the
      // client's point of view, from a real lost acknowledgement (a dropped
      // radio mid-response, a proxy timeout): `apiFetch`'s own `fetch()`
      // call rejects exactly the way it would for a genuine network error,
      // and the resend that follows goes through the engine's own retry
      // path (`drainOutbox`'s `network-failure` branch,
      // `frontend/src/sync/engine.ts`) rather than a hand-crafted second
      // request.
      await route.fetch();
      await route.abort("failed");
    });

    // Exactly one queued mutation, so "the same mutation twice" below is
    // unambiguous: starting the session, without also starting a bout, is
    // the smallest offline-capable action available.
    await app.getByRole("link", { name: "PAD walking" }).click();
    await expect(app.getByRole("heading", { level: 1, name: "PAD walking" })).toBeVisible();
    await app.getByRole("button", { name: "Start" }).click();
    await expect(app.getByRole("button", { name: "Start walking" })).toBeVisible();

    // The first push attempt lands on the intercepted route above: the
    // server sees it and applies it, but the client never gets to hear that.
    await expect.poll(() => server.pushRequests().length, { timeout: 10_000 }).toBe(1);
    expect(server.appliedMutations()).toHaveLength(1);

    // From the client's own point of view this is an ordinary network
    // failure: the mutation stays queued, unacknowledged, and a retry is
    // scheduled with backoff (docs/data-sync.md, "Client obligations") --
    // surfaced here as the sync strip's manual-retry affordance.
    await expect(app.getByRole("button", { name: "Sync now" })).toBeVisible();

    // Force the resend right now, through the engine's own manual retry
    // (`syncNow`) instead of waiting out the real ~5s backoff timer -- same
    // code path, just not timer-gated, and still entirely the client's own
    // retry mechanism rather than a second request this test assembles by
    // hand.
    await app.getByRole("button", { name: "Sync now" }).click();
    await expect(app.getByRole("status").filter({ hasText: "All changes synced" })).toBeVisible();

    // The resend really happened...
    const pushed = server.pushRequests();
    expect(pushed).toHaveLength(2);
    const deliveredMutationIds = new Set(pushed.flatMap((request) => request.body.mutations.map((m) => m.mutation_id)));
    expect(deliveredMutationIds.size).toBe(1); // ...it was genuinely the same mutation both times...

    // ...but only one logical server-side event exists: the ledger applied
    // it once (on the delivery the client never saw), and the resend came
    // back `duplicate` -- exactly PAD-05's expected outcome.
    expect(server.appliedMutations()).toHaveLength(1);
  },
);

test(
  "AUTH-01(a) — unauthenticated access and CSRF failure are independent checks, neither substituting for the other",
  async ({ request, server }) => {
    const mutationsUrl = `${server.origin}/api/v1/sync/mutations/`;
    const validEnvelope = { client_id: "11111111-1111-1111-1111-111111111111", mutations: [] };

    // No session at all, and no CSRF token either: the mock's
    // `guardProtectedEndpoint` (mirroring `SessionAuthentication`/
    // `enforce_csrf`'s own ordering in the real `backend/core/
    // authentication.py`) checks authentication *before* it ever looks at
    // CSRF, so the answer is `not_authenticated`, not `csrf_failed` -- the
    // absence of a valid session is decided on its own, not because CSRF
    // also happened to be missing.
    const unauthenticated = await request.post(mutationsUrl, { data: validEnvelope });
    expect(unauthenticated.status()).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({ code: "not_authenticated" });

    // Now the other direction: a genuinely valid session must not substitute
    // for a valid CSRF token. Prime the CSRF cookie, sign in with it (login
    // itself is CSRF-protected too, unconditionally, even before any session
    // exists), then attempt the protected endpoint again -- this time with a
    // real, currently-valid session, but a deliberately wrong CSRF header.
    const sessionResponse = await request.get(`${server.origin}/api/v1/auth/session/`);
    const csrfToken = readCsrfCookie(sessionResponse);
    expect(csrfToken).toBeDefined();

    const loginResponse = await request.post(`${server.origin}/api/v1/auth/login/`, {
      headers: { "X-CSRFToken": csrfToken ?? "" },
      data: { username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD },
    });
    expect(loginResponse.status()).toBe(200);

    const csrfFailureWhileAuthenticated = await request.post(mutationsUrl, {
      headers: { "X-CSRFToken": "not-the-real-token" },
      data: validEnvelope,
    });
    expect(csrfFailureWhileAuthenticated.status()).toBe(403);
    expect(await csrfFailureWhileAuthenticated.json()).toMatchObject({ code: "csrf_failed" });
  },
);

test(
  "AUTH-01(b) — a device that has never signed in shows only the login screen and fetches no workout data",
  async ({ app, server }) => {
    // The gate the sync engine consults (`frontend/src/auth/syncGate.ts`) is
    // checked *before* any network call is made, not merely to fail one
    // (`runCycle`'s very first line in `frontend/src/sync/engine.ts`) -- so
    // while `authStatus` never leaves "login-required" on this fresh device,
    // bootstrap/changes/mutations should never be attempted at all. Recorded
    // directly, not inferred from silence.
    const syncCalls: string[] = [];
    await app.route("**/api/v1/sync/**", async (route) => {
      syncCalls.push(route.request().url());
      await route.continue();
    });

    // AuthGate withholds every app route while status is "login-required":
    // only the sign-in form renders, with no bottom navigation and no PAD
    // link to reach local data through even if there were any.
    await expect(app.getByLabel("Username")).toBeVisible();
    await expect(app.getByLabel("Password")).toBeVisible();
    await expect(app.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expect(app.getByRole("navigation", { name: "Primary" })).toHaveCount(0);
    await expect(app.getByRole("link", { name: "PAD walking" })).toHaveCount(0);

    expect(syncCalls).toHaveLength(0);
    expect(server.pushRequests()).toHaveLength(0);
    expect(server.appliedMutations()).toHaveLength(0);
  },
);

test(
  "AUTH-01(c) — session expiry during a pending offline workout keeps local data and the outbox untouched, and drains once with no duplicates after re-authenticating",
  async ({ app, server }) => {
    test.setTimeout(45_000);

    await signIn(app);

    await app.context().setOffline(true);
    await startWalkingBout(app); // queues 2 mutations: start session, start bout.
    await app.getByRole("button", { name: "Pause" }).click(); // a 3rd.
    // Anchored (see PAD-04's own comment on this exact trap): the
    // sync-status strip can simultaneously read "Sync paused — ..." while
    // offline, which a plain case-insensitive "Paused" substring would also
    // match.
    await expect(app.getByRole("status").filter({ hasText: /^Paused/ })).toBeVisible();

    // Still offline: nothing has reached the server yet, so there is nothing
    // for the server-side session invalidation below to have touched.
    expect(server.appliedMutations()).toHaveLength(0);

    // Invalidate the session server-side *while still offline* -- the device
    // has no way to know yet; only a request that actually reaches the
    // server can tell it (docs/data-sync.md, "Authentication and offline
    // continuation": a 401 is the decisive signal, nothing else is).
    server.expireSession();

    await app.context().setOffline(false);

    // Trigger 4 fires on the browser's own `online` event, the drain attempt
    // hits the now-expired session, and the resulting 401 -- not the offline
    // gap itself -- is what flips authStatus to "expired" through
    // `apiFetch`'s central 401 handling (frontend/src/api/client.ts).
    const expiredBanner = app.getByRole("status").filter({ hasText: "Session expired" });
    await expect(expiredBanner).toBeVisible();

    // The exact documented guarantee for this case (docs/data-sync.md's
    // lifecycle table, "Server-session expiry" row): "Local data and outbox
    // preserved; app stays usable." Checked on both halves, without ever
    // navigating away from the PAD screen the workout was queued on:
    //
    // (1) the app stays usable. AuthGate only withholds app routes for
    // "checking"/"login-required"/"server-unreachable" -- "expired" is none
    // of those -- so PadPage never unmounts, and the paused bout is still
    // showing from the same live React state, not merely recoverable from
    // storage on a fresh load.
    await expect(app.getByRole("heading", { level: 1, name: "PAD walking" })).toBeVisible();
    await expect(app.getByRole("status").filter({ hasText: /^Paused/ })).toBeVisible();

    // (2) the outbox itself was never touched. Nothing was ever applied on
    // the server -- the 401 happened before the mock even records a push
    // attempt (`guardProtectedEndpoint` in `support/server.ts` answers 401
    // before `pushLog` is written to) -- and the sync strip reports the real
    // reason synchronization is paused rather than claiming anything synced.
    expect(server.appliedMutations()).toHaveLength(0);
    expect(server.pushRequests()).toHaveLength(0);
    await expect(app.getByRole("status").filter({ hasText: "Sync paused — signed out" })).toBeVisible();

    // Re-authenticate through the banner's own inline form -- the "expired"
    // recovery path, not a sign-out/sign-in round trip.
    server.restoreSession();
    await expiredBanner.getByRole("button", { name: "Sign in" }).click();
    await expiredBanner.getByLabel("Username").fill(DEFAULT_USERNAME);
    await expiredBanner.getByLabel("Password").fill(DEFAULT_PASSWORD);
    await expiredBanner.getByRole("button", { name: "Sign in" }).click();
    await expect(expiredBanner).toBeHidden();

    // The whole queue drains with no manual re-entry -- the three actions
    // above are never redone -- in ascending sequence, exactly PAD-04's own
    // guarantee, now proven to survive an expiry episode sitting in the
    // middle of it.
    await expect.poll(() => server.appliedMutations().length, { timeout: 15_000 }).toBe(3);
    const applied = server.appliedMutations();
    const sequences = applied.map((mutation) => mutation.body.sequence);
    expect(sequences).toEqual([...sequences].sort((left, right) => left - right));

    // No duplicate server records: three mutations queued through the whole
    // episode, three distinct mutation_ids applied, no more.
    expect(new Set(applied.map((mutation) => mutation.mutationId)).size).toBe(3);
    await expect(app.getByRole("status").filter({ hasText: "All changes synced" })).toBeVisible();
  },
);
