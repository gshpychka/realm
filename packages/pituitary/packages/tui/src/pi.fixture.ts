import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin });
let streaming = false;
let answer: unknown;
const received: string[] = [];
/** The bridge extension this Pi loaded, by its file; it registers under a renamed command. */
const bridge = process.env.FIXTURE_BRIDGE;
const BRIDGE_NAME = "pituitary:2";
/** The session `--session` names, as a Pi started on it would be. */
const named = process.argv.indexOf("--session");
const sessionId = (named === -1 ? undefined : process.argv[named + 1]) ?? "pi-session";
const command = (name: string, source: "extension" | "prompt", path: string) => ({
  name,
  source,
  sourceInfo: { path, source: "cli", scope: "temporary", origin: "top-level" },
});
/** What get_commands answers: a reload and a new session each load another prompt template. */
let commands = bridge ? [command(BRIDGE_NAME, "extension", bridge)] : [];
let reloadFails = false;
/** The shell command running until `fixture_bash_end`, by its request's id. */
let shell: string | undefined;
const write = (...records: unknown[]) =>
  process.stdout.write(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
const runtime = (cwd?: string) => ({
  type: "extension_ui_request",
  id: `runtime-${cwd ?? "end"}`,
  method: "setStatus",
  statusKey: "pituitary.runtime",
  ...(cwd ? { statusText: JSON.stringify({ cwd }) } : {}),
});
write({ type: "extension_ui_request", id: "startup", method: "notify", message: "Pi extension ready" });
for await (const line of input) {
  const request = JSON.parse(line) as { id: string; type: string; message?: string };
  received.push(request.type);
  const response = (data?: unknown) => ({
    id: request.id,
    type: "response",
    command: request.type,
    success: true,
    data,
  });
  switch (request.type) {
    case "get_state":
      write(
        response({
          sessionId,
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
    case "bash":
      // Pi streams a command's output under the id of the request that runs it.
      shell = request.id;
      write({ type: "bash_execution_update", id: request.id, delta: "building\n" });
      break;
    case "fixture_bash_end":
      write(
        { type: "bash_execution_update", id: shell, delta: "done\n" },
        {
          id: shell,
          type: "response",
          command: "bash",
          success: true,
          data: { output: "building\ndone\n", exitCode: 0, cancelled: false, truncated: false },
        },
        response(),
      );
      break;
    case "fixture_compaction_start":
      write(response(), { type: "compaction_start", reason: "threshold" });
      break;
    case "fixture_compaction_end":
      write(response(), { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
      break;
    case "get_commands":
      write(response({ commands }));
      break;
    case "fixture_break_reload":
      reloadFails = true;
      write(response());
      break;
    case "prompt": {
      const message = request.message ?? "";
      if (bridge && message.startsWith(`/${BRIDGE_NAME} `)) {
        const call = JSON.parse(message.slice(BRIDGE_NAME.length + 2)) as { id: string; kind: string };
        const reply = (result: unknown) =>
          write({
            type: "extension_ui_request",
            id: "reply",
            method: "setStatus",
            statusKey: "pituitary.bridge",
            statusText: JSON.stringify({ id: call.id, ok: true, result }),
          });
        // A broken reload throws, as an extension's broken command would.
        if (call.kind === "reload" && reloadFails)
          write({
            type: "extension_error",
            extensionPath: `command:${BRIDGE_NAME}`,
            event: "command",
            error: "reload exploded",
          });
        else if (call.kind === "reload") {
          commands = [...commands, command("reloaded", "prompt", "/fixture/reloaded.md")];
          reply(null);
        } else
          reply({
            sessions: [
              // The prompt carries a terminal control, which the frontend never draws.
              { path: "/s/a.jsonl", id: "a", cwd: "/w", modified: 2, prompts: 3, first: "he\x1b[31mllo" },
              { path: 7 },
            ],
          });
        write(response({ disposition: "handled" }));
      } else write(response({ disposition: "started" }));
      break;
    }
    case "new_session": {
      // The old runtime ends and the new one starts twice over before Pi answers, as Pi does.
      const started = [
        { type: "extension_ui_request", id: "n1", method: "notify", message: "demo noticed a new session" },
        { type: "extension_error", extensionPath: "/x/demo.ts", event: "session_start", error: "demo broke" },
        runtime("/fresh"),
      ];
      commands = [...commands, command("fresh", "prompt", "/fresh/.pi/prompts/fresh.md")];
      write(runtime(), ...started, ...started.map((record) => ({ ...record, id: `again-${record.id}` })));
      write(response({ cancelled: false }));
      break;
    }
    case "export_html":
      // Pi names the page as given, which it wrote relative to its own working directory.
      write(response({ path: (request as { outputPath?: string }).outputPath ?? "pi-session.html" }));
      break;
    case "fixture_runtime":
      write(response(), runtime("/elsewhere"));
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
      answer = request;
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
