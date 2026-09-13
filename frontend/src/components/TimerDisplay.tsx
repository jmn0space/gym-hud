interface TimerDisplayProps {
  /** Elapsed duration derived from persisted timestamps by the caller. */
  durationMs: number;
  size?: "large" | "compact";
}

function wholeSeconds(durationMs: number): number {
  return Number.isFinite(durationMs) ? Math.max(0, Math.floor(durationMs / 1000)) : 0;
}

/** Format a duration as MM:SS, or H:MM:SS from one hour. */
export function formatDuration(durationMs: number): string {
  const total = wholeSeconds(durationMs);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0 ? `${hours.toString()}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function TimerDisplay({ durationMs, size = "large" }: TimerDisplayProps) {
  return (
    <time className={`timer timer--${size}`} dateTime={`PT${wholeSeconds(durationMs).toString()}S`}>
      {formatDuration(durationMs)}
    </time>
  );
}
