import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  mkdirSync(join(cwd, ".github"));
  mkdirSync(join(cwd, ".git"));
  writeFileSync(join(cwd, ".github", "workflow.yml"), "hidden hit\n");
  writeFileSync(join(cwd, ".git", "secret"), "hidden hit\n");
  writeFileSync(join(cwd, "one.ts"), "limit hit\n");
  writeFileSync(join(cwd, "two.ts"), "limit hit\n");
  writeFileSync(join(cwd, "include:rust"), "glob hit\n");
  writeFileSync(join(cwd, "unrelated.rs"), "glob hit\n");
  mkdirSync(join(cwd, ".github", "nested"));
  writeFileSync(join(cwd, ".github", "nested", "inside.ts"), "nested hit\n");
  const configuration = join(cwd, "rg-config");
  writeFileSync(configuration, "--follow\n--files-with-matches\n");
  symlinkSync(join(cwd, ".github"), join(cwd, "linked"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(codingExtension);
  const environment = new NodeExecutionEnv({
    cwd,
    shellEnv: { ...process.env, RIPGREP_CONFIG_PATH: configuration },
  });
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
    expect(JSON.stringify(find)).not.toContain("linked/");
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
    const invoke = async (name: string, args: Parameters<typeof fauxToolCall>[1]) => {
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
        fauxAssistantMessage("Done."),
      ]);
      await (await conversation.submit({ type: "input", content: "Search again" }, context)).wait(context);
      return (await conversation.context(context)).messages.findLast(
        (message) => message.role === "toolResult",
      )!;
    };
    const hidden = await invoke("grep", { pattern: "hidden hit" });
    expect(JSON.stringify(hidden)).toContain(".github/workflow.yml:1:hidden hit");
    expect(JSON.stringify(hidden)).not.toContain(".git/secret");
    const single = await invoke("grep", { pattern: "limit hit", path: "one.ts" });
    expect(JSON.stringify(single)).toContain("one.ts:1:limit hit");
    const fileFind = await invoke("find", { pattern: "*.ts", path: ".ignore" });
    expect(JSON.stringify(fileFind)).toContain("find root must be a directory");
    const fileGlob = await invoke("grep", { pattern: "limit hit", path: "one.ts", glob: "*.rs" });
    expect(JSON.stringify(fileGlob)).toContain("file glob requires a directory path");
    const limited = await invoke("grep", { pattern: "limit hit", limit: 1 });
    const limitedText = limited.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    expect(limitedText.trim().split("\n")).toHaveLength(1);
    expect(limitedText).toContain("limit hit");
    const foundGlob = await invoke("find", { pattern: "include:rust" });
    expect(foundGlob.role === "toolResult" && foundGlob.isError).toBe(true);
    expect(JSON.stringify(foundGlob)).not.toContain("unrelated.rs");
    const grepGlob = await invoke("grep", { pattern: "glob hit", glob: "include:rust" });
    expect(grepGlob.role === "toolResult" && grepGlob.isError).toBe(true);
    expect(JSON.stringify(grepGlob)).not.toContain("unrelated.rs");
    const linked = await invoke("find", { pattern: "*", path: "linked" });
    expect(JSON.stringify(linked)).toContain("find root must be a directory");
    const explicit = await invoke("find", { pattern: "*.ts", path: "linked/nested" });
    expect(JSON.stringify(explicit)).toContain("inside.ts");
  } finally {
    await harness.close(context);
    await environment.cleanup(context);
    rmSync(cwd, { recursive: true, force: true });
  }
});
