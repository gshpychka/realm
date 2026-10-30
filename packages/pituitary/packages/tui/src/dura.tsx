import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { type ConversationClient, Runtime } from "@realm/dura/client";
import type { DuraOptions } from "./cli.ts";
import { attachCommand, openLog } from "./config.ts";
import { ManagedWorkspace } from "./managed.tsx";
import { prewarm } from "./nvim/engine.ts";
import { mark } from "./profile.ts";
import { type ManagedView, RELOAD_UI, readManagedView, watchFrontend, writeManagedView } from "./ui-state.ts";

export async function runDura(options: DuraOptions): Promise<void> {
  const log = openLog();
  process.on("unhandledRejection", (reason) => log.write(`unhandled rejection: ${String(reason)}\n`));
  const runtime = new Runtime({
    stateDirectory: options.state,
    socketPath: options.socket,
  });
  const detail = await runtime.inspect(options.run);
  const saved = readManagedView(process.env.PITUITARY_UI_STATE);
  const selected =
    process.env.PITUITARY_UI_RESUME === "1" && saved && detail.tasks.some((task) => task.id === saved.taskId)
      ? saved.taskId
      : (options.task ?? detail.run.rootTaskId);
  let client: ConversationClient = await runtime.connect(
    detail.run.id,
    process.env.PITUITARY_UI_RESUME === "1" && saved ? saved.control : true,
    selected,
  );
  mark("agent-spawned");
  prewarm();
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 120, maxFps: 120 });
  mark("renderer");
  const root = createRoot(renderer);
  renderer.once("frame", () => mark("first-frame"));
  let capture: (() => ManagedView) | undefined;
  let stopWatching: (() => void) | undefined;
  let quitting = false;
  const quit = (code = 0) => {
    if (quitting) return;
    const view = capture?.();
    try {
      if (view) writeManagedView(process.env.PITUITARY_UI_STATE, view);
    } catch (error) {
      log.write(`saving frontend state: ${String(error)}\n`);
      if (code === RELOAD_UI) return;
    }
    quitting = true;
    stopWatching?.();
    mark("quit");
    const closing = client.close();
    root.unmount();
    mark("ui-unmounted");
    renderer.destroy();
    mark("renderer-destroyed");
    void closing.then(() => {
      mark("agent-closed");
      if (code !== RELOAD_UI)
        process.stdout.write(
          `Detached from run ${detail.run.name}. To reconnect: ${attachCommand(detail.run.name, { stateDirectory: options.state, taskId: view?.taskId ?? selected, socketPath: options.socket })}\n`,
        );
      process.exit(code);
    });
  };
  process.once("SIGTERM", () => quit());
  process.once("SIGHUP", () => quit());
  process.once("exit", () => mark("exit"));
  root.render(
    <ManagedWorkspace
      runtime={runtime}
      initial={detail}
      taskId={selected}
      client={client}
      saved={saved}
      onClient={(next) => {
        client = next;
      }}
      onCapture={(next) => {
        capture = next;
      }}
      onQuit={() => quit()}
      onReload={() => quit(RELOAD_UI)}
    />,
  );
  if (options.watch) stopWatching = watchFrontend(() => quit(RELOAD_UI));
}
