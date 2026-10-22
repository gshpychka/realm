export interface BenchmarkOptions {
  readonly model: string;
  readonly trials: number;
  readonly step: number;
  readonly concurrency: number;
  readonly reasoning?: string;
}

export interface BenchmarkDraft extends BenchmarkOptions {
  readonly key: string;
}

export const MAX_MODEL_LENGTH = 200;
export const MAX_BROWSER_SAMPLES = 100_000;

/** Match the local bridge's limits before offering a run or copied command. */
export const validateBenchmarkOptions = (options: BenchmarkOptions): string | null => {
  const model = options.model.trim();
  if (model === "all" || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,199}$/.test(model)) {
    return `Choose one OpenRouter model slug or alias, up to ${MAX_MODEL_LENGTH} characters.`;
  }
  if (!Number.isSafeInteger(options.trials) || options.trials < 1 || options.trials > 10_000) {
    return "Samples per target must be an integer from 1 to 10,000.";
  }
  if (!Number.isSafeInteger(options.step) || options.step < 1 || options.step > 100) {
    return "Target step must be an integer from 1 to 100 percent.";
  }
  if (
    !Number.isSafeInteger(options.concurrency) ||
    options.concurrency < 1 ||
    options.concurrency > 50
  ) {
    return "Concurrent requests must be an integer from 1 to 50.";
  }
  if (
    options.reasoning !== undefined &&
    !["off", "low", "medium", "high", "xhigh"].includes(options.reasoning)
  ) {
    return "Choose a supported reasoning mode.";
  }
  return null;
};

export const PRESETS = [
  { id: "quick", label: "Quick check", description: "Find the shape", trials: 10, step: 25 },
  { id: "standard", label: "Standard", description: "A closer look", trials: 50, step: 10 },
  { id: "thorough", label: "Thorough", description: "More evidence", trials: 100, step: 5 },
] as const;

// These are existing benchmark starter slugs, not a ranking of model quality.
export const STARTER_MODELS = [
  "anthropic/claude-haiku-4.5",
  "gpt-5-mini-low",
  "google/gemini-2.5-flash",
] as const;

/** Includes both endpoints, including the final 100% target for non-divisor steps. */
export const sampleBudget = (
  trials: number,
  step: number,
): { targets: number; samples: number; attempts: number } => {
  if (
    !Number.isSafeInteger(trials) ||
    trials < 1 ||
    !Number.isSafeInteger(step) ||
    step < 1 ||
    step > 100
  ) {
    return { targets: 0, samples: 0, attempts: 0 };
  }
  const targets = Math.ceil(100 / step) + 1;
  const samples = targets * trials;
  if (!Number.isSafeInteger(samples * 6)) return { targets: 0, samples: 0, attempts: 0 };
  // The runner allows five retries after the first attempt (MAX_RETRIES = 5).
  return { targets, samples, attempts: samples * 6 };
};

/** Quote every user-controlled argument, including apostrophes, for POSIX shells. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const benchmarkCommand = (options: BenchmarkOptions): string =>
  `bun run bench --model ${shellQuote(options.model.trim())} --trials ${options.trials} --step ${options.step} --concurrency ${options.concurrency}${options.reasoning ? ` --reasoning ${shellQuote(options.reasoning)}` : ""}`;

export interface Job {
  readonly id: string;
  readonly status: "running" | "completed" | "failed" | "cancelled";
  readonly startedAt: string;
  readonly log: string;
  readonly error?: string;
}

/** Read the latest completed probability point from the CLI's human progress output. */
export const jobPointProgress = (log: string): { completed: number; total: number } | null => {
  let progress: { completed: number; total: number } | null = null;
  for (const match of log.matchAll(/\] point (\d+)\/(\d+) x=/g)) {
    const completed = Number(match[1]);
    const total = Number(match[2]);
    if (
      Number.isSafeInteger(completed) &&
      Number.isSafeInteger(total) &&
      total > 0 &&
      completed > 0 &&
      completed <= total
    ) {
      progress = { completed, total };
    }
  }
  return progress;
};

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
