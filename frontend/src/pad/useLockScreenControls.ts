import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { useEffect, useRef } from "react";

import { formatDuration } from "../components/TimerDisplay";
import { hasReachedMaximum, totalWalkingMs, walkingElapsedMs, type PadSessionView } from "./session";

export type LockScreenCommand = "start" | "pause" | "resume" | "finish" | "next";

export interface WalkingNotificationContent {
  title: string;
  text: string;
  /** Epoch ms Android's chronometer counts up from, or null for no timer. */
  chronometerBase: number | null;
  actions: { id: LockScreenCommand; title: string }[];
}

interface WalkingNotificationPlugin {
  show(content: WalkingNotificationContent): Promise<void>;
  hide(): Promise<void>;
  addListener(
    event: "action",
    listener: (event: { id: LockScreenCommand }) => void,
  ): Promise<PluginListenerHandle>;
}

/** Native only: the Android wrapper's WalkingNotificationPlugin.java. */
const WalkingNotification = registerPlugin<WalkingNotificationPlugin>("WalkingNotification");

/**
 * What the lock screen shows for an open session. The timer is the same one the
 * HUD shows for that state (bout walking time, pause, or rest), expressed as a
 * start instant so Android can tick it without the app running every second.
 */
export function walkingNotificationContent(
  view: PadSessionView,
  now: number,
): WalkingNotificationContent | null {
  const total = `Total walking ${Math.floor(totalWalkingMs(view, now) / 60_000).toString()} min`;
  const bout = view.currentBout;
  const boutTitle = `Bout ${view.currentBoutNumber.toString()}`;
  switch (view.state) {
    case "READY":
      return { title: `${boutTitle} · Ready`, text: total, chronometerBase: null, actions: [{ id: "start", title: "Start walking" }] };
    case "WALKING":
      if (bout === null) return null;
      return {
        title: `${boutTitle} · Walking${hasReachedMaximum(view, now) ? " · Maximum reached" : ""}`,
        text: `Max ${formatDuration(view.session.max_bout_seconds * 1000)} · ${total}`,
        chronometerBase: now - walkingElapsedMs(bout, view.pauses, now),
        actions: [{ id: "pause", title: "Pause" }, { id: "finish", title: "Finish bout" }],
      };
    case "PAUSED":
      if (bout === null || view.currentPause === null) return null;
      return {
        title: `${boutTitle} · Paused`,
        text: `Walked ${formatDuration(walkingElapsedMs(bout, view.pauses, now))} · ${total}`,
        chronometerBase: Date.parse(view.currentPause.started_at),
        actions: [{ id: "resume", title: "Resume" }, { id: "finish", title: "Finish bout" }],
      };
    case "RESTING":
      return {
        title: `Rest after bout ${(bout?.bout_number ?? view.currentBoutNumber).toString()}`,
        text: total,
        chronometerBase: view.currentRest === null ? null : Date.parse(view.currentRest.started_at),
        actions: [{ id: "next", title: "Start next bout" }],
      };
    case "COMPLETED":
      return null;
  }
}

/**
 * Mirrors the open walking session onto an Android notification (lock screen and
 * shade) and routes its buttons to `onCommand`. A no-op outside the Android
 * wrapper: the PWA has no way to do this without taking over the phone's audio.
 */
export function useLockScreenControls(
  view: PadSessionView | null,
  now: number,
  onCommand: (command: LockScreenCommand) => void,
): void {
  const native = Capacitor.isNativePlatform();
  const commandRef = useRef(onCommand);
  useEffect(() => {
    commandRef.current = onCommand;
  });

  // Serialized so a tick that changes nothing visible (the chronometer moves on its
  // own; the total only changes per minute) does not re-post the notification.
  const content = view === null ? null : walkingNotificationContent(view, now);
  const serialized = content === null ? null : JSON.stringify(content);

  useEffect(() => {
    if (!native) return;
    const handle = WalkingNotification.addListener("action", ({ id }) => {
      commandRef.current(id);
    });
    return () => {
      void handle.then((listener) => listener.remove());
      void WalkingNotification.hide();
    };
  }, [native]);

  useEffect(() => {
    if (!native) return;
    if (serialized === null) {
      void WalkingNotification.hide();
    } else {
      void WalkingNotification.show(JSON.parse(serialized) as WalkingNotificationContent);
    }
  }, [native, serialized]);
}
