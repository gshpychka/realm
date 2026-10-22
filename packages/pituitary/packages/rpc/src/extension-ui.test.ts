import { describe, expect, test } from "bun:test";
import {
  dismiss,
  type ExtensionUi,
  emptyExtensionUi,
  follow,
  openSession,
  present,
  WIDGET_LINES,
} from "./extension-ui.ts";
import { type DisplayRequest, type PiEvent, plain, type RpcExtensionUIRequest, scrub } from "./protocol.ts";
import { dialogRequest, uiRequest } from "./scripted.ts";

const select = dialogRequest({ id: "a", method: "select", title: "Allow?", options: ["Yes", "No"] });
const confirm = dialogRequest({ id: "b", method: "confirm", title: "Sure", message: "Really?" });

describe("plain", () => {
  test("drops colour and hyperlink escapes", () => {
    expect(plain("\x1b[33m◆ 3\x1b[39m")).toBe("◆ 3");
    expect(plain("\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07")).toBe("link");
  });

  test("keeps text with no escapes as it is", () => {
    expect(plain("mcp 2/2")).toBe("mcp 2/2");
  });
});

describe("extension UI", () => {
  test("dialogs queue in arrival order", () => {
    const state = present(present(emptyExtensionUi, select), confirm);
    expect(state.dialogs.map((dialog) => dialog.id)).toEqual(["a", "b"]);
  });

  test("a dialog repeated by id is held once", () => {
    expect(present(present(emptyExtensionUi, select), select).dialogs).toHaveLength(1);
  });

  test("dismissing a dialog brings the next one forward", () => {
    const state = dismiss(present(present(emptyExtensionUi, select), confirm), "a");
    expect(state.dialogs.map((dialog) => dialog.id)).toEqual(["b"]);
  });

  test("statuses are held by key, unstyled", () => {
    let state = present(
      emptyExtensionUi,
      uiRequest({ id: "1", method: "setStatus", statusKey: "rewind", statusText: "\x1b[33m◆\x1b[0m" }),
    );
    state = present(
      state,
      uiRequest({ id: "2", method: "setStatus", statusKey: "mcp", statusText: "mcp 2/2" }),
    );
    expect(state.statuses).toEqual({ rewind: "◆", mcp: "mcp 2/2" });
  });

  test("an empty status text clears its key", () => {
    const set = present(
      emptyExtensionUi,
      uiRequest({ id: "1", method: "setStatus", statusKey: "k", statusText: "on" }),
    );
    const cleared = present(
      set,
      uiRequest({ id: "2", method: "setStatus", statusKey: "k", statusText: undefined }),
    );
    expect(cleared.statuses).toEqual({});
  });

  test("a widget replaces its own key, defaults above the editor, and is cut to its line limit", () => {
    const lines = Array.from({ length: WIDGET_LINES + 5 }, (_, index) => `line ${index}`);
    let state = present(
      emptyExtensionUi,
      uiRequest({ id: "1", method: "setWidget", widgetKey: "w", widgetLines: ["old"] }),
    );
    state = present(state, uiRequest({ id: "2", method: "setWidget", widgetKey: "w", widgetLines: lines }));
    expect(state.widgets).toHaveLength(1);
    expect(state.widgets[0]?.lines).toHaveLength(WIDGET_LINES);
    expect(state.widgets[0]?.placement).toBe("aboveEditor");
  });

  test("a widget with no lines is removed", () => {
    const set = present(
      emptyExtensionUi,
      uiRequest({ id: "1", method: "setWidget", widgetKey: "w", widgetLines: ["x"] }),
    );
    const gone = present(
      set,
      uiRequest({ id: "2", method: "setWidget", widgetKey: "w", widgetLines: undefined }),
    );
    expect(gone.widgets).toEqual([]);
  });

  test("two identical editor texts are told apart", () => {
    const once = present(emptyExtensionUi, uiRequest({ id: "1", method: "set_editor_text", text: "go" }));
    const twice = present(once, uiRequest({ id: "2", method: "set_editor_text", text: "go" }));
    expect(twice.editor?.text).toBe("go");
    expect(twice.editor?.seq).not.toBe(once.editor?.seq);
  });
});

describe("statuses as the turn began", () => {
  const status = (seq: number, statusText: string | undefined) =>
    uiRequest({ id: `s${seq}`, method: "setStatus", statusKey: "am", statusText });
  const fold = (state: ExtensionUi, beats: (PiEvent | RpcExtensionUIRequest)[]) =>
    beats.reduce<ExtensionUi>(
      (current, beat) =>
        beat.type === "extension_ui_request"
          ? present(current, beat as DisplayRequest)
          : follow(current, beat),
      state,
    );
  const start: PiEvent = { type: "agent_start" };
  const settled: PiEvent = { type: "agent_settled" };
  const end = (willRetry: boolean): PiEvent => ({ type: "agent_end", messages: [], willRetry });

  test("before the session's first turn they follow the latest text", () => {
    const state = fold(emptyExtensionUi, [status(1, "d:5"), status(2, "d:6")]);
    expect(state.turnStatuses).toEqual({ am: "d:6" });
  });

  test("a run's start fixes them for its turn, which outlasts the run", () => {
    const state = fold(emptyExtensionUi, [status(1, "d:5"), start, status(2, "d:7"), end(false), settled]);
    expect(state.statuses).toEqual({ am: "d:7" });
    expect(state.turnStatuses).toEqual({ am: "d:5" });
    expect(fold(state, [start]).turnStatuses).toEqual({ am: "d:7" });
  });

  test("a retry continues the turn it retries", () => {
    const state = fold(emptyExtensionUi, [
      status(1, "d:0"),
      start,
      status(2, "d:1"),
      end(true),
      start,
      status(3, "d:2"),
      end(false),
      settled,
    ]);
    expect(state.turnStatuses).toEqual({ am: "d:0" });
  });

  test("a status first set during a turn was absent as the turn began", () => {
    const state = fold(emptyExtensionUi, [start, status(1, "d:1")]);
    expect(state.turnStatuses).toEqual({});
  });

  test("another session opened starts over from its latest text", () => {
    const earlier = fold(emptyExtensionUi, [status(1, "d:0"), start, status(2, "d:3"), end(false), settled]);
    const opened = fold(openSession(earlier), [status(3, "d:9")]);
    expect(opened.turnStatuses).toEqual({ am: "d:9" });
    expect(fold(opened, [start, status(4, "d:10")]).turnStatuses).toEqual({ am: "d:9" });
  });
});

describe("plain, against hostile text", () => {
  test("a sequence rebuilt from the pieces around a removed one is removed too", () => {
    expect(plain("\x1b\x1b[m]52;c;aGk=\x07after")).toBe("after".replace(/^/, plain("]52;c;aGk=")));
    expect(plain("\x1b\x1b[m]52;c;aGk=\x07")).not.toContain("\x1b");
  });

  test("clipboard, title, reset, and bell never survive", () => {
    const hostile = "a\x1b]52;c;YQ==\x07b\x1b]0;title\x07c\x1bcd\x07e\x1b[2Jf\x9b31mg";
    const cleaned = plain(hostile);
    expect(cleaned).toBe("abcdefg".replace("g", "31mg"));
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what must be absent
    expect(cleaned).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });

  test("newlines and tabs stay", () => {
    expect(plain("one\n\ttwo")).toBe("one\n\ttwo");
  });
});

describe("scrub", () => {
  test("cleans every string in a record, however deep", () => {
    expect(scrub({ a: ["\x1b[31mred\x1b[0m"], b: { c: "\x07bell" }, n: 1 })).toEqual({
      a: ["red"],
      b: { c: "bell" },
      n: 1,
    });
  });
});
