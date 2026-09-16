import { deriveActiveSessionSummaries } from "../local/activeSessions";
import type { OutboxEntry, RecoverySnapshot } from "../storage";

/**
 * `deriveActiveSessionSummaries` takes a clock only to compute each card's elapsed
 * duration; how many sessions it returns never depends on it. Passing a fixed value
 * keeps this gate callable during render without reading the real clock.
 */
const CLOCK_INDEPENDENT = 0;

/**
 * The safety gate for acceptance criterion 4: a service-worker update is never
 * applied over live work, because applying it reloads the page.
 *
 * "Live work" is an active session (the same derivation that drives the Resume
 * cards) or an unsynchronised mutation still sitting in the outbox. A snapshot that
 * has not loaded yet counts as live: until the local database has answered, the only
 * safe assumption is that there is something to protect.
 */
export function hasLiveWork(
  snapshot: RecoverySnapshot | null,
  pendingOutbox: readonly OutboxEntry[],
): boolean {
  if (snapshot === null) {
    return true;
  }
  if (pendingOutbox.length > 0) {
    return true;
  }
  return deriveActiveSessionSummaries(snapshot, CLOCK_INDEPENDENT).length > 0;
}
