import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertBaySession, Bay, BayError, type BaySession } from "./bay.ts";
import type { AgentDefinition } from "./catalog.ts";

const agent: AgentDefinition = {
  manifest: {
    schemaVersion: 1,
    name: "builder",
    description: "Build a change",
    instructions: "Make the requested change.",
    model: null,
    tools: ["read", "bash"],
    delegatesTo: [],
    credentials: [],
  },
  program: "pituitary-builder",
  machine: "pituitary-builder",
  machineRevision: "revision-1",
};

const session: BaySession = {
  id: "record-id",
  generation: 3,
  name: "run-name",
  state: "running",
  program: agent.program,
  machine: agent.machine,
  machineRevision: agent.machineRevision,
};

test("Bay identity pins the record, generation, program, machine and image revision", () => {
  const expected = { name: session.name, id: session.id, generation: session.generation, agent };
  expect(() => assertBaySession(session, expected)).not.toThrow();
  for (const field of ["id", "name", "program", "machine", "machineRevision"] as const)
    expect(() => assertBaySession({ ...session, [field]: "replaced" }, expected)).toThrow(
      "identity or machine changed",
    );
  expect(() => assertBaySession({ ...session, generation: session.generation + 1 }, expected)).toThrow(
    "identity or machine changed",
  );
  expect(() => assertBaySession({ ...session, id: "" }, { name: session.name, agent })).toThrow(
    "identity or machine changed",
  );
});

test("Bay lifecycle uses structured JSON and requires a record identity when suspending", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-bay-api-"));
  const calls: Array<{ method?: string; path?: string; body?: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    calls.push({
      method: request.method,
      path: request.url,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
    });
    response.setHeader("Content-Type", "application/json");
    if (request.url?.includes("missing")) {
      response.writeHead(404).end(JSON.stringify({ error: "No such session" }));
    } else if (request.url?.includes("capacity")) {
      response
        .writeHead(409)
        .end(JSON.stringify({ error: "No free machine admission", code: "capacity_exhausted" }));
    } else if (request.url?.includes("rejected")) {
      response
        .writeHead(409)
        .end(JSON.stringify({ error: "The frozen machine revision changed", code: "launch_rejected" }));
    } else {
      response.end(JSON.stringify(session));
    }
  });
  const socket = join(root, "bay.sock");
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const bay = new Bay(socket);
    expect(await bay.start("run/name", agent, ["owner/repo@pinned-ref"])).toEqual(session);
    expect(await bay.get("run/name")).toEqual(session);
    await bay.suspend("run/name", session.id, session.generation);
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v1/sessions/run%2Fname/start",
        body: {
          program: agent.program,
          machineRevision: agent.machineRevision,
          repos: ["owner/repo@pinned-ref"],
        },
      },
      { method: "GET", path: "/v1/sessions/run%2Fname", body: undefined },
      {
        method: "POST",
        path: "/v1/sessions/run%2Fname/suspend",
        body: { id: session.id, generation: session.generation },
      },
    ]);
    const missing = await bay.get("missing").catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(BayError);
    expect(missing).toMatchObject({ status: 404, message: "No such session" });
    const capacity = await bay.start("capacity", agent, []).catch((error: unknown) => error);
    expect(capacity).toBeInstanceOf(BayError);
    expect(capacity).toMatchObject({
      status: 409,
      code: "capacity_exhausted",
      message: "No free machine admission",
    });
    const rejected = await bay.start("rejected", agent, []).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(BayError);
    expect(rejected).toMatchObject({
      status: 409,
      code: "launch_rejected",
      message: "The frozen machine revision changed",
    });
    expect((missing as BayError).code).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
