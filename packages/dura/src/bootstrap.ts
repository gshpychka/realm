import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Runtime } from "./client.ts";
import { privateDirectory } from "./paths.ts";

/** Only the Dura CLI may start a local host; frontend connections never do. */
export async function ensureLocalRuntime(
  runtime: Runtime,
  options: { stateDirectory: string; socketPath?: string; catalogFile?: string },
): Promise<void> {
  try {
    await runtime.ready();
    return;
  } catch (error) {
    if (
      options.socketPath ||
      process.env.DURA_RUNTIME_SOCKET ||
      process.env.DURA_AUTO_START === "0" ||
      !["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      throw error;
  }
  privateDirectory(options.stateDirectory);
  const logPath = join(options.stateDirectory, "runtime.log");
  const log = openSync(logPath, "a", 0o600);
  let failure: Error | undefined;
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./supervisor.ts", import.meta.url)), "--state", options.stateDirectory],
      {
        detached: true,
        stdio: ["ignore", log, log],
        env: {
          ...process.env,
          ...(options.catalogFile ? { DURA_CATALOG: options.catalogFile } : {}),
        },
      },
    );
    child.on("error", (error) => {
      failure = error;
    });
    child.unref();
  } finally {
    closeSync(log);
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    try {
      await runtime.ready();
      return;
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Dura did not become ready; see ${logPath}`);
}
