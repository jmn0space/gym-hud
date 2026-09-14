// Augments the ImportMetaEnv declared by vite/client (see tsconfig.app.json "types").
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}
