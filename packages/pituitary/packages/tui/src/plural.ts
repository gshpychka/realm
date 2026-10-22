/** `count` and `noun`, the noun plural unless the count is one: `1 tool`, `3 tools`, `0 tools`. */
export function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
