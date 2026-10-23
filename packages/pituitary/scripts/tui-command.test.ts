import { describe, expect, test } from "bun:test";
import { driverSocket, environment, parseCommand, validateCommand } from "./tui-command.ts";

describe("development CLI arguments", () => {
  test("literal flags reach the editor after --", () => {
    expect(parseCommand(["type", "--", "--help", "--model=example"]).args).toEqual([
      "--help",
      "--model=example",
    ]);
    expect(parseCommand(["submit", "--", "--"]).args).toEqual(["--"]);
  });

  test("boolean switches never consume following words", () => {
    expect(() => parseCommand(["screen", "--style", "unexpected"])).toThrow("takes no arguments");
    expect(parseCommand(["start", "--tmux", "--cols=40"])).toMatchObject({
      options: { tmux: "", cols: "40" },
    });
  });

  test("typos and missing values fail before starting a driver", () => {
    expect(() => parseCommand(["scren"])).toThrow("unknown command");
    expect(() => parseCommand(["screen", "--stlye"])).toThrow("unknown option");
    expect(() => parseCommand(["start", "--cols"])).toThrow("needs a value");
    expect(() => parseCommand(["start", "--scenario", "--cols", "40"])).toThrow("needs a value");
    expect(() => parseCommand(["resize", "40"])).toThrow("columns and rows");
    expect(() => parseCommand(["wait"])).toThrow("needs an argument");
  });

  test("invalid dimensions and timers cannot corrupt the terminal", () => {
    for (const value of ["0", "-1", "NaN", "Infinity", "1.5", "", "9007199254740992"]) {
      expect(() => parseCommand(["resize", value, "28"])).toThrow("positive integer");
      expect(() => parseCommand(["start", `--cols=${value}`])).toThrow("positive integer");
    }
    expect(parseCommand(["start", "--delay", "0"]).options.delay).toBe("0");
    expect(() => parseCommand(["start", "--delay", "-1"])).toThrow("nonnegative integer");
    expect(() => parseCommand(["start", "--settle", "no"])).toThrow("true or false");
  });

  test("capture names and session names cannot escape their directories", () => {
    expect(() => parseCommand(["capture", "../outside"])).toThrow("capture name");
    expect(() => driverSocket("../outside")).toThrow("TUI_SESSION");
    expect(driverSocket("review-2")).toMatch(/\/pituitary-drive-\d+\/[a-f0-9]{24}\.sock$/);
    expect(parseCommand(["capture", "review-2"]).args).toEqual(["review-2"]);
  });

  test("socket addresses stay short and isolate workspaces and sessions", () => {
    const workspace = `/tmp/${"long-checkout/".repeat(30)}`;
    const session = "a".repeat(40);
    const socket = driverSocket(session, workspace);
    expect(Buffer.byteLength(socket)).toBeLessThan(100);
    expect(driverSocket(session, workspace)).toBe(socket);
    expect(driverSocket(session, `${workspace}/other`)).not.toBe(socket);
    expect(driverSocket(`${session.slice(1)}b`, workspace)).not.toBe(socket);
  });

  test("direct socket commands have the same validation", () => {
    for (const value of [null, [], { op: "screen" }, { op: "screen", args: [2], options: {} }]) {
      expect(() => validateCommand(value)).toThrow("not a command");
    }
  });
});

test("environment assignments preserve empty values and embedded equals", () => {
  expect(environment("TOKEN=;URL=https://example.invalid/?x=y;;")).toEqual({
    TOKEN: "",
    URL: "https://example.invalid/?x=y",
  });
  for (const value of ["BROKEN", "=value", "bad name=value"]) {
    expect(() => environment(value)).toThrow("KEY=value");
  }
});
