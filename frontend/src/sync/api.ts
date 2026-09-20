/** Thin `apiFetch` wrappers for the three synchronization endpoints. */

import { apiFetch } from "../api/client";
import type { OutboxEntry } from "../storage";
import {
  isBootstrapResponse,
  isChangesResponse,
  parsePushResponse,
  type BootstrapResponse,
  type ChangesResponse,
  type MutationAck,
} from "./protocol";

/** `POST /api/v1/sync/mutations/`, CSRF-protected like every unsafe API request. */
export async function pushMutations(
  clientId: string,
  mutations: readonly OutboxEntry[],
): Promise<MutationAck[]> {
  const body = await apiFetch<unknown>("/api/v1/sync/mutations/", {
    method: "POST",
    body: { client_id: clientId, mutations },
    csrf: true,
  });
  return parsePushResponse(body);
}

/** `GET /api/v1/sync/bootstrap/`. */
export async function fetchBootstrap(): Promise<BootstrapResponse> {
  const body = await apiFetch<unknown>("/api/v1/sync/bootstrap/");
  if (!isBootstrapResponse(body)) {
    throw new Error("Bootstrap endpoint returned an unexpected payload");
  }
  return body;
}

/** `GET /api/v1/sync/changes/?since=&limit=`. */
export async function fetchChanges(since: number, limit?: number): Promise<ChangesResponse> {
  const params = new URLSearchParams({ since: since.toString() });
  if (limit !== undefined) {
    params.set("limit", limit.toString());
  }
  const body = await apiFetch<unknown>(`/api/v1/sync/changes/?${params.toString()}`);
  if (!isChangesResponse(body)) {
    throw new Error("Changes endpoint returned an unexpected payload");
  }
  return body;
}
