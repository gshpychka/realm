import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Runtime } from "./client.ts";
import { startRuntime } from "./supervisor.ts";

const [stateDirectory, cwd] = process.argv.slice(2);
if (!stateDirectory || !cwd) throw new Error("Fixture needs state directory and workspace");
const faux = fauxProvider();
faux.setResponses([fauxAssistantMessage("The host kept this reply across frontend and runtime restarts.")]);
const models = createModels();
models.setProvider(faux.provider);
const options = { stateDirectory, models, environment: { ...process.env, DURA_MODEL: "faux/faux-1" } };
let host = await startRuntime(options);
const runtime = new Runtime({ stateDirectory });
const run = await runtime.start({
  name: "managed",
  cwd,
  prompt: "Keep this conversation while the terminal is closed.",
});
const identity = async () => {
  const detail = await runtime.inspect(run.id),
    task = detail.tasks.find((task) => task.id === detail.run.rootTaskId);
  const attempt = detail.attempts.find((attempt) => attempt.id === task?.currentAttemptId);
  return {
    runId: run.id,
    taskId: task?.id,
    conversationId: attempt?.conversationId,
    modelCalls: faux.state.callCount,
  };
};
const wait = async (predicate: () => Promise<boolean>) => {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Managed runtime fixture timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
await wait(async () => Boolean((await identity()).conversationId));
await wait(async () => {
  const attached = await runtime.connect(run.id, false);
  try {
    return JSON.stringify(await attached.getMessages()).includes("The host kept this reply");
  } finally {
    await attached.close();
  }
});
console.log(JSON.stringify(await identity()));
let pending = Promise.resolve();
process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
  const lines = input.split("\n");
  input = lines.pop() ?? "";
  for (const line of lines)
    pending = pending
      .then(async () => {
        if (line === "restart") {
          await host.close();
          host = await startRuntime(options);
          console.log(JSON.stringify({ restarted: true, ...(await identity()) }));
        }
        if (line === "archive") {
          await runtime.stop(run.id);
          await wait(async () =>
            (await runtime.inspect(run.id)).attempts.every((attempt) => attempt.status === "stopped"),
          );
          console.log(JSON.stringify({ archived: true, ...(await identity()) }));
        }
      })
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
});
let closing: Promise<void> | undefined;
process.once("SIGTERM", () => {
  closing ??= pending.then(() => host.close());
  void closing.then(
    () => process.exit(0),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
});
