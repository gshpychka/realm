import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghCommand, runGh } from "../github/gh.ts";
import type { CommandContext } from "./run-command.ts";

/** Milliseconds one call to gh may take before it counts as failed. */
const GH_TIMEOUT_MS = 60_000;

/** The page that renders a shared gist, as pi's `getShareViewerUrl` builds it. */
export function viewerUrl(gistId: string): string {
  return `${process.env.PI_SHARE_VIEWER_URL || "https://pi.dev/session/"}#${gistId}`;
}

/** The id at the end of the gist URL gh prints, or null when it prints none. */
export function gistId(stdout: string): string | null {
  const url = stdout.trim().split("\n").at(-1)?.trim() ?? "";
  const id = /^https?:\/\/\S+\/([0-9a-f]+)$/i.exec(url)?.[1];
  return id ?? null;
}

/**
 * Publishes the session as a secret GitHub gist of its HTML export, and tells the operator
 * the gist's URL and the viewer's.
 */
export async function shareSession({ link, session }: CommandContext): Promise<void> {
  const gh = ghCommand();
  if (!gh) throw new Error("the GitHub CLI is turned off; PITUITARY_GH is set empty");
  const missing = "the GitHub CLI (gh) is not installed; get it from https://cli.github.com/";
  // The export holds the whole conversation, so it lives where only the operator can read it.
  const scratch = mkdtempSync(join(tmpdir(), "pituitary-share-"));
  try {
    // pi exports only a saved session, so this comes before anything asks gh.
    const { path } = await link.call({ type: "export_html", outputPath: join(scratch, "session.html") });
    const auth = await runGh(gh, ["auth", "status"], { timeoutMs: GH_TIMEOUT_MS });
    if (auth.kind === "missing") throw new Error(missing);
    if (auth.kind === "late") throw new Error(`could not check the GitHub CLI's login: ${auth.reason}`);
    if (auth.code !== 0) throw new Error("the GitHub CLI is not signed in; run `gh auth login` first");
    session.notify("info", "creating a secret gist…");
    const created = await runGh(gh, ["gist", "create", "--public=false", path], { timeoutMs: GH_TIMEOUT_MS });
    if (created.kind === "missing") throw new Error(missing);
    if (created.kind === "late") throw new Error(`could not create the gist: ${created.reason}`);
    if (created.code !== 0) {
      throw new Error(
        `could not create the gist: ${created.stderr.trim() || `gh exited with ${created.code}`}`,
      );
    }
    const id = gistId(created.stdout);
    if (!id) throw new Error("gh created a gist but printed no URL for it");
    const gist = created.stdout.trim().split("\n").at(-1)?.trim() ?? "";
    session.notify("info", `shared the session\n${viewerUrl(id)}\ngist ${gist}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
