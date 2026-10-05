import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The Android wrapper exists only for the native walking notification (lock
 * screen timers and buttons, docs/android-wrapper.md). It loads the deployed site
 * itself rather than a bundled copy, so login cookies, CSRF and the service worker
 * stay same-origin exactly as in the PWA, and a deploy still updates the app.
 */
const url = process.env.GYM_HUD_URL;

const config: CapacitorConfig = {
  appId: "app.gymhud",
  appName: "Gym HUD",
  webDir: "dist",
  server: url === undefined ? undefined : { url, cleartext: url.startsWith("http:") },
};

export default config;
