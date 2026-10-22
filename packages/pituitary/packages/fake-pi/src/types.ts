import type {
  DialogRequest,
  PiEvent,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcSessionState,
} from "@pituitary/rpc";

/** One step of a script. */
export type Beat =
  | PiEvent
  /** An extension UI request pi sends and forgets. */
  | { ui: RpcExtensionUIRequest }
  /** A dialog: the script waits for the answer and continues with what `answered` returns. */
  | { ask: DialogRequest; answered(response: RpcExtensionUIResponse): Beat[] }
  /** The agent process dies with `code`. */
  | { exit: number }
  /** An extension replaces the session with one holding `session`, without an event. */
  | { session: unknown[] }
  /** A provider response's usage-limit headers, as pi's bridge extension passes them to pituitary. */
  | { limits: Record<string, string> };

export interface Scenario {
  name: string;
  /** Models `get_available_models` lists, the first of them selected; the stock fake models otherwise. */
  models?: NonNullable<RpcSessionState["model"]>[];
  /** Session state reported to `get_state`. */
  state?: Partial<RpcSessionState>;
  /** Messages the session holds before the first prompt, as `get_messages` returns them. */
  history?: unknown[];
  /** Commands `get_commands` lists; a prompt template and an extension command otherwise. */
  commands?: unknown[];
  /** Context window use, in percent, reported by `get_session_stats`; it grows with the session otherwise. */
  context?: number;
  /** Output lines for a command the operator runs; one line echoing it otherwise. */
  bash?(command: string): string[];
  /** Why a prompt is turned away, for an agent that refuses; every prompt is accepted otherwise. */
  refuse?(prompt: string): string | undefined;
  /** The script played for a prompt. */
  run(prompt: string): Beat[];
}
