/**
 * Harness self-test (issue #23, part 1): proves the real-browser E2E foundation
 * actually works end to end, before any PAD-xx/AUTH-xx acceptance spec is built on
 * top of it. Not itself an acceptance test -- it carries no PAD-xx/AUTH-xx
 * identifier and asserts nothing about PAD business rules.
 *
 * What "works" means here: the built PWA is served and its service worker
 * activates with a real, versioned shell cache; signing in through the real login
 * form and starting a walking bout produce a mutation the mock server answers
 * `applied`; `context.setOffline(true)` genuinely cuts the network rather than
 * merely failing a mocked call; and `coldReopen` (close/reopen, same origin and
 * IndexedDB) brings back the Resume card for the session left running.
 */

import { expect, test } from "./support/fixtures";
import { coldReopen, readShellCacheName, signIn, startWalkingBout } from "./support/fixtures";

test("build served, sign-in, a bout syncs, offline works, and a cold reopen resumes", async ({
  app,
  server,
}, testInfo) => {
  // The worker actually precached a shell under this build's own cache name --
  // the "one identified build" issue #23 asks evidence to be tied to. Attached
  // to the report (not just asserted on) so a CI run's evidence record names
  // the exact build it exercised, alongside the commit SHA the `e2e` job logs.
  const cacheName = await readShellCacheName(app);
  expect(cacheName).toMatch(/^gym-hud-shell-/);
  await testInfo.attach("shell-cache-name", { body: cacheName ?? "" });

  await signIn(app);
  await startWalkingBout(app);

  // Trigger 1 of docs/data-sync.md's "Synchronization triggers": a local
  // mutation pushes immediately while online. Polled, not awaited on a fixed
  // delay, since the push happens on its own schedule inside SyncProvider.
  await expect
    .poll(() => server.appliedMutations().length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  // Not a precise count on purpose: `startWalkingBout` queues two mutations
  // (start session, start bout), and this poll can catch either one or both
  // already applied depending on drain timing -- exact-count and
  // exactly-once-delivery assertions are PAD-04's and PAD-05's job, not this
  // harness self-test's. All this needs to prove is that at least one push
  // genuinely reached the server and got applied.
  expect(server.pushRequests().length).toBeGreaterThan(0);

  // Genuinely offline: Playwright cuts the network at the browser-context level,
  // not by making a mocked fetch throw, so this exercises the worker's real
  // network-first-with-fallback navigation handling (`src/sw/runtime.ts`).
  await app.context().setOffline(true);
  await app.reload();
  await expect(app.getByRole("heading", { level: 1, name: "PAD walking" })).toBeVisible();
  await app.context().setOffline(false);

  await app.getByRole("link", { name: "Home" }).click();
  const reopened = await coldReopen(app);
  await expect(reopened.getByRole("link", { name: /^Resume/ })).toBeVisible();
});
