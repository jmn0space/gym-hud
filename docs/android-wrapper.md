# Android wrapper

The PWA can't put a ticking walking timer with buttons on the lock screen
without playing audio, and playing audio pauses whatever music or podcast is
already running. The wrapper is a Capacitor shell (`frontend/android/`) whose
only native feature is the walking notification
(`WalkingNotificationPlugin.java`). It shows the bout, pause or rest timer,
which Android itself ticks, plus the total walking minutes and the
Pause/Resume/Finish bout/Start next bout buttons. It doesn't touch audio focus.

The wrapper loads the deployed site (`GYM_HUD_URL`) instead of a bundled copy,
so login, CSRF, sync and the service worker work exactly as they do in the
PWA, and deploying the site still updates the app. Rebuild the APK only when
something under `frontend/android/` changes.

## Build

Needs JDK 21 and the Android SDK (`ANDROID_HOME`, platform 36).

```bash
cd frontend
npm run build
GYM_HUD_URL=https://your-host npx cap sync android
cd android && ./gradlew assembleDebug
```

Install `android/app/build/outputs/apk/debug/app-debug.apk` on the phone
(`adb install -r …`, or copy it over and open it).

### Developing against this machine

Run the Docker preview stack (README, "Docker preview quick start") with
`PREVIEW_HOST` set to this machine's LAN IP, install its Caddy CA on the phone
the way that section describes, and build with
`GYM_HUD_URL=https://<that IP>`. Debug builds trust user-installed CAs
(`res/xml/network_security_config.xml`); release builds don't. If DHCP gives
the machine a new IP, update both values and rebuild.

## Phone settings (Xiaomi / HyperOS)

Menu names vary by version.

- Allow notifications when the app first asks, and set **Lock screen
  notifications** to show for Gym HUD.
- App info → Battery saver → **No restrictions**, and turn on **Autostart**.
  Otherwise MIUI may kill the app mid-session and the buttons stop answering.

## Limits

- The notification follows the PAD page. If you navigate elsewhere in the app,
  it disappears until you come back.
- The plain PWA in Chrome shows no lock-screen controls.
