import { spawn } from "node:child_process";
import type { IncomingMessage } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createBenchController, isLocalRequest, parseBenchRequest } from "./local-bench";

const settings = {
  model: "openai/example:free",
  trialsPerStep: 10,
  stepPercent: 25,
  concurrency: 5,
};

describe("local benchmark request boundaries", () => {
  it("accepts a model slug and preserves the default reasoning choice", () => {
    expect(parseBenchRequest(settings)).toEqual(settings);
  });
  it.each([
    null,
    { ...settings, model: "all" },
    { ...settings, model: "future-model" },
    { ...settings, model: "vendor/model+variant" },
    { ...settings, model: "--help" },
    { ...settings, model: "model; touch /tmp/oops" },
    { ...settings, model: "a,b" },
    { ...settings, trialsPerStep: 0 },
    { ...settings, trialsPerStep: 1.5 },
    { ...settings, stepPercent: 101 },
    { ...settings, concurrency: 51 },
    { ...settings, reasoning: "secret" },
    { ...settings, trialsPerStep: 10_000, stepPercent: 1 },
  ])("rejects invalid or excessive plans before launch: %j", (value) => {
    expect(() => parseBenchRequest(value)).toThrow();
  });

  const request = (host: string, origin?: string, address = "127.0.0.1") =>
    ({
      headers: { host, ...(origin ? { origin } : {}) },
      socket: { remoteAddress: address },
    }) as IncomingMessage;

  it("allows same-origin localhost mutations and local status reads", () => {
    expect(isLocalRequest(request("localhost:5173", "http://localhost:5173"), true)).toBe(true);
    expect(isLocalRequest(request("127.0.0.1:5173"), false)).toBe(true);
    expect(isLocalRequest(request("[::1]:5173", "http://[::1]:5173", "::1"), true)).toBe(true);
  });
  it("rejects remote callers, DNS rebinding, cross-site and missing-origin mutations", () => {
    expect(isLocalRequest(request("127.0.0.1:5173", "https://example.com"), true)).toBe(false);
    expect(isLocalRequest(request("evil.example:5173", "http://evil.example:5173"), true)).toBe(
      false,
    );
    expect(isLocalRequest(request("localhost:5173"), true)).toBe(false);
    expect(isLocalRequest(request("localhost:5173", undefined, "192.168.1.5"), false)).toBe(false);
    expect(isLocalRequest(request("localhost:5173@evil.example"), false)).toBe(false);
  });
});

async function until(check: () => boolean) {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (check()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for local child process");
}

describe("local benchmark lifecycle", () => {
  it("does not launch before a key is configured", () => {
    let launched = false;
    const controller = createBenchController({
      workspace: "/tmp",
      apiKey: () => "",
      launch: () => {
        launched = true;
        throw new Error("should not launch");
      },
    });
    expect(controller.status().configured).toBe(false);
    expect(() => controller.start(settings)).toThrow("OPENROUTER_API_KEY");
    expect(launched).toBe(false);
  });

  it("passes settings as arguments, redacts secrets, and reports completion", async () => {
    let argumentsPassed: readonly string[] = [];
    const controller = createBenchController({
      workspace: "/tmp",
      apiKey: () => "test-secret",
      launch: (args, key) => {
        argumentsPassed = args;
        return spawn(
          process.execPath,
          [
            "-e",
            "console.log('progress ' + process.env.TEST_KEY.slice(0, 5) + '\\x1b[31m' + process.env.TEST_KEY.slice(5) + '\\x1b[0m')",
          ],
          {
            env: { ...process.env, TEST_KEY: key },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      },
    });
    const job = controller.start(settings);
    expect(job.status).toBe("running");
    await until(() => job.status !== "running");
    expect(job.status).toBe("completed");
    expect(argumentsPassed).toContain(settings.model);
    expect(argumentsPassed).toContain("--yes");
    expect(argumentsPassed).not.toContain("--reasoning");
    expect(argumentsPassed).not.toContain("test-secret");
    expect(job.log).toContain("progress [redacted]");
    expect(job.log).not.toContain("test-secret");
    expect(job.log).not.toContain(String.fromCharCode(27));
  });

  it("limits concurrent writers, cancels active work, and allows another run", async () => {
    const controller = createBenchController({
      workspace: "/tmp",
      apiKey: () => "test-key",
      launch: () =>
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
          stdio: ["ignore", "pipe", "pipe"],
        }),
    });
    const first = controller.start(settings);
    try {
      expect(() => controller.start(settings)).toThrow("already running");
      controller.cancel();
      await until(() => first.status !== "running");
      expect(first.status).toBe("cancelled");
      const next = controller.start(settings);
      expect(next.id).not.toBe(first.id);
      controller.cancel();
      await until(() => next.status !== "running");
      expect(next.status).toBe("cancelled");
    } finally {
      controller.cancel();
    }
  });

  it("holds secrets split across pipe chunks while status is polled", async () => {
    const controller = createBenchController({
      workspace: "/tmp",
      apiKey: () => "test-secret",
      launch: () =>
        spawn(
          process.execPath,
          [
            "-e",
            "process.stdout.write('progress test-secre\\x1b[31;'); setTimeout(() => process.stdout.write('1mt\\x1b[0m done'), 100)",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
    });
    const job = controller.start(settings);
    try {
      await until(() => job.log.includes("progress"));
      expect(controller.status().job?.log).not.toContain("test-");
      await until(() => job.status !== "running");
      expect(job.log).toBe("progress [redacted] done");
    } finally {
      controller.cancel();
    }
  });

  it("handles failed processes and unavailable Bun without leaking internals", async () => {
    for (const launch of [
      () =>
        spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: ["ignore", "pipe", "pipe"] }),
      () => spawn("/this-command-does-not-exist", [], { stdio: ["ignore", "pipe", "pipe"] }),
    ]) {
      const controller = createBenchController({
        workspace: "/tmp",
        apiKey: () => "test-key",
        launch,
      });
      const job = controller.start(settings);
      await until(() => job.status !== "running");
      expect(job.status).toBe("failed");
      expect(job.error).toBeTruthy();
      expect(job.error).not.toContain("ENOENT");
    }
  });
});
