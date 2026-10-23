import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { codingExtension, codingTools } from "./coding.ts";

test("declared search tools use the environment, respect ignores and treat patterns as data", async () => {
  const cwd = mkdtempSync("/tmp/pituitary-coding-");
  writeFileSync(join(cwd, "visible.ts"), "const value = 42;\n; touch SENTINEL\n");
  writeFileSync(join(cwd, "ignored.ts"), "not part of the search\n");
  writeFileSync(join(cwd, ".ignore"), "ignored.ts\n");
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(codingExtension);
  const environment = new NodeExecutionEnv({ cwd });
  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, env: () => environment },
    context,
  );
  try {
    const conversation = await harness.root(context, {
      agent: {
        model: { provider: "faux", modelId: "faux-1" },
        cwd,
        tools: codingTools.filter((tool) => ["grep", "find", "ls"].includes(tool.name)),
      },
    });
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("grep", { pattern: "; touch SENTINEL", literal: true }),
          fauxToolCall("find", { pattern: "*.ts" }),
          fauxToolCall("ls", {}),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Search complete."),
    ]);
    await (await conversation.submit({ type: "input", content: "Inspect the workspace" }, context)).wait(
      context,
    );
    const view = await conversation.context(context);
    const results = view.messages.filter((message) => message.role === "toolResult");
    expect(results).toHaveLength(3);
    const grep = results.find((message) => message.role === "toolResult" && message.toolName === "grep");
    expect(JSON.stringify(grep)).toContain("visible.ts:2:; touch SENTINEL");
    const find = results.find((message) => message.role === "toolResult" && message.toolName === "find");
    expect(JSON.stringify(find)).toContain("visible.ts");
    expect(JSON.stringify(find)).not.toContain("ignored.ts");
    expect(existsSync(join(cwd, "SENTINEL"))).toBe(false);
    expect(codingTools.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "ls",
      "read",
      "write",
    ]);
  } finally {
    await harness.close(context);
    await environment.cleanup(context);
    rmSync(cwd, { recursive: true, force: true });
  }
});
