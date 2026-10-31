import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface StashConfig {
  /** Delete content not read or written for this many days. */
  retentionDays: number;
  /** Reject entries larger than this. */
  maxEntryBytes: number;
  /** Warn in /stash when the store is larger than this. */
  maxStoreBytes: number;
}

export const DEFAULT_CONFIG: StashConfig = {
  retentionDays: 30,
  maxEntryBytes: 20 * 1024 * 1024,
  maxStoreBytes: 1024 * 1024 * 1024,
};
export const CONFIG_FILE = "stash.json";

export function sanitizeConfig(raw: unknown): Partial<StashConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const config: Partial<StashConfig> = {};
  if (
    typeof input.retentionDays === "number" &&
    Number.isFinite(input.retentionDays) &&
    input.retentionDays > 0
  ) {
    config.retentionDays = input.retentionDays;
  }
  for (const key of ["maxEntryBytes", "maxStoreBytes"] as const) {
    const value = input[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) config[key] = value;
  }
  return config;
}

/**
 * Global only (`<agent dir>/stash.json`): the store is shared by every project,
 * so a project file must not shorten retention for everyone else's entries.
 */
export function loadStashConfig(agentDir = getAgentDir()): StashConfig {
  const path = join(agentDir, CONFIG_FILE);
  try {
    return { ...DEFAULT_CONFIG, ...sanitizeConfig(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[pi-stash] Ignoring settings at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { ...DEFAULT_CONFIG };
  }
}
