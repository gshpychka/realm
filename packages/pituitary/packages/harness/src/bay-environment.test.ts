import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { BayExecutionEnv } from "./bay-environment.ts";
import type { BayExecution } from "./model.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bay-environment-")),
    socket = join(root, "bay.sock");
  const files = new Map<string, Buffer>(),
    handles = new Map<number, { path: string; bytes: Buffer }>();
  let next = 0,
    connections = 0,
    closed = 0;
  const received: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    connections++;
    expect(request.url).toBe("/v1/sessions/one/environment");
    expect(request.headers["bay-session-id"]).toBe("record");
    expect(request.headers["bay-session-generation"]).toBe("2");
    expect(request.headers["bay-machine-revision"]).toBe("revision");
    for (const key of ["Bay-Session-ID", "Bay-Session-Generation", "Bay-Machine-Revision"])
      response.setHeader(key, request.headers[key.toLowerCase()]!);
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.flushHeaders();
    const commands = new Map<number, NodeJS.Timeout>();
    let pending = "";
    const send = (id: number, value?: unknown, error?: unknown) =>
      response.write(JSON.stringify({ id, value, error }) + "\n");
    request.on("data", (chunk: Buffer) => {
      pending += chunk.toString();
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const r = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        received.push(r);
        switch (r.op) {
          case "mkdir":
            send(r.id);
            break;
          case "openWrite": {
            const bytes = r.append ? (files.get(r.path) ?? Buffer.alloc(0)) : Buffer.alloc(0);
            files.set(r.path, bytes);
            handles.set(++next, { path: r.path, bytes });
            send(r.id, next);
            break;
          }
          case "writeChunk": {
            const h = handles.get(r.handle)!;
            h.bytes = Buffer.concat([h.bytes, Buffer.from(r.data, "base64")]);
            files.set(h.path, h.bytes);
            send(r.id);
            break;
          }
          case "open": {
            const bytes = files.get(r.path);
            if (!bytes) {
              send(r.id, undefined, { code: "not_found", message: "missing" });
              break;
            }
            handles.set(++next, { path: r.path, bytes });
            send(r.id, next);
            break;
          }
          case "read": {
            const h = handles.get(r.handle)!;
            send(r.id, h.bytes.subarray(r.offset, r.offset + r.length).toString("base64"));
            break;
          }
          case "handleInfo": {
            const h = handles.get(r.handle)!;
            send(r.id, {
              path: h.path,
              name: h.path.split("/").pop(),
              kind: "file",
              size: h.bytes.length,
              mtimeMs: 1,
            });
            break;
          }
          case "close":
            handles.delete(r.handle);
            send(r.id);
            break;
          case "rename":
            files.set(r.to, files.get(r.path)!);
            files.delete(r.path);
            send(r.id);
            break;
          case "exists":
            send(r.id, files.has(r.path));
            break;
          case "exec":
            if (r.command === "wait") {
              commands.set(
                r.id,
                setTimeout(() => send(r.id, { exitCode: 0 }), 30_000),
              );
              break;
            }
            for (const [stream, bytes] of [
              ["stdout", Buffer.from([0xe2])],
              ["stdout", Buffer.from([0x82, 0xac])],
              ["stderr", Buffer.from("warning")],
            ] as const)
              response.write(JSON.stringify({ id: r.id, stream, data: bytes.toString("base64") }) + "\n");
            send(r.id, { exitCode: 7, spillPath: "/tmp/full-output" });
            break;
          case "cancel": {
            const timer = commands.get(r.handle);
            if (timer) {
              clearTimeout(timer);
              commands.delete(r.handle);
              send(r.handle, { exitCode: -1 }, { code: "aborted", message: "cancelled" });
            }
            break;
          }
          default:
            throw new Error(`Unexpected environment operation ${r.op}`);
        }
      }
    });
    request.once("end", () => {
      for (const timer of commands.values()) clearTimeout(timer);
      response.end();
    });
    request.once("aborted", () => {
      for (const timer of commands.values()) clearTimeout(timer);
      response.destroy();
    });
    request.once("close", () => {
      closed++;
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  const execution: BayExecution = {
    kind: "bay",
    socket,
    sessionName: "one",
    recordId: "record",
    generation: 2,
    repos: [],
    agent: {
      program: "builder",
      machine: "builder",
      machineRevision: "revision",
      manifest: {
        schemaVersion: 1,
        name: "builder",
        description: "",
        instructions: "",
        model: null,
        tools: ["read", "bash"],
        delegatesTo: [],
        credentials: [],
        limits: { maxChildren: 0, maxDepth: 0 },
      },
    },
  };
  const env = new BayExecutionEnv(execution, "workspace");
  return {
    env,
    files,
    handles,
    received,
    connections: () => connections,
    closed: () => closed,
    close: async () => {
      await env.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Bay environment opens lazily and preserves opened inode identity across rename", async () => {
  const f = await fixture();
  try {
    expect(f.connections()).toBe(0);
    expect(await f.env.absolutePath("notes", BACKGROUND_CONTEXT)).toEqual({
      ok: true,
      value: "/work/workspace/notes",
    });
    expect(f.connections()).toBe(0);
    expect((await f.env.writeFile("notes", "α\nβ\n", BACKGROUND_CONTEXT)).ok).toBe(true);
    const opened = await f.env.openBinaryReader("notes", undefined, BACKGROUND_CONTEXT);
    if (!opened.ok) throw opened.error;
    await f.env.renameFile("notes", "moved", BACKGROUND_CONTEXT);
    await f.env.writeFile("notes", "replacement", BACKGROUND_CONTEXT);
    const read = await opened.value.read(0, 64, BACKGROUND_CONTEXT);
    if (!read.ok) throw read.error;
    expect(new TextDecoder().decode(read.value)).toBe("α\nβ\n");
    const scan = await opened.value.scanLines({ startLine: 1, endLine: 2 }, BACKGROUND_CONTEXT);
    if (!scan.ok) throw scan.error;
    expect(scan.value).toMatchObject({ newlines: 2, selectedBytes: 2, firstLineBytes: 2 });
    await opened.value.close(BACKGROUND_CONTEXT);
    expect(f.handles.size).toBe(0);
    expect(f.connections()).toBe(1);
    expect(await f.env.readTextFile("missing", BACKGROUND_CONTEXT)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  } finally {
    await f.close();
  }
});

test("Bay text reader retains LF termination and streams split UTF-8 without losing output order", async () => {
  const f = await fixture();
  try {
    await f.env.writeFile("lines", "a\r\nb", BACKGROUND_CONTEXT);
    const opened = await f.env.openTextLineReader("lines", BACKGROUND_CONTEXT);
    if (!opened.ok) throw opened.error;
    expect(await opened.value.readLine(BACKGROUND_CONTEXT)).toEqual({
      ok: true,
      value: { text: "a\r", terminated: true },
    });
    expect(await opened.value.readLine(BACKGROUND_CONTEXT)).toEqual({
      ok: true,
      value: { text: "b", terminated: false },
    });
    expect(await opened.value.readLine(BACKGROUND_CONTEXT)).toEqual({ ok: true, value: undefined });
    await opened.value.close(BACKGROUND_CONTEXT);
    const chunks: Array<[string, string]> = [];
    const result = await f.env.exec(
      ["command", "a path"],
      {
        onOutput: (text, _ctx, info) => chunks.push([info.stream, text]),
        spill: { afterBytes: 4, afterLines: 100 },
        timeout: 0.25,
      },
      BACKGROUND_CONTEXT,
    );
    expect(chunks).toEqual([
      ["stdout", "€"],
      ["stderr", "warning"],
    ]);
    expect(result).toEqual({ ok: true, value: { exitCode: 7, spillPath: "/tmp/full-output" } });
    expect(f.received.find((r) => r.op === "exec")?.command).toEqual(["command", "a path"]);
    expect(f.received.find((r) => r.op === "exec")?.timeoutMs).toBe(250);
  } finally {
    await f.close();
  }
});

test("Bay shell cancellation addresses one command and leaves its environment usable", async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    const waiting = f.env.exec("wait", undefined, withAbortSignal(abort.signal, BACKGROUND_CONTEXT));
    while (!f.received.some((r) => r.op === "exec")) await new Promise((resolve) => setTimeout(resolve, 1));
    abort.abort();
    expect(await waiting).toMatchObject({ ok: false, error: { code: "aborted" } });
    expect(f.received.filter((r) => r.op === "cancel")).toHaveLength(1);
    expect(await f.env.exists("untouched", BACKGROUND_CONTEXT)).toEqual({ ok: true, value: false });
    await f.env.close();
    expect(await f.env.exists("untouched", BACKGROUND_CONTEXT)).toMatchObject({ ok: false });
  } finally {
    await f.close();
  }
});
