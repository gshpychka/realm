import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentManifest } from "./agent.ts";
import { loadModels } from "./models.ts";

const role: AgentManifest = {
  schemaVersion: 1,
  name: "builder",
  description: "Build",
  instructions: "Build",
  model: "anthropic/example",
  tools: ["read"],
  delegatesTo: [],
  credentials: ["primary"],
  limits: { maxChildren: 0, maxDepth: 0 },
};

test("host model credentials require declared role access and stay in runtime files", async () => {
  const root = mkdtempSync(join(tmpdir(), "pituitary-models-"));
  try {
    const profiles = join(root, "profiles.json"),
      key = join(root, "key");
    writeFileSync(key, "test-key-one\n");
    writeFileSync(profiles, JSON.stringify({ primary: { provider: "anthropic", file: key } }));
    const host = loadModels({ PITUITARY_CREDENTIAL_PROFILES: profiles, PITUITARY_MODEL: role.model! });
    expect(() => host.authorize(role)).not.toThrow();
    expect(() => host.authorize({ ...role, model: null })).not.toThrow();
    expect(() => host.authorize({ ...role, model: null, credentials: [] })).toThrow(
      "no declared credential profile",
    );
    expect(() => host.authorize({ ...role, credentials: [] })).toThrow("no declared credential profile");
    expect(() => host.authorize({ ...role, credentials: ["missing"] })).toThrow(
      "Undeclared credential profile",
    );
    expect(() =>
      loadModels({ ANTHROPIC_API_KEY: "ambient-key" }).authorize({ ...role, credentials: [] }),
    ).toThrow("no declared credential profile");
    expect(() => host.authorize({ ...role, model: "openai/example" })).toThrow(
      "no declared credential profile",
    );
    const model = host.models.getModels("anthropic")[0];
    if (!model) throw new Error("Missing upstream model catalog");
    expect((await host.models.getAuth(model))?.auth.apiKey).toBe("test-key-one");
    writeFileSync(key, "test-key-two\n");
    expect((await host.models.getAuth(model))?.auth.apiKey).toBe("test-key-two");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential declarations reject duplicate providers and canonical store paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "pituitary-models-"));
  try {
    const profiles = join(root, "profiles.json"),
      environment = { PITUITARY_CREDENTIAL_PROFILES: profiles };
    writeFileSync(
      profiles,
      JSON.stringify({
        first: { provider: "anthropic", file: "/runtime/one" },
        second: { provider: "anthropic", file: "/runtime/two" },
      }),
    );
    expect(() => loadModels(environment)).toThrow("one credential profile per provider");
    writeFileSync(profiles, JSON.stringify({ first: { provider: "anthropic", file: "/nix/store/key" } }));
    expect(() => loadModels(environment)).toThrow("Invalid runtime credential profile");
    writeFileSync(
      profiles,
      JSON.stringify({ first: { provider: "anthropic", file: "/tmp/../nix/store/key" } }),
    );
    expect(() => loadModels(environment)).toThrow("Invalid runtime credential profile");
    const linked = join(root, "linked-store");
    symlinkSync("/nix/store", linked);
    writeFileSync(profiles, JSON.stringify({ first: { provider: "anthropic", file: linked } }));
    const host = loadModels(environment);
    const model = host.models.getModels("anthropic")[0]!;
    await expect(host.models.getAuth(model)).rejects.toThrow("Invalid runtime credential profile");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
