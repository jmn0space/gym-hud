const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

/** API origin prefix; empty means same-origin requests. */
export const API_BASE_URL = configuredBaseUrl.replace(/\/+$/, "");

export function apiUrl(path: `/${string}`): string {
  return `${API_BASE_URL}${path}`;
}
