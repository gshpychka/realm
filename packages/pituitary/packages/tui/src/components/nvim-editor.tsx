import {
  type BoxRenderable,
  decodePasteBytes,
  type KeyEvent,
  type PasteEvent,
  stripAnsiSequences,
} from "@opentui/core";
import { flushSync } from "@opentui/react";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { type Draft, type DraftEngine, offsetOf, textOf } from "../nvim/engine.ts";
import { toNvim } from "../nvim/keys.ts";
import type { Frame, Mode } from "../nvim/screen.ts";
import { palette } from "../theme.ts";
import type { EditorProps } from "./editor.tsx";
import { draftMark, EditorFrame, type Mark } from "./editor-frame.tsx";
import { type Cursor, cursorOf, heightOf, NvimScreen } from "./nvim-screen.tsx";

/** Whether keys go into the text as typed: insert mode and its variants. */
function inserting(mode: string): boolean {
  return mode.startsWith("i");
}

/** Insert and normal mode, where the arrows walk the draft's own rows. */
function editing(draft: Draft): boolean {
  return inserting(draft.mode) || draft.mode === "n";
}

/** The tag beside the draft for a mode other than insert, with its colour. */
function tagOf(mode: Mode): Mark | null {
  switch (mode.name) {
    case "insert":
    case "showmatch":
      return null;
    case "visual":
    case "visual_select":
      return { label: "V", tone: palette.purple };
    case "replace":
      return { label: "R", tone: palette.red };
    default:
      return { label: "N", tone: palette.yellow };
  }
}

export interface NvimEditorProps extends EditorProps {
  engine: DraftEngine;
  maxRows: number;
}

/** The draft as an embedded nvim edits and draws it: one row, growing as it fills. */
export function NvimEditor({
  ref,
  engine,
  onSubmit,
  steering,
  focused,
  initialDraft,
  initialCursor,
  note,
  confirm,
  onChange,
  onEscapes,
  maxRows,
}: NvimEditorProps) {
  const area = useRef<BoxRenderable | null>(null);
  const [draft, setDraft] = useState<Draft>(engine.draft);
  const [frame, setFrame] = useState<Frame | null>(engine.frame);
  const latest = useRef<{ cursor: Cursor | null; shown: boolean }>({ cursor: null, shown: false });

  const changed = useRef(onChange);
  changed.current = onChange;
  const escapes = useRef(onEscapes);
  escapes.current = onEscapes;
  useEffect(
    () =>
      engine.onChange((next) => {
        flushSync(() => setDraft(next));
        changed.current?.(textOf(next), offsetOf(next));
        escapes.current?.(next.mode === "n" && !engine.pending ? 1 : 2);
      }),
    [engine],
  );
  useEffect(() => engine.onFrame((next) => flushSync(() => setFrame(next))), [engine]);

  useEffect(() => {
    if (area.current) engine.resize(area.current.width, maxRows);
  }, [engine, maxRows]);

  useEffect(() => {
    engine.placeholder(steering ? "queue a steering message" : "ask pi");
  }, [engine, steering]);

  useImperativeHandle(ref, () => ({
    text: () => textOf(engine.draft),
    set: (text, cursor) => engine.set(text, cursor),
    cursor: () => offsetOf(engine.draft),
    hasFocus: () => area.current?.focused ?? false,
    focus: () => area.current?.focus(),
    onFirstLine: () => editing(engine.draft) && engine.draft.onFirstRow,
    onLastLine: () => editing(engine.draft) && engine.draft.onLastRow,
    wantsEscape: () => engine.draft.mode !== "n" || engine.pending,
    pending: () => engine.pending,
    busy: () => engine.busy,
    settle: () => engine.settle(),
    take: () => engine.take(),
  }));

  useEffect(() => {
    if (initialDraft !== undefined) engine.set(initialDraft, initialCursor);
  }, [initialDraft, initialCursor, engine]);

  const onKeyDown = (key: KeyEvent) => {
    const { mode } = engine.draft;
    const plain = !key.shift && !key.meta && !key.ctrl;
    // Enter sends the draft, save where a command line or an operator waiting on its motion takes it.
    if (
      (key.name === "return" || key.name === "kpenter") &&
      plain &&
      !mode.startsWith("c") &&
      !mode.startsWith("no") &&
      !engine.pending
    ) {
      key.preventDefault();
      // A draft nvim failed to hand over stays with the plain editor that takes over.
      engine.take().then(onSubmit, () => {});
      return;
    }
    if ((key.name === "return" || key.name === "kpenter") && key.shift && inserting(mode)) {
      key.preventDefault();
      engine.input("<CR>");
      return;
    }
    const keys = toNvim(key);
    if (keys === null) return;
    key.preventDefault();
    engine.input(keys);
  };

  const onPaste = (event: PasteEvent) => {
    event.preventDefault();
    engine.paste(stripAnsiSequences(decodePasteBytes(event.bytes)));
  };

  latest.current.cursor = cursorOf(frame);

  // The terminal's own cursor marks the insertion point, shaped by the mode.
  function drawCursor(this: BoxRenderable) {
    const state = latest.current;
    if (!this.focused || !state.cursor) {
      if (state.shown) this.ctx.setCursorPosition(0, 0, false);
      state.shown = false;
      return;
    }
    const { x, y, style, blinking } = state.cursor;
    this.ctx.setCursorPosition(this.x + x + 1, this.y + y + 1, true);
    this.ctx.setCursorStyle({ style, blinking });
    state.shown = true;
  }

  const rows = Math.min(maxRows, heightOf(frame));
  const mark = (frame && tagOf(frame.mode)) ?? draftMark(steering);
  return (
    <EditorFrame signal={{}} rows={rows} note={note} confirm={confirm} mark={mark}>
      <box
        ref={area}
        focusable
        focused={focused}
        flexGrow={1}
        height={rows}
        flexDirection="column"
        overflow="hidden"
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onSizeChange={function (this: BoxRenderable) {
          engine.resize(this.width, maxRows);
        }}
        renderAfter={drawCursor}
      >
        {/* An empty draft shows only the placeholder, which is not there to be copied. */}
        {frame ? <NvimScreen frame={frame} selectable={textOf(draft) !== ""} /> : null}
      </box>
    </EditorFrame>
  );
}
