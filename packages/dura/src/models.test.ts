import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
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

function fixture(provider = "anthropic") {
  const root = mkdtempSync(join(tmpdir(), "dura-models-"));
  const profiles = join(root, "profiles.json"),
    authFile = join(root, "auth.json");
  writeFileSync(profiles, JSON.stringify({ primary: { provider } }));
  return {
    root,
    profiles,
    authFile,
    environment: {
      DURA_AUTH_FILE: authFile,
      DURA_CREDENTIAL_PROFILES: profiles,
      DURA_MODEL: role.model!,
    },
  };
}

test("Pi login changes reach the running host without granting undeclared role access", async () => {
  const f = fixture();
  try {
    const pi = await ModelRuntime.create({ authPath: f.authFile, modelsPath: null, refreshOnCreate: false });
    const host = await loadModels(f.environment);
    const login = (key: string) =>
      pi.login("anthropic", "api_key", {
        async prompt() {
          return key;
        },
        notify() {},
      });
    await login("test-key-one");
    expect((await host.models.getAuth("anthropic"))?.auth.apiKey).toBe("test-key-one");
    await login("test-key-two");
    expect((await host.models.getAuth("anthropic"))?.auth.apiKey).toBe("test-key-two");
    expect(() => host.authorize(role)).not.toThrow();
    expect(() => host.authorize({ ...role, model: null })).not.toThrow();
    expect(() => host.authorize({ ...role, credentials: [] })).toThrow("no declared credential profile");
    expect(() => host.authorize({ ...role, credentials: ["missing"] })).toThrow(
      "Undeclared credential profile",
    );
    expect(() => host.authorize({ ...role, model: "openai/example" })).toThrow(
      "no declared credential profile",
    );
    const ungranted = await loadModels({ ...f.environment, DURA_CREDENTIAL_PROFILES: undefined });
    expect(() => ungranted.authorize(role)).toThrow("Undeclared credential profile");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("subscription tokens refresh once through the shared native Pi auth store", async () => {
  const f = fixture("openai-codex");
  try {
    const expired: OAuthCredential = {
      type: "oauth",
      access: "expired-access",
      refresh: "initial-refresh",
      expires: Date.now() - 1000,
    };
    writeFileSync(f.authFile, JSON.stringify({ "openai-codex": expired }));
    const first = await loadModels(f.environment),
      second = await loadModels(f.environment);
    let refreshes = 0;
    for (const host of [first, second]) {
      if (!(host.models instanceof ModelRuntime)) throw new Error("Dura must use Pi's native runtime");
      const provider = host.models.getProvider("openai-codex");
      if (!provider?.auth.oauth) throw new Error("Missing upstream subscription provider");
      host.models.registerNativeProvider({
        ...provider,
        auth: {
          ...provider.auth,
          oauth: {
            ...provider.auth.oauth,
            async refresh(credential) {
              refreshes++;
              expect(credential.refresh).toBe("initial-refresh");
              await new Promise((resolve) => setTimeout(resolve, 20));
              return {
                type: "oauth",
                access: "renewed-access",
                refresh: "rotated-refresh",
                expires: Date.now() + 60 * 60 * 1000,
              };
            },
          },
        },
      });
    }
    const subscriptionRole = { ...role, model: "openai-codex/example" };
    expect(() => first.authorize(subscriptionRole)).not.toThrow();
    const auth = await Promise.all([
      first.models.getAuth("openai-codex"),
      second.models.getAuth("openai-codex"),
    ]);
    expect(auth.map((result) => result?.auth.apiKey)).toEqual(["renewed-access", "renewed-access"]);
    expect(refreshes).toBe(1);
    expect(readStoredCredential("openai-codex", f.authFile)).toMatchObject({
      type: "oauth",
      access: "renewed-access",
      refresh: "rotated-refresh",
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("provider grants reject duplicate providers and credentials never come from the Nix store", async () => {
  const f = fixture();
  try {
    writeFileSync(
      f.profiles,
      JSON.stringify({ first: { provider: "anthropic" }, second: { provider: "anthropic" } }),
    );
    await expect(loadModels(f.environment)).rejects.toThrow("one credential profile per provider");
    writeFileSync(f.profiles, JSON.stringify({ primary: { provider: "anthropic" } }));
    await expect(loadModels({ ...f.environment, DURA_AUTH_FILE: "/nix/store/auth.json" })).rejects.toThrow(
      "outside the Nix store",
    );
    await expect(
      loadModels({ ...f.environment, DURA_AUTH_FILE: "/tmp/../nix/store/auth.json" }),
    ).rejects.toThrow("outside the Nix store");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
