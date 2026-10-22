import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PiRpcClient } from "./client.ts";
import type { PiEvent, RpcExtensionUIRequest } from "./protocol.ts";
import { emptySession, reduceAll, transcript } from "./session.ts";

const FAKE_AGENT = join(import.meta.dir, "../../fake-pi/src/main.ts");

function startClient(scenario: string): { client: PiRpcClient; events: PiEvent[]; stderr: string[] } {
  const events: PiEvent[] = [];
  const stderr: string[] = [];
  const client = new PiRpcClient({
    command: "bun",
    args: [FAKE_AGENT],
    env: { FAKE_PI_SCENARIO: scenario },
    onStderr: (chunk) => stderr.push(chunk),
  });
  client.onEvent((event) => events.push(event));
  client.start();
  return { client, events, stderr };
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let active: PiRpcClient | null = null;
afterEach(async () => {
  await active?.close();
  active = null;
});

describe("PiRpcClient", () => {
  test("correlates a request with its response", async () => {
    const { client } = startClient("hello");
    active = client;
    const state = await client.getState();
    expect(state.model?.id).toBe("fake-model-1");
  });

  test("streams a prompt through to a rendered transcript", async () => {
    const { client, events } = startClient("tool");
    active = client;
    await client.prompt("what is here");
    await waitFor(() => events.some((event) => event.type === "agent_end"));
    const view = reduceAll(emptySession, events);
    expect(transcript(view)).toContain("> what is here");
    expect(transcript(view)).toContain("[ok] bash flake.nix");
    expect(view.phase).toBe("idle");
  });

  test("a dialog waits for its answer and the run continues with it", async () => {
    const { client, events } = startClient("permission");
    active = client;
    const requests: RpcExtensionUIRequest[] = [];
    client.onUiRequest((request) => requests.push(request));
    await client.prompt("clean up");
    await waitFor(() => requests.length > 0);
    expect(requests[0]?.method).toBe("select");
    expect(events.some((event) => event.type === "agent_settled")).toBe(false);
    client.respond({ type: "extension_ui_response", id: requests[0]?.id ?? "", value: "No" });
    await waitFor(() => events.some((event) => event.type === "agent_settled"));
    expect(transcript(reduceAll(emptySession, events))).toContain("Left build alone (No).");
  });

  test("reports once when the agent dies", async () => {
    const { client } = startClient("crash");
    active = client;
    const reasons: string[] = [];
    client.onClose((reason) => reasons.push(reason));
    await client.prompt("go");
    await waitFor(() => reasons.length > 0);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("code=3");
    client.onClose((reason) => reasons.push(reason));
    expect(reasons).toHaveLength(2);
  });

  test("rejects a command the agent refuses", async () => {
    const { client } = startClient("hello");
    active = client;
    await expect(client.call({ type: "set_model", provider: "fake", modelId: "nope" })).rejects.toThrow(
      /unknown model/,
    );
  });

  test("a typed call resolves with what pi answers", async () => {
    const { client } = startClient("hello");
    active = client;
    const { models } = await client.call({ type: "get_available_models" });
    expect(models.map((model) => model.id)).toEqual(["fake-model-1", "fake-model-2"]);
  });

  test("abort stops the run and settles the session", async () => {
    const { client, events } = startClient("long");
    active = client;
    await client.prompt("write a lot");
    await waitFor(() => events.some((event) => event.type === "agent_start"));
    await client.abort();
    await waitFor(() => events.some((event) => event.type === "agent_end"));
    expect(reduceAll(emptySession, events).running).toBe(false);
  });

  test("pending requests reject once the agent process is gone", async () => {
    const { client } = startClient("hello");
    active = client;
    await client.getState();
    await client.close();
    await expect(client.getState()).rejects.toThrow();
  });

  test("commands sent after a crash reject immediately with the original reason", async () => {
    const { client } = startClient("crash");
    active = client;
    let reason = "";
    client.onClose((value) => {
      reason = value;
    });
    await client.prompt("go");
    await waitFor(() => Boolean(reason));
    await expect(client.prompt("again")).rejects.toThrow(reason);
    // A late dialog answer has no consumer and must not write into the broken pipe.
    client.respond({ type: "extension_ui_response", id: "late", cancelled: true });
  });

  test("ignores non-object JSON records without losing the next response", async () => {
    const client = new PiRpcClient({
      command: "bun",
      args: [
        "-e",
        `
        console.log('null\\n42\\n[]');
        for await (const line of console) {
          const request = JSON.parse(line);
          console.log(JSON.stringify({ type: 'response', command: request.type, id: request.id, success: true, data: { ok: true } }));
        }
      `,
      ],
    });
    active = client;
    client.start();
    expect(await client.request({ type: "get_state" }, 1000)).toEqual({ ok: true });
  });

  test("a duplicate request id is rejected without stranding its first caller", async () => {
    const { client } = startClient("hello");
    active = client;
    const first = client.request({ type: "get_state" }, 1000, "same");
    await expect(client.request({ type: "get_state" }, 1000, "same")).rejects.toThrow("already pending");
    await expect(first).resolves.toMatchObject({ model: { id: "fake-model-1" } });
  });
});
