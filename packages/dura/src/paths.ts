import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.())
    throw new Error(`Expected a directory owned by the operator: ${path}`);
  chmodSync(path, 0o700);
}

export function socketDirectory(root: string): string {
  const namespace = createHash("sha256")
    .update(resolve(root))
    .digest("hex")
    .slice(0, 16);
  const parent = `/tmp/dura-${process.getuid?.() ?? "operator"}`;
  return join(parent, namespace);
}
