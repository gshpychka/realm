import { useTerminalDimensions } from "@opentui/react";
import type { Action } from "../keymap.ts";
import { keyHint, useKeymap } from "../keymap-context.tsx";
import { ellipsize } from "../text-width.ts";
import { theme } from "../theme.ts";

/** A key on the welcome screen, what it does, and the shorter words a narrow screen takes. */
type WelcomeRow = readonly [keys: string, does: string, short?: string];

/** The draft's own keys; regular Pi's draft also runs the operator's shell commands. */
const editorKeys = (local: boolean, shell: boolean, latest: string): readonly WelcomeRow[] => [
  ["enter", "send"],
  ["shift+enter  ctrl+j", "new line"],
  local ? ["/  @", "commands, and files to mention", "commands, files"] : ["/", "commands"],
  ...(shell ? [["!  !!", "run a shell command; !! keeps its output from pi", "shell command"] as const] : []),
  [
    ["pgup  pgdn", latest].filter(Boolean).join("  "),
    latest ? "scroll, and back to the latest" : "scroll",
    "scroll",
  ],
];

/** Cells between the key column and what the key does. */
const KEY_GAP = 2;
/** Cells the key column leaves for what the keys do, where it can. */
const DOES_LEAST = 16;

/**
 * The empty conversation: where to start, and the keys. When one row's words do not fit, every
 * row that has shorter words takes them, so the list reads alike.
 */
export function Welcome({
  escapes,
  agent,
  local = true,
  modelSelectable = local,
  providerUsage = false,
  sessions = false,
}: {
  escapes: string;
  /** What the operator calls the agent, such as `pi` or `the builder` for a Dura task's role. */
  agent: string;
  local?: boolean;
  modelSelectable?: boolean;
  /** The footer's card shows the provider's usage beside the session's cost. */
  providerUsage?: boolean;
  /** Regular Pi's saved sessions can be resumed, forked and started afresh. */
  sessions?: boolean;
}) {
  const { width } = useTerminalDimensions();
  const bindings = useKeymap();
  const bound = (action: Action) => keyHint(bindings, action) ?? "";
  const interrupt = bound("app.interrupt");
  const rows = (
    [
      ...editorKeys(local, sessions, bound("tui.altScreen.bottom")),
      [bound("app.message.followUp"), `queue a follow-up while ${agent} works`, "queue a follow-up"],
      [
        interrupt ? escapes : "",
        interrupt === "esc" && escapes !== "esc"
          ? "leave insert mode, then interrupt"
          : "interrupt and take back queued messages",
        "interrupt",
      ],
      [bound("app.tools.expand"), "open every box of work at full length", "open every box"],
      [
        bound("app.tools.browse"),
        sessions ? "pick a message or box to open, copy or fork" : "pick a message or box to open or copy",
        "pick a message",
      ],
      [bound("app.thinking.toggle"), "show or hide thinking", "toggle thinking"],
      [modelSelectable ? bound("app.model.select") : "", "pick a model"],
      [modelSelectable ? bound("app.model.cycleForward") : "", "take the next model", "next model"],
      providerUsage
        ? [bound("app.usage.toggle"), "show usage and cost", "usage and cost"]
        : [bound("app.usage.toggle"), "show session cost", "session cost"],
      [bound("app.editor.external"), "edit in $VISUAL"],
      [
        sessions
          ? [bound("app.session.resume"), bound("app.session.fork"), bound("app.session.new")]
              .filter(Boolean)
              .join("  ")
          : "",
        "resume, fork or start a session",
        "sessions",
      ],
      // One row for both keeps the list within the rows of a small terminal.
      [
        sessions ? [bound("app.skills"), bound("app.consult")].filter(Boolean).join("  ") : "",
        "choose a skill · ask for a second opinion",
        "skills · second opinion",
      ],
    ] satisfies readonly WelcomeRow[]
  ).filter(([keys]) => keys);
  const quitKeys = [bound("app.clear") && `${bound("app.clear")} twice`, bound("app.exit")]
    .filter(Boolean)
    .join("  ");
  // How to leave stays in view however few rows the welcome gets, as extension statuses take some.
  const quit: readonly WelcomeRow[] = quitKeys ? [[quitKeys, "quit"]] : [];
  const inner = Math.max(0, width - 2);
  // The key column fits the longest key shown, leaving room for the short descriptions.
  const keyColumn = Math.max(
    0,
    Math.min(
      Math.max(...[...rows, ...quit].map(([keys]) => Bun.stringWidth(keys))) + KEY_GAP,
      inner - DOES_LEAST,
    ),
  );
  const room = inner - keyColumn;
  const short = rows.some(([, does, brief]) => brief !== undefined && Bun.stringWidth(does) > room);
  const row = ([keys, does, brief]: WelcomeRow) => (
    <box key={keys} flexDirection="row" flexShrink={0} height={1}>
      <text selectable={false} fg={theme.tool} width={keyColumn} flexShrink={0} wrapMode="none">
        {ellipsize(keys, keyColumn - KEY_GAP)}
      </text>
      <text selectable={false} fg={theme.dim} wrapMode="none">
        {ellipsize(short && brief ? brief : does, room)}
      </text>
    </box>
  );
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      flexShrink={1}
      overflow="hidden"
      paddingLeft={1}
      paddingRight={1}
    >
      <text selectable={false} fg={theme.dim} flexShrink={0}>
        Ask {agent} something to get started.
      </text>
      <box flexDirection="column" flexShrink={1} minHeight={0} marginTop={1}>
        {/* Short of rows, the list loses its last keys before the quit row under it. */}
        <box flexDirection="column" flexShrink={1} minHeight={0} overflow="hidden">
          {rows.map(row)}
        </box>
        {quit.map(row)}
      </box>
    </box>
  );
}
