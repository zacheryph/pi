import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Parameters for one layered settings load: describes where the files live,
 * how to validate their contents, and what label to use in warnings.
 *
 * @public
 */
export interface LayeredSettingsSource<T> {
  /** Directory holding the global settings file (typically the Pi agent dir). */
  agentDir: string;
  /** Project root; the project file lives at `<cwd>/.pi/<filename>`. */
  cwd: string;
  /** Base filename for both layers, e.g. `"subagents.json"`. */
  filename: string;
  /**
   * Validate and coerce parsed JSON into a partial settings object.
   * Unknown or invalid fields should be silently dropped — return `{}` for
   * unrecognised shapes. Never throw.
   */
  sanitize: (raw: unknown) => Partial<T>;
  /**
   * Short label used in the malformed-file warning prefix,
   * e.g. `"pi-subagents"` → `"[pi-subagents] Ignoring malformed settings at …"`.
   */
  warnLabel: string;
  /** Override error reporting (e.g. terminal-safe warnings). */
  onError?: (path: string, error: unknown) => void;
}

/**
 * Load merged layered settings: global provides defaults, project overrides.
 *
 * - A missing file is silent — returns `{}` for that layer.
 * - A file that exists but cannot be parsed warns to stderr and returns `{}` for
 *   that layer, so startup proceeds normally.
 * - The two layers are merged with a shallow spread; project keys win.
 *
 * By default errors warn and fall back to `{}`. A custom error callback may throw.
 *
 * @public
 */
export function loadLayeredSettings<T>(source: LayeredSettingsSource<T>): Partial<T> {
  const { agentDir, cwd, filename, sanitize, warnLabel } = source;
  const read = (path: string) =>
    readSettingsFile(path, sanitize, (error) => {
      if (source.onError) source.onError(path, error);
      else {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[${warnLabel}] Ignoring malformed settings at ${path}: ${reason}`);
      }
    });
  const global = read(join(agentDir, filename));
  const project = read(join(cwd, ".pi", filename));
  return { ...global, ...project };
}

/** Missing files are absent; callers choose whether other failures throw, warn or fall back. */
export function readSettingsFile<T>(
  path: string,
  sanitize: (raw: unknown) => Partial<T>,
  onError?: (error: unknown) => void,
): Partial<T> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (!onError) throw error;
    onError(error);
    return {};
  }
  try {
    return sanitize(JSON.parse(raw));
  } catch (error) {
    if (!onError) throw error;
    onError(error);
    return {};
  }
}

/** Write JSON after creating its parent directory; errors remain the caller's decision. */
export function writeSettingsFile(path: string, value: unknown, trailingNewline = false): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + (trailingNewline ? "\n" : ""), "utf8");
}

/** Preserve unknown keys and refuse to overwrite malformed/non-object existing settings. */
export function patchSettingsFile(path: string, patch: object): void {
  const existing = readSettingsFile<Record<string, unknown>>(path, (raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("Settings must be a JSON object");
    return raw as Record<string, unknown>;
  });
  writeSettingsFile(path, { ...existing, ...patch }, true);
}
