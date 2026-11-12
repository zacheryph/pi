import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readWorkspaces, repositoryRoot } from "./workspaces.mjs";

const usage = "Usage: npm run test:workspace -- [workspace name or path] [--watch]";

/** Build a test run without changing cwd or loading any test framework. */
export function testCommands(workspaces, argv, root = repositoryRoot) {
  const watch = argv.includes("--watch");
  const selectors = argv.filter((arg) => arg !== "--watch");
  if (selectors.length > 1 || selectors.some((arg) => arg.startsWith("-"))) throw new Error(usage);
  if (watch && !selectors.length) throw new Error(`Watch mode requires one workspace. ${usage}`);
  const selected = selectors.length
    ? workspaces.filter((ws) => ws.name === selectors[0] || ws.path === selectors[0])
    : workspaces;
  if (!selected.length) throw new Error(`Unknown workspace: ${selectors[0]}`);
  const commands = selected
    .filter((ws) => ws.runner === "node")
    .map((ws) => ({
      cwd: join(root, ws.path),
      args: [...(watch ? ["--watch"] : []), "--test", "--test-timeout=30000", "test/*.test.ts"],
    }));
  const vitest = selected.filter((ws) => ws.runner === "vitest");
  if (vitest.length) {
    commands.push({
      cwd: root,
      args: [
        join(root, "node_modules/vitest/vitest.mjs"),
        watch ? "watch" : "run",
        ...vitest.flatMap((ws) => ["--project", ws.name]),
      ],
    });
  }
  return commands;
}

function main() {
  let commands;
  try {
    commands = testCommands(readWorkspaces(), process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  for (const { cwd, args } of commands) {
    const result = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
    if (result.error) console.error(result.error.message);
    const code = result.status ?? (result.signal ? 128 + constants.signals[result.signal] : 1);
    process.exitCode ||= code;
    if (result.signal) break;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main();
