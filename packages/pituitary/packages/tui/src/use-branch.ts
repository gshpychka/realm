import type { AgentLink } from "@pituitary/rpc";
import { useEffect, useState } from "react";
import { branchOf } from "./place.ts";

/** The branch `cwd` has checked out, read again each time a run settles, since the agent may switch it. */
export function useBranch(link: AgentLink, cwd: string | null) {
  const [branch, setBranch] = useState(() => (cwd === null ? null : branchOf(cwd)));
  useEffect(
    () =>
      link.onEvent((event) => {
        if (event.type === "agent_settled" && cwd !== null) setBranch(branchOf(cwd));
      }),
    [link, cwd],
  );
  return cwd === null ? null : branch;
}
