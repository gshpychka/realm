// Runs one benchmark at a time as a runner process and keeps its status for the page.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { benchArgs, parseSampleProgress } from "@probabench/domain";
import type { BenchRequest, BridgeFailure, BridgeStatus, Job } from "../src/bridge/protocol";

/** The page shows this much of the end of the runner's output. */
const MAX_LOG_CHARS = 64_000;
/** A stuck provider request must not keep a paid run alive after a cancel. */
const KILL_AFTER_MS = 3_000;

const keepTail = (log: string): string => log.slice(-MAX_LOG_CHARS);

export function createBenchController({
  configured,
  launch,
}: {
  /** Whether the dev server has the sampling and history credentials. */
  readonly configured: boolean;
  /** Starts the runner with these flags; the key reaches it through the environment. */
  readonly launch: (args: readonly string[]) => ChildProcess;
}) {
  let job: Job | null = null;
  let runner: ChildProcess | null = null;
  let stopping = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const update = (change: (current: Job) => Partial<Job>) => {
    if (job) job = { ...job, ...change(job) };
  };
  const status = (): BridgeStatus => ({ configured, job });

  return {
    status,
    start(request: BenchRequest): BridgeStatus | BridgeFailure {
      if (runner) return { error: "A benchmark is already running or stopping." };
      if (!configured)
        return {
          error:
            "Set OPENROUTER_API_KEY in secrets/infra/probabench.env, then start the page with bun run dev.",
        };
      const child = launch([...benchArgs(request), "--yes"]);
      runner = child;
      stopping = false;
      job = {
        id: randomUUID(),
        status: "running",
        startedAt: new Date().toISOString(),
        log: "",
        progress: null,
      };

      // Whole lines only: an escape sequence never spans a newline, so stripping needs no
      // state across chunks. @effect/cli renders ANSI regardless of NO_COLOR, so escapes
      // are stripped here.
      const appendLine = (raw: string) => {
        const line = stripVTControlCharacters(raw);
        update((current) => ({
          log: keepTail(`${current.log}${line}\n`),
          progress: parseSampleProgress(line) ?? current.progress,
        }));
      };
      for (const stream of [child.stdout, child.stderr])
        if (stream) createInterface({ input: stream, crlfDelay: Infinity }).on("line", appendLine);

      child.on("error", () => {
        // Node also emits "error" when a kill fails; only a missing pid means Bun never started.
        if (child.pid === undefined)
          update(() => ({
            error: "Could not start Bun. Run the page from the Realm infra development shell.",
          }));
      });
      child.once("close", (code) => {
        clearTimeout(killTimer);
        runner = null;
        // A run that saved before a late cancel landed exits 0 and is completed. A stop that
        // cut it short exits 130 on SIGTERM, or with no code after SIGKILL.
        update((current) =>
          code === 0
            ? { status: "completed" }
            : stopping
              ? { status: "cancelled" }
              : {
                  status: "failed",
                  error:
                    current.error ??
                    "The benchmark stopped before completing. See the runner output for details.",
                },
        );
      });
      return status();
    },
    cancel(): BridgeStatus {
      if (runner && !stopping) {
        stopping = true;
        const child = runner;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
        killTimer.unref();
      }
      return status();
    },
  };
}
export type BenchController = ReturnType<typeof createBenchController>;
