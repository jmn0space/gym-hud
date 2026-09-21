/**
 * PAD acceptance evidence (issue #23), offline half: PAD-03, PAD-06 and the RESTING
 * counterpart of PAD-02's cold-reopen coverage (`pad-walking.spec.ts` covers the
 * WALKING and PAUSED cases; see that file's own header for why none of this is
 * device evidence).
 *
 * `context.setOffline(true)` genuinely severs the network at the browser-context
 * level (unlike a mocked `fetch` rejection), so every assertion below that a step
 * "worked offline" is really exercising the service worker's real fetch handling
 * and the local-first repository -- not a stand-in for either.
 */

import { expect, test } from "./support/fixtures";
import { coldReopen, signIn, startWalkingBout } from "./support/fixtures";

test(
  "PAD-03 — offline session: bout, finish, pain, rest and next bout all work while offline",
  async ({ app, server }) => {
    // Sign in while still online: AUTH-01's offline-continuation case is what makes
    // acting offline afterwards legitimate at all, but authenticating itself is the
    // concurrent agent's AUTH-01 spec's concern, not this one's -- so this test signs
    // in first and only then goes offline, matching the acceptance wording's own
    // step order ("1. Disable connectivity" comes after a session already exists).
    await signIn(app);
    await app.context().setOffline(true);

    const startedAt = await startWalkingBout(app);
    expect(startedAt).toBeGreaterThan(0);

    await app.getByRole("button", { name: "Finish bout" }).click();
    const status = app.getByRole("status");
    await expect(status.filter({ hasText: "Resting" })).toBeVisible();

    // Pain is entered through the PainSelector's numbered toggle buttons inside a
    // `<fieldset>`/`<legend>` pair (frontend/src/pages/PadPage.tsx's `PainSelector`),
    // not a `<select>` -- the "Select a reason" dropdown nearby is the separate stop-
    // reason field, which PAD-03's own wording does not ask this test to set. The
    // fieldset's accessible name ("Pain for bout 1") comes from its `<legend>`.
    const painGroup = app.getByRole("group", { name: "Pain for bout 1" });
    await painGroup.getByRole("button", { name: "3", exact: true }).click();
    await painGroup.getByRole("button", { name: "4", exact: true }).click();
    // `selected.join("–")` (PadPage.tsx) uses an en dash, not a hyphen.
    await expect(app.locator(".pad-bout-record")).toContainText("Pain 3–4");

    // Still offline throughout: nothing above required, or attempted, a network
    // round trip. Confirmed on the server side, not just by absence of an error in
    // the UI.
    expect(server.pushRequests()).toHaveLength(0);
    expect(server.appliedMutations()).toHaveLength(0);

    await app.getByRole("button", { name: "Start next bout" }).click();
    await expect(status.filter({ hasText: "Walking" })).toBeVisible();
    await expect(app.locator(".pad-hud__bout")).toHaveText("Bout 2");

    // The whole sequence -- start, finish, pain, rest, next bout -- happened with
    // zero server interaction.
    expect(server.pushRequests()).toHaveLength(0);
    expect(server.appliedMutations()).toHaveLength(0);

    await app.context().setOffline(false); // Tidy up; not required for the assertions above.
  },
);

test(
  "PAD-06 — rest integrity: Start walking is not offered while RESTING, and Start next bout closes the rest and starts the next bout atomically",
  async ({ app, server }) => {
    // Run this one offline too: it strengthens the claim that the RESTING-state
    // restriction is a local UI/state-machine rule (frontend/src/pad/session.ts's
    // state derivation, and actions.ts's `requireState(view, "RESTING")` guard for
    // `startNextWalkingBoutAction`), not something only a reachable server enforces.
    // docs/acceptance-tests.md#pad-06 already has dedicated server-side coverage
    // (`test_pad06_a_bout_cannot_start_while_a_rest_is_open`); this spec is about
    // what the UI on this device offers and what it actually records, not about
    // re-proving the server's own rejection path.
    await signIn(app);
    await app.context().setOffline(true);

    await startWalkingBout(app);
    await app.getByRole("button", { name: "Finish bout" }).click();
    const status = app.getByRole("status");
    await expect(status.filter({ hasText: "Resting" })).toBeVisible();

    // The normal control to leave RESTING exists...
    const startNext = app.getByRole("button", { name: "Start next bout" });
    await expect(startNext).toBeVisible();
    // ...and nothing else offers a way to start walking outside it: `Start walking`
    // only ever renders in the READY state (PadPage.tsx's `WalkingHud`), so while
    // RESTING it must not exist in the DOM at all, not merely be hidden or disabled.
    await expect(app.getByRole("button", { name: "Start walking" })).toHaveCount(0);

    await startNext.click();

    // Atomic: the same tap both closes the rest and starts the next bout -- there is
    // no intermediate state where the rest is closed but no bout is open, and the
    // HUD lands directly on WALKING, bout 2.
    await expect(status.filter({ hasText: "Walking" })).toBeVisible();
    await expect(app.locator(".pad-hud__bout")).toHaveText("Bout 2");

    // Still offline: this local rule needed no server to enforce it, and nothing was
    // pushed while proving that.
    expect(server.pushRequests()).toHaveLength(0);
    expect(server.appliedMutations()).toHaveLength(0);
  },
);

test(
  "PAD-02 — application termination: Home reconstructs the RESTING state after a cold reopen while resting, and resuming offers Start next bout",
  async ({ app }) => {
    // The RESTING case of PAD-02's device checklist item ("Force-stop the installed
    // PWA/browser process, reopen it, and confirm Home shows Resume PAD Walking with
    // the correct ... RESTING state", docs/acceptance-tests.md) -- the WALKING and
    // PAUSED cases are covered in pad-walking.spec.ts. Filed under PAD-02 rather than
    // PAD-06 because it is PAD-02's cold-reopen/reconstruction claim being extended
    // to a third state, not a rest-integrity claim.
    await signIn(app);
    await startWalkingBout(app);
    await app.getByRole("button", { name: "Finish bout" }).click();
    await expect(app.getByRole("status").filter({ hasText: "Resting" })).toBeVisible();

    // Navigate to Home first: `coldReopen` reopens at whatever URL the page was
    // already on, not necessarily Home, and Home's Resume card is what this
    // assertion needs (exactly as the smoke spec does before its own `coldReopen`
    // call). This is a page close/reopen stand-in, not an Android force-stop -- see
    // `coldReopen`'s own doc comment in support/fixtures.ts and PAD-02's fuller
    // comment in pad-walking.spec.ts.
    await app.getByRole("link", { name: "Home" }).click();
    const reopened = await coldReopen(app);

    const card = reopened
      .getByRole("article")
      .filter({ has: reopened.getByRole("heading", { level: 3, name: "PAD Walking" }) });
    // `padStatus` (frontend/src/local/activeSessions.ts) reports RESTING as "Resting
    // after bout <n>", naming the finished bout rather than the not-yet-started one.
    await expect(card.locator(".resume-card__status")).toContainText("Resting after bout 1");

    await card.getByRole("link", { name: "Resume PAD Walking" }).click();
    await expect(reopened.getByRole("status").filter({ hasText: "Resting" })).toBeVisible();
    await expect(reopened.getByRole("button", { name: "Start next bout" })).toBeVisible();
    await expect(reopened.getByRole("button", { name: "Start walking" })).toHaveCount(0);
  },
);
