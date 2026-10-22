import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";

/** One entry of the session tree, as the `/tree` picker lists it. */
export interface TreeRow {
  id: string;
  /** Indented to its branch, with a marker on the path to where the session stands. */
  label: string;
  /** True for the entry the session stands on, or the nearest one listed above it. */
  current: boolean;
  /** Text the editor takes when the session moves to this entry: a prompt goes back for editing. */
  editorText?: string;
}

type Entry = SessionTreeNode["entry"];

/** Characters of an entry's text shown in its row. */
const PREVIEW = 80;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
    .join(" ");
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW - 1)}…` : flat;
}

/** What a row says for an entry worth moving to; null for bookkeeping entries. */
function describe(entry: Entry): { text: string; editorText?: string } | null {
  switch (entry.type) {
    case "message": {
      const { message } = entry;
      if (message.role === "user") {
        const text = textOf(message.content);
        return { text: `you: ${oneLine(text)}`, editorText: text };
      }
      if (message.role === "assistant") {
        const text = oneLine(textOf(message.content));
        return text ? { text: `pi: ${text}` } : null;
      }
      return null;
    }
    case "custom_message": {
      const text = textOf(entry.content);
      return { text: `[${entry.customType}] ${oneLine(text)}`, editorText: text };
    }
    case "compaction":
      return { text: `[compaction] ${oneLine(entry.summary)}` };
    case "branch_summary":
      return { text: `[branch summary] ${oneLine(entry.summary)}` };
    default:
      return null;
  }
}

/**
 * The session tree as picker rows, depth-first. A row is indented only where the tree
 * branches, so a straight conversation reads as one column.
 *
 * A conversation is a chain as deep as it is long, so the tree is walked with a stack.
 */
export function treeRows(roots: readonly SessionTreeNode[], leafId: string | null): TreeRow[] {
  const onPath = new Set<string>();
  const parents = new Map<string, string | null>();
  const entries = new Map<string, Entry>();
  const pending: { node: SessionTreeNode; parent: string | null }[] = roots.map((node) => ({
    node,
    parent: null,
  }));
  for (let next = pending.pop(); next; next = pending.pop()) {
    parents.set(next.node.entry.id, next.parent);
    entries.set(next.node.entry.id, next.node.entry);
    for (const child of next.node.children) pending.push({ node: child, parent: next.node.entry.id });
  }
  let here: string | null = null;
  for (let at = leafId; at; at = parents.get(at) ?? null) {
    onPath.add(at);
    const entry = entries.get(at);
    if (here === null && entry && describe(entry)) here = at;
  }

  const rows: TreeRow[] = [];
  const stack: { node: SessionTreeNode; level: number }[] = [];
  const visit = (nodes: readonly SessionTreeNode[], depth: number) => {
    const level = nodes.length > 1 ? depth + 1 : depth;
    for (let at = nodes.length - 1; at >= 0; at--) {
      const node = nodes[at];
      if (node) stack.push({ node, level });
    }
  };
  visit(roots, 0);
  for (let next = stack.pop(); next; next = stack.pop()) {
    const { node, level } = next;
    const shown = describe(node.entry);
    if (shown) {
      const mark = node.entry.id === here ? "◆" : onPath.has(node.entry.id) ? "•" : " ";
      const label = node.label ? ` (${node.label})` : "";
      rows.push({
        id: node.entry.id,
        label: `${"  ".repeat(level)}${mark} ${shown.text}${label}`,
        current: node.entry.id === here,
        editorText: shown.editorText,
      });
    }
    visit(node.children, level);
  }
  return rows;
}
