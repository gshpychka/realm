import type { KeyEvent, TextareaRenderable } from "@opentui/core";
import type { EditorSeed } from "@pituitary/rpc";
import {
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { takeEngine, textOf } from "../nvim/engine.ts";
import * as profile from "../profile.ts";
import { theme } from "../theme.ts";
import { draftMark, EditorFrame } from "./editor-frame.tsx";
import { NvimEditor } from "./nvim-editor.tsx";

/** What the rest of the app may do with the draft. */
export interface EditorHandle {
  text(): string;
  /** Replaces the draft, with the cursor at `cursor`, the end by default. */
  set(text: string, cursor?: number): void;
  /** Where the cursor is, as a character offset into the draft. */
  cursor(): number;
  /** True while the draft takes the keyboard. */
  hasFocus(): boolean;
  /** Gives the keyboard back to the draft. */
  focus(): void;
  /** True when the cursor is on the draft's top screen row, where up has nowhere left to go in it. */
  onFirstLine(): boolean;
  /** True when the cursor is on the draft's bottom screen row, where down has nowhere left to go in it. */
  onLastLine(): boolean;
  /** True while the draft has a use for escape of its own, such as leaving insert mode. */
  wantsEscape(): boolean;
  /** True while the draft holds a half-typed command that the next key completes. */
  pending(): boolean;
  /** True while keys sent to the draft may not show in `text()` yet. */
  busy(): boolean;
  /** Resolves once `text()` shows every key sent so far. */
  settle(): Promise<void>;
  /** Takes a key the app held back, as though it arrived now. */
  press(key: KeyEvent): void;
  /** The draft with every key typed so far, leaving the editor empty. */
  take(): Promise<string>;
}

export interface EditorProps {
  ref?: Ref<EditorHandle>;
  onSubmit(text: string): void;
  /** Shown while the agent runs, where a submission becomes a steering message. */
  steering: boolean;
  /** False while something else, such as a dialog, holds the keyboard. */
  focused: boolean;
  /** Text an extension put in the editor, replacing the draft. */
  seed: EditorSeed | null;
  /** A passing message about the keys, drawn into the rule above the draft. */
  note: string | null;
  /** What a second press of the key just pressed does, shown until another key passes it up. */
  confirm?: string | null;
  /** Called when the draft or the cursor changes. */
  onChange?(text: string, cursor: number): void;
  /** How many escapes reach the app's interrupt from where the draft stands, told as it changes. */
  onEscapes?(count: 1 | 2): void;
  /** Tells the operator something about the editor itself, such as nvim failing to start. */
  onNotice?(text: string): void;
}

/**
 * The draft, edited by an embedded nvim. Where nvim cannot run, a plain multi-line
 * editor takes over with the draft as it stood.
 */
export function Editor(props: EditorProps) {
  const [engine] = useState(takeEngine);
  const [plain, setPlain] = useState<string | null>(null);
  const noticed = useRef(props.onNotice);
  noticed.current = props.onNotice;

  useEffect(() => {
    engine.ready.then(
      () => profile.mark("editor-ready"),
      () => {},
    );
    const unsubscribe = engine.onClose((reason) => {
      setPlain(textOf(engine.draft));
      noticed.current?.(`vim mode is off: ${reason}`);
    });
    return () => {
      unsubscribe();
      engine.close();
    };
  }, [engine]);

  if (plain !== null) return <PlainEditor {...props} initial={plain} />;
  return <NvimEditor {...props} engine={engine} />;
}

/** Rows the editor grows to before it scrolls. */
const MAX_ROWS = 8;

const BINDINGS = [
  { name: "return", action: "submit" as const },
  { name: "kpenter", action: "submit" as const },
  { name: "linefeed", action: "newline" as const },
  { name: "return", shift: true, action: "newline" as const },
  // pi's editor keeps home and end to the line the cursor is on.
  { name: "home", action: "line-home" as const },
  { name: "end", action: "line-end" as const },
];

/** Rows `text` fills at `width` columns, each line wrapping onto as many as it needs. */
export function rowsFor(text: string, width: number): number {
  if (width <= 0) return text.split("\n").length;
  return text
    .split("\n")
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(Bun.stringWidth(line) / width)), 0);
}

/** What the app may do with a draft held in a plain textarea, which `set` replaces. */
function plainHandle(
  area: RefObject<TextareaRenderable | null>,
  set: (text: string, cursor?: number) => void,
): EditorHandle {
  // The textarea's arrows walk wrapped rows, and its visual cursor counts from the row scrolled to.
  const row = (field: TextareaRenderable) => field.visualCursor.visualRow + field.scrollY;
  const text = () => area.current?.plainText ?? "";
  return {
    text,
    set,
    cursor: () => area.current?.cursorOffset ?? 0,
    hasFocus: () => area.current?.focused ?? false,
    focus: () => area.current?.focus(),
    onFirstLine: () => !area.current || row(area.current) === 0,
    onLastLine: () => !area.current || row(area.current) >= area.current.virtualLineCount - 1,
    wantsEscape: () => false,
    pending: () => false,
    busy: () => false,
    settle: () => Promise.resolve(),
    press: (key) => area.current?.handleKeyPress(key),
    take: () => {
      const draft = text();
      set("");
      return Promise.resolve(draft);
    },
  };
}

/** A multi-line draft: enter sends, shift+enter or ctrl+j breaks the line. */
function PlainEditor({
  ref,
  onSubmit,
  steering,
  focused,
  seed,
  note,
  confirm,
  onChange,
  onEscapes,
  initial,
}: EditorProps & { initial: string }) {
  const area = useRef<TextareaRenderable | null>(null);
  const [rows, setRows] = useState(1);
  const [bash, setBash] = useState(false);

  const changed = useRef(onChange);
  changed.current = onChange;
  const measure = useCallback(() => {
    const field = area.current;
    if (!field) return;
    changed.current?.(field.plainText, field.cursorOffset);
    // Counted from the text and the width it has, so the editor grows before the layout wraps it.
    setRows(Math.min(MAX_ROWS, Math.max(1, rowsFor(field.plainText, field.width))));
    setBash(field.plainText.startsWith("!"));
  }, []);

  const set = useCallback(
    (text: string, cursor?: number) => {
      const field = area.current;
      if (!field) return;
      field.setText(text);
      if (cursor === undefined) field.gotoBufferEnd();
      else field.cursorOffset = cursor;
      measure();
    },
    [measure],
  );

  useImperativeHandle(ref, () => plainHandle(area, set));

  useEffect(() => {
    if (seed) set(seed.text);
  }, [seed, set]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: carries the draft over once, when this editor takes over
  useEffect(() => {
    if (initial) set(initial);
    onEscapes?.(1);
  }, []);

  return (
    <EditorFrame
      signal={{ command: bash }}
      rows={rows}
      note={note}
      confirm={confirm}
      mark={draftMark(bash, steering)}
    >
      <textarea
        ref={area}
        focused={focused}
        flexGrow={1}
        height={rows}
        keyBindings={BINDINGS}
        textColor={theme.assistant}
        placeholderColor={theme.dim}
        placeholder={steering ? "queue a steering message" : "ask pi · !cmd runs a shell command"}
        onContentChange={measure}
        onSizeChange={measure}
        onCursorChange={measure}
        onSubmit={() => {
          const draft = area.current?.plainText ?? "";
          set("");
          onSubmit(draft);
        }}
      />
    </EditorFrame>
  );
}
