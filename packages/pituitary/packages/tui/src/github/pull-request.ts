import { runGh } from "./gh.ts";

export type PullState = "open" | "draft" | "merged" | "closed";

/** The GitHub pull request opened from the checked-out branch. */
export interface PullRequest {
  number: number;
  url: string;
  state: PullState;
}

/** What one question to the GitHub CLI found. */
export type Lookup =
  | { kind: "found"; pull: PullRequest }
  | { kind: "none" }
  /** gh ran and could not say: signed out, offline, or a repository GitHub does not hold. */
  | { kind: "failed"; reason: string }
  /** No gh to ask. */
  | { kind: "missing"; reason: string };

/** Milliseconds a lookup may take before it counts as failed. */
export const LOOKUP_TIMEOUT_MS = 10_000;

/** Milliseconds between lookups nothing prompted, for a pull request opened elsewhere. */
export const POLL_MS = 5 * 60_000;

/** The pull request in `gh pr view --json number,url,state,isDraft` output, or null. */
export function parsePullRequest(stdout: string): PullRequest | null {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { number, url, state, isDraft } = data as Record<string, unknown>;
  if (typeof number !== "number" || !Number.isInteger(number) || number <= 0) return null;
  if (typeof url !== "string" || typeof state !== "string") return null;
  const upper = state.toUpperCase();
  const known: PullState | null =
    upper === "MERGED"
      ? "merged"
      : upper === "CLOSED"
        ? "closed"
        : upper === "OPEN"
          ? isDraft === true
            ? "draft"
            : "open"
          : null;
  return known ? { number, url, state: known } : null;
}

/** gh's answer when the branch has no pull request, as opposed to gh failing to answer. */
const NO_PULL = /no (open )?pull requests? found/i;

/**
 * Asks the GitHub CLI at `gh` for the pull request of the branch checked out in `cwd`.
 * Read-only, under the operator's own gh login; its stderr goes to the returned reason.
 */
export async function lookupPullRequest(
  gh: string,
  cwd: string,
  timeoutMs = LOOKUP_TIMEOUT_MS,
): Promise<Lookup> {
  const ran = await runGh(gh, ["pr", "view", "--json", "number,url,state,isDraft"], { cwd, timeoutMs });
  if (ran.kind === "missing") return { kind: "missing", reason: ran.reason };
  if (ran.kind === "late") return { kind: "failed", reason: ran.reason };
  const { code, stdout, stderr } = ran;
  if (code === 0) {
    const pull = parsePullRequest(stdout);
    return pull
      ? { kind: "found", pull }
      : { kind: "failed", reason: "gh answered with no pull request it could name" };
  }
  if (NO_PULL.test(stderr)) return { kind: "none" };
  return { kind: "failed", reason: stderr.trim().split("\n")[0] || `gh exited with ${code}` };
}

export interface WatchOptions {
  lookup(): Promise<Lookup>;
  /** Told the branch's pull request each time a lookup lands, null when there is none. */
  onChange(pull: PullRequest | null): void;
  /** One line per new reason gh gave for not answering. */
  log(line: string): void;
  pollMs?: number;
}

/**
 * Keeps the branch's pull request current: one lookup at a time, a request during one
 * answered by one more after it, and nothing further once gh turns out to be absent.
 */
export class PullRequestWatch {
  private running = false;
  private again = false;
  private stopped = false;
  private generation = 0;
  private lastReason: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startup: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: WatchOptions) {}

  /** Looks the pull request up once the current turn of the event loop is done, then on a slow timer. */
  start(): void {
    this.startup = setTimeout(() => this.refresh(), 0);
    this.timer = setInterval(() => this.refresh(), this.options.pollMs ?? POLL_MS);
  }

  /**
   * Looks the pull request up again. `reset` marks what is known as belonging to another
   * branch: it is cleared at once, and a lookup already running is answered by a fresh one.
   */
  refresh({ reset = false }: { reset?: boolean } = {}): void {
    if (this.stopped) return;
    if (reset) {
      this.generation++;
      this.options.onChange(null);
    }
    if (this.running) {
      this.again = true;
      return;
    }
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.startup);
    clearInterval(this.timer);
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      do {
        this.again = false;
        const generation = this.generation;
        const found = await this.options.lookup();
        if (this.stopped) return;
        if (generation !== this.generation) {
          this.again = true;
          continue;
        }
        this.settle(found);
      } while (this.again && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private settle(found: Lookup): void {
    switch (found.kind) {
      case "found":
        this.lastReason = null;
        this.options.onChange(found.pull);
        return;
      case "none":
        this.lastReason = null;
        this.options.onChange(null);
        return;
      case "failed":
        this.options.onChange(null);
        if (found.reason !== this.lastReason) this.options.log(`pull request lookup failed: ${found.reason}`);
        this.lastReason = found.reason;
        return;
      case "missing":
        this.options.onChange(null);
        this.options.log(`pull request lookup off, no GitHub CLI: ${found.reason}`);
        this.stop();
        return;
    }
  }
}
