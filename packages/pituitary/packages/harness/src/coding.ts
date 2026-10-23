import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";

const path = Type.Optional(
  Type.String({
    description: "File or directory relative to the assigned workspace. Defaults to the workspace.",
  }),
);
const ls = defineTool({
  name: "ls",
  description: "List a directory, with directories first. Paths are relative to the assigned workspace.",
  parameters: Type.Object({ path, limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }),
  replay: "safe",
  execute: async (args, api, context) => {
    if (!api.env) throw new Error("This agent has no filesystem environment");
    const result = await api.env.listDir(args.path ?? ".", context);
    if (!result.ok) throw result.error;
    const entries = [...result.value].sort(
      (a, b) =>
        (a.kind === "directory" ? 0 : 1) - (b.kind === "directory" ? 0 : 1) || a.name.localeCompare(b.name),
    );
    const limit = args.limit ?? 500;
    return {
      output: [
        {
          type: "text",
          text:
            entries
              .slice(0, limit)
              .map(
                (entry) =>
                  entry.name + (entry.kind === "directory" ? "/" : entry.kind === "symlink" ? "@" : ""),
              )
              .join("\n") + (entries.length > limit ? `\n… ${entries.length - limit} more entries` : ""),
        },
      ],
    };
  },
});
const find = defineTool({
  name: "find",
  description:
    "Find files by glob relative to the assigned workspace. Respects ignore files and does not follow symbolic links.",
  parameters: Type.Object({
    pattern: Type.String({ description: "Glob such as **/*.ts or **/package.json" }),
    path,
  }),
  replay: "safe",
  outputLimits: { maxBytes: 65536, maxLines: 2000 },
  execute: async (args, api, context) => {
    if (!api.env) throw new Error("This agent has no filesystem environment");
    const result = await api.env.exec(
      [
        "rg",
        "--files",
        "--hidden",
        "--glob",
        "!.git",
        "--type-add",
        `pituitary:${args.pattern}`,
        "--type",
        "pituitary",
        "--",
        args.path ?? ".",
      ],
      {
        timeout: 30,
        window: api.outputWindow,
        onOutput: (chunk, _context, info) => api.output(chunk, info.skipped),
      },
      context,
    );
    if (!result.ok) throw result.error;
    return { isError: result.value.exitCode > 1, details: { exitCode: result.value.exitCode } };
  },
});
const grep = defineTool({
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns matching lines with file paths and line numbers, respecting ignore files.",
  parameters: Type.Object({
    pattern: Type.String(),
    path,
    glob: Type.Optional(Type.String()),
    ignoreCase: Type.Optional(Type.Boolean()),
    literal: Type.Optional(Type.Boolean()),
    context: Type.Optional(Type.Integer({ minimum: 0, maximum: 20 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
  }),
  replay: "safe",
  outputLimits: { maxBytes: 65536, maxLines: 2000 },
  execute: async (args, api, context) => {
    if (!api.env) throw new Error("This agent has no filesystem environment");
    const command = [
      "rg",
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      "--max-count",
      String(args.limit ?? 100),
      ...(args.glob ? ["--type-add", `pituitary:${args.glob}`, "--type", "pituitary"] : []),
      ...(args.ignoreCase ? ["--ignore-case"] : []),
      ...(args.literal ? ["--fixed-strings"] : []),
      ...(args.context ? ["--context", String(args.context)] : []),
      "-e",
      args.pattern,
      "--",
      args.path ?? ".",
    ];
    const result = await api.env.exec(
      command,
      {
        timeout: 30,
        window: api.outputWindow,
        onOutput: (chunk, _context, info) => api.output(chunk, info.skipped),
      },
      context,
    );
    if (!result.ok) throw result.error;
    return { isError: result.value.exitCode > 1, details: { exitCode: result.value.exitCode } };
  },
});
/** One registry, filtered directly by each declarative role's tool names. */
export const codingTools: readonly ToolRegistration[] = [
  createReadTool(),
  createEditTool(),
  createWriteTool(),
  createBashTool(),
  grep,
  find,
  ls,
];
export const codingExtension = defineExtension({ name: "coding", tools: [...codingTools] });
