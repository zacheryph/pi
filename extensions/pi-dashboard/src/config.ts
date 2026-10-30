import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PORT } from "./protocol.ts";

export interface DashboardConfig {
  port: number;
  /** Node binary for the hub; defaults to Pi's own runtime. */
  node?: string;
}

export const DEFAULT_CONFIG: DashboardConfig = { port: DEFAULT_PORT };

export function configPath(agentDir = getAgentDir()): string {
  return join(agentDir, "dashboard.json");
}

/** Global only: one hub serves every project. Invalid fields fall back to defaults. */
export function loadDashboardConfig(path = configPath()): DashboardConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
  const value = raw as Record<string, unknown>;
  const port = Number.isInteger(value.port) && (value.port as number) > 0 && (value.port as number) <= 65_535
    ? value.port as number
    : DEFAULT_PORT;
  const node = typeof value.node === "string" && value.node.trim() ? value.node.trim() : undefined;
  return { port, ...(node ? { node } : {}) };
}
