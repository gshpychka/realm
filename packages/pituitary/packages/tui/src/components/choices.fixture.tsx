import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { useState } from "react";
import { theme } from "../theme.ts";
import { Checklist } from "./checklist.tsx";
import { Dialog } from "./dialog.tsx";
import { Picker } from "./picker.tsx";
import { TodoPanel } from "./widgets.tsx";

const items = [
  { label: "match first", value: "first" },
  { label: "match second", value: "second" },
  { label: "other current", value: "other", current: true },
];
const renderer = await createCliRenderer({ exitOnCtrlC: true });
function Example() {
  const [picked, setPicked] = useState("");
  const mode = process.env.CHOICES_VIEW;
  const choices =
    mode === "long"
      ? items.map((item) => ({
          ...item,
          label: `${item.label} ${"資料🙂e\u0301".repeat(12)}`,
          detail: "a very long provider / model detail",
        }))
      : items;
  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.bg}>
      <box flexGrow={1} />
      {(mode === "dialog" || mode === "dialog-title") && !picked ? (
        <Dialog
          rows={4}
          behind={0}
          dialog={{
            type: "extension_ui_request",
            id: "confirm",
            method: "confirm",
            title:
              mode === "dialog-title"
                ? Array.from({ length: 6 }, (_, index) => `Question part ${index + 1}`).join("\n")
                : "Review a long confirmation message",
            message: Array.from({ length: 12 }, (_, index) => `Review line ${index + 1}`).join("\n"),
          }}
          onAnswer={() => setPicked("answered")}
        />
      ) : mode === "todo" ? (
        <TodoPanel
          tasks={[
            ...Array.from({ length: 8 }, (_, id) => ({
              id,
              subject: `finished ${id}`,
              status: "completed" as const,
            })),
            { id: 8, subject: "active task", status: "in_progress" },
            { id: 9, subject: "next task", status: "pending" },
            { id: 10, subject: "removed task", status: "deleted" },
          ]}
        />
      ) : picked ? (
        <text>{picked}</text>
      ) : mode === "checklist" ? (
        <Checklist
          spec={{
            title: "choose models",
            items: choices,
            checked: null,
            onSave: () => setPicked("saved"),
          }}
          rows={4}
          onClose={() => {}}
        />
      ) : (
        <Picker
          spec={{
            title: "choose a model",
            items: choices,
            alternate: {
              label: "every model",
              items: async () => {
                await new Promise((resolve) => setTimeout(resolve, 1500));
                throw new Error("sessions unavailable");
              },
            },
            onPick: setPicked,
          }}
          rows={4}
          onClose={() => {}}
        />
      )}
      <text fg={theme.user}>draft stays here</text>
      <text fg={theme.dim}>footer stays here</text>
    </box>
  );
}
createRoot(renderer).render(<Example />);
