import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { type Launched, type LaunchOptions, launch, REPO, uiPid } from "./helpers/harness.ts";
import { record, summarise } from "./helpers/perf.ts";

// Budgets sit well above what a quiet machine measures, so they catch a regression
// without failing on a busy one. Startup figures count from the UI process starting.
const FRAME_P50_MS = 300;
const EDITOR_P50_MS = 400;
const REAL_AGENT_P50_MS = 1500;
const EXIT_P50_MS = 200;
/** Past this, closing pi fell back to killing it. */
const EXIT_MAX_MS = 1500;
const SAMPLES = 5;

const PROBE = join(REPO, "e2e/fixtures/probe.ts");
const REAL: LaunchOptions = { pi: ["--no-session", "--no-extensions", "-e", PROBE] };

after(async () => {
  await closeAll();
});

/** Launches `SAMPLES` times, waiting each time until the editor answers a key. */
async function startups(options: LaunchOptions, until: string): Promise<Launched[]> {
  const runs: Launched[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    const app = await launch({ ...options, settle: false });
    await app.terminal.write("x");
    await app.terminal.waitText("» x");
    const deadline = Date.now() + 10_000;
    while (!(until in app.profile()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    runs.push(app);
    await app.close();
  }
  return runs;
}

const at = (runs: Launched[], name: string) =>
  summarise(runs.map((run) => run.profile()[name]?.at ?? Number.POSITIVE_INFINITY));

test("the scripted session is drawn and takes keys promptly", async () => {
  const runs = await startups({}, "session-loaded");
  const frame = at(runs, "first-frame");
  const editor = at(runs, "editor-ready");
  record(
    "startup-scripted",
    { "first frame": frame, "editor ready": editor },
    `p50 < ${FRAME_P50_MS} · ${EDITOR_P50_MS}ms`,
  );
  assert.ok(frame.p50 < FRAME_P50_MS, JSON.stringify(frame));
  assert.ok(editor.p50 < EDITOR_P50_MS, JSON.stringify(editor));
});

test("real pi's session is drawn and takes keys promptly", async () => {
  const runs = await startups(REAL, "session-loaded");
  const frame = at(runs, "first-frame");
  const editor = at(runs, "editor-ready");
  const agent = at(runs, "session-loaded");
  record(
    "startup-real-pi",
    { "first frame": frame, "editor ready": editor, "session loaded": agent },
    `p50 < ${FRAME_P50_MS} · ${EDITOR_P50_MS} · ${REAL_AGENT_P50_MS}ms`,
  );
  assert.ok(frame.p50 < FRAME_P50_MS, JSON.stringify(frame));
  assert.ok(editor.p50 < EDITOR_P50_MS, JSON.stringify(editor));
  assert.ok(agent.p50 < REAL_AGENT_P50_MS, JSON.stringify(agent));
});

/** Each way out, given the UI and its process id. */
const EXITS: Record<string, (app: Launched, ui: number) => Promise<void>> = {
  "ctrl+d": (app) => app.terminal.write("\x04"),
  "ctrl+c twice": async (app) => {
    await app.terminal.write("\x03");
    await app.terminal.write("\x03");
  },
  SIGTERM: async (_app, ui) => {
    process.kill(ui, "SIGTERM");
  },
};

for (const [name, leave] of Object.entries(EXITS)) {
  test(`${name} exits promptly with real pi`, async () => {
    const samples: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample++) {
      const app = await launch({ ...REAL, settle: false });
      await app.terminal.waitText("» ");
      while (!("session-loaded" in app.profile())) await new Promise((resolve) => setTimeout(resolve, 20));
      // Finding the process takes a moment of its own, which the measure leaves out.
      const ui = uiPid(app.home);
      // Measured from the moment the key or signal leaves, to the UI's last mark.
      const sent = performance.timeOrigin + performance.now();
      await leave(app, ui);
      await app.terminal.waitExit({ timeout: 10_000 });
      const exit = app.profile().exit;
      assert.ok(exit, "the UI left no exit mark");
      samples.push(exit.epoch - sent);
      await app.close();
    }
    const exit = summarise(samples);
    record(`exit-${name.replace(/\W+/g, "-")}`, { exit }, `p50 < ${EXIT_P50_MS} · max < ${EXIT_MAX_MS}ms`);
    assert.ok(exit.p50 < EXIT_P50_MS, JSON.stringify(exit));
    assert.ok(exit.max < EXIT_MAX_MS, JSON.stringify(exit));
  });
}
