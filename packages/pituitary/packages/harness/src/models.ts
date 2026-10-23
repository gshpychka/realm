import { readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CreateModelsOptions, Models } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { AgentManifest } from "./agent.ts";

interface Profile {
  provider: string;
  file: string;
}
export interface HostModels {
  models: Models;
  authorize(manifest: AgentManifest): void;
}

/** Provider credentials belong to the host. Guests receive neither keys nor model access. */
export function loadModels(environment: NodeJS.ProcessEnv = process.env): HostModels {
  const profiles: Record<string, Profile> = Object.create(null);
  const providers = new Map<string, string>();
  if (environment.PITUITARY_CREDENTIAL_PROFILES) {
    const source: unknown = JSON.parse(readFileSync(environment.PITUITARY_CREDENTIAL_PROFILES, "utf8"));
    if (!source || typeof source !== "object" || Array.isArray(source))
      throw new Error("Credential profiles must be a named object");
    for (const [name, entry] of Object.entries(source)) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) ||
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry)
      )
        throw new Error("Invalid credential profile");
      const profile = entry as Record<string, unknown>;
      if (
        Object.keys(profile).some((key) => !["provider", "file"].includes(key)) ||
        typeof profile.provider !== "string" ||
        !/^[a-zA-Z0-9_.-]+$/.test(profile.provider) ||
        typeof profile.file !== "string" ||
        !profile.file.startsWith("/") ||
        profile.file.startsWith("/nix/store/")
      )
        throw new Error(`Invalid runtime credential profile ${name}`);
      if (providers.has(profile.provider))
        throw new Error(`Declare one credential profile per provider: ${profile.provider}`);
      profiles[name] = { provider: profile.provider, file: profile.file };
      providers.set(profile.provider, name);
    }
  }
  type Store = NonNullable<CreateModelsOptions["credentials"]>;
  const credentials: Store = {
    async read(provider) {
      const name = providers.get(provider),
        profile = name ? profiles[name] : undefined;
      if (!profile) return undefined;
      const key = (await readFile(profile.file, "utf8")).trim();
      if (!key || Buffer.byteLength(key) > 64 * 1024)
        throw new Error(`Empty or oversized credential profile ${name}`);
      return { type: "api_key", key };
    },
    async list() {
      return [...providers.keys()].map((providerId) => ({ providerId, type: "api_key" as const }));
    },
    async modify() {
      throw new Error("Credential profiles are declared runtime files");
    },
    async delete() {
      throw new Error("Credential profiles are declared runtime files");
    },
  };
  const models = builtinModels({
    credentials,
    authContext: {
      async env(name) {
        return environment[name];
      },
      async fileExists(path) {
        try {
          await access(path.startsWith("~/") ? join(environment.HOME ?? homedir(), path.slice(2)) : path);
          return true;
        } catch {
          return false;
        }
      },
    },
    identity: { attribution: { name: "Pituitary", url: "https://github.com/gshpychka/realm" } },
  });
  return {
    models,
    authorize(manifest) {
      for (const name of manifest.credentials)
        if (!profiles[name]) throw new Error(`Undeclared credential profile ${name}`);
      const provider = manifest.model?.split("/")[0];
      const name = provider ? providers.get(provider) : undefined;
      if (!name || !manifest.credentials.includes(name))
        throw new Error(`Agent ${manifest.name} has no declared credential profile for ${provider}`);
    },
  };
}
