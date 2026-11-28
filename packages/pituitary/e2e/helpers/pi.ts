import { mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { boot, type Harness, REPO } from "./harness.ts";

/** The pinned Pi CLI, which regular-Pi scenarios run instead of the operator's own Pi. */
export const PI_CLI = join(
  REPO,
  "packages/tui/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
);
/** The ChatGPT model the scenarios talk to; Pi knows it from its catalog. */
export const MODEL = "gpt-6.1-sol";
const MAIN = join(REPO, "packages/tui/src/main.tsx");

/**
 * What the provider answers one request with: the reply's text, OpenAI Responses stream events,
 * or a reply that starts streaming and finishes only once `until` settles, keeping Pi at work.
 */
export type Reply = string | { events: readonly unknown[] } | { text: string; until: Promise<unknown> };

/** A request the provider received: its JSON body, and the latest prompt in it. */
export interface Received {
  body: Record<string, unknown>;
  prompt: string;
}

/** A stand-in for OpenAI's Responses API on localhost, answering from a script. */
export interface Provider {
  /** Every request so far, in order. */
  readonly requests: Received[];
  /** Queues replies for the next requests; with none queued, a reply repeats the prompt. */
  reply(...replies: Reply[]): void;
  readonly port: number;
  close(): Promise<void>;
}

/** The stream of one finished reply whose text is `text`. */
export function replyEvents(text: string): unknown[] {
  const item = { type: "message", id: "msg", role: "assistant" };
  return [
    { type: "response.created", response: { id: "resp", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { ...item, content: [{ type: "output_text", text }] },
    },
    {
      type: "response.completed",
      response: { id: "resp", status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
    },
  ];
}

/** Answers `Reply to: <prompt>` unless a test queued something else. */
export async function fakeProvider(): Promise<Provider> {
  const requests: Received[] = [];
  const queued: Reply[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const received = { body: parsed, prompt: latestPrompt(parsed) };
      requests.push(received);
      const reply = queued.shift() ?? `Reply to: ${received.prompt}`;
      const events =
        typeof reply === "string"
          ? replyEvents(reply)
          : "events" in reply
            ? reply.events
            : replyEvents(reply.text);
      const stream = (part: readonly unknown[]) =>
        part.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (typeof reply === "object" && "until" in reply) {
        response.write(stream(events.slice(0, 2)));
        void reply.until.then(() => response.end(stream(events.slice(2))));
      } else response.end(stream(events));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    reply: (...replies) => queued.push(...replies),
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The text of the last user item in a Responses request. */
function latestPrompt(body: Record<string, unknown>): string {
  const input = Array.isArray(body.input) ? (body.input as Record<string, unknown>[]) : [];
  const user = input.findLast((item) => item.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return (Array.isArray(user.content) ? (user.content as Record<string, unknown>[]) : [])
    .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
    .join("\n");
}

export interface PiLaunchOptions {
  /** Arguments for `pituitary`; the model comes first unless they choose another. */
  argv?: string[];
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /** Pi extensions to load besides Pituitary's own, by file name: their TypeScript source. */
  extensions?: Record<string, string>;
  /** Runs a Pi that never loads Pituitary's bridge extension, as a Pi that failed to load it. */
  withoutBridge?: boolean;
  /** An earlier launch's HOME, whose sessions and provider this launch takes over. */
  from?: PiLaunch;
  /** The project directory inside HOME that Pituitary runs in. */
  project?: string;
  /** Text on the first frame; the footer's model by default. */
  ready?: string;
}

export interface PiLaunch extends Harness {
  /** The throwaway HOME, which holds Pi's agent directory and the project. */
  home: string;
  /** The project Pituitary runs in. */
  cwd: string;
  /** Pi's agent directory, `PI_CODING_AGENT_DIR`. */
  agent: string;
  provider: Provider;
  /** The session files Pi has written for every project, oldest first. */
  sessions(): string[];
}

/**
 * Regular Pituitary, as `main.tsx` runs it, over the pinned Pi CLI in a throwaway HOME.
 * Pi signs in to ChatGPT with a placeholder credential and talks to `provider` on localhost,
 * so no request leaves the machine and every one can be inspected.
 */
export async function launchPi(options: PiLaunchOptions = {}): Promise<PiLaunch> {
  const {
    argv = [],
    cols,
    rows,
    env = {},
    extensions = {},
    withoutBridge = false,
    from,
    project = "sample",
    ready = MODEL,
  } = options;
  const home = from?.home ?? realpathSync(mkdtempSync("/tmp/pituitary-pi-"));
  const agent = join(home, ".pi", "agent");
  const cwd = join(home, project);
  const provider = from?.provider ?? (await fakeProvider());
  mkdirSync(cwd, { recursive: true });
  if (!from) {
    mkdirSync(agent, { recursive: true });
    writeFileSync(
      join(agent, "auth.json"),
      JSON.stringify({
        openai: { type: "oauth", access: "chatgpt-fixture", refresh: "fixture", expires: Date.now() + 864e5 },
      }),
    );
    writeFileSync(
      join(agent, "models.json"),
      JSON.stringify({ providers: { openai: { baseUrl: `http://127.0.0.1:${provider.port}/v1` } } }),
    );
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  }
  const loaded = Object.entries(extensions).map(([name, source]) => {
    const path = join(home, "extensions", name);
    mkdirSync(join(home, "extensions"), { recursive: true });
    writeFileSync(path, source);
    return path;
  });
  const pi = [PI_CLI, "--no-extensions", "--no-skills", ...loaded.flatMap((path) => ["--extension", path])];
  const harness = await boot({
    entry: MAIN,
    argv: argv.includes("--model") ? argv : ["--model", `openai/${MODEL}`, ...argv],
    cwd,
    cols,
    rows,
    ready,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      PI_AGENT_CMD: "node",
      PI_AGENT_ARGS: (withoutBridge ? [bridgeless(home), ...pi] : pi).join(" "),
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PITUITARY_STILL: "1",
      PITUITARY_GH: "",
      PITUITARY_LOG: join(home, "tui.log"),
      ...env,
    },
  });
  return {
    ...harness,
    home,
    cwd,
    agent,
    provider,
    sessions: () => sessionFiles(join(agent, "sessions")),
  };
}

/** A script that runs Pi with every argument but the one loading Pituitary's bridge extension. */
function bridgeless(home: string): string {
  const path = join(home, "pi-without-bridge.mjs");
  writeFileSync(
    path,
    `import { spawn } from "node:child_process";
const args = process.argv.slice(2);
const kept = args.filter((arg, index) => !arg.endsWith("pi-bridge-extension.ts") && !(arg === "--extension" && args[index + 1]?.endsWith("pi-bridge-extension.ts")));
spawn(process.execPath, kept, { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 1));
`,
  );
  return path;
}

function sessionFiles(root: string): string[] {
  let found: string[] = [];
  try {
    for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (statSync(path).isDirectory()) found = [...found, ...sessionFiles(path)];
      else if (name.endsWith(".jsonl")) found.push(path);
    }
  } catch {
    return [];
  }
  return found.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}
