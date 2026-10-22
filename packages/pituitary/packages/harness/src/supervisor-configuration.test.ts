import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { supervisorBayFixture } from "./fixtures/supervisor-bay.fixture.ts";
import { rootAttempt, waitRun } from "./runtime.fixture.ts";
import { Runtime } from "./runtime.ts";
import { startRuntime } from "./supervisor.ts";

test("one daemon owns a state directory and releasing it permits a new owner", async () => {
  const stateDirectory = mkdtempSync(join(tmpdir(), "pituitary-owner-"));
  const first = await startRuntime({ stateDirectory });
  try {
    await expect(startRuntime({ stateDirectory })).rejects.toThrow("already owns");
  } finally {
    await first.close();
  }
  const second = await startRuntime({ stateDirectory });
  try {
    expect(await new Runtime({ stateDirectory, autoStart: false }).list()).toEqual([]);
  } finally {
    await second.close();
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("new runs read catalog edits while existing runs keep their frozen role and image", async () => {
  const fixture = await supervisorBayFixture();
  const catalogFile = join(fixture.root, "agents.json");
  const catalog = {
    schemaVersion: 1,
    baySocket: fixture.catalog.baySocket,
    agents: Object.fromEntries(
      Object.entries(fixture.catalog.agents).map(([name, { manifest, ...machine }]) => [
        name,
        { ...manifest, ...machine },
      ]),
    ),
  };
  const save = () => writeFileSync(catalogFile, JSON.stringify(catalog));
  save();
  const host = await startRuntime({
    stateDirectory: fixture.stateDirectory,
    catalogFile,
    bayCommand: fixture.bayCommand,
  });
  const runtime = new Runtime({ stateDirectory: fixture.stateDirectory, autoStart: false });
  try {
    const before = await runtime.start({ name: "original-role", cwd: fixture.root, agent: "coordinator" });
    await waitRun(runtime, before.id, (detail) => rootAttempt(detail).status === "ready");
    const original = before.catalog?.agents.coordinator;
    if (!original || !catalog.agents.coordinator) throw new Error("Missing coordinator declaration");
    catalog.agents.coordinator.instructions = "Fresh role instructions without rebuilding its NixOS machine.";
    save();
    const after = await runtime.start({ name: "updated-role", cwd: fixture.root, agent: "coordinator" });
    await waitRun(runtime, after.id, (detail) => rootAttempt(detail).status === "ready");
    expect(after.catalog?.agents.coordinator?.manifest.instructions).toBe(
      catalog.agents.coordinator.instructions,
    );
    expect((await runtime.inspect(before.id)).run.catalog?.agents.coordinator?.manifest.instructions).toBe(
      original.manifest.instructions,
    );
    expect(after.catalog?.agents.coordinator?.machineRevision).toBe(original.machineRevision);
    expect(fixture.starts.map((start) => start.input.machineRevision)).toEqual([
      original.machineRevision,
      original.machineRevision,
    ]);
    expect([...fixture.guests.values()].map((guest) => guest.engine.context.role?.instructions)).toEqual([
      original.manifest.instructions,
      catalog.agents.coordinator.instructions,
    ]);
  } finally {
    try {
      for (const run of await runtime.list()) await runtime.stop(run.id);
      for (const run of await runtime.list())
        await waitRun(runtime, run.id, (detail) => rootAttempt(detail).status === "stopped");
    } finally {
      await host.close();
      await fixture.close();
    }
  }
}, 20_000);
