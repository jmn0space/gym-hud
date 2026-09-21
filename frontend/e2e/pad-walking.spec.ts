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
import { coldReopen, signIn, startWalkingBout } from "./support/fixtures";

/**
 * Local helpers, not shared via `support/`: this PR's scope is limited to its own
 * two spec files, and a concurrent agent is reading `support/` for its own specs, so
 * duplicating these few lines is cheaper than risking a conflicting edit there.
 */

/**
 * Parses a `TimerDisplay`'s `datetime="PT<seconds>S"` attribute back into
 * milliseconds (see `frontend/src/components/TimerDisplay.tsx`). Reading this
 * instead of the rendered "MM:SS" text avoids re-deriving hour/minute/second parsing
 * in the test and gets whole-second precision directly from the same value the
 * component computed.
 */
function parseTimerDatetimeMs(datetime: string | null): number {
  const match = datetime === null ? null : /^PT(\d+)S$/.exec(datetime);
  if (match === null) {
    throw new Error(`Expected a "PT<seconds>S" timer datetime, got: ${String(datetime)}`);
  }
  return Number(match[1]) * 1000;
}

/** Parses a rendered "MM:SS" or "H:MM:SS" duration (`formatDuration`'s own format). */
function parseFormattedDurationMs(text: string): number {
  const parts = text.trim().split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Expected a formatted MM:SS or H:MM:SS duration, got: ${text}`);
  }
  const padded = parts.length === 3 ? parts : [0, ...parts];
  const [hours, minutes, seconds] = padded as [number, number, number];
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

test(
  "PAD-01 — lock-screen recovery: displayed duration resyncs to wall-clock elapsed time after a real visibility change",
  async ({ app }) => {
    await signIn(app);
    const startedAt = await startWalkingBout(app);
    const timer = app.locator("time.timer--large");
    await expect(timer).toBeVisible();

    // Real lock-screen stand-in, not a faked one: a second page in the SAME browser
    // context is brought to the front, which genuinely backgrounds `app` -- Chromium
    // fires a real `visibilitychange` on it, exactly the event `useNow` (frontend/
    // src/pad/useNow.ts) listens for. The existing fake-timer coverage (`PAD-01 --
    // lock-screen recovery` in `frontend/src/pages/PadPage.test.tsx`) advances a
    // mocked clock so that literally *no* tick fires while time passes; this spec
    // cannot force that on headless Chromium over a few real seconds (Chrome's
    // background-tab timer throttling generally only bites after minutes hidden, and
    // headless mode's exact scheduling is not something this suite controls), so it
    // does not claim to reproduce "zero ticks delivered." What it CAN prove on a real
    // browser: after a genuine visibility change, the displayed duration matches
    // wall-clock elapsed -- which is only true if the display is recomputed from the
    // stored `started_at`, because a tick-accumulating implementation that missed
    // ticks while hidden would show a smaller value than wall-clock elapsed and stay
    // wrong until its next natural tick.
    const blank = await app.context().newPage();
    await blank.bringToFront();

    // Deliberate wall-clock wait, not a synchronization mechanism -- PAD-01's whole
    // premise is that real time passes while the tab is hidden. 4s is long enough to
    // be clearly more than one 1s tick interval (so "the display just ticked once
    // more" cannot explain a pass) and short enough to keep CI fast.
    const HIDE_MS = 4_000;
    await blank.waitForTimeout(HIDE_MS);

    await app.bringToFront();

    // Tolerance: two `bringToFront` round trips plus one React re-render are not
    // instantaneous under CI load (see `playwright.config.ts`'s own comment about
    // needing more slack than a typical DOM assertion for an IndexedDB round trip).
    // 2s is half of `HIDE_MS`, so a pass still clearly demonstrates recomputation --
    // a implementation that simply never resyncs would be off by ~`HIDE_MS`, not by
    // something inside this tolerance.
    const TOLERANCE_MS = 2_000;

    // Recomputed on every poll attempt (not a single fixed target) because the
    // acceptable "wall-clock elapsed" value keeps moving while `expect.poll` retries
    // waiting for React to flush the resync.
    await expect
      .poll(
        async () => {
          const displayedMs = parseTimerDatetimeMs(await timer.getAttribute("datetime"));
          const wallClockMs = Date.now() - startedAt;
          return Math.abs(displayedMs - wallClockMs);
        },
        {
          timeout: 3_000,
          message: "displayed duration should resync to wall-clock elapsed time after becoming visible again",
        },
      )
      .toBeLessThanOrEqual(TOLERANCE_MS);

    await blank.close();
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
  await startWalkingBout(app);
  const status = app.getByRole("status");

  // Three real intervals: walk, pause, walk again. Kept a few seconds each so the
  // "excludes the pause" signal (the gap between the raw total and the effective
  // total is roughly PAUSE_MS) is well clear of round-trip noise from the commit
  // queue (each Pause/Resume/Finish tap is its own local-first action, committed
  // through real IndexedDB -- see playwright.config.ts's own comment on why that
  // needs more slack than a typical DOM assertion).
  const WALK1_MS = 3_000;
  const PAUSE_MS = 3_000;
  const WALK2_MS = 2_000;
  const TOLERANCE_MS = 2_000;

  await app.waitForTimeout(WALK1_MS); // Deliberate wall-clock wait: real walking time.
  await app.getByRole("button", { name: "Pause" }).click();
  await expect(status.filter({ hasText: "Paused" })).toBeVisible();

  await app.waitForTimeout(PAUSE_MS); // Deliberate wall-clock wait: real paused time.
  await app.getByRole("button", { name: "Resume" }).click();
  await expect(status.filter({ hasText: "Walking" })).toBeVisible();

  await app.waitForTimeout(WALK2_MS); // Deliberate wall-clock wait: more real walking time.
  await app.getByRole("button", { name: "Finish bout" }).click();
  await expect(status.filter({ hasText: "Resting" })).toBeVisible();

  // Once the bout and its pause are both closed, `walkingElapsedMs` (frontend/src/
  // pad/session.ts) is a fixed value derived purely from stored timestamps, not
  // from `now` -- so reading it once here is exact, not a snapshot of something
  // still moving.
  const effectiveMs = parseFormattedDurationMs(
    (await app.locator(".pad-bout-record .timer--inline").textContent()) ?? "",
  );
  const expectedMs = WALK1_MS + WALK2_MS;
  expect(Math.abs(effectiveMs - expectedMs)).toBeLessThanOrEqual(TOLERANCE_MS);
  // Distinguishes "excluded correctly" from "not excluded at all": had the pause
  // leaked into the total, it would read close to WALK1+PAUSE+WALK2 (~8s), well
  // outside the tolerance band around the expected ~5s.
  expect(effectiveMs).toBeLessThan(WALK1_MS + PAUSE_MS + WALK2_MS - TOLERANCE_MS);
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
