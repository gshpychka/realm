/**
 * `count` and `noun`, the noun plural unless the count is one: `1 tool`, `3 tools`, `0 tools`.
 * A noun that does not take an s says its plural: `counted(2, "reply", "replies")`.
 */
export function counted(count: number, noun: string, plural = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : plural}`;
}
