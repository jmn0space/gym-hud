/**
 * PAD acceptance evidence (issue #23), real-browser half: PAD-01, PAD-02, PAD-07 and
 * PAD-08, all against a live walking bout in a single active session (no offline
 * mechanics here -- that half is `pad-offline.spec.ts`).
 *
 * See `docs/acceptance-tests.md` for each ID's exact wording and
 * `docs/pad-pilot-validation.md` for the coverage matrix these test names feed. Per
 * that document's own honesty rule, nothing here is device evidence: it proves the
 * derivation and reconstruction logic on a real browser, not on the target Android
 * PWA (see `docs/device-smoke-tests.md` Parts B and C for the device procedures, and
 * `coldReopen`'s own doc comment in `support/fixtures.ts` for exactly how a page
 * close/reopen differs from an Android force-stop).
 */

import { expect, test } from "./support/fixtures";
import {
  coldReopen,
  parseFormattedDurationMs,
  parseTimerDatetimeMs,
  signIn,
  startWalkingBout,
  waitForServiceWorkerActive,
} from "./support/fixtures";

test(
  "PAD-01 — lock-screen recovery: displayed duration resyncs after a visibility/focus recovery signal, and ONLY via that resync path",
  async ({ page, server }) => {
    // Fake clock installed BEFORE navigation (per Playwright's own guidance:
    // https://playwright.dev/docs/clock), so `useNow`'s `setInterval` (frontend/
    // src/pad/useNow.ts) is fake from the moment React creates it -- never a real
    // OS timer. This is what makes the test able to fail for the defect PAD-01
    // exists to catch: with a real clock, Chromium's own background-tab timer
    // throttling still delivers at least one 1s tick during a few-second hide, and
    // that lone tick alone -- via `now = Date.now()` -- is already enough to land
    // inside a 2s tolerance, regardless of whether the `visibilitychange`/`focus`
    // listeners exist. This is deliberately a different technique from PAD-07's
    // real wall-clock wait (below): PAD-07 starts from an interval React already
    // created against the page's *real* timers before this test could install a
    // fake clock over it (`page.clock` cannot retrofit an already-running
    // interval) -- here, `page` (not the shared `app` fixture, which has already
    // navigated) is still blank when the clock is installed, so there is no such
    // race.
    await page.clock.install({ time: Date.now() });
    await page.goto(server.origin);
    await waitForServiceWorkerActive(page);

    await signIn(page);
    await startWalkingBout(page);
    const timer = page.locator("time.timer--large");
    await expect(timer).toBeVisible();

    // `install()` alone leaves the clock "live": `Date.now()` keeps advancing
    // with real wall-clock time (just offset by whatever `install`/`setSystemTime`
    // last set), so `useNow`'s interval would still tick on its own, on its
    // normal real-time cadence, exactly the confound this rewrite exists to
    // remove. `pauseAt()` is what actually freezes it: after this call, per
    // Playwright's own docs, "no timers are fired unless runFor()/
    // fastForward()/pauseAt()/resume() is called" -- so the interval genuinely
    // cannot tick again until this test explicitly says so, no matter how much
    // real time elapses around it.
    //
    // The `+ 50` margin (well under the 1s interval period, so it cannot itself
    // cross a tick boundary) exists because the clock is still live at the
    // instant this line's own `Date.now()` read happens: by the time the
    // `pauseAt` command actually reaches the page over CDP, live real time has
    // moved on a little, and `pauseAt` refuses to "fast-forward to the past".
    const pausedAtMs = (await page.evaluate(() => Date.now())) + 50;
    await page.clock.pauseAt(pausedAtMs);
    expect(parseTimerDatetimeMs(await timer.getAttribute("datetime"))).toBe(0);

    // Moves the (paused, non-live) fake `Date.now()` forward by 10s, before any
    // recovery signal fires. `setSystemTime` is the one clock method that is
    // explicitly documented to move time WITHOUT firing any due timer -- unlike
    // `fastForward`/`runFor`/`pauseAt` itself, which all fire due timers (at
    // least once) as part of advancing. Combined with the clock already being
    // paused above, this is what makes the 1s interval fire zero times across
    // the jump: the ONLY way `now` can end up correct afterwards is the
    // `visibilitychange`/`focus` resync path calling `Date.now()` itself.
    const ADVANCE_MS = 10_000;
    await page.clock.setSystemTime(pausedAtMs + ADVANCE_MS);

    // A genuine `document.visibilityState`/`window` focus transition (bringing a
    // second same-context page to the front, then this one back) was tried
    // first and does NOT work in this harness: verified directly (a page-level
    // event counter recorded zero `visibilitychange`/`focus`/`blur` deliveries
    // across a `blank.bringToFront()` / `page.bringToFront()` round trip) --
    // this headless multi-page setup never actually backgrounds the other
    // `Page`, so `document.visibilityState` stays `"visible"` throughout. That
    // also means the *previous* version of this test, which relied on exactly
    // that round trip to "genuinely background" the page, never exercised a
    // real visibility transition at all; it passed solely because the real
    // interval kept ticking during the real 4s wait, which is a second,
    // independent reason (beyond the one CRITICAL 2 identified) that it could
    // not have failed for the tick-accumulation defect. Dispatching the events
    // directly is the honest fix: it still runs the app's own real listener
    // functions (`document.addEventListener("visibilitychange", ...)` /
    // `window.addEventListener("focus", ...)` in `useNow.ts`), just triggered
    // synthetically instead of through a browser-level backgrounding this
    // environment cannot produce.
    await page.evaluate(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });

    // Deterministic, not a wall-clock race: the fake clock only ever holds exactly
    // `pausedAtMs + ADVANCE_MS` at this point, so the only slack needed is for
    // React to actually flush the resync -- a whole-second floor (up to 999ms) plus
    // a little margin for the event round trip.
    const TOLERANCE_MS = 1_100;
    await expect
      .poll(
        async () => Math.abs(parseTimerDatetimeMs(await timer.getAttribute("datetime")) - ADVANCE_MS),
        {
          timeout: 3_000,
          message: "displayed duration should resync to the fake clock's advanced time after the recovery signal",
        },
      )
      .toBeLessThanOrEqual(TOLERANCE_MS);
  },
);

test(
  "PAD-02 — application termination: Home reconstructs the WALKING state and elapsed duration after a cold reopen, and resuming shows the same in the PAD HUD",
  async ({ app }) => {
    await signIn(app);
    const startedAt = await startWalkingBout(app);

    // Deliberate short wait so the reconstructed elapsed duration is meaningfully
    // nonzero, not coincidentally close to a fresh start.
    await app.waitForTimeout(2_000);

    // `coldReopen` reopens at whatever URL the page was already on (see its own doc
    // comment in support/fixtures.ts) -- it is a page close/reopen, NOT an Android
    // force-stop, and it does not by itself navigate anywhere. Home's Resume card is
    // what this assertion needs, so navigate there first, exactly like the smoke
    // spec does before its own `coldReopen` call.
    await app.getByRole("link", { name: "Home" }).click();
    const reopened = await coldReopen(app);

    const resumeLink = reopened.getByRole("link", { name: "Resume PAD Walking" });
    await expect(resumeLink).toBeVisible();
    const card = reopened
      .getByRole("article")
      .filter({ has: reopened.getByRole("heading", { level: 3, name: "PAD Walking" }) });
    // `padStatus` (frontend/src/local/activeSessions.ts) names the bout as well as
    // the state, so the card alone says which bout it is resuming into.
    await expect(card.locator(".resume-card__status")).toContainText("Walking · Bout 1");

    const TOLERANCE_MS = 1_500; // whole-second floor (up to 999ms) plus script slack.
    const cardElapsedMs = parseTimerDatetimeMs(await card.locator("time").getAttribute("datetime"));
    expect(Math.abs(cardElapsedMs - (Date.now() - startedAt))).toBeLessThanOrEqual(TOLERANCE_MS);

    await resumeLink.click();
    await expect(reopened.getByRole("heading", { level: 1, name: "PAD walking" })).toBeVisible();
    await expect(reopened.getByRole("status").filter({ hasText: "Walking" })).toBeVisible();
    await expect(reopened.locator(".pad-hud__bout")).toHaveText("Bout 1");

    const hudElapsedMs = parseTimerDatetimeMs(
      await reopened.locator("time.timer--large").getAttribute("datetime"),
    );
    expect(Math.abs(hudElapsedMs - (Date.now() - startedAt))).toBeLessThanOrEqual(TOLERANCE_MS);
  },
);

test(
  "PAD-07 — maximum timer: the HUD alerts once the maximum bout is reached but does not auto-terminate the bout",
  async ({ app, server }) => {
    // Real wall-clock time has to pass up to the configured maximum; 30s is the
    // smallest value the "Maximum bout (minutes)" field's own `min="0.5"` allows
    // (frontend/src/pages/PadPage.tsx), so this test needs more than the config's
    // default 30s test timeout even with the smallest legal setting.
    test.setTimeout(75_000);

    await signIn(app);
    await app.getByRole("link", { name: "PAD walking" }).click();
    await expect(app.getByRole("heading", { level: 1, name: "PAD walking" })).toBeVisible();

    // A virtual/fast-forwarded clock was considered instead of a real 30s wait, but
    // rejected: `useNow`'s `setInterval` is created by React the moment the HUD
    // mounts, using the page's *real* `setInterval` reference. Playwright's
    // `page.clock` only fakes timers created *after* it is installed -- installing
    // it here would not retroactively convert this already-running interval, so it
    // would not actually move the HUD's ticking forward, only the fake time itself,
    // which is not the same claim. Accepting the real wait instead.
    await app.getByLabel("Maximum bout (minutes)").fill("0.5");
    await app.getByRole("button", { name: "Start" }).click();
    const startWalkingButton = app.getByRole("button", { name: "Start walking" });
    await expect(startWalkingButton).toBeVisible();
    await startWalkingButton.click();
    const status = app.getByRole("status");
    await expect(status.filter({ hasText: "Walking" })).toBeVisible();

    // `hasReachedMaximum` (frontend/src/pad/session.ts) drives a `· Maximum reached`
    // suffix appended to the same status line (`WalkingHud` in PadPage.tsx) rather
    // than a separate alert element -- this is a `toBeVisible` web-first assertion,
    // not a fixed sleep, so it resolves as soon as the HUD's next 1s tick crosses the
    // 30s threshold, with the 75s test timeout above as the only real wait bound.
    await expect(status.filter({ hasText: "Maximum reached" })).toBeVisible({ timeout: 60_000 });

    // The bout must still be the running bout: still WALKING, still offering Pause/
    // Finish (not auto-transitioned to RESTING), and nothing was pushed to
    // "finish" it server-side either -- the maximum is an alert, never an automatic
    // stop (docs/acceptance-tests.md#pad-07--maximum-timer).
    await expect(status.filter({ hasText: "Walking" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Pause" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Finish bout" })).toBeVisible();
    await expect(app.getByRole("button", { name: "Start next bout" })).toHaveCount(0);
    expect(
      server.appliedMutations().some((mutation) =>
        mutation.body.changes.some((change) => change.store === "walking_rests"),
      ),
    ).toBe(false);
  },
);

test("PAD-08 — pause: effective walking duration excludes the paused interval", async ({ app }) => {
  await signIn(app);
  const boutStartedAt = await startWalkingBout(app);
  const status = app.getByRole("status");

  // Three real intervals: walk, pause, walk again. Kept a few seconds each so the
  // "excludes the pause" signal (the gap between the raw total and the effective
  // total is roughly the pause's own length) is well clear of round-trip noise
  // from the commit queue (each Pause/Resume/Finish tap is its own local-first
  // action, committed through real IndexedDB -- see playwright.config.ts's own
  // comment on why that needs more slack than a typical DOM assertion).
  const WALK1_MS = 3_000;
  const PAUSE_MS = 3_000;
  const WALK2_MS = 2_000;
  // Tight on purpose: every interval below is *measured* (bracketed with
  // `Date.now()` around the click that ends it), not the nominal constants
  // above, so the only slack this needs to cover is the commit round-trip
  // between a click and the app's own recorded timestamp for it -- not
  // `waitForTimeout`'s own scheduling slop (a `waitForTimeout(3_000)` can
  // legitimately resolve at 3_050ms under load; measuring removes that
  // entirely rather than padding around it).
  const TOLERANCE_MS = 800;

  await app.waitForTimeout(WALK1_MS); // Deliberate wall-clock wait: real walking time.
  const pauseClickedAt = Date.now();
  await app.getByRole("button", { name: "Pause" }).click();
  await expect(status.filter({ hasText: "Paused" })).toBeVisible();

  await app.waitForTimeout(PAUSE_MS); // Deliberate wall-clock wait: real paused time.
  const resumeClickedAt = Date.now();
  await app.getByRole("button", { name: "Resume" }).click();
  await expect(status.filter({ hasText: "Walking" })).toBeVisible();

  await app.waitForTimeout(WALK2_MS); // Deliberate wall-clock wait: more real walking time.
  const finishClickedAt = Date.now();
  await app.getByRole("button", { name: "Finish bout" }).click();
  await expect(status.filter({ hasText: "Resting" })).toBeVisible();

  // Once the bout and its pause are both closed, `walkingElapsedMs` (frontend/src/
  // pad/session.ts) is a fixed value derived purely from stored timestamps, not
  // from `now` -- so reading it once here is exact, not a snapshot of something
  // still moving.
  const effectiveMs = parseFormattedDurationMs(
    (await app.locator(".pad-bout-record .timer--inline").textContent()) ?? "",
  );
  const measuredWalk1Ms = pauseClickedAt - boutStartedAt;
  const measuredWalk2Ms = finishClickedAt - resumeClickedAt;
  const expectedMs = measuredWalk1Ms + measuredWalk2Ms;
  expect(Math.abs(effectiveMs - expectedMs)).toBeLessThanOrEqual(TOLERANCE_MS);
  // Distinguishes "excluded correctly" from "not excluded at all": had the pause
  // leaked into the total, it would read close to the measured raw span from bout
  // start to finish (~8s), well outside the tolerance band around the ~5s
  // expected once the pause is excluded. A non-excluded pause still fails this
  // (verified: reintroducing the pause into the total lands well past
  // `rawTotalMs - TOLERANCE_MS`).
  const rawTotalMs = finishClickedAt - boutStartedAt;
  expect(effectiveMs).toBeLessThan(rawTotalMs - TOLERANCE_MS);
});

test(
  "PAD-08 — pause: the PAUSED state and its excluded-pause elapsed time restore after a cold reopen",
  async ({ app }) => {
    await signIn(app);
    await startWalkingBout(app);
    const status = app.getByRole("status");

    const WALK_MS = 3_000;
    const TOLERANCE_MS = 1_500;

    await app.waitForTimeout(WALK_MS); // Deliberate wall-clock wait: real walking time before the pause.
    await app.getByRole("button", { name: "Pause" }).click();
    await expect(status.filter({ hasText: "Paused" })).toBeVisible();

    // Real pause time before the cold reopen -- the point is that the pause is
    // still open (never resumed) across the reopen boundary.
    await app.waitForTimeout(2_500);

    // Navigate to Home first: `coldReopen` reopens at whatever URL the page was
    // already on, and Home's Resume card is what this test needs to read.
    await app.getByRole("link", { name: "Home" }).click();
    const reopened = await coldReopen(app); // Page close/reopen stand-in; see PAD-02's own comment.

    const card = reopened
      .getByRole("article")
      .filter({ has: reopened.getByRole("heading", { level: 3, name: "PAD Walking" }) });
    await expect(card.locator(".resume-card__status")).toContainText("Paused · Bout 1");

    await card.getByRole("link", { name: "Resume PAD Walking" }).click();
    await expect(reopened.getByRole("status").filter({ hasText: "Paused" })).toBeVisible();
    await expect(reopened.locator(".pad-hud__bout")).toHaveText("Bout 1");

    // The HUD's "Walking Xs" sub-line under a PAUSED state (`WalkingHud` in
    // PadPage.tsx) is `walkingElapsedMs`, i.e. exactly the excluded-pause figure
    // PAD-08 is about. It must reconstruct to ~WALK_MS immediately after reopening.
    const walkingLine = reopened.locator("p.muted").filter({ hasText: /^Walking \d/ });
    const readExcludedMs = async () => parseFormattedDurationMs((await walkingLine.textContent())?.replace("Walking ", "") ?? "");
    await expect
      .poll(async () => Math.abs((await readExcludedMs()) - WALK_MS), { timeout: 5_000 })
      .toBeLessThanOrEqual(TOLERANCE_MS);

    // And it must STAY there while more real time passes with the pause still
    // open: an open pause keeps growing at the same rate the raw bout interval
    // does, so the net excluded-pause figure should not grow at all. This is the
    // part that actually distinguishes "restores once" from "restores and keeps
    // excluding correctly."
    await reopened.waitForTimeout(2_000); // Deliberate wall-clock wait: more real paused time.
    const excludedAfterMoreWaiting = await readExcludedMs();
    expect(Math.abs(excludedAfterMoreWaiting - WALK_MS)).toBeLessThanOrEqual(TOLERANCE_MS);
  },
);
