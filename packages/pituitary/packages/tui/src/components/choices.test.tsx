import { expect, test } from "bun:test";
import { KeyEvent, parseKeypress } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createRoot, flushSync } from "@opentui/react";
import { act, type ReactNode } from "react";
import { Checklist } from "./checklist.tsx";
import { CustomPanel } from "./custom-panel.tsx";
import { Dialog, GRACE_MS } from "./dialog.tsx";
import { Picker } from "./picker.tsx";
import { TodoPanel } from "./widgets.tsx";

async function draw(view: ReactNode) {
  const environment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const app = await createTestRenderer({ width: 80, height: 24 });
  const root = createRoot(app.renderer);
  act(() => flushSync(() => root.render(view)));
  await app.renderOnce();
  return {
    ...app,
    async key(name: string) {
      await act(async () => app.mockInput.pressKey(name));
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
    expect(app.captureCharFrame()).toContain("▸ other current");
    await app.type("match");
    expect(app.captureCharFrame()).toContain("▸ match first");
  } finally {
    app.close();
  }
});

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
    expect(app.captureCharFrame()).toContain("▸ match first");
    await app.key("RETURN");
    expect(picked).toBe("first");
  } finally {
    app.close();
  }
});

test("an alternate picker exposes loading and failure without picking stale items", async () => {
  let reject = (_cause: Error) => {};
  let picked = "";
  const app = await draw(
    <Picker
      spec={{
        title: "models",
        items,
        alternate: {
          label: "every model",
          items: () =>
            new Promise((_resolve, fail) => {
              reject = fail;
            }),
        },
        onPick(value) {
          picked = value;
        },
      }}
      onClose={() => {}}
    />,
  );
  try {
    await app.key("TAB");
    expect(app.captureCharFrame()).toContain("loading…");
    expect(app.captureCharFrame()).not.toContain("other current");
    await app.key("RETURN");
    expect(picked).toBe("");
    await act(async () => reject(new Error("sessions unavailable")));
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("could not load: sessions unavailable");
    await app.key("TAB");
    expect(app.captureCharFrame()).toContain("▸ match first");
    expect(app.captureCharFrame()).not.toContain("could not load");
  } finally {
    app.close();
  }
});

test("a late alternate picker response cannot replace the current list", async () => {
  let finish = (_items: typeof items) => {};
  const app = await draw(
    <Picker
      spec={{
        title: "models",
        items,
        alternate: {
          label: "every model",
          items: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        },
        onPick() {},
      }}
      onClose={() => {}}
    />,
  );
  try {
    await app.key("TAB");
    await app.key("TAB");
    await act(async () => finish([{ label: "late result", value: "late" }]));
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("match first");
    expect(app.captureCharFrame()).not.toContain("late result");
  } finally {
    app.close();
  }
});

test("mouse choices pick a model and toggle a checklist row", async () => {
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
  const checklist = await draw(
    <Checklist spec={{ title: "models", items, checked: null, onSave() {} }} onClose={() => {}} />,
  );
  try {
    await act(async () => checklist.mockMouse.click(8, 4));
    await checklist.renderOnce();
    expect(checklist.captureCharFrame()).toContain("▸ · match second");
    expect(checklist.captureCharFrame()).toContain("2 of 3 checked");
  } finally {
    checklist.close();
  }
});

test("the wheel moves a choice without moving the text filter", async () => {
  const app = await draw(<Picker spec={{ title: "models", items, onPick() {} }} onClose={() => {}} />);
  try {
    await act(async () => app.mockMouse.scroll(8, 4, "up"));
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("▸ match second");
    await act(async () => app.mockMouse.scroll(8, 4, "up"));
    await app.renderOnce();
    expect(app.captureCharFrame()).toContain("▸ match first");
  } finally {
    app.close();
  }
});

test("keypad Enter picks and checks the focused choice", async () => {
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
  const checklist = await draw(
    <Checklist spec={{ title: "models", items, checked: null, onSave() {} }} onClose={() => {}} />,
  );
  try {
    await checklist.keypad();
    expect(checklist.captureCharFrame()).toContain("2 of 3 checked");
  } finally {
    checklist.close();
  }
});

for (const method of ["select", "confirm", "input", "editor"] as const) {
  test(`keypad Enter answers an extension ${method} dialog`, async () => {
    let answer: unknown;
    const dialog = {
      type: "extension_ui_request" as const,
      id: "dialog",
      title: "Question",
      ...(method === "select"
        ? { method, options: ["first", "second"] }
        : method === "confirm"
          ? { method, message: "Keep it?" }
          : method === "editor"
            ? { method, prefill: "draft" }
            : { method }),
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
      if (method === "input") await app.type("reply");
      await app.keypad(method === "editor");
      expect(answer).toEqual({
        type: "extension_ui_response",
        id: "dialog",
        ...(method === "confirm"
          ? { confirmed: true }
          : { value: method === "select" ? "first" : method === "editor" ? "draft" : "reply" }),
      });
    } finally {
      app.close();
    }
  });
}

test("clipping an extension row keeps its prefix across ANSI style runs", async () => {
  const app = await draw(
    <box width={9}>
      <CustomPanel view={{ id: "custom", lines: ["AAAA界\x1b[31mX"] }} rows={1} />
    </box>,
  );
  try {
    expect(app.captureCharFrame()).toContain("AAAA");
    expect(app.captureCharFrame()).not.toContain("AAAAX");
  } finally {
    app.close();
  }
});

test("a checklist starts a narrowed search at its first result", async () => {
  const app = await draw(
    <Checklist spec={{ title: "models", items, checked: null, onSave() {} }} onClose={() => {}} />,
  );
  try {
    await app.key("ARROW_DOWN");
    await app.key("ARROW_DOWN");
    await app.type("match");
    expect(app.captureCharFrame()).toContain("▸ ✓ match first");
  } finally {
    app.close();
  }
});

test("a checklist can recover from arrow navigation through an empty search", async () => {
  const app = await draw(
    <Checklist spec={{ title: "models", items, checked: null, onSave() {} }} onClose={() => {}} />,
  );
  try {
    await app.type("z");
    await app.key("ARROW_UP");
    await app.key("BACKSPACE");
    expect(app.captureCharFrame()).toContain("▸ ✓ match first");
  } finally {
    app.close();
  }
});

test("checking and unchecking follows the item as checked rows reorder", async () => {
  const app = await draw(
    <Checklist spec={{ title: "models", items, checked: null, onSave() {} }} onClose={() => {}} />,
  );
  try {
    await app.key("ARROW_DOWN");
    await app.key("RETURN");
    expect(app.captureCharFrame()).toContain("▸ · match second");
    await app.key("RETURN");
    expect(app.captureCharFrame()).toContain("all checked");
    expect(app.captureCharFrame()).toContain("▸ ✓ match second");
  } finally {
    app.close();
  }
});

test("the todo panel keeps active work visible after a long completed prefix", async () => {
  const tasks = [
    ...Array.from({ length: 8 }, (_, id) => ({
      id,
      subject: `finished ${id}`,
      status: "completed" as const,
    })),
    { id: 8, subject: "active task", status: "in_progress" as const },
    { id: 9, subject: "next task", status: "pending" as const },
    { id: 10, subject: "removed task", status: "deleted" as const },
  ];
  const app = await draw(<TodoPanel tasks={tasks} />);
  try {
    const frame = app.captureCharFrame();
    expect(frame).toContain("todo 8/10");
    expect(frame).toContain("active task");
    expect(frame).toContain("next task");
    expect(frame).not.toContain("removed task");
  } finally {
    app.close();
  }
});

test("completed and deleted tasks leave no empty todo panel", async () => {
  const app = await draw(
    <TodoPanel
      tasks={[
        { id: 1, subject: "finished", status: "completed" },
        { id: 2, subject: "removed", status: "deleted" },
      ]}
    />,
  );
  try {
    expect(app.captureCharFrame()).not.toContain("todo");
  } finally {
    app.close();
  }
});
