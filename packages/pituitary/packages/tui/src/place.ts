import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The branch checked out in the repository holding `cwd`, read from `.git` so no
 * process runs on each redraw. A detached head shows as its short commit.
 */
export function branchOf(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    const git = join(dir, ".git");
    if (existsSync(git)) return headOf(git);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function headOf(git: string): string | null {
  try {
    // A worktree or submodule holds a `.git` file pointing at its real git directory.
    const dir = statSync(git).isFile()
      ? resolve(
          dirname(git),
          readFileSync(git, "utf8")
            .replace(/^gitdir:\s*/, "")
            .trim(),
        )
      : git;
    const head = readFileSync(join(dir, "HEAD"), "utf8").trim();
    const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
    return ref?.[1] ?? head.slice(0, 7);
  } catch {
    return null;
  }
}

/** `path` with the home directory written as `~`. */
export function tilde(path: string, home = homedir()): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
