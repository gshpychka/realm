import { describe, expect, test } from "bun:test";
import type { Widget } from "@pituitary/rpc";
import type { Task } from "../details.ts";
import { besideTodo } from "./widgets.tsx";

const rpivTodo: Widget = { key: "rpiv-todos", lines: ["● Todos (0/1)"], placement: "aboveEditor" };
const plan: Widget = { key: "plan-mode-plan", lines: ["plan: 1. read"], placement: "aboveEditor" };
const tasks: Task[] = [{ id: 1, subject: "Read limits.ts", status: "pending" }];

describe("besideTodo", () => {
  test("rpiv-todo's widget gives way to the panel, which draws the same list", () => {
    expect(besideTodo([rpivTodo, plan], tasks)).toEqual([plan]);
  });

  test("rpiv-todo's widget stays while the conversation holds no list, as after a compaction", () => {
    expect(besideTodo([rpivTodo, plan], [])).toEqual([rpivTodo, plan]);
  });
});
