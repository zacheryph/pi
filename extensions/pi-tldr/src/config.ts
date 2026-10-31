import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface TldrConfig {
  /** auto prefers the most recent available Haiku, then Luna. */
  model: string;
  /** Controls automatic session naming (Pi manages the terminal title). */
  setSessionName: boolean;
}

export const DEFAULT_CONFIG: Readonly<TldrConfig> = {
  model: "auto",
  setSessionName: true,
};

function readConfig(path: string): Partial<TldrConfig> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path}: invalid JSON: ${String(error)}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const record = data as Record<string, unknown>;
  if (record.model !== undefined && (typeof record.model !== "string" || !record.model.trim())) {
    throw new Error(`${path}: model must be a nonempty string`);
  }
  if (record.setSessionName !== undefined && typeof record.setSessionName !== "boolean") {
    throw new Error(`${path}: setSessionName must be true or false`);
  }
  return {
    ...(typeof record.model === "string" ? { model: record.model.trim() } : {}),
    ...(typeof record.setSessionName === "boolean"
      ? { setSessionName: record.setSessionName }
      : {}),
  };
}

/** Project settings override global settings. No configuration is written implicitly. */
export function loadTldrConfig(cwd: string, agentDir = getAgentDir()): TldrConfig {
  return {
    ...DEFAULT_CONFIG,
    ...readConfig(join(agentDir, "tldr.json")),
    ...readConfig(join(cwd, ".pi", "tldr.json")),
  };
}
