import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { TodoRequest } from "./actions.ts";
import type { TodoConfig } from "./config.ts";
import { cloneTodoState, type TodoState, type TodoTaskInput } from "./state.ts";
import { showTodoBrowser } from "./ui/browser.ts";
import { sanitizeTodoText } from "./ui/text.ts";

export interface TodoController {
  state(): TodoState;
  config(): TodoConfig;
  branchToken(): number;
  mutate(request: TodoRequest, ctx: ExtensionCommandContext): void;
  configure(patch: Partial<TodoConfig>, ctx: ExtensionCommandContext): void;
}

export function registerTodoCommands(pi: ExtensionAPI, controller: TodoController): void {
  const register = (name: string, description: string,
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void) => {
    pi.registerCommand(name, { description, handler: async (args, ctx) => {
      try { await handler(args.trim(), ctx); }
      catch (error) { ctx.ui.notify(sanitizeTodoText(error instanceof Error ? error.message : String(error)), "error"); }
    } });
  };
  const list = async (_args: string, ctx: ExtensionCommandContext) => {
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify("Task browser requires TUI mode. Use todo(action: list) in other modes.", "warning");
      return;
    }
    await showTodoBrowser(ctx, cloneTodoState(controller.state()));
  };
  register("todos", "Browse session tasks (alias for /todos:list)", list);
  register("todos:list", "Browse/search session tasks and dependency details", list);
  register("todos:add", "Append a task: /todos:add <subject> (never starts agent)", async (args, ctx) => {
    const session = ctx.sessionManager.getSessionId();
    const branch = controller.branchToken();
    const subject = args || (ctx.hasUI ? await ctx.ui.input("New task subject") : undefined);
    if (!subject?.trim()) return;
    guardSession(ctx, session, branch, controller);
    const key = newTaskKey(subject, controller.state());
    controller.mutate({ action: "upsert", tasks: [{ key, subject }] }, ctx);
    ctx.ui.notify(`Added ${key} (pending). Agent sees change on its next request.`, "info");
  });
  register("todos:update", 'Edit task: /todos:update <key> <status|JSON patch>', (args, ctx) => {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(args);
    if (!match) throw new Error('Usage: /todos:update <key> <pending|in_progress|completed|JSON patch>');
    const [, key, value] = match;
    if (!controller.state().tasks.some((task) => task.key === key)) throw new Error(`Unknown task: ${key}`);
    const patch: unknown = value.startsWith("{") ? JSON.parse(value) : { status: value };
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Patch must be a JSON object");
    const fields = patch as Record<string, unknown>;
    if (Object.keys(fields).some((field) => !["subject", "description", "status", "dependsOn"].includes(field))) {
      throw new Error("Patch fields: subject, description, status, dependsOn");
    }
    if (Object.keys(fields).length === 0) throw new Error("Patch requires at least one field");
    if (fields.subject !== undefined && typeof fields.subject !== "string") throw new Error("subject must be a string");
    if (fields.description !== undefined && typeof fields.description !== "string") throw new Error("description must be a string");
    if (fields.status !== undefined && !["pending", "in_progress", "completed"].includes(String(fields.status))) {
      throw new Error("status must be pending, in_progress, or completed");
    }
    if (fields.dependsOn !== undefined && (!Array.isArray(fields.dependsOn) || fields.dependsOn.some((key) => typeof key !== "string"))) {
      throw new Error("dependsOn must be an array of task keys");
    }
    controller.mutate({ action: "upsert", tasks: [{ ...fields, key } as TodoTaskInput] }, ctx);
    ctx.ui.notify(`Updated ${key}.`, "info");
  });
  register("todos:remove", "Remove tasks: /todos:remove <key> [key ...]; refuses dangling dependencies", (args, ctx) => {
    if (!args) throw new Error("Usage: /todos:remove <key> [key ...]");
    controller.mutate({ action: "remove", keys: args.split(/\s+/) }, ctx);
    ctx.ui.notify("Removed tasks. Agent sees change on its next request.", "info");
  });
  register("todos:clear", "Clear tasks: /todos:clear [all|completed] [--yes]; completed keeps needed blockers", async (args, ctx) => {
    const parts = args ? args.split(/\s+/) : [];
    if (parts.some((part) => !["all", "completed", "--yes"].includes(part)) ||
      (parts.includes("all") && parts.includes("completed"))) throw new Error("Usage: /todos:clear [all|completed] [--yes]");
    const scope = parts.includes("completed") ? "completed" : "all";
    const revision = controller.state().revision;
    const session = ctx.sessionManager.getSessionId();
    const branch = controller.branchToken();
    if (!controller.state().tasks.length) { ctx.ui.notify("Task list already empty.", "info"); return; }
    if (scope === "all" && controller.config().confirmClear && !parts.includes("--yes")) {
      if (!ctx.hasUI) throw new Error("Use /todos:clear all --yes without UI");
      if (!(await ctx.ui.confirm("Clear task list?", "Remove every task from this branch? Session history remains available."))) return;
    }
    guardSession(ctx, session, branch, controller);
    controller.mutate({ action: "clear", scope, baseRevision: revision }, ctx);
    ctx.ui.notify(scope === "all" ? "Cleared task list." : "Cleared unneeded completed tasks; prerequisites of open work retained.", "info");
  });
  register("todos:settings", "Configure task display and policies (project overrides global defaults)", async (_args, ctx) => {
    if (!ctx.hasUI) { ctx.ui.notify("Task settings require UI. Edit .pi/todos.json instead.", "warning"); return; }
    const config = controller.config();
    const session = ctx.sessionManager.getSessionId();
    const branch = controller.branchToken();
    const items: [keyof TodoConfig, string][] = [
      ["widget", "Show widget"], ["maxVisible", "Visible tasks"], ["showCompleted", "Show completed"],
      ["singleActive", "Single active task"], ["confirmClear", "Confirm clear-all"], ["contextSync", "Model state sync"],
    ];
    const choices = items.map(([key, label]) => `${label} (current: ${config[key]})`);
    const choice = await ctx.ui.select("Task settings", choices);
    const index = choice === undefined ? -1 : choices.indexOf(choice);
    if (index < 0) return;
    const key = items[index][0];
    let patch: Partial<TodoConfig>;
    if (key === "maxVisible") {
      const text = await ctx.ui.input("Visible tasks (1–12)", String(config.maxVisible));
      if (text === undefined) return;
      if (!/^\d+$/.test(text.trim()) || Number(text) < 1 || Number(text) > 12) throw new Error("Visible tasks must be an integer from 1 to 12");
      patch = { maxVisible: Number(text) };
    } else if (key === "contextSync") {
      const value = await ctx.ui.select("Model state sync (context-only, never starts a turn)", ["changes", "off"]);
      if (value !== "changes" && value !== "off") return;
      patch = { contextSync: value };
    } else {
      patch = { [key]: !config[key] };
    }
    guardSession(ctx, session, branch, controller);
    controller.configure(patch, ctx);
  });
}

function guardSession(ctx: ExtensionCommandContext, expected: string, branch: number, controller: TodoController): void {
  if (ctx.sessionManager.getSessionId() !== expected) throw new Error("Session changed while command was open; reopen command");
  if (controller.branchToken() !== branch) throw new Error("Branch changed while command was open; reopen command");
}

export function newTaskKey(subject: string, state: TodoState): string {
  const base = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "task";
  let key = base;
  for (let suffix = 2; state.tasks.some((task) => task.key === key); suffix++) key = `${base}-${suffix}`;
  return key;
}
