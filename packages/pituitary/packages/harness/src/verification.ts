import { createHash } from "node:crypto";
import { assertBaySession, Bay, BayError } from "./bay.ts";
import { baySessionName } from "./identity.ts";
import type { Artifact, BayExecution, Run, Verification, VerificationCheckResult } from "./model.ts";
import { bayIdentity, type Workspaces, waitJob } from "./workspaces.ts";

const key = (id: string): string => createHash("sha256").update(id).digest("hex");

export interface VerificationCheckpoint {
  dispatched?: boolean;
  execution?: NonNullable<Verification["execution"]>;
  result?: {
    checks: VerificationCheckResult[];
    verificationExecution: NonNullable<Verification["execution"]>;
  };
}
export interface VerificationJournal {
  load(): Promise<VerificationCheckpoint>;
  save(checkpoint: VerificationCheckpoint): Promise<void>;
}

/** A verifier has no model, credentials, or tool authority: only frozen named commands. */
export class Verifier {
  constructor(
    private readonly workspaces: Workspaces,
    private readonly namespace: string,
  ) {}

  async run(
    run: Run,
    verification: Verification,
    artifact: Artifact,
    journal: VerificationJournal,
    alive: () => boolean | Promise<boolean>,
    closing: () => boolean = () => false,
    signal?: AbortSignal,
  ): Promise<{
    checks: VerificationCheckResult[];
    verificationExecution: NonNullable<Verification["execution"]>;
  }> {
    if (!run.catalog) throw new Error("Verification requires a declared agent catalog");
    const sessionName = baySessionName(this.namespace, "verify", verification.id);
    const bay = new Bay(run.catalog.baySocket, signal);
    let checkpoint = await journal.load();
    const retained = checkpoint.result;
    if (retained) {
      const result = retained;
      let session: Awaited<ReturnType<Bay["get"]>>;
      try {
        session = await bay.get(result.verificationExecution.sessionName);
      } catch (error) {
        if (error instanceof BayError && error.status === 404) return result;
        throw error;
      }
      // The committed evidence survives removal or later reuse of its verifier. Cleanup
      // may touch only the exact execution that produced that evidence.
      if (
        session.id !== result.verificationExecution.recordId ||
        session.generation !== result.verificationExecution.generation
      )
        return result;
      assertBaySession(session, {
        name: result.verificationExecution.sessionName,
        agent: verification.agent,
        id: result.verificationExecution.recordId,
        generation: result.verificationExecution.generation,
      });
      if (session.state === "running") await bay.suspend(session.name, session.id, session.generation);
      return result;
    }
    let session: Awaited<ReturnType<Bay["get"]>>;
    if (checkpoint.dispatched) {
      try {
        session = await bay.get(sessionName);
      } catch (error) {
        if (error instanceof BayError && error.status === 404)
          throw new Error("Verification launch outcome is unknown; its create command will not be repeated");
        throw error;
      }
    } else {
      if (!(await alive())) throw new Error("Verification is no longer current");
      checkpoint = { ...checkpoint, dispatched: true };
      await journal.save(checkpoint);
      try {
        session = await bay.start(sessionName, verification.agent, []);
      } catch (error) {
        // A definite capacity rejection creates nothing; every other transport result is uncertain.
        if (error instanceof BayError && error.code === "capacity_exhausted" && !closing()) {
          checkpoint = { ...checkpoint, dispatched: false };
          await journal.save(checkpoint);
        }
        throw error;
      }
    }
    if (closing())
      throw new Error("Runtime detached from verification; its machine and durable jobs remain alive");
    const previous = checkpoint.execution;
    assertBaySession(session, {
      name: sessionName,
      agent: verification.agent,
      id: previous?.recordId,
      generation: previous?.generation ?? 1,
    });
    const identity = { sessionName, recordId: session.id, generation: session.generation };
    checkpoint = { ...checkpoint, execution: identity };
    await journal.save(checkpoint);
    if (session.state !== "running")
      throw new Error(`Verification machine is ${session.state}; saved receipts require explicit recovery`);
    const execution: BayExecution = {
      kind: "bay",
      socket: run.catalog.baySocket,
      sessionName,
      recordId: session.id,
      generation: session.generation,
      agent: verification.agent,
      repos: [],
    };
    const checks: VerificationCheckResult[] = [];
    try {
      if (!(await alive())) throw new Error("Verification was superseded before materialization");
      await this.workspaces.materialize(run, execution, artifact, `${verification.id}:input`, alive, signal);
      const sourceTree = (phase: string, name: string) =>
        waitJob(
          bay,
          bayIdentity(execution),
          key(`${verification.id}:tree:${phase}:${name}`),
          {
            argv: [
              "/bin/sh",
              "-c",
              "set -eu; test -d .git && test ! -L .git; git -c core.hooksPath=/dev/null -c core.fsmonitor=false add -A -- .; git write-tree",
            ],
            cwd: "workspace",
            timeoutMs: 60_000,
            maxOutputBytes: 64 * 1024,
            machineRevision: verification.agent.machineRevision,
            inputDigest: artifact.content,
          },
          alive,
        );
      for (const [name, check] of Object.entries(verification.policy.checks)) {
        if (!(await alive()))
          throw new Error("Verification was superseded; evidence cannot accept this task");
        const before = await sourceTree("before", name);
        if (
          before.status !== "succeeded" ||
          before.exitCode !== 0 ||
          before.stdout.trim() !== artifact.tree
        ) {
          checks.push({
            name,
            status: "failed",
            exitCode: null,
            output: "Verification input changed before its check; no command was run.",
          });
          break;
        }
        const result = await waitJob(
          bay,
          bayIdentity(execution),
          key(`${verification.id}:check:${name}`),
          {
            argv: check.command,
            cwd: "workspace",
            timeoutMs: check.timeoutMs,
            maxOutputBytes: 256 * 1024,
            machineRevision: verification.agent.machineRevision,
            inputDigest: artifact.content,
          },
          alive,
        );
        let status: VerificationCheckResult["status"] =
          result.status === "timed_out"
            ? "timed_out"
            : result.status === "succeeded" && result.exitCode === 0
              ? "passed"
              : "failed";
        let output = [result.stdout, result.stderr, result.error].filter(Boolean).join("\n");
        // Commands may create ignored build products. Changes to source invalidate their evidence.
        const snapshot = await sourceTree("after", name);
        if (
          snapshot.status !== "succeeded" ||
          snapshot.exitCode !== 0 ||
          snapshot.stdout?.trim() !== artifact.tree
        ) {
          status = "failed";
          output += "\nVerification changed the source tree; evidence does not match the retained artifact.";
        }
        checks.push({
          name,
          status,
          exitCode: status === "passed" ? 0 : (result.exitCode ?? null),
          output: Buffer.from(output)
            .subarray(0, 256 * 1024)
            .toString("utf8"),
        });
        if (status !== "passed") break;
      }
      const result = { checks, verificationExecution: identity };
      if (closing()) throw new Error("Runtime detached before verification acknowledgement");
      checkpoint = { ...checkpoint, result };
      await journal.save(checkpoint);
      return result;
    } finally {
      // A stale verifier still loses its machine. Suspension retains its bounded job receipts.
      if (!closing())
        await new Bay(run.catalog.baySocket, AbortSignal.timeout(15_000)).suspend(
          identity.sessionName,
          identity.recordId,
          identity.generation,
        );
    }
  }
}
