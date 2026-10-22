import {
  agentRun,
  assistantTurn,
  customTurn,
  dialogRequest,
  failedTurn,
  fakeModels,
  type PiEvent,
  type RpcExtensionUIResponse,
  stored,
  type ToolArgs,
  toolRun,
  uiRequest,
  userTurn,
} from "@pituitary/rpc";
import type { Beat, Scenario } from "../src/types.ts";
import { CURATOR_URL } from "./curator.ts";

const START: PiEvent[] = [{ type: "agent_start" }, { type: "turn_start" }];
const END: PiEvent[] = [{ type: "agent_end", messages: [], willRetry: false }, { type: "agent_settled" }];

/** What the operator answered, as text a scripted reply can repeat. */
function answer(response: RpcExtensionUIResponse): string {
  if ("cancelled" in response) return "(cancelled)";
  if ("confirmed" in response) return response.confirmed ? "yes" : "no";
  return response.value;
}

const hello: Scenario = {
  name: "hello",
  run: (prompt) => agentRun([userTurn(prompt), assistantTurn({ text: `You said: ${prompt}` })]),
};

const stock = fakeModels[0] as (typeof fakeModels)[number];

/** A model of each provider mark and one of the generic mark, the Anthropic one selected. */
const providers: Scenario = {
  name: "providers",
  models: [
    { provider: "anthropic", id: "claude-sonnet-4-5" },
    { provider: "openai-codex", id: "gpt-5.1-codex" },
    { provider: "google", id: "gemini-2.5-pro" },
    { provider: "github-copilot", id: "gpt-4.1" },
    { provider: "ollama", id: "qwen3" },
  ].map((model) => ({ ...stock, ...model, name: model.id })),
  run: hello.run,
};

const thinking: Scenario = {
  name: "thinking",
  run: (prompt) =>
    agentRun([
      userTurn(prompt),
      assistantTurn({ thinking: "Weighing the options carefully.", text: "Here is the answer." }),
    ]),
};

const tool: Scenario = {
  name: "tool",
  run: (prompt) =>
    agentRun([
      userTurn(prompt),
      assistantTurn({
        text: "Listing the directory.",
        toolCall: { id: "call-1", name: "bash", args: { command: "ls -1" } },
      }),
      toolRun({
        id: "call-1",
        name: "bash",
        args: { command: "ls -1" },
        output: ["flake.nix", "flake.nix\npackages", "flake.nix\npackages\njustfile"],
      }),
      assistantTurn({ text: "Three entries at the root." }),
    ]),
};

const toolError: Scenario = {
  name: "tool-error",
  run: (prompt) =>
    agentRun([
      userTurn(prompt),
      assistantTurn({
        text: "Running it.",
        toolCall: { id: "call-1", name: "bash", args: { command: "false" } },
      }),
      toolRun({
        id: "call-1",
        name: "bash",
        args: { command: "false" },
        output: ["exit status 1"],
        isError: true,
      }),
      assistantTurn({ text: "The command failed." }),
    ]),
};

const long: Scenario = {
  name: "long",
  run: (prompt) =>
    agentRun([
      userTurn(prompt),
      assistantTurn({
        text: Array.from({ length: 40 }, (_, index) => `line ${index + 1} of the long answer`).join("\n"),
        parts: 8,
      }),
    ]),
};

/** A run through each thing the status line tells apart: thinking, writing, a tool, and a dialog. */
const phases: Scenario = {
  name: "phases",
  run: (prompt) => {
    const list = { command: "ls -1" };
    const clear = { command: "rm -rf build" };
    return [
      ...START,
      ...userTurn(prompt),
      ...assistantTurn({
        thinking: "Checking what the build leaves behind.",
        text: "Listing the directory.",
        toolCall: { id: "call-1", name: "bash", args: list },
        outputTokens: 1240,
      }),
      ...toolRun({
        id: "call-1",
        name: "bash",
        args: list,
        output: ["build", "build\nflake.nix", "build\nflake.nix\npackages", "build\nflake.nix\npackages"],
      }),
      ...assistantTurn({
        text: "Clearing the build directory.",
        toolCall: { id: "call-2", name: "bash", args: clear },
        outputTokens: 180,
      }),
      {
        ask: dialogRequest({
          id: "ui-1",
          method: "confirm",
          title: "bash wants to run",
          message: "rm -rf build",
        }),
        answered: (response): Beat[] => [
          ...toolRun({ id: "call-2", name: "bash", args: clear, output: ["", ""] }),
          ...assistantTurn({ text: `Cleared (${answer(response)}).` }),
          ...END,
        ],
      },
    ];
  },
};

/** A transient provider error pi recovers from, in the order pi emits it. */
const retry: Scenario = {
  name: "retry",
  run: (prompt) => [
    { type: "agent_start" },
    { type: "turn_start" },
    ...userTurn(prompt),
    ...failedTurn("529 overloaded_error"),
    { type: "agent_end", messages: [], willRetry: true },
    {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 200,
      errorMessage: "529 overloaded_error",
    },
    { type: "agent_start" },
    { type: "turn_start" },
    ...assistantTurn({ text: "Recovered after a retry." }),
    { type: "auto_retry_end", success: true, attempt: 2 },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ],
};

/** A provider error pi gives up on. */
const failure: Scenario = {
  name: "failure",
  run: (prompt) => agentRun([userTurn(prompt), failedTurn("400 invalid_request_error: prompt is too long")]),
};

const queue: Scenario = {
  name: "queue",
  run: (prompt) => [
    { type: "agent_start" },
    { type: "turn_start" },
    ...userTurn(prompt),
    { type: "queue_update", steering: ["focus on error handling"], followUp: ["then summarize"] },
    ...assistantTurn({ text: "Working through the queue." }),
    { type: "queue_update", steering: [], followUp: [] },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ],
};

/** A permission gate on a tool call, as pi-permission-system asks it over RPC. */
const permission: Scenario = {
  name: "permission",
  run: (prompt) => [
    ...START,
    ...userTurn(prompt),
    ...assistantTurn({
      text: "Clearing the build directory.",
      toolCall: { id: "call-1", name: "bash", args: { command: "rm -rf build" } },
    }),
    {
      ask: dialogRequest({
        id: "ui-1",
        method: "select",
        title: "bash wants to run:\n  rm -rf build",
        options: ["Yes", "Yes, for this session", "No", "No, provide reason"],
      }),
      answered: (response): Beat[] => {
        const allowed = answer(response).startsWith("Yes");
        return [
          ...toolRun({
            id: "call-1",
            name: "bash",
            args: { command: "rm -rf build" },
            output: [allowed ? "" : "blocked: permission denied"],
            isError: !allowed,
          }),
          ...assistantTurn({ text: allowed ? "Removed build." : `Left build alone (${answer(response)}).` }),
          ...END,
        ];
      },
    },
  ],
};

/** Every blocking dialog in turn, each answer carried into the next step. */
const dialogs: Scenario = {
  name: "dialogs",
  run: (prompt) => [
    ...START,
    ...userTurn(prompt),
    {
      ask: dialogRequest({ id: "ui-1", method: "confirm", title: "Overwrite", message: "Replace notes.md?" }),
      answered: (confirmed) => [
        {
          ask: dialogRequest({
            id: "ui-2",
            method: "input",
            title: "Name the branch",
            placeholder: "feat/…",
          }),
          answered: (name) => [
            {
              ask: dialogRequest({
                id: "ui-3",
                method: "editor",
                title: "Describe the change",
                prefill: "Why:\n",
              }),
              answered: (notes) => [
                ...assistantTurn({
                  text: `confirm=${answer(confirmed)} branch=${answer(name)} notes=${answer(notes).replace(/\n/g, " / ")}`,
                }),
                ...END,
              ],
            },
          ],
        },
      ],
    },
  ],
};

/** A dialog after the run has settled, as pi-plan-mode offers a finished plan. */
const ready: Scenario = {
  name: "ready",
  run: (prompt) => [
    ...agentRun([userTurn(prompt), assistantTurn({ text: "The plan is written." })]),
    {
      ask: dialogRequest({
        id: "ui-1",
        method: "select",
        title: "Plan ready",
        options: ["Implement it", "Keep planning"],
      }),
      answered: (response) => [
        {
          ui: uiRequest({
            id: "ui-2",
            method: "notify",
            message: `chose: ${answer(response)}`,
            notifyType: "info",
          }),
        },
      ],
    },
  ],
};

/** Every fire-and-forget request, styled the way pi's theme styles them. */
const display: Scenario = {
  name: "display",
  run: (prompt) => [
    ...START,
    ...userTurn(prompt),
    {
      ui: uiRequest({
        id: "ui-1",
        method: "setStatus",
        statusKey: "rewind",
        statusText: "\x1b[33m◆ 3 checkpoints\x1b[39m",
      }),
    },
    { ui: uiRequest({ id: "ui-2", method: "setStatus", statusKey: "mcp", statusText: "mcp 2/2" }) },
    {
      ui: uiRequest({
        id: "ui-3",
        method: "setWidget",
        widgetKey: "plan-mode-plan",
        widgetLines: ["plan: 1. read limits.ts", "      2. add the upper bound"],
      }),
    },
    { ui: uiRequest({ id: "ui-4", method: "setTitle", title: "pi · payouts" }) },
    {
      ui: uiRequest({
        id: "ui-5",
        method: "notify",
        message: "lens: 2 diagnostics fixed",
        notifyType: "warning",
      }),
    },
    { ui: uiRequest({ id: "ui-6", method: "set_editor_text", text: "implement the plan" }) },
    ...assistantTurn({ text: "Display set." }),
    ...END,
  ],
};

/**
 * Statuses as the operator's extensions set them: pi-lens, the MCP adapter, plan mode,
 * rewind, the permission system, subagents, auto mode, and one the footer knows nothing about.
 * A prompt of `activate` brings the language servers and MCP servers up.
 */
const statuses: Scenario = {
  name: "statuses",
  run: (prompt) => {
    const up = prompt === "activate";
    const set = (statusKey: string, statusText: string): Beat => ({
      ui: uiRequest({ id: `status-${statusKey}`, method: "setStatus", statusKey, statusText }),
    });
    return [
      ...START,
      ...userTurn(prompt),
      set("pi-lens-lsp", up ? "\x1b[32mLSP Active: typescript\x1b[39m" : "\x1b[2mLSP Inactive\x1b[22m"),
      set("mcp", up ? "MCP: 2 servers (2 connected)" : "MCP: 2 servers (1 connected)"),
      set("plan-mode", "plan ready"),
      set("rewind", "\x1b[2m◆ \x1b[22m3 checkpoints"),
      set("pi-permission-system", "yolo"),
      set("subagents", "2 running agents"),
      set("pi-automode", "AM ● a:7 d:2 ca:7 cd:1"),
      set("indexer", "indexing 42 files"),
      ...assistantTurn({ text: up ? "Servers up." : "Statuses set." }),
      ...END,
    ];
  },
};

/**
 * pi-automode's session-long counts across turns: the session opens at none denied, `first`
 * denies twice, `second` denies nothing, `third` denies once, and `off` turns auto mode off.
 */
const automode: Scenario = {
  name: "automode",
  run: (prompt) => {
    const set = (seq: number, text: string): Beat => ({
      ui: uiRequest({
        id: `automode-${prompt}-${seq}`,
        method: "setStatus",
        statusKey: "pi-automode",
        statusText: `\x1b[36m${text}\x1b[39m`,
      }),
    });
    const during: Record<string, Beat[]> = {
      first: [set(1, "AM ● a:1 d:1"), set(2, "AM ● a:1 d:2")],
      second: [set(1, "AM ● a:4 d:2")],
      third: [set(1, "AM ● a:5 d:3")],
      off: [set(1, "AM ○ a:5 d:3")],
    };
    return [
      ...(prompt === "first" ? [set(0, "AM ● a:0 d:0")] : []),
      ...START,
      ...userTurn(prompt),
      ...(during[prompt] ?? []),
      ...assistantTurn({ text: `Turn ${prompt} done.` }),
      ...END,
    ];
  },
};

/** The agent dies mid-run. */
const crash: Scenario = {
  name: "crash",
  run: (prompt) => [...START, ...userTurn(prompt), ...assistantTurn({ text: "Starting." }), { exit: 3 }],
};

/** A session with history, as `pi --continue` opens one. */
const resumed: Scenario = {
  name: "resumed",
  history: [
    stored.compaction("Earlier: set up the payout limits module.", 120_000),
    stored.user("cap the window at 168h"),
    stored.assistant({
      text: "Adding the upper bound.",
      toolCall: { id: "c1", name: "edit", args: { path: "limits.ts" } },
    }),
    stored.toolResult({ id: "c1", name: "edit", output: "applied +6 -2" }),
    stored.custom({ customType: "proposed-plan", text: "1. read limits.ts\n2. add the upper bound" }),
    stored.assistant({ text: "Both bounds hold." }),
  ],
  run: (prompt) => agentRun([userTurn(prompt), assistantTurn({ text: `You said: ${prompt}` })]),
};

/** An extension command that swaps in a fresh session, as pi-plan-mode starts an implementation. */
const fresh: Scenario = {
  name: "fresh",
  commands: [{ name: "fresh", description: "Start the implementation afresh", source: "extension" }],
  run: (prompt) =>
    prompt === "/fresh"
      ? [{ session: [stored.user("implement the plan"), stored.assistant({ text: "Implementing." })] }]
      : [
          ...agentRun([userTurn(prompt), assistantTurn({ text: "Planned." })]),
          ...customTurn(stored.custom({ customType: "proposed-plan", text: "1. do it" })),
        ],
};

/** Commands the operator runs: `count` streams slowly enough to be cancelled. */
const shell: Scenario = {
  name: "shell",
  bash: (command) =>
    command === "count" ? Array.from({ length: 40 }, (_, index) => `tick ${index + 1}`) : [`ran: ${command}`],
  run: (prompt) => agentRun([userTurn(prompt), assistantTurn({ text: `You said: ${prompt}` })]),
};

/** One assistant turn that calls a tool, and the tool's run. */
function call(
  id: string,
  name: string,
  args: ToolArgs,
  output: string[],
  extra: { isError?: boolean; details?: unknown; progress?: unknown[]; text?: string } = {},
): PiEvent[][] {
  const { text, ...run } = extra;
  return [
    assistantTurn({ ...(text ? { text } : {}), toolCall: { id, name, args } }),
    toolRun({ id, name, args, output, ...run }),
  ];
}

const numbered = (count: number, label: string) =>
  Array.from({ length: count }, (_, index) => `${label} ${index + 1}`).join("\n");

/** A reply that uses the markdown pi's models write. */
const markdown: Scenario = {
  name: "markdown",
  run: (prompt) =>
    agentRun([
      userTurn(prompt),
      assistantTurn({
        thinking: "The limits module needs an upper bound.",
        text: [
          "## Plan",
          "",
          "1. Read **limits.ts**",
          "2. Add the `MAX_WINDOW` bound",
          "",
          "```ts",
          "export const MAX_WINDOW = 168; // hours",
          "```",
          "",
          "> Keep the lower bound as it is.",
        ].join("\n"),
      }),
    ]),
};

/** Every built-in tool, with output long enough to collapse. */
const tools: Scenario = {
  name: "tools",
  run: (prompt) =>
    agentRun([
      userTurn(prompt),
      ...call("r1", "read", { path: "src/limits.ts", offset: 1, limit: 30 }, [numbered(30, "source line")], {
        text: "Reading first.",
      }),
      ...call(
        "e1",
        "edit",
        { path: "src/limits.ts" },
        ["Successfully replaced 1 block(s) in src/limits.ts."],
        {
          details: {
            diff: [
              "  4 const HOUR = 3600;",
              "- 5 const MAX = 24;",
              "+ 5 const MAX = 168;",
              "  6 export {};",
            ].join("\n"),
          },
        },
      ),
      ...call("b1", "bash", { command: "just check" }, [numbered(12, "check")]),
      ...call("g1", "grep", { pattern: "MAX", path: "src" }, ["src/limits.ts:5: const MAX = 168;"]),
      ...call("w1", "write", { path: "NOTES.md", content: "# Notes\nupper bound added" }, [""]),
      ...call("x1", "bash", { command: "false" }, ["exit status 1"], { isError: true }),
      assistantTurn({ text: "Done." }),
    ]),
};

/** The todo tool as rpiv-todo reports it, and its widget of the list as pi's bridge extension draws it. */
const todo: Scenario = {
  name: "todo",
  run: (prompt) => [
    ...START,
    ...userTurn(prompt),
    ...call("t1", "todo", { action: "create" }, ["3 tasks"], {
      details: {
        action: "create",
        tasks: [
          { id: 1, subject: "Read limits.ts", status: "completed" },
          {
            id: 2,
            subject: "Add the upper bound",
            status: "in_progress",
            activeForm: "Adding the upper bound",
          },
          { id: 3, subject: "Update the docs", status: "pending" },
        ],
      },
    }).flat(),
    {
      ui: uiRequest({
        id: "ui-1",
        method: "setWidget",
        widgetKey: "rpiv-todos",
        widgetLines: [
          "\u25cf Todos (1/3)",
          "\u251c\u2500 \u2713 Read limits.ts",
          "\u251c\u2500 \u25d0 Add the upper bound (Adding the upper bound)",
          "\u2514\u2500 \u25cb Update the docs",
        ],
        widgetPlacement: "aboveEditor",
      }),
    },
    ...assistantTurn({ text: "Working through the list." }),
    ...END,
  ],
};

/** Tools from the operator's packages, rendered from their details. */
const packages: Scenario = {
  name: "packages",
  run: (prompt) =>
    agentRun([
      userTurn(prompt),
      ...call("s1", "subagent", { prompt: "survey" }, ["found 3 call sites"], {
        details: {
          displayName: "scout",
          description: "find the call sites",
          status: "completed",
          toolUses: 7,
          tokens: 12_400,
          durationMs: 8_300,
        },
      }),
      ...call("q1", "ask_user_question", { questions: [] }, ["answered"], {
        details: { answers: [{ question: "Cap at?", answer: "168h" }], cancelled: false },
      }),
      ...call("w1", "web_search", { query: "payout limits" }, ["2 results"], {
        details: { phase: "curator-fallback", curatorUrl: CURATOR_URL },
      }),
      ...call("p1", "plan_mode_complete", {}, ["plan saved"], {
        details: { plan: "1. **Read** limits.ts\n2. Add the bound" },
      }),
      assistantTurn({ text: "All four tools reported." }),
    ]),
};

/** A reply cut off at the output limit. */
const cutoff: Scenario = {
  name: "cutoff",
  run: (prompt) => {
    const events = agentRun([userTurn(prompt), assistantTurn({ text: "This answer runs long and" })]);
    return events.map((event) =>
      event.type === "message_end" && (event.message as { role?: string }).role === "assistant"
        ? ({ ...event, message: { ...event.message, stopReason: "length" } } as PiEvent)
        : event,
    );
  },
};

/** A compaction that stays in progress once the reply is done, long enough to be seen. */
const compacting: Scenario = {
  name: "compacting",
  run: (prompt) => [
    ...agentRun([userTurn(prompt), assistantTurn({ text: `You said: ${prompt}` })]),
    { type: "compaction_start", reason: "threshold" },
  ],
};

/** A session near the end of its context window. */
const crowded: Scenario = {
  name: "crowded",
  context: 93,
  run: (prompt) => agentRun([userTurn(prompt), assistantTurn({ text: `You said: ${prompt}` })]),
};

/** A retry that waits long enough to be seen and cancelled. */
const retryWait: Scenario = {
  name: "retry-wait",
  run: (prompt) => [
    { type: "agent_start" },
    { type: "turn_start" },
    ...userTurn(prompt),
    ...failedTurn("529 overloaded_error"),
    { type: "agent_end", messages: [], willRetry: true },
    {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 30_000,
      errorMessage: "529 overloaded_error",
    },
  ],
};

/** Escape sequences where a model, a tool, and an extension could put them. */
const hostile: Scenario = {
  name: "hostile",
  run: (prompt) => [
    ...START,
    ...userTurn(prompt),
    {
      ui: uiRequest({
        id: "ui-1",
        method: "notify",
        message: "notice\x1b]0;PWNED-NOTIFY\x07 done",
        notifyType: "info",
      }),
    },
    ...assistantTurn({
      text: "reply \x1b]52;c;cHduZWQ=\x07\x1b]0;PWNED-TEXT\x07\x1b[2J still here",
      toolCall: { id: "c1", name: "bash", args: { command: "cat evil" } },
    }),
    ...toolRun({
      id: "c1",
      name: "bash",
      args: { command: "cat evil" },
      output: ["line\x1b\x1b[m]0;PWNED-TOOL\x07 end"],
    }),
    ...END,
  ],
};

/** An agent that turns every prompt away, as pi does when no model can take it. */
const refusing: Scenario = {
  name: "refusing",
  refuse: () => "No API key found for anthropic",
  run: () => [],
};

/** A reply pi cannot send because Anthropic turned down the stored refresh token, in pi 0.87's words. */
const expiredLogin: Scenario = {
  name: "expired-login",
  run: (prompt) =>
    agentRun([
      userTurn(prompt),
      failedTurn(
        [
          'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://platform.claude.com/v1/oauth/token; details=Error: HTTP request failed. status=400; url=https://platform.claude.com/v1/oauth/token; body={"error": "invalid_grant", "error_description": "Refresh token expired"}; stack=Error: HTTP request failed. status=400; url=https://platform.claude.com/v1/oauth/token; body={"error": "invalid_grant", "error_description": "Refresh token expired"}',
          "    at postJson (/$bunfs/root/pi:275778:11)",
          "    at refreshAnthropicToken (/$bunfs/root/pi:275898:34)",
          "    at processTicksAndRejections (native)",
        ].join("\n"),
      ),
    ]),
};

/** MCP servers failing to connect as a run starts them, in pi-mcp-adapter's words. */
const mcpFailure: Scenario = {
  name: "mcp-failure",
  run: (prompt) => [
    ...START,
    ...userTurn(prompt),
    {
      ui: uiRequest({
        id: "ui-1",
        method: "notify",
        message:
          'MCP: Failed to connect to linear: Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"Missing or invalid access token"} \u2014 probe: auth-required',
        notifyType: "error",
      }),
    },
    {
      ui: uiRequest({
        id: "ui-2",
        method: "notify",
        message:
          "MCP: Failed to connect to local-db: fetch failed \u2014 ECONNREFUSED \u2014 macOS Local Network Privacy may be blocking access. Check System Settings > Privacy & Security > Local Network for the app hosting Pi; enable access if listed and restart it.",
        notifyType: "error",
      }),
    },
    ...assistantTurn({ text: "Carrying on without them." }),
    ...END,
  ],
};

/** One exchange of a long session: a question, a markdown answer with code, and an edit. */
function exchange(index: number): unknown[] {
  const id = `s${index}`;
  return [
    stored.user(`step ${index}: tighten the retry window in module ${index}`),
    stored.assistant({
      text: `Reading module ${index}.\n\n- keeps the **upper** bound\n- drops the \`legacy\` path\n\n\`\`\`ts\nexport const window${index} = clamp(hours, 1, 168);\n\`\`\``,
      toolCall: { id, name: "edit", args: { path: `module${index}.ts` } },
    }),
    stored.toolResult({ id, name: "edit", output: `applied +${index % 9} -${index % 5}` }),
  ];
}

/** A session long enough that only a window of it is drawn. */
const sprawl: Scenario = {
  name: "sprawl",
  history: Array.from({ length: 300 }, (_, index) => exchange(index + 1)).flat(),
  run: (prompt) => agentRun([userTurn(prompt), assistantTurn({ text: `You said: ${prompt}` })]),
};

/** A long markdown reply streamed in small deltas, as a fast model sends it. */
const torrent: Scenario = {
  name: "torrent",
  run: (prompt) =>
    agentRun([
      userTurn(prompt),
      assistantTurn({
        text: `${Array.from(
          { length: 60 },
          (_, index) =>
            `## Part ${index + 1}\n\nThe window holds at **${index + 1}h** and the \`limits\` table follows it.\n\n\`\`\`ts\nconst part${index + 1} = limit(${index + 1});\n\`\`\``,
        ).join("\n\n")}\n\nTorrent done.`,
        parts: 2000,
      }),
    ]),
};

/** Epoch seconds `hours` from now, as Anthropic writes a limit's reset. */
const hence = (hours: number) => String(Math.floor(Date.now() / 1000 + hours * 3600));

/** A reply carrying a Claude subscription's usage-limit headers, as a provider response does. */
function limited(headers: Record<string, string>): Scenario["run"] {
  return (prompt) => [
    ...agentRun([userTurn(prompt), assistantTurn({ text: `You said: ${prompt}` })]).slice(0, -2),
    { limits: headers },
    ...END,
  ];
}

const U = "anthropic-ratelimit-unified-";

/** Well within every limit. */
const limitsCalm: Scenario = {
  name: "limits-calm",
  run: limited({
    [`${U}status`]: "allowed",
    [`${U}5h-utilization`]: "0.34",
    [`${U}5h-reset`]: hence(3),
    [`${U}7d-utilization`]: "0.12",
    [`${U}7d-reset`]: hence(96),
    [`${U}representative-claim`]: "five_hour",
    [`${U}overage-status`]: "allowed",
  }),
};

/** The weekly limit nearly reached, which Anthropic warns of. */
const limitsWarning: Scenario = {
  name: "limits-warning",
  run: limited({
    [`${U}status`]: "allowed_warning",
    [`${U}5h-utilization`]: "0.62",
    [`${U}5h-reset`]: hence(2),
    [`${U}7d-utilization`]: "0.93",
    [`${U}7d-reset`]: hence(50),
    [`${U}representative-claim`]: "seven_day",
    [`${U}overage-status`]: "allowed",
  }),
};

/** The five-hour limit reached, and replies continuing as extra usage. */
const limitsExtra: Scenario = {
  name: "limits-extra",
  run: limited({
    [`${U}status`]: "rejected",
    [`${U}5h-utilization`]: "1.0",
    [`${U}5h-reset`]: hence(0.7),
    [`${U}7d-utilization`]: "0.71",
    [`${U}7d-reset`]: hence(80),
    [`${U}representative-claim`]: "five_hour",
    [`${U}overage-status`]: "allowed",
    [`${U}overage-in-use`]: "true",
    [`${U}overage-period-monthly-utilization`]: "0.42",
    [`${U}overage-reset`]: hence(12 * 24),
  }),
};

/** Every scenario, by the name FAKE_PI_SCENARIO selects it by. */
export const scenarios = new Map<string, Scenario>(
  Object.entries({
    "limits-calm": limitsCalm,
    "limits-warning": limitsWarning,
    "limits-extra": limitsExtra,
    sprawl,
    torrent,
    hostile,
    refusing,
    "expired-login": expiredLogin,
    "mcp-failure": mcpFailure,
    failure,
    crowded,
    "retry-wait": retryWait,
    markdown,
    tools,
    todo,
    packages,
    cutoff,
    compacting,
    shell,
    resumed,
    fresh,
    permission,
    dialogs,
    ready,
    display,
    statuses,
    automode,
    crash,
    hello,
    providers,
    thinking,
    tool,
    "tool-error": toolError,
    long,
    phases,
    retry,
    queue,
  }),
);

export function getScenario(name: string): Scenario {
  const scenario = scenarios.get(name);
  if (!scenario) {
    throw new Error(`unknown scenario "${name}"; available: ${[...scenarios.keys()].join(", ")}`);
  }
  return scenario;
}
