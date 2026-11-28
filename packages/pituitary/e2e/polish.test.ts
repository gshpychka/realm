import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { closeAll } from "@microsoft/tui-test";
import { glyphs } from "../packages/tui/src/glyphs.ts";
import { boot, launch, pastGrace, REPO, waitMatch } from "./helpers/harness.ts";
import { re } from "./helpers/pattern.ts";
import { launchPi } from "./helpers/pi.ts";

const CTRL_O = "\x0f";

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

test("a mention offers the file whose name matches first, and letters in order across a path", async () => {
  const app = await launch({
    prepare: (_home, _sessions, cwd) => {
      for (const path of [
        "src/payouts/limits.ts",
        "src/limits/index.ts",
        "docs/payouts.md",
        "test/limits.test.ts",
      ]) {
        mkdirSync(join(cwd, path, ".."), { recursive: true });
        writeFileSync(join(cwd, path), "export {};\n");
      }
    },
  });
  try {
    await app.terminal.type("@limits");
    await app.terminal.waitText("@src/limits/index.ts");
    assert.match(await app.capture("mention-ranked"), /^ ▶ @src\/payouts\/limits\.ts *$/m);
    await app.terminal.keyboard.press("Tab");
    await waitMatch(app.terminal, /» @src\/payouts\/limits\.ts *$/m);
    await app.terminal.write("\x03");
    await app.terminal.waitText("» ask pi");
    await app.terminal.type("@dpm");
    await app.terminal.waitText("@docs/payouts.md");
    const fuzzy = await app.capture("mention-fuzzy");
    assert.match(fuzzy, /^ ▶ @docs\/payouts\.md *$/m);
    assert.equal(fuzzy.match(/^ [▶ ] @/gm)?.length, 1);
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
      if (unbound) {
        assert.doesNotMatch(welcome, /interrupt and take back|show or hide thinking|open every box/);
        // With no interrupt key, the list names no key to close it.
        await app.terminal.type("/");
        await app.terminal.waitText("/compact [instructions]");
        await app.terminal.waitIdle();
        assert.doesNotMatch(await app.capture("keybindings-unbound-menu"), /\S+ close/);
      } else {
        assert.match(welcome, /ctrl\+x.*interrupt/);
        assert.match(welcome, /alt\+o.*open every box/);
        assert.match(welcome, /alt\+t.*show or hide thinking/);
        await app.terminal.submit("write a lot");
        await app.terminal.waitText("line 1 of the long answer");
        await app.terminal.type("/");
        await app.terminal.waitText("/compact [instructions]");
        // The list closes with the interrupt's key as the operator binds it.
        const menu = await app.terminal.text();
        assert.match(menu, /ctrl\+x close/);
        assert.doesNotMatch(menu, /esc close/);
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
    const heading = "Ask pi something to get started.";
    const rows = welcome
      .slice(welcome.indexOf(heading) + heading.length, welcome.indexOf("━"))
      .split("\n")
      .filter((row) => row.trim() !== "");
    assert.ok(rows.length > 0, welcome);
    for (const row of rows) {
      assert.doesNotMatch(row, /…/);
      // Every key keeps what it does beside it.
      assert.match(row, /^ \S.*\S {2,}\S/);
    }
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
    await pastGrace();
    await app.terminal.type("faux-2");
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("model: Faux Fast · faux/faux-2");
    // Faux Fast has no reasoning, so the footer drops the thinking level the last model had.
    const switched = await waitMatch(app.terminal, /Faux Fast[^\n]*$/);
    assert.doesNotMatch(switched.split("\n").at(-1) ?? "", /medium/);
    await app.capture("model-switch-thinking");
  } finally {
    await app.close();
  }
});

test("a long queued message keeps to one row on a narrow terminal, and keys in a burst each move the list", async () => {
  const app = await launch({ scenario: "long", delayMs: 150, cols: 60 });
  try {
    // Keys that arrive together before the list draws each move the choice, and shift+tab moves
    // it back without cycling the thinking level.
    await app.terminal.type("/");
    await app.terminal.waitText("/compact [instructions]");
    await app.terminal.waitIdle();
    const listed = (await app.terminal.text())
      .split("\n")
      .flatMap((row) => /^ [▶ ] (\/\S+)/.exec(row)?.[1] ?? []);
    assert.ok(listed.length >= 4, listed.join(" "));
    const chosen = async () =>
      (await app.terminal.text()).split("\n").flatMap((row) => /^ ▶ (\/\S+)/.exec(row)?.[1] ?? [])[0];
    await app.terminal.write("\x1b[B\x1b[B\x1b[B");
    await waitMatch(app.terminal, re.m`^ ▶ ${listed[3] as string}\b`);
    await app.terminal.write("\x1b[Z");
    await waitMatch(app.terminal, re.m`^ ▶ ${listed[2] as string}\b`);
    assert.equal(await chosen(), listed[2]);
    assert.doesNotMatch(await app.terminal.text(), /thinking: /);
    await app.terminal.keyboard.press("Tab");
    await waitMatch(app.terminal, re.m`» ${listed[2] as string} *$`);
    await app.terminal.write("\x03");
    await app.terminal.waitText("» ask pi");

    await app.terminal.submit("write a lot");
    await app.terminal.waitText("line 1 of the long answer");
    await app.terminal.submit(
      "follow three is a much longer message that should show how the queue truncates it at the end",
    );
    await app.terminal.waitText(`${glyphs.steering} steering follow three`);
    const queued = await app.capture("queue-narrow");
    assert.match(queued, new RegExp(`${glyphs.steering} steering follow three is a much longer .*…$`, "m"));
  } finally {
    await app.close();
  }
});

test("regular Pi names its model, insets extension statuses, counts down dialogs and says what deals with errors", async () => {
  const app = await launchPi({
    apiModels: [{ id: "fake-1", name: "Fake One" }],
    argv: ["--extension", join(REPO, "packages/tui/src/pi-extension-ui.fixture.ts")],
    // A full context shows as the provider refused it, rather than after Pi compacts and retries.
    settings: { compaction: { enabled: false } },
  });
  try {
    await app.terminal.waitText("demo status");
    const start = await app.capture("pi-polish-start");
    assert.match(start, /^ demo widget line$/m);
    assert.match(start, /^ demo status$/m);
    // The footer names the model as Pi's registry does, never by its id.
    assert.match(start.split("\n").at(-1) ?? "", /Fake One/);
    assert.doesNotMatch(start, /fake-1/);
    await app.terminal.submit("/ask");
    await app.terminal.waitText("Allow rm -rf build?");
    const counting = await waitMatch(app.terminal, /auto-cancels in [3-6]s/);
    await app.capture("pi-dialog-countdown");
    const left = Number(/auto-cancels in (\d)s/.exec(counting)?.[1]);
    await waitMatch(app.terminal, re`auto-cancels in ${left - 1}s`);
    await app.terminal.waitText("The question timed out: Allow rm -rf build?", { timeout: 10_000 });
    await app.terminal.waitText("picked: nothing");
    // The question closes before Pi answers it, so the notice comes before the extension's reaction.
    const timedOut = await app.capture("pi-dialog-timed-out");
    assert.match(timedOut, /The question timed out: Allow rm -rf build\?[\s\S]*picked: nothing/);

    // A question longer than the dialog shows its start and every option, and scrolls.
    await app.terminal.submit("/ask-long");
    await app.terminal.waitText("question line 1");
    await app.terminal.waitIdle();
    const long = await app.capture("pi-dialog-long");
    assert.doesNotMatch(long, /question line 20/);
    assert.match(long, /▶ Allow/);
    assert.match(long, /Block/);
    assert.match(long, /pgup pgdn scroll/);
    await pastGrace();
    for (let page = 0; page < 10 && !(await app.terminal.text()).includes("question line 20"); page++)
      await app.terminal.write("\x1b[6~");
    const scrolled = await waitMatch(app.terminal, /question line 20/);
    assert.doesNotMatch(scrolled, /question line 1\b/);
    await app.terminal.keyboard.press("Enter");
    await app.terminal.waitText("picked: Allow");

    // The provider refuses the credential, as it does a bad key: the brief says what to do, and its
    // detail is the body the provider sent.
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
    await app.terminal.waitText("/login");
    const refused = await app.capture("pi-error-remedy");
    assert.match(refused, /Incorrect API key provided\..*\/login.*· ctrl\+o\b/);
    assert.doesNotMatch(refused, /"code":"invalid_api_key"/);
    await app.terminal.write(CTRL_O);
    await app.terminal.waitIdle();
    const detail = await app.capture("pi-error-detail");
    assert.match(detail, /"code":\s*"invalid_api_key"/);
    assert.doesNotMatch(detail, /\/login.*ctrl\+o/);
    await app.terminal.write(CTRL_O);

    // A refused permission is no sign-in problem, so it offers no /login.
    app.provider.reply({
      status: 403,
      body: {
        type: "error",
        error: {
          type: "permission_error",
          message: "Your API key does not have permission to use the specified resource.",
        },
      },
    });
    await app.terminal.submit("may I");
    await app.terminal.waitText("does not have permission");
    await app.terminal.waitIdle();
    const forbidden = await app.capture("pi-error-forbidden");
    assert.match(forbidden, /403.*Your API key does not have permission to use the specified resource\./);
    assert.equal(forbidden.match(/\/login/g)?.length, 1);

    // A provider that limits the rate asks for patience.
    app.provider.reply({
      status: 429,
      body: {
        error: { message: "Rate limit reached for requests", type: "requests", code: "rate_limit_exceeded" },
      },
    });
    await app.terminal.submit("again");
    await app.terminal.waitText("Rate limit reached for requests");
    await app.terminal.waitIdle();
    assert.match(await app.capture("pi-error-rate"), /429.*Rate limit reached for requests · wait a moment/);

    // A full context offers /compact.
    app.provider.reply({
      status: 400,
      body: {
        error: {
          message:
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.",
          type: "invalid_request_error",
          code: "context_length_exceeded",
        },
      },
    });
    await app.terminal.submit("one more");
    await app.terminal.waitText("maximum context length");
    await app.terminal.waitIdle();
    assert.match(
      await app.capture("pi-error-context"),
      /400: This model's maximum context length[\s\S]*?tokens\. · \/compact frees context/,
    );

    // An error an extension reports with its stack shows its message, and the frames only expanded.
    await app.terminal.submit("/crash");
    await app.terminal.waitText("Cannot read properties of null (reading 'x')");
    await app.terminal.waitIdle();
    const crashed = await app.capture("pi-error-stack");
    assert.match(crashed, /Cannot read properties of null \(reading 'x'\) · ctrl\+o\b/);
    assert.doesNotMatch(crashed, /TypeError|^ +at /m);
    await app.terminal.write(CTRL_O);
    await waitMatch(app.terminal, /^ +at \S/m);
    // The frames follow the message, which they do not repeat.
    const frames = await app.capture("pi-error-stack-detail");
    assert.doesNotMatch(frames, /TypeError/);
    assert.ok((frames.match(/Cannot read properties of null/g)?.length ?? 0) <= 1, frames);
  } finally {
    await app.close();
  }
});

test("a write's heading says how many lines it wrote, and the file holds them", async () => {
  const app = await launchPi();
  try {
    app.provider.reply(
      { tool: "write", arguments: { path: "notes.md", content: "one\ntwo\n" } },
      "Wrote the notes.",
    );
    await app.terminal.submit("write the notes");
    await app.terminal.waitText("Wrote the notes.");
    await app.terminal.waitIdle();
    await app.terminal.write(CTRL_O);
    await app.terminal.waitText("notes.md");
    await app.terminal.waitIdle();
    const written = await app.capture("pi-write-heading");
    assert.match(written, /write notes\.md · 2 lines/);
    assert.equal(readFileSync(join(app.cwd, "notes.md"), "utf8"), "one\ntwo\n");
  } finally {
    await app.close();
  }
});

test("without a credential for its model Pi says how to sign in, once, and asks the provider nothing", async () => {
  const app = await launchPi({ signedIn: false });
  try {
    await app.terminal.submit("hello");
    await app.terminal.waitText("No API key found");
    await app.terminal.waitIdle();
    const missing = await app.capture("pi-no-credential");
    assert.match(
      missing,
      /No API key found for \S+\. Use \/login to log into a provider via OAuth or API key\./,
    );
    assert.equal(missing.match(/\/login/g)?.length, 1);
    assert.equal(app.provider.requests.length, 0);
    await app.terminal.write(CTRL_O);
    await waitMatch(app.terminal, /providers\.md[\s\S]*models\.md/);
    const detail = await app.capture("pi-no-credential-detail");
    assert.equal(detail.match(/No API key found/g)?.length, 1);
  } finally {
    await app.close();
  }
});
