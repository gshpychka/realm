import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { PickItem } from "../components/picker.tsx";
import { resolveAgentCommand } from "../config.ts";
import { tilde } from "../place.ts";
import { restartToApply } from "./carry-over.ts";
import type { CommandContext } from "./run-command.ts";

/** A trust decision the operator can save, as pi's own trust selector offers them. */
interface TrustOption {
  label: string;
  detail: string;
  trusted: boolean;
  /** What saving writes to the trust store; `null` removes a decision. */
  updates: { path: string; decision: boolean | null }[];
  /** The directory whose saved decision this option is. */
  savedPath: string;
}

/** The options pi's `/trust` offers for `cwd`, which the trust store keys by its real path. */
function trustOptions(cwd: string): TrustOption[] {
  const path = realpathSync(cwd);
  const parent = dirname(path);
  return [
    {
      label: "trust",
      detail: tilde(path),
      trusted: true,
      updates: [{ path, decision: true }],
      savedPath: path,
    },
    ...(parent === path
      ? []
      : [
          {
            label: "trust the parent folder",
            detail: tilde(parent),
            trusted: true,
            updates: [
              { path: parent, decision: true },
              { path, decision: null },
            ],
            savedPath: parent,
          },
        ]),
    {
      label: "do not trust",
      detail: tilde(path),
      trusted: false,
      updates: [{ path, decision: false }],
      savedPath: path,
    },
  ];
}

/**
 * Whether pi trusts the project's own files in `cwd`, as pi decides at start without asking:
 * the command line's `--approve` or `--no-approve`, then the saved decision, then pi's default.
 * An extension's `project_trust` handler can decide otherwise.
 */
export async function projectTrusted(cwd = process.cwd()): Promise<boolean> {
  const { ProjectTrustStore, SettingsManager, getAgentDir, hasTrustRequiringProjectResources } = await import(
    "@earendil-works/pi-coding-agent"
  );
  const { args } = resolveAgentCommand();
  if (args.some((arg) => arg === "--no-approve" || arg === "-na")) return false;
  if (args.some((arg) => arg === "--approve" || arg === "-a")) return true;
  if (!hasTrustRequiringProjectResources(cwd)) return true;
  const decision = new ProjectTrustStore(getAgentDir()).get(cwd);
  if (decision !== null) return decision;
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
  return settings.getDefaultProjectTrust() === "always";
}

/** Saves a trust decision for this project, then restarts pi, which reads trust only as it starts. */
export async function trust(context: CommandContext): Promise<void> {
  const { ProjectTrustStore, getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const cwd = process.cwd();
  const store = new ProjectTrustStore(getAgentDir());
  const saved = store.getEntry(cwd);
  const options = trustOptions(cwd);
  const isSaved = (option: TrustOption) =>
    saved?.decision === option.trusted && saved.path === option.savedPath;
  const trusted = await projectTrusted(cwd);
  const decision = saved
    ? `${saved.decision ? "trusted" : "untrusted"}${saved.path === options[0]?.savedPath ? "" : ` from ${tilde(saved.path)}`}`
    : "none";
  const items: PickItem[] = options.map((option, index) => ({
    label: option.label,
    detail: option.detail,
    value: String(index),
    current: isSaved(option),
  }));
  context.pick({
    title: `trust · this session ${trusted ? "trusted" : "untrusted"} · saved ${decision}`,
    items,
    onPick: (value) => {
      const option = options[Number(value)];
      if (!option) return;
      try {
        store.setMany(option.updates);
      } catch (cause) {
        context.session.notify("error", `/trust: ${cause instanceof Error ? cause.message : String(cause)}`);
        return;
      }
      restartToApply(context, `saved trust decision: ${option.trusted ? "trusted" : "untrusted"}`);
    },
  });
}
