import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

/**
 * What the tests read of running processes. Linux keeps it in /proc; elsewhere, as on macOS,
 * ps reports it.
 */
const PROC = process.platform === "linux";

/** `ps` with `args`, one process per line. */
function ps(...args: string[]): string[] {
  const out = execFileSync("ps", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\n").filter((line) => line.trim() !== "");
}

/** A `pid command` line from ps, split in two. */
function pidAndRest(line: string): [number, string] {
  const [, pid = "", rest = ""] = /^\s*(\d+) ?(.*)$/.exec(line) ?? [];
  return [Number(pid), rest];
}

/**
 * The processes still running with `home` as their HOME, as `pid command` lines: the UI
 * and everything it started inherit the throwaway HOME, so a survivor is an orphan.
 *
 * macOS shows no environment for a process that retitles itself, as pi does, so there a
 * process working inside `home` counts too: everything a run starts works in its project.
 */
export function survivors(home: string): string[] {
  const entry = `HOME=${home}`;
  if (PROC) {
    const found: string[] = [];
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const env = `\0${readFileSync(`/proc/${pid}/environ`, "utf8")}`;
        if (!env.includes(`\0${entry}\0`)) continue;
        found.push(`${pid} ${readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim()}`);
      } catch {
        // A process that ended between the listing and the read is gone.
      }
    }
    return found;
  }
  const commands = new Map(ps("-axww", "-o", "pid=,command=").map(pidAndRest));
  const pids = new Set(workingIn(home));
  for (const line of ps("-axwwE", "-o", "pid=,command=")) {
    const [pid, both] = pidAndRest(line);
    const command = commands.get(pid);
    // ps -E writes the environment after the command, so the command alone says where it starts.
    if (
      command !== undefined &&
      both.startsWith(command) &&
      ` ${both.slice(command.length)} `.includes(` ${entry} `)
    ) {
      pids.add(pid);
    }
  }
  // A retitled process pads what is left of its old title with blanks.
  return [...pids].flatMap((pid) => {
    const command = commands.get(pid);
    return command === undefined ? [] : [`${pid} ${command.trim()}`];
  });
}

/** The processes whose working directory lies inside `dir`, from lsof. */
function workingIn(dir: string): number[] {
  // lsof exits non-zero when it cannot read some process, and still lists the rest.
  const { stdout } = spawnSync("lsof", ["-a", "-d", "cwd", "-Fpn"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const found: number[] = [];
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && (line.slice(1) === dir || line.startsWith(`n${dir}/`))) found.push(pid);
  }
  return found;
}

/** Whether `pid` has a controlling terminal. */
export function hasTerminal(pid: number): boolean {
  if (PROC) {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // tty_nr is the fifth field after the parenthesised command name, 0 for none.
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[4]) !== 0;
  }
  // ps names no terminal with question marks.
  const [tty = ""] = ps("-o", "tty=", "-p", String(pid));
  return !/^\s*\?*\s*$/.test(tty);
}

/** Linux counts process CPU in ticks of 1/100 s. */
const CLOCK_TICKS = 100;

/** Milliseconds of CPU `pid` has used, user and system together. */
export function cpuMs(pid: number): number {
  if (PROC) {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the parenthesised command name; utime and stime are the 14th and 15th.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return ((Number(fields[11]) + Number(fields[12])) * 1000) / CLOCK_TICKS;
  }
  // ps writes CPU time as [dd-][hh:]mm:ss.cc.
  const [clock = "0"] = ps("-o", "cputime=", "-p", String(pid));
  const [days, time] = clock.trim().includes("-") ? clock.trim().split("-") : ["0", clock.trim()];
  const seconds = (time ?? "0").split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return (Number(days) * 86_400 + seconds) * 1000;
}
