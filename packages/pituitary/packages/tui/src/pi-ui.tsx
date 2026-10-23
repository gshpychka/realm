import type { CliRenderer } from "@opentui/core";
import { plain } from "@pituitary/session";
import { type RefObject, useEffect, useState } from "react";
import type { DialogRequest, DialogResponse } from "./components/dialog.tsx";
import type { EditorHandle } from "./components/editor.tsx";
import type { PiUiPort, PiUiRequest } from "./pi.ts";
import { theme } from "./theme.ts";
import type { SessionController } from "./use-session.ts";

type Question = Extract<PiUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;
type Widget = { lines: string[]; placement: "aboveEditor" | "belowEditor" };

/** Pi's extension UI stays at the frontend boundary, outside the conversation protocol. */
export function usePiUI(
  port: PiUiPort | undefined,
  editor: RefObject<EditorHandle | null>,
  renderer: CliRenderer,
  notify: SessionController["notify"],
) {
  const [questions, setQuestions] = useState<{ request: Question; deadline?: number }[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [widgets, setWidgets] = useState<Record<string, Widget>>({});
  useEffect(() => {
    setQuestions([]);
    setStatuses({});
    setWidgets({});
    return port?.onRequest((request) => {
      switch (request.method) {
        case "notify":
          notify(request.notifyType ?? "info", plain(request.message));
          break;
        case "setStatus":
          setStatuses((current) => ({ ...current, [request.statusKey]: plain(request.statusText ?? "") }));
          break;
        case "setWidget":
          setWidgets((current) => ({
            ...current,
            [request.widgetKey]: {
              lines: (request.widgetLines ?? []).map(plain),
              placement: request.widgetPlacement ?? "aboveEditor",
            },
          }));
          break;
        case "setTitle":
          renderer.setTerminalTitle(plain(request.title));
          break;
        case "set_editor_text":
          editor.current?.set(request.text);
          break;
        default:
          setQuestions((current) => [
            ...current,
            {
              request,
              ...("timeout" in request && request.timeout ? { deadline: Date.now() + request.timeout } : {}),
            },
          ]);
      }
    });
  }, [port, editor, renderer, notify]);

  useEffect(() => {
    const deadlines = questions.flatMap((question) => question.deadline ?? []);
    if (!deadlines.length) return;
    const timer = setTimeout(
      () => {
        const expired = questions.filter((question) => question.deadline && question.deadline <= Date.now());
        for (const { request } of expired)
          port?.respond({ type: "extension_ui_response", id: request.id, cancelled: true });
        setQuestions((current) => current.filter((question) => !expired.includes(question)));
      },
      Math.max(0, Math.min(...deadlines) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [port, questions]);

  const dialogs: DialogRequest[] = questions.map(({ request }): DialogRequest => {
    const base = { type: "dialog" as const, id: request.id, title: plain(request.title) };
    switch (request.method) {
      case "select":
        return { ...base, method: "select", options: request.options.map(plain) };
      case "confirm":
        return {
          ...base,
          title: `${base.title}\n${plain(request.message)}`,
          method: "select",
          options: ["Yes", "No"],
        };
      case "input":
        return { ...base, method: "input", placeholder: plain(request.placeholder ?? "") };
      default:
        return { ...base, method: "editor", prefill: plain(request.prefill ?? "") };
    }
  });
  const answer = (response: DialogResponse) => {
    const question = questions.find(({ request }) => request.id === response.id)?.request;
    if (!question || !port) return false;
    port.respond(
      response.cancelled
        ? { type: "extension_ui_response", id: question.id, cancelled: true }
        : question.method === "confirm"
          ? { type: "extension_ui_response", id: question.id, confirmed: response.value === "Yes" }
          : {
              type: "extension_ui_response",
              id: question.id,
              value:
                question.method === "select"
                  ? (question.options.find((option) => plain(option) === response.value) ??
                    response.value ??
                    "")
                  : (response.value ?? ""),
            },
    );
    setQuestions((current) => current.filter(({ request }) => request.id !== question.id));
    return true;
  };
  return {
    dialogs,
    answer,
    statuses: Object.values(statuses).filter(Boolean),
    widgets: Object.values(widgets),
  };
}

export function PiWidgets({ widgets, placement }: { widgets: Widget[]; placement: Widget["placement"] }) {
  const lines = widgets.filter((widget) => widget.placement === placement).flatMap((widget) => widget.lines);
  if (!lines.length) return null;
  return (
    <box paddingLeft={1} flexShrink={0} maxHeight={5} overflow="hidden">
      <text fg={theme.dim}>{lines.join("\n")}</text>
    </box>
  );
}
