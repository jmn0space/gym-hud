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
  /**
   * Applies the staged update: asks the waiting worker to take over, or -- when the
   * new worker has already activated and no further `controllerchange` can fire --
   * reloads straight away. A no-op when there is nothing staged.
   *
   * The caller is responsible for deciding that applying is safe *before* calling
   * this; see `AppUpdateBanner.isSafeToApply`.
   */
  readonly applyUpdate: () => void;
  /**
   * Installs the last-moment guard consulted immediately before the page is
   * reloaded, after the new worker has activated. It exists because everything
   * between `applyUpdate()` and `controllerchange` is asynchronous (worker wake-up,
   * `skipWaiting`, cache pruning, `clients.claim`), and the user can start live work
   * inside that window. Passing `null` removes the guard.
   */
  readonly setReloadGuard: (guard: (() => boolean) | null) => void;
  /** Resolves to `null` when registration is impossible or rejected. */
  readonly register: () => Promise<ServiceWorkerRegistration | null>;
}

export interface ServiceWorkerUpdatesOptions {
  scriptUrl?: string | undefined;
  /** Injected by tests; production resolves `navigator.serviceWorker` lazily. */
  container?: ServiceWorkerContainer | undefined;
  reload?: (() => void) | undefined;
  /** Initial value of the reload guard; `setReloadGuard` replaces it. */
  canReload?: (() => boolean) | undefined;
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
  /**
   * True once the worker this tab was offering has taken control -- because another
   * tab applied the update, or because our own `SKIP_WAITING` landed. Tracked apart
   * from `applyRequested` because it changes what "apply" *means*: `skipWaiting()` on
   * a worker that is already the controller is a no-op and no second
   * `controllerchange` can ever fire, so the only way left to apply is to reload.
   */
  let controllerMoved = false;
  let reloaded = false;
  let canReload: (() => boolean) | null = options.canReload ?? null;
  let registration: Promise<ServiceWorkerRegistration | null> | null = null;
  /** Workers already carrying a `statechange` listener, so none is attached twice. */
  const tracked = new WeakSet<ServiceWorker>();

  function notify(): void {
    for (const listener of [...listeners]) {
      listener();
    }
  }

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

  function isReloadAllowed(): boolean {
    if (canReload === null) {
      return true;
    }
    try {
      return canReload();
    } catch {
      // A guard that cannot answer is treated as "not safe", the same way the
      // asynchronous gate in the banner treats a failed read.
      return false;
    }
  }

  function markUpdateReady(worker: ServiceWorker): void {
    // A freshly waiting worker means `SKIP_WAITING` is the right move again, whatever
    // an earlier controller change left behind.
    controllerMoved = false;
    if (updateReady && waiting === worker) {
      return;
    }
    waiting = worker;
    updateReady = true;
    notify();
  }

  /**
   * Called when the worker this tab was offering leaves the `installed` state, which
   * always means the offer is over: it either activated (only a reload applies it
   * now) or went redundant (a rollback or a newer worker superseded it). Either way
   * `waiting` must stop pointing at it, or "Update now" becomes a button that posts
   * `SKIP_WAITING` into the void forever.
   */
  function retireWaitingWorker(worker: ServiceWorker): void {
    if (waiting !== worker) {
      return;
    }
    waiting = null;
    if (worker.state !== "redundant") {
      controllerMoved = true;
      if (applyRequested) {
        // This tab staged the update and it has now taken over. The banner stays up
        // until `handleControllerChange` has decided whether reloading is safe.
        return;
      }
    }
    if (!updateReady) {
      return;
    }
    updateReady = false;
    notify();
  }

  function evaluateWorkerState(
    container: ServiceWorkerContainer,
    worker: ServiceWorker,
    onStateChange: () => void,
  ): void {
    if (worker.state === "installing") {
      return;
    }
    if (worker.state === "installed") {
      // No controller means this is a first install: the page is already running
      // exactly the version that just finished caching, so there is nothing to offer
      // the user and nothing to reload for. The listener stays attached either way --
      // a worker can still go redundant (rollback) or activate (another tab applied
      // the update) from here, and both have to retract the offer.
      if (container.controller !== null) {
        markUpdateReady(worker);
      }
      return;
    }
    worker.removeEventListener("statechange", onStateChange);
    tracked.delete(worker);
    retireWaitingWorker(worker);
  }

  /**
   * Follows one worker for its whole life, from `installing` (or wherever it already
   * is) to `activated`/`redundant`. Every worker this store may offer goes through
   * here -- the one found `installing` or `waiting` at registration time just as much
   * as the one announced by `updatefound`.
   */
  function watchWorker(container: ServiceWorkerContainer, worker: ServiceWorker): void {
    if (tracked.has(worker)) {
      return;
    }
    tracked.add(worker);
    const onStateChange = () => {
      evaluateWorkerState(container, worker, onStateChange);
    };
    worker.addEventListener("statechange", onStateChange);
    // The worker may already be past `installing` by the time we get here.
    evaluateWorkerState(container, worker, onStateChange);
  }

  function handleControllerChange(): void {
    // Whoever triggered it, a controller change means the worker we were offering is
    // no longer waiting, so `SKIP_WAITING` would land on a worker that is already in
    // charge. A first install claiming this page had nothing to offer in the first
    // place, so it must not arm the "apply by reload" path.
    const hadOffer = updateReady || applyRequested;
    waiting = null;
    if (hadOffer) {
      controllerMoved = true;
    }

    if (!applyRequested) {
      // Another tab activated the update, or a first install claimed this page.
      // Reloading here would yank the page out from under live work this tab knows
      // nothing about -- but leaving the banner up would leave a button whose message
      // can no longer do anything, so retract the offer instead.
      if (updateReady) {
        updateReady = false;
        notify();
      }
      return;
    }
    if (reloaded) {
      return;
    }
    if (!isReloadAllowed()) {
      // Live work appeared between `applyUpdate()` and the activation. Stand down and
      // leave the banner up: the update is still applicable, by reload, whenever the
      // user next asks and the gate agrees.
      applyRequested = false;
      notify();
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
    active.addEventListener("updatefound", () => {
      const installing = active.installing;
      if (installing !== null) {
        watchWorker(container, installing);
      }
    });
    if (active.waiting !== null) {
      // A previous visit already staged an update that was never applied.
      watchWorker(container, active.waiting);
    }
    if (active.installing !== null) {
      // The browser started its own soft update at navigation time, before this
      // registration resolved, so `updatefound` has already fired and nothing is
      // waiting yet. Without this the update would go unannounced for the whole
      // session.
      watchWorker(container, active.installing);
    }
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
    setReloadGuard: (guard) => {
      canReload = guard;
    },
    applyUpdate: () => {
      if (reloaded) {
        return;
      }
      if (controllerMoved) {
        // The new worker already controls the page: `skipWaiting()` is a no-op and no
        // further `controllerchange` will ever arrive, so reload directly rather than
        // waiting for an event that cannot recur. The caller has already decided this
        // is safe.
        reloaded = true;
        reload();
        return;
      }
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
