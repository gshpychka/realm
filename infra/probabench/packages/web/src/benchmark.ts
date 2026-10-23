import {
  isModelToken,
  parsePointProgress,
  type ReasoningMode,
  type SamplingPreset,
} from "@probabench/domain";

export interface BenchmarkOptions {
  readonly model: string;
  readonly trialsPerStep: number;
  readonly stepPercent: number;
  readonly concurrency: number;
  readonly reasoning?: ReasoningMode;
}

export interface BenchmarkDraft extends BenchmarkOptions {
  readonly key: string;
}

export const MAX_MODEL_LENGTH = 200;
export const MAX_BROWSER_SAMPLES = 100_000;

/** Match the local bridge's limits before offering a run or copied command. */
export const validateBenchmarkOptions = (options: BenchmarkOptions): string | null => {
  const model = options.model.trim();
  if (model.length > MAX_MODEL_LENGTH || !isModelToken(model)) {
    return "Choose one model alias or OpenRouter vendor/model ID.";
  }
  const { trialsPerStep, stepPercent, concurrency } = options;
  if (!Number.isSafeInteger(trialsPerStep) || trialsPerStep < 1 || trialsPerStep > 10_000) {
    return "Samples per target must be an integer from 1 to 10,000.";
  }
  if (!Number.isSafeInteger(stepPercent) || stepPercent < 1 || stepPercent > 100) {
    return "Target step must be an integer from 1 to 100 percent.";
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 50) {
    return "Concurrent requests must be an integer from 1 to 50.";
  }
  return null;
};

export const PRESET_DESCRIPTIONS: Readonly<Record<SamplingPreset["id"], string>> = {
  quick: "Find the shape",
  standard: "A closer look",
  thorough: "More evidence",
};

/** Quote every user-controlled argument, including apostrophes, for POSIX shells. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const benchmarkCommand = (options: BenchmarkOptions): string =>
  `bun run bench --model ${shellQuote(options.model.trim())} --trials ${options.trialsPerStep} --step ${options.stepPercent} --concurrency ${options.concurrency}${options.reasoning ? ` --reasoning ${shellQuote(options.reasoning)}` : ""}`;

export interface Job {
  readonly id: string;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly startedAt: string;
  readonly log: string;
  readonly error?: string;
}

/** The latest finished probability point the runner reported in its log. */
export const jobPointProgress = (log: string) =>
  log
    .split("\n")
    .map(parsePointProgress)
    .findLast((progress) => progress !== null) ?? null;

export interface LocalStatus {
  readonly local: true;
  readonly configured: boolean;
  readonly job: Job | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const parseJob = (value: unknown): Job | null => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.log !== "string"
  )
    return null;
  if (
    value.status !== "running" &&
    value.status !== "completed" &&
    value.status !== "failed" &&
    value.status !== "cancelled"
  )
    return null;
  return {
    id: value.id,
    startedAt: value.startedAt,
    log: value.log,
    status: value.status,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
};

export const fetchLocalStatus = async (): Promise<LocalStatus | null> => {
  try {
    const response = await fetch("/api/bench/status", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
      return null;
    const value: unknown = await response.json();
    if (!isRecord(value) || value.local !== true || typeof value.configured !== "boolean")
      return null;
    const job = parseJob(value.job);
    if (value.job !== null && job === null) return null;
    return { local: true, configured: value.configured, job };
  } catch {
    return null;
  }
};

export const postJob = async (path: "run" | "cancel", options?: BenchmarkOptions): Promise<Job> => {
  const response = await fetch(`/api/bench/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options ?? {}),
    signal: AbortSignal.timeout(10000),
  });
  const value: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      isRecord(value) && typeof value.error === "string"
        ? value.error
        : "The local runner could not accept this request.",
    );
  const job = parseJob(value);
  if (!job)
    throw new Error(
      "The local runner returned an unexpected response. Refresh its status and try again.",
    );
  return job;
};
