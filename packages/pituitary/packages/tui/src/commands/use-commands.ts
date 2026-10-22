import { type AgentLink, BRIDGE_COMMAND_PREFIX } from "@pituitary/rpc";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BUILTINS, type Command } from "./commands.ts";

/**
 * The commands the draft completes: pituitary's own, then those pi lists for its extensions,
 * prompt templates, and skills. pi is asked again when the session changes, and on `reread`,
 * as after a reload.
 */
export function useCommands(link: AgentLink, sessionId: string | undefined) {
  const [listed, setListed] = useState<Command[]>([]);
  const [reads, setReads] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a reread asks for the list again
  useEffect(() => {
    if (!sessionId) return;
    link
      .call({ type: "get_commands" })
      .then(({ commands }) =>
        setListed(
          commands.flatMap((each) =>
            each.name.startsWith(BRIDGE_COMMAND_PREFIX)
              ? []
              : [{ name: each.name, description: each.description ?? "", source: each.source }],
          ),
        ),
      )
      .catch(() => {});
  }, [link, sessionId, reads]);

  const commands = useMemo(
    () => [...BUILTINS, ...listed.filter((each) => !BUILTINS.some((own) => own.name === each.name))],
    [listed],
  );
  const reread = useCallback(() => setReads((count) => count + 1), []);
  return { commands, reread };
}
