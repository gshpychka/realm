import type { InputRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { DialogRequest, RpcExtensionUIResponse } from "@pituitary/rpc";
import { useEffect, useRef, useState } from "react";
import { theme } from "../theme.ts";

export interface DialogProps {
  dialog: DialogRequest;
  /** Dialogs waiting behind this one. */
  behind: number;
  onAnswer(response: RpcExtensionUIResponse): void;
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
 * The dialog an extension is waiting on, in the editor's place.
 *
 * Esc cancels every kind; the caller owns that key, since it also aborts a run.
 */
export function Dialog({ dialog, behind, onAnswer, rows = LIST_ROWS }: DialogProps) {
  const { id } = dialog;
  const [ready, setReady] = useState(false);
  // Each dialog mounts afresh, keyed by its id, so the grace runs once per dialog.
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), GRACE_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border
      borderColor={theme.tool}
      title={behind > 0 ? ` 1 of ${behind + 1} ` : undefined}
      titleAlignment="right"
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.tool}>{dialog.title}</text>
      <Body dialog={dialog} onAnswer={onAnswer} ready={ready} rows={rows} key={id} />
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
            onSelect={(index) => {
              const value = dialog.options[index];
              if (value !== undefined) onAnswer({ type: "extension_ui_response", id, value });
            }}
          />
          <Hint text="↑↓ choose · enter pick · esc cancel" />
        </box>
      );
    case "confirm":
      return <Confirm id={id} message={dialog.message} onAnswer={onAnswer} ready={ready} />;
    case "input":
      return <Input id={id} placeholder={dialog.placeholder ?? ""} onAnswer={onAnswer} ready={ready} />;
    case "editor":
      return (
        <Editor
          id={id}
          prefill={dialog.prefill ?? ""}
          onAnswer={onAnswer}
          ready={ready}
          rows={Math.max(2, Math.min(EDITOR_ROWS, rows))}
        />
      );
  }
}

function Confirm({
  id,
  message,
  onAnswer,
  ready,
}: {
  id: string;
  message: string;
  onAnswer: DialogProps["onAnswer"];
  ready: boolean;
}) {
  useKeyboard((key) => {
    if (!ready) return;
    if (key.name === "y" || key.name === "return")
      onAnswer({ type: "extension_ui_response", id, confirmed: true });
    else if (key.name === "n") onAnswer({ type: "extension_ui_response", id, confirmed: false });
  });
  return (
    <box flexDirection="column">
      <text fg={theme.assistant}>{message}</text>
      <Hint text="y / enter yes · n no · esc cancel" />
    </box>
  );
}

function Input({
  id,
  placeholder,
  onAnswer,
  ready,
}: {
  id: string;
  placeholder: string;
  onAnswer: DialogProps["onAnswer"];
  ready: boolean;
}) {
  const field = useRef<InputRenderable | null>(null);
  return (
    <box flexDirection="column">
      <input
        ref={field}
        focused={ready}
        placeholder={placeholder}
        onSubmit={() => onAnswer({ type: "extension_ui_response", id, value: field.current?.value ?? "" })}
      />
      <Hint text="enter submit · esc cancel" />
    </box>
  );
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
  const save = () => onAnswer({ type: "extension_ui_response", id, value: area.current?.plainText ?? "" });
  useKeyboard((key) => {
    if (ready && key.ctrl && key.name === "s") save();
  });
  return (
    <box flexDirection="column">
      <textarea ref={area} focused={ready} initialValue={prefill} height={rows} onSubmit={save} />
      <Hint text="alt+enter or ctrl+s save · esc cancel" />
    </box>
  );
}

function Hint({ text }: { text: string }) {
  return <text fg={theme.dim}>{text}</text>;
}
