import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { type RefObject, useEffect, useRef, useState } from "react";
import { dismiss, type Hint, hintLine, MOVE, PAGE } from "../hints.ts";
import { useKeyHint } from "../keymap-context.tsx";
import { wrappedRows } from "../text-width.ts";
import { palette, theme } from "../theme.ts";

/** A terminal-owned team question or revision, independent of conversation transport. */
export type DialogRequest = {
  type: "dialog";
  id: string;
  title: string;
  /** When the question cancels itself unanswered, in epoch milliseconds, as an extension's timeout asks. */
  deadline?: number;
} & (
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

/** Seconds before its deadline from which a question's countdown warns. */
const WARN_SECONDS = 5;

/** Whole seconds until `deadline`, or null without one. */
function secondsUntil(deadline: number | undefined): number | null {
  return deadline === undefined ? null : Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
}

/** The seconds a question has left, redrawn as each one passes. */
function useSecondsLeft(deadline: number | undefined): number | null {
  const [seconds, setSeconds] = useState(() => secondsUntil(deadline));
  useEffect(() => {
    if (deadline === undefined) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      setSeconds(secondsUntil(deadline));
      const until = deadline - Date.now();
      // The next redraw lands as the count changes, so it never shows a second late.
      if (until > 0) timer = setTimeout(tick, until % 1000 || 1000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [deadline]);
  return seconds;
}

/** Where the question stands among those waiting, and how long it waits for an answer, for the border. */
export function dialogTitle(behind: number, seconds: number | null): string | undefined {
  const parts = [
    behind > 0 ? `1 of ${behind + 1}` : null,
    seconds === null ? null : `auto-cancels in ${seconds}s`,
  ].filter(Boolean);
  return parts.length ? ` ${parts.join(" · ")} ` : undefined;
}

/**
 * An operator question or edit, in the editor's place. A long question takes up to half the
 * dialog's rows, and pgup and pgdn scroll it.
 *
 * Esc cancels every kind; the caller owns that key, since it also aborts a run.
 */
export function Dialog({ dialog, behind, onAnswer, rows = LIST_ROWS }: DialogProps) {
  const { id } = dialog;
  const { width } = useTerminalDimensions();
  const [ready, setReady] = useState(false);
  const question = useRef<ScrollBoxRenderable | null>(null);
  const seconds = useSecondsLeft(dialog.deadline);
  // Each dialog mounts afresh, keyed by its id, so the grace runs once per dialog.
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), GRACE_MS);
    return () => clearTimeout(timer);
  }, []);
  const wrapped = wrappedRows(dialog.title, width - 4);
  const titleRows = Math.max(1, Math.min(Math.floor(rows / 2), wrapped));
  useKeyboard((key) => {
    if (key.name !== "pageup" && key.name !== "pagedown") return;
    key.preventDefault();
    scrollBy(question, key.name === "pageup" ? -1 : 1);
  });
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      border
      borderColor={theme.tool}
      backgroundColor={theme.bg}
      title={dialogTitle(behind, seconds)}
      titleAlignment="right"
      titleColor={seconds !== null && seconds <= WARN_SECONDS ? palette.yellow : theme.tool}
      paddingLeft={1}
      paddingRight={1}
    >
      <scrollbox ref={question} maxHeight={titleRows} flexShrink={0} scrollX={false} focusable={false}>
        <text fg={theme.tool}>{dialog.title}</text>
      </scrollbox>
      <Body
        dialog={dialog}
        onAnswer={onAnswer}
        ready={ready}
        rows={Math.max(1, rows - titleRows + 1)}
        scrolls={wrapped > titleRows}
        key={id}
      />
    </box>
  );
}

/** Scrolls the question half its height towards `direction`. */
function scrollBy(view: RefObject<ScrollBoxRenderable | null>, direction: -1 | 1): void {
  const box = view.current;
  if (box) box.scrollBy(direction * Math.max(1, Math.floor(box.height / 2)));
}

function Body({
  dialog,
  onAnswer,
  ready,
  rows,
  scrolls,
}: Omit<DialogProps, "behind" | "rows"> & { ready: boolean; rows: number; scrolls: boolean }) {
  const { id } = dialog;
  const page = scrolls ? PAGE : null;
  switch (dialog.method) {
    case "input":
      return (
        <box flexDirection="column">
          <input
            focused={ready}
            placeholder={dialog.placeholder}
            placeholderColor={theme.dim}
            textColor={theme.assistant}
            focusedTextColor={theme.assistant}
            onSubmit={(value) => {
              if (typeof value === "string") onAnswer({ type: "dialog_response", id, value });
            }}
          />
          <Hints hints={[["enter", "send"], page]} />
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
          <Hints hints={[MOVE, ["enter", "pick"], page]} />
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
          page={page}
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
  page,
}: {
  id: string;
  prefill: string;
  onAnswer: DialogProps["onAnswer"];
  ready: boolean;
  rows: number;
  page: Hint | null;
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
      <textarea
        ref={area}
        focused={ready}
        initialValue={prefill}
        height={rows}
        textColor={theme.assistant}
        focusedTextColor={theme.assistant}
        onSubmit={save}
      />
      <Hints hints={[["ctrl+s / alt+enter", "save"], page]} />
    </box>
  );
}

/** The dialog's keys, ending with the key that cancels it, as the operator has it bound. */
function Hints({ hints }: { hints: readonly (Hint | null)[] }) {
  const { width } = useTerminalDimensions();
  const interrupt = useKeyHint("app.interrupt");
  const clear = useKeyHint("app.clear");
  return (
    <text fg={theme.dim} wrapMode="none" selectable={false}>
      {hintLine([...hints, dismiss(interrupt ?? clear, "cancel")], null, width - 4)}
    </text>
  );
}
