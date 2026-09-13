import { useEffect, useRef } from "react";
import { Outlet, useLocation } from "react-router";

import { BottomNav } from "./BottomNav";

export function AppLayout() {
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const isInitialRender = useRef(true);

  // Move focus to the new page heading after client-side navigation so screen
  // readers announce the screen change. Leave focus alone on first load.
  useEffect(() => {
    if (isInitialRender.current) {
      isInitialRender.current = false;
      return;
    }
    mainRef.current?.querySelector<HTMLElement>("h1")?.focus();
  }, [pathname]);

  return (
    <div className="app">
      <main ref={mainRef} className="app__main">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
