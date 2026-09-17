# Device smoke tests

[← Documentation index](README.md) · [Architecture](architecture.md) · [Data & sync](data-sync.md) · [Acceptance criteria](acceptance-tests.md)

This is the real-device evidence record for acceptance criterion 5 of issue
#17 ("Record a real-device installation/offline-reopen smoke result").
Target device: **Xiaomi Redmi Note 13 Pro+ / Android** (`docs/architecture.md`,
"Primary target device").

**Honesty statement.** No one has run this procedure on hardware yet. Every
row in the [Results](#results) table below is marked `NOT YET RUN`. This
document specifies exactly what to do and what to check; it does not claim
any of it has happened. Do not change a result to a passing value without
actually performing that step on the named device and recording who did it
and when.

## Scope

This procedure has two parts.

- **Part A — installation and offline reopen.** Fully specified and runnable
  today with only what issue #17 adds: the manifest, icons, service worker,
  and the Docker preview workflow. This is the part acceptance criterion 5
  and the "Force-stop the installed PWA/browser process, reopen it..." item
  in [`docs/acceptance-tests.md`](acceptance-tests.md#follow-up-android-and-synchronization-checklist)
  need.
- **Part B — PAD-02 and cached reference data.** Cannot be genuinely
  exercised yet. PAD-02 (see `docs/acceptance-tests.md`, "PAD-02 —
  Application termination") needs an active walking bout to already exist on
  the device, which needs PAD walking controls — a separate, not-yet-implemented
  issue (`frontend/src/pages/PadPage.tsx` is currently an explicit "Not
  available yet" stub). Confirming cached reference data survives an offline
  reopen needs something to have actually written that cache, which needs the
  backend synchronization contract (issue #13) — there is no sync engine yet
  (see [Data & synchronization: sync gate](data-sync.md#sync-gate)). Both
  remain out of scope for this smoke test and are recorded as blocked, not
  attempted. Re-run Part B once its blocking issue ships.

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

### Part B — blocked; do not attempt yet

- Confirming `Resume PAD Walking` appears with the correct WALKING/PAUSED/
  RESTING state after step 9 above (PAD-02, and the "active-session
  presence" and "current PAD walking/pause/rest state" clauses of the
  Overall v1 continuity criterion in `docs/acceptance-tests.md`) requires an
  active walking bout to exist before step 7. There is no UI to create one
  yet. Re-run steps 6–10 once PAD controls ship, starting a bout between
  steps 6 and 7.
- Confirming cached reference data survives the same offline reopen requires
  something to have written that cache first, which requires the backend
  synchronization contract (issue #13). Re-run once that exists.

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
| — | B | `Resume PAD Walking` with correct state (PAD-02) | BLOCKED | needs PAD controls (separate issue) |
| — | B | Cached reference data survives offline reopen | BLOCKED | needs backend sync contract (issue #13) |

An unrun step must never be recorded as `PASS`. If a step is executed and
fails, record `FAIL` with a note, not `NOT YET RUN` and not a silent skip.
