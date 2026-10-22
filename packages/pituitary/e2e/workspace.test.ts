import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { boot, type Harness, REPO } from "./helpers/harness.ts";

after(async () => {
  await closeAll();
});

test("a remote agent shows its own workspace and never offers the operator's files, branch or credentials", async () => {
  const root = mkdtempSync("/tmp/pituitary-remote-ui-");
  const host = join(root, "host-checkout");
  mkdirSync(join(host, ".git"), { recursive: true });
  writeFileSync(join(host, ".git", "HEAD"), "ref: refs/heads/HOST_ONLY_BRANCH\n");
  writeFileSync(join(host, "HOST_ONLY_SECRET.ts"), "operator files stay local\n");
  const gh = join(root, "gh");
  const ghCalls = join(root, "gh-calls");
  writeFileSync(
    gh,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_PROBE_PATH"\nprintf \'{"number":999,"url":"https://github.com/host/repo/pull/999","state":"OPEN","isDraft":false}\\n\'\n',
    { mode: 0o700 },
  );
  let app: Harness | undefined;
  try {
    app = await boot({
      entry: join(REPO, "packages/tui/src/app.fixture.tsx"),
      cwd: host,
      ready: "builder:/work",
      env: {
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        PITUITARY_GH: gh,
        GH_PROBE_PATH: ghCalls,
        PITUITARY_STILL: "1",
        PITUITARY_LOG: join(root, "tui.log"),
      },
    });
    const attached = await app.capture("remote-workspace-attached");
    assert.match(attached, /builder:\/work/);
    assert.match(attached, /remote-build/);
    assert.doesNotMatch(attached, /HOST_ONLY_BRANCH|host-checkout|#999/);
    assert.doesNotMatch(attached, /files to mention|pick a model|take the next model/);
    assert.equal(existsSync(ghCalls), false, "remote footer invoked the operator's GitHub CLI");
    await app.terminal.type("@HOST_ONLY");
    await app.terminal.waitIdle();
    const mentioning = await app.terminal.text();
    assert.doesNotMatch(mentioning, /HOST_ONLY_SECRET\.ts|tab completes/);
    await app.terminal.write("\x03");
    await app.terminal.submit("/resume");
    await app.terminal.waitText("/resume requires a local session.");
    await app.terminal.submit("/model");
    await app.terminal.waitText("The model is declared by this agent's role.");
    await app.terminal.submit("/share");
    await app.terminal.waitText("/share requires a local session.");
    assert.equal(existsSync(ghCalls), false, "remote share invoked the operator's GitHub CLI");
    await app.terminal.submit("/name reviewed remotely");
    await app.terminal.waitText("reviewed remotely");
    await app.terminal.type("/co");
    await app.terminal.waitText("/compact [instructions]");
    const commands = await app.capture("remote-workspace-commands");
    assert.match(commands, /\/copy/);
    assert.doesNotMatch(commands, /\/scoped-models/);
  } finally {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
