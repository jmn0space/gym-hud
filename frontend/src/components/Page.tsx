import { useEffect, useRef, type ReactNode } from "react";

interface PageProps {
  heading: string;
  /** Browser tab title; defaults to "<heading> · Gym HUD". */
  documentTitle?: string;
  /**
   * An identifier for the screen currently rendered inside this page. When it
   * changes, focus moves to the heading.
   *
   * A page that swaps its whole subtree without navigating -- PAD's start screen
   * for its HUD, say -- unmounts the control the user just pressed, and focus then
   * falls to `<body>`. `AppLayout` only restores it on a route change, and a
   * `role="status"` line is no substitute: that element is itself freshly
   * inserted, and screen readers are inconsistent about announcing a live region
   * that was not already on the page.
   */
  focusKey?: string | undefined;
  children: ReactNode;
}

export function Page({ heading, documentTitle, focusKey, children }: PageProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousFocusKey = useRef(focusKey);

  useEffect(() => {
    const previous = previousFocusKey.current;
    previousFocusKey.current = focusKey;
    // Only between two known screens: leave focus alone on first load, and while
    // the page has not decided which screen it is on yet.
    if (focusKey === undefined || previous === undefined || previous === focusKey) {
      return;
    }
    headingRef.current?.focus();
  }, [focusKey]);

  return (
    <>
      <title>{documentTitle ?? `${heading} · Gym HUD`}</title>
      {/* tabIndex -1 lets AppLayout (and the screen switch above) move focus here. */}
      <h1 ref={headingRef} className="page__heading" tabIndex={-1}>
        {heading}
      </h1>
      <div className="stack stack--loose">{children}</div>
    </>
  );
}
