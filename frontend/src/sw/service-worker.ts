/**
 * Service-worker build entry. Vite emits this as an unhashed `/sw.js` at the site
 * root so its scope is `/` and the browser can keep updating the same URL.
 *
 * `self.__GYM_HUD_BUILD__` is prepended to this chunk by the inline precache plugin
 * in `vite.config.ts`; the logic itself lives in `./runtime` so it stays testable.
 */

import { createServiceWorkerRuntime, parseInjectedBuild } from "./runtime";

const scope = globalThis as unknown as ServiceWorkerGlobalScope & {
  __GYM_HUD_BUILD__?: unknown;
};

createServiceWorkerRuntime(scope, parseInjectedBuild(scope.__GYM_HUD_BUILD__));
