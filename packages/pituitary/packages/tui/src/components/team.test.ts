import { expect, test } from "bun:test";
import type { RunDetail } from "@realm/dura/types";
import { readyToApply, taskState } from "./team.tsx";

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
