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

const rootDependencies = (root) => ({
  file: "npm",
  args: ["install", "--ignore-scripts"],
  cwd: root,
});

// `ci` installs exactly what the lockfile says and never writes it; `install` re-tags
// entries (dev to devOptional) and leaves bb-plugin/package-lock.json modified.
const pluginDependencies = (root) => ({
  file: "npm",
  args: ["ci", "--include=dev"],
  cwd: join(root, "bb-plugin"),
});

/** Every dependency in the repository: the root workspaces and bb-plugin, which is not one. */
export function dependencyCommands(root = repositoryRoot) {
  return [rootDependencies(root), pluginDependencies(root)];
}

export function installCommands(target, root = repositoryRoot, node = process.execPath) {
  if (!["pi", "bb"].includes(target)) throw new Error("Expected install target pi or bb");
  const commands = [
    rootDependencies(root),
    // Resolve after npm has installed the peer, rather than whichever pi is on PATH.
    { file: node, args: () => [piEntry(root), "install", root], cwd: root },
  ];
  if (target === "bb")
    commands.push(pluginDependencies(root), {
      file: "bb",
      args: ["plugin", "install", join(root, "bb-plugin"), "--yes"],
      cwd: root,
    });
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

export function installDependencies(root = repositoryRoot) {
  for (const command of dependencyCommands(root)) run(command);
}

export function main(argv) {
  const [action, ...args] = argv;
  if (action === "deps") {
    if (args.length) throw new Error("deps takes no arguments");
    installDependencies();
    console.log("Installed the dependencies of the root workspaces and bb-plugin.");
    return;
  }
  if (action === "setup:pi" || action === "setup:bb") {
    if (args.length) throw new Error(`${action} takes no arguments`);
    installBundle(action.slice(6));
    console.log("Installed this checkout. Reload Pi or restart its bb thread to pick up changes.");
    return;
  }
  throw new Error(`Unknown command: ${action}; expected deps, setup:pi or setup:bb`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`bundle: ${error.message}`);
    process.exitCode = 1;
  }
}
