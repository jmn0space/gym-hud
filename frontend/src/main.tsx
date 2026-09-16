import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { App } from "./App";
import { registerServiceWorker } from "./pwa/registerServiceWorker";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root is missing from index.html.");
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

// Registration happens after the first render and only once the page has loaded, so
// it never competes with first paint. Restricting it to production builds keeps it
// out of `vite dev` (which serves no `/sw.js`) and out of the jsdom test run.
if (import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void registerServiceWorker();
  });
}
