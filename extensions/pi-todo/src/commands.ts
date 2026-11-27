import { errorText } from "#foundations/errors";
import type { UserOutput } from "#foundations/user-output";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { latestTodoMessage, type TodoActivity } from "#src/activity";
import type { TodoRequest, TodoTaskPatch } from "#src/actions";
import type { TodoConfig } from "#src/config";
import { cloneTodoState, type TodoState } from "#src/state";
import { showTodoBrowser } from "#src/ui/browser";
import { renderTodoText } from "#src/ui/render";
import { sanitizeText } from "#ui";

export interface TodoController {
  /** Where command results go: a notification in the terminal, a displayed message elsewhere. */
  output: UserOutput;
  state(): TodoState;
  config(): TodoConfig;
  activity(): TodoActivity;
  /** Subagent holding each delegated task, as a display label. */
  assignees(): ReadonlyMap<string, string>;
  branchToken(): number;
  /** Completed tasks archived off the list. */
  archived(): number;
  /** Command edits are recorded as user updates. */
  mutate(request: TodoRequest, ctx: ExtensionCommandContext): void;
  configure(patch: Partial<TodoConfig>, ctx: ExtensionCommandContext): void;
}

/** Rows of the task listing outside the terminal browser; the rest is counted. */
const MAX_LISTED_TASKS = 40;

export function registerTodoCommands(pi: ExtensionAPI, controller: TodoController): void {
  const register = (
    name: string,
    description: string,
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void,
  ) => {
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        try {
          await handler(args.trim(), ctx);
        } catch (error) {
          controller.output.show(ctx, sanitizeText(errorText(error)), "error");
        }
      },
    });
  };
  const browse = async (ctx: ExtensionCommandContext) => {
    await showTodoBrowser(ctx, cloneTodoState(controller.state()), {
      activity: controller.activity(),
      assignees: controller.assignees(),
      archived: controller.archived(),
      // Details go through todo.inspect on this session's bus.
      actions: pi.events,
    });
  };
  /** The browser's content as text, for a host without the terminal UI. */
  const listing = (): string => {
    const state = controller.state();
    const archived = controller.archived();
    const activity = controller.activity();
    return [
      ...renderTodoText(state, {
        maxVisible: MAX_LISTED_TASKS,
        showCompleted: true,
        assignees: controller.assignees(),
        messages: new Map(
          state.tasks.flatMap((task) => {
            const message = latestTodoMessage(task.key, activity)?.message;
            return message ? [[task.key, message] as const] : [];
          }),
        ),
      }),
      ...(archived > 0
        ? [`${archived} earlier completed task${archived === 1 ? "" : "s"} archived.`]
        : []),
      "Change tasks with /todo:add, /todo:update, /todo:remove or /todo:clear.",
    ].join("\n");
  };
  const list = async (_args: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      controller.output.show(ctx, listing(), "info");
      return;
    }
    await browse(ctx);
  };
  register("todo", "Browse/search session tasks and dependency details", list);
  register(
    "todo:add",
    "Append a task: /todo:add <subject> (never starts agent)",
    async (args, ctx) => {
      const session = ctx.sessionManager.getSessionId();
      const branch = controller.branchToken();
      const subject = args || (ctx.hasUI ? await ctx.ui.input("New task subject") : undefined);
      if (!subject?.trim()) {
        // A cancelled dialog is an answer; with no dialog to ask, say what to type.
        if (!ctx.hasUI) throw new Error("Usage: /todo:add <subject>");
        return;
      }
      guardSession(ctx, session, branch, controller);
      const key = newTaskKey(subject, controller.state());
      controller.mutate({ action: "upsert", tasks: [{ key, subject }] }, ctx);
      controller.output.show(
        ctx,
        `Added ${key} (pending). Agent sees change on its next request.`,
        "info",
      );
    },
  );
  register(
    "todo:update",
    "Edit task: /todo:update <key> <status> [message] | <key> <JSON patch>",
    (args, ctx) => {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(args);
      if (!match)
        throw new Error(
          "Usage: /todo:update <key> <pending|in_progress|completed> [message] | <key> <JSON patch>",
        );
      const [, key, value] = match;
      if (!controller.state().tasks.some((task) => task.key === key))
        throw new Error(`Unknown task: ${key}`);
      const [, status, message] = /^(\S+)(?:\s+([\s\S]+))?$/.exec(value)!;
      const patch: unknown = value.startsWith("{")
        ? JSON.parse(value)
        : { status, ...(message ? { message } : {}) };
      if (!patch || typeof patch !== "object" || Array.isArray(patch))
        throw new Error("Patch must be a JSON object");
      const fields = patch as Record<string, unknown>;
      if (
        Object.keys(fields).some(
          (field) => !["subject", "description", "status", "dependsOn", "message"].includes(field),
        )
      ) {
        throw new Error("Patch fields: subject, description, status, dependsOn, message");
      }
      if (Object.keys(fields).length === 0) throw new Error("Patch requires at least one field");
      if (fields.subject !== undefined && typeof fields.subject !== "string")
        throw new Error("subject must be a string");
      if (fields.description !== undefined && typeof fields.description !== "string")
        throw new Error("description must be a string");
      if (fields.message !== undefined && typeof fields.message !== "string")
        throw new Error("message must be a string");
      if (
        fields.status !== undefined &&
        (typeof fields.status !== "string" ||
          !["pending", "in_progress", "completed"].includes(fields.status))
      ) {
        throw new Error("status must be pending, in_progress, or completed");
      }
      if (
        fields.dependsOn !== undefined &&
        (!Array.isArray(fields.dependsOn) ||
          fields.dependsOn.some((key) => typeof key !== "string"))
      ) {
        throw new Error("dependsOn must be an array of task keys");
      }
      controller.mutate({ action: "upsert", tasks: [{ ...fields, key } as TodoTaskPatch] }, ctx);
      controller.output.show(ctx, `Updated ${key}.`, "info");
    },
  );
  register(
    "todo:remove",
    "Remove tasks: /todo:remove <key> [key ...]; refuses dangling dependencies",
    (args, ctx) => {
      if (!args) throw new Error("Usage: /todo:remove <key> [key ...]");
      controller.mutate({ action: "remove", keys: args.split(/\s+/) }, ctx);
      controller.output.show(ctx, "Removed tasks. Agent sees change on its next request.", "info");
    },
  );
  register(
    "todo:clear",
    "Clear tasks: /todo:clear [all|completed] [--yes]; completed archives finished tasks",
    async (args, ctx) => {
      const parts = args ? args.split(/\s+/) : [];
      if (
        parts.some((part) => !["all", "completed", "--yes"].includes(part)) ||
        (parts.includes("all") && parts.includes("completed"))
      )
        throw new Error("Usage: /todo:clear [all|completed] [--yes]");
      const scope = parts.includes("completed") ? "completed" : "all";
      const revision = controller.state().revision;
      const session = ctx.sessionManager.getSessionId();
      const branch = controller.branchToken();
      if (!controller.state().tasks.length) {
        controller.output.show(ctx, "Task list already empty.", "info");
        return;
      }
      if (scope === "all" && controller.config().confirmClear && !parts.includes("--yes")) {
        if (!ctx.hasUI) throw new Error("Use /todo:clear all --yes without UI");
        if (
          !(await ctx.ui.confirm(
            "Clear task list?",
            "Remove every task from this branch? Session history remains available.",
          ))
        )
          return;
      }
      guardSession(ctx, session, branch, controller);
      controller.mutate({ action: "clear", scope, baseRevision: revision }, ctx);
      controller.output.show(
        ctx,
        scope === "all" ? "Cleared task list." : "Archived completed tasks.",
        "info",
      );
    },
  );
  register(
    "todo:settings",
    "Configure task display and policies (project overrides global defaults)",
    async (_args, ctx) => {
      if (!ctx.hasUI) {
        controller.output.show(
          ctx,
          "Task settings require UI. Edit .pi/todo.json instead.",
          "warning",
        );
        return;
      }
      const config = controller.config();
      const session = ctx.sessionManager.getSessionId();
      const branch = controller.branchToken();
      const items: [keyof TodoConfig, string][] = [
        ["widget", "Show widget"],
        ["maxVisible", "Visible tasks"],
        ["showCompleted", "Show completed"],
        ["singleActive", "Single active task"],
        ["confirmClear", "Confirm clear-all"],
        ["contextSync", "Model state sync"],
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
        if (!/^\d+$/.test(text.trim()) || Number(text) < 1 || Number(text) > 12)
          throw new Error("Visible tasks must be an integer from 1 to 12");
        patch = { maxVisible: Number(text) };
      } else if (key === "contextSync") {
        const value = await ctx.ui.select("Model state sync (context-only, never starts a turn)", [
          "changes",
          "off",
        ]);
        if (value !== "changes" && value !== "off") return;
        patch = { contextSync: value };
      } else {
        patch = { [key]: !config[key] };
      }
      guardSession(ctx, session, branch, controller);
      controller.configure(patch, ctx);
    },
  );
}

function guardSession(
  ctx: ExtensionCommandContext,
  expected: string,
  branch: number,
  controller: TodoController,
): void {
  if (ctx.sessionManager.getSessionId() !== expected)
    throw new Error("Session changed while command was open; reopen command");
  if (controller.branchToken() !== branch)
    throw new Error("Branch changed while command was open; reopen command");
}

export function newTaskKey(subject: string, state: TodoState): string {
  const base =
    subject
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30) || "task";
  let key = base;
  for (let suffix = 2; state.tasks.some((task) => task.key === key); suffix++)
    key = `${base}-${suffix}`;
  return key;
}
