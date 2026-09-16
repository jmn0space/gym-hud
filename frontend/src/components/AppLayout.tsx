import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router";

import { AccountMismatchBanner } from "../auth/AccountMismatchBanner";
import { ExpiredSessionBanner } from "../auth/ExpiredSessionBanner";
import { StorageWarningBanner } from "../auth/StorageWarningBanner";
import { AccountStatus } from "./AccountStatus";
import { BottomNav } from "./BottomNav";
import { LocalDataStatus } from "./LocalDataStatus";

export function AppLayout() {
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const previousPathname = useRef(pathname);

  // Move focus to the new page heading after client-side navigation so screen
  // readers announce the screen change. Leave focus alone on first load; comparing
  // paths (not a first-render flag) survives StrictMode's double-invoked effects.
  useEffect(() => {
    if (previousPathname.current === pathname) {
      return;
    }
    previousPathname.current = pathname;
    mainRef.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [pathname]);

  return (
    <div className="app">
      <main ref={mainRef} className="app__main">
        <StorageWarningBanner />
        <ExpiredSessionBanner />
        <AccountMismatchBanner />
        <LocalDataStatus />
        <AccountStatus />
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
