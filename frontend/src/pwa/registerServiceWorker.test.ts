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
}

function harness({ controller = createFakeWorker("activated"), register }: Harness = {}) {
  const registration = createFakeRegistration();
  const container = createFakeContainer(registration, controller);
  if (register !== undefined) {
    container.register = vi.fn(register) as typeof container.register;
  }
  const reload = vi.fn();
  const updates = createServiceWorkerUpdates({
    container: container as unknown as ServiceWorkerContainer,
    reload,
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

  it("stops listening to a worker once it has installed", async () => {
    const { registration, updates } = harness();
    await updates.register();

    const worker = installNewWorker(registration);

    expect(worker.listenerCount("statechange")).toBe(0);
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
