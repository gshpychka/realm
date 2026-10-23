import type { Attempt, RunDetail } from "./model.ts";
import type { Runtime } from "./client.ts";

export function rootAttempt(detail: RunDetail): Attempt {
  const task = detail.tasks.find((item) => item.id === detail.run.rootTaskId);
  const attempt = detail.attempts.find((item) => item.id === task?.currentAttemptId);
  if (!attempt) throw new Error("Root task has no current attempt");
  return attempt;
}

/** Poll observable state rather than assuming a durable command has finished its effects. */
export async function waitRun(
  runtime: Runtime,
  name: string,
  predicate: (detail: RunDetail) => boolean,
  timeout = 10_000,
): Promise<RunDetail> {
  const deadline = Date.now() + timeout;
  let detail = await runtime.inspect(name);
  while (!predicate(detail)) {
    if (Date.now() >= deadline) throw new Error(`Run did not settle: ${JSON.stringify(detail)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    detail = await runtime.inspect(name);
  }
  return detail;
}
