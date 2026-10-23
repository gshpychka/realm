import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Lookup,
  lookupPullRequest,
  type PullRequest,
  PullRequestWatch,
  parsePullRequest,
} from "./pull-request.ts";

const url = "https://github.com/o/r/pull/42";

describe("parsePullRequest", () => {
  test("reads each state gh reports, with a draft as its own state", () => {
    expect(parsePullRequest(JSON.stringify({ number: 42, url, state: "OPEN", isDraft: false }))).toEqual({
      number: 42,
      url,
      state: "open",
    });
    expect(parsePullRequest(JSON.stringify({ number: 42, url, state: "OPEN", isDraft: true }))?.state).toBe(
      "draft",
    );
    expect(
      parsePullRequest(JSON.stringify({ number: 42, url, state: "MERGED", isDraft: false }))?.state,
    ).toBe("merged");
    expect(
      parsePullRequest(JSON.stringify({ number: 42, url, state: "CLOSED", isDraft: false }))?.state,
    ).toBe("closed");
  });

  test("refuses output that names no pull request", () => {
    for (const stdout of [
      "",
      "not json",
      "[]",
      JSON.stringify({ number: "42", url, state: "OPEN" }),
      JSON.stringify({ number: 0, url, state: "OPEN" }),
      JSON.stringify({ number: 4.5, url, state: "OPEN" }),
      JSON.stringify({ number: 42, state: "OPEN" }),
      JSON.stringify({ number: 42, url, state: "LOCKED" }),
    ]) {
      expect(parsePullRequest(stdout)).toBeNull();
    }
  });
});

describe("lookupPullRequest", () => {
  const fake = (script: string) => {
    const dir = mkdtempSync(join(tmpdir(), "pituitary-gh-"));
    const path = join(dir, "gh");
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  test("a pull request gh names is found", async () => {
    const gh = fake(`echo '{"number":7,"url":"${url}","state":"OPEN","isDraft":false}'`);
    expect(await lookupPullRequest(gh, tmpdir())).toEqual({
      kind: "found",
      pull: { number: 7, url, state: "open" },
    });
  });

  test("gh saying the branch has none is none, and any other refusal a failure with its reason", async () => {
    const none = fake(`echo 'no pull requests found for branch "x"' >&2; exit 1`);
    expect(await lookupPullRequest(none, tmpdir())).toEqual({ kind: "none" });
    const signedOut = fake(`echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4`);
    expect(await lookupPullRequest(signedOut, tmpdir())).toEqual({
      kind: "failed",
      reason: "To get started with GitHub CLI, please run:  gh auth login",
    });
  });

  test("a gh that hangs is stopped and counted as failed", async () => {
    const slow = fake("sleep 5");
    const found = await lookupPullRequest(slow, tmpdir(), 100);
    expect(found.kind).toBe("failed");
  });

  test("no gh at all is missing", async () => {
    const found = await lookupPullRequest(join(tmpdir(), "no-such-gh-here"), tmpdir());
    expect(found.kind).toBe("missing");
  });
});

/** A lookup the test answers by hand, counting how many run at once. */
function controlled() {
  const pending: ((found: Lookup) => void)[] = [];
  let active = 0;
  let most = 0;
  return {
    lookup: () =>
      new Promise<Lookup>((resolve) => {
        active++;
        most = Math.max(most, active);
        pending.push((found) => {
          active--;
          resolve(found);
        });
      }),
    answer(found: Lookup) {
      pending.shift()?.(found);
    },
    get calls() {
      return pending.length;
    },
    get most() {
      return most;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const pull = (number: number): PullRequest => ({ number, url, state: "open" });

describe("PullRequestWatch", () => {
  test("refreshes during a lookup coalesce into one more after it, never two at once", async () => {
    const gh = controlled();
    const seen: (PullRequest | null)[] = [];
    const watch = new PullRequestWatch({ lookup: gh.lookup, onChange: (p) => seen.push(p), log: () => {} });
    watch.refresh();
    watch.refresh();
    watch.refresh();
    expect(gh.calls).toBe(1);
    gh.answer({ kind: "found", pull: pull(1) });
    await flush();
    expect(gh.calls).toBe(1);
    gh.answer({ kind: "found", pull: pull(2) });
    await flush();
    expect(gh.calls).toBe(0);
    expect(gh.most).toBe(1);
    expect(seen).toEqual([pull(1), pull(2)]);
    watch.stop();
  });

  test("a branch change clears the pull request at once and drops the answer about the old branch", async () => {
    const gh = controlled();
    const seen: (PullRequest | null)[] = [];
    const watch = new PullRequestWatch({ lookup: gh.lookup, onChange: (p) => seen.push(p), log: () => {} });
    watch.refresh();
    watch.refresh({ reset: true });
    expect(seen).toEqual([null]);
    gh.answer({ kind: "found", pull: pull(1) });
    await flush();
    expect(seen).toEqual([null]);
    expect(gh.calls).toBe(1);
    gh.answer({ kind: "found", pull: pull(2) });
    await flush();
    expect(seen).toEqual([null, pull(2)]);
    watch.stop();
  });

  test("a failure logs its reason once, and a missing gh stops every later lookup", async () => {
    const gh = controlled();
    const lines: string[] = [];
    const watch = new PullRequestWatch({
      lookup: gh.lookup,
      onChange: () => {},
      log: (line) => lines.push(line),
    });
    for (let round = 0; round < 3; round++) {
      watch.refresh();
      gh.answer({ kind: "failed", reason: "offline" });
      await flush();
    }
    expect(lines).toEqual(["pull request lookup failed: offline"]);
    watch.refresh();
    gh.answer({ kind: "missing", reason: "ENOENT" });
    await flush();
    watch.refresh();
    expect(gh.calls).toBe(0);
    expect(lines).toHaveLength(2);
  });

  test("start looks up once after the current turn, then on the timer", async () => {
    const gh = controlled();
    const watch = new PullRequestWatch({ lookup: gh.lookup, onChange: () => {}, log: () => {}, pollMs: 20 });
    watch.start();
    expect(gh.calls).toBe(0);
    await flush();
    expect(gh.calls).toBe(1);
    gh.answer({ kind: "none" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(gh.calls).toBe(1);
    watch.stop();
  });
});
