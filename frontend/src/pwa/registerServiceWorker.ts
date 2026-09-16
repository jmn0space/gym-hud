/**
 * Service-worker registration and the update-readiness store the UI subscribes to.
 *
 * Everything here is a no-op rather than a failure when service workers are
 * unavailable -- jsdom, a private window, or any non-secure context (decision D3).
 * Nothing in this module reaches for `navigator` until `register()` is called, so
 * importing it is always safe.
 */

/** Built by Vite to the site root, so its scope is `/`. Must stay unhashed. */
export const SERVICE_WORKER_URL = "/sw.js";
/** Matches `SKIP_WAITING_MESSAGE` in `src/sw/runtime.ts`. */
export const SKIP_WAITING_MESSAGE = "SKIP_WAITING";

export interface ServiceWorkerUpdates {
  /** Subscribes to update-readiness changes; the return value unsubscribes. */
  readonly subscribe: (listener: () => void) => () => void;
  /** True once a newer worker is waiting *and* an older one is already in control. */
  readonly isUpdateReady: () => boolean;
  /** Asks the waiting worker to take over. A no-op when nothing is waiting. */
  readonly applyUpdate: () => void;
  /** Resolves to `null` when registration is impossible or rejected. */
  readonly register: () => Promise<ServiceWorkerRegistration | null>;
}

export interface ServiceWorkerUpdatesOptions {
  scriptUrl?: string | undefined;
  /** Injected by tests; production resolves `navigator.serviceWorker` lazily. */
  container?: ServiceWorkerContainer | undefined;
  reload?: (() => void) | undefined;
}

export function createServiceWorkerUpdates(
  options: ServiceWorkerUpdatesOptions = {},
): ServiceWorkerUpdates {
  const scriptUrl = options.scriptUrl ?? SERVICE_WORKER_URL;
  const reload = options.reload ?? (() => { window.location.reload(); });
  const listeners = new Set<() => void>();

  let waiting: ServiceWorker | null = null;
  let updateReady = false;
  /** Set only by `applyUpdate`, so this tab never reloads over work it did not stage. */
  let applyRequested = false;
  let reloaded = false;
  let registration: Promise<ServiceWorkerRegistration | null> | null = null;

  function resolveContainer(): ServiceWorkerContainer | null {
    if (options.container !== undefined) {
      return options.container;
    }
    if (typeof navigator === "undefined") {
      return null;
    }
    // `Navigator.serviceWorker` is non-optional in the DOM types but genuinely
    // absent in jsdom and in insecure contexts.
    const container = (navigator as Partial<Navigator>).serviceWorker;
    return container ?? null;
  }

  function markUpdateReady(worker: ServiceWorker): void {
    if (updateReady && waiting === worker) {
      return;
    }
    waiting = worker;
    updateReady = true;
    for (const listener of [...listeners]) {
      listener();
    }
  }

  function watchInstallingWorker(
    container: ServiceWorkerContainer,
    active: ServiceWorkerRegistration,
  ): void {
    const installing = active.installing;
    if (installing === null) {
      return;
    }
    const onStateChange = () => {
      if (installing.state === "installed") {
        installing.removeEventListener("statechange", onStateChange);
        // No controller means this is a first install: the page is already running
        // exactly the version that just finished caching, so there is nothing to
        // offer the user and nothing to reload for.
        if (container.controller !== null) {
          markUpdateReady(installing);
        }
      } else if (installing.state === "redundant") {
        installing.removeEventListener("statechange", onStateChange);
      }
    };
    installing.addEventListener("statechange", onStateChange);
  }

  function handleControllerChange(): void {
    // Exactly one reload, and only for an update this tab asked for. Another tab
    // activating a worker must never yank the page out from under live work.
    if (!applyRequested || reloaded) {
      return;
    }
    reloaded = true;
    reload();
  }

  async function startRegistration(): Promise<ServiceWorkerRegistration | null> {
    const container = resolveContainer();
    if (container === null) {
      return null;
    }

    let active: ServiceWorkerRegistration;
    try {
      active = await container.register(scriptUrl, {
        // The built `sw.js` is an ES module chunk, so the registration type has to
        // match it. `updateViaCache: "none"` keeps the browser from serving the
        // worker script itself out of the HTTP cache.
        type: "module",
        scope: "/",
        updateViaCache: "none",
      });
    } catch {
      return null;
    }

    container.addEventListener("controllerchange", handleControllerChange);
    if (active.waiting !== null && container.controller !== null) {
      // A previous visit already staged an update that was never applied.
      markUpdateReady(active.waiting);
    }
    active.addEventListener("updatefound", () => {
      watchInstallingWorker(container, active);
    });
    return active;
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isUpdateReady: () => updateReady,
    applyUpdate: () => {
      const worker = waiting;
      if (worker === null) {
        return;
      }
      applyRequested = true;
      worker.postMessage({ type: SKIP_WAITING_MESSAGE });
    },
    register: () => {
      registration ??= startRegistration();
      return registration;
    },
  };
}

/** The instance `main.tsx` registers and the update banner subscribes to. */
export const serviceWorkerUpdates: ServiceWorkerUpdates = createServiceWorkerUpdates();

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  return serviceWorkerUpdates.register();
}
