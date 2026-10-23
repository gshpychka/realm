import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Models } from "@earendil-works/pi-ai/models";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentManifest } from "./agent.ts";

interface Profile {
  provider: string;
}
export interface HostModels {
  models: Models;
  authorize(manifest: AgentManifest): void;
}

/** Roles grant provider access; Pi owns the shared auth file, OAuth refresh, and its locks. */
export async function loadModels(environment: NodeJS.ProcessEnv = process.env): Promise<HostModels> {
  const profiles: Record<string, Profile> = Object.create(null);
  const providers = new Map<string, string>();
  if (environment.DURA_CREDENTIAL_PROFILES) {
    const source: unknown = JSON.parse(readFileSync(environment.DURA_CREDENTIAL_PROFILES, "utf8"));
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
        Object.keys(profile).some((key) => key !== "provider") ||
        typeof profile.provider !== "string" ||
        !/^[a-zA-Z0-9_.-]+$/.test(profile.provider)
      )
        throw new Error(`Invalid credential profile ${name}`);
      if (providers.has(profile.provider))
        throw new Error(`Declare one credential profile per provider: ${profile.provider}`);
      profiles[name] = { provider: profile.provider };
      providers.set(profile.provider, name);
    }
  }
  const authPath = resolve(environment.DURA_AUTH_FILE ?? join(getAgentDir(), "auth.json"));
  if (authPath === "/nix/store" || authPath.startsWith("/nix/store/"))
    throw new Error("Dura authFile must be a private runtime path outside the Nix store");
  const models = await ModelRuntime.create({ authPath, modelsPath: null, refreshOnCreate: false });
  return {
    models,
    authorize(manifest) {
      for (const name of manifest.credentials)
        if (!profiles[name]) throw new Error(`Undeclared credential profile ${name}`);
      const provider = (manifest.model ?? environment.DURA_MODEL)?.split("/")[0];
      const name = provider ? providers.get(provider) : undefined;
      if (!name || !manifest.credentials.includes(name))
        throw new Error(`Agent ${manifest.name} has no declared credential profile for ${provider}`);
    },
  };
}
