import { Route, Routes } from "react-router";

import { AppLayout } from "./components/AppLayout";
import { CardioPage } from "./pages/CardioPage";
import { HistoryPage } from "./pages/HistoryPage";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { PadPage } from "./pages/PadPage";
import { ResistancePage } from "./pages/ResistancePage";
import { routes } from "./routes";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { LoginPage } from "./auth/LoginPage";
import { StorageWarningBanner } from "./auth/StorageWarningBanner";
import { LocalDataProvider } from "./local/LocalDataProvider";
import type { LocalRepository } from "./storage";

interface AppProps {
  repository?: LocalRepository | undefined;
  /**
   * Repository for the auth marker/session state machine. Defaults to
   * `repository` (not its own independent connection) so that when a caller
   * supplies one repository, logout confirmation and different-user/owner
   * checks read the same outbox LocalDataProvider writes to (finding #19).
   * Only truly defaults to its own connection when neither prop is given, as
   * in production (see main.tsx), where both providers' own default
   * connections point at the same underlying database anyway.
   */
  authRepository?: LocalRepository | undefined;
}

export function App({ authRepository, repository }: AppProps) {
  return (
    <AuthProvider repository={authRepository ?? repository}>
      <LocalDataProvider repository={repository}>
        <AuthGate />
      </LocalDataProvider>
    </AuthProvider>
  );
}

/**
 * Renders the login/checking screens or the app shell depending on
 * authStatus; app routes never render while sign-in is required or the
 * server cannot be reached. The login/checking screens get their own minimal
 * `<main>` landmark (finding #11) instead of AppLayout's, since the app shell
 * (nav, account status, etc.) does not apply until there is a session to show
 * it for.
 */
function AuthGate() {
  const { status } = useAuth();

  if (status === "checking" || status === "login-required" || status === "server-unreachable") {
    return (
      <main className="app__main">
        <StorageWarningBanner />
        {status === "checking" ? (
          <p className="storage-notice muted" role="status">
            Checking sign-in…
          </p>
        ) : (
          <LoginPage />
        )}
      </main>
    );
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<HomePage />} />
        <Route path={routes.pad} element={<PadPage />} />
        <Route path={routes.resistance} element={<ResistancePage />} />
        <Route path={routes.cardio} element={<CardioPage />} />
        <Route path={routes.history} element={<HistoryPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
