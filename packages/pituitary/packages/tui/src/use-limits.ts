import type { BridgeHost, Limits } from "@pituitary/rpc";
import { useEffect, useState } from "react";

/** The usage limits the latest provider response carried, as the bridge reports them. */
export function useLimits(bridge: BridgeHost | undefined): Limits | null {
  const [limits, setLimits] = useState<Limits | null>(() => bridge?.limits() ?? null);
  useEffect(() => bridge?.onLimits(() => setLimits(bridge.limits())), [bridge]);
  return limits;
}
