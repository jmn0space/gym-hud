import type { ReactNode } from "react";

interface PageProps {
  heading: string;
  /** Browser tab title; defaults to "<heading> · Gym HUD". */
  documentTitle?: string;
  children: ReactNode;
}

export function Page({ heading, documentTitle, children }: PageProps) {
  return (
    <>
      <title>{documentTitle ?? `${heading} · Gym HUD`}</title>
      {/* tabIndex -1 lets AppLayout move focus here after navigation. */}
      <h1 className="page__heading" tabIndex={-1}>
        {heading}
      </h1>
      <div className="stack stack--loose">{children}</div>
    </>
  );
}
