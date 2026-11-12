import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defer, type Defer } from "#src/cleanup";

/**
 * A fresh directory under the system temp dir, removed when `cleanup` runs.
 * Keep `prefix` short where the path ends up in a unix socket (about 104 bytes on macOS).
 */
export function tempDir(cleanup: Defer, prefix = "pi-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  defer(cleanup, () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Write files under `root`, creating parent directories. Objects are written as
 * pretty JSON, strings as they are.
 */
export function writeFiles(root: string, files: Record<string, string | object>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
}

export interface SettingsDirs {
  /** Holds both scopes; removed when the test ends. */
  root: string;
  /** Global scope: pass as `agentDir`. */
  agentDir: string;
  /** Project scope: pass as `cwd`. */
  cwd: string;
  /** `<agentDir>/<filename>`. */
  globalFile: string;
  /** `<cwd>/.pi/<filename>`. */
  projectFile: string;
  /** Write the global file: strings as they are, anything else as JSON. */
  writeGlobal(value: unknown): void;
  /** Write the project file, creating `.pi/` first. */
  writeProject(value: unknown): void;
}

/**
 * An agent directory and a project for layered settings (global, then
 * `.pi/<filename>` in the project), as Pi's own settings and every extension's
 * config file use. The project's `.pi/` exists only once something writes it.
 */
export function settingsDirs(
  cleanup: Defer,
  filename: string,
  prefix = "pi-settings-",
): SettingsDirs {
  const root = tempDir(cleanup, prefix);
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const globalFile = join(agentDir, filename);
  const projectFile = join(cwd, ".pi", filename);
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
  };
  return {
    root,
    agentDir,
    cwd,
    globalFile,
    projectFile,
    writeGlobal: (value) => write(globalFile, value),
    writeProject: (value) => write(projectFile, value),
  };
}
