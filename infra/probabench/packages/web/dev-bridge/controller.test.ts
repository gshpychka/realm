import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as flush } from "node:timers/promises";
import { benchArgs, formatPointProgress, Probability } from "@probabench/domain";
import { describe, expect, it, vi } from "vitest";
import { createBenchController } from "./controller";

const request = {
  model: "openai/example:free",
  trialsPerStep: 10,
  stepPercent: 25,
  concurrency: 5,
};

/** A runner process driven by the test: write to its streams, then end it with exit(). */
const fakeChild = ({ started = true } = {}) =>
  Object.assign(new EventEmitter(), {
    pid: started ? 1 : undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
type FakeChild = ReturnType<typeof fakeChild>;

const write = async (child: FakeChild, text: string) => {
  child.stdout.write(text);
  await flush();
};
// readline flushes a final unterminated line when its stream ends, before 'close'.
const exit = async (child: FakeChild, code: number | null) => {
  child.stdout.end();
  child.stderr.end();
  await flush();
  child.emit("close", code);
};

const withFake = (configured = true) => {
  const child = fakeChild();
  const launch = vi.fn((_args: readonly string[]) => child as unknown as ChildProcess);
  return { child, launch, controller: createBenchController({ configured, launch }) };
};

describe("createBenchController", () => {
  it("does not launch before a key is configured", () => {
    const { launch, controller } = withFake(false);
    expect(controller.status().configured).toBe(false);
    expect(() => controller.start(request)).toThrow("OPENROUTER_API_KEY");
    expect(launch).not.toHaveBeenCalled();
  });

  it("passes the request as runner flags with --yes and the runner's own --out", () => {
    const { launch, controller } = withFake();
    controller.start({ ...request, reasoning: "low" });
    expect(launch).toHaveBeenCalledWith([...benchArgs({ ...request, reasoning: "low" }), "--yes"]);
  });

  it("publishes whole lines without escapes", async () => {
    const { child, controller } = withFake();
    controller.start(request);
    await write(child, "progress sam");
    expect(controller.status().job?.log).toBe("");
    await write(child, "pled\x1b[31m\x1b[0m done\nnext");
    expect(controller.status().job?.log).toBe("progress sampled done\n");
    await exit(child, 0);
    expect(controller.status().job).toMatchObject({
      status: "completed",
      log: "progress sampled done\nnext\n",
    });
  });

  it("keeps the end of a long log, even one long line", async () => {
    const { child, controller } = withFake();
    controller.start(request);
    await write(child, `${"a".repeat(40_000)}\n${"b".repeat(70_000)}\n`);
    const log = controller.status().job?.log ?? "";
    expect(log.length).toBeLessThanOrEqual(64_000);
    expect(log.endsWith("b\n")).toBe(true);
    expect(log).not.toContain("a");
  });

  it("reports the latest finished point from the runner's progress lines", async () => {
    const { child, controller } = withFake();
    controller.start(request);
    const point = { x: Probability.make(0.25), outcomes: [1, 0] as const };
    await write(child, `${formatPointProgress({ model: "m", point, completed: 2, total: 5 })}\n`);
    await write(child, "retrying a sample\n");
    expect(controller.status().job?.progress).toEqual({ completed: 2, total: 5 });
  });

  it("runs one benchmark at a time", () => {
    const { controller } = withFake();
    controller.start(request);
    expect(() => controller.start(request)).toThrow("already running");
  });

  it("reports a cancelled run as cancelled even though the runner exits 0", async () => {
    const { child, controller } = withFake();
    controller.start(request);
    expect(controller.cancel().job?.status).toBe("running");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await exit(child, 0);
    expect(controller.status().job?.status).toBe("cancelled");
  });

  it("answers a cancel with no run with the current status", () => {
    const { controller } = withFake();
    expect(controller.cancel()).toEqual({ configured: true, job: null });
  });

  it("reports a failing exit with a pointer to the runner output", async () => {
    const { child, controller } = withFake();
    controller.start(request);
    await exit(child, 1);
    expect(controller.status().job).toMatchObject({
      status: "failed",
      error: expect.stringContaining("runner output"),
    });
  });

  it("explains a runner that never started", async () => {
    const child = fakeChild({ started: false });
    const controller = createBenchController({
      configured: true,
      launch: () => child as unknown as ChildProcess,
    });
    controller.start(request);
    child.emit("error", new Error("spawn bun ENOENT"));
    await exit(child, -2);
    expect(controller.status().job).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Could not start Bun"),
    });
  });

  it("stops a real process on cancel and accepts the next run", async () => {
    const spawned: ChildProcess[] = [];
    const controller = createBenchController({
      configured: true,
      launch: () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        spawned.push(child);
        return child;
      },
    });
    // Listening after cancel() is safe: the signalled process closes asynchronously.
    const cancelAndWait = () => {
      controller.cancel();
      return once(spawned.at(-1) as ChildProcess, "close");
    };
    const first = controller.start(request).job;
    await cancelAndWait();
    expect(controller.status().job).toMatchObject({ id: first?.id, status: "cancelled" });
    expect(controller.start(request).job?.id).not.toBe(first?.id);
    await cancelAndWait();
  });
});
