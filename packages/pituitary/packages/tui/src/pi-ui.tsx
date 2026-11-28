import type { CliRenderer } from "@opentui/core";
import { plain } from "@pituitary/session";
import { type RefObject, useEffect, useSyncExternalStore } from "react";
import type { DialogRequest, DialogResponse } from "./components/dialog.tsx";
import type { EditorHandle } from "./components/editor.tsx";
import type { PiUiPort } from "./pi.ts";
import { type PiUiState, type PiWidget, piUiStore } from "./pi-ui-store.ts";
import { theme } from "./theme.ts";
import type { SessionController } from "./use-session.ts";

const NONE: PiUiState = { questions: [], statuses: {}, widgets: {}, fast: false };
const unsubscribed = () => () => {};

/** Pi's extension UI stays at the frontend boundary, outside the conversation protocol. */
export function usePiUI(
  port: PiUiPort | undefined,
  editor: RefObject<EditorHandle | null>,
  renderer: CliRenderer,
  notify: SessionController["notify"],
) {
  const store = port ? piUiStore(port) : undefined;
  const state = useSyncExternalStore(store?.subscribe ?? unsubscribed, store?.snapshot ?? (() => NONE));
  useEffect(
    () =>
      store?.onEffect((effect) => {
        if (effect.kind === "notify") notify(effect.level, effect.text);
        else if (effect.kind === "title") renderer.setTerminalTitle(effect.title);
        else editor.current?.set(effect.text);
      }),
    [store, editor, renderer, notify],
  );

  const { questions } = state;
  useEffect(() => {
    const deadlines = questions.flatMap((question) => question.deadline ?? []);
    if (!store || !deadlines.length) return;
    const timer = setTimeout(
      () => store.expire(Date.now()),
      Math.max(0, Math.min(...deadlines) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [store, questions]);

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
  return {
    dialogs,
    answer: (response: DialogResponse) => store?.answer(response) ?? false,
    statuses: Object.values(state.statuses).filter(Boolean),
    /** Whether replies to the selected model come at Fast mode's priority speed. */
    fast: state.fast,
    usage: state.usage,
    widgets: Object.values(state.widgets),
  };
}

export function PiWidgets({ widgets, placement }: { widgets: PiWidget[]; placement: PiWidget["placement"] }) {
  const lines = widgets.filter((widget) => widget.placement === placement).flatMap((widget) => widget.lines);
  if (!lines.length) return null;
  return (
    <box paddingLeft={1} flexShrink={0} maxHeight={5} overflow="hidden">
      <text fg={theme.dim}>{lines.join("\n")}</text>
    </box>
  );
}
