import {
  loadLayeredSettings,
  patchSettingsFile,
} from "../../../packages/pi-foundations/src/settings.ts";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { sanitizeTodoText } from "./ui/text.ts";

export interface TodoConfig {
  widget: boolean;
  maxVisible: number;
  showCompleted: boolean;
  singleActive: boolean;
  confirmClear: boolean;
  contextSync: "changes" | "off";
  /** Let a subagent with a `ledger` claim add prerequisites to tasks it does not hold. */
  childPrerequisites: boolean;
}
export const DEFAULT_CONFIG: TodoConfig = {
  widget: true,
  maxVisible: 5,
  showCompleted: true,
  singleActive: false,
  confirmClear: true,
  contextSync: "changes",
  childPrerequisites: true,
};
export const CONFIG_FILE = "todos.json";

export function sanitizeConfig(raw: unknown): Partial<TodoConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const config: Partial<TodoConfig> = {};
  for (const key of [
    "widget",
    "showCompleted",
    "singleActive",
    "confirmClear",
    "childPrerequisites",
  ] as const) {
    if (typeof input[key] === "boolean") config[key] = input[key];
  }
  if (
    typeof input.maxVisible === "number" &&
    Number.isInteger(input.maxVisible) &&
    input.maxVisible >= 1 &&
    input.maxVisible <= 12
  ) {
    config.maxVisible = input.maxVisible;
  }
  if (input.contextSync === "changes" || input.contextSync === "off")
    config.contextSync = input.contextSync;
  return config;
}

/** Same layering as subagents, without requiring its package to be installed. */
export function loadTodoConfig(cwd: string, agentDir = getAgentDir()): TodoConfig {
  return {
    ...DEFAULT_CONFIG,
    ...loadLayeredSettings<TodoConfig>({
      agentDir,
      cwd,
      filename: CONFIG_FILE,
      sanitize: sanitizeConfig,
      warnLabel: "pi-todo",
      onError: (path, error) =>
        console.warn(
          sanitizeTodoText(
            `[pi-todo] Ignoring settings at ${path}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
    }),
  };
}

export function saveTodoConfig(cwd: string, patch: Partial<TodoConfig>): void {
  const path = join(cwd, ".pi", CONFIG_FILE);
  patchSettingsFile(path, sanitizeConfig(patch));
}
