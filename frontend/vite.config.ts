import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Django local settings trust exactly this origin for CSRF/CORS.
const DEV_SERVER_PORT = 5173;
const DEFAULT_API_PROXY_TARGET = "http://127.0.0.1:8000";

export default defineConfig(({ mode }) => {
  // API_PROXY_TARGET has no VITE_ prefix, so it never reaches the client bundle.
  const env = loadEnv(mode, import.meta.dirname, "");
  const apiProxyTarget = env.API_PROXY_TARGET || DEFAULT_API_PROXY_TARGET;

  return {
    plugins: [react()],
    server: {
      port: DEV_SERVER_PORT,
      strictPort: true,
      // Same-origin API requests in development: no CORS, and session cookies just work.
      proxy: {
        "/api": { target: apiProxyTarget, changeOrigin: true },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      restoreMocks: true,
      unstubGlobals: true,
    },
  };
});
