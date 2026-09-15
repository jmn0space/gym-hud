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
import { LocalDataProvider } from "./local/LocalDataProvider";
import type { LocalRepository } from "./storage";

interface AppProps {
  repository?: LocalRepository | undefined;
  /**
   * Repository for the auth marker/session state machine. Defaults to its own
   * connection (independent of `repository`) so a minimal LocalDataProvider
   * test double never has to also implement the auth-marker methods.
   */
  authRepository?: LocalRepository | undefined;
}

export function App({ authRepository, repository }: AppProps) {
  return (
    <AuthProvider repository={authRepository}>
      <LocalDataProvider repository={repository}>
        <AuthGate />
      </LocalDataProvider>
    </AuthProvider>
  );
}

/** Renders the login screen or the app shell depending on authStatus; app routes never render while sign-in is required. */
function AuthGate() {
  const { status } = useAuth();

  if (status === "checking") {
    return (
      <p className="storage-notice muted" role="status">
        Checking sign-in…
      </p>
    );
  }

  if (status === "login-required") {
    return <LoginPage />;
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
