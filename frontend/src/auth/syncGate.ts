import { useAuth, type AuthStatus } from "./AuthProvider";

/**
 * The single gate a future sync engine (issue #13) must consult before
 * attempting network synchronization: only while the session is confirmed
 * valid AND the device is online. "unverified" (offline continuation) and
 * "expired" both pause sync -- pending outbox entries stay queued, not lost.
 *
 * There is no sync engine yet; this module only exists so that future work
 * has one place to call instead of re-deriving this rule.
 */
export function canSync(status: AuthStatus, online: boolean): boolean {
  return status === "authenticated" && online;
}

export function useSyncGate(): boolean {
  const { status, online } = useAuth();
  return canSync(status, online);
}
