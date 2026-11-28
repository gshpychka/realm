import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { boot, type Harness, REPO, survivors } from "./harness.ts";

/** The pinned Pi CLI, which regular-Pi scenarios run instead of the operator's own Pi. */
export const PI_CLI = join(
  REPO,
  "packages/tui/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
);
/** The ChatGPT model the scenarios talk to unless they bring API models; Pi knows it from its catalog. */
export const MODEL = "gpt-6.1-sol";
/** MODEL as Pi's catalog names it, which the footer shows. */
export const MODEL_NAME = "GPT-6.1 Sol";
/** The placeholder key Pi signs in to API models with, which nothing may show. */
export const API_KEY = "fixture-secret";
const MAIN = join(REPO, "packages/tui/src/main.tsx");

/**
 * What the provider answers one request with: the reply's text, or that text with response
 * headers, such as a provider's rate limits, and an `until` that holds the reply's end back
 * until it settles, keeping Pi at work; a call of one of Pi's tools, which Pi runs and answers
 * with the next request; or an error status with its JSON body. Replies stream in the API the
 * request came in.
 */
export type Reply =
  | string
  | { text: string; until?: Promise<unknown>; headers?: Record<string, string> }
  | { tool: string; arguments: Record<string, unknown> }
  | { status: number; body: unknown };

/** A request the provider received: its JSON body, and the latest prompt in it. */
export interface Received {
  body: Record<string, unknown>;
  prompt: string;
}

/** A stand-in for OpenAI's Responses and Chat Completions APIs on localhost, answering from a script. */
export interface Provider {
  /** Every request so far, in order. */
  readonly requests: Received[];
  /** Queues replies for the next requests; with none queued, a reply repeats the prompt. */
  reply(...replies: Reply[]): void;
  readonly port: number;
  close(): Promise<void>;
}

/** A model Pi reaches with an API key over Chat Completions, which `models.json` declares. */
export interface ApiModel {
  id: string;
  /** What Pi's registry names it; without one Pi shows the id. */
  name?: string;
}

/**
 * One reply's stream in `api`, split where a held reply waits: the Responses API's after the
 * reply has started and before its text, Chat Completions' after its text and before its end.
 */
function replyStream(api: Api, text: string): { head: unknown[]; tail: unknown[] } {
  if (api === "completions") {
    const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
      id: "chunk",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    return {
      head: [chunk({ role: "assistant", content: text }, null)],
      tail: [chunk({}, "stop"), "[DONE]"],
    };
  }
  const item = { type: "message", id: "msg", role: "assistant" };
  return {
    head: [
      { type: "response.created", response: { id: "resp", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    ],
    tail: [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...item, content: [{ type: "output_text", text }] },
      },
      {
        type: "response.completed",
        response: {
          id: "resp",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [],
        },
      },
    ],
  };
}

/** A reply that calls `name` with `args`, streamed whole in `api`, under the call id `id`. */
function toolStream(api: Api, name: string, args: Record<string, unknown>, id: string): unknown[] {
  const json = JSON.stringify(args);
  if (api === "completions") {
    const call = { index: 0, id, type: "function", function: { name, arguments: json } };
    return [
      {
        id: "chunk",
        choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }],
      },
      { id: "chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ];
  }
  const item = { type: "function_call", id: `fc_${id}`, call_id: id, name };
  return [
    { type: "response.created", response: { id: "resp", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: json } },
    {
      type: "response.completed",
      response: { id: "resp", status: "completed", usage: { input_tokens: 1, output_tokens: 1 }, output: [] },
    },
  ];
}

type Api = "responses" | "completions";

/** Server-sent events; a string goes out as it is, as Chat Completions' closing `[DONE]` does. */
const sse = (events: readonly unknown[]) =>
  events.map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");

/** Answers `Reply to: <prompt>` unless a test queued something else. */
export async function fakeProvider(): Promise<Provider> {
  const requests: Received[] = [];
  const queued: Reply[] = [];
  // Each call has an id of its own, as a provider gives it, so a run's calls stay apart.
  let calls = 0;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const api = apiOf(request);
      const received = { body: parsed, prompt: latestPrompt(parsed) };
      requests.push(received);
      const reply = queued.shift() ?? `Reply to: ${received.prompt}`;
      if (typeof reply === "object" && "status" in reply) {
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body));
        return;
      }
      if (typeof reply === "object" && "tool" in reply) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse(toolStream(api, reply.tool, reply.arguments, `call_${++calls}`)));
        return;
      }
      const { text, until, headers } = typeof reply === "string" ? { text: reply } : reply;
      const { head, tail } = replyStream(api, text);
      response.writeHead(200, { "content-type": "text/event-stream", ...headers });
      if (!until) response.end(sse([...head, ...tail]));
      else {
        response.write(sse(head));
        void until.then(() => response.end(sse(tail)));
      }
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

/** Which API a request came in: Pi posts Chat Completions to `/chat/completions`, Responses to `/responses`. */
function apiOf(request: IncomingMessage): Api {
  return request.url?.endsWith("/chat/completions") ? "completions" : "responses";
}

/** The text of the last user item in a Responses request, or the last user message in Chat Completions'. */
function latestPrompt(body: Record<string, unknown>): string {
  const items = Array.isArray(body.input) ? body.input : Array.isArray(body.messages) ? body.messages : [];
  const user = (items as Record<string, unknown>[]).findLast((item) => item.role === "user");
  if (!user) return "";
  if (typeof user.content === "string") return user.content;
  return (Array.isArray(user.content) ? (user.content as Record<string, unknown>[]) : [])
    .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
    .join("\n");
}

export interface PiLaunchOptions {
  /** Arguments for `pituitary`; the first model comes first unless they choose another. */
  argv?: string[];
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  /** Pi extensions to load besides Pituitary's own, by file name: their TypeScript source. */
  extensions?: Record<string, string>;
  /**
   * Skills Pi finds in its agent directory, by name: each `SKILL.md`'s content. Without them Pi
   * runs with `--no-skills`, so no skill of the machine's enters a scenario.
   */
  skills?: Record<string, string>;
  /** Skills Pi finds as single Markdown files in its agent directory, by name: each file's content. */
  skillFiles?: Record<string, string>;
  /** Prompt templates Pi finds in its agent directory, by name: each file's content. */
  prompts?: Record<string, string>;
  /**
   * Pi settings over the scenario's own, which turn Pi's retries off: how much history a
   * compaction keeps, or whether a tree move asks for a summary.
   */
  settings?: Record<string, unknown>;
  /** Pituitary's own key bindings, its `keybindings.json`: keys by action. */
  keybindings?: Record<string, string | string[]>;
  /** Pi's key bindings, which Pituitary follows where Pi has the same action. */
  piKeybindings?: Record<string, string | string[]>;
  /** False leaves Pi without a credential for the provider, as before a first `/login`. */
  signedIn?: boolean;
  /** Runs a Pi that never loads Pituitary's bridge extension, as a Pi that failed to load it. */
  withoutBridge?: boolean;
  /**
   * Models Pi reaches with API_KEY over Chat Completions on the provider. Without them Pi signs
   * in to ChatGPT with a placeholder credential and talks to MODEL over the Responses API.
   */
  apiModels?: readonly ApiModel[];
  /** An earlier launch's HOME, whose sessions, sign-in and provider this launch takes over. */
  from?: PiLaunch;
  /** The project directory inside HOME that Pituitary runs in. */
  project?: string;
  /** Text on the first frame; the footer's model name by default. */
  ready?: string;
  /** Records every byte Pituitary writes to the terminal, for `raw()`. */
  record?: boolean;
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
  /** Everything Pituitary wrote to the terminal, when launched with `record`. */
  raw(): string;
  /**
   * Closes Pituitary. The launch that made HOME also closes its provider and removes HOME, so a
   * relaunch `from` it closes first.
   */
  close(): Promise<void>;
}

/**
 * Regular Pituitary, as `main.tsx` runs it, over the pinned Pi CLI in a throwaway HOME, with
 * only the extensions a test names besides Pituitary's own. Pi talks to `provider` on
 * localhost, so no request leaves the machine and every one can be inspected.
 */
export async function launchPi(options: PiLaunchOptions = {}): Promise<PiLaunch> {
  const {
    argv = [],
    cols,
    rows,
    env = {},
    extensions = {},
    skills,
    skillFiles = {},
    prompts = {},
    settings = {},
    keybindings,
    piKeybindings,
    signedIn = true,
    withoutBridge = false,
    apiModels,
    from,
    project = "sample",
    record = false,
  } = options;
  const first = apiModels?.[0];
  const ready = options.ready ?? (first ? (first.name ?? first.id) : MODEL_NAME);
  const home = from?.home ?? realpathSync(mkdtempSync("/tmp/pituitary-pi-"));
  const agent = join(home, ".pi", "agent");
  const cwd = join(home, project);
  const provider = from?.provider ?? (await fakeProvider());
  const owned = async () => {
    await provider.close();
    rmSync(home, { recursive: true, force: true });
  };
  try {
    mkdirSync(cwd, { recursive: true });
    if (!from) signIn(agent, provider, { apiModels, settings, signedIn });
    if (keybindings) {
      mkdirSync(join(home, ".config", "pituitary"), { recursive: true });
      writeFileSync(join(home, ".config", "pituitary", "keybindings.json"), JSON.stringify(keybindings));
    }
    if (piKeybindings) writeFileSync(join(agent, "keybindings.json"), JSON.stringify(piKeybindings));
    const loaded = Object.entries(extensions).map(([name, source]) => {
      const path = join(home, "extensions", name);
      mkdirSync(join(home, "extensions"), { recursive: true });
      writeFileSync(path, source);
      return path;
    });
    for (const [name, content] of Object.entries(skills ?? {})) {
      mkdirSync(join(agent, "skills", name), { recursive: true });
      writeFileSync(join(agent, "skills", name, "SKILL.md"), content);
    }
    for (const [name, content] of Object.entries(skillFiles)) {
      mkdirSync(join(agent, "skills"), { recursive: true });
      writeFileSync(join(agent, "skills", `${name}.md`), content);
    }
    for (const [name, content] of Object.entries(prompts)) {
      mkdirSync(join(agent, "prompts"), { recursive: true });
      writeFileSync(join(agent, "prompts", `${name}.md`), content);
    }
    const pi = [
      PI_CLI,
      "--no-extensions",
      ...(skills || Object.keys(skillFiles).length > 0 ? [] : ["--no-skills"]),
      ...loaded.flatMap((path) => ["--extension", path]),
    ];
    const model = first ? `openai/${first.id}` : `openai/${MODEL}`;
    const harness = await boot({
      entry: MAIN,
      argv: argv.includes("--model") ? argv : ["--model", model, ...argv],
      cwd,
      cols,
      rows,
      ready,
      record: record ? join(home, "terminal.raw") : undefined,
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
      raw: () => readFileSync(join(home, "terminal.raw"), "latin1"),
      close: async () => {
        try {
          await harness.close();
        } finally {
          if (!from) await owned();
        }
      },
    };
  } catch (error) {
    if (!from) await owned();
    throw error;
  }
}

/**
 * Pi's agent directory pointed at the provider and, `signedIn`, signed in to it: ChatGPT by
 * default, or an API key for `apiModels`, with `settings` among its own.
 */
function signIn(
  agent: string,
  provider: Provider,
  options: {
    apiModels: readonly ApiModel[] | undefined;
    settings: Record<string, unknown>;
    signedIn: boolean;
  },
) {
  const { apiModels, settings, signedIn } = options;
  const baseUrl = `http://127.0.0.1:${provider.port}/v1`;
  mkdirSync(agent, { recursive: true });
  if (signedIn)
    writeFileSync(
      join(agent, "auth.json"),
      JSON.stringify({
        openai: apiModels
          ? { type: "api_key", key: API_KEY }
          : { type: "oauth", access: "chatgpt-fixture", refresh: "fixture", expires: Date.now() + 864e5 },
      }),
    );
  writeFileSync(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        openai: apiModels ? { baseUrl, api: "openai-completions", models: apiModels } : { baseUrl },
      },
    }),
  );
  // A refused request shows as it failed, rather than after Pi's retries.
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, ...settings }));
}

/** Ends the launch's Pi at once, as a crash would, leaving Pituitary running. */
export function killPi(launch: PiLaunch): void {
  // Pi retitles its process `pi`.
  const pi = survivors(launch.home).find((line) => /^\d+ pi$/.test(line));
  if (!pi) throw new Error(`no Pi runs with HOME=${launch.home}`);
  process.kill(Number(pi.split(" ")[0]), "SIGKILL");
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
