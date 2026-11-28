import { expect, test } from "bun:test";
import { KeyEvent, parseKeypress } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { act, type ReactNode } from "react";
import { keymap } from "../keymap.ts";
import { KeymapProvider } from "../keymap-context.tsx";
import { Dialog, dialogTitle, GRACE_MS } from "./dialog.tsx";
import { Picker } from "./picker.tsx";

async function draw(view: ReactNode) {
  const environment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const app = await createTestRenderer({ width: 80, height: 24 });
  const root = createRoot(app.renderer);
  act(() => flushSync(() => root.render(view)));
  await app.renderOnce();
  return {
    ...app,
    async key(name: string, modifiers?: { ctrl?: boolean }) {
      await act(async () => app.mockInput.pressKey(name, modifiers));
      await app.renderOnce();
    },
    async type(text: string) {
      await act(async () => app.mockInput.typeText(text));
      await app.renderOnce();
    },
    async keypad(alt = false) {
      const key = parseKeypress(alt ? "\x1b[57414;3u" : "\x1b[57414u", { useKittyKeyboard: true });
      if (key?.name !== "kpenter") throw new Error("keypad Enter did not parse");
      await act(async () => {
        app.renderer.keyInput.emit("keypress", new KeyEvent(key));
      });
      await app.renderOnce();
    },
    close() {
      act(() => flushSync(() => root.unmount()));
      app.renderer.destroy();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", environment);
    },
  };
}

const items = [
  { label: "match first", value: "first" },
  { label: "match second", value: "second" },
  { label: "other current", value: "other", current: true },
];

test("a picker starts a narrowed search at its first result", async () => {
  const app = await draw(<Picker spec={{ title: "models", items, onPick() {} }} onClose={() => {}} />);
  try {
    expect(app.captureCharFrame()).toContain("▶ other current");
    await app.type("match");
    expect(app.captureCharFrame()).toContain("▶ match first");
  } finally {
    app.close();
  }
});

test("typing a filter and Enter together picks from the new matches", async () => {
  let picked = "";
  const app = await draw(
    <Picker
      spec={{
        title: "models",
        items,
        onPick: (value) => {
          picked = value;
        },
      }}
      onClose={() => {}}
    />,
  );
  try {
    await act(async () => {
      await app.mockInput.typeText("match");
      app.mockInput.pressKey("RETURN");
    });
    expect(picked).toBe("first");
  } finally {
    app.close();
  }
});

for (const [name, query, keys, expected] of [
  ["new filter", "match", ["ARROW_DOWN", "RETURN"], "second"],
  ["repeated arrows", "", ["ARROW_UP", "ARROW_UP", "RETURN"], "first"],
  ["empty filter recovery", "z", ["ARROW_DOWN", "BACKSPACE", "ARROW_DOWN", "RETURN"], "second"],
] as const) {
  test(`picker selection follows ${name} before the next render`, async () => {
    let picked = "";
    const app = await draw(
      <Picker
        spec={{
          title: "models",
          items,
          onPick: (value) => {
            picked = value;
          },
        }}
        onClose={() => {}}
      />,
    );
    try {
      await act(async () => {
        await app.mockInput.typeText(query);
        for (const key of keys) app.mockInput.pressKey(key);
      });
      expect(picked).toBe(expected);
    } finally {
      app.close();
    }
  });
}

test("an empty picker can recover from arrow navigation without losing its selection", async () => {
  let picked = "";
  const app = await draw(
    <Picker
      spec={{
        title: "models",
        items,
        onPick(value) {
          picked = value;
        },
      }}
      onClose={() => {}}
    />,
  );
  try {
    await app.type("z");
    await app.key("ARROW_DOWN");
    await app.key("BACKSPACE");
    expect(app.captureCharFrame()).toContain("▶ match first");
    await app.key("RETURN");
    expect(picked).toBe("first");
  } finally {
    app.close();
  }
});

test("mouse choices pick a model", async () => {
  let picked = "";
  const picker = await draw(
    <Picker
      spec={{
        title: "models",
        items,
        onPick(value) {
          picked = value;
        },
      }}
      onClose={() => {}}
    />,
  );
  try {
    await act(async () => picker.mockMouse.click(8, 4));
    expect(picked).toBe("second");
  } finally {
    picker.close();
  }
});

test("the wheel moves a choice without moving the text filter", async () => {
  const app = await draw(<Picker spec={{ title: "models", items, onPick() {} }} onClose={() => {}} />);
  try {
    await act(async () => app.mockMouse.scroll(8, 4, "up"));
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("▶ match second");
    await act(async () => app.mockMouse.scroll(8, 4, "up"));
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("▶ match first");
  } finally {
    app.close();
  }
});

test("a long label is cut at its end, so the details line up at the right edge past the current mark", async () => {
  const long = {
    label: `another session with a deliberately very long first prompt ${"x".repeat(40)}`,
    value: "long",
  };
  const app = await draw(
    <Picker
      spec={{
        title: "resume",
        items: [
          { ...long, detail: "3m ago · 5 prompts" },
          { label: "short", detail: "just now · 1 prompt", value: "short", keywords: "zebra topic" },
          { label: "in effect", detail: "1h ago · 2 prompts", value: "now", current: true },
        ],
        onPick() {},
      }}
      onClose={() => {}}
    />,
  );
  try {
    const rows = app.captureCharFrame().split("\n");
    expect(rows.find((row) => row.includes("another session"))).toMatch(
      /│ {3}another session with a deliberately very long first pr… 3m ago · 5 prompts │/,
    );
    expect(rows.find((row) => row.includes("short"))).toMatch(/│ {3}short\s+just now · 1 prompt │/);
    // The list starts on the item in effect, which says so after its label; its detail keeps the column.
    expect(rows.find((row) => row.includes("in effect"))).toMatch(
      /│ ▶ in effect · current\s+1h ago · 2 prompts │/,
    );
    // Text the row does not show still finds it.
    await app.type("zebra");
    expect(app.captureCharFrame()).toContain("▶ short");
  } finally {
    app.close();
  }
});

test("a list's own keys follow the operator's bindings, and its hint names them", async () => {
  const acted: string[] = [];
  const app = await draw(
    <KeymapProvider value={keymap({ "app.session.rename": "ctrl+e" })}>
      <Picker
        spec={{
          title: "resume",
          items,
          keys: [
            { action: "app.session.rename", label: "rename", run: (value) => acted.push(`rename ${value}`) },
            { action: "app.session.delete", label: "delete", run: (value) => acted.push(`delete ${value}`) },
            { action: "tui.input.tab", label: "every project", run: () => acted.push("scope") },
          ],
          onPick() {},
        }}
        onClose={() => {}}
      />
    </KeymapProvider>,
  );
  try {
    // At 80 columns the keys every list has give way to the list's own.
    expect(app.captureCharFrame()).toContain(
      "ctrl+e rename · ctrl+x delete · tab every project · esc close · 3 of 3",
    );
    await app.key("r", { ctrl: true });
    await app.key("e", { ctrl: true });
    await app.key("x", { ctrl: true });
    await act(async () => app.mockInput.pressTab());
    expect(acted).toEqual(["rename other", "delete other", "scope"]);
  } finally {
    app.close();
  }
});

test("keypad Enter picks the focused model", async () => {
  let picked = "";
  const picker = await draw(
    <Picker
      spec={{
        title: "models",
        items,
        onPick(value) {
          picked = value;
        },
      }}
      onClose={() => {}}
    />,
  );
  try {
    await picker.keypad();
    expect(picked).toBe("other");
  } finally {
    picker.close();
  }
});

for (const method of ["select", "editor"] as const) {
  test(`keypad Enter answers an operator ${method} dialog`, async () => {
    let answer: unknown;
    const dialog = {
      type: "dialog" as const,
      id: "dialog",
      title: "Question",
      ...(method === "select" ? { method, options: ["first", "second"] } : { method, prefill: "draft" }),
    };
    const app = await draw(
      <Dialog
        dialog={dialog}
        behind={0}
        onAnswer={(value) => {
          answer = value;
        }}
      />,
    );
    try {
      await act(async () => new Promise((resolve) => setTimeout(resolve, GRACE_MS + 10)));
      await app.keypad(method === "editor");
      expect(answer).toEqual({
        type: "dialog_response",
        id: "dialog",
        value: method === "select" ? "first" : "draft",
      });
    } finally {
      app.close();
    }
  });
}

test("a long question takes half the dialog, and pgup and pgdn scroll it", async () => {
  const title = [
    "builder asks",
    ...Array.from({ length: 12 }, (_, line) => `paragraph line ${line + 1}`),
  ].join("\n");
  const app = await draw(
    <Dialog
      dialog={{ type: "dialog", id: "long", title, method: "select", options: ["yes", "no"] }}
      behind={0}
      rows={12}
      onAnswer={() => {}}
    />,
  );
  try {
    let frame = app.captureCharFrame();
    expect(frame).toContain("paragraph line 5");
    expect(frame).not.toContain("paragraph line 6");
    expect(frame).toContain("↑↓ move · enter pick · pgup pgdn scroll");
    await app.key("\x1b[6~");
    await app.key("\x1b[6~");
    frame = app.captureCharFrame();
    expect(frame).toContain("paragraph line 8");
    expect(frame).not.toContain("builder asks");
  } finally {
    app.close();
  }
});

test("a dialog's border counts the questions waiting and the seconds left", () => {
  expect(dialogTitle(0, null)).toBeUndefined();
  expect(dialogTitle(1, null)).toBe(" 1 of 2 ");
  expect(dialogTitle(0, 7)).toBe(" auto-cancels in 7s ");
  expect(dialogTitle(2, 0)).toBe(" 1 of 3 · auto-cancels in 0s ");
});
