import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boot, type Harness, REPO } from "./harness.ts";

/** The pinned Pi CLI, which regular Pituitary runs over RPC in these tests. */
export const PI = join(REPO, "packages/tui/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");

export interface PiOptions {
  /** Pi's `auth.json`: the credentials its providers sign in with. */
  auth: Record<string, unknown>;
  /** Pi's `models.json`, which points providers at a local fake endpoint. */
  models: Record<string, unknown>;
  /** Arguments for Pituitary, which pass through to Pi, such as `--model`. */
  argv?: string[];
  /** Text on the first frame, which marks the UI as up. */
  ready: string;
  cols?: number;
  rows?: number;
}

export interface PiHarness extends Harness {
  /** The throwaway HOME, which holds Pi's agent directory and the working directory. */
  home: string;
}

/**
 * Runs regular Pituitary on `main.tsx` with the pinned Pi CLI, in a throwaway HOME whose Pi
 * agent directory holds only `auth` and `models`. Pi's own extensions and skills stay out;
 * `argv` may load a fixture extension with `--extension`.
 */
export async function bootPi(options: PiOptions): Promise<PiHarness> {
  const home = realpathSync(mkdtempSync("/tmp/pituitary-pi-"));
  const agent = join(home, ".pi", "agent");
  const cwd = join(home, "sample");
  mkdirSync(agent, { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(agent, "auth.json"), JSON.stringify(options.auth));
  writeFileSync(join(agent, "models.json"), JSON.stringify(options.models));
  try {
    const app = await boot({
      entry: join(REPO, "packages/tui/src/main.tsx"),
      argv: options.argv ?? [],
      cwd,
      cols: options.cols,
      rows: options.rows,
      ready: options.ready,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        PI_AGENT_CMD: "node",
        PI_AGENT_ARGS: `${PI} --no-extensions --no-skills`,
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        PITUITARY_STILL: "1",
        PITUITARY_GH: "",
        PITUITARY_LOG: join(home, "tui.log"),
      },
    });
    return {
      ...app,
      home,
      close: async () => {
        try {
          await app.close();
        } finally {
          rmSync(home, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}
