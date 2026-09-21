/**
 * Real-browser coverage for PAD-09 (manual time correction) -- issue #23's
 * last previously-blocked acceptance ID. Issue #22 (PAD timestamp
 * corrections, confirmed undo, bout deletion) has since merged into this
 * branch, so the correction controls this spec drives now exist in the built
 * app; see `docs/pad-pilot-validation.md` for the history of that block.
 *
 * What issue #22 already proved at the unit level is NOT re-proven here:
 * `frontend/src/pad/padCorrections.test.ts`'s "PAD time corrections (PAD-09)"
 * describe block already exercises `correctWalkingBoutTimesAction` directly
 * against a real `createLocalRepository` (including every invalid-correction
 * refusal), and `frontend/src/pages/PadPage.test.tsx`'s "corrects a completed
 * bout's recorded end time and recalculates the displayed duration (PAD-09)"
 * already drives the real HUD controls in jsdom. This file exists for the two
 * things neither of those can reach: a correction committed through the real
 * IndexedDB/service-worker stack in an actual browser, and the resulting
 * mutation actually landing on a real HTTP server exactly once. See
 * `docs/acceptance-tests.md#pad-09--manual-time-correction` for the exact
 * acceptance wording and `docs/pad-pilot-validation.md` for the coverage
 * matrix these test names feed.
 *
 * A separate file rather than an addition to `pad-walking.spec.ts`: that
 * file's own header comment scopes it to PAD-01/02/07/08 (timer/pause/
 * cold-reopen behaviour on a live bout, all shipped before issue #22).
 * PAD-09's correction controls are a distinct feature surface with their own
 * setup shape (a bout must be finished, then edited, before any of this
 * applies), so a dedicated file keeps each spec's scope legible at a glance --
 * the same reasoning that already split `pad-offline.spec.ts` and
 * `auth-sync.spec.ts` out of `pad-walking.spec.ts` by concern rather than
 * growing one file indefinitely.
 */

import type { Page } from "@playwright/test";

import { expect, test } from "./support/fixtures";
import { coldReopen, parseFormattedDurationMs, signIn, startWalkingBout } from "./support/fixtures";

/**
 * `RecordedTimeField`'s own local-time conversion (`isoToLocalInputValue` in
 * `frontend/src/pages/PadPage.tsx`), reproduced here rather than imported:
 * this spec drives the built app as a black box over HTTP, the same way a
 * real device would, and has no access to the app's own module graph.
 * Matches the jsdom unit test's identical helper
 * (`frontend/src/pages/PadPage.test.tsx`'s `toDatetimeLocalValue`) so a
 * `<input type="datetime-local">` fill here means exactly what it means
 * there: local wall-clock time, whole seconds only -- the field's own
 * `step="1"` drops anything finer (issue #22 finding 3).
 */
function toDatetimeLocalValue(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return (
    `${date.getFullYear().toString()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/**
 * `new Date(<the truncated datetime-local string above>).toISOString()` --
 * what `localInputValueToIso` (`PadPage.tsx`) actually commits once Save is
 * pressed. Computing it this same way, from the same truncated string the
 * browser will parse, is what lets the mutation assertion below match on an
 * *exact* ISO string instead of a tolerance band: the field's whole-second
 * truncation is the only imprecision in this scenario, and this function
 * applies exactly that truncation once, the same way the app does.
 */
function wholeSecondIso(date: Date): string {
  return new Date(toDatetimeLocalValue(date)).toISOString();
}

/**
 * Opens bout 1's time editor and corrects its recorded end through the real
 * controls: the "Edit times for bout 1" disclosure, the tappable "Bout 1
 * ended" field it reveals, and Save. Requires the bout to already be
 * finished -- the ended-time field only renders once `ended_at` is set
 * (`CompletedBout` in `PadPage.tsx`).
 */
async function correctBout1EndedAt(page: Page, correctedEndedAt: Date): Promise<void> {
  await page.getByText("Edit times for bout 1", { exact: true }).click();
  await page.getByRole("button", { name: /Bout 1 ended/ }).click();
  await page.getByLabel("Bout 1 ended").fill(toDatetimeLocalValue(correctedEndedAt));
  await page.getByRole("button", { name: "Save" }).click();
}

test(
  "PAD-09 — manual time correction: correcting an overrun bout's recorded end time recalculates the displayed duration and effective walking time, and reaches the server as one applied mutation",
  async ({ app, server }) => {
    await signIn(app);
    const boutStartedAt = await startWalkingBout(app);
    const status = app.getByRole("status");

    // Real intervals, each bracketed by `Date.now()` around the click that ends
    // it -- the same technique `PAD-08` uses in `pad-walking.spec.ts` and for
    // the same reason: the app stamps its own commit time a few milliseconds
    // after this click (a real IndexedDB round trip), so measuring removes
    // that slack instead of assuming a nominal wait landed exactly on it.
    const WALK1_MS = 3_000;
    const PAUSE_MS = 2_000;
    // The bout is deliberately left running well past this: PAD-09's own
    // scenario is "allow it to continue accidentally beyond its intended
    // end," and this real wait is that overrun.
    const OVERRUN_MS = 6_000;
    // What the second walking interval should actually have been -- well
    // short of OVERRUN_MS, so the correction below is a real, provable
    // change, not a same-value no-op.
    const INTENDED_WALK2_MS = 2_000;
    // Whole-second floor on the corrected value (up to 999ms, see
    // `wholeSecondIso`) plus the usual commit round-trip slack (PAD-02/
    // PAD-08's own margin for a real IndexedDB write reaching the DOM).
    const TOLERANCE_MS = 1_500;

    await app.waitForTimeout(WALK1_MS); // Deliberate wall-clock wait: real walking time.
    const pauseClickedAt = Date.now();
    await app.getByRole("button", { name: "Pause" }).click();
    await expect(status.filter({ hasText: "Paused" })).toBeVisible();

    await app.waitForTimeout(PAUSE_MS); // Deliberate wall-clock wait: real paused time.
    const resumeClickedAt = Date.now();
    await app.getByRole("button", { name: "Resume" }).click();
    await expect(status.filter({ hasText: "Walking" })).toBeVisible();

    await app.waitForTimeout(OVERRUN_MS); // Deliberate wall-clock wait: the accidental overrun itself.
    await app.getByRole("button", { name: "Finish bout" }).click();
    await expect(status.filter({ hasText: "Resting" })).toBeVisible();

    const durationLocator = app.locator(".pad-bout-record .timer--inline");
    // Sanity check on the PRE-correction state: prove the overrun is really
    // reflected in the displayed number before touching anything, so the
    // correction below is provably fixing a real, wrong value -- not
    // rewriting a number that already happened to read right.
    const beforeCorrectionMs = parseFormattedDurationMs((await durationLocator.textContent()) ?? "");
    expect(beforeCorrectionMs).toBeGreaterThan(WALK1_MS + INTENDED_WALK2_MS + TOLERANCE_MS);

    // Correct the recorded end back to what it should have been:
    // INTENDED_WALK2_MS after the resume, not the actual (overrun) Finish
    // bout click.
    const correctedEndedAt = new Date(resumeClickedAt + INTENDED_WALK2_MS);
    await correctBout1EndedAt(app, correctedEndedAt);

    // Effective walking time = (corrected span from bout start to the
    // corrected end) minus the pause. Substituting resumeClickedAt cancels
    // the walk-1/pause segment out of the corrected span algebraically,
    // leaving exactly measuredWalk1Ms + INTENDED_WALK2_MS -- PAD-08's own
    // "measured, not nominal" shape, extended to a corrected (not directly
    // clicked) endpoint.
    const measuredWalk1Ms = pauseClickedAt - boutStartedAt;
    const expectedEffectiveMs = measuredWalk1Ms + INTENDED_WALK2_MS;

    await expect
      .poll(
        async () => Math.abs(parseFormattedDurationMs((await durationLocator.textContent()) ?? "") - expectedEffectiveMs),
        {
          timeout: 5_000,
          message: "displayed bout duration should recalculate from the corrected end time, excluding the pause",
        },
      )
      .toBeLessThanOrEqual(TOLERANCE_MS);
    // Distinguishes "recalculated" from "the correction did not actually take":
    // the corrected value must read well below the pre-correction overrun
    // figure, not just somewhere in a wide tolerance band around it.
    const afterCorrectionMs = parseFormattedDurationMs((await durationLocator.textContent()) ?? "");
    expect(afterCorrectionMs).toBeLessThan(beforeCorrectionMs - TOLERANCE_MS);

    // The part no jsdom test can cover: the correction reaches the server as
    // its own mutation, and exactly once -- never zero (still local-only,
    // e.g. a Save that only updated IndexedDB) and never more than one (a
    // retried or duplicated push). Matched on the exact corrected ISO value
    // rather than a mutation count, since the earlier start/pause/resume/
    // finish actions already produced `walking_bouts` changes of their own
    // and a bare count would not distinguish this one from those.
    const correctedEndedAtIso = wholeSecondIso(correctedEndedAt);
    const correctionMutations = server
      .appliedMutations()
      .filter((mutation) =>
        mutation.body.changes.some((change) => change.store === "walking_bouts" && change.record.ended_at === correctedEndedAtIso),
      );
    expect(correctionMutations).toHaveLength(1);
  },
);

test(
  "PAD-09 — manual time correction: the corrected end time, not the pre-correction overrun, is what survives a cold reopen and feeds the next session's total",
  async ({ app }) => {
    await signIn(app);
    const boutStartedAt = await startWalkingBout(app);
    const status = app.getByRole("status");

    // No pause in this scenario, deliberately: PAD-08's own pause-exclusion
    // claim, and its interaction with a correction, is already proven by the
    // previous test in this file and by PAD-08's own cold-reopen test in
    // `pad-walking.spec.ts`. This test's job is narrower and orthogonal --
    // does the CORRECTED value (not the original one) survive a restart and
    // reach the next session's summary -- and a bare bout keeps that signal
    // uncluttered.
    const OVERRUN_MS = 5_000; // The accidental overrun.
    const INTENDED_WALK_MS = 2_000; // What the bout should actually have lasted.
    const TOLERANCE_MS = 1_500; // Whole-second floor plus commit round-trip slack, as above.

    await app.waitForTimeout(OVERRUN_MS); // Deliberate wall-clock wait: the accidental overrun.
    await app.getByRole("button", { name: "Finish bout" }).click();
    await expect(status.filter({ hasText: "Resting" })).toBeVisible();

    const durationLocator = app.locator(".pad-bout-record .timer--inline");
    const beforeCorrectionMs = parseFormattedDurationMs((await durationLocator.textContent()) ?? "");

    const correctedEndedAt = new Date(boutStartedAt + INTENDED_WALK_MS);
    await correctBout1EndedAt(app, correctedEndedAt);

    const expectedMs = Date.parse(wholeSecondIso(correctedEndedAt)) - boutStartedAt;
    await expect
      .poll(
        async () => Math.abs(parseFormattedDurationMs((await durationLocator.textContent()) ?? "") - expectedMs),
        { timeout: 5_000, message: "displayed bout duration should recalculate before the cold reopen" },
      )
      .toBeLessThanOrEqual(TOLERANCE_MS);
    // The exact rendered string, captured once here and compared verbatim
    // below -- both readings come from `formatDuration` applied to the same
    // fixed, already-closed interval, so they should match byte-for-byte,
    // not merely within a tolerance band.
    const correctedDurationText = ((await durationLocator.textContent()) ?? "").trim();
    expect(correctedDurationText.length).toBeGreaterThan(0);
    expect(parseFormattedDurationMs(correctedDurationText)).toBeLessThan(beforeCorrectionMs - TOLERANCE_MS);

    // Home -> cold reopen -> Resume, exactly like PAD-02/PAD-08's own
    // cold-reopen tests: `coldReopen` reopens at whatever URL the page was
    // already on, so Home's Resume card is what this needs to read first.
    await app.getByRole("link", { name: "Home" }).click();
    const reopened = await coldReopen(app); // Page close/reopen stand-in; see PAD-02's own comment in support/fixtures.ts.

    const card = reopened
      .getByRole("article")
      .filter({ has: reopened.getByRole("heading", { level: 3, name: "PAD Walking" }) });
    await expect(card.locator(".resume-card__status")).toContainText("Resting after bout 1");
    await card.getByRole("link", { name: "Resume PAD Walking" }).click();

    // The value that survived the restart must be the CORRECTED one, not the
    // pre-correction overrun -- reading back the pre-correction figure here
    // would mean the correction only ever lived in a stale in-memory view and
    // never actually reached IndexedDB.
    const reopenedDurationLocator = reopened.locator(".pad-bout-record .timer--inline");
    await expect(reopenedDurationLocator).toHaveText(correctedDurationText);

    // Finish the whole session so its summary is written
    // (`summarizeWalkingSession` in `frontend/src/pad/settings.ts`, from
    // `PadPage.tsx`'s `finishSession`), then confirm the next "Last session"
    // card -- rendered on the very same screen once no session is active --
    // carries the CORRECTED total forward, not the overrun one. This is
    // PAD-09's "session totals" claim from a genuinely different read path
    // than the bout's own duration line above: a separate sync-metadata
    // write, read back by a freshly mounted `WalkingStartScreen`.
    await reopened.getByRole("button", { name: "Finish session" }).click();
    await expect(reopened.getByRole("heading", { level: 2, name: "Last session" })).toBeVisible();
    const lastSession = reopened.locator("section").filter({ has: reopened.getByRole("heading", { level: 2, name: "Last session" }) });
    await expect(lastSession).toContainText(`${correctedDurationText} walking`);
  },
);
