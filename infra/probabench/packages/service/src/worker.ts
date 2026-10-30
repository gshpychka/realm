import { CheckpointRequest, HISTORY_ROUTES } from "@probabench/domain";
import * as Schema from "effect/Schema";
import type { Database } from "./database";

export interface Env {
  readonly DB: Database;
  readonly HISTORY_WRITE_TOKEN: string;
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
}

const PAGE_SIZE = 128;
const MAX_BODY = 1_048_576;
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });

class BadRequest extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new BadRequest(415, "Expected application/json.");
  const reader = request.body?.getReader();
  if (!reader) throw new BadRequest(400, "Missing request body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        throw new BadRequest(413, "Checkpoint batch is too large.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new BadRequest(400, "Invalid JSON.");
  }
}

// Compare fixed-length digests to keep token comparison time independent of the prefix.
async function authorized(request: Request, secret: string): Promise<boolean> {
  if (secret.length < 32) return false;
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [actual, expected] = await Promise.all([
    digest(request.headers.get("authorization") ?? ""),
    digest(`Bearer ${secret}`),
  ]);
  const a = new Uint8Array(actual);
  const b = new Uint8Array(expected);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === HISTORY_ROUTES.results) {
    if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
    const after = Number(url.searchParams.get("after") ?? "0");
    if (!Number.isSafeInteger(after) || after < 0)
      return json({ error: "Invalid history cursor." }, 400);
    const { results } = await env.DB.prepare(
      "SELECT seq, payload FROM checkpoints WHERE seq > ? ORDER BY seq LIMIT ?",
    )
      .bind(after, PAGE_SIZE)
      .all<{ seq: number; payload: string }>();
    return json({
      runs: results.map((row) => JSON.parse(row.payload)),
      cursor: results.at(-1)?.seq ?? after,
      next: results.length === PAGE_SIZE ? results.at(-1)?.seq : null,
    });
  }
  if (url.pathname !== HISTORY_ROUTES.checkpoints) {
    if (url.pathname.startsWith("/api/")) return json({ error: "Not found." }, 404);
    return env.ASSETS.fetch(request);
  }
  if (!(await authorized(request, env.HISTORY_WRITE_TOKEN)))
    return json({ error: "Unauthorized." }, 401);
  if (request.method === "HEAD")
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const input = await body(request);
  let batch: typeof CheckpointRequest.Type;
  try {
    batch = Schema.decodeUnknownSync(CheckpointRequest, { onExcessProperty: "error" })(input);
  } catch {
    return json({ error: "Invalid checkpoints." }, 400);
  }
  // A reused ID with different data violates NOT NULL and rolls back the batch.
  const inserts = batch.runs.map((run) =>
    env.DB.prepare(`
    INSERT INTO checkpoints(id, payload) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = CASE
      WHEN checkpoints.payload = excluded.payload THEN checkpoints.payload ELSE NULL END
  `).bind(run.id, JSON.stringify(run)),
  );
  try {
    await env.DB.batch(inserts);
  } catch (error) {
    if (error instanceof Error && error.message.includes("NOT NULL constraint failed"))
      return json({ error: "Checkpoint ID conflicts with stored data." }, 409);
    throw error;
  }
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      if (error instanceof BadRequest) return json({ error: error.message }, error.status);
      console.error("History request failed", error);
      return json({ error: "History storage unavailable." }, 503);
    }
  },
};
