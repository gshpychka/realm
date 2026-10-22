import { describe, expect, test } from "bun:test";
import { badge, badges } from "./status.ts";

describe("badge", () => {
  test("language servers read their state from pi-lens's words", () => {
    expect(badge("pi-lens-lsp", "LSP Inactive")).toMatchObject({ glyph: "lsp", tone: "off", detail: null });
    expect(badge("pi-lens-lsp", "LSP Active: typescript")).toMatchObject({ tone: "ok", detail: null });
    expect(badge("pi-lens-lsp", "LSP Active: ts · LSP Failed: nix")).toMatchObject({ tone: "alarm" });
  });

  test("a negated or failed state is never read as ok", () => {
    expect(badge("pi-lens-lsp", "LSP Disconnected")).toMatchObject({ tone: "alarm" });
    expect(badge("pi-lens-lsp", "LSP not running")).toMatchObject({ tone: "alarm" });
    expect(badge("indexer", "not connected")).toMatchObject({ tone: "alarm" });
    expect(badge("indexer", "server unreachable")).toMatchObject({ tone: "alarm" });
    expect(badge("indexer", "offline")).toMatchObject({ tone: "alarm" });
  });

  test("a failure outranks a server count that reads healthy", () => {
    expect(badge("mcp", "mcp 3/3 failed")).toMatchObject({ tone: "alarm", detail: "failed" });
    expect(badge("mcp", "MCP: 3 servers (1 connected) error")).toMatchObject({
      tone: "alarm",
      detail: "1/3 error",
    });
  });

  test("MCP servers show a count only while some are missing", () => {
    expect(badge("mcp", "MCP: 2 servers (2 connected)")).toMatchObject({
      glyph: "mcp",
      tone: "ok",
      detail: null,
    });
    expect(badge("mcp", "MCP: 3 servers (1 connected)")).toMatchObject({ tone: "busy", detail: "1/3" });
    expect(badge("mcp", "mcp 0/2")).toMatchObject({ tone: "off", detail: "0/2" });
    expect(badge("mcp", "MCP: connecting to github...")).toMatchObject({ tone: "busy", detail: null });
  });

  test("known statuses keep only the words worth reading", () => {
    expect(badge("plan-mode", "plan ready")).toMatchObject({ glyph: "plan", tone: "busy", detail: "ready" });
    expect(badge("pi-permission-system", "yolo")).toMatchObject({
      glyph: "unlocked",
      tone: "alarm",
      detail: "yolo",
    });
    expect(badge("subagents", "2 running agents")).toMatchObject({
      glyph: "agents",
      tone: "ok",
      detail: "2",
    });
  });

  test("auto mode off is an alarm", () => {
    expect(badge("pi-automode", "AM ○ a:3 d:1", "AM ● a:3 d:0")).toMatchObject({
      glyph: "guard",
      tone: "alarm",
      detail: null,
    });
  });

  test("auto mode shows the actions it denied this turn, while there are any", () => {
    expect(badge("pi-automode", "AM ● a:7 d:0", "AM ● a:0 d:0")).toMatchObject({
      glyph: "guard",
      tone: "ok",
      detail: null,
    });
    expect(badge("pi-automode", "AM ● a:7 d:2", "AM ● a:3 d:0")).toMatchObject({ tone: "busy", detail: "2" });
    expect(badge("pi-automode", "AM ● a:9 d:5 ca:7 cd:1", "AM ● a:7 d:4 ca:7 cd:1")).toMatchObject({
      tone: "busy",
      detail: "1",
    });
    expect(badge("pi-automode", "AM ● a:9 d:4 ca:7 cd:1", "AM ● a:7 d:4 ca:7 cd:1")).toMatchObject({
      tone: "ok",
      detail: null,
    });
  });

  test("auto mode counts every denial when it had no status as the turn began", () => {
    expect(badge("pi-automode", "AM ● a:7 d:2")).toMatchObject({ tone: "busy", detail: "2" });
  });

  test("auto mode reset during a turn counts from the reset", () => {
    expect(badge("pi-automode", "AM ● a:1 d:1", "AM ● a:40 d:6")).toMatchObject({
      tone: "busy",
      detail: "1",
    });
    expect(badge("pi-automode", "AM ● a:0 d:0", "AM ● a:40 d:6")).toMatchObject({ tone: "ok", detail: null });
  });

  test("auto mode without its counts reads its state words", () => {
    expect(badge("pi-automode", "auto mode starting")).toMatchObject({
      glyph: "guard",
      tone: "busy",
      detail: null,
    });
  });

  test("an unknown status keeps its text, coloured by its state words", () => {
    expect(badge("indexer", "indexing 42 files")).toMatchObject({
      glyph: "status",
      tone: "info",
      detail: "indexing 42 files",
    });
    expect(badge("sync", "sync failed")).toMatchObject({ tone: "alarm" });
  });
});

test("badges come in key order and skip empty and quiet statuses", () => {
  expect(
    badges({ rewind: "◆ 1 checkpoint", plan: "plan ready", mcp: "mcp 1/1", empty: " " }, {}).map(
      (entry) => entry.key,
    ),
  ).toEqual(["mcp", "plan"]);
});

test("badges read each status beside its own text as the turn began", () => {
  const read = badges(
    { "pi-automode": "AM ● a:9 d:5", mcp: "mcp 1/1" },
    { "pi-automode": "AM ● a:2 d:3", mcp: "mcp 0/1" },
  );
  expect(read.find((entry) => entry.key === "pi-automode")).toMatchObject({ tone: "busy", detail: "2" });
});
