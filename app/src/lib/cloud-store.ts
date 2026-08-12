/**
 * The cloud session: where inference points, whether an instance is alive, and for how long.
 *
 * Cloud Run GPU requires CPU-always-allocated, which means INSTANCE-BASED billing — you pay
 * for the instance's whole lifetime, cold start and idle tail included, not for the seconds of
 * inference. Three consequences shape this file:
 *
 * 1. **Idle polling is a cost bug.** The inspector used to GET /gpu every 4 seconds forever.
 *    Against a real service that is a request every 4 s, and an instance with traffic never
 *    scales to zero — so leaving the tab open billed indefinitely. Polling here is explicitly
 *    demand-driven: during a run, during warm-up, or when the operator asks.
 * 2. **Releasing the model is not stopping the meter.** POST /shutdown frees VRAM so the
 *    instance *can* scale down; it does not delete anything. Only deleting the service ends
 *    billing, which is why that is a separate, louder action.
 * 3. **The elapsed lifetime is the number that matters** and it is the one thing we can
 *    honestly measure locally. A currency figure would be invented — see COST_BASIS.
 */

import { useSyncExternalStore } from "react";

export type CloudState =
  | "local"
  | "connecting"
  | "cold"
  | "warming"
  | "warm"
  | "busy"
  | "unreachable";

export interface CloudSession {
  /**
   * Where GPU calls go, or null when using the local fixture mock.
   *
   * Two shapes, both remote. An absolute `https://…run.app` is the direct connection, which
   * needs a token in this store. `PROXY_BASE` (`/api/cloud/svc`) is same-origin and needs
   * none: the dev server signs each request from the local gcloud login. Prefer the
   * second — a credential the browser never receives cannot leak from it.
   */
  baseUrl: string | null;
  token: string;
  /**
   * The service being addressed, for display only.
   *
   * With the proxy, `baseUrl` is a local path and no longer names anything, so the operator
   * would otherwise have no way to see WHICH service is billing.
   */
  serviceUrl: string | null;
  /** True when requests are signed by the dev server rather than carrying a token from here. */
  proxied: boolean;
  state: CloudState;
  /** First moment we saw this service respond — the earliest the instance can have existed. */
  firstContactAt: number | null;
  lastRequestAt: number | null;
  requestCount: number;
  /** Billable inference runs issued this session. */
  runCount: number;
  /** Set once Delete service succeeds, so the UI stops claiming a live instance. */
  deleted: boolean;
  error: string | null;
}

/**
 * Why there is no dollar figure here.
 *
 * DESIGN.md honesty rule 1: never render an unmeasured quantity as a precise number. The app
 * has no billing data, the rate depends on region, GPU type and committed-use discounts, and
 * the instance's true birth predates our first contact by the cold start. What we can measure
 * is elapsed time since first contact, so that is what is displayed, with the billing model
 * stated in words. A number that looked authoritative would be worse than none.
 */
export const COST_BASIS =
  "Cloud Run bills the whole instance lifetime — cold start (~64 s) and the idle tail included — not inference seconds. Elapsed time is measured locally from first contact; the true lifetime is longer. No rate is applied because the app has no billing data.";

const state: CloudSession = {
  baseUrl: null,
  token: "",
  serviceUrl: null,
  proxied: false,
  state: "local",
  firstContactAt: null,
  lastRequestAt: null,
  requestCount: 0,
  runCount: 0,
  deleted: false,
  error: null,
};

let snapshot: CloudSession = { ...state };
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { ...state };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCloud(): CloudSession {
  return snapshot;
}

export function useCloud(): CloudSession {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

export function isRemote(): boolean {
  return state.baseUrl !== null;
}

/** Base for GPU routes: gpu, warmup, shutdown, infer. Local ffmpeg routes never come here. */
export function inferBase(): string {
  return state.baseUrl ?? "/api";
}

export function setCloudState(next: CloudState): void {
  if (state.state === next) return;
  state.state = next;
  emit();
}

export function setCloudError(message: string | null): void {
  state.error = message;
  if (message) state.state = "unreachable";
  emit();
}

/**
 * Every request to the GPU service passes through here. It is what makes the instance timer
 * and the request count real rather than a guess, and it is deliberately the only place that
 * can start the clock: the first response we ever get is the first proof an instance exists.
 */
export function noteRequest(): void {
  const now = Date.now();
  state.lastRequestAt = now;
  state.requestCount += 1;
  if (state.baseUrl && state.firstContactAt === null) state.firstContactAt = now;
  emit();
}

export function noteRun(): void {
  state.runCount += 1;
  emit();
}

/**
 * Point at a service through the dev server's authenticated proxy.
 *
 * Nothing is typed and no token is held: `serviceUrl` comes from `gcloud run services
 * describe` via /api/cloud/status, and the bearer is attached inside the dev server.
 */
export function connectProxied(serviceUrl: string, proxyBase: string): void {
  connectCloud(proxyBase, "");
  state.serviceUrl = serviceUrl;
  state.proxied = true;
  emit();
}

export function connectCloud(baseUrl: string, token: string): void {
  const normalized = baseUrl.replace(/\/$/, "");
  if (token) {
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      throw new Error("service URL is invalid");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || (!loopback && !url.hostname.endsWith(".run.app"))) {
      throw new Error("refusing to send a bearer token to an unapproved service host");
    }
  }
  state.baseUrl = normalized;
  state.token = token;
  state.serviceUrl = /^https?:\/\//i.test(baseUrl) ? baseUrl.replace(/\/$/, "") : null;
  state.proxied = false;
  state.state = "connecting";
  state.firstContactAt = null;
  state.lastRequestAt = null;
  state.requestCount = 0;
  state.runCount = 0;
  state.deleted = false;
  state.error = null;
  emit();
}

/**
 * Point back at the local mock.
 *
 * This does NOT stop billing, and it deliberately does NOT clear `firstContactAt`: the
 * instance keeps running until the service is deleted, so forgetting that we ever reached one
 * would turn the safest signal we have into a false all-clear. The clock keeps ticking and the
 * unload guard keeps firing until `markServiceDeleted`.
 */
export function disconnectCloud(): void {
  state.baseUrl = null;
  state.token = "";
  state.serviceUrl = null;
  state.proxied = false;
  state.state = "local";
  state.error = null;
  emit();
}

export function markServiceDeleted(): void {
  state.deleted = true;
  state.baseUrl = null;
  state.token = "";
  state.serviceUrl = null;
  state.proxied = false;
  state.state = "local";
  state.firstContactAt = null;
  emit();
}

/** Milliseconds since first contact, or null when no instance has answered us. */
export function instanceElapsedMs(session: CloudSession, now = Date.now()): number | null {
  return session.firstContactAt === null ? null : now - session.firstContactAt;
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

/**
 * True when an instance is probably alive and billing.
 *
 * Deliberately pessimistic, and deliberately independent of `baseUrl`: if we have ever
 * reached a service and have not deleted it, assume the meter is running. Requiring a live
 * connection here would report "not billing" the moment the operator pointed the app back at
 * the mock — which is precisely when they are most likely to walk away from a live instance.
 */
export function isBilling(session: CloudSession): boolean {
  return session.firstContactAt !== null && !session.deleted;
}
