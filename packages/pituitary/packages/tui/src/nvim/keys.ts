/** The parts of a key event that name it. */
export interface KeyLike {
  name: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/** Keys nvim names in angle brackets, by the name the key event carries. */
const NAMED: Record<string, string> = {
  return: "CR",
  enter: "CR",
  kpenter: "CR",
  escape: "Esc",
  backspace: "BS",
  delete: "Del",
  tab: "Tab",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  insert: "Insert",
  space: "Space",
};

/**
 * The key in nvim's key notation (`:help key-notation`), or null for a key nvim has no
 * name for. Text keys come through as themselves, with `<` spelled `<lt>`.
 */
export function toNvim(key: KeyLike): string | null {
  const mods = `${key.ctrl ? "C-" : ""}${key.meta ? "M-" : ""}`;
  // Terminals send ctrl+j as a line feed, which reaches here under its own name.
  if (key.name === "linefeed") return "<C-j>";
  const named = NAMED[key.name] ?? (/^f\d{1,2}$/.test(key.name) ? key.name.toUpperCase() : undefined);
  if (named) {
    if (named === "Space" && !mods && !key.shift) return " ";
    return `<${mods}${key.shift ? "S-" : ""}${named}>`;
  }
  const text = key.sequence && !/\p{Cc}/u.test(key.sequence) ? key.sequence : key.name;
  if ([...text].length !== 1) return null;
  if (!mods) return text === "<" ? "<lt>" : text;
  const letter = key.shift ? text.toUpperCase() : text;
  return `<${mods}${letter === "<" ? "lt" : letter}>`;
}
