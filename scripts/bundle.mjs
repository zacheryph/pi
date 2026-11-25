import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./workspaces.mjs";

function piEntry(root) {
  const directory = join(root, "node_modules/@earendil-works/pi-coding-agent");
  const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
  if (typeof bin !== "string") throw new Error("Installed Pi has no pi executable");
  return realpathSync(resolve(directory, bin));
}

export function installCommands(target, root = repositoryRoot, node = process.execPath) {
  if (!["pi", "bb"].includes(target)) throw new Error("Expected install target pi or bb");
  const commands = [
    { file: "npm", args: ["install", "--ignore-scripts"], cwd: root },
    // Resolve after npm has installed the peer, rather than whichever pi is on PATH.
    { file: node, args: () => [piEntry(root), "install", root], cwd: root },
  ];
  if (target === "bb")
    commands.push(
      { file: "npm", args: ["install", "--include=dev"], cwd: join(root, "bb-plugin") },
      { file: "bb", args: ["plugin", "install", join(root, "bb-plugin"), "--yes"], cwd: root },
    );
  return commands;
}

function run(command) {
  const args = typeof command.args === "function" ? command.args() : command.args;
  const result = spawnSync(command.file, args, { cwd: command.cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.status !== 0) throw new Error(`${command.file} exited with status ${result.status}`);
}

export function installBundle(target, root = repositoryRoot) {
  for (const command of installCommands(target, root)) run(command);
}

export function main(argv) {
  const [action, ...args] = argv;
  if (action === "setup:pi" || action === "setup:bb") {
    if (args.length) throw new Error(`${action} takes no arguments`);
    installBundle(action.slice(6));
    console.log("Installed this checkout. Reload Pi or restart its bb thread to pick up changes.");
    return;
  }
  throw new Error(`Unknown command: ${action}; expected setup:pi or setup:bb`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`bundle: ${error.message}`);
    process.exitCode = 1;
  }
}
