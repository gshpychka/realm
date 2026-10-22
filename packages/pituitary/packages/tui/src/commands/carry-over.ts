import { existsSync } from "node:fs";
import type { SessionController } from "../use-session.ts";
import type { CommandContext } from "./run-command.ts";

/** What pi is in the middle of, which a command that restarts or reloads it would cut short. */
export function busyWith(session: SessionController): string | null {
  if (session.view.phase === "compacting") return "pi is compacting the session";
  if (session.view.running) return "pi is working";
  if (session.shellBusy) return "a command is running";
  return null;
}

/**
 * Whether another pi process can take the session up where this one leaves it. pi writes
 * the session file once it holds a reply, so an unsaved session with entries would be lost.
 */
export function carriesOver(session: SessionController): boolean {
  const file = session.state?.sessionFile;
  if (file && existsSync(file)) return true;
  return !session.view.entries.some((entry) => entry.kind !== "notice");
}

/**
 * Restarts pi on this session so it takes up what `saved` describes, or tells the operator
 * to restart when the session cannot carry over now.
 */
export function restartToApply(context: CommandContext, saved: string): void {
  if (busyWith(context.session) || !carriesOver(context.session)) {
    context.session.notify("info", `${saved}; restart pituitary for this to take effect`);
    return;
  }
  context.restart(`${saved}; pi restarted to take it up`);
}

/** Throws unless another pi process can take the session over now, naming what `doing` waits for. */
export function assertCarriesOver(session: SessionController, doing: string): void {
  const busy = busyWith(session);
  if (busy) throw new Error(`${busy}; wait for it to finish, or press esc, before ${doing}`);
  if (!carriesOver(session)) {
    throw new Error(
      "this session is not saved yet, so pi could not carry it over; it is saved once pi replies",
    );
  }
}
