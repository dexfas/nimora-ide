import type { TaskProgress, TaskTodo } from "../../../src/task-contract.js";

const MAX_TODOS = 24;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export interface NormalizedBridgeProgress {
  progress: Omit<TaskProgress, "at">;
  linkedTodo?: TaskTodo;
}

export function normalizeBridgeTodos(value: unknown): TaskTodo[] {
  const input = asRecord(value);
  if (!Array.isArray(input.todos)) throw new Error("set_todos.todos must be an array.");
  if (input.todos.length > MAX_TODOS) throw new Error(`set_todos.todos must contain at most ${MAX_TODOS} items.`);

  const seen = new Set<string>();
  const todos: TaskTodo[] = input.todos.map((raw, index) => {
    const item = asRecord(raw);
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const status = item.status;
    if (!id || id.length > 80) throw new Error(`set_todos.todos[${index}].id must be 1-80 characters.`);
    if (seen.has(id)) throw new Error(`set_todos.todos contains duplicate id: ${id}`);
    seen.add(id);
    if (!title || title.length > 400) throw new Error(`set_todos.todos[${index}].title must be 1-400 characters.`);
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new Error(`set_todos.todos[${index}].status must be pending, in_progress, or completed.`);
    }
    return { id, title, status };
  });

  if (todos.filter(todo => todo.status === "in_progress").length > 1) {
    throw new Error("set_todos supports at most one in_progress todo.");
  }
  return todos;
}

export function normalizeBridgeProgress(value: unknown, todos: readonly TaskTodo[]): NormalizedBridgeProgress {
  const input = asRecord(value);
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!message) throw new Error("report_progress.message must be a non-empty string.");
  if (message.length > 2_000) throw new Error("report_progress.message must be at most 2000 characters.");

  const phase = typeof input.phase === "string" ? input.phase.trim().slice(0, 160) : undefined;
  let percent: number | undefined;
  if (input.percent !== undefined) {
    if (!Number.isInteger(input.percent) || Number(input.percent) < 0 || Number(input.percent) > 100) {
      throw new Error("report_progress.percent must be an integer from 0 to 100.");
    }
    percent = Number(input.percent);
  }

  const requestedTodoId = typeof input.todo_id === "string" ? input.todo_id.trim() : "";
  let linkedTodo: TaskTodo | undefined;
  if (requestedTodoId) {
    linkedTodo = todos.find(todo => todo.id === requestedTodoId);
    if (!linkedTodo) throw new Error(`report_progress.todo_id does not match a current todo: ${requestedTodoId}`);
  } else {
    linkedTodo = todos.find(todo => todo.status === "in_progress");
  }

  return {
    progress: {
      message,
      phase,
      percent,
      todoId: linkedTodo?.id,
    },
    linkedTodo: linkedTodo ? { ...linkedTodo } : undefined,
  };
}
