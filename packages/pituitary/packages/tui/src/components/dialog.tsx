import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef, useState } from "react";
import { useKeyHint } from "../keymap-context.tsx";
import { wrappedRows } from "../text-width.ts";
import { theme } from "../theme.ts";

/** A terminal-owned team question or revision, independent of conversation transport. */
export type DialogRequest = { type: "dialog"; id: string; title: string } & (
  | { method: "select"; options: string[] }
  | { method: "input"; placeholder?: string }
  | { method: "editor"; prefill?: string }
);
export interface DialogResponse {
  type: "dialog_response";
  id: string;
  value?: string;
  cancelled?: boolean;
}

export interface DialogProps {
  dialog: DialogRequest;
  /** Dialogs waiting behind this one. */
  behind: number;
  onAnswer(response: DialogResponse): void;
  /** Rows the dialog's list or text area may take, so it fits the screen. */
  rows?: number;
}

/** Rows a select list takes before it scrolls, room permitting. */
const LIST_ROWS = 8;
/** Rows the text area takes, room permitting. */
const EDITOR_ROWS = 6;

/**
 * How long a new dialog ignores the keyboard. A dialog can open under keys typed for
 * the editor, and one of them must not answer it.
 */
export const GRACE_MS = 400;

/**
 * An operator question or edit, in the editor's place.
 *
 * Esc cancels every kind; the caller owns that key, since it also aborts a run.
 */
export function Dialog({ dialog, behind, onAnswer, rows = LIST_ROWS }: DialogProps) {
  const { id } = dialog;
  const { width } = useTerminalDimensions();
  const [ready, setReady] = useState(false);
  // Each dialog mounts afresh, keyed by its id, so the grace runs once per dialog.
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), GRACE_MS);
    return () => clearTimeout(timer);
  }, []);
  const titleRows = Math.max(1, Math.min(3, Math.floor(rows / 3), wrappedRows(dialog.title, width - 4)));
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border
      borderColor={theme.tool}
      backgroundColor={theme.bg}
      title={behind > 0 ? ` 1 of ${behind + 1} ` : undefined}
      titleAlignment="right"
      paddingLeft={1}
      paddingRight={1}
    >
      <scrollbox maxHeight={titleRows} flexShrink={0} scrollX={false} focusable={false}>
        <text fg={theme.tool}>{dialog.title}</text>
      </scrollbox>
      <Body
        dialog={dialog}
        onAnswer={onAnswer}
        ready={ready}
        rows={Math.max(1, rows - titleRows + 1)}
        key={id}
      />
    </box>
  );
}

function Body({
  dialog,
  onAnswer,
  ready,
  rows,
}: Omit<DialogProps, "behind" | "rows"> & { ready: boolean; rows: number }) {
  const { id } = dialog;
  switch (dialog.method) {
    case "input":
      return (
        <box flexDirection="column">
          <input
            focused={ready}
            placeholder={dialog.placeholder}
            onSubmit={(value) => {
              if (typeof value === "string") onAnswer({ type: "dialog_response", id, value });
            }}
          />
          <Hint text="enter send" />
        </box>
      );
    case "select":
      return (
        <box flexDirection="column">
          <select
            focused={ready}
            height={Math.max(1, Math.min(LIST_ROWS, rows, dialog.options.length))}
            options={dialog.options.map((option) => ({ name: option, description: "" }))}
            showDescription={false}
            selectedBackgroundColor={theme.border}
            selectedTextColor={theme.assistant}
            textColor={theme.assistant}
            backgroundColor={theme.bg}
            focusedBackgroundColor={theme.bg}
            keyBindings={[{ name: "kpenter", action: "select-current" }]}
            onSelect={(index) => {
              const value = dialog.options[index];
              if (value !== undefined) onAnswer({ type: "dialog_response", id, value });
            }}
          />
          <Hint text="↑↓ choose · enter pick" />
        </box>
      );
    case "editor":
      return (
        <Editor
          id={id}
          prefill={dialog.prefill ?? ""}
          onAnswer={onAnswer}
          ready={ready}
          rows={Math.max(1, Math.min(EDITOR_ROWS, rows))}
        />
      );
  }
}

function Editor({
  id,
  prefill,
  onAnswer,
  ready,
  rows,
}: {
  id: string;
  prefill: string;
  onAnswer: DialogProps["onAnswer"];
  ready: boolean;
  rows: number;
}) {
  const area = useRef<TextareaRenderable | null>(null);
  // The prefill is a start the operator writes on from.
  useEffect(() => {
    area.current?.gotoBufferEnd();
  }, []);
  const save = () => onAnswer({ type: "dialog_response", id, value: area.current?.plainText ?? "" });
  useKeyboard((key) => {
    if (ready && !key.defaultPrevented && key.ctrl && key.name === "s") {
      key.preventDefault();
      save();
    }
  });
  return (
    <box flexDirection="column">
      <textarea ref={area} focused={ready} initialValue={prefill} height={rows} onSubmit={save} />
      <Hint text="ctrl+s save · alt+enter" />
    </box>
  );
}

function Hint({ text }: { text: string }) {
  const interrupt = useKeyHint("app.interrupt");
  const clear = useKeyHint("app.clear");
  const cancel = interrupt ?? clear;
  return (
    <text fg={theme.dim} truncate wrapMode="none">
      {text}
      {cancel ? ` · ${cancel} cancel` : ""}
    </text>
  );
}
