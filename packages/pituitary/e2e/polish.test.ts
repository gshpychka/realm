import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { boot, launch, pastGrace, REPO, waitMatch } from "./helpers/harness.ts";
import { launchPi } from "./helpers/pi.ts";

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
    await app.terminal.waitIdle();
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
        assert.match(welcome, /alt\+o.*open every box/);
        assert.match(welcome, /alt\+t.*show or hide thinking/);
        await app.terminal.submit("write a lot");
        await app.terminal.waitText("line 1 of the long answer");
        await app.terminal.type("/");
        await app.terminal.waitText("/compact [instructions]");
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
    await app.terminal.keyboard.press("Escape");
    await app.terminal.write("\x03");
    await app.terminal.write("/model\rfaux-2");
    await app.terminal.waitText("1 of 2");
    assert.match(await app.capture("picker-held-editor-command"), /filter faux-2/);
  } finally {
    await app.close();
  }
});

test("configured work and thinking keys dispatch to the visible work box", async () => {
  const app = await launch({
    scenario: "thinking",
    prepare: (home) => {
      const directory = join(home, ".config/pituitary");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "keybindings.json"),
        JSON.stringify({
          "app.tools.expand": "alt+o",
          "app.thinking.toggle": "alt+t",
        }),
      );
    },
  });
  try {
    await app.terminal.submit("consider this");
    await app.terminal.waitText("You said: consider this");
    await app.terminal.waitIdle();
    await app.terminal.write("\x1bo");
    await app.terminal.waitText("I will reason through the request.");
    await app.terminal.write("\x1bt");
    await app.terminal.waitIdle();
    assert.doesNotMatch(await app.terminal.text(), /I will reason through the request\./);
    await app.terminal.write("\x1bt");
    await app.terminal.waitText("I will reason through the request.");
    await app.capture("keybindings-custom-work-thinking");
  } finally {
    await app.close();
  }
});

test("a narrow welcome fits its keys and shortens what they all do, cutting nothing mid-word", async () => {
  const app = await launch({ cols: 50 });
  try {
    const welcome = await app.capture("welcome-narrow");
    assert.match(welcome, /^ alt\+enter +queue a follow-up$/m);
    assert.match(welcome, /^ ctrl\+f +step through boxes$/m);
    // One row too long for its words shortens them all, so the list reads alike.
    assert.match(welcome, /^ ctrl\+o +open every box$/m);
    assert.match(welcome, /^ ctrl\+c twice {2}ctrl\+d +quit$/m);
    // Without a provider's report, the card holds the session's cost alone.
    assert.match(welcome, /^ alt\+u +session cost$/m);
    assert.doesNotMatch(welcome, /\.\.\./);
  } finally {
    await app.close();
  }
});

test("the model picker marks the current model by name, and a switch takes the new model's thinking", async () => {
  const app = await launch();
  try {
    await app.terminal.write("\x0c");
    await app.terminal.waitText("▶ Faux Model · current");
    const picker = await app.capture("picker-current");
    // The detail keeps its column at the right edge, past the current mark.
    assert.match(picker, /Faux Model · current +\S+ faux\/faux-1 +│/);
    assert.doesNotMatch(picker, /✓/);
    assert.match(picker, /↑↓ move · enter pick · esc close · 2 of 2/);
    await pastGrace();
    await app.terminal.type("faux-2");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("model: Faux Fast · faux/faux-2");
    // Faux Fast has no reasoning, so the footer drops the thinking level the last model had.
    const switched = await waitMatch(app.terminal, /Faux Fast(?! +\S* *medium)/);
    assert.doesNotMatch(switched.split("\n").at(-1) ?? "", /medium/);
    await app.capture("model-switch-thinking");
  } finally {
    await app.close();
  }
});

test("completion, the queue and the cost card read the same way on a narrow terminal", async () => {
  const app = await launch({ scenario: "long", delayMs: 150, cols: 60 });
  try {
    await app.terminal.type("/compact");
    await app.terminal.waitText("tab complete");
    const menu = await app.capture("completion-hint");
    assert.match(menu, /↑↓ move · tab complete · enter run · esc close/);
    await app.terminal.write("\x03");
    await app.terminal.submit("write a lot");
    await app.terminal.waitText("line 1 of the long answer");
    await app.terminal.submit(
      "follow three is a much longer message that should show how the queue truncates it at the end",
    );
    await app.terminal.waitText(`${glyphs.steering} steering follow three`);
    await app.terminal.write("\x1bu");
    await app.terminal.waitText("session $");
    const queued = await app.capture("queue-narrow");
    assert.match(queued, new RegExp(`${glyphs.steering} steering follow three is a much longer .*…$`, "m"));
    assert.doesNotMatch(queued, /\.\.\./);
    // While the run goes the interrupt key stops it, so the card closes with its own key.
    await app.terminal.write("\x1bu");
    await waitMatch(app.terminal, /^(?![\s\S]*session \$)/);
    assert.doesNotMatch(await app.terminal.text(), /aborted/);
  } finally {
    await app.close();
  }
});

test("regular Pi names its model, insets extension statuses, counts down dialogs and says what deals with errors", async () => {
  const app = await launchPi({
    apiModels: [{ id: "fake-1", name: "Fake One" }],
    argv: ["--extension", join(REPO, "packages/tui/src/pi-extension-ui.fixture.ts")],
  });
  try {
    await app.terminal.waitText("demo status");
    const start = await app.capture("pi-polish-start");
    assert.match(start, /^ demo widget line$/m);
    assert.match(start, /^ demo status$/m);
    assert.doesNotMatch(start, /fake-1/);
    await app.terminal.submit("/ask");
    await app.terminal.waitText("Allow rm -rf build?");
    await waitMatch(app.terminal, /auto-cancels in [3-6]s/);
    const asking = await app.capture("pi-dialog-countdown");
    assert.match(asking, /↑↓ move · enter pick · esc cancel/);
    await app.terminal.waitText("The question timed out: Allow rm -rf build?", { timeout: 10_000 });
    await app.terminal.waitText("picked: nothing");
    // The question closes before Pi answers it, so the notice comes before the extension's reaction.
    const timedOut = await app.capture("pi-dialog-timed-out");
    assert.match(timedOut, /The question timed out: Allow rm -rf build\?[\s\S]*picked: nothing/);
    // The provider refuses the credential, as it does a bad key.
    app.provider.reply({
      status: 401,
      body: {
        error: {
          message: "Incorrect API key provided.",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      },
    });
    await app.terminal.submit("hello");
    await app.terminal.waitText("/login signs in again");
    const refused = await app.capture("pi-error-remedy");
    assert.match(refused, /401:? Incorrect API key provided\. · \/login signs in again/);
    await app.terminal.write("\x0f");
    await app.terminal.waitIdle();
    await app.capture("pi-error-detail");
  } finally {
    await app.close();
  }
});
