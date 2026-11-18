import { spawnSync } from "node:child_process";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryRoot } from "./workspaces.mjs";

const launcher = (root) => join(root, "packages/pi-isolate/bin/pi-launch.mjs");

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
    // Resolve after npm has installed the peer; never recurse through a pi shim.
    { file: node, args: () => [piEntry(root), "install", root], cwd: root },
  ];
  if (target === "bb")
    commands.push(
      { file: "npm", args: ["install", "--include=dev"], cwd: join(root, "bb-plugin") },
      { file: "bb", args: ["plugin", "install", join(root, "bb-plugin"), "--yes"], cwd: root },
    );
  return commands;
}

export function installLink(source, directory = join(homedir(), ".local/bin")) {
  const destination = join(resolve(directory), "pi-launch");
  mkdirSync(dirname(destination), { recursive: true });
  let existing;
  try {
    existing = lstatSync(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (
      existing.isSymbolicLink() &&
      resolve(dirname(destination), readlinkSync(destination)) === resolve(source)
    )
      return destination;
    throw new Error(
      `${destination} already exists; choose another --bin-dir or remove it yourself`,
    );
  }
  symlinkSync(resolve(source), destination);
  return destination;
}

export function initializePolicy(root = repositoryRoot, home = userInfo().homedir) {
  const path = join(home, ".pi/agent/isolation.yaml");
  mkdirSync(dirname(path), { recursive: true });
  try {
    copyFileSync(
      join(root, "packages/pi-isolate/isolation.example.yaml"),
      path,
      constants.COPYFILE_EXCL,
    );
    chmodSync(path, 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return { path, created: false };
  }
  return { path, created: true };
}

export function launchCommand(
  action,
  args,
  root = repositoryRoot,
  cwd = process.env.INIT_CWD ?? process.cwd(),
) {
  if (action === "pi" || action === "pi:isolate")
    return {
      file: realpathSync(process.execPath),
      args: [launcher(root), ...(action === "pi:isolate" ? ["--isolate"] : []), ...args],
      cwd,
    };
  if (action === "pi:compiled")
    return { file: join(root, "packages/pi-isolate/dist/pi-launch"), args, cwd };
  throw new Error(`Unknown launch command: ${action}`);
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

export async function main(argv) {
  const [action, ...args] = argv;
  if (action === "setup:pi" || action === "setup:bb") {
    if (args.length) throw new Error(`${action} takes no arguments`);
    installBundle(action.slice(6));
    console.log("Installed this checkout. Reload Pi or restart its bb thread to pick up changes.");
    return;
  }
  if (action === "setup:policy") {
    if (args.length) throw new Error("setup:policy takes no arguments");
    const result = initializePolicy();
    console.log(
      `${result.created ? "Created" : "Kept existing"} ${result.path}\nReview provider domains, sensitive paths and write grants before launching with --isolate.`,
    );
    return;
  }
  if (action === "setup:launcher") {
    let directory,
      compiled = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--compiled") compiled = true;
      else if (args[i] === "--bin-dir" && args[i + 1] && !args[i + 1].startsWith("--"))
        directory = args[++i];
      else throw new Error("Usage: npm run setup:launcher -- [--compiled] [--bin-dir PATH]");
    }
    const source = compiled
      ? await (await import("./build-launcher.mjs")).buildLauncher()
      : launcher(repositoryRoot);
    if (!existsSync(source)) throw new Error(`Missing launcher: ${source}`);
    const destination = installLink(source, directory);
    console.log(
      `Installed ${destination}\nAdd ${dirname(destination)} to PATH. Existing pi executables are unchanged.`,
    );
    return;
  }
  const command = launchCommand(action, args);
  // Replace this process so Pi owns the terminal and receives signals directly.
  process.chdir(command.cwd);
  if (!process.execve) throw new Error("Launching requires Node 24+ on macOS or Linux");
  process.execve(command.file, [command.file, ...command.args], process.env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`bundle: ${error.message}`);
    process.exitCode = 1;
  }
}
