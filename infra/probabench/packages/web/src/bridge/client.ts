// Browser side of the dev bridge. Only the dev server serves these routes.
import * as Schema from "effect/Schema";
import { type BenchRequest, BRIDGE_ROUTES, BridgeFailure, BridgeStatus } from "./protocol";

const TIMEOUT_MS = { status: 5_000, action: 10_000 } as const;
const UNAVAILABLE = "The dev bridge is unavailable. Try again.";

const isStatus = Schema.is(BridgeStatus);
const isFailure = Schema.is(BridgeFailure);

/** Whether the bridge answered with a success code, and its JSON body (null if none). */
const call = async (route: string, init: RequestInit) => {
  try {
    const response = await fetch(route, init);
    return { ok: response.ok, body: (await response.json()) as unknown };
  } catch {
    return { ok: false, body: null };
  }
};

/** The bridge's status, or null while it is temporarily unreachable. */
export const fetchStatus = async (): Promise<BridgeStatus | null> => {
  const { ok, body } = await call(BRIDGE_ROUTES.status, {
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS.status),
  });
  return ok && isStatus(body) ? body : null;
};

const post = async (route: string, request: BenchRequest | null): Promise<BridgeStatus> => {
  const { ok, body } = await call(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: request && JSON.stringify(request),
    signal: AbortSignal.timeout(TIMEOUT_MS.action),
  });
  if (ok && isStatus(body)) return body;
  throw new Error(isFailure(body) ? body.error : UNAVAILABLE);
};

export const startRun = (request: BenchRequest) => post(BRIDGE_ROUTES.run, request);
export const cancelRun = () => post(BRIDGE_ROUTES.cancel, null);
