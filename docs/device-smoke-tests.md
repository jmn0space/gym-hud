# Device smoke tests

[← Documentation index](README.md) · [Architecture](architecture.md) · [Data & sync](data-sync.md) · [Acceptance criteria](acceptance-tests.md) · [PAD pilot validation](pad-pilot-validation.md)

This is the real-device evidence record for acceptance criterion 5 of issue
#17 ("Record a real-device installation/offline-reopen smoke result"), for
the target-device evidence PAD-01 and PAD-02 require (issue #18, acceptance
criterion 5), and for the complete PAD pilot device procedure issue #23
requires (acceptance criteria 2–4). Target device: **Xiaomi Redmi Note 13
Pro+ / Android** (`docs/architecture.md`, "Primary target device"). The
overall pass/fail status of the issue #23 gate — including how this
document's evidence combines with automated coverage, and what still blocks
it — is recorded in [`docs/pad-pilot-validation.md`](pad-pilot-validation.md),
not here; this document only specifies and records the device steps
themselves.

**Honesty statement.** No one has run this procedure on hardware yet. Every
row in the [Results](#results) table below is marked `NOT YET RUN`. This
document specifies exactly what to do and what to check; it does not claim
any of it has happened. Do not change a result to a passing value without
actually performing that step on the named device and recording who did it
and when.

## Scope

This procedure has three parts.

- **Part A — installation and offline reopen.** Fully specified and runnable
  today with only what issue #17 adds: the manifest, icons, service worker,
  and the Docker preview workflow. This is the part acceptance criterion 5
  and the "Force-stop the installed PWA/browser process, reopen it..." item
  in [`docs/acceptance-tests.md`](acceptance-tests.md#follow-up-android-and-synchronization-checklist)
  need.
- **Part B — PAD-01 and PAD-02 (walking state).** Runnable since issue #18
  added the first PAD controls: `START` on the PAD screen creates a walking
  session, and `START WALKING` starts a bout, so an active bout can exist on
  the device before the phone is locked or the process is force-stopped. The
  numbered procedure is below; it has not been run.
- **Part C — the complete PAD pilot (issue #23).** Issue #21 added the
  `Pause`/`Resume`, `Finish bout`, and `Start next bout` controls to
  `frontend/src/pages/PadPage.tsx`, which unblocks the PAUSED and RESTING
  variants of Part B's force-stop/cold-reopen check — **those are no longer
  blocked** and are covered by [Part C](#part-c--the-complete-pad-pilot-on-the-device)
  below, not left as `BLOCKED` rows. Part C also covers the full PAD-03
  offline sequence, PAD-04 reconnection with a concrete server-side check,
  PAD-07's maximum-timer alert, session expiry/re-authentication during a
  pending offline workout, and a service-worker update while a bout is
  active. It has not been run. PAD-09 (manual time correction) has no
  procedure here: it depends on issue #22 (PAD timestamp corrections,
  confirmed undo, bout deletion), whose PR
  [#43](https://github.com/jmn0space/gym-hud/pull/43) is open and unmerged.
  See [`docs/pad-pilot-validation.md`](pad-pilot-validation.md) for the full
  blocking-issue record and the issue #23 coverage matrix.

One thing remains genuinely blocked and must not be recorded as passing:
confirming that cached reference data survives an offline reopen. The client
sync engine (issue #20) writes `pad_defaults`/`pad_next_session_settings` to
`reference_data` on every successful pull (see [Data & synchronization:
client obligations](data-sync.md#client-obligations)), but no screen reads
those values back yet — `WalkingStartScreen` inherits settings from its own
`PREVIOUS_WALKING_SESSION_KEY` sync-metadata write or a local history scan
(`frontend/src/pages/PadPage.tsx`), never from the pulled reference cache —
so there is still no on-device way to confirm this end to end. This is no
longer blocked on the backend contract (issue #19/#20 shipped that); it is
blocked on a UI consumer that does not exist yet. Re-run once one does.

## Prerequisites

- A host machine on the same Wi-Fi network as the phone, with this repository
  checked out and Docker available (see the repository root `README.md`,
  "PWA and offline" section, for the full preview quick start).
- The phone's LAN IP address is not needed in advance — check the phone's
  Wi-Fi settings for its own address, or use the host machine's LAN IP (the
  address other devices on the network use to reach it), whichever the
  Compose stack is bound to. Either way, `PREVIEW_HOST` below must be an
  address the phone can actually reach; `localhost` only proves the stack
  boots.
- A provisioned application account (see root `README.md`, "Provisioning the
  application account") reachable through the preview stack's Django
  service.
- USB debugging enabled on the phone and the host authorized
  (`adb devices` shows it), used below both to transfer the CA certificate
  and, optionally, to inspect the installed app through
  `chrome://inspect` on the host's desktop Chrome.

## Procedure

### Part A — installation and offline reopen

1. On the host, build the frontend bundle (Caddy only serves what already
   exists on disk; it does not build it) and start the preview stack, with
   `PREVIEW_HOST` set to the address from "Prerequisites" above:

   ```bash
   cd frontend && npm ci && npm run build && cd ..
   PREVIEW_HOST=192.168.1.5 docker compose -f docker-compose.preview.yml up --build
   ```

2. One-time per host: extract Caddy's locally-trusted root CA and install it
   on the phone.

   ```bash
   docker compose -f docker-compose.preview.yml cp \
     caddy:/data/caddy/pki/authorities/local/root.crt ./gym-hud-preview-ca.crt
   adb push ./gym-hud-preview-ca.crt /sdcard/Download/
   ```

   On the phone: Settings → Security (menu names and nesting vary by Android
   version and OEM skin; search Settings for "Install a certificate" or "CA
   certificate" if these do not match exactly) → Encryption & credentials →
   Install a certificate → CA certificate → select `gym-hud-preview-ca.crt`
   from Downloads → confirm the warning that this certificate can monitor
   network traffic.

   **That warning is accurate, not boilerplate.** Trusting this CA is
   **not** scoped to the `PREVIEW_HOST` this stack happens to issue
   certificates for — "only issues a certificate for `PREVIEW_HOST`"
   describes what Caddy chooses to issue, not what the phone will accept.
   Once installed, the root is **trusted for every HTTPS site on this phone,
   until you remove it** — indefinitely, across reboots, unrelated to this
   test. The CA's private key sits unencrypted in the `caddy_data` volume
   (`/data/caddy/pki/authorities/local/root.key`); anyone who later obtains
   it (stolen device, backup, a machine shared with someone else) can mint a
   certificate for any domain and transparently MITM this phone's HTTPS
   traffic on any network. Use a dedicated test device, not a personal
   phone, if at all possible.

   This trust step only needs repeating if the `caddy_data` volume is ever
   deleted (`docker compose down -v`); a plain restart or a changed
   `PREVIEW_HOST` reuses the same trusted CA — which is exactly why the
   mandatory teardown below matters once testing is actually done.

   **Teardown (do this when you are finished testing, not just when you stop
   the containers):**

   ```bash
   docker compose -f docker-compose.preview.yml down -v   # destroys root.key
   ```

   On the phone: Settings → Security → Encryption & credentials → User
   credentials → remove `gym-hud-preview-ca.crt` (or whatever name it
   installed under).

3. On the phone, open Chrome and navigate to `https://<PREVIEW_HOST>/`.
   Confirm:
   - the page loads with **no certificate warning** (the CA from step 2 is
     trusted);
   - Chrome's menu (⋮) offers "Install app" / "Add to Home screen";
   - on the host, `chrome://inspect` (with the phone's Chrome tab visible)
     lets you open DevTools for that page; under Application → Manifest, the
     manifest is detected with no errors and `Gym HUD` as its name; under
     Application → Service Workers, `/sw.js` is listed with status
     `activated and is running` and scope `/`.
4. Install the app (Chrome's "Install app" prompt, or the ⋮ menu). Confirm
   the resulting home-screen icon is the Gym HUD icon (not a broken-image
   placeholder or a generic globe) and its label reads "Gym HUD".
5. Launch the installed app from its home-screen icon. Confirm it opens in
   **standalone** display: no browser address bar or tab strip.
6. While still online, sign in with the provisioned application account.
   Confirm the app reaches its normal authenticated Home screen.
7. Enable Airplane Mode on the phone.
8. Fully terminate the app process — from Android's Recent Apps view, swipe
   it away, or use Settings → Apps → Gym HUD → Force stop. This must be a
   real process termination, not merely sending the app to the background
   (the same distinction PAD-02 draws).
9. While still offline, cold-start the app from its home-screen icon.
10. Confirm all of the following:
    - the app shell loads — the previously installed UI, not a browser-level
      "You're offline" / dinosaur page and not a blank white screen. This is
      the service worker's precached shell and offline fallback (D2 in
      [`docs/plans/issue-17-installable-offline-pwa.md`](plans/issue-17-installable-offline-pwa.md))
      doing its job;
    - the app does **not** bounce to a login screen — it reaches the
      offline-continuation state described in [Data & synchronization:
      authentication and offline
      continuation](data-sync.md#authentication-and-offline-continuation)
      (`unverified`), since step 6 stored an auth marker on this device;
    - Home renders with no visible error state. It is expected to show **no**
      Resume cards at this point — see Part B; that is not a failure of this
      step.
11. Disable Airplane Mode. Confirm the app reconciles back to its normal
    `authenticated` state on its own within a few seconds, without a manual
    reload (data-sync.md's online/focus re-check triggers).
12. Once this run is genuinely finished (not just this sitting — only once
    you have no more preview testing planned on this device for a while):
    perform the teardown in step 2 above (remove the CA from the phone's
    user credentials, and `docker compose -f docker-compose.preview.yml
    down -v`). Leaving the CA trusted and the key on disk is the whole risk
    step 2 describes; do not skip this because the app worked.

### Part B — PAD-01 and PAD-02 on the device

Run Part A first, at least through step 6 (installed, launched standalone,
signed in). Part B then continues on the same installed app, so leave Part A's
step 12 teardown (removing the CA and destroying the preview volume) until Part
B is finished too. Steps B1–B4 are PAD-01; steps B5–B9 are PAD-02.

B1. On the installed app, open `PAD` from the bottom navigation. Confirm the
    start screen shows the treadmill settings (speed, incline, maximum bout)
    and a `Start` button. On a device that has completed a walking session
    before, confirm the settings match that session's; on a fresh install,
    confirm they are the application defaults `5.0 km/h`, `2.0 %`, `8`
    minutes.
B2. Press `Start`, then press `Start walking`. Confirm the screen shows
    `Bout 1`, the state `Walking`, and a timer counting from `00:00`. Note the
    wall-clock time here — everything below is checked against it, not against
    what the app was showing when the screen went off.
B3. Lock the phone (power button) and leave it locked for at least five
    minutes. Do not merely switch apps: the screen must be off long enough for
    the timer to be throttled or stopped entirely.
B4. Unlock and return to the app. Confirm the displayed duration equals the
    real time elapsed since B2 (within a second), not a smaller value that
    stopped while the screen was off. **This is PAD-01.**
B5. Enable Airplane Mode (if Part A left it off) and confirm the bout keeps
    running with no error banner. **This is the "start a PAD bout while
    offline" checklist item** in `docs/acceptance-tests.md`; if the bout was
    started online in B2, start a second session offline to exercise it
    properly: press `Finish session`, then `Start` and `Start walking` again
    while offline.
B6. Fully terminate the app process, exactly as in Part A step 8 (Recent Apps
    → swipe away, or Settings → Apps → Gym HUD → Force stop). This must be a
    real process termination.
B7. While still offline, cold-start the app from its home-screen icon.
B8. Confirm Home shows a `Resume PAD Walking` card whose state reads
    `Walking · Bout N` for the bout that was running, with an elapsed time
    matching the real time since that bout started. **This is PAD-02.**
B9. Press `Resume`. Confirm the PAD screen shows the same bout number, the
    same treadmill settings, and the same elapsed time (within a second), then
    press `Finish session` to leave the device with no active session.

Not attempted in Part B, and to be left as `NOT YET RUN` rather than folded
into B8:

- the PAUSED and RESTING variants of B8 — issue #21 unblocked these, and
  their procedure is [Part C](#part-c--the-complete-pad-pilot-on-the-device)
  below (C1–C6), not a variant of B8 itself;
- confirming cached reference data survives the same offline reopen, which
  remains blocked as explained in [Scope](#scope) above (no screen reads the
  pulled cache back yet).

### Part C — the complete PAD pilot on the device

Run Part A first, through step 6 (installed, launched standalone, signed
in). Part C then continues on the same installed app; leave Part A's step 12
teardown until Part C is finished too, alongside Part B if you run both in
the same session. Each numbered step states what to do and exactly what to
confirm before moving on. Button and label text below is quoted verbatim
from `frontend/src/pages/PadPage.tsx` and `frontend/src/components/ResumeCard.tsx`
as it exists today — confirm the on-screen text matches exactly, since a
mismatch here is itself worth recording as a finding.

**PAUSED and RESTING restoration** (cross-referencing PAD-06 and PAD-08):

C1. On the PAD screen, press `Start`, then `Start walking` to begin Bout 1
    (or continue a bout already running from Part B). Note the wall-clock
    time.
C2. Press `Pause`. Confirm the state line reads `Paused`, a second line
    shows the frozen `Walking …` duration next to the running pause timer.
    Leave it paused for at least two minutes (PAD-08's own scenario), noting
    the wall-clock time the pause began.
C3. Fully terminate the app process (Part A step 8), then, while still
    offline, cold-start it from the home-screen icon.
C4. Confirm Home's `Resume PAD Walking` card reads `Paused · Bout 1` with an
    elapsed time matching the real time since C2 (within a second). This is
    the PAUSED case Part B left blocked.
C5. Press `Resume` on the card, then `Resume` on the PAD screen. Confirm the
    walking timer equals the time since C1 minus the paused interval from
    C2–C4 (within a second) — the effective-duration exclusion PAD-08
    requires. Press `Finish bout`, then `Start next bout` to close its rest
    and begin Bout 2.
C6. With Bout 2 walking, press `Finish bout` so its rest is open, then fully
    terminate the app again and cold-start it offline. Confirm Home reads
    `Resting after bout 2` with an elapsed time matching real time since the
    finish. Press `Resume`; confirm the PAD screen offers `Start next bout`
    as the only way to continue — not `Start walking` — since a bout cannot
    start while a rest is open (PAD-06). Press it, confirm Bout 3 begins
    walking, then press `Finish bout` and `Finish session` to leave the
    device with no active session.

**PAD-03 offline sequence end to end:**

C7. Enable Airplane Mode. Press `Start`, then `Start walking` for a new
    session (Bout 1). Confirm it runs with no error banner while offline.
C8. Press `Finish bout`. Confirm the state reads `Resting after bout 1`,
    still offline.
C9. Under "Completed bouts," on Bout 1's pain selector, press `3` then `4`
    (an adjacent pair; pain remains editable after a bout finishes). Confirm
    both show pressed with no error, still offline.
C10. Press `Start next bout`. Confirm Bout 2 begins Walking, still offline.
C11. Reload the page (browser refresh) while still offline. Confirm the HUD
     reconstructs exactly the same state — Bout 2 Walking, Bout 1 listed
     under Completed bouts with `Pain 3–4` — proving each step above was
     actually persisted, not merely held in memory. Leave the session active
     and the device offline for the reconnection check below.

**PAD-04 reconnection: one server record per logical action:**

C12. Enumerate the mutations C7–C10 should have queued offline, in the
     order they were committed, and why each is its own row rather than
     folded into its neighbor:

     1. start session (C7's `Start`) — creates the walking session.
     2. start bout 1 (C7's `Start walking`) — a separate action from #1:
        starting a session and starting its first bout are two logical
        actions in this app (`startWalkingSessionAction` and
        `startWalkingBoutAction` in `frontend/src/pad/actions.ts`), even
        though C7 has you press both buttons back to back.
     3. finish bout 1 into its rest (C8) — one row, not two: ending the
        bout and opening its rest commit atomically in the same mutation
        (`finishWalkingBoutAction`); there is no separate action for
        "open a rest."
     4. pain → 3 (C9's first press).
     5. pain → 3–4 (C9's second press) — its own row, not an amendment of
        #4: every pain button press commits and clears immediately, so
        the next press starts a fresh mutation rather than editing the
        one before it. Two presses always produce two rows, whatever
        range they land on.
     6. start bout 2, closing bout 1's rest (C10) — again one row: closing
        the rest and opening bout 2 commit atomically in the same
        mutation (`startNextWalkingBoutAction`).

     Six mutations in total for C7–C10 as scripted above. If you pressed
     the pain selector a different number of times than C9 says, adjust
     only step 4/5 above — every other press-to-mutation is one-for-one
     regardless.
C13. Disable Airplane Mode. Confirm Home's "Saved on this device" count
     drains to `No saved changes waiting to sync` within a few seconds, with
     no action beyond reconnecting — no manual re-entry.
C14. On the host, confirm the server side agrees exactly. Using the
     provisioned account's username (`DJANGO_APP_USERNAME`):

     ```bash
     docker compose -f docker-compose.preview.yml exec web python backend/manage.py shell -c "
     from django.contrib.auth import get_user_model
     from apps.sync.models import ProcessedMutation
     from apps.pad.models import WalkingBout, WalkingRest
     user = get_user_model().objects.get(username='<DJANGO_APP_USERNAME value>')
     print('applied:', ProcessedMutation.objects.filter(user=user, status='applied').count())
     print('processed (all):', ProcessedMutation.objects.filter(user=user).count())
     print('live bouts:', WalkingBout.objects.filter(user=user, deleted_at__isnull=True).count())
     print('live rests:', WalkingRest.objects.filter(user=user, deleted_at__isnull=True).count())
     "
     ```

     Confirm `applied` equals the six-row enumeration from C12 (or your
     adjusted count, if C9's presses differed) and equals `processed
     (all)` — nothing `rejected`, nothing left unresolved — and that `live
     bouts`/`live rests` match what the device shows.

     The number itself depends on following C7–C10 exactly as scripted, so
     the invariant that actually matters, and that holds no matter how many
     times you tapped the pain selector, is this: **never two ledger rows
     for one button press.** Concretely, one press of `Start`, `Start
     walking`, `Finish bout`, a pain button, or `Start next bout` must
     correspond to exactly one `ProcessedMutation` row — not zero (lost),
     not two (duplicated). That per-press count is what this step is really
     checking; the six-row total is only that count applied to the script
     above. Equivalently, browse `/admin/sync/processedmutation/` and
     `/admin/pad/walkingbout/` in Django Admin, filtered to this account.

**PAD-07 maximum timer:**

C15. Finish or discard the session above. Start a new one with `Maximum
     bout (minutes)` set to `0.5` (30 seconds — the shortest value the
     field's own `min="0.5"` HTML constraint allows; a shorter one is
     refused by the browser at submit time, before the app's own "at least
     1 second" rule is even reached). Press `Start walking`.
C16. Let the bout run past 30 seconds without pressing `Finish bout`.
     Confirm the state line grows a `· Maximum reached` alert and the timer
     keeps counting upward — the bout does not end on its own, and `Pause`
     / `Finish bout` remain present and functional. Then press `Finish
     bout` and `Finish session`.

**Session expiry and re-authentication during a pending offline workout**
(AUTH-01(c), issue #23 criterion 4):

C17. Start online and signed in, with no active session and nothing waiting
     to sync — Home must read `No saved changes waiting to sync` before you
     continue. The point of this step is a *valid* server session that C18
     can then invalidate, so it has to be established online first.

     Now enable Airplane Mode, and only then press `Start`, `Start walking`
     and `Pause`. That queues three mutations offline (start session, start
     bout 1, pause — see C12 for why the first two are separate logical
     actions). Confirm Home's "Saved on this device" count shows three
     waiting.

     The order matters and is easy to get wrong: pressing `Start` while
     still online lets the sync engine drain it immediately, which would
     leave only the pause genuinely queued and reduce this check to a
     single-mutation case. Everything C19–C21 assert about local data and
     the outbox surviving an expiry is only meaningfully tested with a
     real queue behind it.
C18. On the host, while the phone stays offline, rotate the provisioned
     account's password to force its current session out — see
     `docs/architecture.md`, "Provisioning the application account":

     ```bash
     export DJANGO_APP_USERNAME=<same account>
     read -rsp 'New app password: ' DJANGO_APP_PASSWORD && export DJANGO_APP_PASSWORD; echo
     docker compose -f docker-compose.preview.yml exec \
       -e DJANGO_APP_USERNAME \
       -e DJANGO_APP_PASSWORD \
       web python backend/manage.py ensure_app_user --reset-password
     ```

     Rotating the password invalidates every session issued under the old
     one the next time it is used.
C19. Disable Airplane Mode on the phone. Confirm the app's next session
     check finds the session gone and shows the persistent `Session
     expired — sign in to sync` banner (`ExpiredSessionBanner`) on every
     screen.
C20. Confirm local data survives untouched: PAD still shows the same paused
     bout from C17, and Home's "Saved on this device" count still shows all
     three queued mutations — the expiry must clear neither the records nor
     the outbox.
C21. Tap the banner's `Sign in` and sign in with the new password. Confirm
     the banner disappears and, with no further manual action, all three
     queued mutations drain (the pending count returns to `No saved changes
     waiting to sync`). Then apply C14's ledger check to these three: one
     `applied` row each, and no duplicate rows for this device's actions.

**Service-worker update while a session is active** (issue #23
criterion 4):

C22. With a bout running and the app online, on the host change any
     frontend source file and rebuild (`cd frontend && npm run build`).
     Caddy bind-mounts `frontend/dist` read-only (`docker-compose.preview.yml`)
     and serves whatever is on disk, so no container restart is needed — the
     new hashed bundle is live as soon as the build finishes.
C23. Bring the installed app to the foreground so its service-worker
     registration checks for an update. Confirm the `AppUpdateBanner`
     ("A new version of Gym HUD is ready.") appears while the bout runs,
     and confirm nothing reloads on its own — `registerServiceWorker.ts`
     never calls `SKIP_WAITING` or reloads except in direct response to
     the banner's own control.
C24. Press `Update now`. Because a session is active, confirm the banner
     switches to the deferred message ("Gym HUD will be ready to update as
     soon as your current session is finished and your changes are
     saved.") instead of reloading — the asynchronous safety gate
     (`isSafeToApply`) and the synchronous last-moment reload guard
     (`setReloadGuard`) both refuse the swap while the bout is live.
C25. Finish the bout and session and let the outbox drain. Confirm the
     banner returns to the ready message on its own, and this time
     pressing `Update now` reloads the page. After reload, confirm
     DevTools → Application → Cache Storage shows a new
     `gym-hud-shell-<hash>` name.
C26. Repeat C22–C24 with a bout running and one pending outbox mutation,
     but instead of finishing the session, fully terminate the app process
     while the update is still staged, then cold-reopen. Confirm the bout
     and the pending mutation are exactly as left — a staged update that is
     never applied never touches anything, closing the app included.

## Results

Run metadata:

| Run | Device | Android version | Chrome version | Build version | Date | Tester |
|---|---|---|---|---|---|---|
| 1 | Xiaomi Redmi Note 13 Pro+ | NOT YET RUN | NOT YET RUN | NOT YET RUN | NOT YET RUN | NOT YET RUN |

"Build version" is the service worker's own cache name, `gym-hud-shell-<hash>`
(DevTools → Application → Cache Storage, or
`navigator.serviceWorker.getRegistrations()` in the console) — the closest
thing this app has to a version string today, since no separate build-version
display exists in the UI.

Per-step results (Run 1):

| Step | Part | Description | Result | Notes |
|---|---|---|---|---|
| 1 | A | Build frontend, start preview stack | NOT YET RUN | |
| 2 | A | Extract and trust the Caddy CA on the phone | NOT YET RUN | |
| 3 | A | Manifest detected, install offered, SW activated | NOT YET RUN | |
| 4 | A | Install to home screen; icon and label correct | NOT YET RUN | |
| 5 | A | Standalone launch (no browser chrome) | NOT YET RUN | |
| 6 | A | Sign in online | NOT YET RUN | |
| 7 | A | Enable Airplane Mode | NOT YET RUN | |
| 8 | A | Force-stop the app process | NOT YET RUN | |
| 9 | A | Cold-start offline | NOT YET RUN | |
| 10 | A | Shell loads offline; reaches `unverified`; Home renders | NOT YET RUN | |
| 11 | A | Reconnect; reconciles to `authenticated` automatically | NOT YET RUN | |
| B1 | B | PAD start screen with inherited or default settings | NOT YET RUN | |
| B2 | B | `Start` then `Start walking`; Bout 1 counting | NOT YET RUN | |
| B3 | B | Phone locked at least five minutes | NOT YET RUN | |
| B4 | B | Duration matches real elapsed time after unlock (PAD-01) | NOT YET RUN | |
| B5 | B | Bout started/continued offline, state visible | NOT YET RUN | |
| B6 | B | Force-stop the app process with a bout running | NOT YET RUN | |
| B7 | B | Cold-start offline | NOT YET RUN | |
| B8 | B | `Resume PAD Walking` shows `Walking · Bout N` and correct elapsed (PAD-02) | NOT YET RUN | |
| B9 | B | PAD screen resumes the same bout; session finished | NOT YET RUN | |
| — | B | Cached reference data survives offline reopen | BLOCKED | no screen reads the pulled `pad_defaults`/`pad_next_session_settings` cache back yet (not a backend limitation — issue #19/#20 shipped that) |
| C1 | C | Start Bout 1 | NOT YET RUN | |
| C2 | C | Pause; paused ≥ 2 minutes | NOT YET RUN | |
| C3 | C | Force-stop, cold-start offline | NOT YET RUN | |
| C4 | C | Home shows `Paused · Bout 1` with correct elapsed | NOT YET RUN | |
| C5 | C | Resume; effective walking time excludes the pause (PAD-08) | NOT YET RUN | |
| C6 | C | Force-stop/cold-start with rest open; `Start next bout` offered and closes the rest atomically (PAD-06) | NOT YET RUN | |
| C7 | C | Start Bout 1 offline | NOT YET RUN | |
| C8 | C | Finish bout into rest, offline | NOT YET RUN | |
| C9 | C | Record pain 3–4, offline | NOT YET RUN | |
| C10 | C | Start next bout, offline | NOT YET RUN | |
| C11 | C | Reload offline; state persisted (PAD-03) | NOT YET RUN | |
| C12 | C | Enumerate the expected offline mutations (six, per script) | NOT YET RUN | |
| C13 | C | Reconnect; outbox drains with no manual re-entry (PAD-04) | NOT YET RUN | |
| C14 | C | Server-side check: applied count matches C12's enumeration; never two rows for one press | NOT YET RUN | |
| C15 | C | Start session with a 30-second maximum bout | NOT YET RUN | |
| C16 | C | Maximum exceeded; HUD alerts, bout not auto-terminated (PAD-07) | NOT YET RUN | |
| C17 | C | Sign in online, then start + pause offline (queue three mutations) | NOT YET RUN | |
| C18 | C | Invalidate session server-side (`ensure_app_user --reset-password`) | NOT YET RUN | |
| C19 | C | Reconnect; app reaches `expired`, banner shown | NOT YET RUN | |
| C20 | C | Local data and outbox survive the expiry untouched | NOT YET RUN | |
| C21 | C | Re-authenticate; queue drains, no duplicates | NOT YET RUN | |
| C22 | C | Deploy a changed build while a bout is active | NOT YET RUN | |
| C23 | C | Update banner appears; no auto-reload | NOT YET RUN | |
| C24 | C | "Update now" deferred while the bout is live | NOT YET RUN | |
| C25 | C | Update applies once idle; new cache name active | NOT YET RUN | |
| C26 | C | Bout and pending outbox survive a force-stop with the update staged | NOT YET RUN | |
| — | C | PAD-09 manual time correction | BLOCKED | depends on issue #22 / PR #43 (unmerged) — see `docs/pad-pilot-validation.md` |

An unrun step must never be recorded as `PASS`. If a step is executed and
fails, record `FAIL` with a note, not `NOT YET RUN` and not a silent skip.
