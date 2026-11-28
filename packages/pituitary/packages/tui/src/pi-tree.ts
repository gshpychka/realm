import { plain } from "@pituitary/session";
import type { DetailIcon } from "./components/detail.tsx";
import type { PickItem } from "./components/picker.tsx";
import { glyphs } from "./glyphs.ts";
import type { TreeKind, TreeNode } from "./pi-bridge.ts";
import { firstLine, when } from "./pi-sessions.ts";
import { palette, theme } from "./theme.ts";

/** The tree picker's rows, and the row that stands for where the session is. */
export interface TreeRows {
  items: PickItem[];
  /** The session's leaf, or the nearest entry above it that has a row; null before the first entry. */
  here: string | null;
}

/** How each kind of row is marked, as the transcript marks the same entries. */
const MARKS: Record<Exclude<TreeKind, "tool" | "other">, DetailIcon> = {
  user: { glyph: "▌", colour: theme.user },
  assistant: { glyph: "●", colour: theme.assistant },
  bash: { glyph: "$", colour: theme.tool },
  custom: { glyph: "●", colour: theme.dim },
  compaction: { glyph: glyphs.summary, colour: theme.dim },
  branch: { glyph: glyphs.summary, colour: theme.dim },
};
/** A row off the branch the session is on keeps its mark, without the colour. */
const ASIDE: DetailIcon["colour"] = theme.dim;

/** The lines that join a branch point to each branch, and carry on beside the branches below it. */
const BRANCH = { first: "├─ ", rest: "│  " };
const LAST = { first: "└─ ", rest: "   " };

/**
 * The session's tree as picker rows, depth first, the branch the session is on before the
 * others at every fork. A chain of entries stays in one column; only where a point has more
 * than one branch do its branches step in, with `├─`, `└─` and `│`, as Pi's own tree draws
 * them. Prompts, replies, the operator's shell commands, extensions' messages and summaries
 * have rows. A tool's result, a step that only called tools, and Pi's bookkeeping, such as a
 * model change or a label, have none: what follows them hangs from the row before.
 */
export function treeRows(nodes: readonly TreeNode[], leaf: string | null, now: number): TreeRows {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // The entries from the leaf up to the first: the branch the session is on.
  const path = new Set<string>();
  for (let id = leaf; id !== null && !path.has(id); ) {
    path.add(id);
    id = byId.get(id)?.parent ?? null;
  }
  const shown = (node: TreeNode) =>
    node.kind !== "tool" &&
    node.kind !== "other" &&
    (node.kind !== "assistant" || node.text.trim() !== "" || node.id === leaf);
  /** The nearest entry above `node` that has a row; null when none does. */
  const above = (node: TreeNode): string | null => {
    const seen = new Set<string>();
    for (let id = node.parent; id !== null && !seen.has(id); ) {
      seen.add(id);
      const parent = byId.get(id);
      if (!parent) return null;
      if (shown(parent)) return id;
      id = parent.parent;
    }
    return null;
  };
  const children = new Map<string | null, TreeNode[]>();
  for (const node of nodes) {
    if (!shown(node)) continue;
    const parent = above(node);
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  // At every fork the branch the session is on comes first; the rest keep the order Pi made them in.
  const ordered = (parent: string | null) =>
    (children.get(parent) ?? []).toSorted((a, b) => Number(path.has(b.id)) - Number(path.has(a.id)));

  let here: string | null = null;
  if (leaf !== null) {
    const node = byId.get(leaf);
    here = node && shown(node) ? leaf : node ? above(node) : null;
  }
  const items: PickItem[] = [];
  // Depth first with a stack: a session's chain of entries can be longer than a call stack is deep.
  const stack: { node: TreeNode; first: string; rest: string }[] = [];
  /** Queues what follows `parent`, its rows led by `rest`; a fork steps each branch in. */
  const follow = (parent: string | null, rest: string) => {
    const kids = ordered(parent);
    const forks = kids.length > 1;
    // The stack takes the last pushed first, so the branches go on in reverse.
    for (let index = kids.length - 1; index >= 0; index--) {
      const node = kids[index] as TreeNode;
      const lines = index === kids.length - 1 ? LAST : BRANCH;
      stack.push(
        forks ? { node, first: rest + lines.first, rest: rest + lines.rest } : { node, first: rest, rest },
      );
    }
  };
  follow(null, "");
  for (let next = stack.pop(); next; next = stack.pop()) {
    const { node, first, rest } = next;
    items.push(row(node, first, path.has(node.id), node.id === here, now));
    follow(node.id, rest);
  }
  return { items, here };
}

function row(node: TreeNode, lead: string, onBranch: boolean, current: boolean, now: number): PickItem {
  const mark = MARKS[node.kind as keyof typeof MARKS];
  const label = node.label ? plain(node.label).trim() : "";
  return {
    label: said(node),
    lead,
    mark: onBranch ? mark : { ...mark, colour: ASIDE },
    detail: [label, when(node.at, now)].filter(Boolean).join(" · "),
    ...(label ? { icon: { glyph: glyphs.label, colour: palette.yellow } } : {}),
    value: node.id,
    current,
    // The filter finds an entry by more than the first line its row shows.
    keywords: plain(node.text),
  };
}

/** What a row says of its entry. */
function said(node: TreeNode): string {
  const line = firstLine(node.text);
  switch (node.kind) {
    case "user":
      return line || "an image";
    case "assistant":
      // Only a step that called tools says nothing; it has a row while the session stands on it.
      return line || "tool calls";
    case "compaction":
      return node.tokens === undefined
        ? "compaction"
        : `compaction of ${node.tokens.toLocaleString("en")} tokens`;
    case "branch":
      return `branch summary · ${line}`;
    default:
      return line;
  }
}
