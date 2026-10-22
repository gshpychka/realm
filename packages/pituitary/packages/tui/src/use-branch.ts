import type { AgentLink } from "@pituitary/rpc";
import { useEffect, useState } from "react";
import { branchOf } from "./place.ts";

/** The branch `cwd` has checked out, read again each time a run settles, since the agent may switch it. */
export function useBranch(link: AgentLink, cwd: string) {
  const [branch, setBranch] = useState(() => branchOf(cwd));
  useEffect(
    () =>
      link.onEvent((event) => {
        if (event.type === "agent_settled") setBranch(branchOf(cwd));
      }),
    [link, cwd],
  );
  return branch;
}
