/** The GitHub CLI pituitary runs under the operator's own gh login; null when `PITUITARY_GH` is set empty. */
export function ghCommand(): string | null {
  const gh = process.env.PITUITARY_GH ?? "gh";
  return gh === "" ? null : gh;
}

/** What one run of gh came to. */
export type GhRun =
  | { kind: "exited"; code: number; stdout: string; stderr: string }
  /** gh ran past its time and was stopped. */
  | { kind: "late"; reason: string }
  /** There is no gh at that path to run. */
  | { kind: "missing"; reason: string };

export interface GhOptions {
  /** Milliseconds gh may run before it is stopped. */
  timeoutMs: number;
  cwd?: string;
}

/** Runs the GitHub CLI at `gh` with `args`, non-interactively, to completion or its timeout. */
export async function runGh(gh: string, args: string[], { timeoutMs, cwd }: GhOptions): Promise<GhRun> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([gh, ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // Keeps gh from prompting, paging, colouring, or checking for its own updates.
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
        GH_SPINNER_DISABLED: "1",
        GH_PAGER: "cat",
        NO_COLOR: "1",
      },
    });
  } catch (cause) {
    return { kind: "missing", reason: cause instanceof Error ? cause.message : String(cause) };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A child gh started can hold its pipes open past gh itself, so the answer races the clock.
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, timeoutMs);
  });
  try {
    const answer = await Promise.race([
      Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
        proc.exited,
      ]),
      late,
    ]);
    if (!answer) return { kind: "late", reason: `gh took longer than ${timeoutMs} ms` };
    const [stdout, stderr, code] = answer;
    return { kind: "exited", code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}
