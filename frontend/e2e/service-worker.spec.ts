/**
 * Service-worker update and offline-shell specs for issue #23. These two
 * together are the "service-worker update while a session is active" half of
 * issue #23's acceptance criterion 4 (the other half, session
 * expiry/re-authentication with pending offline data, is
 * `auth-sync.spec.ts`'s AUTH-01(c)) plus the offline-continuation ("unverified")
 * state described in `docs/data-sync.md`'s "Authentication and offline
 * continuation" section.
 *
 * The update mechanics under test live in `frontend/src/pwa/registerServiceWorker.ts`
 * (the waiting-worker/`applyUpdate`/reload-guard store) and
 * `frontend/src/components/AppUpdateBanner.tsx` (the UI, and the actual safety
 * gate: `isSafeToApply`/`hasLiveWork`, `frontend/src/pwa/updateSafety.ts`).
 */

import { expect, test } from "./support/fixtures";
import { coldReopen, readShellCacheName, signIn, startWalkingBout } from "./support/fixtures";

test(
  "a service-worker update staged while a bout is active is deferred, never reloading over live work, and applies once the session is finished (issue #23 criterion 4)",
  async ({ app, server }) => {
    // Staging the build, finishing a whole session, and a real page reload
    // comfortably exceed the config's default 30s in a loaded CI sandbox.
    test.setTimeout(60_000);

    await signIn(app);
    await startWalkingBout(app); // ACTIVE session, WALKING bout -- the "live work" the banner must protect.

    // Let the two mutations already queued (start session, start bout) reach
    // the server before staging the update: the later "apply" step needs the
    // outbox to end up empty, and this keeps that step down to exactly the
    // finish-bout/finish-session mutations, rather than racing this drain too.
    await expect.poll(() => server.appliedMutations().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

    // A byte-different `/sw.js` is now being served -- see `stageNewBuild`'s
    // own header comment in `support/server.ts` for exactly what this does
    // and does not reproduce about a real deploy.
    server.stageNewBuild();

    // Nothing in this app polls for an update on its own (no interval, no
    // `registration.update()` call anywhere in `src/pwa`) -- production
    // relies entirely on the browser's own Update algorithm, which runs on
    // every navigation and periodically in the background. Calling
    // `update()` directly here triggers that exact same algorithm on demand,
    // rather than waiting on a navigation this test has no reason to make or
    // a real clock's worth of background polling.
    await app.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await registration.update();
    });

    // `AppUpdateBanner`'s own two messages, distinguished by content since
    // `role="status"` never takes its accessible name from text (the same
    // trap `startWalkingBout` already documents for the HUD's state line).
    const readyBanner = app.getByRole("status").filter({ hasText: "A new version of Gym HUD is ready." });
    const deferredBanner = app
      .getByRole("status")
      .filter({ hasText: "Gym HUD will be ready to update as soon as your current session is finished" });

    await expect(readyBanner).toBeVisible();

    // Counts real navigations of the top-level frame from here on, so
    // "did not reload" below is a direct observation, not an inference from
    // "the heading is still there" (which a fast enough remount could also
    // satisfy).
    let navigationCount = 0;
    app.on("framenavigated", (frame) => {
      if (frame === app.mainFrame()) {
        navigationCount += 1;
      }
    });

    await app.getByRole("button", { name: "Update now" }).click();

    // Criterion 4's central guarantee, and `AppUpdateBanner`'s own promise
    // (`isSafeToApply`/`hasLiveWork`, `frontend/src/pwa/updateSafety.ts`): an
    // ACTIVE session -- WALKING here -- always counts as live work, so
    // "Update now" defers instead of reloading. `requestUpdate` checks safety
    // *before* ever calling `applyUpdate()`, so `SKIP_WAITING` is never even
    // sent while this is true -- proven below by the banner switching to the
    // deferred message and by zero navigations, not merely by the PAD screen
    // still looking the same.
    await expect(deferredBanner).toBeVisible();
    await expect(app.getByRole("heading", { level: 1, name: "PAD walking" })).toBeVisible();
    // Anchored, not a plain substring (see auth-sync.spec.ts's PAD-04 comment
    // on the same trap): nothing else on this screen currently reads
    // "walking," but anchoring costs nothing and keeps this consistent with
    // every other HUD-state check in this suite.
    await expect(app.getByRole("status").filter({ hasText: /^Walking/ })).toBeVisible();
    expect(navigationCount).toBe(0);

    // What this spec does NOT (and cannot honestly) prove: the *narrower*
    // race where `applyUpdate()` has already been sent and live work starts
    // in the gap before `controllerchange` fires -- `setReloadGuard`'s own
    // last-line-of-defence in `registerServiceWorker.ts`. Staging a build
    // that changes no precached asset bytes (only the worker's own version
    // string) activates in a handful of milliseconds, far too fast to race
    // deterministically from outside the page without a hook this harness
    // does not have. That narrower guard is covered at the unit level
    // instead (`AppUpdateBanner.test.tsx`, `registerServiceWorker.test.ts`).
    // This spec proves the outer gate that, in practice, is what actually
    // stops a reload here: safety is checked before `applyUpdate()` is ever
    // called, not only after.

    // Finish the bout and the whole session so no ACTIVE session remains --
    // the actual precondition for the deferred update to become safe.
    await app.getByRole("button", { name: "Finish bout" }).click();
    await expect(app.getByRole("button", { name: "Finish session" })).toBeVisible();
    await app.getByRole("button", { name: "Finish session" }).click();
    await expect(app.getByRole("button", { name: "Start", exact: true })).toBeVisible();

    // Applying still also needs the outbox empty (`hasLiveWork` treats a
    // nonzero pending outbox as live work too), so wait for the
    // finish-bout/finish-session mutations to actually drain.
    await expect(app.getByRole("status").filter({ hasText: "All changes synced" })).toBeVisible();

    // The record of the just-finished session, read from purely local data
    // (`PREVIOUS_WALKING_SESSION_KEY`, written by `PadPage.tsx`'s own
    // `finishSession` on commit) -- captured now so the reload below can be
    // checked against it verbatim.
    const lastSessionBeforeReload = await app.getByRole("region", { name: "Last session" }).textContent();
    expect(lastSessionBeforeReload).toContain("1 bout");

    // The deferred effect re-checks safety on its own once live work clears
    // and un-defers the banner without reloading anything (`AppUpdateBanner`'s
    // own comment: "Deliberately not applyUpdate(): ... the user may well
    // have moved on to something this gate cannot see") -- so a second,
    // explicit click is still required to actually apply it.
    await expect(readyBanner).toBeVisible();
    const cacheNameBeforeUpdate = await readShellCacheName(app);

    await app.getByRole("button", { name: "Update now" }).click();

    // This time nothing is live: `applyUpdate()` runs for real, the worker
    // takes over, and the registration's own `reload()` fires -- a genuine
    // navigation this test did not have to force by hand.
    await expect.poll(() => navigationCount, { timeout: 10_000 }).toBeGreaterThan(0);

    // Post-reload: the app comes back up (re-verifying the still-valid
    // session in the background) with the just-finished session's local
    // record intact, and under a *different* shell cache name -- the
    // concrete, buildwide evidence this really was a new build, not a no-op.
    await expect(app.getByRole("button", { name: "Start", exact: true })).toBeVisible();
    const lastSessionAfterReload = await app.getByRole("region", { name: "Last session" }).textContent();
    expect(lastSessionAfterReload).toBe(lastSessionBeforeReload);
    await expect(app.getByRole("status").filter({ hasText: "All changes synced" })).toBeVisible();

    await expect.poll(() => readShellCacheName(app)).not.toBeNull();
    const cacheNameAfterUpdate = await readShellCacheName(app);
    expect(cacheNameAfterUpdate).not.toBe(cacheNameBeforeUpdate);
  },
);

test(
  "offline cold reopen serves the precached shell and reaches the offline-continuation state, not the login screen",
  async ({ app }) => {
    await signIn(app);

    // Nothing else needs to happen online first: a device that has signed in
    // even once already has the auth marker this whole scenario depends on
    // (docs/data-sync.md, "Authentication and offline continuation").
    await app.context().setOffline(true);

    // `coldReopen` closes `app` and opens a fresh `Page` in the same browser
    // context -- same origin, IndexedDB and service-worker registration --
    // the closest a desktop browser gets to "the app was not running and is
    // opened again" (see the helper's own header comment on how this differs
    // from a real Android force-stop).
    const reopened = await coldReopen(app);

    // The shell rendered at all -- and specifically *this* app's shell, not
    // a browser-generated offline/network-error page, which would never
    // produce this heading -- proves the service worker answered the
    // navigation from its precache rather than the (cut) network.
    await expect(reopened.getByRole("heading", { level: 1, name: "Gym HUD" })).toBeVisible();

    // Reaches "unverified" (offline continuation), not "login-required": app
    // routes -- the bottom navigation, in particular -- render normally,
    // which AuthGate only ever does once a marker exists and app routes are
    // not being withheld. A decisive online/offline signal is not available
    // to distinguish "unverified" from "authenticated" by role queries alone,
    // but the sync strip's own offline-specific wording is: while
    // login-required/server-unreachable never render `SyncStatus` at all
    // (AuthGate withholds every app route first), so seeing this exact text
    // is only possible from inside the "unverified" (or "authenticated")
    // branch, and offline rules out the latter.
    await expect(reopened.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expect(reopened.getByRole("status").filter({ hasText: "Sync paused — offline" })).toBeVisible();

    // No error state: none of the app's own error/alert surfaces
    // (`StorageWarningBanner`, `LocalDataStatus`'s retryable-error banner,
    // `AccountMismatchBanner`) are showing.
    await expect(reopened.getByRole("alert")).toHaveCount(0);

    // Home itself renders its normal content from local data, offline, with
    // no active session (none was started in this spec) and nothing queued.
    await expect(reopened.getByRole("heading", { level: 2, name: "Resume" })).toBeVisible();
    await expect(reopened.getByText("No active session.")).toBeVisible();
    await expect(reopened.getByText("No saved changes waiting to sync.")).toBeVisible();
  },
);
