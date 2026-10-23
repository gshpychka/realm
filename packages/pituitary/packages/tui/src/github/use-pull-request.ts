import type { ConversationLink } from "@pituitary/session";
import { useEffect, useRef, useState } from "react";
import { openLog } from "../config.ts";
import { ghCommand } from "./gh.ts";
import { lookupPullRequest, type PullRequest, PullRequestWatch } from "./pull-request.ts";

const log = openLog();

/**
 * The pull request opened from `branch`, looked up off the first frame, again when the
 * branch changes or a run settles, and on a slow timer. Null when there is none, or when
 * gh cannot say.
 */
export function usePullRequest(
  link: ConversationLink,
  cwd: string | null,
  branch: string | null,
): PullRequest | null {
  const [pull, setPull] = useState<PullRequest | null>(null);
  const watch = useRef<PullRequestWatch | null>(null);
  const inRepository = cwd !== null && branch !== null;

  useEffect(() => {
    const gh = ghCommand();
    if (!gh || !inRepository || cwd === null) return;
    const current = new PullRequestWatch({
      lookup: () => lookupPullRequest(gh, cwd),
      onChange: setPull,
      log: (line) => log.write(`${line}\n`),
    });
    watch.current = current;
    current.start();
    return () => {
      current.stop();
      watch.current = null;
      setPull(null);
    };
  }, [cwd, inRepository]);

  const shownBranch = useRef(branch);
  useEffect(() => {
    if (shownBranch.current === branch) return;
    shownBranch.current = branch;
    watch.current?.refresh({ reset: true });
  }, [branch]);

  // The agent may have just opened the pull request.
  useEffect(
    () =>
      link.onEvent((event) => {
        if (event.type === "agent_settled") watch.current?.refresh();
      }),
    [link],
  );

  return inRepository ? pull : null;
}
