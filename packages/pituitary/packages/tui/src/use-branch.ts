import type { ConversationLink } from "@pituitary/session";
import { useEffect, useState } from "react";
import { branchOf } from "./place.ts";

/**
 * The branch `cwd` has checked out, read again when `cwd` moves, as to a resumed session's
 * project, and each time a run settles, since the agent may switch it.
 */
export function useBranch(link: ConversationLink, cwd: string | null) {
  const [branch, setBranch] = useState(() => (cwd === null ? null : branchOf(cwd)));
  useEffect(() => {
    if (cwd === null) return;
    setBranch(branchOf(cwd));
    return link.onEvent((event) => {
      if (event.type === "agent_settled") setBranch(branchOf(cwd));
    });
  }, [link, cwd]);
  return cwd === null ? null : branch;
}
