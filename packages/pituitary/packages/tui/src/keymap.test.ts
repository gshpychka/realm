import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionFor, keymap, loadKeymap, matches } from "./keymap.ts";

describe("matches", () => {
  test("a binding names its modifiers and key", () => {
    expect(matches({ name: "l", ctrl: true }, "ctrl+l")).toBe(true);
    expect(matches({ name: "l" }, "ctrl+l")).toBe(false);
    expect(matches({ name: "return", meta: true }, "alt+enter")).toBe(true);
    expect(matches({ name: "escape" }, "esc")).toBe(true);
    expect(matches({ name: "kpenter", meta: true }, "alt+enter")).toBe(true);
  });

  test("a modifier the binding leaves out must be up", () => {
    expect(matches({ name: "l", ctrl: true, meta: true }, "ctrl+l")).toBe(false);
    expect(matches({ name: "c", ctrl: true, shift: true }, "ctrl+c")).toBe(false);
  });

  test("shift+tab matches the key terminals report for it", () => {
    expect(matches({ name: "tab", shift: true }, "shift+tab")).toBe(true);
    expect(matches({ name: "tab" }, "shift+tab")).toBe(false);
    expect(matches({ name: "tab", shift: true }, "ctrl+shift+tab")).toBe(false);
    expect(matches({ name: "tab", shift: true, ctrl: true }, "ctrl+shift+tab")).toBe(true);
    expect(matches({ name: "tab", shift: true }, "alt+shift+tab")).toBe(false);
    expect(matches({ name: "tab", shift: true, meta: true }, "alt+shift+tab")).toBe(true);
  });

  test("an unknown modifier does not accidentally bind an ordinary letter", () => {
    expect(matches({ name: "c" }, "hyper+c")).toBe(false);
  });
});

describe("keymap", () => {
  test("pi's defaults hold where the operator sets nothing", () => {
    expect(actionFor(keymap(), { name: "l", ctrl: true })).toBe("app.model.select");
    expect(actionFor(keymap(), { name: "n", meta: true })).toBeNull();
  });

  test("an override binds an action, and replaces what it had", () => {
    const map = keymap({ "app.session.new": "alt+n", "app.model.select": ["ctrl+k"] });
    expect(actionFor(map, { name: "n", meta: true })).toBe("app.session.new");
    expect(actionFor(map, { name: "k", ctrl: true })).toBe("app.model.select");
    expect(actionFor(map, { name: "l", ctrl: true })).toBeNull();
  });

  test("an explicit override can reuse another action's default key", () => {
    const map = keymap({ "app.session.new": "ctrl+l" });
    expect(actionFor(map, { name: "l", ctrl: true })).toBe("app.session.new");
    expect(map["app.model.select"]).toEqual([]);
  });

  test("an unknown action or a malformed value is ignored", () => {
    const map = keymap({ "app.nope": "ctrl+x", "app.clear": 42 });
    expect(actionFor(map, { name: "c", ctrl: true })).toBe("app.clear");
  });
});

describe("loadKeymap", () => {
  const dirs = () => {
    const root = mkdtempSync(join(tmpdir(), "pituitary-keymap-"));
    const agent = join(root, "agent");
    mkdirSync(agent);
    return { agent, own: join(root, "own.json") };
  };

  test("pituitary's own file overrides pi's, action by action", () => {
    const { agent, own } = dirs();
    writeFileSync(
      join(agent, "keybindings.json"),
      JSON.stringify({ "app.model.select": "ctrl+k", "app.exit": "ctrl+q" }),
    );
    writeFileSync(own, JSON.stringify({ "app.model.select": ["alt+m"] }));
    const map = loadKeymap(agent, own);
    expect(map["app.model.select"]).toEqual(["alt+m"]);
    expect(map["app.exit"]).toEqual(["ctrl+q"]);
  });

  test("a missing or malformed file leaves the other in force", () => {
    const { agent, own } = dirs();
    writeFileSync(own, "not json");
    expect(loadKeymap(agent, own)["app.model.select"]).toEqual(["ctrl+l"]);
    writeFileSync(own, JSON.stringify({ "app.exit": "ctrl+q" }));
    expect(loadKeymap(agent, own)["app.exit"]).toEqual(["ctrl+q"]);
  });
});
