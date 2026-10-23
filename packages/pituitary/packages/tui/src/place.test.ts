import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { branchOf, tilde } from "./place.ts";

const directories: string[] = [];
function temporary(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  directories.push(root);
  return root;
}
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function repo(head: string): string {
  const root = temporary("place-");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), `${head}\n`);
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  return root;
}

describe("branchOf", () => {
  test("reads the branch from a directory anywhere inside the repository", () => {
    const root = repo("ref: refs/heads/feat/limits");
    expect(branchOf(join(root, "src", "deep"))).toBe("feat/limits");
  });

  test("shows a detached head as its short commit", () => {
    expect(branchOf(repo("0123456789abcdef"))).toBe("0123456");
  });

  test("follows a worktree's .git file to its git directory", () => {
    const main = repo("ref: refs/heads/main");
    const worktreeGit = join(main, ".git", "worktrees", "wt");
    mkdirSync(worktreeGit, { recursive: true });
    writeFileSync(join(worktreeGit, "HEAD"), "ref: refs/heads/side\n");
    const worktree = temporary("wt-");
    writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGit}\n`);
    expect(branchOf(worktree)).toBe("side");
  });

  test("is null outside a repository", () => {
    // TMPDIR may itself be inside the checkout; the filesystem root is outside it.
    expect(branchOf(parse(tmpdir()).root)).toBeNull();
  });
});

describe("tilde", () => {
  test("writes the home directory as ~", () => {
    expect(tilde("/home/me/src", "/home/me")).toBe("~/src");
    expect(tilde("/home/me", "/home/me")).toBe("~");
    expect(tilde("/home/meadow", "/home/me")).toBe("/home/meadow");
  });
});
