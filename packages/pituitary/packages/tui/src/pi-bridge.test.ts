import { expect, test } from "bun:test";
import {
  BridgeError,
  decodeCall,
  decodeReply,
  decodeRuntime,
  encodeCall,
  encodeReply,
  encodeRuntime,
  readResult,
} from "./pi-bridge.ts";

test("each request kind survives the command line it travels as", () => {
  for (const call of [
    { id: "1", kind: "sessions", all: true },
    { id: "2", kind: "rename-session", path: "/s/a.jsonl", name: "Planning" },
    { id: "3", kind: "delete-session", path: "/s/a.jsonl" },
    { id: "4", kind: "reload" },
  ] as const)
    expect(decodeCall(` ${encodeCall(call)} `)).toEqual(call);
  expect(
    decodeCall(encodeCall({ id: "5", kind: "rename-session", path: "/s", name: "  spaced  " })),
  ).toMatchObject({
    name: "spaced",
  });
});

test("a malformed request names its id when it has one, so the reply can still say what failed", () => {
  const failure = (args: string) => {
    try {
      decodeCall(args);
    } catch (error) {
      return error instanceof BridgeError ? { message: error.message, id: error.id } : error;
    }
  };
  expect(failure("not json")).toEqual({ message: "The bridge request is not a JSON object.", id: undefined });
  expect(failure('{"kind":"reload"}')).toMatchObject({ id: undefined });
  expect(failure('{"id":"7","kind":"sessions"}')).toEqual({ message: "sessions needs `all`.", id: "7" });
  expect(failure('{"id":"8","kind":"rename-session","path":"/s","name":"  "}')).toMatchObject({ id: "8" });
  expect(failure('{"id":"9","kind":"delete-session"}')).toMatchObject({ id: "9" });
  expect(failure('{"id":"10","kind":"tree-of-life"}')).toEqual({
    message: "Unknown bridge request: tree-of-life",
    id: "10",
  });
});

test("replies and runtime marks are read only when well formed", () => {
  expect(decodeReply(encodeReply({ id: "1", ok: true, result: { sessions: [] } }))).toEqual({
    id: "1",
    ok: true,
    result: { sessions: [] },
  });
  expect(decodeReply(encodeReply({ id: "2", ok: false, error: "no" }))).toEqual({
    id: "2",
    ok: false,
    error: "no",
  });
  expect(decodeReply(undefined)).toBeUndefined();
  expect(decodeReply('{"ok":true}')).toBeUndefined();
  expect(decodeReply('{"id":"3","ok":"yes"}')).toBeUndefined();
  const mark = { cwd: "/work", argumentHints: { review: "<focus>" } };
  expect(decodeRuntime(encodeRuntime(mark))).toEqual(mark);
  expect(decodeRuntime(undefined)).toBeUndefined();
  expect(decodeRuntime('{"cwd":""}')).toBeUndefined();
});

test("a sessions result keeps only the sessions it can show", () => {
  const good = { path: "/s/a.jsonl", id: "a", cwd: "", modified: 1, prompts: 0, first: "", name: "Plan" };
  expect(readResult("sessions", { sessions: [good, { ...good, modified: "soon" }, null] })).toEqual({
    sessions: [good],
  });
  expect(readResult("sessions", "nonsense")).toEqual({ sessions: [] });
  expect(readResult("reload", { anything: true })).toBeNull();
  expect(readResult("delete-session", { trashed: true })).toEqual({ trashed: true });
  expect(readResult("delete-session", null)).toEqual({ trashed: false });
});
