import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { boot, launch, REPO, settled } from "./helpers/harness.ts";

after(closeAll);

test("pending markdown keeps paragraph separators through highlighting and narrow Unicode layout", async () => {
  const app = await boot({
    entry: join(REPO, "packages/tui/src/components/markdown.fixture.tsx"),
    ready: "highlight pending",
    cols: 44,
    rows: 20,
  });
  try {
    const pending = await app.capture("markdown-highlight-pending");
    assert.match(pending, /first paragraph\n[^\n]*\n[^\n]*second paragraph/);
    await app.terminal.type("h");
    await app.terminal.waitText("highlight released");
    await settled(app.terminal);
    const highlighted = await app.capture("markdown-highlight-settled");
    assert.equal(highlighted.replace("released", "pending"), pending);
    await app.terminal.resize(30, 20);
    await app.terminal.waitIdle();
    const narrow = await app.capture("footer-unicode-narrow");
    assert.match(narrow, /資料/);
    assert.doesNotMatch(narrow, /\*\*|##|paragraphsecond/);
  } finally {
    await app.close();
  }
});

test("quoted completion consumes the full mention and leaves the cursor after it", async () => {
  const app = await launch({
    prepare: (_home, _sessions, cwd) => {
      writeFileSync(join(cwd, "two words.ts"), "export {};\n");
    },
  });
  try {
    await app.terminal.type('@"two');
    await app.terminal.waitText('@"two words.ts"');
    await app.capture("completion-quoted-menu");
    await app.terminal.keyboard.press("Tab");
    await app.terminal.type("next");
    await app.terminal.waitText('@"two words.ts" next');
    await app.capture("completion-quoted-accepted");
  } finally {
    await app.close();
  }
});

test("custom work and interrupt hints match dispatch, and unbound hints disappear", async () => {
  for (const unbound of [false, true]) {
    const app = await launch({
      scenario: "long",
      delayMs: 150,
      prepare: (home) => {
        const directory = join(home, ".config/pituitary");
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, "keybindings.json"),
          JSON.stringify({
            "app.interrupt": unbound ? [] : "ctrl+x",
            "app.tools.expand": unbound ? [] : "alt+o",
            "app.thinking.toggle": unbound ? [] : "alt+t",
          }),
        );
      },
    });
    try {
      const welcome = await app.capture(`keybindings-${unbound ? "unbound" : "custom"}`);
      assert.doesNotMatch(welcome, /ctrl\+o|ctrl\+t/);
      if (unbound)
        assert.doesNotMatch(welcome, /interrupt and take back|show or hide thinking|open every box/);
      else {
        assert.match(welcome, /ctrl\+x.*interrupt/);
        await app.terminal.submit("write a lot");
        await app.terminal.waitText("line 1 of the long answer");
        await app.terminal.write("\x18");
        await app.terminal.waitText("aborted");
        await app.capture("keybindings-custom-interrupt");
      }
    } finally {
      await app.close();
    }
  }
});

test("rapid picker input follows the asynchronous model command", async () => {
  const app = await launch();
  try {
    await app.terminal.write("draft\x0cfaux-2");
    await app.terminal.waitText("1 of 2");
    const screen = await app.capture("picker-held-filter");
    assert.match(screen, /filter faux-2/);
    assert.doesNotMatch(screen, /filter.*draft/);
  } finally {
    await app.close();
  }
});
