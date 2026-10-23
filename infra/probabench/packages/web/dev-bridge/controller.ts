// Runs one benchmark at a time as a runner process and keeps its status for the page.
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { benchArgs, parsePointProgress } from "@probabench/domain";
import type { BenchRequest, BridgeStatus, Job } from "../src/bridge/protocol";

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** The page shows this much of the end of the runner's output. */
const MAX_LOG_CHARS = 64_000;
/** A stuck provider request must not keep a paid run alive after a cancel. */
const KILL_AFTER_MS = 3_000;

const keepTail = (log: string): string =>
  // log always ends in a newline, so the cut lands at the start of a whole line.
  log.length > MAX_LOG_CHARS ? log.slice(log.indexOf("\n", log.length - MAX_LOG_CHARS) + 1) : log;

export function createBenchController({
  apiKey,
  launch,
}: {
  readonly apiKey: string;
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
  const status = (): BridgeStatus => ({ configured: apiKey !== "", job });

  return {
    status,
    start(request: BenchRequest): BridgeStatus {
      if (runner) throw new RequestError(409, "A benchmark is already running or stopping.");
      if (apiKey === "")
        throw new RequestError(
          400,
          "OPENROUTER_API_KEY is not set. Start the page with bun run dev, which decrypts secrets/infra/probabench.env.",
        );
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

      // Whole lines only: escape sequences and the key never span a newline, so stripping
      // and redaction need no state across chunks. The runner never prints the key;
      // redaction is defence in depth. @effect/cli renders ANSI regardless of NO_COLOR, so
      // escapes are stripped here.
      const appendLine = (raw: string) => {
        const line = stripVTControlCharacters(raw).replaceAll(apiKey, "[redacted]");
        update((current) => ({
          log: keepTail(`${current.log}${line}\n`),
          progress: parsePointProgress(line) ?? current.progress,
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
        // runMain exits 0 when SIGTERM interrupts it, so a requested stop outranks the exit code.
        update((current) =>
          stopping
            ? { status: "cancelled" }
            : code === 0
              ? { status: "completed" }
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
