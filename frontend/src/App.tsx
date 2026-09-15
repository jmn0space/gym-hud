import { Route, Routes } from "react-router";

import { AppLayout } from "./components/AppLayout";
import { CardioPage } from "./pages/CardioPage";
import { HistoryPage } from "./pages/HistoryPage";
import { HomePage } from "./pages/HomePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { PadPage } from "./pages/PadPage";
import { ResistancePage } from "./pages/ResistancePage";
import { routes } from "./routes";
import { LocalDataProvider } from "./local/LocalDataProvider";
import type { LocalRepository } from "./storage";

interface AppProps {
  repository?: LocalRepository | undefined;
}

export function App({ repository }: AppProps) {
  return (
    <LocalDataProvider repository={repository}>
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
    </LocalDataProvider>
  );
}
