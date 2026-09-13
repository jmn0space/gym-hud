import type { ReactNode } from "react";

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function HomeIcon() {
  return (
    <Icon>
      <path d="M3 11 12 4l9 7" />
      <path d="M5 10v10h14V10" />
    </Icon>
  );
}

export function PadIcon() {
  return (
    <Icon>
      <circle cx="13" cy="4" r="2" />
      <path d="m9 21 3-7 3 3v4" />
      <path d="m7 12 3-4 4 1 3 4" />
    </Icon>
  );
}

export function ResistanceIcon() {
  return (
    <Icon>
      <path d="M6 7v10M18 7v10M3 10v4M21 10v4M6 12h12" />
    </Icon>
  );
}

export function CardioIcon() {
  return (
    <Icon>
      <path d="M3 12h4l2-5 4 10 2-5h6" />
    </Icon>
  );
}

export function HistoryIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Icon>
  );
}
