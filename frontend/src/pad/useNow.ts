import { useEffect, useState } from "react";

/**
 * The wall clock, as milliseconds, for screens that derive elapsed time from
 * stored timestamps.
 *
 * The interval only triggers a re-render; the displayed duration is always
 * recomputed as `now - started_at` (docs/pad-walking.md, "Starting and timing a
 * bout"). That is why this also resynchronizes on focus and on becoming visible:
 * a locked phone or a backgrounded PWA stops delivering ticks entirely, so a
 * tick-counting timer would come back minutes behind, while re-reading the clock
 * at that moment is exactly PAD-01's expectation.
 *
 * Pass `active = false` when nothing on screen is counting, so an idle screen does
 * not re-render every second.
 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return;
    }
    const sync = () => {
      setNow(Date.now());
    };
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") {
        sync();
      }
    };
    sync();
    const timer = window.setInterval(sync, 1000);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", syncWhenVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", syncWhenVisible);
    };
  }, [active]);

  return now;
}
