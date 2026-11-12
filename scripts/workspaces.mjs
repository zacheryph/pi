import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The only test-runner exception; other registered workspaces use Vitest. */
export function workspaceRunner(path) {
  if (path === "extensions/pi-job") return "node";
  if (path === "test" || /^(extensions|packages)\/[^/]+$/.test(path)) return "vitest";
  return undefined;
}

/**
 * Derive project names and roots from the existing workspace registration.
 * @returns {Array<{ path: string, name: string, runner: "node" | "vitest" }>}
 */
export function readWorkspaces(root = repositoryRoot) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const names = new Set();
  return manifest.workspaces.map((path) => {
    const { name } = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8"));
    const runner = workspaceRunner(path);
    if (!runner) throw new Error(`No test runner for workspace ${path}`);
    if (!name || names.has(name)) throw new Error(`Missing or duplicate workspace name: ${path}`);
    names.add(name);
    return { path, name, runner };
  });
}
