import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import type {
  AgentLink,
  AgentSnapshot,
  PiEvent,
  RpcExtensionUIRequest,
  RpcSessionState,
  SessionStats,
} from "@pituitary/rpc";
import { assistantTurn, fakeSessionState, stored } from "@pituitary/rpc";
import { useState } from "react";
import { type SessionController, useSession } from "./use-session.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const state = (sessionId: string) =>
  ({
    sessionId,
    messageCount: 0,
    isStreaming: false,
    isCompacting: false,
  }) as RpcSessionState;
const stats = (sessionId: string) => ({ sessionId }) as SessionStats;

function link(overrides: Partial<AgentLink> = {}): AgentLink {
  return {
    onEvent: () => () => {},
    onUiRequest: () => () => {},
    onClose: () => () => {},
    getState: async () => state("new"),
    getMessages: async () => [],
    getSessionStats: async () => stats("new"),
    ...overrides,
  } as AgentLink;
}

async function until(done: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("session did not update");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("late startup replies from the previous agent cannot replace the new session", async () => {
  const first = deferred<RpcSessionState>();
  let reads = 0;
  const old = link({
    getState: () => first.promise,
    getSessionStats: async () => {
      reads++;
      return stats("old");
    },
  });
  let latest!: SessionController;
  let change!: (agent: AgentLink) => void;
  function Probe() {
    const [agent, setAgent] = useState(old);
    change = setAgent;
    latest = useSession(agent);
    return null;
  }
  const app = await createTestRenderer({ width: 20, height: 4 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Probe />));
    await app.renderOnce();
    flushSync(() => change(link()));
    await until(() => latest.state?.sessionId === "new");
    first.resolve(state("old"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(latest.state?.sessionId).toBe("new");
    expect(reads).toBe(0);
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});

test("an older stats request cannot overwrite the latest refresh", async () => {
  const first = deferred<SessionStats>();
  let reads = 0;
  const agent = link({
    getSessionStats: () => (++reads === 1 ? first.promise : Promise.resolve(stats("latest"))),
  });
  let latest!: SessionController;
  function Probe() {
    latest = useSession(agent);
    return null;
  }
  const app = await createTestRenderer({ width: 20, height: 4 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Probe />));
    await until(() => reads === 1);
    await latest.refresh();
    await until(() => latest.stats?.sessionId === "latest");
    first.resolve(stats("stale"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(latest.stats?.sessionId).toBe("latest");
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});

test("late control failures from the previous agent cannot appear in the new session", async () => {
  const control = deferred<void>();
  const queue = deferred<{ steering: string[]; followUp: string[] }>();
  const old = link({
    getState: async () => state("old"),
    abort: () => control.promise,
    abortBash: () => control.promise,
    abortRetry: () => control.promise,
    clearQueue: () => queue.promise,
  });
  let latest!: SessionController;
  let change!: (agent: AgentLink) => void;
  function Probe() {
    const [agent, setAgent] = useState(old);
    change = setAgent;
    latest = useSession(agent);
    return null;
  }
  const app = await createTestRenderer({ width: 20, height: 4 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Probe />));
    await until(() => latest.state?.sessionId === "old");
    latest.abort();
    latest.abortBash();
    latest.abortRetry();
    const interrupted = latest.interrupt();
    const taken = latest.takeQueue();
    flushSync(() => change(link()));
    await until(() => latest.state?.sessionId === "new");
    control.reject(new Error("previous agent stopped"));
    queue.reject(new Error("previous queue unavailable"));
    await Promise.all([interrupted, taken]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(latest.view.entries).toEqual([]);
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});

test("queued text remains recoverable after the agent disconnects", async () => {
  let event!: (value: PiEvent) => void;
  let close!: (reason: string) => void;
  const agent = link({
    onEvent: (listener) => {
      event = listener;
      return () => {};
    },
    onClose: (listener) => {
      close = listener;
      return () => {};
    },
    clearQueue: async () => {
      throw new Error("unreachable");
    },
  });
  let latest!: SessionController;
  function Probe() {
    latest = useSession(agent);
    return null;
  }
  const app = await createTestRenderer({ width: 20, height: 4 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Probe />));
    await until(() => latest.state !== null);
    flushSync(() => {
      event({ type: "queue_update", steering: ["keep the first idea"], followUp: ["and this one"] });
      close("gone");
    });
    await until(() => latest.closed !== null);
    expect(await latest.takeQueue()).toBe("keep the first idea\n\nand this one");
    await until(() => latest.view.queue.steering.length === 0);
    expect(await latest.takeQueue()).toBe("");
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});

test("live attachment uses the snapshot cursor to include later deltas exactly once", async () => {
  const snapshot = deferred<AgentSnapshot>();
  let event!: (value: PiEvent, sequence?: number) => void;
  const agent = link({
    getSnapshot: () => snapshot.promise,
    onEvent: (listener) => {
      event = listener;
      return () => {};
    },
  });
  let latest!: SessionController;
  function Probe() {
    latest = useSession(agent);
    return null;
  }
  const app = await createTestRenderer({ width: 20, height: 4 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Probe />));
    const delta = (text: string) => {
      const value = assistantTurn({ text, parts: 1 }).find(
        (item) => item.type === "message_update" && item.assistantMessageEvent.type === "text_delta",
      );
      if (!value) throw new Error("missing delta");
      return value;
    };
    flushSync(() => {
      event(delta("first"), 4);
      event(delta(" second"), 6);
    });
    const messages = [stored.user("continue")];
    snapshot.resolve({
      sequence: 5,
      state: { ...fakeSessionState, isStreaming: true },
      messages,
      streamingMessage: stored.assistant({ text: "first" }),
      pendingToolCalls: [],
    });
    await until(() => latest.state !== null);
    expect(latest.view.running).toBe(true);
    expect(latest.view.entries.at(-1)).toMatchObject({
      kind: "assistant",
      text: "first second",
      done: false,
    });
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
});

test("a native worker can retire one dialog without dismissing another", async () => {
  let request!: (value: RpcExtensionUIRequest) => void;
  let retire!: (id: string) => void;
  let subscribed = false;
  const agent = link({
    onUiRequest: (listener) => {
      request = listener;
      return () => {};
    },
    onUiClose: (listener) => {
      retire = listener;
      subscribed = true;
      return () => {
        subscribed = false;
      };
    },
  });
  let latest!: SessionController;
  function Probe() {
    latest = useSession(agent);
    return null;
  }
  const app = await createTestRenderer({ width: 20, height: 4 });
  const root = createRoot(app.renderer);
  try {
    flushSync(() => root.render(<Probe />));
    await until(() => latest.state !== null);
    flushSync(() => {
      request({
        type: "extension_ui_request",
        id: "expired",
        method: "confirm",
        title: "Expired",
        message: "Old question",
      });
      request({
        type: "extension_ui_request",
        id: "current",
        method: "confirm",
        title: "Current",
        message: "New question",
      });
    });
    expect(latest.extensionUi.dialogs).toHaveLength(2);
    flushSync(() => retire("expired"));
    expect(latest.extensionUi.dialogs.map((dialog) => dialog.id)).toEqual(["current"]);
  } finally {
    flushSync(() => root.unmount());
    app.renderer.destroy();
  }
  expect(subscribed).toBe(false);
});
