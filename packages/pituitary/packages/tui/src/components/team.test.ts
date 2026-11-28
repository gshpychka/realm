import { expect, test } from "bun:test";
import type { RunDetail } from "@realm/dura/types";
import { byteSize, narrowTasks, readyToApply, taskState, teamPanelWidth, timeLeft } from "./team.tsx";

const task = {
  id: "builder",
  role: "builder",
  revision: 2,
  status: "accepted",
  currentAttemptId: "attempt",
  integrationId: "integration",
  verificationId: "verification",
  artifactId: "result",
} as RunDetail["tasks"][number];
const detail = {
  run: { acceptedArtifactId: "accepted", integrationArtifactId: "accepted" },
  tasks: [task],
  attempts: [],
  questions: [],
  integrations: [],
  verifications: [
    {
      id: "verification",
      status: "passed",
      revision: 2,
      integrationId: "integration",
      artifactId: "accepted",
    },
  ],
} as unknown as RunDetail;
test("apply names only the currently accepted and independently checked integration", () => {
  const verified = detail.verifications[0];
  if (!verified) throw new Error("Missing fixture verification");
  expect(readyToApply(detail, task)).toBe(true);
  expect(readyToApply({ ...detail, run: { ...detail.run, integrationArtifactId: "newer" } }, task)).toBe(
    false,
  );
  expect(readyToApply(detail, { ...task, revision: 3 })).toBe(false);
  expect(readyToApply({ ...detail, verifications: [{ ...verified, artifactId: "different" }] }, task)).toBe(
    false,
  );
});
test("retained code explains integration state and missing verification policy", () => {
  const submitted = { ...task, status: "submitted" as const, verificationId: null };
  expect(taskState(detail, submitted)).toBe("code retained · awaiting integration");
  const integration = { id: "integration", status: "integrated" } as RunDetail["integrations"][number];
  expect(taskState({ ...detail, integrations: [integration] }, submitted)).toBe(
    "code integrated · no verification policy",
  );
  expect(taskState({ ...detail, integrations: [{ ...integration, status: "pending" }] }, submitted)).toBe(
    "integrating retained code",
  );
});

test("task errors stay on one line in the sidebar", () => {
  const attempt = {
    id: "attempt",
    error: "Image unavailable\nlong diagnostics",
  } as RunDetail["attempts"][number];
  expect(taskState({ ...detail, attempts: [attempt] }, task)).toBe("Image unavailable");
});

test("a narrow screen shows the children that need the operator first, and counts the rest", () => {
  const child = (id: string, status: RunDetail["tasks"][number]["status"]) =>
    ({
      ...task,
      id,
      status,
      parentTaskId: "coordinator",
      currentAttemptId: `attempt-${id}`,
    }) as RunDetail["tasks"][number];
  const team = {
    ...detail,
    tasks: [
      child("done", "accepted"),
      child("broken", "failed"),
      child("asking", "waiting"),
      child("late", "conflicted"),
    ],
    questions: [{ id: "question", taskId: "asking", status: "open" }],
  } as unknown as RunDetail;
  const shown = narrowTasks(team, "coordinator");
  expect(shown.tasks.map((item) => item.id)).toEqual(["asking", "broken"]);
  expect(shown.hidden).toBe(2);
  expect(shown.hiddenFailed).toBe(1);
  expect(narrowTasks(team, "done")).toEqual({ tasks: [], hidden: 0, hiddenFailed: 0 });
});

test("the wide panel takes a share of the screen, within bounds", () => {
  expect(teamPanelWidth(120)).toBe(36);
  expect(teamPanelWidth(100)).toBe(35);
  expect(teamPanelWidth(148)).toBe(44);
  expect(teamPanelWidth(300)).toBe(60);
});

test("sizes and deadlines read as the operator says them", () => {
  expect(byteSize(1)).toBe("1 byte");
  expect(byteSize(512)).toBe("512 bytes");
  expect(byteSize(1536)).toBe("1.5 KiB");
  expect(byteSize(8192)).toBe("8 KiB");
  expect(byteSize(222_222)).toBe("217 KiB");
  expect(byteSize(64 * 1024 * 1024)).toBe("64 MiB");
  expect(timeLeft(4 * 3_600_000 + 1_000, 1_000)).toBe("4h 0m left");
  expect(timeLeft(45 * 60_000, 0)).toBe("45m 0s left");
  expect(timeLeft(1_000, 5_000)).toBe("overdue");
});
