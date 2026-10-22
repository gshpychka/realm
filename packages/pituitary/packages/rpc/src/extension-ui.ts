import { type DialogRequest, type DisplayRequest, type PiEvent, plain } from "./protocol.ts";

/** Lines an extension placed beside the editor. */
export interface Widget {
  key: string;
  lines: readonly string[];
  placement: "aboveEditor" | "belowEditor";
}

/** Text an extension asked to put in the editor; `seq` tells two identical requests apart. */
export interface EditorSeed {
  text: string;
  seq: number;
}

/**
 * Everything extensions show outside the conversation.
 *
 * Dialogs queue in arrival order and the first is the one on screen; each stays
 * until the operator answers it or pi stops waiting for it.
 */
export interface ExtensionUi {
  dialogs: readonly DialogRequest[];
  /** Status text by extension key, in key order when drawn. */
  statuses: Readonly<Record<string, string>>;
  /** Status text by key as it stood when the current turn began; before the session's first turn, the latest. */
  turnStatuses: Readonly<Record<string, string>>;
  /** Whether the session has had a turn yet, and whether that turn's run is still going. */
  turn: "unbegun" | "running" | "settled";
  widgets: readonly Widget[];
  title: string | null;
  editor: EditorSeed | null;
}

export const emptyExtensionUi: ExtensionUi = {
  dialogs: [],
  statuses: {},
  turnStatuses: {},
  turn: "unbegun",
  widgets: [],
  title: null,
  editor: null,
};

/** Widgets past this many lines are cut, as pi's own editor does. */
export const WIDGET_LINES = 10;

/** Folds one extension UI request into `state`. `notify` belongs to the conversation. */
export function present(state: ExtensionUi, request: DialogRequest | DisplayRequest): ExtensionUi {
  switch (request.method) {
    case "select":
    case "confirm":
    case "input":
    case "editor":
      return state.dialogs.some((open) => open.id === request.id)
        ? state
        : { ...state, dialogs: [...state.dialogs, request] };
    case "setStatus": {
      const { [request.statusKey]: _, ...rest } = state.statuses;
      const text = request.statusText === undefined ? "" : plain(request.statusText).trim();
      const statuses = text ? { ...rest, [request.statusKey]: text } : rest;
      return { ...state, statuses, turnStatuses: state.turn === "unbegun" ? statuses : state.turnStatuses };
    }
    case "setWidget": {
      const others = state.widgets.filter((widget) => widget.key !== request.widgetKey);
      if (!request.widgetLines || request.widgetLines.length === 0) return { ...state, widgets: others };
      const widget: Widget = {
        key: request.widgetKey,
        lines: request.widgetLines.slice(0, WIDGET_LINES).map(plain),
        placement: request.widgetPlacement ?? "aboveEditor",
      };
      return { ...state, widgets: [...others, widget] };
    }
    case "setTitle":
      return { ...state, title: plain(request.title) };
    case "set_editor_text":
      return { ...state, editor: { text: request.text, seq: (state.editor?.seq ?? 0) + 1 } };
    case "notify":
      return state;
  }
}

/** The extension UI with the dialog `id` closed, whether answered or abandoned. */
export function dismiss(state: ExtensionUi, id: string): ExtensionUi {
  return { ...state, dialogs: state.dialogs.filter((dialog) => dialog.id !== id) };
}

/** Folds one agent event into `state`: a turn begins with a run and lasts until the next run begins. */
export function follow(state: ExtensionUi, event: PiEvent): ExtensionUi {
  switch (event.type) {
    case "agent_start":
      // pi starts a run again for a retry or a continuation, each before the run settles.
      return state.turn === "running" ? state : { ...state, turn: "running", turnStatuses: state.statuses };
    case "agent_settled":
      return state.turn === "running" ? { ...state, turn: "settled" } : state;
    default:
      return state;
  }
}

/** `state` for another session opened in its place, which has had no turn yet. */
export function openSession(state: ExtensionUi): ExtensionUi {
  return { ...state, turn: "unbegun", turnStatuses: state.statuses };
}
