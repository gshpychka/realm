import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeAll, type TuiTest } from "@microsoft/tui-test";
import { boot, launch, normalMode, REPO, uiPid, waitMatch } from "./helpers/harness.ts";
import { echoes, record, summarise, timeTo } from "./helpers/perf.ts";
import { cpuMs } from "./helpers/processes.ts";

// Budgets sit well above what a quiet machine measures, so they catch a regression
// without failing on a busy one. The figures themselves land in artifacts/perf.
const FLOOR_P95_MS = 10;
const ECHO_P95_MS = 30;
const FRAME_P95_MS = 20;
const STREAMING_P95_MS = 25;
const RESUME_MS = 3000;

after(async () => {
  await closeAll();
});

test("the harness itself adds under a few milliseconds", async () => {
  const app = await boot({ entry: `${REPO}/e2e/fixtures/echo.ts`, ready: "ready" });
  const echo = summarise(await echoes(app.terminal, 40));
  record("echo-harness-floor", { echo }, `p95 < ${FLOOR_P95_MS}ms`);
  assert.ok(echo.p95 < FLOOR_P95_MS, JSON.stringify(echo));
  await app.close();
});

test("a typed character reaches the screen promptly", async () => {
  const app = await launch({ scenario: "hello" });
  const echo = summarise(await echoes(app.terminal, 40));
  record("echo-idle", { echo }, `p95 < ${ECHO_P95_MS}ms`);
  assert.ok(echo.p95 < ECHO_P95_MS, JSON.stringify(echo));
  await app.close();
});

test("keys sent faster than a frame each land within one", async () => {
  const app = await launch({ scenario: "hello" });
  const echo = summarise(await echoes(app.terminal, 40, 0));
  record("echo-back-to-back", { echo }, `p95 < ${FRAME_P95_MS}ms`);
  assert.ok(echo.p95 < FRAME_P95_MS, JSON.stringify(echo));
  await app.close();
});

test("typing stays prompt with a long session behind it", async () => {
  const app = await launch({ scenario: "sprawl" });
  await app.terminal.waitText("step 300:");
  const echo = summarise(await echoes(app.terminal, 40));
  record("echo-long-session", { echo }, `p95 < ${ECHO_P95_MS}ms`);
  assert.ok(echo.p95 < ECHO_P95_MS, JSON.stringify(echo));
  await app.close();
});

test("typing stays prompt while a reply streams in", async () => {
  const app = await launch({ scenario: "long", delayMs: 30 });
  await app.terminal.submit("stream");
  await app.terminal.waitText("line 1 of the long answer");
  const echo = summarise(await echoes(app.terminal, 30));
  record("echo-streaming", { echo }, `p95 < ${STREAMING_P95_MS}ms`);
  assert.ok(echo.p95 < STREAMING_P95_MS, JSON.stringify(echo));
  await app.close();
});

test("a long session opens promptly", async () => {
  const start = performance.now();
  const app = await launch({ scenario: "sprawl" });
  await app.terminal.waitText("step 300:");
  const ms = performance.now() - start;
  record("resume-long-session", { ms: Math.round(ms) }, `< ${RESUME_MS}ms`);
  assert.ok(ms < RESUME_MS, `${Math.round(ms)}ms`);
  await app.close();
});

/** Milliseconds from `act` until the terminal cursor leaves `from`. */
async function cursorMoves(
  terminal: TuiTest,
  from: { x: number; y: number },
  act: () => Promise<void>,
): Promise<number> {
  const start = performance.now();
  await act();
  for (;;) {
    const at = await terminal.getCursor();
    if (at.x !== from.x || at.y !== from.y) return performance.now() - start;
    if (performance.now() - start > 5000) throw new Error("the cursor never moved");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 80));

test("a normal-mode motion moves the cursor promptly", async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type(Array.from({ length: 12 }, (_, index) => `w${index}`).join(" "));
  await app.terminal.waitText("w11");
  await normalMode(app.terminal);
  await app.terminal.write("0");
  await pause();
  const samples: number[] = [];
  for (let index = 0; index < 10; index++) {
    await pause();
    const from = await app.terminal.getCursor();
    samples.push(await cursorMoves(app.terminal, from, () => app.terminal.write("w")));
  }
  const motion = summarise(samples);
  record("nvim-motion", { motion }, `p95 < ${ECHO_P95_MS}ms`);
  assert.ok(motion.p95 < ECHO_P95_MS, JSON.stringify(motion));
  await app.close();
});

test('ci" reaches the screen promptly', async () => {
  const app = await launch({ scenario: "hello" });
  await app.terminal.type('say "word" now');
  await app.terminal.waitText('» say "word" now');
  await normalMode(app.terminal);
  await app.terminal.write("0w");
  await pause();
  const samples: number[] = [];
  for (let index = 0; index < 15; index++) {
    await pause();
    samples.push(
      await timeTo(
        app.terminal,
        () => app.terminal.write('ci"X'),
        (screen) => screen.includes('say "X" now'),
      ),
    );
    await normalMode(app.terminal);
    await app.terminal.write("u");
    await waitMatch(app.terminal, /^ N say "word" now/m);
  }
  const change = summarise(samples);
  record("nvim-change-inner", { change }, `p95 < ${ECHO_P95_MS}ms`);
  assert.ok(change.p95 < ECHO_P95_MS, JSON.stringify(change));
  await app.close();
});

/** The footer shows the corner fire from this width with the test's long working directory. */
const WIDE = 140;

/** Idle CPU a burning corner fire may cost, as a share of one core. */
const EMBERS_CPU_SHARE = 0.08;

test("typing stays prompt with the corner fire burning", async () => {
  const app = await launch({ scenario: "hello", cols: WIDE, settle: false, env: { PITUITARY_STILL: "0" } });
  await app.terminal.waitText("faux-1");
  const echo = summarise(await echoes(app.terminal, 40));
  record("echo-embers", { echo }, `p95 < ${ECHO_P95_MS}ms`);
  assert.ok(echo.p95 < ECHO_P95_MS, JSON.stringify(echo));
  await app.close();
});

/** The corner fire's step, which bounds how often it may draw. */
const EMBER_PACE_MS = 200;

test("an idle UI with the corner fire burning draws once a step and stays light on the processor", async () => {
  const WINDOW_MS = 3000;
  const idle = async (still: boolean) => {
    const app = await launch({
      scenario: "hello",
      cols: WIDE,
      settle: false,
      record: true,
      env: { PITUITARY_STILL: still ? "1" : "0" },
    });
    await app.terminal.waitText("faux-1");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const pid = uiPid(app.home);
    const cpu = cpuMs(pid);
    const bytes = app.raw().length;
    const start = performance.now();
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS));
    const share = (cpuMs(pid) - cpu) / (performance.now() - start);
    // Each frame the renderer writes opens a synchronized update.
    const frames = app.raw().slice(bytes).split("\x1b[?2026h").length - 1;
    await app.close();
    return { percent: Math.round(share * 1000) / 10, frames };
  };
  const held = await idle(true);
  const burning = await idle(false);
  const most = WINDOW_MS / EMBER_PACE_MS + 2;
  record(
    "idle-embers",
    {
      heldCpuPercent: held.percent,
      burningCpuPercent: burning.percent,
      heldFrames: held.frames,
      burningFrames: burning.frames,
    },
    `burning < ${EMBERS_CPU_SHARE * 100}% · at most ${most} frames in ${WINDOW_MS / 1000} s`,
  );
  assert.equal(held.frames, 0, "a held fire drew");
  assert.ok(burning.frames <= most, `${burning.frames} frames in ${WINDOW_MS} ms`);
  assert.ok(burning.percent < EMBERS_CPU_SHARE * 100, `${burning.percent}% of a core`);
});
