import type { ReactNode } from "react";

interface UnavailableStateProps {
  title: string;
  children: ReactNode;
}

/** Honest placeholder for screens whose domain behavior is not built yet. */
export function UnavailableState({ title, children }: UnavailableStateProps) {
  return (
    <div className="card">
      <p className="card__title">{title}</p>
      <p className="muted">{children}</p>
    </div>
  );
}
