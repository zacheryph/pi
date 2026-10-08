import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { sanitizeTodoText } from "./ui/text.ts";

export interface TodoConfig {
  widget: boolean;
  maxVisible: number;
  showCompleted: boolean;
  singleActive: boolean;
  confirmClear: boolean;
  contextSync: "changes" | "off";
}
export const DEFAULT_CONFIG: TodoConfig = {
  widget: true, maxVisible: 5, showCompleted: true, singleActive: false,
  confirmClear: true, contextSync: "changes",
};
export const CONFIG_FILE = "todos.json";

export function sanitizeConfig(raw: unknown): Partial<TodoConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const config: Partial<TodoConfig> = {};
  for (const key of ["widget", "showCompleted", "singleActive", "confirmClear"] as const) {
    if (typeof input[key] === "boolean") config[key] = input[key];
  }
  if (typeof input.maxVisible === "number" && Number.isInteger(input.maxVisible) && input.maxVisible >= 1 && input.maxVisible <= 12) {
    config.maxVisible = input.maxVisible;
  }
  if (input.contextSync === "changes" || input.contextSync === "off") config.contextSync = input.contextSync;
  return config;
}

function readLayer(path: string): Partial<TodoConfig> {
  try {
    return sanitizeConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(sanitizeTodoText(`[pi-todo] Ignoring settings at ${path}: ${error instanceof Error ? error.message : String(error)}`));
    }
    return {};
  }
}

/** Same layering as subagents, without requiring its package to be installed. */
export function loadTodoConfig(cwd: string, agentDir = getAgentDir()): TodoConfig {
  return { ...DEFAULT_CONFIG, ...readLayer(join(agentDir, CONFIG_FILE)), ...readLayer(join(cwd, ".pi", CONFIG_FILE)) };
}

export function saveTodoConfig(cwd: string, patch: Partial<TodoConfig>): void {
  const path = join(cwd, ".pi", CONFIG_FILE);
  // Do not silently destroy malformed project settings on write.
  let existing: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Settings must be a JSON object");
    existing = value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...existing, ...sanitizeConfig(patch) }, null, 2)}\n`, "utf8");
}
