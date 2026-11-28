import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { boot, type Harness, pastGrace, press, REPO, waitGone, waitMatch } from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});
test("team conversations, attention and retained results stay readable in compact and wide terminals", async () => {
  const home = mkdtempSync("/tmp/pituitary-team-ui-");
  let app: Harness | undefined;
  const env = {
    HOME: home,
    PITUITARY_GH: "",
    PITUITARY_STILL: "1",
    PITUITARY_UI_STATE: join(home, "frontend.json"),
  };
  const launch = (cols: number, resume = false) =>
    boot({
      entry: join(REPO, "packages/tui/src/managed.fixture.tsx"),
      cols,
      rows: 32,
      ready: resume ? "Archived" : "waiting for builder",
      env: { ...env, ...(resume ? { PITUITARY_UI_RESUME: "1" } : {}) },
    });
  try {
    app = await launch(100);
    const compact = await app.capture("team-compact");
    assert.match(compact, /coordinator/);
    assert.match(compact, /1 needs you · tasks/);
    // The children that need the operator come first, their states under their roles, and the rest are counted.
    assert.match(
      compact,
      /^ {3}builder · Build keyboard navigation and focus handling\n {3}needs your answer$/m,
    );
    assert.match(
      compact,
      /^ {3}builder · Fix the environment and continue the menu polish\n {3}Environment image unavailable$/m,
    );
    assert.match(compact, /^ {3}\+1 more · ctrl\+k tasks$/m);
    await app.terminal.type("Keep this draft while I inspect the team");
    await app.terminal.write("\x0b");
    await app.terminal.waitText("tasks · choose");
    await pastGrace();
    await app.terminal.type("builder");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Observing");
    assert.match(await app.capture("team-child-observer"), /alt\+i join/);
    await app.terminal.write("\x11");
    await app.terminal.waitText("where should focus return?");
    await pastGrace();
    assert.match(await app.capture("team-attention"), /Return focus to the trigger/);
    await app.terminal.keyboard.press("Enter");
    await waitMatch(app.terminal, /builder · running/);
    await app.terminal.write("\x1b[1;3D");
    await waitMatch(app.terminal, /Keep this draft while I inspect the team/);
    assert.match(await app.capture("team-back-restored"), /Keep this draft while I inspect the team/);
    await app.terminal.write("\x0b");
    await app.terminal.waitText("tasks · choose");
    await pastGrace();
    await app.terminal.type("Environment image unavailable");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("No report has been submitted for this revision.");
    const failed = await app.capture("team-failed-environment");
    assert.match(failed, /Environment image unavailable/);
    assert.match(failed, /r retry · e revise/);
    await pastGrace();
    await app.terminal.type("r");
    await app.terminal.waitText("r again to start a fresh attempt");
    await app.capture("team-retry-confirm");
    // Esc steps out of the confirmation, and the next esc closes the panel.
    await app.terminal.keyboard.press("Escape");
    await app.terminal.waitText("r retry · e revise");
    await app.terminal.keyboard.press("Escape");
    await waitMatch(app.terminal, /Keep this draft while I inspect the team/);
    await app.close();
    app = undefined;
    app = await launch(148);
    const wide = await app.capture("team-wide");
    // The deadline counts minutes, not seconds, until its last minute.
    assert.match(wide, /work · 2\/4 active · 4\dm left/);
    // The attached task says so in words; the arrow marks only a list's highlighted row.
    assert.match(wide, /coordinator · current · /);
    assert.doesNotMatch(wide, /▶/);
    assert.match(wide, /verified 2\/2/);
    // Objectives that start alike are cut at their ends, so the two builders read apart.
    assert.match(wide, /builder · Build keyboard navigation and\n.*│ {3}focus handling$/m);
    assert.match(wide, /builder · Fix the environment and\n.*│ {3}continue the menu polish$/m);
    // The coordinator's work shares its rows with the panel, so what it says is cut before the
    // panel, an ellipsis last, and its failed command's row stays whole beside it.
    assert.match(wide, /^ ▸ \S+ read 3 files · searched · edited [^│\n]*… +│/m);
    assert.match(wide, /^ {3}✗ \$ bun test --filter keyboard +│/m);
    await app.terminal.write("\x06");
    await press(app.terminal, "\x1b[A", "enter open");
    await app.terminal.write("\r");
    const open = await waitMatch(app.terminal, /enter close/);
    await app.capture("team-wide-box-open");
    // Open, the title tops the box's frame, its corner against the panel.
    assert.match(open, /^ ╭ ▾ \S+ read 3 files · [^│\n]*…[ ─]*╮ +│/m);
    await app.terminal.write("\r");
    await app.terminal.waitText("enter open");
    await app.terminal.keyboard.press("Escape");
    await waitGone(app.terminal, /esc back/);
    await app.terminal.write("\x0b");
    await app.terminal.waitText("tasks · choose");
    await pastGrace();
    await app.terminal.type("reviewer");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Archived");
    await app.terminal.write("/");
    await app.terminal.waitText("archived conversation");
    await pastGrace();
    await app.terminal.type("result");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("result · reviewer");
    const result = await app.capture("team-retained-result");
    assert.match(result, /Code retained · tree \w{12} · 8 KiB/);
    assert.match(result, /Independent checks: passed/);
    assert.match(result, /✓ types/);
    assert.doesNotMatch(result, /types · passed/);
    assert.doesNotMatch(result, /i integrate|r retry/);
    await pastGrace();
    await app.terminal.type("i");
    await app.terminal.waitIdle();
    assert.match(await app.terminal.text(), /Independent checks: passed/);
    assert.doesNotMatch(result, /ctrl\+k tasks/);
    await pastGrace();
    await app.terminal.keyboard.press("Escape");
    // The archive footer is also visible while the result panel is open.
    await waitMatch(app.terminal, /^(?!.*result · reviewer).*Archived/s);
    await app.terminal.write("\x12");
    await app.terminal.waitExit({ timeout: 10000 });
    const saved = JSON.parse(readFileSync(env.PITUITARY_UI_STATE, "utf8"));
    assert.equal(saved.taskId, "reviewer");
    assert.equal(saved.control, false);
    await app.close();
    app = undefined;
    app = await launch(100, true);
    assert.match(await app.capture("team-reload-selected"), /reviewer · verified/);
    await app.terminal.write("\x1b[1;3D");
    await waitMatch(app.terminal, /command-menu · coordinator/);
    await app.terminal.waitText("Observing");
    assert.match(await app.capture("team-reload-parent"), /Observing/);
  } finally {
    await app?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("failed verification keeps its diagnostic visible in the result", async () => {
  const home = mkdtempSync("/tmp/pituitary-failed-check-ui-");
  const app = await boot({
    entry: join(REPO, "packages/tui/src/managed.fixture.tsx"),
    cols: 100,
    rows: 28,
    ready: "waiting for builder",
    env: {
      HOME: home,
      PITUITARY_UI_STATE: join(home, "frontend.json"),
      PITUITARY_FIXTURE_FAILED_CHECK: "1",
      PITUITARY_STILL: "1",
      PITUITARY_GH: "",
    },
  });
  try {
    await app.terminal.write("\x0b");
    await app.terminal.waitText("tasks · choose");
    await pastGrace();
    await app.terminal.type("reviewer");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Archived");
    await app.terminal.write("/");
    await app.terminal.waitText("archived conversation");
    await pastGrace();
    await app.terminal.type("result");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Missing exported member: keyboardShortcut");
    const screen = await app.capture("team-failed-check-output");
    assert.match(screen, /output truncated/);
    assert.doesNotMatch(screen, /i integrate/);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failed Back keeps its history entry available for a retry", async () => {
  const home = mkdtempSync("/tmp/pituitary-back-ui-");
  const app = await boot({
    entry: join(REPO, "packages/tui/src/managed.fixture.tsx"),
    cols: 100,
    rows: 28,
    ready: "waiting for builder",
    env: {
      HOME: home,
      PITUITARY_UI_STATE: join(home, "frontend.json"),
      PITUITARY_FIXTURE_FAIL_BACK: "1",
      PITUITARY_STILL: "1",
      PITUITARY_GH: "",
    },
  });
  try {
    await app.terminal.write("\x0b");
    await app.terminal.waitText("tasks · choose");
    await pastGrace();
    await app.terminal.type("builder");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("Observing");
    await app.terminal.write("\x1b[1;3D");
    await app.terminal.waitText("The previous input lease is unavailable");
    const failed = await app.capture("team-back-failed");
    assert.match(failed, /‹ back/);
    await app.terminal.write("\x1b[1;3D");
    await waitMatch(app.terminal, /command-menu · coordinator/);
    assert.doesNotMatch(await app.capture("team-back-retried"), /Observing/);
  } finally {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  }
});
