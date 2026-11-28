import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
let streaming = false;
let answer: unknown;
const received: string[] = [];
/** The bridge extension this Pi loaded, by its file; it registers under a renamed command. */
const bridge = process.env.FIXTURE_BRIDGE;
const BRIDGE_NAME = "pituitary:2";
const write = (...records: unknown[]) =>
  process.stdout.write(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
write({ type: "extension_ui_request", id: "startup", method: "notify", message: "Pi extension ready" });
for await (const line of input) {
  const command = JSON.parse(line) as { id: string; type: string; message?: string };
  received.push(command.type);
  const response = (data?: unknown) => ({
    id: command.id,
    type: "response",
    command: command.type,
    success: true,
    data,
  });
  switch (command.type) {
    case "get_state":
      write(
        response({
          sessionId: "pi-session",
          sessionFile: "/tmp/pi-session.jsonl",
          thinkingLevel: "medium",
          isStreaming: streaming,
          isCompacting: false,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0,
        }),
      );
      break;
    case "get_messages":
      if (streaming)
        write(
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "before" },
          },
          response({ messages: [] }),
          {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "after" },
          },
        );
      else write(response({ messages: [] }));
      break;
    case "fixture_stream":
      streaming = true;
      write(
        response(),
        { type: "agent_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        { type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
        { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "README.md" } },
        {
          type: "tool_execution_update",
          toolCallId: "read-1",
          toolName: "read",
          args: {},
          partialResult: { content: [{ type: "text", text: "Reading" }] },
        },
      );
      break;
    case "fixture_tool_start":
      streaming = true;
      // Pi's JSON/RPC encoder replaces the native partial snapshot with id/toolName.
      write(
        response(),
        { type: "agent_start" },
        { type: "message_start", message: { role: "assistant", content: [] } },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "toolcall_start",
            contentIndex: 1,
            id: "read-stream",
            toolName: "read",
          },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"path":' },
        },
      );
      break;
    case "fixture_tool_end":
      write(
        response(),
        {
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '"README.md"}' },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "toolcall_end",
            contentIndex: 1,
            toolCall: { type: "toolCall", id: "read-stream", name: "read", arguments: { path: "README.md" } },
          },
        },
      );
      break;
    case "fixture_compaction_start":
      write(response(), { type: "compaction_start", reason: "threshold" });
      break;
    case "fixture_compaction_end":
      write(response(), { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
      break;
    case "get_commands":
      write(
        response({
          commands: bridge
            ? [
                {
                  name: BRIDGE_NAME,
                  source: "extension",
                  sourceInfo: { path: bridge, source: "cli", scope: "temporary", origin: "top-level" },
                },
              ]
            : [],
        }),
      );
      break;
    case "prompt": {
      const message = command.message ?? "";
      if (bridge && message.startsWith(`/${BRIDGE_NAME} `)) {
        const call = JSON.parse(message.slice(BRIDGE_NAME.length + 2)) as { id: string; kind: string };
        // The handler of a reload throws, as an extension's broken command would.
        if (call.kind === "reload")
          write({
            type: "extension_error",
            extensionPath: `command:${BRIDGE_NAME}`,
            event: "command",
            error: "reload exploded",
          });
        else
          write({
            type: "extension_ui_request",
            id: "reply",
            method: "setStatus",
            statusKey: "pituitary.bridge",
            statusText: JSON.stringify({
              id: call.id,
              ok: true,
              result: {
                sessions: [
                  { path: "/s/a.jsonl", id: "a", cwd: "/w", modified: 2, messages: 3, first: "hello" },
                  { path: 7 },
                ],
              },
            }),
          });
        write(response({ disposition: "handled" }));
      } else write(response({ disposition: "started" }));
      break;
    }
    case "new_session":
      write(response({ cancelled: false }));
      break;
    case "fixture_runtime":
      write(response(), {
        type: "extension_ui_request",
        id: "runtime",
        method: "setStatus",
        statusKey: "pituitary.runtime",
        statusText: JSON.stringify({ cwd: "/elsewhere" }),
      });
      break;
    case "fixture_extension_error":
      write(response(), {
        type: "extension_error",
        extensionPath: "/home/operator/.pi/agent/extensions/demo.ts",
        event: "before_agent_start",
        error: "demo handler exploded",
      });
      break;
    case "fixture_received":
      write(response(received.slice(0, -1)));
      break;
    case "extension_ui_response":
      answer = command;
      break;
    case "fixture_answer":
      write(response(answer));
      break;
    case "fixture_args":
      write(response(process.argv.slice(2)));
      break;
    case "fixture_exit":
      process.exit(3);
      break;
    default:
      write(response());
  }
}
