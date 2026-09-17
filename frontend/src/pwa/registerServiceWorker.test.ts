import { describe, expect, it, vi } from "vitest";

import { createServiceWorkerUpdates, SKIP_WAITING_MESSAGE } from "./registerServiceWorker";

/**
 * jsdom has no `navigator.serviceWorker`, so the container, registration and worker
 * are all built here. Each is a minimal event target with the handful of members
 * `createServiceWorkerUpdates` actually touches.
 */
function createEventHub() {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  return {
    addEventListener: (type: string, listener: (event: Event) => void) => {
      const existing = listeners.get(type) ?? new Set<(event: Event) => void>();
      existing.add(listener);
      listeners.set(type, existing);
    },
    removeEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    },
    emit: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) {
        listener(new Event(type));
      }
    },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  };
}

type FakeWorker = ReturnType<typeof createFakeWorker>;

function createFakeWorker(state: ServiceWorkerState = "installing") {
  const hub = createEventHub();
  const worker = {
    state,
    postMessage: vi.fn(),
    addEventListener: hub.addEventListener,
    removeEventListener: hub.removeEventListener,
    listenerCount: hub.listenerCount,
    transitionTo: (next: ServiceWorkerState) => {
      worker.state = next;
      hub.emit("statechange");
    },
  };
  return worker;
}

function createFakeRegistration() {
  const hub = createEventHub();
  return {
    installing: null as FakeWorker | null,
    waiting: null as FakeWorker | null,
    addEventListener: hub.addEventListener,
    removeEventListener: hub.removeEventListener,
    emit: hub.emit,
  };
}

function createFakeContainer(
  registration: ReturnType<typeof createFakeRegistration>,
  controller: FakeWorker | null,
) {
  const hub = createEventHub();
  return {
    controller,
    register: vi.fn(() => Promise.resolve(registration)),
    addEventListener: hub.addEventListener,
    removeEventListener: hub.removeEventListener,
    emit: hub.emit,
  };
}

interface Harness {
  controller?: FakeWorker | null;
  register?: () => Promise<unknown>;
  canReload?: () => boolean;
}

function harness({ controller = createFakeWorker("activated"), register, canReload }: Harness = {}) {
  const registration = createFakeRegistration();
  const container = createFakeContainer(registration, controller);
  if (register !== undefined) {
    container.register = vi.fn(register) as typeof container.register;
  }
  const reload = vi.fn();
  const updates = createServiceWorkerUpdates({
    container: container as unknown as ServiceWorkerContainer,
    reload,
    canReload,
  });
  return { container, registration, reload, updates };
}

/** Drives a fresh worker through `updatefound` -> `installed`. */
function installNewWorker(
  registration: ReturnType<typeof createFakeRegistration>,
): FakeWorker {
  const worker = createFakeWorker("installing");
  registration.installing = worker;
  registration.emit("updatefound");
  worker.transitionTo("installed");
  return worker;
}

describe("createServiceWorkerUpdates", () => {
  it("no-ops when the browser has no service-worker support", async () => {
    vi.stubGlobal("navigator", {});
    const reload = vi.fn();
    const updates = createServiceWorkerUpdates({ reload });

    await expect(updates.register()).resolves.toBeNull();
    expect(updates.isUpdateReady()).toBe(false);
    // Nothing is waiting, so this must not throw either.
    expect(() => { updates.applyUpdate(); }).not.toThrow();
    expect(reload).not.toHaveBeenCalled();
  });

  it("no-ops when registration rejects", async () => {
    const { updates, reload } = harness({
      register: () => Promise.reject(new Error("SecurityError: insecure context")),
    });

    await expect(updates.register()).resolves.toBeNull();
    expect(updates.isUpdateReady()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("registers /sw.js at the root scope exactly once", async () => {
    const { container, updates } = harness();

    await updates.register();
    await updates.register();

    expect(container.register).toHaveBeenCalledTimes(1);
    expect(container.register).toHaveBeenCalledWith("/sw.js", {
      type: "module",
      scope: "/",
      updateViaCache: "none",
    });
  });

  it("surfaces an update when a worker installs while a controller is in charge", async () => {
    const { registration, updates } = harness();
    const notified = vi.fn();
    updates.subscribe(notified);
    await updates.register();

    expect(updates.isUpdateReady()).toBe(false);
    installNewWorker(registration);

    expect(updates.isUpdateReady()).toBe(true);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("stays silent on a first install, when no worker controls the page yet", async () => {
    const { registration, updates } = harness({ controller: null });
    await updates.register();

    installNewWorker(registration);

    expect(updates.isUpdateReady()).toBe(false);
  });

  it("adopts a worker that was already waiting from an earlier visit", async () => {
    const { container, registration, updates } = harness();
    registration.waiting = createFakeWorker("installed");

    await updates.register();

    expect(updates.isUpdateReady()).toBe(true);
    expect(container.register).toHaveBeenCalledTimes(1);
  });

  it("surfaces an update that was already installing when registration resolved", async () => {
    // A navigation to a controlled page makes the browser start its own soft update
    // of /sw.js before `load` fires, so `updatefound` can be long gone by the time
    // `register()` resolves and nothing is waiting yet.
    const { registration, updates } = harness();
    const worker = createFakeWorker("installing");
    registration.installing = worker;

    await updates.register();
    expect(updates.isUpdateReady()).toBe(false);

    worker.transitionTo("installed");

    expect(updates.isUpdateReady()).toBe(true);
  });

  it("keeps following a worker after it installs, so the offer can still be retracted", async () => {
    const { registration, updates } = harness();
    await updates.register();

    const worker = installNewWorker(registration);

    expect(updates.isUpdateReady()).toBe(true);
    // A worker that has installed can still go redundant or activate, and both end
    // the offer -- so the listener must survive the install.
    expect(worker.listenerCount("statechange")).toBe(1);
  });

  it("retracts the offer when the waiting worker activates under another tab", async () => {
    const { container, registration, updates } = harness();
    const notified = vi.fn();
    updates.subscribe(notified);
    await updates.register();
    const worker = installNewWorker(registration);
    expect(updates.isUpdateReady()).toBe(true);

    // Another tab pressed "Update now": the worker skips waiting and claims clients.
    container.controller = worker;
    worker.transitionTo("activated");

    expect(updates.isUpdateReady()).toBe(false);
    expect(worker.listenerCount("statechange")).toBe(0);
    expect(notified).toHaveBeenCalledTimes(2);
  });

  it("retracts the offer when the waiting worker goes redundant", async () => {
    const { registration, updates } = harness();
    await updates.register();
    const worker = installNewWorker(registration);
    expect(updates.isUpdateReady()).toBe(true);

    // A rollback replaced the deployed worker before anyone applied this one.
    worker.transitionTo("redundant");

    expect(updates.isUpdateReady()).toBe(false);
    expect(worker.listenerCount("statechange")).toBe(0);
  });

  it("retracts the offer when a worker adopted at registration goes redundant", async () => {
    const { registration, updates } = harness();
    const worker = createFakeWorker("installed");
    registration.waiting = worker;
    await updates.register();
    expect(updates.isUpdateReady()).toBe(true);

    worker.transitionTo("redundant");

    expect(updates.isUpdateReady()).toBe(false);
  });

  it("stops listening to a worker that goes redundant instead", async () => {
    const { registration, updates } = harness();
    await updates.register();

    const worker = createFakeWorker("installing");
    registration.installing = worker;
    registration.emit("updatefound");
    worker.transitionTo("redundant");

    expect(worker.listenerCount("statechange")).toBe(0);
    expect(updates.isUpdateReady()).toBe(false);
  });

  it("posts SKIP_WAITING and reloads exactly once on controllerchange", async () => {
    const { container, registration, reload, updates } = harness();
    await updates.register();
    const worker = installNewWorker(registration);

    updates.applyUpdate();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: SKIP_WAITING_MESSAGE });

    container.emit("controllerchange");
    container.emit("controllerchange");

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload on a controllerchange this page never asked for", async () => {
    const { container, registration, reload, updates } = harness();
    await updates.register();
    installNewWorker(registration);

    // Another tab applied the update, or this is the first install claiming clients.
    container.emit("controllerchange");

    expect(reload).not.toHaveBeenCalled();
  });

  it("leaves no dead Update button in a second tab when the first tab applies", async () => {
    // Both tabs are controlled and both show the banner. The shared worker object
    // stands in for the one worker both registrations are looking at.
    const worker = createFakeWorker("installed");
    const tabA = harness();
    const tabB = harness();
    tabA.registration.waiting = worker;
    tabB.registration.waiting = worker;
    await tabA.updates.register();
    await tabB.updates.register();
    expect(tabA.updates.isUpdateReady()).toBe(true);
    expect(tabB.updates.isUpdateReady()).toBe(true);

    tabA.updates.applyUpdate();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);

    // `skipWaiting()` lands: the worker activates and claims both pages.
    tabA.container.controller = worker;
    tabB.container.controller = worker;
    worker.transitionTo("activated");
    tabA.container.emit("controllerchange");
    tabB.container.emit("controllerchange");

    expect(tabA.reload).toHaveBeenCalledTimes(1);
    // Tab B must not be reloaded out from under whatever it is doing...
    expect(tabB.reload).not.toHaveBeenCalled();
    // ...and its banner must not survive as a button that can no longer do anything.
    expect(tabB.updates.isUpdateReady()).toBe(false);

    // If tab B does ask anyway, it reloads instead of posting SKIP_WAITING into the
    // void and waiting for a `controllerchange` that can never fire again.
    tabB.updates.applyUpdate();

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(tabB.reload).toHaveBeenCalledTimes(1);
  });

  it("stands down instead of reloading when the guard reports live work", async () => {
    let live = false;
    const { container, registration, reload, updates } = harness({ canReload: () => !live });
    await updates.register();
    const worker = installNewWorker(registration);

    updates.applyUpdate();
    // The user starts a session while the worker is still waking up and activating.
    live = true;
    container.controller = worker;
    worker.transitionTo("activated");
    container.emit("controllerchange");

    expect(reload).not.toHaveBeenCalled();
    // The update is still applicable -- by reload -- once the user asks again.
    expect(updates.isUpdateReady()).toBe(true);

    live = false;
    updates.applyUpdate();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("uses the guard installed with setReloadGuard", async () => {
    const { container, registration, reload, updates } = harness();
    await updates.register();
    installNewWorker(registration);
    updates.setReloadGuard(() => false);

    updates.applyUpdate();
    container.emit("controllerchange");
    expect(reload).not.toHaveBeenCalled();

    updates.setReloadGuard(null);
    updates.applyUpdate();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("notifies and un-notifies subscribers", async () => {
    const { registration, updates } = harness();
    const listener = vi.fn();
    const unsubscribe = updates.subscribe(listener);
    await updates.register();

    unsubscribe();
    installNewWorker(registration);

    expect(listener).not.toHaveBeenCalled();
    expect(updates.isUpdateReady()).toBe(true);
  });
});
